import { describe, it, expect } from 'vitest';
import { codePlan, adjustmentBody, verifyAdjustment, poConfirmsDevice, stockAt, sameBalances, HttpError } from '../supabase/functions/staff-portal/logic.ts';

const product = (SKU: string, extra: object = {}) => ({ ID: 'id-' + SKU, SKU, Name: SKU + ' name', Status: 'Active', Type: 'Stock', CostingMethod: 'FIFO', AverageCost: 300.12345, AdditionalAttribute4: 'Black', AdditionalAttribute5: '3 - Good', ...extra });
const bal = (onHand: number, allocated = 0) => ({ onHand, available: onHand - allocated, allocated });

describe('codePlan', () => {
  it('moves stock at the source average cost', () => {
    const p = codePlan(product('PH13256BK-2'), product('PH13256BK-3'), bal(4), bal(1), 'Ready For Sale', 2, false);
    expect(p.after).toEqual({ from: 2, to: 3 });
    expect(p.unitCost).toBe(300.1235);
    expect(p.target).toMatchObject({ SKU: 'PH13256BK-3', grade: '3', colour: 'Black' });
  });
  it('refuses stock that is allocated to orders', () => {
    expect(() => codePlan(product('A-1'), product('A-2'), bal(1, 1), bal(0), 'Ready For Sale', 1, true)).toThrow(/available/);
  });
  it('refuses more than is on hand, same SKU, non-FIFO and unknown locations', () => {
    expect(() => codePlan(product('A-1'), product('A-2'), bal(2), bal(0), 'Ready For Sale', 3, false)).toThrow(HttpError);
    expect(() => codePlan(product('A-1'), product('A-1'), bal(2), bal(0), 'Ready For Sale', 1, false)).toThrow(/different/);
    expect(() => codePlan(product('A-1'), product('A-2', { CostingMethod: 'FIFO - Batch' }), bal(2), bal(0), 'Ready For Sale', 1, false)).toThrow(/FIFO/);
    expect(() => codePlan(product('A-1'), product('A-2'), bal(2), bal(0), 'Office Use', 1, false)).toThrow(/location/);
  });
  it('needs a grade on the target for a device change', () => {
    expect(() => codePlan(product('A-1'), product('A-2', { AdditionalAttribute5: '' }), bal(1), bal(0), 'Repairs', 1, true)).toThrow(/grade/);
  });
});

describe('adjustment', () => {
  const change = { id: 'c1', kind: 'device', serial: '351', from_sku: 'A-1', to_sku: 'A-2', staff_name: 'Fraser', reason: 'Regraded', created_at: '2026-11-05T12:30:00Z',
    plan: codePlan(product('A-1'), product('A-2'), bal(1), bal(5), 'Repairs', 1, true) };
  it('sets new on-hand quantities on both SKUs, dated in NZ time', () => {
    const b = adjustmentBody(change);
    expect(b.EffectiveDate).toBe('2026-11-06T00:00:00');
    expect(b.Reference).toBe('Code change c1');
    expect(b.Lines).toEqual([
      { ProductID: 'id-A-1', SKU: 'A-1', Quantity: 0, UnitCost: 300.1235, Location: 'Repairs' },
      { ProductID: 'id-A-2', SKU: 'A-2', Quantity: 6, UnitCost: 300.1235, Location: 'Repairs' },
    ]);
  });
  it('verifies what Cin7 recorded', () => {
    const ok = { TaskID: 't', Reference: 'Code change c1', ExistingStockLines: [{ ProductID: 'id-A-1', Location: 'Repairs', Adjustment: 0 }, { ProductID: 'id-A-2', Location: 'Repairs', Adjustment: 6 }] };
    expect(() => verifyAdjustment(ok, change)).not.toThrow();
    expect(() => verifyAdjustment({ ...ok, Reference: 'other' }, change)).toThrow();
    expect(() => verifyAdjustment({ ...ok, ExistingStockLines: [ok.ExistingStockLines[0], { ProductID: 'id-A-2', Location: 'Repairs', Adjustment: 7 }] }, change)).toThrow();
  });
});

describe('Cin7 helpers', () => {
  it('reads one location balance and rejects batch stock', () => {
    const data = { ProductAvailabilityList: [{ SKU: 'A-1', Location: 'Repairs', OnHand: 3, Available: 2, Allocated: 1 }, { SKU: 'A-1', Location: 'Ready For Sale', OnHand: 9, Available: 9, Allocated: 0 }] };
    expect(stockAt(data, 'A-1', 'Repairs')).toEqual({ onHand: 3, available: 2, allocated: 1 });
    expect(stockAt(data, 'A-1', 'Locked Devices')).toEqual({ onHand: 0, available: 0, allocated: 0 });
    expect(() => stockAt({ ProductAvailabilityList: [{ SKU: 'A-1', Location: 'Repairs', OnHand: 1, Available: 1, Allocated: 0, Batch: 'B1' }] }, 'A-1', 'Repairs')).toThrow(/batch/);
  });
  it('compares balances field by field', () => {
    expect(sameBalances({ from: bal(1), to: bal(2) }, { from: bal(1), to: bal(2), extra: 1 })).toBe(true);
    expect(sameBalances({ from: bal(1), to: bal(3) }, { from: bal(1), to: bal(2) })).toBe(false);
  });
  it('needs the PO receipt to include the IMEI', () => {
    const po = { Order: { Lines: [{ SKU: 'A-1', Comment: 'IMEI 351906514559486' }] }, StockReceived: { Status: 'AUTHORISED', Lines: [{ SKU: 'A-1', Received: true, Quantity: 1 }] } };
    expect(poConfirmsDevice(po, '351906514559486')).toBe(true);
    expect(poConfirmsDevice(po, '359999999999999')).toBe(false);
    expect(poConfirmsDevice({ ...po, StockReceived: { ...po.StockReceived, Status: 'DRAFT' } }, '351906514559486')).toBe(false);
  });
});
