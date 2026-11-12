import { callUrl, RETURNS_URL, ApiError, J } from '../api.ts';
import { h, mount, message, scanInput, busy, money, nzTime, confirmDialog } from '../ui.ts';
import { orderRef } from '../orderlinks.ts';
import type { ScreenCtx } from '../main.ts';

// Returns: find the customer's Cin7 order, log the return (items, reason, what they want) against the
// signed-in staff, email an eShip return label, mark it received, then create the Cin7 Replacement /
// Warranty SO with a matching eShip order. That SO is scanned, printed and shipped from the Shipping tab.

const rt = <T = J>(action: string, body: J = {}) => callUrl<T>(RETURNS_URL, action, body);
export const OUTCOME_LABEL: Record<string, string> = { refund: 'Refund', replacement: 'Replacement', warranty: 'Warranty repair', undecided: 'Not decided' };
export const STATUS_LABEL: Record<string, string> = { open: 'Open', label_sent: 'Label sent', received: 'Received', outbound: 'Replacement / warranty', closed: 'Closed', cancelled: 'Cancelled' };
const errText = (e: unknown) => e instanceof ApiError ? e.message : (e as Error)?.message || 'Something went wrong.';
const field = (label: string, el: HTMLElement) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), el);
const addr = (a: J = {}) => [a.Line1, a.Line2, a.City, a.Postcode].filter(Boolean).join(', ');

/** Items on a sale that can be returned (anything with a SKU), with device IMEIs offered for devices. */
export function returnableLines(sale: J): J[] {
  return (sale.lines || []).filter((l: J) => l.sku && Number(l.qty) > 0);
}

function openPdf(b64: string, name: string) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const w = window.open(url, '_blank');
  if (!w) { const a = h('a', { href: url, download: name }); a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

export function returnsScreen(_ctx: ScreenCtx): HTMLElement {
  const root = h('div', { class: 'stack' });
  let reasons: string[] = [];

  async function home(note?: HTMLElement) {
    const status = h('div', { class: 'status-slot' }, note || null);
    const results = h('div', { class: 'list' });
    const list = h('div', {}, h('p', { class: 'muted small' }, 'Loading…'));
    const search = scanInput({
      placeholder: 'Search name, email, phone, SO, #order or IMEI', label: 'Find the order', auto: true,
      onScan: async q => {
        status.replaceChildren(); search.disabled = true;
        try {
          const r = await rt<{ sales: J[] }>('find', { q });
          mount(results, r.sales.length ? r.sales.map(saleRow) : h('p', { class: 'muted' }, 'No orders found. Try the email, phone or SO.'));
        } catch (e) { status.replaceChildren(message('error', errText(e))); }
        finally { search.disabled = false; search.focus(); }
      },
    });
    mount(root,
      h('section', { class: 'card stack' }, h('h1', {}, 'Returns'), search, status, results),
      h('section', { class: 'card stack' }, h('h2', {}, 'Returns'), list));
    setTimeout(() => search.focus());
    try {
      const r = await rt<{ returns: J[]; reasons: string[] }>('list');
      reasons = r.reasons;
      mount(list, r.returns.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ops-table returns-table' },
        h('thead', {}, h('tr', {}, ['Return', 'Customer', 'Order', 'Reason', 'Wants', 'Status', 'Logged'].map(t => h('th', {}, t)))),
        h('tbody', {}, r.returns.map(x => h('tr', { class: 'clickable', onclick: () => detail(x.id) },
          h('td', { class: 'mono' }, h('strong', {}, x.number)),
          h('td', {}, x.customer?.name || ''),
          h('td', { class: 'mono' }, x.so || '', x.order_ref ? h('div', { class: 'muted small' }, x.order_ref) : null),
          h('td', {}, x.reason_category), h('td', {}, OUTCOME_LABEL[x.outcome] || x.outcome),
          h('td', {}, h('span', { class: 'chip chip-' + x.status }, STATUS_LABEL[x.status] || x.status)),
          h('td', { class: 'small' }, x.created_by_name, h('div', { class: 'muted' }, nzTime(x.created_at)))))))) : h('p', { class: 'muted' }, 'No returns logged yet.'));
    } catch (e) { mount(list, message('error', errText(e))); }
  }

  function saleRow(s: J) {
    return h('button', { type: 'button', class: 'list-item', onclick: () => createForm(s) },
      h('div', { class: 'row between wrap' }, h('strong', {}, `${s.so}${s.ref ? ' · ' + s.ref : ''}`), h('span', { class: 'muted small' }, `${s.date} · ${s.rep || ''}`)),
      h('div', {}, s.customer?.name || '', h('span', { class: 'muted small' }, s.customer?.email ? ' · ' + s.customer.email : '')),
      h('div', { class: 'muted small' }, returnableLines(s).map((l: J) => l.name).join(' · ')),
      s.returns?.length ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, 'Already has return ' + s.returns.map((x: J) => `${x.number} (${STATUS_LABEL[x.status] || x.status})`).join(', ')) : null);
  }

  function createForm(s: J) {
    const status = h('div', { class: 'status-slot' });
    const imeis: string[] = s.imeis || [];
    const picks = returnableLines(s).map((l: J) => {
      const box = h('input', { type: 'checkbox', checked: returnableLines(s).length === 1 }) as HTMLInputElement;
      const imei = h('input', { type: 'text', placeholder: 'IMEI / serial (optional)', value: imeis.length === 1 ? imeis[0] : '', maxLength: 30, class: 'mono' }) as HTMLInputElement;
      return { l, box, imei, el: h('div', { class: 'return-item' }, h('label', { class: 'row' }, box, h('span', {}, h('strong', {}, l.name), h('span', { class: 'muted small mono' }, ` ${l.sku} · ${money(Number(l.price) || 0)}`))), imei) };
    });
    const reason = h('select', {}, h('option', { value: '' }, 'Choose the reason'), (reasons.length ? reasons : ['Other']).map(r => h('option', { value: r }, r))) as HTMLSelectElement;
    const detailEl = h('textarea', { rows: 3, maxLength: 2000, placeholder: 'What is wrong, in the customer’s words, and what you checked' }) as HTMLTextAreaElement;
    const outcome = h('select', {}, h('option', { value: '' }, 'What does the customer want?'), Object.entries(OUTCOME_LABEL).map(([k, v]) => h('option', { value: k }, v))) as HTMLSelectElement;
    const c = s.customer || {}, a = c.address || {};
    const inp = (v: string, ph: string, type = 'text') => h('input', { type, value: v || '', placeholder: ph, maxLength: 150 }) as HTMLInputElement;
    const name = inp(c.contact || c.name, 'Name'), email = inp(c.email, 'Email', 'email'), phone = inp(c.phone, 'Phone', 'tel');
    const l1 = inp(a.Line1, 'Street'), l2 = inp(a.Line2, 'Suburb'), city = inp(a.City, 'City'), pc = inp(a.Postcode, 'Postcode');
    const save = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, 'Log return');
    save.addEventListener('click', () => busy(save, async () => {
      status.replaceChildren();
      try {
        const items = picks.filter(p => p.box.checked).map(p => ({ sku: p.l.sku, imei: p.imei.value.trim() }));
        const r = await rt<{ return: J }>('create', {
          saleId: s.saleId, so: s.so, items, reasonCategory: reason.value, reasonDetail: detailEl.value, outcome: outcome.value,
          customer: { name: name.value, email: email.value, phone: phone.value, address: { Line1: l1.value, Line2: l2.value, City: city.value, Postcode: pc.value } },
        });
        detail(r.return.id, message('ok', `Return ${r.return.number} logged.`));
      } catch (e) { status.replaceChildren(message('error', errText(e))); }
    }));
    mount(root, h('section', { class: 'card stack' },
      h('div', { class: 'device-head' }, h('div', {}, h('h2', {}, 'New return · ', orderRef(s.so), s.ref ? [' · ', orderRef(s.ref)] : null), h('div', { class: 'muted' }, `${s.date} · ${c.name || ''}`))),
      h('h3', {}, 'Items'), picks.map(p => p.el),
      imeis.length ? h('p', { class: 'muted small' }, 'Devices verified when shipped: ', h('span', { class: 'mono' }, imeis.join(', '))) : null,
      field('Reason', reason), field('Details', detailEl), field('Customer wants', outcome),
      h('h3', {}, 'Customer'), h('div', { class: 'grid2' }, name, email, phone),
      h('div', { class: 'grid2' }, l1, l2, city, pc),
      status, h('div', { class: 'row end wrap' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => home() }, 'Back'), save)));
  }

  async function detail(id: string, note?: HTMLElement) {
    mount(root, h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…')));
    let d: J;
    try { d = await rt('get', { id }); } catch (e) { return home(message('error', errText(e))); }
    const r = d.return, c = r.customer || {}, done = ['closed', 'cancelled'].includes(r.status);
    const slot = h('div', { class: 'status-slot' }, note || null);
    const fail = (e: unknown) => slot.replaceChildren(message('error', errText(e)));
    const act = (label: string, cls: string, run: () => Promise<void>) => {
      const b = h('button', { type: 'button', class: 'btn ' + cls }, label);
      b.addEventListener('click', () => busy(b, async () => { slot.replaceChildren(); try { await run(); } catch (e) { fail(e); } }));
      return b;
    };
    const actions: HTMLElement[] = [];
    if (!done && !r.return_label?.tracking) actions.push(act('Email return label', 'btn-primary', async () => {
      if (!(await confirmDialog('Create a return label?', `An eShip return label to GoodTech is created and emailed to ${c.email || '(no email)'}. This creates a courier ticket.`, 'Create & email'))) return;
      const x = await rt<J>('label', { id });
      await detail(id, message('ok', `Label ${x.tracking} created and queued to email to ${c.email}.`));
      if (x.label) openPdf(x.label, `GoodTech-return-${r.number}.pdf`);
    }));
    if (!done && r.return_label?.tracking) actions.push(act('Resend label email', '', async () => { await rt('resend', { id }); await detail(id, message('ok', 'Label email queued again.')); }));
    if (!done && !r.received_at) {
      const imei = scanInput({ placeholder: 'Scan the returned device (optional)', label: 'Returned device IMEI', auto: true, onScan: async v => {
        try { await rt('receive', { id, imei: v }); await detail(id, message('ok', 'Marked received.')); } catch (e) { fail(e); }
      } });
      actions.push(h('div', { class: 'row receive' }, imei, act('Mark received', '', async () => { await rt('receive', { id }); await detail(id, message('ok', 'Marked received.')); })));
    }
    mount(root, h('section', { class: 'card stack' },
      h('div', { class: 'device-head' },
        h('div', {}, h('h2', {}, `Return ${r.number}`), h('div', { class: 'muted' }, c.name || '', ' · ', r.so ? orderRef(r.so) : '', r.order_ref ? [' · ', orderRef(r.order_ref)] : null)),
        h('span', { class: 'chip chip-' + r.status }, STATUS_LABEL[r.status] || r.status)),
      h('div', { class: 'grid2 small' },
        h('div', {}, h('div', { class: 'label' }, 'Reason'), `${r.reason_category} — ${r.reason_detail}`),
        h('div', {}, h('div', { class: 'label' }, 'Customer wants'), OUTCOME_LABEL[r.outcome] || r.outcome),
        h('div', {}, h('div', { class: 'label' }, 'Contact'), [c.email, c.phone].filter(Boolean).join(' · ') || '—'),
        h('div', {}, h('div', { class: 'label' }, 'Address'), addr(c.address) || '—')),
      h('div', {}, h('div', { class: 'label' }, 'Items'), (r.items || []).map((i: J) => h('div', {}, i.name, h('span', { class: 'muted small mono' }, ` ${i.sku}${i.imei ? ' · ' + i.imei : ''}`)))),
      r.return_label?.tracking ? message('info', `Return label ${r.return_label.tracking}` + (d.emails?.length ? ` · email ${d.emails[d.emails.length - 1].status}${d.emails[d.emails.length - 1].error ? ' (' + d.emails[d.emails.length - 1].error + ')' : ''}` : '')) : null,
      r.received_at ? message('ok', `Received ${nzTime(r.received_at)} by ${r.received_by}`) : null,
      slot, actions.length ? h('div', { class: 'row wrap' }, actions) : null),
      outboundCard(r, () => detail(id)),
      h('section', { class: 'card stack' }, h('h3', {}, 'History'),
        h('table', { class: 'ops-table' }, h('tbody', {}, (d.events || []).map((e: J) => h('tr', {}, h('td', { class: 'small' }, nzTime(e.at)), h('td', {}, e.action.replace(/_/g, ' ')), h('td', { class: 'small' }, e.staff_name || ''))))),
        done ? (r.closed_note ? h('p', { class: 'muted' }, r.closed_note) : null) : closeRow(r)),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => home() }, '← All returns')));
  }

  function closeRow(r: J) {
    const note = h('input', { type: 'text', placeholder: 'Outcome note (e.g. refunded $499 on CN1234)', maxLength: 1000 }) as HTMLInputElement;
    const slot = h('div', { class: 'status-slot' });
    const go = (action: 'close' | 'cancel', label: string, cls: string) => {
      const b = h('button', { type: 'button', class: 'btn ' + cls }, label);
      b.addEventListener('click', () => busy(b, async () => {
        try { await rt(action, { id: r.id, note: note.value }); await detail(r.id, message('ok', action === 'close' ? 'Return closed.' : 'Return cancelled.')); }
        catch (e) { slot.replaceChildren(message('error', errText(e))); }
      }));
      return b;
    };
    return h('div', { class: 'stack' }, note, slot, h('div', { class: 'row end wrap' }, go('cancel', 'Cancel return', 'btn-ghost'), go('close', 'Close return', '')));
  }

  function outboundCard(r: J, refresh: () => void) {
    const ob = r.outbound;
    if (ob?.eship_order_id) return h('section', { class: 'card stack' }, h('h3', {}, ob.kind === 'replacement' ? 'Replacement' : 'Warranty', ' order'),
      h('p', {}, orderRef(ob.so), ` · ${ob.ref} · `, (ob.lines || []).map((l: J) => `${l.sku}${l.imei ? ' (' + l.imei + ')' : ''} ${money(Number(l.price) || 0)}`).join(', ')),
      message('info', `Ready to ship: scan ${ob.so} in the Shipping tab, verify the device, print the label and Ship.`));
    if (['closed', 'cancelled'].includes(r.status) || !['replacement', 'warranty', 'undecided'].includes(r.outcome)) return null;
    let kind: 'replacement' | 'warranty' = r.outcome === 'warranty' ? 'warranty' : 'replacement';
    const lines: J[] = kind === 'replacement' ? (r.items || []).map((i: J) => ({ sku: i.sku, name: i.name, price: Number(i.price) || 0, imei: '' })) : [];
    const slot = h('div', { class: 'status-slot' });
    const linesEl = h('div', { class: 'stack' });
    const drawLines = () => mount(linesEl, lines.length ? lines.map((l, i) => {
      const price = h('input', { type: 'number', min: '0', step: '0.01', value: String(l.price), 'aria-label': 'Price' }) as HTMLInputElement;
      price.oninput = () => { l.price = Number(price.value || 0); };
      const imei = h('input', { type: 'text', value: l.imei || '', placeholder: 'Device IMEI (optional)', maxLength: 30, class: 'mono' }) as HTMLInputElement;
      imei.oninput = () => { l.imei = imei.value.trim(); };
      return h('div', { class: 'out-line' }, h('div', {}, l.name, h('div', { class: 'muted small mono' }, l.sku)), imei, price,
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { lines.splice(i, 1); drawLines(); } }, 'Remove'));
    }) : h('p', { class: 'muted small' }, 'Add the product(s) to send.'));
    const results = h('div', { class: 'list' });
    const search = h('input', { type: 'text', placeholder: 'Search product code or name to add', autocomplete: 'off' }) as HTMLInputElement;
    let t: ReturnType<typeof setTimeout> | undefined;
    search.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
      try {
        const x = await rt<{ products: J[] }>('products', { id: r.id, q: search.value });
        mount(results, x.products.map(p => h('button', { type: 'button', class: 'list-item', onclick: () => { lines.push({ sku: p.sku, name: p.name, price: kind === 'warranty' ? 0 : p.price, imei: '' }); mount(results); search.value = ''; drawLines(); } },
          h('strong', {}, p.sku), ' ', p.name, h('span', { class: 'muted small' }, ' ' + money(p.price)))));
      } catch (e) { slot.replaceChildren(message('error', errText(e))); }
    }, 300); };
    const kindSel = h('select', {}, h('option', { value: 'replacement', selected: kind === 'replacement' }, 'Replacement (rep: Replacement)'), h('option', { value: 'warranty', selected: kind === 'warranty' }, 'Warranty (rep: Warranty)')) as HTMLSelectElement;
    kindSel.onchange = () => { kind = kindSel.value as typeof kind; };
    const go = h('button', { type: 'button', class: 'btn btn-primary' }, 'Create Cin7 SO + eShip order');
    go.addEventListener('click', () => busy(go, async () => {
      slot.replaceChildren();
      if (!(await confirmDialog('Create the order?', `A ${kind} SO is created and authorised in Cin7 for ${r.customer?.name}, with a matching eShip order to ${addr(r.customer?.address)}.`, 'Create'))) return;
      try { await rt('outbound', { id: r.id, kind, lines }); refresh(); } catch (e) { slot.replaceChildren(message('error', errText(e))); }
    }));
    drawLines();
    return h('section', { class: 'card stack' }, h('h3', {}, 'Send a replacement or warranty repair'),
      ob?.cin7_sale_id ? message('warn', `${ob.so} was created in Cin7; the eShip order still needs creating. Press the button to finish.`) : null,
      field('Type', kindSel), linesEl, search, results,
      h('p', { class: 'muted small' }, 'Replacement: price as agreed (normally the device price, with the credit on the original order). Warranty: repair or service lines, usually $0.'),
      slot, h('div', { class: 'row end' }, go));
  }

  home();
  return root;
}
