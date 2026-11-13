// Pure request rules for the staff portal gateway. No Deno or network access here so the
// rules can be unit tested from Node.

export type J = Record<string, any>;

export const GRADING_TESTS = [
  'Display', 'Touchscreen', 'Front camera', 'Rear cameras', 'Microphone', 'Speakers',
  'Buttons', 'Charging', 'Wi-Fi', 'Bluetooth', 'Mobile network', 'Biometrics',
] as const;
export const DESTINATIONS = ['Ready For Sale', 'Repairs', 'Locked'] as const;
const TEST_RESULTS = ['Pass', 'Fail', 'Not applicable'];

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: J = {}) { super(message); }
}

export function nzDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function validSerial(serial: unknown): string {
  const s = String(serial ?? '').trim();
  if (!/^[A-Za-z0-9-]{5,30}$/.test(s)) throw new HttpError(400, 'Scan a valid serial or IMEI.');
  return s;
}

export function locationFor(destination: string): string {
  return destination === 'Ready For Sale' ? 'Cabinet' : destination;
}

// Builds the record written to the Grading sheet. The tester and date always come from the
// signed-in session, never from the terminal.
export function gradingRecord(input: J, tester: string, today: string): J {
  const grade = String(input?.grade ?? '');
  if (!['1', '2', '3'].includes(grade)) throw new HttpError(400, 'Select a grade.');
  const destination = String(input?.destination ?? '');
  if (!(DESTINATIONS as readonly string[]).includes(destination)) throw new HttpError(400, 'Select where the device goes.');
  const colour = String(input?.colour ?? '').trim();
  if (!colour || colour.length > 150 || ['X', '#N/A', 'N/A', '*'].includes(colour.toUpperCase())) throw new HttpError(400, 'Enter the colour.');
  const battery = String(input?.battery ?? '').trim();
  if (battery && (!/^\d{1,3}$/.test(battery) || Number(battery) > 100)) throw new HttpError(400, 'Battery must be 0–100.');
  const tests: J = {};
  for (const t of GRADING_TESTS) {
    const v = String(input?.tests?.[t] ?? '');
    if (!TEST_RESULTS.includes(v)) throw new HttpError(400, `Record the ${t} test.`);
    tests[t] = v;
  }
  const status = String(input?.status ?? '').trim().slice(0, 1000);
  if (Object.values(tests).includes('Fail') && !status) throw new HttpError(400, 'Describe the fault in Device status when a test fails.');
  const notes = String(input?.notes ?? '').trim().slice(0, 5000);
  return { grade, colour, status, location: locationFor(destination), tester, date: today, battery, tests, notes, destination };
}

export function uuidOrNull(v: unknown): string | null {
  const s = String(v ?? '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

/** Areas that need the manager's PIN once per session (Admin, and committing a Cin7 product-code change).
 *  Everything else is name-only: staff pick their name and work. */
export function needsElevation(module: string, action: string): boolean {
  if (module === 'admin') return true;
  if (module === 'stock') return action === 'commit';
  return false;
}

const SHIPPING_FIELDS = ['salesOrderNumber', 'trackingNumber', 'imei', 'scanEventId', 'overrideReason', 'claimedSku', 'copyImeiToComments'];
const SALES_FIELDS = ['q', 'kind', 'mode', 'requestId', 'customer', 'lines', 'memo', 'id'];
export const SHIPPING_ACTIONS = ['lookup', 'scan', 'override', 'print', 'ship', 'pickup_ready', 'collect', 'settings', 'save_settings', 'errors'];
export const SALES_ACTIONS = ['bootstrap', 'search', 'create', 'get', 'invoice', 'ship', 'void', 'resume'];

export function bridgeBody(module: 'shipping' | 'sales', action: string, body: J, staff: { id: string; name: string }): J {
  const fields = module === 'shipping' ? SHIPPING_FIELDS : SALES_FIELDS;
  const out: J = { action, staff: staff.name, owner: staff.id };
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

export function discountedLines(order: J | undefined): number {
  return (order?.lines ?? []).filter((l: J) => Number.isFinite(Number(l.catalogue_price)) && Number(l.price) < Number(l.catalogue_price) - 0.004).length;
}

export function shippingRef(body: J, result: J): string {
  return String(body.salesOrderNumber || result?.cin7OrderNumber || result?.shipment?.cin7_order_number || body.trackingNumber || '').slice(0, 120);
}

// Cin7 Pick authorisation for a printed pick list. Mirrors the lines Cin7 itself writes when a
// pick is authorised in the app: every order line, from the sale's location.
export function pickRequest(task: string, location: string, lines: J[]): J {
  const picked = (lines || []).filter(l => l?.ProductID && Number(l.Quantity) > 0);
  if (!task || !location || !picked.length) throw new HttpError(400, 'Order has nothing to pick.');
  return {
    TaskID: task, Status: 'AUTHORISED',
    Lines: picked.map(l => ({ ProductID: l.ProductID, SKU: l.SKU, Name: l.Name, Location: location, Quantity: Number(l.Quantity), NonInventory: !!l.NonInventory })),
  };
}

export function cin7ErrorText(data: unknown, status: number): string {
  const first = Array.isArray(data) ? data[0] : data as J;
  const text = String(first?.Exception || first?.Message || first?.error || '').trim();
  return (text || `Cin7 request failed (HTTP ${status}).`).slice(0, 300);
}

// ---------- Product-code changes (Cin7 stock adjustments) ----------
// Same method as the 15 Oct device correction: one adjustment that takes N off the source SKU and
// puts N on the target SKU at the same location, at the source's average cost. Balances are
// reviewed first and re-checked against live Cin7 before each write.

export const CIN7_STOCK_LOCATIONS = ['Ready For Sale', 'Repairs', 'Locked Devices'] as const;
export type Balance = { onHand: number; available: number; allocated: number };

export function stockAt(data: J, sku: string, location: string): Balance {
  const rows = (data?.ProductAvailabilityList || []).filter((r: J) => r.SKU === sku && r.Location === location);
  if (rows.some((r: J) => r.Batch || r.Bin) || rows.length > 1) throw new HttpError(400, `${sku} has batch or bin stock at ${location}. Change it in Cin7.`);
  const r = rows[0] || { OnHand: 0, Available: 0, Allocated: 0 };
  for (const k of ['OnHand', 'Available', 'Allocated']) if (!Number.isFinite(Number(r[k]))) throw new HttpError(400, 'Cin7 returned an invalid stock balance.');
  return { onHand: Number(r.OnHand), available: Number(r.Available), allocated: Number(r.Allocated) };
}

export function sameBalances(live: J, saved: J): boolean {
  return ['from', 'to'].every(side => ['onHand', 'available', 'allocated'].every(k =>
    typeof live?.[side]?.[k] === 'number' && Number.isFinite(live[side][k]) && live[side][k] === saved?.[side]?.[k]));
}

export function cin7ProductSummary(p: J): J {
  return { ID: p.ID, SKU: p.SKU, Name: p.Name, colour: String(p.AdditionalAttribute4 || ''), grade: String(p.AdditionalAttribute5 || '').trim().slice(0, 1) };
}

export function codePlan(source: J, target: J, from: Balance, to: Balance, location: string, quantity: number, device: boolean): J {
  if (!(CIN7_STOCK_LOCATIONS as readonly string[]).includes(location)) throw new HttpError(400, 'Choose the Cin7 location.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new HttpError(400, 'Enter a quantity from 1 to 500.');
  for (const p of [source, target]) {
    if (p?.Status !== 'Active' || p?.Type !== 'Stock' || p?.CostingMethod !== 'FIFO') throw new HttpError(400, `${p?.SKU || 'Product'} is not an active FIFO stock product in Cin7.`);
  }
  if (source.SKU === target.SKU) throw new HttpError(400, 'Choose a different product code.');
  if (![from.onHand, to.onHand].every(Number.isInteger) || to.onHand < 0) throw new HttpError(400, 'Unexpected stock quantity. Check Cin7 first.');
  if (from.onHand < quantity || from.available < quantity) {
    throw new HttpError(400, `Only ${Math.max(0, Math.min(from.onHand, from.available))} of ${source.SKU} available at ${location} (${from.allocated} allocated to orders).`);
  }
  const unitCost = Number(source.AverageCost);
  if (!Number.isFinite(unitCost) || unitCost <= 0) throw new HttpError(400, `${source.SKU} has no average cost in Cin7. Fix its cost first.`);
  const t = cin7ProductSummary(target);
  if (device && !/^[123]$/.test(t.grade)) throw new HttpError(400, `${target.SKU} has no grade 1–3 in Cin7 (Additional Attribute 5).`);
  return {
    source: cin7ProductSummary(source), target: t, from, to, location, quantity, unitCost: Math.round(unitCost * 10000) / 10000,
    after: { from: from.onHand - quantity, to: to.onHand + quantity },
  };
}

export function nzDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
}

export function adjustmentBody(change: J): J {
  const p = change.plan;
  const what = change.kind === 'device' ? `IMEI ${change.serial}` : `${p.quantity} unit${p.quantity === 1 ? '' : 's'}`;
  return {
    EffectiveDate: nzDateOf(change.created_at) + 'T00:00:00', Status: 'DRAFT', UpdateOnHand: true,
    Reference: 'Code change ' + change.id,
    Comment: `${what}; ${change.from_sku} → ${change.to_sku}; ${change.staff_name}; ${change.reason}`.slice(0, 256),
    Lines: [
      { ProductID: p.source.ID, SKU: p.source.SKU, Quantity: p.from.onHand - p.quantity, UnitCost: p.unitCost, Location: p.location },
      { ProductID: p.target.ID, SKU: p.target.SKU, Quantity: p.to.onHand + p.quantity, UnitCost: p.unitCost, Location: p.location },
    ],
  };
}

export function verifyAdjustment(result: J, change: J): void {
  const lines = [...(result?.ExistingStockLines || []), ...(result?.NewStockLines || [])];
  if (!result?.TaskID || lines.length !== 2 || result.Reference !== 'Code change ' + change.id) throw new HttpError(409, 'The Cin7 adjustment does not match this change. Review it in Cin7.');
  const p = change.plan;
  for (const [product, qty] of [[p.source, p.from.onHand - p.quantity], [p.target, p.to.onHand + p.quantity]] as const) {
    const l = lines.find((x: J) => x.ProductID === product.ID && x.Location === p.location);
    if (!l || Number(l.Adjustment ?? l.Quantity) !== qty) throw new HttpError(409, 'The Cin7 adjustment quantities do not match. Review it in Cin7.');
  }
}

// The purchase order confirms this IMEI was received (so the stock being moved really is this device).
export function poConfirmsDevice(purchase: J, serial: string): boolean {
  const received = purchase?.StockReceived;
  if (received?.Status !== 'AUTHORISED') return false;
  const deviceLines = (purchase?.Order?.Lines || []).filter((l: J) => String(l.Comment || '').includes(serial) || l.BatchSN === serial);
  return deviceLines.some((l: J) => (received.Lines || []).some((r: J) => r.SKU === l.SKU && r.Received && Number(r.Quantity) > 0));
}
