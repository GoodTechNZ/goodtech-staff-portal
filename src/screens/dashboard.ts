import { auth, call, ApiError, J } from '../api.ts';
import { h, mount, message, askPin, nzTime, nzToday, money, busy } from '../ui.ts';
import type { ScreenCtx } from '../main.ts';

// Daily per-person summary and review flags. Staff see their own day; managers see everyone,
// system health, and can manage staff badges/PINs and terminals.

function ago(iso?: string | null) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

function stat(k: string, v: string | number, bad = false) {
  return h('div', { class: 'stat' + (bad ? ' bad' : '') }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k));
}

export function dashboardScreen(_ctx: ScreenCtx): HTMLElement {
  const root = h('div', { class: 'stack' });
  const day = h('input', { type: 'date', value: nzToday(), max: nzToday(), 'aria-label': 'Day' });
  const body = h('div', { class: 'stack' });
  const manager = auth.staff?.role === 'manager';
  day.addEventListener('change', () => load());

  async function load() {
    mount(body, h('p', { class: 'muted' }, 'Loading…'));
    try {
      const r = await call('dashboard.summary', { day: day.value });
      render(r);
    } catch (err) { mount(body, message('error', err instanceof ApiError ? err.message : 'Dashboard unavailable.')); }
  }

  function render(r: J) {
    const people: J[] = r.people || [];
    const flagged = people.filter(p => p.flags?.length);
    const g = r.health?.grading;
    const workerStale = g?.workerAt && Date.now() - Date.parse(g.workerAt) > 15 * 60000;
    mount(body,
      r.health ? h('section', { class: 'stack' }, h('h2', {}, 'Grading sheet sync'),
        h('div', { class: 'cards' },
          stat('Waiting to write', g.pending, g.pending > 20),
          stat('Conflicts to review', g.conflicts, g.conflicts > 0),
          stat('Linked to existing rows today', g.linkedToday),
          stat('Sheet worker last ran', ago(g.workerAt), !!workerStale),
          stat('Sheet last imported', ago(g.importAt)),
          stat('Signed in now', r.health.sessions.active))) : null,
      manager ? h('section', { class: 'stack' }, h('h2', {}, `Flags (${flagged.reduce((n, p) => n + p.flags.length, 0)})`),
        flagged.length ? h('div', { class: 'card' }, h('table', {}, h('tbody', {}, flagged.flatMap(p => p.flags.map((f: J) =>
          h('tr', {}, h('td', {}, h('strong', {}, p.name)), h('td', {}, h('span', { class: 'chip chip-' + f.severity }, f.severity)), h('td', {}, f.message))))))) : h('p', { class: 'muted' }, 'No flags for this day.')) : null,
      h('section', { class: 'stack' }, h('h2', {}, manager ? 'People' : 'My day'),
        people.length ? h('div', { class: 'card table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Name', 'Hours', 'Graded', 'G1/G2/G3', 'Linked', 'Regrades', 'Orders shipped', 'Devices verified', 'Overrides', 'Sales', 'Sales total', 'Sign-ins', 'Idle outs', 'Errors'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t)))),
          h('tbody', {}, people.map(p => {
            const s = p.summary;
            return h('tr', {},
              h('td', {}, h('strong', {}, p.name), p.flags?.length && !manager ? h('div', { class: 'flags' }, p.flags.map((f: J) => h('span', { class: 'chip chip-' + f.severity }, f.message))) : null),
              h('td', {}, `${nzTime(s.firstAt)}–${nzTime(s.lastAt)}`),
              h('td', { class: 'num' }, s.grading.devices),
              h('td', { class: 'num' }, `${s.grading.grades['1']}/${s.grading.grades['2']}/${s.grading.grades['3']}`),
              h('td', { class: 'num' }, s.grading.linked),
              h('td', { class: 'num' }, s.grading.regrades),
              h('td', { class: 'num' }, s.shipping.orders),
              h('td', { class: 'num' }, s.shipping.devicesVerified),
              h('td', { class: 'num' }, s.shipping.overrides),
              h('td', { class: 'num' }, s.sales.completed),
              h('td', { class: 'num' }, money(Number(s.sales.total))),
              h('td', { class: 'num' }, s.signIns),
              h('td', { class: 'num' }, s.idleSignOuts),
              h('td', { class: 'num' }, s.errors));
          })))) : h('p', { class: 'muted' }, 'No portal activity on this day.')),
      manager ? adminSection() : null);
  }

  function adminSection() {
    const box = h('section', { class: 'stack' }, h('h2', {}, 'Staff & terminals'), h('p', { class: 'muted' }, 'Loading…'));
    const slot = h('div', { class: 'status-slot' });

    async function run(action: string, args: J, title: string, button?: HTMLButtonElement) {
      slot.replaceChildren();
      const pin = await askPin(title);
      if (!pin) return;
      await busy(button || null, async () => {
        try { await call(`admin.${action}`, { ...args, pin }); slot.replaceChildren(message('ok', 'Done.')); await loadAdmin(); }
        catch (err) { slot.replaceChildren(message('error', (err as Error).message)); }
      });
    }

    async function loadAdmin() {
      try {
        const [s, t] = await Promise.all([call('admin.staff'), call('admin.terminals')]);
        const addName = h('input', { type: 'text', placeholder: 'New staff name', maxLength: 60 });
        const addBtn = h('button', { type: 'button', class: 'btn' }, 'Add staff');
        addBtn.onclick = () => addName.value.trim() && run('add_staff', { name: addName.value.trim() }, `Add ${addName.value.trim()}`, addBtn);
        const btn = (label: string, action: string, st: J, title: string, cls = 'btn btn-sm') => {
          const b = h('button', { type: 'button', class: cls }, label);
          b.onclick = () => run(action, { staffId: st.id }, title, b);
          return b;
        };
        mount(box, h('h2', {}, 'Staff & terminals'), slot,
          h('div', { class: 'card table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Name', 'Role', 'Badge', 'PIN', 'Actions'].map(x => h('th', {}, x)))),
            h('tbody', {}, s.staff.map((st: J) => h('tr', {},
              h('td', {}, h('strong', {}, st.name), st.formerNames?.length ? h('div', { class: 'muted small' }, 'formerly ' + st.formerNames.join(', ')) : null, !st.active ? h('span', { class: 'chip chip-error' }, 'inactive') : null),
              h('td', {}, st.role),
              h('td', {}, st.hasBadge ? 'Registered' : h('span', { class: 'muted' }, 'Not yet')),
              h('td', {}, st.locked ? h('span', { class: 'chip chip-error' }, 'Locked') : st.hasPin ? 'Set' : h('span', { class: 'muted' }, 'Not set')),
              h('td', {}, h('div', { class: 'row wrap' },
                st.locked ? btn('Unlock', 'unlock', st, `Unlock ${st.name}`) : null,
                st.hasPin ? btn('Reset PIN', 'reset_pin', st, `Reset ${st.name}'s PIN`) : null,
                st.hasBadge ? btn('Reset badge', 'reset_badge', st, `Reset ${st.name}'s badge and PIN`) : null,
                st.active ? btn('Deactivate', 'deactivate', st, `Deactivate ${st.name}`, 'btn btn-sm btn-ghost') : btn('Activate', 'activate', st, `Activate ${st.name}`)))))))),
          h('div', { class: 'row' }, addName, addBtn),
          h('div', { class: 'card table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Terminal', 'Enrolled', 'Last used', ''].map(x => h('th', {}, x)))),
            h('tbody', {}, t.terminals.map((x: J) => {
              const b = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, 'Revoke');
              b.onclick = () => run('revoke_terminal', { terminalId: x.id }, `Revoke terminal ${x.name}`, b);
              return h('tr', {}, h('td', {}, x.name, x.revoked_at ? h('span', { class: 'chip chip-error' }, ' revoked') : null),
                h('td', {}, new Date(x.created_at).toLocaleDateString('en-NZ')), h('td', {}, ago(x.last_seen_at)), h('td', {}, x.revoked_at ? null : b));
            })))));
      } catch (err) { mount(box, h('h2', {}, 'Staff & terminals'), message('error', (err as Error).message)); }
    }
    loadAdmin();
    return box;
  }

  mount(root, h('section', { class: 'card row between wrap' }, h('h1', {}, 'Dashboard'), h('div', { class: 'row' }, day, h('button', { type: 'button', class: 'btn', onclick: () => load() }, 'Refresh'))), body);
  load();
  return root;
}
