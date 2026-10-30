import './styles.css';
import { auth, call, onSignedOut, onTerminalLost, lastServerContact } from './api.ts';
import { IdleTimer } from './idle.ts';
import { h, mount, doneSplash } from './ui.ts';
import { setupScreen } from './screens/setup.ts';
import { signInScreen } from './screens/signin.ts';
import { gradingScreen } from './screens/grading.ts';
import { shippingScreen } from './screens/shipping.ts';
import { salesScreen } from './screens/sales.ts';
import { dashboardScreen } from './screens/dashboard.ts';

export type ScreenCtx = {
  /** Called after a completed device/order: the server has already ended the session. */
  completed: (title: string, lines: string[]) => Promise<void>;
};

const TABS = [
  { id: 'grading', label: 'Grading', screen: gradingScreen },
  { id: 'shipping', label: 'Shipping', screen: shippingScreen },
  { id: 'sales', label: 'Sales', screen: salesScreen },
  { id: 'dashboard', label: 'Dashboard', screen: dashboardScreen },
] as const;
type TabId = typeof TABS[number]['id'];

const root = document.getElementById('app')!;
const TAB_KEY = 'gt.portal.tab';
let tab: TabId = (() => { try { return (localStorage.getItem(TAB_KEY) as TabId) || 'grading'; } catch { return 'grading'; } })();
let idle: IdleTimer | null = null;
let ticker: number | undefined;

function stopIdle() { if (ticker) clearInterval(ticker); ticker = undefined; idle = null; }

function showSignIn(notice?: string) {
  stopIdle();
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
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, 'GT'), h('span', {}, 'GoodTech Staff')),
    staff ? h('nav', { class: 'tabs', 'aria-label': 'Sections' }, TABS.map(t =>
      h('button', { type: 'button', class: 'tab' + (t.id === tab ? ' on' : ''), 'aria-current': t.id === tab ? 'page' : undefined, onclick: () => { setTab(t.id); } }, t.label))) : h('div', { class: 'spacer' }),
    h('div', { class: 'who' },
      countdown,
      staff ? h('span', { class: 'who-name' }, staff.name) : h('span', { class: 'muted small' }, auth.terminal?.name || ''),
      staff ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => signOut('manual') }, 'Sign out') : null));
}

function setTab(id: TabId) {
  tab = id;
  try { localStorage.setItem(TAB_KEY, id); } catch { /* ignore */ }
  showApp();
}

async function signOut(reason: 'manual' | 'idle') {
  try { if (auth.sessionToken) await call('auth.signout', { reason }); } catch { /* already signed out */ }
  showSignIn(reason === 'idle' ? 'Signed out after 10 minutes without activity.' : undefined);
}

const ctx: ScreenCtx = {
  async completed(title, lines) {
    stopIdle();
    auth.setSession('', null);
    await doneSplash(title, lines);
    showSignIn();
  },
};

function showApp() {
  if (!auth.staff) return showSignIn();
  stopIdle();
  const timer = new IdleTimer();
  idle = timer;
  const countdown = h('span', { class: 'countdown', 'aria-live': 'polite' });
  const screen = TABS.find(t => t.id === tab)!.screen(ctx);
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

onSignedOut(reason => showSignIn(reason === 'idle' ? 'Signed out after 10 minutes without activity.' : 'Signed out. Scan your badge to continue.'));
onTerminalLost(() => showSetup());

auth.terminal ? showSignIn() : showSetup();
