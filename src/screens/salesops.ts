import { callUrl, SALES_OPS_URL, ApiError, J } from '../api.ts';
import { h, mount, message, segmented, pinPad, nzTime } from '../ui.ts';

// Sales & Ops: managers only, on approved devices (checked by the portal-sales-ops function on
// every request). The page always opens locked and asks for the PIN. It locks again after
// 5 minutes without use, when you leave the page, or when a badge/barcode scan is detected.

export type Period = 'today' | 'yesterday' | '7d' | '30d';
const PERIODS: readonly Period[] = ['today', 'yesterday', '7d', '30d'];
const PERIOD_LABEL: Record<Period, string> = { today: 'Today', yesterday: 'Yesterday', '7d': '7 days', '30d': '30 days' };
export const LOCK_IDLE_MS = 5 * 60 * 1000;

const ops = <T = J>(action: string, body: J = {}) => callUrl<T>(SALES_OPS_URL, action, body);

/** Whether this signed-in person on this terminal can see Sales & Ops (server decides). */
export async function salesOpsAvailable(): Promise<boolean> {
  try { return (await ops<{ allowed: boolean }>('access')).allowed === true; } catch { return false; }
}

/**
 * Detects a badge/barcode scanner: scanners "type" a burst of characters a few milliseconds apart,
 * ending in Enter. People can't type 6+ characters at under ~35 ms per key.
 */
export class ScanDetector {
  private times: number[] = [];
  constructor(private minChars = 6, private maxGapMs = 35) {}
  /** Feed every keydown; returns true when a scan has just finished. */
  key(key: string, at: number): boolean {
    if (key === 'Enter') {
      const fast = this.times.length >= this.minChars;
      this.times = [];
      return fast;
    }
    if (key.length !== 1) return false;
    const last = this.times[this.times.length - 1];
    if (last !== undefined && at - last > this.maxGapMs) this.times = [];
    this.times.push(at);
    return false;
  }
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
    card('Sales',
      h('div', { class: 'kpis' },
        kpi('Devices sold', nz(s.deviceUnits || 0), s.otherUnits ? `+ ${nz(s.otherUnits)} accessories & other` : undefined),
        kpi('Revenue ex GST', dollars(s.revenue)),
        kpi('GP', dollars(s.gp)),
        kpi('GP %', pct(s.gpPct))),
      s.revenueWithoutCost ? h('p', { class: 'muted small' }, `GP % excludes ${dollars(s.revenueWithoutCost)} of sales with no cost recorded (mostly repairs).`) : null),
    card('Top 10 models', table(['Model', 'Units', 'Revenue', 'GP', 'GP %'],
      (d.topModels || []).map((m: J) => [m.model, m.units, dollars(m.revenue), dollars(m.gp), pct(m.gpPct)]), 1, [3])),
    card('Channels', table(['Channel', 'Devices', 'Revenue', 'GP', 'GP %'],
      (d.channels || []).map((c: J) => [c.name, c.units, dollars(c.revenue), dollars(c.gp), pct(c.gpPct)]), 1, [3])),
    card('Staff sales', table(['Staff', 'Devices', 'Revenue', 'GP', 'GP %'],
      (d.staff || []).map((c: J) => [c.name, c.units, dollars(c.revenue), dollars(c.gp), pct(c.gpPct)]), 1, [3])),
    card('Returns',
      h('div', { class: 'kpis' },
        kpi('Returns', nz(r.count || 0), r.credits != null ? `${nz(r.credits)} credited` : undefined),
        kpi('Credit ex GST', dollars(r.creditValue)),
        kpi('Return rate', pct(r.rate), `${nz(r.deviceReturns || 0)} devices vs ${nz(s.deviceUnits || 0)} sold`)),
      table(['Top reasons', 'Count'], (r.reasons || []).map((x: J) => [x.reason, x.count]))),
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
    h('p', { class: 'muted small so-foot' }, `${range} (NZ time). Sales data to ${fmtTime(d.freshness?.sales)} · returns to ${fmtTime(d.freshness?.returns)} · stock ${fmtTime(d.freshness?.stock)}. Sales are Cin7 lines counted in general sales; revenue and credits ex GST.`),
  ];
}

function fmtTime(v?: string | null) {
  if (!v) return '—';
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + '+13:00'; // NZ local timestamps without zone
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short' })} ${nzTime(new Date(t).toISOString())}` : v;
}

export function salesOpsScreen(): HTMLElement {
  const root = h('div', { class: 'stack so' });
  const body = h('div', { class: 'stack' });
  let token = '';
  let period: Period = 'today';
  let lastUse = Date.now();
  let lastServer = Date.now();
  let loading = 0;
  const scans = new ScanDetector();

  const periodSeg = segmented<Period>({ name: 'Period', options: PERIODS, value: period, labels: PERIOD_LABEL, className: 'so-periods', onChange: p => { period = p; load(); } });
  const lockBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => lock('Locked.') }, 'Lock');
  const head = h('section', { class: 'card so-head' }, h('div', { class: 'row between wrap' }, h('h1', {}, 'Sales & Ops'), lockBtn), periodSeg);

  function showLocked(note?: string) {
    token = '';
    head.hidden = true;
    const status = h('div', { class: 'status-slot' }, note ? message('info', note) : null);
    const pad = pinPad({ label: 'Enter your PIN to open Sales & Ops', onComplete: async pin => {
      status.replaceChildren(message('info', 'Checking…'));
      try {
        const r = await ops<{ token: string }>('unlock', { pin });
        token = r.token; lastUse = lastServer = Date.now(); head.hidden = false;
        load();
      } catch (err) {
        status.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Could not unlock.'));
        pad.reset();
      }
    } });
    mount(body, h('section', { class: 'card narrow stack so-lock' }, h('h1', {}, 'Sales & Ops'), status, pad));
    setTimeout(() => pad.focusPad());
  }

  function lock(note: string) {
    const t = token;
    if (t) ops('lock', { token: t }).catch(() => {});
    showLocked(note);
  }

  async function load() {
    if (!token) return showLocked();
    const mine = ++loading;
    lastUse = lastServer = Date.now();
    if (!body.querySelector('.so-card')) mount(body, h('p', { class: 'muted' }, 'Loading…'));
    else body.classList.add('so-busy');
    try {
      const d = await ops('data', { token, period });
      if (mine !== loading || !token) return;
      mount(body, h('div', { class: 'so-grid' }, renderSalesOps(d)), devicesCard());
    } catch (err) {
      if (mine !== loading) return;
      if (err instanceof ApiError && (err.data.locked || err.data.pinRequired)) return showLocked(err.message);
      mount(body, message('error', err instanceof ApiError ? err.message : 'Sales & Ops could not be loaded.'));
    } finally { body.classList.remove('so-busy'); }
  }

  // Which devices may open this page. Changing it needs this page unlocked (manager + PIN).
  function devicesCard() {
    const list = h('div', { class: 'stack' });
    const box = h('details', { class: 'card so-devices' }, h('summary', {}, 'Devices with access'), list);
    box.addEventListener('toggle', () => { if (box.open && !list.childElementCount) render(); });
    async function render(action = 'devices', extra: J = {}) {
      try {
        const r = await ops<{ devices: J[]; current: string }>(action, { token, ...extra });
        mount(list, h('p', { class: 'muted small' }, 'Enrolled terminals. Only managers on ticked devices see Sales & Ops. Enrol a new device with a code from Admin, then tick it here.'),
          ...r.devices.map(t => {
            const cb = h('input', { type: 'checkbox', checked: t.allowed, disabled: t.id === r.current, onchange: () => render('set_device', { terminalId: t.id, allow: cb.checked }) });
            return h('label', { class: 'row so-device' }, cb, h('span', {}, h('strong', {}, t.name), t.id === r.current ? h('span', { class: 'muted small' }, ' · this device') : null));
          }));
      } catch (err) {
        if (err instanceof ApiError && err.data.locked) return showLocked(err.message);
        mount(list, message('error', err instanceof ApiError ? err.message : 'Devices unavailable.'));
      }
    }
    return box;
  }

  const activity = () => { if (token) lastUse = Date.now(); };
  const onKey = (e: KeyboardEvent) => {
    if (scans.key(e.key, e.timeStamp || performance.now())) lock('Locked after a badge scan.');
    else activity();
  };
  window.addEventListener('keydown', onKey, true);
  for (const ev of ['pointerdown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(ev, activity, { passive: true, capture: true });
  const timer = window.setInterval(() => {
    if (!root.isConnected) {
      // Left the page: lock and stop listening.
      clearInterval(timer);
      window.removeEventListener('keydown', onKey, true);
      for (const ev of ['pointerdown', 'wheel', 'touchstart', 'scroll']) window.removeEventListener(ev, activity, true);
      if (token) ops('lock', { token }).catch(() => {});
      token = '';
      return;
    }
    if (token && Date.now() - lastUse > LOCK_IDLE_MS) { lock('Locked after 5 minutes without activity.'); return; }
    if (token && lastUse > lastServer && Date.now() - lastServer > 60000) {
      lastServer = Date.now();
      ops('touch', { token }).catch(err => { if (err instanceof ApiError && err.data.locked) showLocked(err.message); });
    }
  }, 1000);

  mount(root, head, body);
  showLocked();
  return root;
}
