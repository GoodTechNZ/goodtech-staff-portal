// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/api.ts', () => ({ call: vi.fn(), ApiError: class extends Error {}, uuid: () => 'x', auth: { staff: null } }));
import { addOnsFor, addOnLabel } from '../src/screens/sales.ts';

const acc = (sku: string, name: string) => ({ id: sku, sku, name, price: 19.95, available: 0, serialRequired: false });
const ACCESSORIES = [
  acc('ACPHGELCASE', 'iPhone Clear Gel Case Add-on'), acc('ACPHGELCASEGP', 'Google Pixel Clear Gel Case Add-on Clear Silicone'),
  acc('ACPHGELCASEMS', 'iPhone Case - MagSafe - Clear Gel - Add-on'), acc('ACPHGELCASESG', 'Galaxy Clear Gel Case Add-on Clear Silicone'),
  acc('ACPHMSSLCASE', 'iPhone Case - MagSafe - Black Silicone - Add-on'), acc('ACSCNPRFTGP', 'Google Pixel Screen Protector - Tempered Glass - Fitted For You'),
  acc('ACSCNPRFTPD', 'iPad Screen Protector - Tempered Glass - Fitted For You'), acc('ACSCNPRFTPH', 'iPhone Screen Protector - Tempered Glass - Fitted For You'),
  acc('ACSCNPRFTSM', 'Galaxy S21/S22/23/24 Screen Protector - Tempered Glass - Fitted For You'), acc('PR174', 'Device Repairs'),
];
const skus = (name: string, model = '') => addOnsFor({ name, model }, ACCESSORIES).map(a => a.sku);

describe('sales add-ons', () => {
  it('matches the device family', () => {
    expect(skus('iPhone 14 128GB Midnight - Good')).toEqual(['ACSCNPRFTPH', 'ACPHGELCASE', 'ACPHGELCASEMS', 'ACPHMSSLCASE']);
    expect(skus('iPhone 11 64GB Black')).toEqual(['ACSCNPRFTPH', 'ACPHGELCASE']);
    expect(skus('iPhone SE (3rd Gen) 64GB')).toEqual(['ACSCNPRFTPH', 'ACPHGELCASE']);
    expect(skus('Google Pixel 8 128GB Obsidian')).toEqual(['ACSCNPRFTGP', 'ACPHGELCASEGP']);
    expect(skus('Samsung Galaxy S23 128GB')).toEqual(['ACPHGELCASESG', 'ACSCNPRFTSM']);
    expect(skus('Samsung Galaxy S25 Ultra 256GB')).toEqual(['ACPHGELCASESG']);
    expect(skus('iPad 9th Gen 64GB Wi-Fi')).toEqual(['ACSCNPRFTPD']);
    expect(skus('iPhone 16e 128GB White')).toEqual(['ACSCNPRFTPH', 'ACPHGELCASE']);
    expect(skus('iPhone Air 256GB Sky Blue')).toEqual(['ACSCNPRFTPH', 'ACPHGELCASE', 'ACPHGELCASEMS', 'ACPHMSSLCASE']);
    expect(skus('iPhone 17 Pro 256GB', 'iPhone 17 Pro')).toEqual(['ACSCNPRFTPH', 'ACPHGELCASE', 'ACPHGELCASEMS', 'ACPHMSSLCASE']);
    expect(skus('Samsung Galaxy Tab S8+ 128GB', 'Galaxy Tab S8+')).toEqual([]);
    expect(skus('Apple Watch Series 9 45mm')).toEqual([]);
  });
  it('labels them simply', () => {
    expect(ACCESSORIES.slice(0, 9).map(addOnLabel)).toEqual(['Clear gel case', 'Clear gel case', 'MagSafe clear case', 'Clear gel case', 'MagSafe black silicone case', 'Screen protector', 'Screen protector', 'Screen protector', 'Screen protector']);
  });
});

describe('sales pick list', () => {
  it('groups lines by SKU and fills in scanned IMEIs', async () => {
    const { pickListPage } = await import('../src/screens/sales.ts');
    const page = pickListPage({ number: 'SO67500', staff: 'Li', customer: { name: 'Sam Test', phone: '021 000' }, memo: 'Gift wrap',
      lines: [{ sku: 'PH14128BK-2', name: 'iPhone 14 128GB Black', imei: '356442166605598' }, { sku: 'ACSCNPRFTPH', name: 'iPhone Screen Protector' }, { sku: 'ACSCNPRFTPH', name: 'iPhone Screen Protector' }] }, new Date('2026-11-14T01:00:00Z'));
    const rows = [...page.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(td => td.textContent));
    expect(rows).toEqual([['☐', '1', 'PH14128BK-2', 'iPhone 14 128GB Black', '356442166605598'], ['☐', '2', 'ACSCNPRFTPH', 'iPhone Screen Protector', '']]);
    expect(page.querySelector('.pick-so')?.textContent).toBe('SO67500');
    expect(page.textContent).toContain('Note: Gift wrap');
  });
});
