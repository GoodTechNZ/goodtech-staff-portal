// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: { action: string; body: any }[] = [];
let lookupDevice: any = {};
vi.mock('../src/api.ts', async orig => ({
  ...(await orig<any>()),
  call: vi.fn(async (action: string, body: any) => {
    calls.push({ action, body });
    if (action === 'grading.recent') return { jobs: [] };
    if (action === 'grading.lookup') return { device: { serial: body.serial, recordId: null, version: '0', row: null, model: 'Phone', ...lookupDevice }, record: {}, sync: 'synced' };
    return { ok: true };
  }),
}));

const { gradingScreen } = await import('../src/screens/grading.ts');
const flush = () => new Promise(r => setTimeout(r, 0));

async function open(device: any) {
  lookupDevice = device;
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
