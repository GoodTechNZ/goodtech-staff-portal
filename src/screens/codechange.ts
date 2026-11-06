import { call, ApiError, uuid, J } from '../api.ts';
import { h, mount, message, askPin, busy, money, nzTime } from '../ui.ts';

// Product-code changes (managers). Cin7 is changed with one stock adjustment: N off the current
// SKU, N onto the new SKU, same location, at the current SKU's average cost. The portal shows the
// live Cin7 balances first and re-checks them before writing, so nothing changes without review.

export const CIN7_LOCATIONS = ['Ready For Sale', 'Repairs', 'Locked Devices'] as const;

const STATE_LABEL: Record<string, string> = {
  preview: 'Reviewed, not confirmed', reserved: 'Starting', creating: 'Creating in Cin7', draft: 'Draft in Cin7',
  completing: 'Completing in Cin7', cin7_done: 'Cin7 done', sheet: 'Cin7 done · updating sheets', done: 'Done', review: 'Needs review',
};
export const changeState = (s: string) => STATE_LABEL[s] || s;

function select(options: readonly string[], value: string, onChange: (v: string) => void, label: string) {
  const el = h('select', { 'aria-label': label, onchange: () => onChange(el.value) },
    h('option', { value: '' }, 'Choose…'), options.map(o => h('option', { value: o, selected: o === value }, o)));
  return el;
}

/** Search Cin7 stock products by SKU or name. */
export function skuPicker(opts: { label: string; location: () => string; onPick: (sku: string, name: string) => void; exclude?: () => string }) {
  const input = h('input', { type: 'text', placeholder: 'Search SKU or name, e.g. PH13256 or iPhone 13 Black', autocomplete: 'off', 'aria-label': opts.label });
  const list = h('div', { class: 'list sku-results' });
  const chosen = h('div', { class: 'small' });
  let timer = 0, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const q = input.value.trim(), mine = ++seq;
      if (q.length < 2) { list.replaceChildren(); return; }
      try {
        const r = await call<{ products: { sku: string; name: string; onHand: number | null }[] }>('stock.products', { q, location: opts.location() });
        if (mine !== seq) return;
        const rows = r.products.filter(p => p.sku !== opts.exclude?.());
        list.replaceChildren(...(rows.length ? rows.map(p => h('button', { type: 'button', class: 'list-item', onclick: () => pick(p.sku, p.name) },
          h('strong', { class: 'mono' }, p.sku), ' ', h('span', {}, p.name),
          p.onHand != null ? h('span', { class: 'muted small' }, ` · ${p.onHand} on hand`) : null)) : [h('p', { class: 'muted small' }, 'No active stock products match.')]));
      } catch (err) { list.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Search failed.')); }
    }, 250);
  });
  function pick(sku: string, name: string) {
    list.replaceChildren(); input.value = sku;
    chosen.replaceChildren(h('strong', { class: 'mono' }, sku), ' ', name);
    opts.onPick(sku, name);
  }
  return { el: h('div', { class: 'field' }, h('span', { class: 'label' }, opts.label), input, chosen, list), pick };
}

/** Review card for a prepared change, with the PIN-confirmed Cin7 step. */
function reviewCard(change: J, onDone: (c: J) => void, onCancel: () => void): HTMLElement {
  const p = change.plan;
  const status = h('div', { class: 'status-slot' });
  const confirm = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, 'Confirm in Cin7');
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: onCancel }, 'Back');
  confirm.addEventListener('click', async () => {
    const pin = await askPin('Change product code in Cin7', `${p.quantity} × ${p.source.SKU} → ${p.target.SKU} at ${p.location}.`);
    if (!pin) return;
    await busy(confirm, async () => {
      status.replaceChildren(message('info', 'Updating Cin7… this takes about 15 seconds.'));
      cancel.disabled = true;
      try {
        const r = await call<{ change: J }>('stock.commit', { id: change.id, pin });
        onDone(r.change);
      } catch (err) {
        status.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Cin7 could not be updated. Check Admin → Product-code changes before trying again.'));
        cancel.disabled = false;
      }
    });
  });
  const row = (label: string, sku: J, before: number, after: number) => h('tr', {},
    h('td', {}, label), h('td', {}, h('strong', { class: 'mono' }, sku.SKU), h('div', { class: 'muted small' }, sku.Name)),
    h('td', { class: 'num' }, String(before)), h('td', { class: 'num' }, '→ ' + after));
  return h('section', { class: 'card stack' },
    h('h3', {}, 'Check and confirm'),
    h('table', { class: 'ops-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Product'), h('th', { class: 'num' }, `On hand at ${p.location}`), h('th', { class: 'num' }, 'After'))),
      h('tbody', {}, row('From', p.source, p.from.onHand, p.after.from), row('To', p.target, p.to.onHand, p.after.to))),
    h('p', { class: 'small' }, `${p.quantity} unit${p.quantity === 1 ? '' : 's'} at ${money(p.unitCost)} each (current average cost). Reason: ${change.reason}`),
    change.kind === 'device' ? h('p', { class: 'small muted' },
      `Then the Grading row ${p.sheetRow ? '(row ' + p.sheetRow + ') ' : ''}changes from grade ${p.current?.grade} ${p.current?.colour || ''} to grade ${p.target.grade} ${p.target.colour || ''}, and ASNs Code shows ${p.target.SKU} (within about 10 minutes).`) : null,
    status, h('div', { class: 'row end wrap' }, cancel, confirm));
}

function doneCard(c: J, onClose: () => void): HTMLElement {
  const ok = c.state === 'done' || c.state === 'sheet' || c.state === 'cin7_done';
  return h('section', { class: 'card stack' },
    message(ok ? 'ok' : 'warn', ok
      ? `Cin7 updated${c.adjustment_number ? ' (' + c.adjustment_number + ')' : ''}: ${c.quantity} × ${c.from_sku} → ${c.to_sku}.`
      : `${changeState(c.state)}. ${c.error || ''}`),
    c.kind === 'device' && c.state === 'sheet' ? h('p', { class: 'small muted' }, 'The Grading row updates within a couple of minutes and ASNs Code within about 10. Progress shows in Admin → Product-code changes.') : null,
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: onClose }, 'Close')));
}

/** Grading screen: change a graded device's product code. */
export function deviceCodePanel(d: { serial: string; recordId: string }, onClose: () => void): HTMLElement {
  const root = h('section', { class: 'card stack' }, h('p', { class: 'muted' }, 'Loading…'));
  (async () => {
    let ctx: J;
    try { ctx = await call('stock.device', { serial: d.serial, recordId: d.recordId }); }
    catch (err) { mount(root, message('error', err instanceof ApiError ? err.message : 'Could not load this device.'), h('button', { type: 'button', class: 'btn', onclick: onClose }, 'Close')); return; }
    const head = [h('h3', {}, 'Change product code'),
      h('p', { class: 'small' }, 'Now ', h('strong', { class: 'mono' }, ctx.sku || '—'), ` · grade ${ctx.grade} ${ctx.colour || ''} · ${ctx.po || 'no PO'}`)];
    if (ctx.problems?.length) {
      mount(root, ...head, ...ctx.problems.map((p: string) => message('warn', p)), h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: onClose }, 'Close')));
      return;
    }
    const state = { location: ctx.location || '', to: '', reason: '' };
    const status = h('div', { class: 'status-slot' });
    const picker = skuPicker({ label: 'New product code', location: () => state.location, exclude: () => ctx.sku, onPick: sku => { state.to = sku; refresh(); } });
    const quick = (ctx.siblings || []).length ? h('div', { class: 'row wrap' }, h('span', { class: 'muted small' }, 'Other grades:'),
      ctx.siblings.map((s: J) => h('button', { type: 'button', class: 'btn btn-sm', title: s.name, onclick: () => picker.pick(s.sku, s.name) }, s.sku))) : null;
    const reason = h('textarea', { rows: 2, maxLength: 300, placeholder: 'e.g. Regraded: scratches missed at grading', oninput: () => { state.reason = reason.value; refresh(); } });
    const review = h('button', { type: 'button', class: 'btn btn-primary' }, 'Review change');
    function refresh() { review.disabled = !state.location || !state.to || !state.reason.trim(); }
    review.addEventListener('click', () => busy(review, async () => {
      status.replaceChildren();
      try {
        const r = await call<{ change: J }>('stock.preview', { kind: 'device', requestId: uuid(), serial: d.serial, recordId: d.recordId, toSku: state.to, location: state.location, reason: state.reason.trim() });
        mount(root, ...head, reviewCard(r.change, c => mount(root, doneCard(c, onClose)), () => mount(root, ...form)));
      } catch (err) { status.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Could not review this change.')); }
    }));
    const form = [...head,
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Cin7 location of this device'), select(CIN7_LOCATIONS, state.location, v => { state.location = v; refresh(); }, 'Cin7 location')),
      quick, picker.el,
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Reason'), reason),
      h('p', { class: 'muted small' }, 'Grade and colour in the Grading sheet follow the new product. Model changes are fine too: the ASNs Code is set to the new SKU.'),
      status, h('div', { class: 'row end wrap' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: onClose }, 'Cancel'), review)];
    mount(root, ...form);
    refresh();
  })();
  return root;
}

/** Admin: move a quantity of stock between two product codes, and list recent changes. */
export function stockCodeCard(): HTMLElement {
  const root = h('section', { class: 'stack' });
  const recent = h('div', {});
  const work = h('div', { class: 'stack' });

  function form() {
    const state = { location: 'Ready For Sale', from: '', to: '', qty: '1', reason: '' };
    const status = h('div', { class: 'status-slot' });
    const fromPicker = skuPicker({ label: 'From product code', location: () => state.location, onPick: sku => { state.from = sku; refresh(); } });
    const toPicker = skuPicker({ label: 'To product code', location: () => state.location, exclude: () => state.from, onPick: sku => { state.to = sku; refresh(); } });
    const qty = h('input', { type: 'number', min: '1', max: '500', step: '1', value: '1', 'aria-label': 'Quantity', oninput: () => { state.qty = qty.value; refresh(); } });
    const reason = h('textarea', { rows: 2, maxLength: 300, placeholder: 'e.g. Cases booked in under the wrong SKU', oninput: () => { state.reason = reason.value; refresh(); } });
    const review = h('button', { type: 'button', class: 'btn btn-primary' }, 'Review');
    function refresh() { review.disabled = !state.from || !state.to || !(Number(state.qty) >= 1) || !state.reason.trim(); }
    review.addEventListener('click', () => busy(review, async () => {
      status.replaceChildren();
      try {
        const r = await call<{ change: J }>('stock.preview', { kind: 'stock', requestId: uuid(), fromSku: state.from, toSku: state.to, quantity: Number(state.qty), location: state.location, reason: state.reason.trim() });
        mount(work, reviewCard(r.change, c => { mount(work, doneCard(c, () => form())); loadRecent(); }, () => form()));
      } catch (err) { status.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Could not review this change.')); }
    }));
    mount(work, h('div', { class: 'card stack' },
      h('p', { class: 'muted small' }, 'For stock without an IMEI (or a whole batch booked under the wrong code). Single devices: scan them in Grading and use Change product code instead, so the sheets update too.'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Cin7 location'), select(CIN7_LOCATIONS, state.location, v => { state.location = v; refresh(); }, 'Cin7 location')),
      fromPicker.el, toPicker.el,
      h('label', { class: 'field w-sm' }, h('span', { class: 'label' }, 'Quantity'), qty),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Reason'), reason),
      status, h('div', { class: 'row end' }, review)));
    refresh();
  }

  async function loadRecent() {
    try {
      const r = await call<{ changes: J[] }>('stock.recent');
      mount(recent, r.changes.length ? h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'What', 'Change', 'Location', 'By', 'Status'].map(t => h('th', {}, t)))),
        h('tbody', {}, r.changes.map(c => h('tr', {},
          h('td', {}, `${c.created_at.slice(5, 10)} ${nzTime(c.created_at)}`),
          h('td', {}, c.kind === 'device' ? h('span', { class: 'mono' }, c.serial) : `${c.quantity} unit${c.quantity === 1 ? '' : 's'}`),
          h('td', {}, h('span', { class: 'mono' }, `${c.from_sku} → ${c.to_sku}`), h('div', { class: 'muted small' }, c.reason)),
          h('td', {}, c.location), h('td', {}, c.staff_name),
          h('td', {}, h('span', { class: 'chip ' + (c.state === 'done' ? 'chip-synced' : c.state === 'review' ? 'chip-conflict' : 'chip-pending') }, changeState(c.state)),
            c.adjustment_number ? h('div', { class: 'muted small' }, c.adjustment_number) : null,
            c.error ? h('div', { class: 'small' }, c.error) : null)))))) : h('p', { class: 'muted small' }, 'No product-code changes yet.'));
    } catch (err) { mount(recent, message('error', err instanceof ApiError ? err.message : 'Recent changes unavailable.')); }
  }

  form(); loadRecent();
  mount(root, h('h2', {}, 'Move stock between product codes'), work, h('h3', {}, 'Product-code changes'), recent);
  return root;
}
