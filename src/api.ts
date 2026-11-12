// Client for the staff-portal gateway. The terminal token is kept in localStorage (one per
// enrolled terminal). The staff session is kept there too so a page refresh doesn't sign anyone
// out; the server still ends it after 5 minutes without activity or on Sign out.

export const API_URL: string =
  import.meta.env.VITE_PORTAL_API || 'https://mniqcdqajhhsrvfagmra.supabase.co/functions/v1/staff-portal';

/** Manager-only Sales & Ops function (separate from the gateway; checks its own access rules). */
export const SALES_OPS_URL: string = API_URL.replace(/staff-portal\/?$/, 'portal-sales-ops');
/** Returns tab function (checks the same portal session). */
export const RETURNS_URL: string = API_URL.replace(/staff-portal\/?$/, 'portal-returns');

export type J = Record<string, any>;
export type Staff = { id: string; name: string; role: 'staff' | 'manager'; pinless?: boolean };

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: J = {}) { super(message); }
}

const TERMINAL_KEY = 'gt.portal.terminal';
const SESSION_KEY = 'gt.portal.session';

function readTerminal(): { token: string; name: string } | null {
  try { return JSON.parse(localStorage.getItem(TERMINAL_KEY) || 'null'); } catch { return null; }
}

function readSession(): { token: string; staff: Staff } | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
const saved = readSession();

export const auth = {
  terminal: readTerminal(),
  sessionToken: saved?.token || '',
  staff: (saved?.staff || null) as Staff | null,
  setTerminal(t: { token: string; name: string } | null) {
    this.terminal = t;
    try { t ? localStorage.setItem(TERMINAL_KEY, JSON.stringify(t)) : localStorage.removeItem(TERMINAL_KEY); } catch { /* private mode */ }
  },
  setSession(token: string, staff: Staff | null) {
    this.sessionToken = token; this.staff = staff;
    try { token && staff ? localStorage.setItem(SESSION_KEY, JSON.stringify({ token, staff })) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  },
};

type Listener = (reason: string) => void;
let signedOutListener: Listener = () => {};
let terminalLostListener: () => void = () => {};
export function onSignedOut(fn: Listener) { signedOutListener = fn; }
export function onTerminalLost(fn: () => void) { terminalLostListener = fn; }

let lastCall = 0;
export function lastServerContact() { return lastCall; }

export function call<T = J>(action: string, body: J = {}): Promise<T> {
  return callUrl<T>(API_URL, action, body);
}

export async function callUrl<T = J>(url: string, action: string, body: J = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-terminal-token': auth.terminal?.token || '',
        'x-session-token': auth.sessionToken,
      },
      body: JSON.stringify({ ...body, action }),
    });
  } catch {
    throw new ApiError('No connection to the portal. Check the network and try again.', 0);
  }
  let data: J = {};
  try { data = await r.json(); } catch { /* empty */ }
  if (r.ok) lastCall = Date.now();
  if (r.status === 401 && data.signedOut) {
    auth.setSession('', null);
    signedOutListener(data.reason || 'expired');
    throw new ApiError(data.error || 'Signed out.', 401, data);
  }
  if (r.status === 403 && data.terminal === false) {
    auth.setTerminal(null);
    auth.setSession('', null);
    terminalLostListener();
    throw new ApiError(data.error || 'This terminal is not enrolled.', 403, data);
  }
  if (!r.ok) throw new ApiError(data.error || `Request failed (${r.status}).`, r.status, data);
  if (data.signedOut) auth.setSession('', null);
  return data as T;
}

export function uuid(): string {
  return crypto.randomUUID();
}
