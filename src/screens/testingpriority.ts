import { call, ApiError, J } from '../api.ts';
import { h, mount, message, nzTime } from '../ui.ts';

// Testing priority (from the "Daily testing priority" routine), shown at the top of Grading.
// Devices in received SOs still waiting to be tested, ranked by how soon each model runs out of
// Ready For Sale stock at its sales rate. Urgent < 7 days cover, High < 14, Medium < 30, else Low;
// fewer than 4 sold in 30 days drops a tier. "Test now" = units to reach 21 days of cover.

export const TIER_LABEL: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
const OPEN_KEY = 'gt.portal.priority.open';
const CUTOFF_KEY = 'gt.portal.cutoff.open';
const SHOW_KEY = 'gt.portal.priority.show';
type Show = 'urgent' | 'high' | 'all';

const soList = (sos: Record<string, number> = {}) =>
  Object.entries(sos).sort((a, b) => b[1] - a[1]).map(([so, n]) => `${so}×${n}`).join(', ');

export function priorityRows(d: J, show: Show): J[] {
  const max = show === 'urgent' ? 1 : show === 'high' ? 2 : 4;
  return (d.rows || []).filter((r: J) => r.tier <= max);
}

export function renderPriority(d: J, show: Show, onShow: (s: Show) => void): HTMLElement[] {
  const t = d.tiers || {};
  const rows = priorityRows(d, show);
  const toggle = (s: Show, label: string) => h('button', { type: 'button', class: 'btn btn-sm' + (s === show ? ' btn-primary' : ' btn-ghost'), onclick: () => onShow(s) }, label);
  return [
    h('p', { class: 'tp-summary' },
      h('strong', {}, `${d.total || 0} to test`), ' · ',
      h('span', { class: 'tp-tier tp-1' }, `${t.urgent || 0} urgent`), t.urgentModels ? ` (${t.urgentModels} models)` : '', ' · ',
      h('span', { class: 'tp-tier tp-2' }, `${t.high || 0} high`), ` · ${t.medium || 0} medium · ${t.low || 0} low`),
    h('div', { class: 'row wrap tp-show' }, toggle('urgent', 'Urgent'), toggle('high', 'Urgent + High'), toggle('all', 'All')),
    rows.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'so-table tp-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Model'), h('th', { class: 'num' }, 'Test now'), h('th', { class: 'num' }, 'To test'),
            h('th', { class: 'num so-opt' }, 'Sold 30d'), h('th', { class: 'num tp-opt' }, 'RFS'), h('th', { class: 'num' }, 'Cover'), h('th', { class: 'so-opt' }, 'SOs'))),
          h('tbody', {}, rows.map((r: J) => h('tr', { class: 'tp-row tp-' + r.tier },
            h('td', {}, h('span', { class: 'tp-dot', title: TIER_LABEL[r.tier] }), h('strong', {}, r.model), ` ${r.gb}`,
              h('div', { class: 'muted small tp-sos-inline' }, soList(r.sos))),
            h('td', { class: 'num' }, h('strong', {}, String(r.testNow))),
            h('td', { class: 'num' }, String(r.untested)),
            h('td', { class: 'num so-opt' }, String(r.sold30)),
            h('td', { class: 'num tp-opt' }, String(r.rfs)),
            h('td', { class: 'num' }, r.cover == null ? '—' : `${r.cover}d`),
            h('td', { class: 'so-opt small' }, soList(r.sos)))))))
      : h('p', { class: 'muted small' }, show === 'urgent' ? 'Nothing urgent to test.' : 'Nothing waiting to test.'),
    h('p', { class: 'muted small' },
      `Received SOs only: ${(d.bySo || []).map((s: J) => `${s.so} (${s.n})`).join(', ') || 'none'}. `,
      'Cover = days of Ready For Sale stock left at the current sales rate. Test now = units needed for 21 days of Ready For Sale stock at the current sales rate. ',
      `ASNs read ${d.asnSyncedAt ? nzTime(d.asnSyncedAt) : '—'}; sales & stock ${d.demandAt ? nzTime(d.demandAt) : 'not loaded yet'}.`),
  ];
}

const dayMonth = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });

/** Supplier returns: devices in SOs on day 7 or later since delivery (day 7 is the last day to raise
 * supplier returns), grouped by SO with day 7 first; untested devices first in each SO. */
export function renderCutoff(c: J): HTMLElement[] {
  const sos: J[] = c?.today || [];
  const tomorrow: J[] = c?.tomorrow || [];
  return [
    sos.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'so-table cutoff-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'Serial'), h('th', {}, 'Grade'), h('th', {}, 'Location'), h('th', { class: 'so-opt' }, 'Status'))),
      sos.map(so => h('tbody', {},
        h('tr', { class: 'cutoff-so' + (so.days === 7 ? ' cutoff-last' : '') }, h('td', { colspan: 5 },
          h('strong', {}, `SO ${so.so}`), ` · ${so.warehouse || ''} · delivered ${dayMonth(so.delivered)} · `,
          h('strong', {}, so.days === 7 ? 'Day 7 — last day today' : `Day ${so.days}`),
          ` · ${so.devices} device${so.devices === 1 ? '' : 's'}${so.untested ? `, ${so.untested} untested` : ''}`)),
        (so.items || []).map((d: J) => h('tr', {},
          h('td', {}, d.model || '—'), h('td', { class: 'mono small' }, d.serial),
          h('td', {}, d.tested ? d.grade || '—' : h('span', { class: 'cutoff-untested' }, 'Untested')),
          h('td', {}, d.location || '—'), h('td', { class: 'so-opt small' }, d.status || '')))))))
      : h('p', { class: 'muted small' }, 'No untested or Locked devices in orders on day 7 or later.'),
    tomorrow.length ? h('p', { class: 'small' }, h('strong', {}, 'Day 7 tomorrow: '),
      tomorrow.map(t => `SO ${t.so} (${t.devices} device${t.devices === 1 ? '' : 's'}${t.untested ? `, ${t.untested} untested` : ''})`).join(', ')) : null,
  ].filter(Boolean) as HTMLElement[];
}

function cutoffCard(): { el: HTMLElement; fill: (c: J) => void } {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Loading…'));
  const count = h('span', { class: 'muted small' });
  let open = true;
  try { open = localStorage.getItem(CUTOFF_KEY) !== '0'; } catch { /* private mode */ }
  const el = h('details', { class: 'card tp-card cutoff-card', open }, h('summary', {}, h('span', { class: 'tp-title' }, 'Supplier returns · day 7+'), count), body);
  el.addEventListener('toggle', () => { try { localStorage.setItem(CUTOFF_KEY, el.open ? '1' : '0'); } catch { /* ignore */ } });
  const fill = (c: J) => {
    const sos: J[] = c?.today || [];
    const devices = sos.reduce((n, x) => n + Number(x.devices || 0), 0);
    const last = sos.filter(x => x.days === 7).reduce((n, x) => n + Number(x.devices || 0), 0);
    count.textContent = ` · ${devices} device${devices === 1 ? '' : 's'} in ${sos.length} order${sos.length === 1 ? '' : 's'}${last ? ` · ${last} on day 7 (last day)` : ''}`;
    el.classList.toggle('cutoff-urgent', last > 0);
    mount(body, h('p', { class: 'muted small' }, 'Day 7 after delivery is the last day to return devices to the supplier. Untested and Locked devices in received orders on day 7 or later.'), ...renderCutoff(c));
  };
  return { el, fill };
}

/** The collapsible Testing priority card for the top of the Grading tab. */
export function testingPriorityCard(): HTMLElement {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Loading…'));
  const count = h('span', { class: 'muted small' });
  let open = true, show: Show = 'urgent';
  try { open = localStorage.getItem(OPEN_KEY) !== '0'; show = (localStorage.getItem(SHOW_KEY) as Show) || 'urgent'; } catch { /* private mode */ }
  const box = h('details', { class: 'card tp-card', open }, h('summary', {}, h('span', { class: 'tp-title' }, 'Testing priority'), count), body);
  box.addEventListener('toggle', () => { try { localStorage.setItem(OPEN_KEY, box.open ? '1' : '0'); } catch { /* ignore */ } });
  let data: J | null = null;
  const draw = () => {
    if (!data) return;
    count.textContent = ` · ${data.tiers?.urgent || 0} urgent of ${data.total || 0}`;
    mount(body, ...renderPriority(data, show, s => { show = s; try { localStorage.setItem(SHOW_KEY, s); } catch { /* ignore */ } draw(); }));
  };
  const cutoff = cutoffCard();
  call<J>('grading.priority')
    .then(d => { data = d; draw(); cutoff.fill(d.cutoff); if (!d.cutoff) cutoff.el.remove(); })
    .catch(err => { cutoff.el.remove(); mount(body, message('error', err instanceof ApiError ? err.message : 'Testing priority unavailable.')); });
  return h('div', { class: 'stack' }, cutoff.el, box);
}
