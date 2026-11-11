// Sales & Ops dashboard (managers only, on allowlisted terminals). Every request is checked here,
// server-side, independently of the main gateway:
//   1. a live portal session for this terminal (same 5-minute idle rule as the rest of the portal);
//   2. the session's staff role is 'manager';
//   3. the terminal id is in portal_config 'dashboard_terminals';
//   4. for data: a dashboard unlock token from this session, issued after the PIN and used within
//      the last 5 minutes. Opening the page always asks for the PIN again (the page locks on leave,
//      idle, or a badge scan).
// Actions: access (is the page available here?), unlock {pin}, data {token, period}, touch {token}, lock {token},
// devices {token} / set_device {token, terminalId, allow} (which terminals may open the page).

type J = Record<string, any>;

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ORIGINS = (Deno.env.get('PORTAL_ALLOWED_ORIGINS') || '*').split(',').map(s => s.trim()).filter(Boolean);
const PERIODS = ['today', 'yesterday', '7d', '30d'];

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: J = {}) { super(message); }
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allow = ORIGINS.includes('*') ? '*' : ORIGINS.includes(origin) ? origin : ORIGINS[0] || '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-terminal-token, x-session-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

async function rpc(fn: string, args: J = {}) {
  const r = await fetch(URL_ + '/rest/v1/rpc/' + fn, {
    method: 'POST', body: JSON.stringify(args),
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const msg = String(data?.message || 'Database request failed.');
    if (msg.startsWith('TERMINAL: ')) throw new HttpError(403, msg.slice(10), { terminal: false });
    if (msg.startsWith('SIGNED_OUT: ')) throw new HttpError(401, msg.slice(12), { signedOut: true });
    throw new HttpError(400, msg);
  }
  return data;
}

async function log(s: J, action: string, outcome: 'ok' | 'denied' | 'error', details: J = {}) {
  try {
    await rpc('portal_log', { p_staff: s.staff.id, p_session: s.sessionId, p_terminal: s.terminalId, p_module: 'salesops', p_action: action, p_ref: null, p_outcome: outcome, p_details: details });
  } catch (e) { console.error('portal_log failed', e); }
}

async function handle(req: Request): Promise<J> {
  const raw = await req.text();
  if (raw.length > 4000) throw new HttpError(413, 'Request too large.');
  let b: J;
  try { b = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
  const action = String(b.action || '');

  const s = await rpc('portal_session', { p_terminal_token: req.headers.get('x-terminal-token') || '', p_session_token: req.headers.get('x-session-token') || '' });
  if (s.signedOut) throw new HttpError(401, 'Signed out after 5 minutes without activity.', { signedOut: true, reason: s.reason });
  const allowed = s.staff?.role === 'manager' && await rpc('portal_dashboard_allowed', { p_terminal: s.terminalId }) === true;

  if (action === 'access') return { allowed };
  if (!allowed) {
    await log(s, action || 'unknown', 'denied', { reason: s.staff?.role === 'manager' ? 'terminal' : 'role' });
    throw new HttpError(403, 'Sales & Ops is only available to managers on approved devices.', { dashboardDenied: true });
  }

  if (action === 'unlock') {
    const pin = String(b.pin ?? '');
    if (!/^\d{4}$/.test(pin)) throw new HttpError(403, 'Enter your PIN.', { pinRequired: true });
    const ok = await rpc('portal_pin_ok', { p_staff: s.staff.id, p_pin: pin, p_terminal: s.terminalId, p_purpose: 'salesops.unlock' });
    if (!ok?.ok) { await log(s, 'unlock', 'denied', { reason: 'pin' }); throw new HttpError(403, ok?.error || 'Wrong PIN.', { pinRequired: true }); }
    const token = await rpc('portal_dashboard_unlock', { p_session: s.sessionId, p_terminal: s.terminalId, p_staff: s.staff.id });
    await log(s, 'unlock', 'ok');
    return { token };
  }
  if (action === 'lock') {
    await rpc('portal_dashboard_lock', { p_token: String(b.token || ''), p_session: s.sessionId });
    return { ok: true };
  }
  if (action === 'devices' || action === 'set_device') {
    const fresh = await rpc('portal_dashboard_check', { p_token: String(b.token || ''), p_session: s.sessionId, p_terminal: s.terminalId });
    if (fresh !== true) throw new HttpError(403, 'Locked. Enter your PIN to open Sales & Ops.', { locked: true });
    if (action === 'set_device') {
      const id = String(b.terminalId || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Choose a device.');
      if (id === s.terminalId && !b.allow) throw new HttpError(400, 'Remove this device from another approved device.');
      await rpc('portal_dashboard_set_terminal', { p_terminal: id, p_allow: !!b.allow });
      await log(s, b.allow ? 'device_allow' : 'device_remove', 'ok', { terminalId: id });
    }
    return { devices: await rpc('portal_dashboard_devices', {}), current: s.terminalId };
  }
  if (action === 'touch') {
    // Activity on the open page keeps the unlock alive (it still lapses 5 minutes after the last use).
    const fresh = await rpc('portal_dashboard_check', { p_token: String(b.token || ''), p_session: s.sessionId, p_terminal: s.terminalId });
    if (fresh !== true) throw new HttpError(403, 'Locked. Enter your PIN to open Sales & Ops.', { locked: true });
    return { ok: true };
  }
  if (action === 'data') {
    const fresh = await rpc('portal_dashboard_check', { p_token: String(b.token || ''), p_session: s.sessionId, p_terminal: s.terminalId });
    if (fresh !== true) throw new HttpError(403, 'Locked. Enter your PIN to open Sales & Ops.', { locked: true });
    const period = PERIODS.includes(String(b.period)) ? String(b.period) : 'today';
    return await rpc('portal_sales_ops', { p_period: period });
  }
  throw new HttpError(400, 'Unknown action.');
}

Deno.serve(async req => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers });
  try {
    return Response.json(await handle(req), { headers: { ...headers, 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message, ...e.extra }, { status: e.status, headers: { ...headers, 'Cache-Control': 'no-store' } });
    console.error(e);
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500, headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
});
