// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ScanDetector, renderSalesOps, dollars, pct } from '../src/screens/salesops.ts';

describe('ScanDetector', () => {
  it('spots a scanner burst ending in Enter', () => {
    const d = new ScanDetector();
    let t = 1000;
    for (const k of 'GT00123') d.key(k, (t += 8));
    expect(d.key('Enter', (t += 8))).toBe(true);
  });
  it('ignores normal typing and short bursts', () => {
    const d = new ScanDetector();
    let t = 1000;
    for (const k of 'iphone13') d.key(k, (t += 120));
    expect(d.key('Enter', (t += 120))).toBe(false);
    for (const k of '1234') d.key(k, (t += 8));
    expect(d.key('Enter', (t += 8))).toBe(false);
  });
});

describe('formatting', () => {
  it('formats dollars and percentages', () => {
    expect(dollars(127634.97)).toBe('$127,635');
    expect(dollars(-50)).toBe('−$50');
    expect(dollars(null)).toBe('—');
    expect(pct(24.52)).toBe('24.5%');
  });
});

describe('renderSalesOps', () => {
  const data = {
    period: '7d', from: '2026-11-05', to: '2026-11-11',
    sales: { deviceUnits: 210, otherUnits: 95, revenue: 125000.5, gp: 31000, gpPct: 25.1, revenueWithoutCost: 900 },
    topModels: [{ model: 'iPhone 13 128GB', units: 19, revenue: 11000, gp: 2900, gpPct: 26.4 }],
    channels: [{ name: 'Website', units: 120, revenue: 80000, gp: 20000, gpPct: 25 }],
    staff: [{ name: 'Crystal', units: 40, revenue: 20000, gp: 5000, gpPct: 25 }],
    returns: { count: 12, credits: 9, creditValue: 4300, deviceReturns: 8, rate: 3.8, reasons: [{ reason: 'Change of mind mentioned', count: 5 }] },
    shipped: { orders: 60, devices: 64, staff: [{ name: 'Tristan', orders: 30, devices: 31 }] },
    tested: { devices: 140, staff: [{ name: 'Crystal', devices: 80 }] },
    lowStock: [{ model: 'iPhone SE (3rd Gen)', gb: 64, rfs: 2, sold30d: 19, wocRfs: 0.5, action: 'BUY' }],
    freshness: { sales: '2026-11-11T13:19:05', returns: '2026-11-11T13:00:00', stock: '2026-11-11T07:10:00' },
  };
  it('shows every section with the numbers', () => {
    const el = document.createElement('div');
    el.append(...renderSalesOps(data));
    const text = el.textContent!;
    for (const s of ['Sales', 'Top 10 models', 'Channels', 'Staff sales', 'Returns', 'Orders shipped', 'Devices tested', 'Selling fast, low stock']) expect(text).toContain(s);
    expect(text).toContain('$125,001');
    expect(text).toContain('25.1%');
    expect(text).toContain('iPhone 13 128GB');
    expect(text).toContain('3.8%');
    expect(text).toContain('8 devices vs 210 sold');
    expect(text).toContain('iPhone SE (3rd Gen) 64GB');
    expect(text).toContain('2026-11-05 – 2026-11-11');
  });
  it('says when a period is empty', () => {
    const el = document.createElement('div');
    el.append(...renderSalesOps({ from: '2026-11-11', to: '2026-11-11', sales: { deviceUnits: 0 }, returns: {}, topModels: [], channels: [] }));
    expect(el.textContent).toContain('Nothing in this period.');
  });
});
