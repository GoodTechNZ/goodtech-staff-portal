// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const calls: { action: string; body: any }[] = [];
vi.mock('../src/api.ts', async orig => ({
  ...(await orig<any>()),
  call: vi.fn(async (action: string, body: any) => {
    calls.push({ action, body });
    if (action === 'stock.device') return { sku: 'PH13256BK-2', grade: '2', colour: 'Black', po: 'PO06787', location: 'Ready For Sale', problems: [], siblings: [{ sku: 'PH13256BK-1', name: 'iPhone 13 256GB Black – Like New' }, { sku: 'PH13256BK-3', name: 'iPhone 13 256GB Black – Good' }] };
    if (action === 'stock.preview') return { change: { id: 'c1', kind: 'device', reason: body.reason, plan: {
      quantity: 1, location: 'Ready For Sale', unitCost: 372.15, sheetRow: 36049, current: { grade: '2', colour: 'Black' },
      source: { SKU: 'PH13256BK-2', Name: 'iPhone 13 / 256GB / 2 - Very Good / Black' }, target: { SKU: 'PH13256BK-3', Name: 'iPhone 13 / 256GB / 3 - Good / Black', grade: '3', colour: 'Black' },
      from: { onHand: 4 }, to: { onHand: 2 }, after: { from: 3, to: 3 } } } };
    return {};
  }),
}));

const { deviceCodePanel } = await import('../src/screens/codechange.ts');
const flush = () => new Promise(r => setTimeout(r, 0));
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined;

describe('device code panel', () => {
  it('reviews a regrade before anything is sent to Cin7', async () => {
    const el = deviceCodePanel({ serial: '352941885309111', recordId: 'r1' }, () => {});
    document.body.replaceChildren(el);
    await flush(); await flush();
    expect(el.textContent).toContain('PH13256BK-2');
    const review = button(el, 'Review change')!;
    expect(review.disabled).toBe(true);
    button(el, 'PH13256BK-3')!.click();
    const reason = el.querySelector('textarea')!;
    reason.value = 'Scratches missed'; reason.dispatchEvent(new Event('input'));
    expect(review.disabled).toBe(false);
    review.click();
    await flush(); await flush();
    expect(calls.find(c => c.action === 'stock.preview')!.body).toMatchObject({ kind: 'device', serial: '352941885309111', recordId: 'r1', toSku: 'PH13256BK-3', location: 'Ready For Sale', reason: 'Scratches missed' });
    expect(el.textContent).toContain('grade 2 Black to grade 3 Black');
    expect(button(el, 'Confirm in Cin7')).toBeDefined();
    expect(calls.some(c => c.action === 'stock.commit')).toBe(false);
  });
});
