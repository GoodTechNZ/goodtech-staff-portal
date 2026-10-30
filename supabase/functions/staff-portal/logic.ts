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
  if (!colour || colour.length > 150 || colour.toUpperCase() === 'X') throw new HttpError(400, 'Enter the colour.');
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

// Actions that need the PIN again even though the person is signed in.
export function needsPin(module: string, action: string, body: J): boolean {
  if (module === 'grading' && action === 'save') return !!uuidOrNull(body.recordId);
  if (module === 'shipping') return ['override', 'save_settings'].includes(action);
  if (module === 'sales') return ['invoice', 'void'].includes(action);
  if (module === 'admin') return action !== 'staff' && action !== 'terminals';
  return false;
}

// A completed device/order ends the session so the next person must badge in.
export function completesWork(module: string, action: string, result: J): boolean {
  if (module === 'grading') return ['save', 'link'].includes(action) && result?.ok === true;
  if (module === 'shipping') return ['ship', 'pickup_ready', 'collect'].includes(action) && result?.ok === true;
  if (module === 'sales') return action === 'ship' && !result?.error && result?.order?.stage === 'shipped';
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
