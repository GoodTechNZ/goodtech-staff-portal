// Staff portal gateway. Every portal request comes here: it checks the enrolled terminal and the
// signed-in staff session, asks for the PIN again on sensitive actions, logs the action for the
// daily summaries. Sessions end only on sign-out or after 5 minutes without activity.
// Grading runs on the portal_grading_* RPCs; Shipping and Sales are forwarded to the existing
// staff-shipping and staff-sales-desk functions with the signed-in staff name.
import {
  HttpError, J, nzDate, validSerial, gradingRecord, uuidOrNull, needsPin, bridgeBody,
  discountedLines, shippingRef, SHIPPING_ACTIONS, SALES_ACTIONS, pickRequest, cin7ErrorText,
  CIN7_STOCK_LOCATIONS, stockAt, sameBalances, codePlan, adjustmentBody, verifyAdjustment, poConfirmsDevice,
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
    'Access-Control-Allow-Headers': 'content-type, x-terminal-token, x-session-token, x-sync-token',
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

// The device's public network address (shared by everything on the same Wi-Fi).
function clientIp(req: Request) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || '';
}

async function sha256(v: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))).map(x => x.toString(16).padStart(2, '0')).join('');
}

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
    return await rpc('portal_grading_scan', { p_serial: serial, p_id: uuidOrNull(b.recordId) });
  }
  if (action === 'move') {
    // A graded device is never graded again: it can only be moved and have its status note updated.
    const serial = validSerial(b.serial);
    const recordId = uuidOrNull(b.recordId);
    const moveId = uuidOrNull(b.moveId);
    if (!recordId || !moveId) throw new HttpError(400, 'Invalid request. Scan again.');
    const destination = String(b.destination ?? '');
    const status = String(b.status ?? '').trim().slice(0, 1000);
    const notes = b.notes == null ? null : String(b.notes).slice(0, 5000);
    const details = { destination, status, recordId, moveId };
    try {
      const result = await rpc('portal_grading_move', { p: { serial, recordId, moveId, version: String(b.version ?? ''), destination, status, notes, owner: ctx.staff.id, staff: ctx.staff.name } });
      await log(ctx, 'grading', 'move', serial, 'ok', { ...details, from: result.from ?? null, to: result.to ?? null });
      return result;
    } catch (e) {
      await log(ctx, 'grading', 'move', serial, 'error', { ...details, error: String((e as Error).message).slice(0, 300) });
      throw e;
    }
  }
  if (action === 'save') {
    const serial = validSerial(b.serial);
    const recordId = uuidOrNull(b.recordId);
    const saveId = uuidOrNull(b.saveId);
    if (!saveId) throw new HttpError(400, 'Invalid save request. Refresh and scan again.');
    const record = gradingRecord(b.record, ctx.staff.name, nzDate());
    // The screen sends the supplier's listed colour so an override shows in the activity log.
    const listed = String(b.listedColour ?? '').trim().slice(0, 150);
    const colourOverride = listed && listed.toLowerCase() !== String(record.colour).toLowerCase() ? { from: listed, to: record.colour } : null;
    const details = { grade: record.grade, destination: record.destination, update: !!recordId, saveId, ...(colourOverride ? { colourOverride } : {}) };
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
  if (action === 'priority') {
    // Testing priority (the "Daily testing priority" routine): what to test first, for everyone.
    return await rpc('portal_testing_priority');
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

// ---------- Cin7 ----------
let lastCin7 = 0;
async function cin7(path: string, method = 'GET', body?: J): Promise<J> {
  const id = Deno.env.get('CIN7_ACCOUNT_ID'), key = Deno.env.get('CIN7_APPLICATION_KEY');
  if (!id || !key) throw new HttpError(503, 'Cin7 is not connected to the portal.');
  // Cin7 allows 60 calls a minute; keep calls at least a second apart.
  const wait = lastCin7 + 1000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCin7 = Date.now();
  const r = await fetch('https://inventory.dearsystems.com/ExternalApi/v2' + path, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
    headers: { 'Content-Type': 'application/json', 'api-auth-accountid': id, 'api-auth-applicationkey': key },
  });
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!r.ok || Array.isArray(data)) throw new Error(cin7ErrorText(data, r.status));
  return data as J;
}

// After pick lists print, authorise each order's Pick in Cin7 so it moves to Picked (awaiting
// packing). Reads the Pick first and never writes to an order Cin7 already shows as picked.
async function authorisePicks(ctx: Ctx, ids: string[]) {
  const orders: J[] = await rpc('portal_pick_prepare', { p_ids: ids, p_staff: ctx.staff.id, p_name: ctx.staff.name });
  const results: J[] = [];
  for (const o of orders) {
    let outcome: 'authorised' | 'review' = 'review', error: string | null = null, already = false;
    try {
      if (!Array.isArray(o.tasks) || o.tasks.length !== 1) throw new Error('This order has more than one fulfilment. Pick it in Cin7.');
      const task = String(o.tasks[0]);
      const current = await cin7('/Sale/Fulfilment/Pick?TaskID=' + encodeURIComponent(task));
      if (current.Status === 'AUTHORISED') { outcome = 'authorised'; already = true; }
      else if (current.Status === 'VOIDED') throw new Error('The pick is voided in Cin7.');
      else {
        let postError: string | null = null;
        try { await cin7('/Sale/Fulfilment/Pick', 'POST', pickRequest(task, String(o.location || ''), o.lines)); }
        catch (e) { postError = (e as Error).message; }
        // Read back rather than trust the write response (a timeout may still have succeeded).
        const after = await cin7('/Sale/Fulfilment/Pick?TaskID=' + encodeURIComponent(task));
        if (after.Status === 'AUTHORISED') outcome = 'authorised';
        else throw new Error(postError || `Cin7 shows the pick as ${String(after.Status || 'unknown').toLowerCase()}.`);
      }
    } catch (e) { error = e instanceof HttpError ? e.message : String((e as Error).message || e); }
    await rpc('portal_pick_result', { p_id: o.id, p_status: outcome, p_error: error });
    await log(ctx, 'dashboard', 'pick', o.number, outcome === 'authorised' ? 'ok' : 'error', { saleId: o.id, already, error });
    results.push({ id: o.id, number: o.number, ok: outcome === 'authorised', already, error });
  }
  const done = new Set(orders.map(o => o.id));
  for (const id of ids) if (!done.has(id)) results.push({ id, ok: false, skipped: true, error: 'Already picked or in progress.' });
  return { results };
}

// ---------- Stock: product-code changes (managers) ----------
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,40}$/;

async function cin7Product(sku: string): Promise<J> {
  if (!SKU_RE.test(sku)) throw new HttpError(400, 'Enter a valid product code.');
  const [row] = await rest('cin7_products?select=product_id&sku=eq.' + encodeURIComponent(sku) + '&limit=1');
  if (!row) throw new HttpError(404, `${sku} is not in Cin7.`);
  const d = await cin7('/product?ID=' + encodeURIComponent(row.product_id));
  const p = (d.Products || []).find((x: J) => x.ID === row.product_id);
  if (!p) throw new HttpError(404, `Cin7 details for ${sku} are unavailable.`);
  return p;
}

async function liveBalances(plan: J) {
  const [a, z] = await Promise.all([
    cin7('/ref/productavailability?SKU=' + encodeURIComponent(plan.source.SKU) + '&Limit=1000'),
    cin7('/ref/productavailability?SKU=' + encodeURIComponent(plan.target.SKU) + '&Limit=1000'),
  ]);
  if (a.Total > 1000 || z.Total > 1000) throw new HttpError(400, 'Too many stock rows; change this in Cin7.');
  return { from: stockAt(a, plan.source.SKU, plan.location), to: stockAt(z, plan.target.SKU, plan.location) };
}

const codeJob = (id: string, action: string, extra: J = {}) => rpc('portal_code_job', { p: { id, action, ...extra } });

async function stock(ctx: Ctx, action: string, b: J) {
  if (ctx.staff.role !== 'manager') throw new HttpError(403, 'Only a manager can change product codes.');
  if (action === 'products') {
    const q = String(b.q || '').trim().replace(/[^A-Za-z0-9 .\/-]/g, '').slice(0, 40);
    if (q.length < 2) return { products: [] };
    const like = encodeURIComponent('*' + q + '*');
    const rows: J[] = await rest(`cin7_products?select=sku,name&status=eq.Active&product_type=eq.Stock&or=(sku.ilike.${like},name.ilike.${like})&order=sku&limit=25`);
    const loc = (CIN7_STOCK_LOCATIONS as readonly string[]).includes(String(b.location)) ? String(b.location) : null;
    let onHand: Record<string, number> = {};
    if (loc && rows.length) {
      const av: J[] = await rest('cin7_product_availability?select=sku,on_hand&location=eq.' + encodeURIComponent(loc) + '&sku=in.(' + rows.map(r => '"' + r.sku + '"').join(',') + ')');
      onHand = Object.fromEntries(av.map(a => [a.sku, Number(a.on_hand)]));
    }
    return { products: rows.map(r => ({ sku: r.sku, name: r.name, onHand: loc ? onHand[r.sku] ?? 0 : null })) };
  }
  if (action === 'device') {
    const serial = validSerial(b.serial);
    const context = await rpc('portal_code_device_context', { p_serial: serial, p_record: uuidOrNull(b.recordId) });
    let siblings: J[] = [];
    if (context.sku) {
      const base = String(context.sku).replace(/-\d$/, '');
      siblings = await rest('cin7_products?select=sku,name&status=eq.Active&product_type=eq.Stock&sku=like.' + encodeURIComponent(base + '-*') + '&sku=neq.' + encodeURIComponent(context.sku) + '&order=sku');
    }
    return { ...context, siblings };
  }
  if (action === 'preview') {
    const id = uuidOrNull(b.requestId);
    if (!id) throw new HttpError(400, 'Invalid request. Start again.');
    const kind = b.kind === 'device' ? 'device' : 'stock';
    const location = String(b.location || '');
    const toSku = String(b.toSku || '').trim().toUpperCase();
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw new HttpError(400, 'Enter a reason.');
    let fromSku: string, quantity: number, device: J | null = null;
    if (kind === 'device') {
      device = await rpc('portal_code_device_context', { p_serial: validSerial(b.serial), p_record: uuidOrNull(b.recordId) });
      if (device!.problems?.length) throw new HttpError(409, device!.problems.join(' '));
      fromSku = device!.sku; quantity = 1;
      if (!device!.purchaseId) throw new HttpError(409, `${device!.po} is not in the portal's Cin7 purchase list yet. Try again later.`);
      const purchase = await cin7('/purchase?ID=' + encodeURIComponent(device!.purchaseId));
      if (!poConfirmsDevice(purchase, device!.serial)) throw new HttpError(409, `${device!.po} doesn't confirm this IMEI was received. Check the receipt in Cin7 first.`);
    } else {
      fromSku = String(b.fromSku || '').trim().toUpperCase(); quantity = Number(b.quantity);
    }
    const [source, target] = await Promise.all([cin7Product(fromSku), cin7Product(toSku)]);
    const draft = { source: { SKU: source.SKU }, target: { SKU: target.SKU }, location };
    if (!(CIN7_STOCK_LOCATIONS as readonly string[]).includes(location)) throw new HttpError(400, 'Choose the Cin7 location.');
    const live = await liveBalances(draft);
    const plan = codePlan(source, target, live.from, live.to, location, quantity, kind === 'device');
    if (device) Object.assign(plan, { serial: device.serial, po: device.po, sheetRow: device.sheetRow, current: { grade: device.grade, colour: device.colour } });
    const change = await rpc('portal_code_prepare', { p: {
      id, kind, serial: device?.serial ?? null, recordId: device?.recordId ?? null, version: device?.version ?? null,
      quantity, reason, staffId: ctx.staff.id, staffName: ctx.staff.name, plan,
    } });
    await log(ctx, 'stock', 'preview', device?.serial || `${fromSku}→${toSku}`, 'ok', { changeId: id, kind, fromSku, toSku, quantity, location });
    return { change };
  }
  if (action === 'commit') {
    const id = uuidOrNull(b.id);
    if (!id) throw new HttpError(400, 'Invalid request.');
    let c = await codeJob(id, 'get');
    if (c.staff_id !== ctx.staff.id) throw new HttpError(403, 'Only the manager who reviewed this change can confirm it.');
    const ref = c.serial || `${c.from_sku}→${c.to_sku}`;
    try {
      if (c.state === 'preview') {
        if (!sameBalances(await liveBalances(c.plan), c.plan)) throw new HttpError(409, 'Stock changed in Cin7 since the review. Start again.');
        c = await codeJob(id, 'reserve');
      }
      if (c.state === 'reserved') {
        if (!sameBalances(await liveBalances(c.plan), c.plan)) {
          await codeJob(id, 'transition', { expected: 'reserved', next: 'review', error: 'Stock changed before the adjustment was created. Nothing was changed in Cin7.' });
          throw new HttpError(409, 'Stock changed in Cin7 since the review. Nothing was changed.');
        }
        c = await codeJob(id, 'transition', { expected: 'reserved', next: 'creating' });
        try {
          const draft = await cin7('/stockadjustment', 'POST', adjustmentBody(c));
          verifyAdjustment(draft, c);
          if (draft.Status !== 'DRAFT') throw new Error('Unexpected adjustment status.');
          c = await codeJob(id, 'transition', { expected: 'creating', next: 'draft', taskId: draft.TaskID, adjustmentNumber: draft.StocktakeNumber });
        } catch (e) {
          await codeJob(id, 'transition', { expected: 'creating', next: 'review', error: 'The Cin7 draft adjustment needs checking (reference Code change ' + id + '). Do not create another.' });
          throw e;
        }
      }
      if (c.state === 'draft') {
        if (!sameBalances(await liveBalances(c.plan), c.plan)) {
          await codeJob(id, 'transition', { expected: 'draft', next: 'review', error: `Stock changed after the draft ${c.adjustment_number || ''} was created. Review the draft in Cin7.` });
          throw new HttpError(409, 'Stock changed in Cin7. The adjustment was left as a draft for review.');
        }
        c = await codeJob(id, 'transition', { expected: 'draft', next: 'completing' });
        try { await cin7('/stockadjustment', 'PUT', { ...adjustmentBody(c), TaskID: c.task_id, Status: 'COMPLETED' }); }
        catch { /* read the known task back below; never replay a write that may have completed */ }
      }
      if (c.state === 'completing' && c.task_id) {
        const done = await cin7('/stockadjustment?TaskID=' + encodeURIComponent(c.task_id));
        verifyAdjustment(done, c);
        if (done.Status !== 'COMPLETED') throw new HttpError(409, `Cin7 has not confirmed ${c.adjustment_number || 'the adjustment'} as completed. Refresh the status; don't start another change.`);
        c = await codeJob(id, 'transition', { expected: 'completing', next: 'cin7_done' });
      }
      await log(ctx, 'stock', 'commit', ref, 'ok', { changeId: id, state: c.state, adjustment: c.adjustment_number, from: c.from_sku, to: c.to_sku, quantity: c.quantity });
      return { change: c };
    } catch (e) {
      await log(ctx, 'stock', 'commit', ref, 'error', { changeId: id, error: String((e as Error).message).slice(0, 300) });
      throw e;
    }
  }
  if (action === 'status') {
    const id = uuidOrNull(b.id);
    if (!id) throw new HttpError(400, 'Invalid request.');
    return { change: await codeJob(id, 'get') };
  }
  if (action === 'recent') return { changes: await rpc('portal_code_recent', { p_limit: 20 }) };
  throw new HttpError(400, 'Unknown stock action.');
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
  if (action === 'picklists') return { orders: await rpc('portal_new_order_pick_lists') };
  if (action === 'pick_confirm') {
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x: unknown) => String(x)).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 10) as string[];
    if (!ids.length) throw new HttpError(400, 'No orders to move.');
    return await authorisePicks(ctx, ids);
  }
  if (action === 'ops') {
    const [ops, asn, gradingQueue] = await Promise.all([rpc('portal_ops_dashboard'), rpc('asn_ops_summary'), rpc('portal_grading_queue')]);
    return { ...ops, asn, gradingQueue };
  }
  throw new HttpError(400, 'Unknown dashboard action.');
}

// ---------- Admin (managers) ----------
async function admin(ctx: Ctx, action: string, b: J, req: Request) {
  if (ctx.staff.role !== 'manager') throw new HttpError(403, 'Managers only.');
  // One-time code for enrolling a new terminal; only works on this device's network for 15 minutes.
  if (action === 'enrol_code') return await rpc('portal_enrol_code_create', { p_staff: ctx.staff.id, p_terminal: ctx.terminalId, p_ip: clientIp(req) });
  if (action === 'staff') {
    const rows = await rest('staff?select=id,display_name,former_names,role,active,pin_set_at,locked_until&order=display_name');
    return { staff: rows.map((s: J) => ({ id: s.id, name: s.display_name, formerNames: s.former_names, role: s.role, active: s.active, hasPin: !!s.pin_set_at, locked: !!s.locked_until && Date.parse(s.locked_until) > Date.now() })) };
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
  } else if (['reset_pin', 'unlock', 'deactivate', 'activate', 'make_manager', 'make_staff'].includes(action)) {
    if (!id) throw new HttpError(400, 'Choose a staff member.');
    if (id === ctx.staff.id && ['deactivate', 'make_staff'].includes(action)) throw new HttpError(400, 'Ask another manager to change your own access.');
    const body: J = {
      reset_pin: { pin_hash: null, pin_set_at: null, failed_pin_attempts: 0, locked_until: null },
      unlock: { failed_pin_attempts: 0, locked_until: null },
      deactivate: { active: false }, activate: { active: true },
      make_manager: { role: 'manager' }, make_staff: { role: 'staff' },
    }[action]!;
    await patch(body);
    if (['reset_pin', 'deactivate'].includes(action)) {
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

const MODULES: Record<string, (ctx: Ctx, action: string, b: J, req: Request) => Promise<J>> = { grading, shipping, sales, dashboard, admin, stock };

async function handle(req: Request): Promise<J> {
  const raw = await req.text();
  const syncToken = req.headers.get('x-sync-token') || '';
  if (raw.length > (syncToken ? 4000000 : 64000)) throw new HttpError(413, 'Request too large.');
  let b: J;
  try { b = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
  const [module, action] = String(b.action || '').split('.');
  const terminalToken = req.headers.get('x-terminal-token') || '';

  // ASNs DB snapshot from apps-script/AsnOpsSync.gs (no staff session; its own token).
  if (module === 'sync' && action === 'asn') {
    const [cfg] = await rest('portal_config?select=value&key=eq.asn_sync_token_sha256');
    if (!cfg || !syncToken || (await sha256(syncToken)) !== cfg.value) throw new HttpError(401, 'Invalid sync token.');
    const ingest = await rpc('asn_ops_ingest', { p: { rowsTotal: b.rowsTotal, rows: b.rows, shipments: b.shipments } });
    // Device product-code changes waiting for the ASNs Code column (AE) to be checked/updated.
    return { ...ingest, codeWrites: await rpc('portal_code_sheet_pending') };
  }
  if (module === 'sync' && action === 'asn_codes') {
    const [cfg] = await rest('portal_config?select=value&key=eq.asn_sync_token_sha256');
    if (!cfg || !syncToken || (await sha256(syncToken)) !== cfg.value) throw new HttpError(401, 'Invalid sync token.');
    return { ok: true, updated: await rpc('portal_code_sheet_ack', { p: { results: Array.isArray(b.results) ? b.results.slice(0, 200) : [] } }) };
  }

  if (module === 'terminal' && action === 'enrol') {
    const r = await rpc('portal_terminal_enrol', { p_code: String(b.code || '').trim().toUpperCase(), p_name: String(b.name || ''), p_ip: clientIp(req) });
    if (!r?.ok) throw new HttpError(403, r?.error || 'Enrolment failed.');
    return r;
  }
  if (module === 'auth' && action === 'staff') return { staff: await rpc('portal_staff_list', { p_terminal_token: terminalToken }) };
  if (module === 'auth' && action === 'signin') {
    const staffId = uuidOrNull(b.staffId);
    if (!staffId) throw new HttpError(400, 'Choose your name.');
    const r = await rpc('portal_sign_in_staff', { p_terminal_token: terminalToken, p_staff: staffId, p_pin: b.pin ?? null, p_new_pin: b.newPin ?? null });
    if (!r?.ok) throw new HttpError(403, r?.error || 'Sign in failed.');
    return r;
  }

  const s = await rpc('portal_session', { p_terminal_token: terminalToken, p_session_token: req.headers.get('x-session-token') || '' });
  if (s.signedOut) throw new HttpError(401, 'Signed out after 5 minutes without activity.', { signedOut: true, reason: s.reason });
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
  return await run(ctx, action, b, req);
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
