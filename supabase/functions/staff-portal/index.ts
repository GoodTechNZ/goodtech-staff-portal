// Staff portal gateway. Every portal request comes here: it checks the enrolled terminal and the
// signed-in staff session, asks for the PIN again on sensitive actions, logs the action for the
// daily summaries, and signs the person out after each completed device or order.
// Grading runs on the portal_grading_* RPCs; Shipping and Sales are forwarded to the existing
// staff-shipping and staff-sales-desk functions with the signed-in staff name.
import {
  HttpError, J, nzDate, validSerial, gradingRecord, uuidOrNull, needsPin, completesWork, bridgeBody,
  discountedLines, shippingRef, SHIPPING_ACTIONS, SALES_ACTIONS,
} from './logic.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BRIDGE = Deno.env.get('PORTAL_BRIDGE_TOKEN') || '';
const ORIGINS = (Deno.env.get('PORTAL_ALLOWED_ORIGINS') || '*').split(',').map(s => s.trim()).filter(Boolean);

type Ctx = { sessionId: string; terminalId: string; staff: { id: string; name: string; role: string } };

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

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(URL_ + '/rest/v1/' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY, ...(init.headers || {}) },
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
const rpc = (fn: string, args: J = {}) => rest('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });

async function log(ctx: Ctx, module: string, action: string, ref: string | null, outcome: 'ok' | 'linked' | 'error' | 'denied', details: J = {}) {
  try {
    await rpc('portal_log', { p_staff: ctx.staff.id, p_session: ctx.sessionId, p_terminal: ctx.terminalId, p_module: module, p_action: action, p_ref: ref, p_outcome: outcome, p_details: details });
  } catch (e) { console.error('portal_log failed', e); }
}

async function requirePin(ctx: Ctx, pin: unknown, purpose: string) {
  if (!/^\d{4}$/.test(String(pin ?? ''))) throw new HttpError(403, 'Enter your PIN to confirm.', { pinRequired: true });
  const r = await rpc('portal_pin_ok', { p_staff: ctx.staff.id, p_pin: String(pin), p_terminal: ctx.terminalId, p_purpose: purpose });
  if (!r?.ok) throw new HttpError(403, r?.error || 'Wrong PIN.', { pinRequired: true });
}

async function signOut(ctx: Ctx, reason: string) {
  await rpc('portal_sign_out', { p_session: ctx.sessionId, p_reason: reason });
}

async function bridge(fn: string, payload: J): Promise<{ status: number; data: J }> {
  if (!BRIDGE) throw new HttpError(503, 'This section is not connected yet. Ask a manager to set PORTAL_BRIDGE_TOKEN.');
  const r = await fetch(URL_ + '/functions/v1/' + fn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sales-desk-token': BRIDGE },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(140000),
  });
  let data: J;
  try { data = await r.json(); } catch { data = { error: `Unexpected response from ${fn} (HTTP ${r.status}). Refresh before retrying.` }; }
  return { status: r.status, data };
}

// ---------- Grading ----------
async function grading(ctx: Ctx, action: string, b: J) {
  if (action === 'lookup') {
    const serial = validSerial(b.serial);
    const data = await rpc('portal_grading_lookup', { p_serial: serial, p_id: uuidOrNull(b.recordId) });
    return data;
  }
  if (action === 'save') {
    const serial = validSerial(b.serial);
    const recordId = uuidOrNull(b.recordId);
    const saveId = uuidOrNull(b.saveId);
    if (!saveId) throw new HttpError(400, 'Invalid save request. Refresh and scan again.');
    const record = gradingRecord(b.record, ctx.staff.name, nzDate());
    const details = { grade: record.grade, destination: record.destination, update: !!recordId, saveId };
    try {
      const result = await rpc('portal_grading_save', { p: { serial, saveId, owner: ctx.staff.id, version: String(b.version ?? '0'), recordId, record } });
      await log(ctx, 'grading', 'save', serial, result.linked ? 'linked' : 'ok', { ...details, linkedRow: result.linkedRow ?? null });
      return result;
    } catch (e) {
      await log(ctx, 'grading', 'save', serial, 'error', { ...details, error: String((e as Error).message).slice(0, 300) });
      throw e;
    }
  }
  if (action === 'link') {
    // The device is already in the sheet and the tester agrees with its grade: record that they
    // checked it against the existing row instead of writing a duplicate.
    const serial = validSerial(b.serial);
    const recordId = uuidOrNull(b.recordId);
    const grade = String(b.grade ?? '');
    if (!recordId || !['1', '2', '3'].includes(grade)) throw new HttpError(400, 'Select a grade.');
    const found = await rpc('portal_grading_lookup', { p_serial: serial, p_id: recordId });
    const existing = String(found?.record?.grade ?? '');
    if (existing !== grade) {
      await log(ctx, 'grading', 'link', serial, 'error', { grade, existingGrade: existing, recordId });
      throw new HttpError(409, `The sheet has grade ${existing || 'blank'} for this device. Update the record instead.`);
    }
    const linkedRow = found?.device?.row ?? null;
    await log(ctx, 'grading', 'save', serial, 'linked', { grade, recordId, linkedRow, update: false, destination: found?.record?.destination ?? null });
    return { ok: true, linked: true, linkedRow, linkedTester: found?.record?.tester ?? null, ...found };
  }
  if (action === 'recent') {
    const rows = await rest('portal_grading_outbox?select=id,status,error,created_at,synced_at,linked_sheet_row,revision,payload,record:portal_grading_records!portal_grading_outbox_record_id_fkey(serial,sheet_row)'
      + '&owner_id=eq.' + encodeURIComponent(ctx.staff.id) + '&order=created_at.desc&limit=15');
    return { jobs: rows.map((r: J) => ({ id: r.id, status: r.status, error: r.error, createdAt: r.created_at, syncedAt: r.synced_at, serial: r.record?.serial, row: r.record?.sheet_row ?? r.linked_sheet_row, grade: r.payload?.grade, update: r.revision > 1 })) };
  }
  throw new HttpError(400, 'Unknown grading action.');
}

// ---------- Shipping (staff-shipping) ----------
async function shipping(ctx: Ctx, action: string, b: J) {
  if (!SHIPPING_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown shipping action.');
  if (action === 'save_settings' && ctx.staff.role !== 'manager') throw new HttpError(403, 'Only a manager can change shipping settings.');
  const { status, data } = await bridge('staff-shipping', bridgeBody('shipping', action, b, ctx.staff));
  const ref = shippingRef(b, data);
  if (!['lookup', 'settings', 'errors'].includes(action)) {
    const failed = status >= 400 || !!data.error;
    await log(ctx, 'shipping', action, ref, failed ? 'error' : 'ok', {
      imei: b.imei ?? null, code: data.code ?? null, error: failed ? String(data.error).slice(0, 300) : null,
      mappedSku: data.lastScan?.mapped_sku ?? null, devices: Array.isArray(data.scans) ? data.scans.length : undefined,
      orderName: data.orderName ?? data.shipment?.order_name ?? null, overrideReason: action === 'override' ? String(b.overrideReason || '').slice(0, 300) : undefined,
    });
  }
  if (status >= 400) throw new HttpError(status === 401 ? 502 : 400, data.error || 'Shipping request failed.', { code: data.code, scanEvent: data.scanEvent });
  return data;
}

// ---------- Sales (staff-sales-desk) ----------
async function sales(ctx: Ctx, action: string, b: J) {
  if (!SALES_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown sales action.');
  const { status, data } = await bridge('staff-sales-desk', bridgeBody('sales', action, b, ctx.staff));
  if (!['bootstrap', 'search', 'get'].includes(action)) {
    const failed = status >= 400 || !!data.error;
    const order = data.order;
    await log(ctx, 'sales', action, order?.number || order?.id || b.id || b.requestId || null, failed ? 'error' : 'ok', {
      orderId: order?.id ?? b.id ?? null, stage: order?.stage ?? null, total: order?.total ?? null,
      lines: order?.lines?.length ?? null, discountedLines: action === 'create' ? discountedLines(order) : undefined,
      error: failed ? String(data.error).slice(0, 300) : null,
    });
  }
  if (status >= 400) throw new HttpError(status === 401 ? 502 : 400, data.error || 'Sales request failed.');
  if (action === 'bootstrap') delete data.staff;
  return data;
}

// ---------- Dashboard ----------
async function dashboard(ctx: Ctx, action: string, b: J) {
  if (action === 'summary') {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? String(b.day) : nzDate();
    const manager = ctx.staff.role === 'manager';
    const [people, health] = await Promise.all([
      rpc('portal_daily_summary', { p_day: day, p_staff: manager ? null : ctx.staff.id }),
      manager ? rpc('portal_health') : Promise.resolve(null),
    ]);
    return { day, manager, people, health };
  }
  throw new HttpError(400, 'Unknown dashboard action.');
}

// ---------- Admin (managers) ----------
async function admin(ctx: Ctx, action: string, b: J) {
  if (ctx.staff.role !== 'manager') throw new HttpError(403, 'Managers only.');
  if (action === 'staff') {
    const rows = await rest('staff?select=id,display_name,former_names,role,active,badge_code,pin_set_at,locked_until&order=display_name');
    return { staff: rows.map((s: J) => ({ id: s.id, name: s.display_name, formerNames: s.former_names, role: s.role, active: s.active, hasBadge: !!s.badge_code, hasPin: !!s.pin_set_at, locked: !!s.locked_until && Date.parse(s.locked_until) > Date.now() })) };
  }
  if (action === 'terminals') {
    return { terminals: await rest('portal_terminals?select=id,name,created_at,last_seen_at,revoked_at&order=created_at.desc') };
  }
  const id = uuidOrNull(b.staffId);
  const patch = (body: J) => rest('staff?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
  let ref: string | null = id;
  if (action === 'add_staff') {
    const name = String(b.name || '').trim();
    if (!/^[\p{L}][\p{L} .'-]{0,59}$/u.test(name)) throw new HttpError(400, 'Enter a valid name.');
    await rest('staff', { method: 'POST', body: JSON.stringify({ display_name: name, role: b.role === 'manager' ? 'manager' : 'staff' }), headers: { Prefer: 'return=minimal' } });
    ref = name;
  } else if (action === 'rename_staff') {
    if (!id) throw new HttpError(400, 'Choose a staff member.');
    const name = String(b.name || '').trim();
    if (!/^[\p{L}][\p{L} .'-]{0,59}$/u.test(name)) throw new HttpError(400, 'Enter a valid name.');
    const [cur] = await rest('staff?select=display_name,former_names&id=eq.' + id);
    if (!cur) throw new HttpError(404, 'Staff member not found.');
    await patch({ display_name: name, former_names: [...new Set([...(cur.former_names || []), cur.display_name])].filter(n => n !== name) });
  } else if (['reset_pin', 'reset_badge', 'unlock', 'deactivate', 'activate', 'make_manager', 'make_staff'].includes(action)) {
    if (!id) throw new HttpError(400, 'Choose a staff member.');
    if (id === ctx.staff.id && ['deactivate', 'make_staff'].includes(action)) throw new HttpError(400, 'Ask another manager to change your own access.');
    const body: J = {
      reset_pin: { pin_hash: null, pin_set_at: null, failed_pin_attempts: 0, locked_until: null },
      reset_badge: { badge_code: null, badge_registered_at: null, pin_hash: null, pin_set_at: null, failed_pin_attempts: 0, locked_until: null },
      unlock: { failed_pin_attempts: 0, locked_until: null },
      deactivate: { active: false }, activate: { active: true },
      make_manager: { role: 'manager' }, make_staff: { role: 'staff' },
    }[action]!;
    await patch(body);
    if (['reset_badge', 'deactivate'].includes(action)) {
      await rest('portal_sessions?staff_id=eq.' + id + '&ended_at=is.null', { method: 'PATCH', body: JSON.stringify({ ended_at: new Date().toISOString(), end_reason: 'manager_' + action }), headers: { Prefer: 'return=minimal' } });
    }
  } else if (action === 'revoke_terminal') {
    const tid = uuidOrNull(b.terminalId);
    if (!tid) throw new HttpError(400, 'Choose a terminal.');
    if (tid === ctx.terminalId) throw new HttpError(400, 'Revoke this terminal from a different one.');
    await rest('portal_terminals?id=eq.' + tid, { method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
    await rest('portal_sessions?terminal_id=eq.' + tid + '&ended_at=is.null', { method: 'PATCH', body: JSON.stringify({ ended_at: new Date().toISOString(), end_reason: 'terminal_revoked' }), headers: { Prefer: 'return=minimal' } });
    ref = tid;
  } else throw new HttpError(400, 'Unknown admin action.');
  await log(ctx, 'admin', action, ref, 'ok', {});
  return { ok: true };
}

const MODULES: Record<string, (ctx: Ctx, action: string, b: J) => Promise<J>> = { grading, shipping, sales, dashboard, admin };

async function handle(req: Request): Promise<J> {
  const raw = await req.text();
  if (raw.length > 64000) throw new HttpError(413, 'Request too large.');
  let b: J;
  try { b = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
  const [module, action] = String(b.action || '').split('.');
  const terminalToken = req.headers.get('x-terminal-token') || '';

  if (module === 'terminal' && action === 'enrol') return await rpc('portal_terminal_enrol', { p_code: String(b.code || '').trim().toUpperCase(), p_name: String(b.name || '') });
  if (module === 'auth' && action === 'badge') return await rpc('portal_badge', { p_terminal_token: terminalToken, p_badge: String(b.badge || '') });
  if (module === 'auth' && action === 'signin') {
    const r = await rpc('portal_sign_in', { p_terminal_token: terminalToken, p_badge: String(b.badge || ''), p_pin: b.pin ?? null, p_new_pin: b.newPin ?? null, p_claim_staff: uuidOrNull(b.claimStaffId) });
    if (!r?.ok) throw new HttpError(403, r?.error || 'Sign in failed.');
    return r;
  }

  const s = await rpc('portal_session', { p_terminal_token: terminalToken, p_session_token: req.headers.get('x-session-token') || '' });
  if (s.signedOut) throw new HttpError(401, 'Signed out after 10 minutes without activity.', { signedOut: true, reason: s.reason });
  const ctx: Ctx = { sessionId: s.sessionId, terminalId: s.terminalId, staff: s.staff };

  if (module === 'auth' && action === 'touch') return { ok: true, staff: ctx.staff };
  if (module === 'auth' && action === 'signout') {
    await signOut(ctx, b.reason === 'idle' ? 'idle' : 'manual');
    return { ok: true, signedOut: true };
  }
  const run = MODULES[module];
  if (!run || !action) throw new HttpError(400, 'Unknown action.');
  if (module === 'admin' && ctx.staff.role !== 'manager') throw new HttpError(403, 'Managers only.');
  if (needsPin(module, action, b)) {
    try { await requirePin(ctx, b.pin, module + '.' + action); }
    catch (e) { await log(ctx, module, action, null, 'denied', { reason: 'pin' }); throw e; }
  }
  const result = await run(ctx, action, b);
  if (completesWork(module, action, result)) {
    await signOut(ctx, 'completed');
    return { ...result, signedOut: true };
  }
  return result;
}

Deno.serve(async req => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers });
  try {
    const data = await handle(req);
    return Response.json(data, { headers: { ...headers, 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message, ...e.extra }, { status: e.status, headers: { ...headers, 'Cache-Control': 'no-store' } });
    console.error(e);
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500, headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
});
