import { callUrl, SALES_OPS_URL, ApiError, J } from '../api.ts';
import { h, mount, message, segmented } from '../ui.ts';

// Sales & Ops: managers only, on approved devices (Fraser's own). The portal-sales-ops function
// checks the signed-in role and the device on every request. No extra PIN: the portal sign-in
// (name + PIN) and its 5-minute idle sign-out still apply.

export type Period = 'today' | 'yesterday' | '7d' | '30d';
const PERIODS: readonly Period[] = ['today', 'yesterday', '7d', '30d'];
const PERIOD_LABEL: Record<Period, string> = { today: 'Today', yesterday: 'Yesterday', '7d': '7 days', '30d': '30 days' };

const ops = <T = J>(action: string, body: J = {}) => callUrl<T>(SALES_OPS_URL, action, body);

/** Whether this signed-in person on this terminal can see Sales & Ops (server decides). */
export async function salesOpsAvailable(): Promise<boolean> {
  try { return (await ops<{ allowed: boolean }>('access')).allowed === true; } catch { return false; }
}

/** Minutes as a short duration: 14 min, 2 h 15 m, 1 d 3 h. */
export function duration(min: number | null | undefined) {
  if (min == null || !Number.isFinite(Number(min))) return '—';
  const m = Math.round(Number(min));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`;
  const h = Math.round(m / 60);
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

const nz = (n: number, d = 0) => new Intl.NumberFormat('en-NZ', { maximumFractionDigits: d, minimumFractionDigits: d }).format(n);
export const dollars = (n: number | null | undefined) => n == null ? '—' : (n < 0 ? '−$' : '$') + nz(Math.abs(Number(n)));
export const pct = (n: number | null | undefined) => n == null ? '—' : nz(Number(n), 1) + '%';

function kpi(label: string, value: string, sub?: string) {
  return h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, value), h('div', { class: 'kpi-k' }, label), sub ? h('div', { class: 'kpi-s' }, sub) : null);
}

/** `phoneHidden`: column indexes dropped on narrow phones so tables fit without scrolling. */
function table(head: string[], rows: (string | number | null)[][], numericFrom = 1, phoneHidden: number[] = []) {
  if (!rows.length) return h('p', { class: 'muted small' }, 'Nothing in this period.');
  const cls = (i: number) => [i >= numericFrom ? 'num' : '', phoneHidden.includes(i) ? 'so-opt' : ''].filter(Boolean).join(' ');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'so-table' },
    h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: cls(i) }, t)))),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { class: cls(i) }, c == null ? '—' : String(c))))))));
}

function card(title: string, ...body: (HTMLElement | null)[]) {
  return h('section', { class: 'so-card' }, h('h2', {}, title), ...body);
}

export function renderSalesOps(d: J): HTMLElement[] {
  const s = d.sales || {}, r = d.returns || {};
  const range = d.from === d.to ? d.from : `${d.from} – ${d.to}`;
  return [
    card('Sales (net of returns)',
      h('div', { class: 'kpis' },
        kpi('Devices sold', nz(s.deviceUnits || 0), s.returnedDevices ? `${nz(s.grossDeviceUnits || 0)} sold − ${nz(s.returnedDevices)} returned` : (s.otherUnits ? `+ ${nz(s.otherUnits)} accessories & other` : undefined)),
        kpi('Revenue ex GST', dollars(s.revenue), s.returnedCredit ? `${dollars(s.grossRevenue)} − ${dollars(s.returnedCredit)} credited` : undefined),
        kpi('GP', dollars(s.gp)),
        kpi('GP %', pct(s.gpPct))),
      h('p', { class: 'muted small' }, [
        'Returns credited in the period come off units, revenue and GP (returned items back at their Cin7 average cost); models, channels and staff below are net too.',
        s.returnedDevices && s.otherUnits ? ` Accessories & other: ${nz(s.otherUnits)} net.` : '',
        s.revenueWithoutCost ? ` GP % excludes ${dollars(s.revenueWithoutCost)} of sales with no cost recorded (mostly repairs).` : '',
      ].join(''))),
    card('Top 10 models', table(['Model', 'Net units', 'Revenue', 'GP', 'GP %'],
      (d.topModels || []).map((m: J) => [m.model, m.units, dollars(m.revenue), dollars(m.gp), pct(m.gpPct)]), 1, [3])),
    card('Channels', table(['Channel', 'Devices', 'Revenue', 'GP', 'GP %'],
      (d.channels || []).map((c: J) => [c.name, c.units, dollars(c.revenue), dollars(c.gp), pct(c.gpPct)]), 1, [3])),
    card('Sales type', table(['Type', 'Devices', 'Revenue', 'GP', 'GP %'],
      (d.types || []).map((c: J) => [c.name, c.units, dollars(c.revenue), dollars(c.gp), pct(c.gpPct)]), 1, [3]),
      h('p', { class: 'muted small' }, 'Website, Reebelo and Trade Me are the online channels; In-store sales = in-store devices and accessories; Repairs, Replacement (replacement devices for returns) and Warranty come from the Cin7 sales group / sales rep. Net of returns.')),
    card('Staff sales', table(['Staff', 'Devices', 'Revenue', 'GP', 'GP %'],
      (d.staff || []).map((c: J) => [c.name === 'Unassigned' ? 'No salesperson' : c.name, c.units, dollars(c.revenue), dollars(c.gp), pct(c.gpPct)]), 1, [3])),
    card('Returns',
      h('div', { class: 'kpis' },
        kpi('Returns', nz(r.count || 0), r.credits != null ? `${nz(r.credits)} credited` : undefined),
        kpi('Credit ex GST', dollars(r.creditValue)),
        kpi('Return rate', pct(r.rate), `${nz(r.deviceReturns || 0)} devices vs ${nz(s.grossDeviceUnits ?? s.deviceUnits ?? 0)} sold`)),
      table(['Top reasons', 'Count'], (r.reasons || []).map((x: J) => [x.reason, x.count]))),
    emailCard(d.email),
    card('Orders shipped',
      h('div', { class: 'kpis' }, kpi('Orders', nz(d.shipped?.orders || 0)), kpi('Devices', nz(d.shipped?.devices || 0))),
      table(['Staff', 'Orders', 'Devices'], (d.shipped?.staff || []).map((x: J) => [x.name, x.orders, x.devices]))),
    card('Devices tested',
      h('div', { class: 'kpis' }, kpi('Devices', nz(d.tested?.devices || 0))),
      table(['Staff', 'Devices'], (d.tested?.staff || []).map((x: J) => [x.name, x.devices]))),
    card('Selling fast, low stock',
      h('p', { class: 'muted small' }, 'Top 5 by weeks of Ready For Sale cover, among models selling 2+ a week (weeks-of-cover scorecard; not affected by the period).'),
      table(['Model', '30 days', 'RFS', 'Wks', 'Action'],
        (d.lowStock || []).map((x: J) => [`${x.model}${x.gb ? ' ' + x.gb + 'GB' : ''}`, x.sold30d, x.rfs, x.wocRfs, x.action]), 1)),
    h('p', { class: 'muted small so-foot' }, `${range} (NZ time). Cin7 sales to ${fmtTime(d.freshness?.sales)} · returns to ${fmtTime(d.freshness?.returns)} · refreshed ${fmtTime(d.freshness?.cache)} (every 10 min) · stock ${fmtTime(d.freshness?.stock)}. Sales are Cin7 lines counted in general sales; revenue and credits ex GST. Sales with no salesperson show as Shopify (website, Reebelo and Trade Me orders) or their Cin7 sales rep role (In-Store Sales, Replacement, Repairs, Warranty).`),
  ];
}

/** Email: replies sent in the period by staff, and customer threads open now. */
function emailCard(e: J = {}) {
  const o = e.open || {};
  return card('Email',
    h('div', { class: 'kpis' },
      kpi('Replies sent', nz(e.replies || 0), `${nz(e.threads || 0)} conversations`),
      kpi('Median first reply', duration(e.medianMinutes)),
      kpi('Open now', nz(o.total || 0), `${nz(o.under24h || 0)} under 24 h · ${nz(o.days1to3 || 0)} 1–3 days · ${nz(o.days3to14 || 0)} 3–14 days`)),
    table(['Replied by', 'Replies', 'Conversations', 'Median first reply'],
      (e.staff || []).map((x: J) => [x.name === 'Unsigned' ? 'Not signed' : x.name, x.replies, x.threads, duration(x.medianMinutes)]), 1, [2]),
    (e.longestWaiting || []).length ? table(['Waiting longest', 'Waiting'], e.longestWaiting.map((x: J) => [x.subject, duration(Number(x.hours) * 60)])) : null,
    h('p', { class: 'muted small' }, `Replies are counted in the period; open is now (last message from the customer, unanswered). Open counts customer emails only: people we've replied to before or personal addresses (Gmail, Hotmail, iCloud…). Left out: ${nz(o.acknowledged || 0)} where the customer's follow-up to our reply needs no answer (thanks, OK, confirmations), ${nz(o.otherSenders || 0)} from suppliers, marketing and notifications, and ${nz(o.older || 0)} customer threads waiting over 14 days. Mailbox synced ${fmtTime(e.syncedAt)}.`));
}

/** Timestamps with a zone are shown in NZ time; Cin7's zoneless ones are already NZ local time. */
export function fmtTime(v?: string | null) {
  if (!v) return '—';
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v);
  if (local && !/([zZ]|[+-]\d\d:?\d\d)$/.test(v)) {
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(local[2]) - 1];
    return `${Number(local[3])} ${month} ${local[4]}:${local[5]}`;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  const parts = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t);
  const get = (k: string) => parts.find(p => p.type === k)?.value || '';
  return `${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
}

export function salesOpsScreen(): HTMLElement {
  const root = h('div', { class: 'stack so' });
  const body = h('div', { class: 'stack' });
  let period: Period = 'today';
  let loading = 0;

  const periodSeg = segmented<Period>({ name: 'Period', options: PERIODS, value: period, labels: PERIOD_LABEL, className: 'so-periods', onChange: p => { period = p; load(); } });
  const head = h('section', { class: 'card so-head' }, h('h1', {}, 'Sales & Ops'), periodSeg);

  async function load() {
    const mine = ++loading;
    if (!body.querySelector('.so-card')) mount(body, h('p', { class: 'muted' }, 'Loading…'));
    else body.classList.add('so-busy');
    try {
      const d = await ops('data', { period });
      if (mine !== loading) return;
      mount(body, h('div', { class: 'so-grid' }, renderSalesOps(d)), devicesCard());
    } catch (err) {
      if (mine !== loading) return;
      mount(body, message('error', err instanceof ApiError ? err.message : 'Sales & Ops could not be loaded.'));
    } finally { body.classList.remove('so-busy'); }
  }

  // Which devices may open this page (only from a device that already has access).
  function devicesCard() {
    const list = h('div', { class: 'stack' });
    const box = h('details', { class: 'card so-devices' }, h('summary', {}, 'Devices with access'), list);
    box.addEventListener('toggle', () => { if (box.open && !list.childElementCount) render(); });
    async function render(action = 'devices', extra: J = {}) {
      try {
        const r = await ops<{ devices: J[]; current: string }>(action, extra);
        mount(list, h('p', { class: 'muted small' }, 'Enrolled terminals. Only managers on ticked devices see Sales & Ops. Enrol a new device with a code from Admin, then tick it here.'),
          ...r.devices.map(t => {
            const cb = h('input', { type: 'checkbox', checked: t.allowed, disabled: t.id === r.current, onchange: () => render('set_device', { terminalId: t.id, allow: cb.checked }) });
            return h('label', { class: 'row so-device' }, cb, h('span', {}, h('strong', {}, t.name), t.id === r.current ? h('span', { class: 'muted small' }, ' · this device') : null));
          }));
      } catch (err) {
        mount(list, message('error', err instanceof ApiError ? err.message : 'Devices unavailable.'));
      }
    }
    return box;
  }

  mount(root, head, body);
  load();
  return root;
}
