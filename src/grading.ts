// Grading form rules shared by the screen and tests. The gateway and database repeat these
// checks; this copy only gives instant feedback on the terminal.

export const TESTS = [
  'Display', 'Touchscreen', 'Front camera', 'Rear cameras', 'Microphone', 'Speakers',
  'Buttons', 'Charging', 'Wi-Fi', 'Bluetooth', 'Mobile network', 'Biometrics',
] as const;
export type TestName = typeof TESTS[number];
export type TestResult = 'Pass' | 'Fail' | 'Not applicable';
export const DESTINATIONS = ['Ready For Sale', 'Repairs', 'Locked'] as const;
export type Destination = typeof DESTINATIONS[number];
export type Grade = '1' | '2' | '3';

export type GradingForm = {
  grade: Grade | '';
  colour: string;
  battery: string;
  tests: Partial<Record<TestName, TestResult>>;
  status: string;
  notes: string;
  destination: Destination | '';
};

export function emptyForm(colour = ''): GradingForm {
  return { grade: '', colour, battery: '', tests: {}, status: '', notes: '', destination: '' };
}

/** Prefill from an existing record, leaving the grade for the tester to decide. */
export function formFromRecord(record: Record<string, any>, deviceColour: string): GradingForm {
  const tests: GradingForm['tests'] = {};
  for (const t of TESTS) {
    const v = record?.tests?.[t];
    if (v === 'Pass' || v === 'Fail' || v === 'Not applicable') tests[t] = v;
  }
  const dest = (DESTINATIONS as readonly string[]).includes(record?.destination) ? record.destination as Destination : '';
  return {
    grade: '', colour: String(record?.colour || deviceColour || ''), battery: String(record?.battery ?? ''),
    tests, status: String(record?.status ?? ''), notes: String(record?.notes ?? ''), destination: dest,
  };
}

/** Supplier colours that mean "not listed". The database applies the same rule. */
export function cleanColour(v: string | null | undefined): string {
  const c = String(v ?? '').replace(/^[\s*]+/, '').trim();
  return ['X', '#N/A', 'N/A'].includes(c.toUpperCase()) ? '' : c;
}

/** The colour field is a typed input when the supplier didn't list one, or when the tester is
 *  overriding it (including an existing record whose colour differs from the supplier's). */
export function colourEditable(listed: string, colour: string): boolean {
  const l = cleanColour(listed);
  return !l || (!!colour.trim() && colour.trim().toLowerCase() !== l.toLowerCase());
}

/** Set when the saved colour differs from the supplier's listed colour, for the activity log. */
export function colourOverride(listed: string, colour: string): { from: string; to: string } | null {
  const l = cleanColour(listed), c = colour.trim();
  return l && c && l.toLowerCase() !== c.toLowerCase() ? { from: l, to: c } : null;
}

export function problems(f: GradingForm): string[] {
  const out: string[] = [];
  if (!f.grade) out.push('Select a grade.');
  if (!cleanColour(f.colour)) out.push('Enter the colour.');
  if (f.battery.trim() && (!/^\d{1,3}$/.test(f.battery.trim()) || Number(f.battery) > 100)) out.push('Battery must be 0–100.');
  const missing = TESTS.filter(t => !f.tests[t]);
  if (missing.length) out.push(`Record ${missing.length === 1 ? 'the ' + missing[0] + ' test' : missing.length + ' more tests'}.`);
  if (TESTS.some(t => f.tests[t] === 'Fail') && !f.status.trim()) out.push('Describe the fault in Device status.');
  if (!f.destination) out.push('Choose where the device goes.');
  return out;
}

/** Destination suggested from the tests: any failure goes to Repairs. */
export function suggestedDestination(f: GradingForm): Destination | '' {
  if (TESTS.some(t => f.tests[t] === 'Fail')) return 'Repairs';
  if (TESTS.every(t => f.tests[t])) return 'Ready For Sale';
  return '';
}

export type ExistingAction = 'save' | 'link' | 'update';

/** What the main button does: a new device saves; a device already in the sheet links when the
 *  tester's grade matches the sheet, otherwise updates the existing row (PIN required). */
export function primaryAction(existingRecordId: string | null, existingGrade: string, grade: string): ExistingAction {
  if (!existingRecordId) return 'save';
  return grade && grade === existingGrade ? 'link' : 'update';
}

export function payload(f: GradingForm) {
  return {
    grade: f.grade, colour: f.colour.trim(), battery: f.battery.trim(), tests: { ...f.tests },
    status: f.status.trim(), notes: f.notes.trim(), destination: f.destination,
  };
}
