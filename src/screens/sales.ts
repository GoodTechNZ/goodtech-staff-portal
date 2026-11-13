import { call, ApiError, uuid, J } from '../api.ts';
import { h, mount, message, scanInput, busy, money, confirmDialog } from '../ui.ts';
import { orderRef } from '../orderlinks.ts';
import type { ScreenCtx } from '../main.ts';

// In-store sales, driven by the existing staff-sales-desk function:
// cart → create (Cin7 order + picking) → confirm payment (invoice) → complete purchase.
// Before payment, "Back — edit order" reloads the order into the cart; saving voids it and creates
// the corrected order (gateway sales.amend).

type Product = { id: string; sku: string; name: string; price: number; available: number; serialRequired: boolean; imei?: string; model?: string };
type Line = Product & { key: string; salePrice: number };
const STAGES = ['draft', 'picking', 'invoiced', 'shipped'] as const;
const STAGE_LABEL: Record<string, string> = { draft: 'Draft', picking: 'Picking', invoiced: 'Paid & invoiced', shipped: 'Handed over', voided: 'Voided' };

const ADD_ONS: Record<string, string[]> = {
  iphone: ['ACSCNPRFTPH', 'ACPHGELCASE', 'ACPHGELCASEMS', 'ACPHMSSLCASE'],
  ipad: ['ACSCNPRFTPD'],
  pixel: ['ACSCNPRFTGP', 'ACPHGELCASEGP'],
  galaxy: ['ACPHGELCASESG', 'ACSCNPRFTSM'],
};
const MAGSAFE = ['ACPHGELCASEMS', 'ACPHMSSLCASE'];

/** Add-ons that fit this device: by family (iPhone / iPad / Pixel / Galaxy phone); MagSafe cases only
 * on iPhone 12 or newer and the Air (not SE or 16e); the Galaxy screen protector only on the S21–S24. */
export function addOnsFor(device: { name: string; model?: string }, accessories: Product[]): Product[] {
  const n = `${device.model || ''} ${device.name}`.toLowerCase();
  const family = /\bipad\b/.test(n) ? 'ipad' : /\biphone\b/.test(n) ? 'iphone' : /\bpixel\b/.test(n) ? 'pixel'
    : /\bgalaxy\b|\bsamsung\b/.test(n) && !/\btab\b/.test(n) ? 'galaxy' : '';
  if (!family) return [];
  // MagSafe: iPhone 12 and newer, and the iPhone Air; not the SE or the "e" models (16e).
  const gen = n.match(/iphone\s*(\d{2})(e?)\b/);
  const magsafe = /iphone air\b/.test(n) || (!!gen && Number(gen[1]) >= 12 && !gen[2] && !/\bse\b/.test(n));
  return ADD_ONS[family].filter(sku =>
    (!MAGSAFE.includes(sku) || magsafe) &&
    (sku !== 'ACSCNPRFTSM' || /\bs2[1-4]\b/.test(n)))
    .map(sku => accessories.find(a => a.sku === sku)).filter((a): a is Product => !!a);
}

export const addOnLabel = (a: Product): string =>
  /screen protector/i.test(a.name) ? 'Screen protector' : /magsafe/i.test(a.name) ? (/silicone/i.test(a.name) ? 'MagSafe black silicone case' : 'MagSafe clear case') : /case/i.test(a.name) ? 'Clear gel case' : a.name;

/** Pick list for one in-store order (same layout as the Dashboard's pick lists), printed from a
 * print-only container; the IMEIs scanned into the cart are filled in. */
export function pickListPage(o: J, printedAt = new Date()): HTMLElement {
  const printed = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', dateStyle: 'medium', timeStyle: 'short' }).format(printedAt);
  const lines: J[] = o.lines || [];
  const grouped = new Map<string, { sku: string; name: string; qty: number; imeis: string[] }>();
  for (const l of lines) {
    const g = grouped.get(l.sku) || { sku: String(l.sku), name: String(l.name), qty: 0, imeis: [] as string[] };
    g.qty += 1; if (l.imei) g.imeis.push(l.imei);
    grouped.set(l.sku, g);
  }
  return h('section', { class: 'pick-page' },
    h('div', { class: 'pick-head' },
      h('div', {}, h('div', { class: 'pick-so' }, o.number || ''), h('div', {}, o.customer?.name || ''), o.customer?.phone ? h('div', { class: 'muted' }, o.customer.phone) : null),
      h('div', { class: 'pick-meta' }, h('div', {}, o.staff ? 'Sold by ' + o.staff : ''), h('div', { class: 'pick-method' }, 'IN-STORE'))),
    h('table', { class: 'pick-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '✓'), h('th', {}, 'Qty'), h('th', {}, 'SKU'), h('th', {}, 'Product'), h('th', {}, 'IMEI / serial'))),
      h('tbody', {}, [...grouped.values()].map(g => h('tr', {}, h('td', { class: 'tick' }, '☐'), h('td', { class: 'qty' }, String(g.qty)),
        h('td', { class: 'mono' }, g.sku), h('td', {}, g.name), h('td', { class: 'serial mono' }, g.imeis.join(', ')))))),
    o.memo ? h('div', { class: 'pick-note' }, 'Note: ' + o.memo) : null,
    h('div', { class: 'pick-foot' }, h('span', {}, 'Picked by ____________________'), h('span', { class: 'muted' }, `Printed ${printed}`)));
}

function printPickList(o: J) {
  document.getElementById('print-root')?.remove();
  const root = h('div', { id: 'print-root' }, pickListPage(o));
  document.body.appendChild(root);
  const done = () => { root.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

export function salesScreen(ctx: ScreenCtx): HTMLElement {
  const root = h('div', { class: 'stack' });
  let lines: Line[] = [];
  let requestId = uuid();
  let accessories: Product[] = [];
  let orders: J[] = [];
  // Customer details survive re-rendering the cart (adding a product used to clear them).
  let cust = { name: '', email: '', phone: '', memo: '' };
  /** The Cin7 order being amended: saving voids it and creates the corrected order. */
  let amending: J | null = null;

  async function boot() {
    mount(root, h('section', { class: 'card' }, h('h1', {}, 'Sales'), h('p', { class: 'muted' }, 'Loading…')));
    try {
      const r = await call('sales.bootstrap');
      accessories = r.accessories || [];
      orders = r.orders || [];
      cartView();
    } catch (err) {
      mount(root, h('section', { class: 'card stack' }, h('h1', {}, 'Sales'), message('error', err instanceof ApiError ? err.message : 'Sales is unavailable.')));
    }
  }

  function cartView(note?: HTMLElement) {
    const slot = h('div', { class: 'status-slot' }, note || null);
    const results = h('div', { class: 'list' });
    const search = scanInput({
      placeholder: 'Scan IMEI or search product code / model', label: 'Product search', auto: true, onScan: async q => {
        slot.replaceChildren();
        try {
          const r = await call<{ products: Product[] }>('sales.search', { q });
          search.value = '';
          if (r.products.length === 1 && r.products[0].imei) { add(r.products[0]); return; }
          mount(results, r.products.length ? r.products.map(p => h('button', { type: 'button', class: 'list-item', onclick: () => add(p) },
            h('strong', {}, p.name), h('div', { class: 'muted small' }, `${p.sku} · ${money(p.price)} · ${p.available} in stock${p.serialRequired && !p.imei ? ' · scan the device IMEI to add' : ''}`))) : h('p', { class: 'muted' }, 'No matching products in stock.'));
        } catch (err) { slot.replaceChildren(message('error', (err as Error).message)); }
      },
    });

    function add(p: Product) {
      if (p.serialRequired && !p.imei) { slot.replaceChildren(message('error', `Scan the device IMEI for ${p.sku} instead of searching by name.`)); return; }
      if (p.imei && lines.some(l => l.imei === p.imei)) { slot.replaceChildren(message('error', 'That device is already in the cart.')); return; }
      lines.push({ ...p, key: uuid(), salePrice: p.price });
      requestId = uuid();
      cartView();
    }

    const field = <T extends HTMLInputElement | HTMLTextAreaElement>(el: T, k: keyof typeof cust) => {
      el.value = cust[k]; el.addEventListener('input', () => { cust[k] = el.value; requestId = uuid(); }); return el;
    };
    const name = field(h('input', { type: 'text', placeholder: 'Customer name', maxLength: 150, autocomplete: 'off' }), 'name');
    const email = field(h('input', { type: 'email', placeholder: 'Email', maxLength: 250, autocomplete: 'off' }), 'email');
    const phone = field(h('input', { type: 'tel', placeholder: 'Phone (optional)', maxLength: 40, autocomplete: 'off' }), 'phone');
    const memo = field(h('textarea', { rows: 2, maxLength: 1000, placeholder: 'Order memo (optional)' }), 'memo');
    const total = () => Math.round(lines.reduce((s, l) => s + l.salePrice, 0) * 100) / 100;
    const totalEl = h('strong', {}, money(total()));

    const create = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !lines.length }, amending ? `Save changes — replace ${amending.number}` : 'Create order in Cin7');
    create.addEventListener('click', async () => {
      const old = amending;
      if (old && !(await confirmDialog(`Replace ${old.number}?`, `${old.number} is voided in Cin7 and a new order is created with these changes. Stock on the old order is released first.`, 'Save changes'))) return;
      await busy(create, async () => {
        slot.replaceChildren();
        try {
          const body = {
            mode: 'live', requestId, memo: memo.value.trim(),
            customer: { name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim() },
            lines: lines.map(l => ({ id: l.id, price: l.salePrice, ...(l.imei ? { imei: l.imei } : {}) })),
          };
          // Amending: the gateway voids the old order, then creates this one (one request).
          const r = old ? await call('sales.amend', { ...body, id: old.id }) : await call('sales.create', body);
          if (old) amending = null;
          lines = []; requestId = uuid(); cust = { name: '', email: '', phone: '', memo: '' };
          orderView(r.order, r.error);
        } catch (err) {
          slot.replaceChildren(message('error', (err as Error).message));
          // The old order was voided but the new one failed: the cart now creates a fresh order.
          if (old && err instanceof ApiError && err.data?.voided) amending = null;
          if (old && !amending) { create.textContent = 'Create order in Cin7'; slot.append(message('warn', `${old.number} was voided. Fix the problem above, then create the order again.`)); }
        }
      });
    });
    const cancelEdit = amending ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { const o = amending; if (!o) return cartView(); amending = null; lines = []; cust = { name: '', email: '', phone: '', memo: '' }; requestId = uuid(); refresh(o); } }, 'Cancel changes') : null;

    mount(root,
      h('div', { class: 'layout-side' },
        h('div', { class: 'stack' },
          h('section', { class: 'card stack' }, h('h1', {}, amending ? `Editing ${amending.number}` : 'Sales'),
            amending ? message('info', `Change devices, prices or the customer, then save. ${amending.number} stays as it is in Cin7 until you save.`) : null,
            search, results),
          h('section', { class: 'card stack' }, h('h2', {}, 'Cart'),
            lines.length ? lines.map(l => {
              const price = h('input', { type: 'number', min: '0', step: '0.01', value: String(l.salePrice), 'aria-label': `Price for ${l.sku}` });
              price.addEventListener('input', () => { l.salePrice = Math.round(Number(price.value || 0) * 100) / 100; requestId = uuid(); totalEl.textContent = money(total()); });
              const extras = l.serialRequired ? addOnsFor(l, accessories) : [];
              return h('div', { class: 'cart-line' },
                h('div', {}, h('div', {}, l.name), h('div', { class: 'muted small mono' }, l.sku, l.imei ? ' · ' + l.imei : ''), l.salePrice < l.price ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, `Below catalogue ${money(l.price)}`) : null,
                  extras.length ? h('div', { class: 'row wrap addons' }, h('span', { class: 'muted small' }, 'Add:'),
                    extras.map(a => h('button', { type: 'button', class: 'btn btn-sm', onclick: () => add(a) }, `${addOnLabel(a)} ${money(a.price)}`))) : null),
                price,
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Remove ${l.sku}`, onclick: () => { lines = lines.filter(x => x !== l); requestId = uuid(); cartView(); } }, 'Remove'));
            }) : h('p', { class: 'muted' }, 'Scan a device or search for a product.'),
            h('div', { class: 'row between' }, h('span', {}, 'Total (GST incl.)'), totalEl)),
          h('section', { class: 'card stack' }, h('h2', {}, 'Customer'), name, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, email), h('div', { class: 'grow' }, phone)), memo, slot,
            h('div', { class: 'row end wrap' }, cancelEdit, create))),
        h('aside', { class: 'card recent' }, h('h3', {}, 'My recent orders'),
          orders.length ? h('div', { class: 'list' }, orders.map(o => h('button', { type: 'button', class: 'list-item', onclick: () => refresh(o) },
            h('strong', {}, o.number), ' ', h('span', { class: 'chip chip-' + o.stage }, STAGE_LABEL[o.stage] || o.stage),
            h('div', { class: 'muted small' }, `${o.customer?.name || ''} · ${money(o.total)}`)))) : h('p', { class: 'muted small' }, 'None yet.'))));
    setTimeout(() => search.focus());
  }

  async function refresh(o: J) {
    try { const r = await call('sales.get', { id: o.id }); orderView(r.order, r.error); }
    catch (err) { orderView(o, (err as Error).message); }
  }

  function orderView(o: J, error?: string) {
    const slot = h('div', { class: 'status-slot' }, error ? message('error', error) : o.last_error ? message('warn', o.last_error) : null);
    const step = (action: 'resume' | 'invoice' | 'ship' | 'void' | 'get', label: string, cls = 'btn btn-lg') => {
      const b = h('button', { type: 'button', class: cls }, label);
      b.addEventListener('click', async () => {
        if (action === 'invoice') {
          if (!(await confirmDialog('Payment received?', `Confirm the customer has paid ${money(o.total)} in full. This creates the invoice in Cin7.`, 'Payment received'))) return;
        }
        if (action === 'void') {
          if (!(await confirmDialog('Void this order?', 'The Cin7 order is voided and stock released.', 'Void order', true))) return;
        }
        await busy(b, async () => {
          try {
            const r = await call(`sales.${action}`, { id: o.id });
            if (action === 'ship' && !r.error && r.order?.stage === 'shipped') {
              await ctx.completed('Sale complete', [`${r.order.number} · ${r.order.customer?.name || ''}`, `${money(r.order.total)} — handed over and recorded in Cin7.`]);
              return;
            }
            orderView(r.order, r.error);
          } catch (err) { slot.replaceChildren(message('error', (err as Error).message)); }
        });
      });
      return b;
    };
    const stageIdx = STAGES.indexOf(o.stage);
    const actions: HTMLElement[] = [];
    if (o.stage === 'draft') actions.push(step('resume', 'Retry sending to Cin7', 'btn btn-primary btn-lg'));
    if (o.stage === 'picking') actions.push(step('invoice', 'Payment received', 'btn btn-primary btn-lg'));
    if (o.stage === 'invoiced') actions.push(step('ship', 'Complete purchase — hand over', 'btn btn-primary btn-lg'));
    if (['draft', 'picking'].includes(o.stage)) actions.unshift(step('void', 'Void', 'btn btn-ghost'));
    if (['picking', 'invoiced'].includes(o.stage)) {
      const pb = h('button', { type: 'button', class: 'btn btn-lg' }, 'Print pick list');
      pb.addEventListener('click', () => printPickList(o));
      actions.splice(actions.length - 1, 0, pb);
    }
    actions.unshift(step('get', 'Refresh', 'btn btn-ghost'));
    // Before payment, go back to the cart with this order loaded to amend it.
    const editable = ['draft', 'picking'].includes(o.stage);

    mount(root, h('section', { class: 'card stack' },
      h('div', { class: 'device-head' }, h('div', {}, h('h1', {}, orderRef(o.number)), h('div', { class: 'muted' }, `${o.customer?.name || ''} · ${o.customer?.email || ''}`)), h('strong', {}, money(o.total))),
      o.stage === 'voided' ? h('span', { class: 'chip chip-voided' }, 'Voided') :
        h('div', { class: 'stages' }, STAGES.map((s, i) => h('span', { class: 'stage' + (i < stageIdx ? ' done' : i === stageIdx ? ' now' : '') }, STAGE_LABEL[s]))),
      h('table', {}, h('tbody', {}, (o.lines || []).map((l: J) => h('tr', {}, h('td', {}, l.name, ' ', h('span', { class: 'muted small mono' }, l.sku + (l.imei ? ' · ' + l.imei : ''))), h('td', { class: 'num' }, money(Number(l.price))))))),
      slot,
      h('div', { class: 'row end wrap' },
        editable ? h('button', { type: 'button', class: 'btn', onclick: () => editOrder(o) }, '← Back — edit order') : null,
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { amending = null; boot(); } }, 'New sale'), actions)));
  }

  /** Load an unpaid order back into the cart so it can be amended. */
  function editOrder(o: J) {
    amending = o;
    lines = (o.lines || []).map((l: J) => ({ ...l, price: Number(l.catalogue_price ?? l.price), salePrice: Number(l.price), key: uuid() }) as Line);
    cust = { name: o.customer?.name || '', email: o.customer?.email || '', phone: o.customer?.phone || '', memo: o.memo || '' };
    requestId = uuid();
    cartView();
  }

  boot();
  return root;
}
