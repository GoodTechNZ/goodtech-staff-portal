// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: { action: string; body: any }[] = [];
let lookupDevice: any = {};
let lookupExtra: any = {};
vi.mock('../src/api.ts', async orig => ({
  ...(await orig<any>()),
  call: vi.fn(async (action: string, body: any) => {
    calls.push({ action, body });
    if (action === 'grading.recent') return { jobs: [] };
    if (action === 'grading.lookup') return { device: { serial: body.serial, recordId: null, version: '0', row: null, model: 'Phone', ...lookupDevice }, record: {}, sync: 'synced', ...lookupExtra };
    return { ok: true };
  }),
}));

const { gradingScreen } = await import('../src/screens/grading.ts');
const flush = () => new Promise(r => setTimeout(r, 0));

async function open(device: any, extra: any = {}) {
  lookupDevice = device; lookupExtra = extra;
  const el = gradingScreen({ completed: vi.fn() } as any);
  document.body.replaceChildren(el);
  const scan = el.querySelector('input.scan') as HTMLInputElement;
  scan.value = '350321561180684';
  scan.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await flush(); await flush();
  return el;
}
const problemsText = (el: HTMLElement) => el.querySelector('.problems')!.textContent || '';
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined;

describe('grading screen colour', () => {
  beforeEach(() => { calls.length = 0; });

  it('uses the listed colour without asking', async () => {
    const el = await open({ colour: 'Midnight', listedColour: 'Midnight' });
    expect(el.querySelector('.colour-listed strong')!.textContent).toBe('Midnight');
    expect(el.querySelector('input[aria-label="Colour"]')).toBeNull();
    expect(problemsText(el)).not.toContain('colour');
  });

  it('asks for the colour when the supplier lists X', async () => {
    const el = await open({ colour: '', listedColour: '' });
    expect(el.querySelector('input[aria-label="Colour"]')).not.toBeNull();
    expect(problemsText(el)).toContain('Enter the colour.');
  });

  it('lets the tester override and go back to the listed colour', async () => {
    const el = await open({ colour: 'White', listedColour: 'White' });
    button(el, 'Change')!.click();
    const input = el.querySelector('input[aria-label="Colour"]') as HTMLInputElement;
    expect(input.value).toBe('White');
    input.value = 'Black'; input.dispatchEvent(new Event('input'));
    expect(el.textContent).toContain('Supplier lists White.');
    button(el, 'Use supplier colour')!.click();
    expect(el.querySelector('.colour-listed strong')!.textContent).toBe('White');
  });
});

describe('already graded devices', () => {
  beforeEach(() => { calls.length = 0; });
  const graded = {
    graded: true, canMove: true,
    record: { grade: '2', colour: 'Black', tester: 'Haobin', date: '2026-11-04', location: 'Cabinet', destination: 'Ready For Sale', status: '', notes: '', tests: {} },
    sheet: { row: 36049, grade: '2', colour: 'Black', status: null, location: 'Cabinet', tester: 'Haobin', productCode: 'PH13256BK-2' },
  };

  it('shows no grading form and offers a move instead', async () => {
    const el = await open({ recordId: 'r1', version: '3', row: 36049 }, graded);
    expect(el.textContent).toContain("It can't be graded again.");
    expect(el.querySelector('.problems')).toBeNull();
    expect(button(el, 'Grade 1')).toBeUndefined();
    expect(button(el, 'Save changes')!.disabled).toBe(true);
  });

  it('moves the device without changing the grade', async () => {
    const el = await open({ recordId: 'r1', version: '3', row: 36049 }, graded);
    button(el, 'Repairs')!.click();
    const move = button(el, 'Move to Repairs')!;
    expect(move.disabled).toBe(false);
    move.click();
    await flush(); await flush();
    const sent = calls.find(c => c.action === 'grading.move')!;
    expect(sent.body).toMatchObject({ serial: '350321561180684', recordId: 'r1', version: '3', destination: 'Repairs' });
    expect(sent.body.moveId).toBeTruthy();
    expect(sent.body.grade).toBeUndefined();
  });

  it('explains when a sheet-only row cannot be moved yet', async () => {
    const el = await open({ recordId: null }, { ...graded, canMove: false, record: {} });
    expect(el.textContent).toContain('hasn’t loaded that row yet');
    expect(button(el, 'Save changes')).toBeUndefined();
  });
});

describe('product-code change button', () => {
  const graded = {
    graded: true, canMove: true,
    record: { grade: '2', colour: 'Black', tester: 'Haobin', date: '2026-11-04', location: 'Cabinet', destination: 'Ready For Sale', status: '', notes: '', tests: {} },
    sheet: { row: 36049, grade: '2', colour: 'Black', status: null, location: 'Cabinet', tester: 'Haobin', productCode: 'PH13256BK-2' },
  };
  it('is offered to managers only', async () => {
    const { auth } = await import('../src/api.ts');
    auth.staff = { id: 's1', name: 'Crystal', role: 'staff' };
    let el = await open({ recordId: 'r1', version: '3', row: 36049 }, graded);
    expect(button(el, 'Change product code')).toBeUndefined();
    expect(el.textContent).toContain('ask a manager');
    auth.staff = { id: 's2', name: 'Fraser', role: 'manager' };
    el = await open({ recordId: 'r1', version: '3', row: 36049 }, graded);
    expect(button(el, 'Change product code')).toBeDefined();
  });
});
