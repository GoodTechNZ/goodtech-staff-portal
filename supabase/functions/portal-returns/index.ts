// Returns tab (all signed-in staff). Every request checks the portal session (same rules as the gateway).
// Actions:
//   find {q}                      Cin7 sales by SO, Shopify #, IMEI, name, email or phone
//   list / get {id}               returns, newest first (open ones on top)
//   create {saleId, items, reasonCategory, reasonDetail, outcome, customer}
//   label {id}                    eShip return label to GoodTech; PDF emailed to the customer
//   receive {id, imei?}           device back in store
//   products {q}                  Cin7 products for a replacement / warranty SO
//   outbound {id, kind, lines}    Cin7 Replacement / Warranty SO + matching eShip order (ship it from Shipping)
//   close {id, note} / cancel {id, note}
// Mailer (apps-script/ReturnsMailer.gs, header x-mail-token): mail.pending / mail.ack {id, ok, error}
type J = Record<string, any>;

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ORIGINS = (Deno.env.get('PORTAL_ALLOWED_ORIGINS') || '*').split(',').map(s => s.trim()).filter(Boolean);
export const REASONS = ['Screen / touch', 'Battery', 'Camera', 'Audio / microphone', 'Connectivity / SIM', 'Charging / port',
  'Software / power / setup', 'Cosmetic / condition', 'Wrong item sent', 'Preference / suitability', 'Other'];
const OUTCOMES = ['refund', 'replacement', 'warranty', 'undecided'];

class HttpError extends Error { constructor(public status: number, message: string, public extra: J = {}) { super(message); } }

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allow = ORIGINS.includes('*') ? '*' : ORIGINS.includes(origin) ? origin : ORIGINS[0] || '';
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-terminal-token, x-session-token, x-mail-token', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
}
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(URL_ + '/rest/v1/' + path, { ...init, headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY, ...(init.headers || {}) } });
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
const one = async (path: string) => (await rest(path))?.[0] ?? null;
const patch = (path: string, body: J) => rest(path, { method: 'PATCH', body: JSON.stringify(body), headers: { Prefer: 'return=representation' } }).then(r => r?.[0]);
const insert = (table: string, body: J) => rest(table, { method: 'POST', body: JSON.stringify(body), headers: { Prefer: 'return=representation' } }).then(r => r?.[0]);
async function sha256(v: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))).map(x => x.toString(16).padStart(2, '0')).join('');
}
const uuidOk = (v: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v ?? ''));
const nzDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

// ---------- Cin7 ----------
let lastCin7 = 0;
async function cin7(path: string, method = 'GET', body?: J): Promise<J> {
  const wait = lastCin7 + 1000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCin7 = Date.now();
  const r = await fetch('https://inventory.dearsystems.com/ExternalApi/v2' + path, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'api-auth-accountid': Deno.env.get('CIN7_ACCOUNT_ID') || '', 'api-auth-applicationkey': Deno.env.get('CIN7_APPLICATION_KEY') || '' },
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* error page */ }
  if (!r.ok || Array.isArray(data) && data[0]?.ErrorCode || data?.ErrorCode) {
    const first = Array.isArray(data) ? data[0] : data;
    throw new Error('Cin7: ' + String(first?.Exception || first?.Message || `HTTP ${r.status}`).slice(0, 300));
  }
  return data;
}

// ---------- eShip (Starshipit) ----------
async function eship(path: string, method = 'GET', body?: J): Promise<J> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.starshipit.com/api/' + path, {
      method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', 'StarShipIT-Api-Key': Deno.env.get('ESHIP_API_KEY') || '', 'Ocp-Apim-Subscription-Key': Deno.env.get('ESHIP_SUBSCRIPTION_KEY') || '' },
    });
    // A 429 is rejected before eShip processes anything, so any request can be retried.
    if (r.status === 429) { await r.text(); await new Promise(s => setTimeout(s, 1500 * 2 ** i)); continue; }
    const text = await r.text();
    let d: any = null;
    try { d = text ? JSON.parse(text) : null; } catch { /* */ }
    if (!r.ok || d?.success === false || d?.succeeded === false) throw new Error('eShip: ' + JSON.stringify(d?.errors || d?.message || r.status).slice(0, 400));
    return d;
  }
  throw new Error('eShip is busy. Try again in a moment.');
}

// Carrier, service and parcel settings copied from a recent shipment of the same kind, so portal labels
// match what staff make in eShip today. 'return' = a manual label addressed to GoodTech (its
// destination is GoodTech's service address); 'outbound' = a recent Shopify courier parcel.
async function eshipTemplate(kind: 'return' | 'outbound'): Promise<J> {
  const key = 'returns_eship_' + kind + '_template';
  const cfg = await one('portal_config?select=value&key=eq.' + key);
  if (cfg?.value) return JSON.parse(cfg.value);
  const since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const list = await eship(`orders/shipped?since_last_updated=${since}T00:00:00Z&limit=250&page=1`);
  const orders = (list.orders || []).filter((o: J) => kind === 'return'
    ? o.integration_source_name === 'Manual' && /service|goodtech/i.test(o.name || '')
    : o.integration_source_name === 'Shopify' && /courier/i.test(o.carrier_service_name || ''));
  orders.sort((a: J, b: J) => String(b.shipped_date).localeCompare(String(a.shipped_date)));
  if (!orders.length) throw new Error(`No recent ${kind === 'return' ? 'manual return' : 'courier'} label in eShip to copy settings from.`);
  const d = await eship('orders?order_id=' + encodeURIComponent(orders[0].order_id));
  const o = d.order || d.data?.order;
  if (!o?.carrier || !o?.carrier_service_code || !(o.packages || []).length) throw new Error('The eShip label settings could not be read.');
  const t = {
    carrier: o.carrier, carrier_name: o.carrier_name, carrier_service_code: o.carrier_service_code, shipping_method: o.shipping_method || o.carrier_service_name || '',
    packages: (o.packages || []).slice(0, 1).map((p: J) => ({ weight: p.weight, height: p.height, width: p.width, length: p.length, packaging_type: p.packaging_type })),
    ...(kind === 'return' ? { destination: returnDestination(o.destination) } : {}), copiedFrom: o.order_number,
  };
  await rest('portal_config', { method: 'POST', body: JSON.stringify({ key, value: JSON.stringify(t) }), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  return t;
}

// GoodTech's service address from the copied label: address fields only (not that label's note).
export function returnDestination(d: J = {}): J {
  return { name: 'Service | GoodTech', company: clip(d.company || 'GoodTech', 100), street: clip(d.street, 150), suburb: clip(d.suburb, 100),
    city: clip(d.city, 100), state: clip(d.state, 50), post_code: clip(d.post_code, 10), country: clip(d.country || 'New Zealand', 60) };
}

export function eshipDestination(c: J): J {
  const a = c.address || {};
  return {
    name: clip(c.name, 100), email: clip(c.email, 200), phone: clip(c.phone, 40), company: clip(a.Company, 100),
    street: clip(a.Line1, 150), suburb: clip(a.Line2, 100), city: clip(a.City, 100), state: clip(a.State, 50),
    post_code: clip(a.Postcode, 10), country: clip(a.Country || 'New Zealand', 60),
  };
}

async function createEshipOrder(orderNumber: string, reference: string, destination: J, items: J[], t: J) {
  const body = { order: {
    order_date: new Date().toISOString(), order_number: orderNumber, reference,
    carrier: t.carrier, carrier_service_code: t.carrier_service_code, shipping_method: t.shipping_method,
    destination, items, packages: t.packages,
  } };
  const r = await eship('orders', 'POST', body);
  const o = r.order || r.data?.order;
  if (!o?.order_id || String(o.order_number) !== orderNumber) throw new Error('eShip did not confirm the new order.');
  return o;
}

async function printLabel(order: J, t: J) {
  const r = await eship('orders/shipment', 'POST', { order_id: order.order_id, carrier: t.carrier, carrier_service_code: t.carrier_service_code, packages: t.packages, reprint: false });
  const labels = (r.labels || []).filter((x: unknown) => typeof x === 'string' && (x as string).startsWith('JVBER'));
  const tracking = (r.tracking_numbers || [])[0];
  if (String(r.order_id) !== String(order.order_id) || labels.length !== 1 || !tracking) throw new Error('eShip did not return one label and tracking number. Check the order in eShip before retrying.');
  return { label: labels[0] as string, tracking: String(tracking) };
}

// ---------- returns ----------
const RETURN_COLS = 'id,number,created_at,updated_at,created_by_name,cin7_sale_id,so,order_ref,customer,items,reason_category,reason_detail,outcome,status,return_label,received_at,received_by,outbound,closed_note';
async function getReturn(id: string) {
  if (!uuidOk(id)) throw new HttpError(400, 'Choose a return.');
  const r = await one(`portal_returns?select=${RETURN_COLS}&id=eq.${id}`);
  if (!r) throw new HttpError(404, 'Return not found.');
  return r;
}
async function event(s: J, id: string, action: string, details: J = {}) {
  await insert('portal_return_events', { return_id: id, staff_id: s.staff.id, staff_name: s.staff.name, action, details });
  try { await rpc('portal_log', { p_staff: s.staff.id, p_session: s.sessionId, p_terminal: s.terminalId, p_module: 'returns', p_action: action, p_ref: details.number || null, p_outcome: 'ok', p_details: details }); } catch { /* logging only */ }
}
const update = (id: string, body: J) => patch(`portal_returns?id=eq.${id}&select=${RETURN_COLS}`, { ...body, updated_at: new Date().toISOString() });

export function returnItems(sale: J, picked: J[]): J[] {
  const lines: J[] = sale.lines || [];
  const out = (Array.isArray(picked) ? picked : []).slice(0, 20).map(p => {
    const l = lines.find(x => x.sku === p.sku);
    if (!l) throw new HttpError(400, 'Choose items from this order.');
    return { sku: l.sku, name: l.name, price: Number(l.price) || 0, imei: clip(p.imei, 30) || null };
  });
  if (!out.length) throw new HttpError(400, 'Choose the item being returned.');
  return out;
}

async function handle(req: Request): Promise<J> {
  const raw = await req.text();
  if (raw.length > 30000) throw new HttpError(413, 'Request too large.');
  let b: J;
  try { b = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
  const action = String(b.action || '');

  // Service mailbox mailer (Apps Script): its own token.
  if (action.startsWith('mail.')) {
    const cfg = await one('portal_config?select=value&key=eq.returns_mail_token_sha256');
    const tok = req.headers.get('x-mail-token') || '';
    if (!cfg?.value || !tok || (await sha256(tok)) !== cfg.value) throw new HttpError(401, 'Invalid mail token.');
    if (action === 'mail.pending') {
      const rows = await rest('portal_outbound_email?select=id,to_email,subject,body,attachment_name,attachment_b64,attempts&status=in.(pending)&attempts=lt.5&order=created_at&limit=10');
      if (rows.length) await rest('portal_outbound_email?id=in.(' + rows.map((r: J) => r.id).join(',') + ')', { method: 'PATCH', body: JSON.stringify({ status: 'sending' }) });
      return { emails: rows };
    }
    if (action === 'mail.ack') {
      if (!uuidOk(b.id)) throw new HttpError(400, 'Invalid email id.');
      const row = await one(`portal_outbound_email?select=attempts,return_id&id=eq.${b.id}`);
      const ok = !!b.ok;
      await rest(`portal_outbound_email?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify(ok
        ? { status: 'sent', sent_at: new Date().toISOString(), error: null }
        : { status: (row?.attempts || 0) + 1 >= 5 ? 'failed' : 'pending', attempts: (row?.attempts || 0) + 1, error: clip(b.error, 500) }) });
      if (ok && row?.return_id) await insert('portal_return_events', { return_id: row.return_id, staff_name: 'Service mailbox', action: 'label_emailed', details: { emailId: b.id } });
      return { ok: true };
    }
    // Setup check (read-only): the eShip settings return labels and outbound orders will copy.
    if (action === 'mail.templates') return { return: await eshipTemplate('return'), outbound: await eshipTemplate('outbound') };
    // Setup check: eShip accepts a portal-made order (created, read back, deleted; no label). With
    // deleteOrderId, only deletes a leftover check order (order number PORTALTEST…).
    if (action === 'mail.eshipcheck' && b.deleteOrderId) {
      const d = await eship('orders?order_id=' + encodeURIComponent(String(b.deleteOrderId)));
      if (!String(d.order?.order_number || '').startsWith('PORTALTEST')) throw new HttpError(400, 'Only setup check orders can be deleted here.');
      return { deleted: await eship('orders/delete?order_id=' + encodeURIComponent(String(b.deleteOrderId)), 'DELETE') };
    }
    if (action === 'mail.eshipcheck') {
      const t = await eshipTemplate('return');
      const o = await createEshipOrder('PORTALTEST' + Date.now().toString().slice(-6), 'Portal returns setup check - delete', { ...returnDestination(t.destination), delivery_instructions: 'TEST - not a real return' },
        [{ description: 'Setup check', sku: 'TEST', quantity: 1, value: 0 }], t);
      const back = await eship('orders?order_id=' + encodeURIComponent(o.order_id));
      let deleted: unknown = null;
      try { deleted = await eship('orders/delete?order_id=' + encodeURIComponent(o.order_id), 'DELETE'); } catch (e) { deleted = String((e as Error).message); }
      const bo = back.order || {};
      return { orderId: o.order_id, orderNumber: o.order_number, carrier: bo.carrier, service: bo.carrier_service_code, packages: bo.packages, destination: bo.destination, deleted };
    }
    throw new HttpError(400, 'Unknown action.');
  }

  const s = await rpc('portal_session', { p_terminal_token: req.headers.get('x-terminal-token') || '', p_session_token: req.headers.get('x-session-token') || '' });
  if (s.signedOut) throw new HttpError(401, 'Signed out after 5 minutes without activity.', { signedOut: true, reason: s.reason });

  if (action === 'find') {
    const q = clip(b.q, 80);
    if (q.length < 3) return { sales: [] };
    return { sales: await rpc('portal_returns_find', { p_q: q }) };
  }
  if (action === 'list') {
    const rows = await rest(`portal_returns?select=${RETURN_COLS}&order=created_at.desc&limit=60`);
    const rank = (r: J) => ['closed', 'cancelled'].includes(r.status) ? 1 : 0;
    return { returns: rows.sort((a: J, c: J) => rank(a) - rank(c)), reasons: REASONS };
  }
  if (action === 'get') {
    const r = await getReturn(String(b.id));
    const events = await rest(`portal_return_events?select=at,staff_name,action,details&return_id=eq.${r.id}&order=at`);
    const emails = await rest(`portal_outbound_email?select=id,to_email,status,sent_at,error&return_id=eq.${r.id}&order=created_at`);
    return { return: r, events, emails };
  }
  if (action === 'create') {
    const sales: J[] = await rpc('portal_returns_find', { p_q: clip(b.so, 20) });
    const sale = sales.find(x => x.saleId === b.saleId);
    if (!sale) throw new HttpError(404, 'Order not found. Search again.');
    const reason = String(b.reasonCategory || '');
    if (!REASONS.includes(reason)) throw new HttpError(400, 'Choose the return reason.');
    const outcome = String(b.outcome || '');
    if (!OUTCOMES.includes(outcome)) throw new HttpError(400, 'Choose what the customer wants.');
    const detail = clip(b.reasonDetail, 2000);
    if (detail.length < 5) throw new HttpError(400, 'Describe the problem.');
    const c = b.customer || {};
    const email = clip(c.email ?? sale.customer.email, 200);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email.');
    const customer = {
      id: sale.customer.id, cin7Name: sale.customer.name, name: clip(c.name ?? sale.customer.name, 150), email, phone: clip(c.phone ?? sale.customer.phone, 40),
      address: { ...(sale.customer.address || {}), ...Object.fromEntries(Object.entries(c.address || {}).map(([k, v]) => [k, clip(v, 150)])) },
    };
    const r = await insert('portal_returns', {
      created_by: s.staff.id, created_by_name: s.staff.name, cin7_sale_id: sale.saleId, so: sale.so, order_ref: sale.ref,
      customer, items: returnItems(sale, b.items), reason_category: reason, reason_detail: detail, outcome,
    });
    await event(s, r.id, 'created', { number: r.number, so: sale.so, reason, outcome });
    return { return: r };
  }

  const r = await getReturn(String(b.id));
  if (action === 'label') {
    if (['closed', 'cancelled'].includes(r.status)) throw new HttpError(400, 'This return is closed.');
    const c = r.customer || {};
    if (!/^\S+@\S+\.\S+$/.test(c.email || '')) throw new HttpError(400, 'Add the customer email to send the label.');
    if (r.return_label?.tracking) throw new HttpError(400, `A return label (${r.return_label.tracking}) was already made. Resend the email instead.`);
    const t = await eshipTemplate('return');
    let label = r.return_label || {};
    if (!label.eship_order_id) {
      const dest = { ...returnDestination(t.destination), delivery_instructions: clip(`Return ${r.number} from ${c.name || ''} (${r.so || ''})`, 100) };
      const o = await createEshipOrder(r.number, `Return ${r.number} ${r.so || ''} ${c.name || ''}`.slice(0, 60), dest,
        (r.items || []).map((i: J) => ({ description: clip(i.name, 100), sku: i.sku, quantity: 1, value: 0 })), t);
      label = { eship_order_id: o.order_id, order_number: o.order_number };
      await update(r.id, { return_label: label });
    }
    const { label: pdf, tracking } = await printLabel({ order_id: label.eship_order_id }, t);
    const mail = await insert('portal_outbound_email', {
      return_id: r.id, to_email: c.email, subject: `Your GoodTech return label (${r.number})`,
      body: returnEmail(r, tracking), attachment_name: `GoodTech-return-${r.number}.pdf`, attachment_b64: pdf,
    });
    const updated = await update(r.id, { return_label: { ...label, tracking, created_at: new Date().toISOString(), email_id: mail.id }, status: r.status === 'open' ? 'label_sent' : r.status });
    await event(s, r.id, 'label_created', { number: r.number, tracking, email: c.email });
    return { return: updated, label: pdf, tracking };
  }
  if (action === 'resend') {
    if (!r.return_label?.tracking || !r.return_label?.email_id) throw new HttpError(400, 'No label to resend yet.');
    const prev = await one(`portal_outbound_email?select=attachment_b64&id=eq.${r.return_label.email_id}`);
    const to = clip(b.email || r.customer?.email, 200);
    if (!/^\S+@\S+\.\S+$/.test(to)) throw new HttpError(400, 'Enter a valid email.');
    await insert('portal_outbound_email', { return_id: r.id, to_email: to, subject: `Your GoodTech return label (${r.number})`, body: returnEmail(r, r.return_label.tracking),
      attachment_name: `GoodTech-return-${r.number}.pdf`, attachment_b64: prev?.attachment_b64 });
    await event(s, r.id, 'label_resent', { number: r.number, email: to });
    return { ok: true };
  }
  if (action === 'receive') {
    if (['closed', 'cancelled'].includes(r.status)) throw new HttpError(400, 'This return is closed.');
    const imei = clip(b.imei, 30);
    const expected = (r.items || []).map((i: J) => i.imei).filter(Boolean);
    if (imei && expected.length && !expected.includes(imei)) throw new HttpError(409, `That IMEI isn't on this return (expected ${expected.join(', ')}).`);
    const updated = await update(r.id, { status: r.status === 'outbound' ? 'outbound' : 'received', received_at: new Date().toISOString(), received_by: s.staff.name });
    await event(s, r.id, 'received', { number: r.number, imei: imei || null });
    return { return: updated };
  }
  if (action === 'products') {
    const q = clip(b.q, 40).replace(/[^A-Za-z0-9 .\/-]/g, '');
    if (q.length < 2) return { products: [] };
    const like = encodeURIComponent('*' + q + '*');
    const rows: J[] = await rest(`cin7_products?select=product_id,sku,name,price_tier_1&status=eq.Active&or=(sku.ilike.${like},name.ilike.${like})&order=sku&limit=20`);
    return { products: rows.map(p => ({ id: p.product_id, sku: p.sku, name: p.name, price: Number(p.price_tier_1) || 0 })) };
  }
  if (action === 'outbound') {
    if (['closed', 'cancelled'].includes(r.status)) throw new HttpError(400, 'This return is closed.');
    const kind = b.kind === 'warranty' ? 'warranty' : b.kind === 'replacement' ? 'replacement' : '';
    if (!kind) throw new HttpError(400, 'Choose Replacement or Warranty.');
    return await outbound(s, r, kind, Array.isArray(b.lines) ? b.lines.slice(0, 10) : []);
  }
  if (action === 'close' || action === 'cancel') {
    const note = clip(b.note, 1000);
    if (action === 'cancel' && note.length < 3) throw new HttpError(400, 'Say why the return is cancelled.');
    const updated = await update(r.id, { status: action === 'close' ? 'closed' : 'cancelled', closed_note: note || null });
    await event(s, r.id, action === 'close' ? 'closed' : 'cancelled', { number: r.number, note });
    return { return: updated };
  }
  throw new HttpError(400, 'Unknown action.');
}

export function returnEmail(r: J, tracking: string) {
  const first = String(r.customer?.name || '').split(/\s+/)[0] || 'there';
  return [`Hi ${first},`, '',
    `Here's your prepaid return label for ${r.so || 'your order'}${r.order_ref ? ' (' + r.order_ref + ')' : ''} — return ${r.number}.`, '',
    '1. Print the attached label and stick it on the parcel.',
    '2. Pack the device securely (please remove any SIM card, and turn off Find My / sign out of your Google account).',
    '3. Drop it at any NZ Post shop or PostBox.', '',
    `Tracking number: ${tracking}`, '',
    "We'll be in touch as soon as it arrives.", '', 'Thanks,', 'GoodTech'].join('\n');
}

// Replacement / Warranty: Cin7 SO (authorised, rep Replacement / Warranty, reference RTxxxx-R / -W) and a
// matching eShip order with the same reference, items and address, so the Shipping tab can scan the IMEI,
// print the label and ship it like any other SO. Safe to retry: each step is skipped once done.
async function outbound(s: J, r: J, kind: 'replacement' | 'warranty', picked: J[]) {
  const ref = r.number + (kind === 'replacement' ? '-R' : '-W');
  const c = r.customer || {};
  const a = c.address || {};
  if (!c.id) throw new HttpError(400, 'This return has no Cin7 customer.');
  if (!a.Line1 || !a.City || !a.Postcode) throw new HttpError(400, 'Add the customer delivery address (street, city, postcode) first.');
  let ob: J = r.outbound || {};
  if (ob.kind && ob.kind !== kind) throw new HttpError(409, `A ${ob.kind} order (${ob.so || ob.ref}) already exists for this return.`);

  if (!ob.cin7_sale_id) {
    if (!picked.length) throw new HttpError(400, 'Add the product(s) to send.');
    const skus = [...new Set(picked.map(p => clip(p.sku, 50)))];
    const products: J[] = await rest('cin7_products?select=product_id,sku,name,raw&sku=in.(' + skus.map(x => '"' + x + '"').join(',') + ')');
    const lines = picked.map(p => {
      const prod = products.find(x => x.sku === p.sku);
      if (!prod) throw new HttpError(400, `${p.sku} is not in Cin7.`);
      const price = Math.round(Number(p.price || 0) * 100) / 100;
      if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'Enter a valid price.');
      return { ProductID: prod.product_id, SKU: prod.sku, Name: prod.name, Quantity: 1, Price: price, Discount: 0, TaxRule: '15% GST on Income',
        Tax: Math.round(price * 15 / 115 * 10000) / 10000, Total: price, Comment: clip(p.imei, 30) };
    });
    const ext = 'GT-RETURN-' + ref;
    // Reuse a sale an earlier attempt may have created (timeouts), never create a second one.
    const found = await cin7('/SaleList?ExternalID=' + encodeURIComponent(ext) + '&Limit=10');
    let saleId = (found.SaleList || []).find((x: J) => x.ExternalID === ext)?.SaleID;
    if (!saleId) {
      const created = await cin7('/Sale', 'POST', {
        CustomerID: c.id, Customer: c.cin7Name || c.name, Contact: c.name, Phone: c.phone, Email: c.email, SkipQuote: true, Type: 'Simple Sale', SaleOrderDate: nzDate(),
        TaxRule: '15% GST on Income', TaxCalculation: 'Inclusive', TaxInclusive: true, Terms: 'Immediate', PriceTier: 'Shopify & Instore',
        Location: 'Ready For Sale', SalesRepresentative: kind === 'replacement' ? 'Replacement' : 'Warranty', Carrier: 'CourierPost',
        DefaultAccount: '200', CustomerCurrency: 'NZD', CurrencyRate: 1, CustomerReference: ref, ExternalID: ext,
        ShippingAddress: { Line1: a.Line1, Line2: a.Line2 || '', City: a.City, State: a.State || '', Postcode: a.Postcode, Country: a.Country || 'New Zealand', Company: a.Company || '', Contact: c.name, ShipToOther: false },
        Note: `${kind === 'replacement' ? 'Replacement' : 'Warranty'} for ${r.so || ''} — return ${r.number} by ${s.staff.name}. ${r.reason_category}: ${r.reason_detail}`.slice(0, 1000),
      });
      saleId = created.ID;
      if (!saleId) throw new Error('Cin7 did not return the new sale ID. Check Cin7 for ' + ext + ' before retrying.');
    }
    let sale = await cin7('/Sale?ID=' + encodeURIComponent(saleId));
    if (sale.ExternalID !== ext) throw new Error('Cin7 sale identity did not match.');
    if (!['AUTHORISED', 'FULFILLED'].includes(sale.Order?.Status)) {
      await cin7('/Sale/Order', 'POST', { SaleID: saleId, Status: 'AUTHORISED', Memo: `Return ${r.number}`, Lines: lines, AdditionalCharges: [] });
      sale = await cin7('/Sale?ID=' + encodeURIComponent(saleId));
    }
    if (sale.Order?.Status !== 'AUTHORISED') throw new Error('Cin7 did not authorise the order. Check ' + (sale.Order?.SaleOrderNumber || ext) + ' in Cin7.');
    ob = { kind, ref, cin7_sale_id: saleId, so: sale.Order.SaleOrderNumber, lines: lines.map(l => ({ sku: l.SKU, name: l.Name, price: l.Price, imei: l.Comment || null })), created_at: new Date().toISOString() };
    await update(r.id, { outbound: ob, status: 'outbound' });
    // Let the Shipping tab find the SO straight away (the Cin7 sync fills in the details).
    await rest('cin7_sales_raw?on_conflict=cin7_sale_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ cin7_sale_id: saleId, order_number: ob.so, status: sale.Status, order_date: nzDate(), customer_id: c.id, summary: {}, detail_sync_status: 'pending' }) });
    await event(s, r.id, 'cin7_order_created', { number: r.number, kind, so: ob.so });
  }
  if (!ob.eship_order_id) {
    const t = await eshipTemplate('outbound');
    const o = await createEshipOrder(ref, `${kind === 'replacement' ? 'Replacement' : 'Warranty'} ${ob.so} for ${r.so || r.number}`.slice(0, 60),
      eshipDestination(c), (ob.lines || []).map((l: J) => ({ description: clip(l.name, 100), sku: l.sku, quantity: 1, value: Number(l.price) || 0 })), t);
    ob = { ...ob, eship_order_id: o.order_id };
    await update(r.id, { outbound: ob, status: 'outbound' });
    await event(s, r.id, 'eship_order_created', { number: r.number, so: ob.so, eshipOrder: o.order_id });
  }
  return { return: await getReturn(r.id) };
}

Deno.serve(async req => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers });
  const h2 = { ...headers, 'Cache-Control': 'no-store' };
  try {
    return Response.json(await handle(req), { headers: h2 });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message, ...e.extra }, { status: e.status, headers: h2 });
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : 'Something went wrong. Try again.' }, { status: 500, headers: h2 });
  }
});
