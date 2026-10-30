import { call, ApiError, uuid, J } from '../api.ts';
import { h, mount, message, scanInput, askPin, busy, money, confirmDialog } from '../ui.ts';
import type { ScreenCtx } from '../main.ts';

// In-store sales, driven by the existing staff-sales-desk function:
// cart → create (Cin7 order + picking) → confirm payment (PIN, invoice) → complete purchase.

type Product = { id: string; sku: string; name: string; price: number; available: number; serialRequired: boolean; imei?: string };
type Line = Product & { key: string; salePrice: number };
const STAGES = ['draft', 'picking', 'invoiced', 'shipped'] as const;
const STAGE_LABEL: Record<string, string> = { draft: 'Draft', picking: 'Picking', invoiced: 'Paid & invoiced', shipped: 'Handed over', voided: 'Voided' };

export function salesScreen(ctx: ScreenCtx): HTMLElement {
  const root = h('div', { class: 'stack' });
  let lines: Line[] = [];
  let requestId = uuid();
  let accessories: Product[] = [];
  let orders: J[] = [];

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
      placeholder: 'Scan IMEI or search product code / model', label: 'Product search', onScan: async q => {
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

    const name = h('input', { type: 'text', placeholder: 'Customer name', maxLength: 150, autocomplete: 'off' });
    const email = h('input', { type: 'email', placeholder: 'Email', maxLength: 250, autocomplete: 'off' });
    const phone = h('input', { type: 'tel', placeholder: 'Phone (optional)', maxLength: 40, autocomplete: 'off' });
    const memo = h('textarea', { rows: 2, maxLength: 1000, placeholder: 'Order memo (optional)' });
    const total = () => Math.round(lines.reduce((s, l) => s + l.salePrice, 0) * 100) / 100;
    const totalEl = h('strong', {}, money(total()));

    const create = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !lines.length }, 'Create order in Cin7');
    create.addEventListener('click', () => busy(create, async () => {
      slot.replaceChildren();
      try {
        const r = await call('sales.create', {
          mode: 'live', requestId, memo: memo.value.trim(),
          customer: { name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim() },
          lines: lines.map(l => ({ id: l.id, price: l.salePrice, ...(l.imei ? { imei: l.imei } : {}) })),
        });
        lines = []; requestId = uuid();
        orderView(r.order, r.error);
      } catch (err) { slot.replaceChildren(message('error', (err as Error).message)); }
    }));

    mount(root,
      h('div', { class: 'layout-side' },
        h('div', { class: 'stack' },
          h('section', { class: 'card stack' }, h('h1', {}, 'Sales'), search, results,
            accessories.length ? h('div', { class: 'row wrap' }, h('span', { class: 'label' }, 'Add-ons'), accessories.map(a => h('button', { type: 'button', class: 'btn btn-sm', onclick: () => add(a) }, `${a.name.replace(/^.*?(screen protector|case)/i, '$1')} ${money(a.price)}`))) : null),
          h('section', { class: 'card stack' }, h('h2', {}, 'Cart'),
            lines.length ? lines.map(l => {
              const price = h('input', { type: 'number', min: '0', step: '0.01', value: String(l.salePrice), 'aria-label': `Price for ${l.sku}` });
              price.addEventListener('input', () => { l.salePrice = Math.round(Number(price.value || 0) * 100) / 100; requestId = uuid(); totalEl.textContent = money(total()); });
              return h('div', { class: 'cart-line' },
                h('div', {}, h('div', {}, l.name), h('div', { class: 'muted small mono' }, l.sku, l.imei ? ' · ' + l.imei : ''), l.salePrice < l.price ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, `Below catalogue ${money(l.price)}`) : null),
                price,
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Remove ${l.sku}`, onclick: () => { lines = lines.filter(x => x !== l); requestId = uuid(); cartView(); } }, 'Remove'));
            }) : h('p', { class: 'muted' }, 'Scan a device or search for a product.'),
            h('div', { class: 'row between' }, h('span', {}, 'Total (GST incl.)'), totalEl)),
          h('section', { class: 'card stack' }, h('h2', {}, 'Customer'), name, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, email), h('div', { class: 'grow' }, phone)), memo, slot,
            h('div', { class: 'row end' }, create))),
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
        let pin: string | null = null;
        if (action === 'invoice') {
          if (!(await confirmDialog('Payment received?', `Confirm the customer has paid ${money(o.total)} in full. This creates the invoice in Cin7.`, 'Payment received'))) return;
          pin = await askPin('Confirm payment received'); if (!pin) return;
        }
        if (action === 'void') {
          if (!(await confirmDialog('Void this order?', 'The Cin7 order is voided and stock released.', 'Void order', true))) return;
          pin = await askPin('Void order'); if (!pin) return;
        }
        await busy(b, async () => {
          try {
            const r = await call(`sales.${action}`, { id: o.id, pin });
            if (r.signedOut) {
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
    actions.unshift(step('get', 'Refresh', 'btn btn-ghost'));

    mount(root, h('section', { class: 'card stack' },
      h('div', { class: 'device-head' }, h('div', {}, h('h1', {}, o.number), h('div', { class: 'muted' }, `${o.customer?.name || ''} · ${o.customer?.email || ''}`)), h('strong', {}, money(o.total))),
      o.stage === 'voided' ? h('span', { class: 'chip chip-voided' }, 'Voided') :
        h('div', { class: 'stages' }, STAGES.map((s, i) => h('span', { class: 'stage' + (i < stageIdx ? ' done' : i === stageIdx ? ' now' : '') }, STAGE_LABEL[s]))),
      h('table', {}, h('tbody', {}, (o.lines || []).map((l: J) => h('tr', {}, h('td', {}, l.name, h('span', { class: 'muted small mono' }, l.sku + (l.imei ? ' · ' + l.imei : ''))), h('td', { class: 'num' }, money(Number(l.price))))))),
      slot,
      h('div', { class: 'row end wrap' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => boot() }, 'Back to sales'), actions)));
  }

  boot();
  return root;
}
