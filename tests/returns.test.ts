import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/api.ts', () => ({ callUrl: vi.fn(), call: vi.fn(), RETURNS_URL: 'x', ApiError: class extends Error {}, auth: { staff: null } }));
import { returnableLines, OUTCOME_LABEL, STATUS_LABEL } from '../src/screens/returns.ts';

describe('returns screen helpers', () => {
  it('offers every product line with a SKU', () => {
    const sale = { lines: [{ sku: 'PH16PR256BK-2', name: 'iPhone 16 Pro', qty: 1 }, { sku: '', name: 'Shipping', qty: 1 }, { sku: 'ACSCNPRFTPH', name: 'Screen protector', qty: 1 }] };
    expect(returnableLines(sale).map(l => l.sku)).toEqual(['PH16PR256BK-2', 'ACSCNPRFTPH']);
  });
  it('labels every outcome and status the server uses', () => {
    expect(Object.keys(OUTCOME_LABEL).sort()).toEqual(['refund', 'replacement', 'undecided', 'warranty']);
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(['cancelled', 'closed', 'label_sent', 'open', 'outbound', 'received']);
  });
});
