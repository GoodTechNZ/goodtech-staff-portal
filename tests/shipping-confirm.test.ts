import { describe, it, expect } from 'vitest';
import { devicesToVerify, overrideReason } from '../src/screens/shipping.ts';

describe('unknown IMEI confirmation', () => {
  const products = [{ sku: 'PH14128BK-2', name: 'iPhone 14 128GB Black', quantity: 2 }, { sku: 'PH15128BU-1', name: 'iPhone 15 128GB Blue', quantity: 1 }];
  it('offers only products with devices still to scan', () => {
    expect(devicesToVerify(products, []).map(p => p.sku)).toEqual(['PH14128BK-2', 'PH15128BU-1']);
    expect(devicesToVerify(products, [{ scanned_sku: 'PH15128BU-1' }, { scanned_sku: 'PH14128BK-2' }]).map(p => p.sku)).toEqual(['PH14128BK-2']);
    expect(devicesToVerify(products, [{ scanned_sku: 'PH15128BU-1' }, { scanned_sku: 'PH14128BK-2' }, { scanned_sku: 'PH14128BK-2' }])).toEqual([]);
  });
  it('writes a reason long enough for staff-shipping', () => {
    expect(overrideReason(products[0]).length).toBeGreaterThanOrEqual(10);
    expect(overrideReason(products[0])).toContain('PH14128BK-2');
  });
});
