import { call, ApiError, J } from '../api.ts';
import { h, mount, message, nzTime, busy } from '../ui.ts';
import type { ScreenCtx } from '../main.ts';

// Operations at a glance: orders by stage, pick-ups, high alert, returns, testing, and Cin7
// Repairs/Locked stock. Counts come from portal_ops_dashboard. Cards whose source isn't connected
// to the portal yet say so instead of showing a number.

type Doc = { document_number: string; reference?: string; party?: string; document_date: string; business_days?: number; stage?: string; is_pickup?: boolean };
type StockItem = { sku: string; name: string; qty: number; age_days: number | null };
type AsnDevice = { serial: string; order_number: string; grade: string; location: string; status: string };
type PickOrder = { document_number: string; reference: string; party: string; document_date: string; carrier: string; is_pickup: boolean; address: string; note: string | null; lines: { sku: string; name: string; qty: number }[] };
type SyncItem = { kind: 'inflight' | 'blocked' | 'conflict'; serial: string; model: string | null; tester: string; grade: string; destination: string; createdAt: string; row: number | null; reason: string };
type AsnOrder = { order_number: string; shipment: string; delivered: string; devices: number };

const GRADING_TAB = 'https://docs.google.com/spreadsheets/d/1opKNiaciUV8-kdWrzID37F41j7DFcxlZSV5RCmi6NZU/edit#gid=1845935179';

function ago(iso?: string | null) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

function shortDate(d?: string | null) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: d.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' }).format(new Date(d + 'T12:00:00'));
}

/** Days since a date for "oldest" lines, in NZ calendar days. */
export function daysSince(d: string, now = new Date()): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(now);
  return Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
}

type CardOpts = {
  title: string; count?: number | null; unit?: string; note?: string; tone?: 'alert' | 'muted';
  status?: string; drill?: () => HTMLElement; drillLabel?: string;
};

export function dashboardScreen(_ctx: ScreenCtx): HTMLElement {
  const root = h('div', { class: 'stack ops' });
  const body = h('div', { class: 'stack' });
  const stamp = h('span', { class: 'muted small' });
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load() }, 'Refresh');

  function card(o: CardOpts) {
    const detail = h('div', { class: 'ops-drill', hidden: true });
    const big = o.count === undefined || o.count === null
      ? h('div', { class: 'ops-count none' }, h('span', { class: 'dash' }, '—'), h('span', { class: 'muted small' }, o.status || 'Not connected'))
      : h('div', { class: 'ops-count' + (o.tone === 'alert' && o.count > 0 ? ' alert' : '') }, h('span', { class: 'n' }, String(o.count)), o.unit ? h('span', { class: 'muted small' }, o.unit) : null);
    const foot = o.drill
      ? h('button', { type: 'button', class: 'ops-foot', 'aria-expanded': 'false', onclick: (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          const open = detail.hidden;
          if (open && !detail.childElementCount) detail.append(o.drill!());
          detail.hidden = !open;
          btn.closest('.ops-card')!.classList.toggle('open', open);
          btn.setAttribute('aria-expanded', String(open));
          btn.querySelector('.arrow')!.textContent = open ? '↑' : '→';
        } }, h('span', {}, o.drillLabel || 'Open queue'), h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'))
      : null;
    return h('article', { class: 'ops-card' + (o.tone === 'muted' ? ' muted-card' : '') },
      h('h3', {}, o.title), big, o.note ? h('p', { class: 'muted small ops-note' }, o.note) : h('div', { class: 'ops-note' }), foot, detail);
  }

  function docTable(rows: Doc[], extra?: (d: Doc) => string) {
    if (!rows.length) return h('p', { class: 'muted small' }, 'Nothing in this queue.');
    return h('table', { class: 'ops-table' }, h('tbody', {}, rows.map(d => h('tr', {},
      h('td', { class: 'mono' }, d.document_number),
      h('td', {}, d.party || '', d.reference && !/^Summary only/.test(d.reference) ? h('div', { class: 'muted small' }, d.reference) : null),
      h('td', { class: 'num' }, shortDate(d.document_date), extra ? h('div', { class: 'muted small' }, extra(d)) : null)))));
  }

  function stockTable(items: StockItem[]) {
    if (!items.length) return h('p', { class: 'muted small' }, 'No devices here.');
    return h('table', { class: 'ops-table' }, h('tbody', {}, items.map(i => h('tr', {},
      h('td', {}, i.name, h('div', { class: 'muted small mono' }, i.sku)),
      h('td', { class: 'num' }, `${i.qty}`), h('td', { class: 'num' }, i.age_days === null ? '—' : `${Math.round(Number(i.age_days))} d`)))));
  }

  function asnOrderTable(rows: AsnOrder[]) {
    if (!rows.length) return h('p', { class: 'muted small' }, 'Nothing waiting.');
    return h('table', { class: 'ops-table' }, h('tbody', {}, rows.map(o => h('tr', {},
      h('td', { class: 'mono' }, o.order_number, h('div', { class: 'muted small' }, `Shipment ${o.shipment}`)),
      h('td', {}, `Delivered ${o.delivered}`), h('td', { class: 'num' }, `${o.devices} device${o.devices === 1 ? '' : 's'}`)))));
  }

  function asnDeviceTable(rows: AsnDevice[]) {
    if (!rows.length) return h('p', { class: 'muted small' }, 'Nothing waiting.');
    return h('table', { class: 'ops-table' }, h('tbody', {}, rows.map(d => h('tr', {},
      h('td', { class: 'mono' }, d.serial, h('div', { class: 'muted small' }, `Order ${d.order_number}`)),
      h('td', {}, `Grade ${d.grade}`, d.location ? h('div', { class: 'muted small' }, d.location) : null),
      h('td', {}, d.status || h('span', { class: 'muted' }, '—'))))));
  }

  function syncTable(items: SyncItem[]) {
    if (!items.length) return h('p', { class: 'muted small' }, 'Nothing waiting. Saves are reaching the sheet.');
    const groups: [SyncItem['kind'], string, string][] = [
      ['inflight', 'Writing now', 'Normally in the sheet within about a minute.'],
      ['blocked', 'Stuck behind a conflict', 'A later save for the same device. It writes once the earlier conflict is resolved.'],
      ['conflict', 'Conflicts', 'Not written because the sheet row was edited by hand. The sheet keeps the manual edit.'],
    ];
    return h('div', { class: 'stack' }, groups.filter(([k]) => items.some(i => i.kind === k)).map(([k, title, help]) => h('div', {},
      h('strong', {}, `${title} (${items.filter(i => i.kind === k).length})`), h('div', { class: 'muted small' }, help),
      h('table', { class: 'ops-table' }, h('tbody', {}, items.filter(i => i.kind === k).map(i => h('tr', {},
        h('td', { class: 'mono' }, i.serial, i.model ? h('div', { class: 'muted small' }, i.model) : null),
        h('td', {}, `Grade ${i.grade} · ${i.tester || '—'}`, h('div', { class: 'muted small' }, `Saved ${shortDate(i.createdAt.slice(0, 10))} ${nzTime(i.createdAt)}`)),
        h('td', {}, i.reason),
        h('td', { class: 'num' }, i.row
          ? h('a', { href: `${GRADING_TAB}&range=A${i.row}`, target: '_blank', rel: 'noopener' }, `Row ${i.row} ↗`)
          : h('a', { href: GRADING_TAB, target: '_blank', rel: 'noopener', title: 'Not in the sheet yet. Opens the Grading tab; search for the serial.' }, 'Grading tab ↗')))))))));
  }

  function section(title: string, action: HTMLElement | null, ...cards: HTMLElement[]) {
    return h('section', { class: 'stack' },
      h('div', { class: 'row between' }, h('h2', {}, title), action),
      h('div', { class: 'ops-grid' }, cards));
  }

  // Pick lists for every New order, one page each, printed from a hidden print-only container.
  async function printPickLists(button: HTMLButtonElement) {
    await busy(button, async () => {
      try {
        const { orders } = await call<{ orders: PickOrder[] }>('dashboard.picklists');
        if (!orders.length) { button.textContent = 'No new orders'; return; }
        document.getElementById('print-root')?.remove();
        const printed = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
        const root = h('div', { id: 'print-root' }, orders.map(o => h('section', { class: 'pick-page' },
          h('div', { class: 'pick-head' },
            h('div', {}, h('div', { class: 'pick-so' }, o.document_number), h('div', {}, o.party || ''), o.reference ? h('div', { class: 'muted' }, o.reference) : null),
            h('div', { class: 'pick-meta' }, h('div', {}, 'Ordered ' + shortDate(o.document_date)), h('div', { class: 'pick-method' }, o.is_pickup ? 'PICK-UP' : 'COURIER'), h('div', { class: 'muted' }, o.carrier))),
          !o.is_pickup && o.address ? h('div', { class: 'pick-address' }, o.address) : null,
          h('table', { class: 'pick-table' },
            h('thead', {}, h('tr', {}, h('th', {}, '✓'), h('th', {}, 'Qty'), h('th', {}, 'SKU'), h('th', {}, 'Product'), h('th', {}, 'IMEI / serial'))),
            h('tbody', {}, o.lines.map(l => h('tr', {}, h('td', { class: 'tick' }, '☐'), h('td', { class: 'qty' }, String(l.qty)), h('td', { class: 'mono' }, l.sku), h('td', {}, l.name), h('td', { class: 'serial' }))))),
          o.note ? h('div', { class: 'pick-note' }, 'Note: ' + o.note) : null,
          h('div', { class: 'pick-foot' }, h('span', {}, 'Picked by ____________________'), h('span', { class: 'muted' }, `Printed ${printed}`)))));
        document.body.appendChild(root);
        const done = () => { root.remove(); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        window.print();
      } catch (err) { mount(body, message('error', err instanceof ApiError ? err.message : 'Pick lists could not be loaded.')); }
    });
  }

  function render(r: J) {
    const o = r.orders, lists = o.lists, st = r.stock || {}, rep = st.repairs || { devices: 0, items: [] }, lock = st.locked || { devices: 0, items: [] };
    const g = r.grading || {};
    const gq = r.gradingQueue || { inFlight: 0, blocked: 0, conflicts: 0, items: [] };
    // ASNs DB snapshot (apps-script/AsnOpsSync.gs). Cards say "Not connected" until the first sync,
    // and flag the source as stale if the sheet hasn't synced for 30 minutes.
    const asn = r.asn && r.asn.syncedAt ? r.asn : null;
    const asnStale = asn && Date.now() - Date.parse(asn.syncedAt) > 30 * 60000;
    const asnNote = () => asn ? `ASNs DB read ${ago(asn.syncedAt)}${asnStale ? ' (stale)' : ''}` : 'Waiting for ASNs DB sync';
    const ageNote = (s: J) => s.averageAgeDays != null ? `Avg age ${s.averageAgeDays} d · oldest ${s.oldestAgeDays ?? '—'} d` : undefined;
    stamp.textContent = `Updated ${nzTime(r.generatedAt)}`;
    const printBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: !o.new.count }, o.new.count ? `Print pick lists (${o.new.count})` : 'No new orders');
    printBtn.addEventListener('click', () => printPickLists(printBtn));
    mount(body,
      section('Orders', printBtn,
        card({ title: 'New', count: o.new.count, unit: 'orders', drill: () => docTable(lists.new, d => d.is_pickup ? 'Pick-up' : '') }),
        card({ title: 'Picked', count: o.picked.count, unit: 'orders', drill: () => docTable(lists.picked, d => d.is_pickup ? 'Pick-up' : '') }),
        card({ title: 'Packed · courier', count: o.packed.count, unit: 'orders', drill: () => docTable(lists.packed) }),
        card({ title: 'Awaiting pick-up', count: o.pickup.count, unit: 'orders', drill: () => docTable(lists.pickup, d => `${daysSince(d.document_date)} d waiting`) }),
        card({ title: 'High alert', count: o.alert.count, unit: 'orders', tone: 'alert', note: 'Over 1 business day old', drillLabel: 'Review overdue orders',
          drill: () => docTable(lists.alert, d => [`${d.business_days} business d`, (d.stage || '').toLowerCase(), d.is_pickup ? 'Pick-up' : ''].filter(Boolean).join(' · ')) })),
      section('Testing', null,
        card({ title: 'Received · not tested', count: asn ? asn.untested : null, unit: 'devices', tone: asnStale ? 'muted' : undefined,
          note: asnNote(), drillLabel: 'Review received devices', drill: asn ? () => asnOrderTable(asn.lists.untested) : undefined }),
        card({ title: 'Graded · not POed', count: asn ? asn.gradedNoPo : null, unit: 'devices', tone: asnStale ? 'muted' : undefined,
          note: asn ? `${asn.readyForPo} ready for PO · ${asn.repairsNoPo} repairs · ${asn.lockedNoPo} locked` : asnNote(), drillLabel: 'Review ready for PO', drill: asn ? () => asnDeviceTable(asn.lists.ready) : undefined }),
        card({ title: 'Grading sheet sync', count: gq.inFlight, unit: 'writing now',
          tone: gq.blocked + gq.conflicts > 0 ? 'alert' : undefined,
          note: gq.blocked + gq.conflicts ? `${gq.conflicts} conflict${gq.conflicts === 1 ? '' : 's'} · ${gq.blocked} stuck behind them` : 'All saves reaching the sheet',
          drillLabel: 'Review sync issues', drill: () => syncTable(gq.items) })),
      section('Repairs & unlocking', null,
        card({ title: 'Repairs · Cin7', count: rep.devices, unit: 'devices', note: ageNote(rep), drill: () => stockTable(rep.items) }),
        card({ title: 'Locked · Cin7', count: lock.devices, unit: 'devices', note: ageNote(lock), drill: () => stockTable(lock.items) }),
        card({ title: 'Repairs · not POed', count: asn ? asn.repairsNoPo : null, unit: 'devices', tone: asnStale ? 'muted' : undefined,
          note: asnStale || !asn ? asnNote() : undefined, drillLabel: 'Review ASN repairs', drill: asn ? () => asnDeviceTable(asn.lists.repairs) : undefined }),
        card({ title: 'Locked · not POed', count: asn ? asn.lockedNoPo : null, unit: 'devices', tone: asnStale ? 'muted' : undefined,
          note: asnStale || !asn ? asnNote() : undefined, drillLabel: 'Review ASN locked devices', drill: asn ? () => asnDeviceTable(asn.lists.locked) : undefined })),
      section('Returns', null,
        card({ title: 'Untriaged requests', count: r.returns.untriaged, unit: `of ${r.returns.total}`, tone: 'muted' }),
        card({ title: 'Received at GT', count: null, status: 'Not recorded yet' })),
      h('details', { class: 'ops-defs' },
        h('summary', {}, 'Count definitions & data freshness'),
        h('p', { class: 'small muted' }, 'Orders count once per open Cin7 sale, excluding quotes, drafts, voided, cancelled and completed sales. New = not picked. Picked = picked, not yet packed. Packed · courier = packed, not shipped, not a pick-up. Awaiting pick-up = ready notification recorded in the portal, not yet collected.'),
        h('p', { class: 'small muted' }, 'High alert uses the order date as day zero and counts Monday–Friday after it; more than 1 business day is overdue (a Friday order is overdue on Tuesday). It includes every open order, including shipped orders still awaiting invoice. NZ public holidays are not excluded yet.'),
        h('p', { class: 'small muted' }, 'Repairs and Locked count devices (phones, watches, tablets, laptops) on hand in the Cin7 Repairs and Locked Devices locations. Age is quantity-weighted stock age from purchase receipts, not time spent in the location.'),
        h('p', { class: 'small muted' }, 'Testing and "not POed" come from ASNs DB, read every 10 minutes. Received · not tested: no grade (column AA) on an order whose Shipment Check row has a Delivered date (column AL). Not POed: column AG blank and graded; Locked if status or location mentions lock, MDM or RML, Repairs for any other fault note or a Repairs location, otherwise ready for PO. Each serial counts once.'),
        h('p', { class: 'small muted' }, `Sales sync ${ago(r.freshness.orders)} · Stock sync ${ago(r.freshness.stock)} · Latest grading change ${ago(r.freshness.grading)} · ASNs DB read ${asn ? ago(asn.syncedAt) : 'never'} · Grading sheet worker ${ago(g.workerAt)} · Returns sync ${ago(r.freshness.returns)}`)));
  }

  async function load() {
    refreshBtn.disabled = true;
    if (!body.childElementCount) mount(body, h('p', { class: 'muted' }, 'Loading…'));
    try { render(await call('dashboard.ops')); }
    catch (err) { mount(body, message('error', err instanceof ApiError ? err.message : 'Operations data could not be loaded. Try Refresh.')); }
    finally { refreshBtn.disabled = false; }
  }

  mount(root, h('section', { class: 'card row between wrap' }, h('h1', {}, 'Dashboard'), h('div', { class: 'row' }, stamp, refreshBtn)), body);
  load();
  return root;
}
