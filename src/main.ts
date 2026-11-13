import './styles.css';
import { auth, call, onSignedOut, onTerminalLost, lastServerContact } from './api.ts';
import type { Staff } from './api.ts';
import { IdleTimer } from './idle.ts';
import { h, mount, doneToast, unlockPanel, message } from './ui.ts';
import { setupScreen } from './screens/setup.ts';
import { signInScreen, signInAs } from './screens/signin.ts';
import type { Person } from './screens/signin.ts';
import { gradingScreen } from './screens/grading.ts';
import { shippingScreen } from './screens/shipping.ts';
import { salesScreen } from './screens/sales.ts';
import { dashboardScreen } from './screens/dashboard.ts';
import { adminScreen } from './screens/admin.ts';
import { returnsScreen } from './screens/returns.ts';
import { salesOpsScreen, salesOpsAvailable } from './screens/salesops.ts';

export type ScreenCtx = {
  /** Called after a completed device/order: show a confirmation and reset the screen for the next one. */
  completed: (title: string, lines: string[]) => Promise<void>;
};

const TABS = [
  { id: 'dashboard', label: 'Dashboard', screen: dashboardScreen },
  { id: 'grading', label: 'Grading', screen: gradingScreen },
  { id: 'shipping', label: 'Shipping', screen: shippingScreen },
  { id: 'sales', label: 'Sales', screen: salesScreen },
  { id: 'returns', label: 'Returns', screen: returnsScreen },
  { id: 'admin', label: 'Admin', screen: adminScreen },
  // Managers on approved devices only; the link is added once the server confirms access.
  { id: 'salesops', label: 'Sales & Ops', screen: (_: ScreenCtx) => salesOpsScreen() },
] as const;
type TabId = typeof TABS[number]['id'];

const root = document.getElementById('app')!;
const TAB_KEY = 'gt.portal.tab';
let tab: TabId = (() => { try { const t = localStorage.getItem(TAB_KEY); return TABS.some(x => x.id === t) ? t as TabId : 'grading'; } catch { return 'grading'; } })();
let idle: IdleTimer | null = null;
/** Sales & Ops access for the current session: null = not checked yet. */
let salesOpsAllowed: boolean | null = null;
// Admin is for managers only (just Fraser); the server also refuses admin actions to anyone else.
// Both Admin and Sales & Ops open only once the session is unlocked with the manager's PIN.
const LOCKED: Partial<Record<TabId, string>> = { admin: 'Admin', salesops: 'Sales & Ops' };
const tabVisible = (id: TabId) =>
  id === 'salesops' ? salesOpsAllowed === true : id === 'admin' ? auth.staff?.role === 'manager' : true;
let ticker: number | undefined;

function stopIdle() { if (ticker) clearInterval(ticker); ticker = undefined; idle = null; }

function showSignIn(notice?: string) {
  stopIdle();
  salesOpsAllowed = null;
  auth.setSession('', null);
  if (!auth.terminal) return showSetup();
  mount(root, header(null), signInScreen(showApp, notice));
}

function showSetup() {
  stopIdle();
  mount(root, header(null), setupScreen(() => showSignIn()));
}

function header(countdown: HTMLElement | null) {
  const staff = auth.staff;
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand', title: 'GoodTech Staff' }, h('img', { class: 'logo', src: '/goodtech-logo.png', alt: 'GoodTech', width: 40, height: 40 })),
    staff ? h('nav', { class: 'tabs', 'aria-label': 'Sections' }, TABS.filter(t => tabVisible(t.id)).map(tabButton)) : h('div', { class: 'spacer' }),
    h('div', { class: 'who' },
      countdown,
      staff ? whoMenu(staff) : h('span', { class: 'muted small' }, auth.terminal?.name || ''),
      staff ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm signout', onclick: () => signOut('manual') }, 'Sign out') : null));
}

// The signed-in name is a menu: pick another name to switch user (no PIN). The current session ends first.
function whoMenu(staff: Staff) {
  const list = h('div', { class: 'who-menu', role: 'menu', hidden: true });
  const button = h('button', { type: 'button', class: 'who-name', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Switch user' }, staff.name, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  const wrap = h('div', { class: 'who-switch' }, button, list);
  const close = () => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e: Event) => { if (!wrap.contains(e.target as Node)) close(); };
  async function choose(p: Person) {
    if (p.id === staff.id) return close();
    list.replaceChildren(h('div', { class: 'who-item muted' }, `Switching to ${p.name}…`));
    try { await call('auth.signout', { reason: 'manual' }); } catch { /* already ended */ }
    try { await signInAs(p); salesOpsAllowed = null; close(); showApp(); }
    catch (err) { showSignIn((err as Error).message); }
  }
  button.onclick = async () => {
    if (!list.hidden) return close();
    list.hidden = false; button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    list.replaceChildren(h('div', { class: 'who-item muted' }, 'Loading…'));
    try {
      const r = await call<{ staff: Person[] }>('auth.staff');
      list.replaceChildren(...r.staff.map(p => {
        const b = h('button', { type: 'button', role: 'menuitem', class: 'who-item' + (p.id === staff.id ? ' on' : '') }, p.name);
        b.onclick = () => choose(p);
        return b;
      }), h('button', { type: 'button', role: 'menuitem', class: 'who-item who-signout', onclick: () => { close(); signOut('manual'); } }, 'Sign out'));
      (list.querySelector('.who-item.on') as HTMLElement | null)?.focus();
    } catch (err) { list.replaceChildren(message('error', (err as Error).message)); }
  };
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); button.focus(); } });
  return wrap;
}

function tabButton(t: typeof TABS[number]) {
  return h('button', { type: 'button', class: 'tab' + (t.id === tab ? ' on' : ''), 'aria-current': t.id === tab ? 'page' : undefined, onclick: () => { setTab(t.id); } }, t.label);
}

// Ask the Sales & Ops function once per session whether this manager on this terminal may see it.
function checkSalesOps() {
  if (salesOpsAllowed !== null) return;
  if (auth.staff?.role !== 'manager') { salesOpsAllowed = false; return; }
  salesOpsAllowed = false;
  salesOpsAvailable().then(ok => {
    salesOpsAllowed = ok;
    const nav = root.querySelector('nav.tabs');
    if (ok && nav && !nav.querySelector('[data-tab="salesops"]')) {
      const b = tabButton(TABS.find(t => t.id === 'salesops')!);
      b.dataset.tab = 'salesops';
      nav.appendChild(b);
    }
  });
}

function setTab(id: TabId) {
  tab = id;
  try { localStorage.setItem(TAB_KEY, id); } catch { /* ignore */ }
  showApp();
}

async function signOut(reason: 'manual' | 'idle') {
  try { if (auth.sessionToken) await call('auth.signout', { reason }); } catch { /* already signed out */ }
  showSignIn(reason === 'idle' ? 'Signed out after 5 minutes without activity.' : undefined);
}

const ctx: ScreenCtx = {
  async completed(title, lines) {
    doneToast(title, lines);
    showApp();
  },
};

function showApp() {
  if (!auth.staff) return showSignIn();
  stopIdle();
  if (!tabVisible(tab)) tab = 'dashboard';
  checkSalesOps();
  const timer = new IdleTimer();
  idle = timer;
  const countdown = h('span', { class: 'countdown', 'aria-live': 'polite' });
  const lockedTitle = LOCKED[tab];
  const screen = lockedTitle && !auth.staff.elevated ? unlockPanel(lockedTitle, () => showApp()) : TABS.find(t => t.id === tab)!.screen(ctx);
  mount(root, header(countdown), h('main', { class: 'content' }, screen));

  ticker = window.setInterval(() => {
    if (idle !== timer) return;
    if (lastServerContact() > Date.now() - 1500) timer.serverContact();
    const s = timer.state();
    if (s.expired) { signOut('idle'); return; }
    countdown.textContent = s.warn ? `Signing out in ${Math.ceil(s.remainingMs / 1000)}s` : '';
    countdown.classList.toggle('warn', s.warn);
    if (timer.shouldTouch()) call('auth.touch').catch(() => {});
  }, 1000);
}

for (const ev of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
  window.addEventListener(ev, () => idle?.activity(), { passive: true, capture: true });
}

onSignedOut(reason => showSignIn(reason === 'idle' ? 'Signed out after 5 minutes without activity.' : 'Signed out. Choose your name to continue.'));
onTerminalLost(() => showSetup());

// After a refresh, resume the saved session if the server still accepts it.
async function start() {
  if (!auth.terminal) return showSetup();
  if (!auth.sessionToken) return showSignIn();
  try {
    const r = await call<{ staff: Staff }>('auth.touch');
    auth.setSession(auth.sessionToken, r.staff);
    showApp();
  } catch { if (auth.terminal) showSignIn(); }
}
start();
