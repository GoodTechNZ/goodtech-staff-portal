// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderSalesOps, dollars, pct, fmtTime, duration } from '../src/screens/salesops.ts';

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
    sales: { deviceUnits: 210, otherUnits: 95, revenue: 125000.5, gp: 31000, gpPct: 25.1, revenueWithoutCost: 900, grossDeviceUnits: 218, returnedDevices: 8, grossRevenue: 129300.5, returnedCredit: 4300 },
    topModels: [{ model: 'iPhone 13 128GB', units: 19, revenue: 11000, gp: 2900, gpPct: 26.4 }],
    channels: [{ name: 'Website', units: 120, revenue: 80000, gp: 20000, gpPct: 25 }],
    staff: [{ name: 'Crystal', units: 40, revenue: 20000, gp: 5000, gpPct: 25 }],
    returns: { count: 12, credits: 9, creditValue: 4300, deviceReturns: 8, rate: 3.8, reasons: [{ reason: 'Change of mind mentioned', count: 5 }] },
    shipped: { orders: 60, devices: 64, staff: [{ name: 'Tristan', orders: 30, devices: 31 }] },
    tested: { devices: 140, staff: [{ name: 'Crystal', devices: 80 }] },
    email: { replies: 153, threads: 84, medianMinutes: 135, staff: [{ name: 'Tristan', replies: 51, threads: 36, medianMinutes: 68 }, { name: 'Unsigned', replies: 26, threads: 24, medianMinutes: null }],
      open: { total: 47, under24h: 10, days1to3: 12, days3to14: 25, older: 59, otherSenders: 83 }, longestWaiting: [{ subject: 'Re: SO67025', hours: 329 }], syncedAt: '2026-11-11T17:49:59Z' },
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
    expect(text).toContain('Sales (net of returns)');
    expect(text).toContain('218 sold − 8 returned');
    expect(text).toContain('$129,301 − $4,300 credited');
    expect(text).toContain('8 devices vs 218 sold');
    expect(text).toContain('Email');
    expect(text).toContain('153');
    expect(text).toContain('2 h 15 m');
    expect(text).toContain('10 under 24 h · 12 1–3 days · 25 3–14 days');
    expect(text).toContain('Not signed');
    expect(text).toContain('Re: SO67025');
    expect(text).toContain('13 d 17 h');
    expect(text).toContain('83 from suppliers');
    expect(text).toContain('iPhone SE (3rd Gen) 64GB');
    expect(text).toContain('2026-11-05 – 2026-11-11');
  });
  it('says when a period is empty', () => {
    const el = document.createElement('div');
    el.append(...renderSalesOps({ from: '2026-11-11', to: '2026-11-11', sales: { deviceUnits: 0 }, returns: {}, topModels: [], channels: [] }));
    expect(el.textContent).toContain('Nothing in this period.');
  });
});

describe('fmtTime', () => {
  it('shows Cin7 NZ-local times as they are and zoned times in NZ time', () => {
    expect(fmtTime('2026-11-11T14:00:47.103')).toBe('11 Nov 14:00');
    expect(fmtTime('2026-11-11T01:03:23.059867+00:00')).toBe('11 Nov 14:03');
    expect(fmtTime('2026-06-11T01:03:23Z')).toBe('11 Jun 13:03');
    expect(fmtTime(null)).toBe('—');
  });
});

describe('duration', () => {
  it('formats minutes', () => {
    expect(duration(14)).toBe('14 min');
    expect(duration(60)).toBe('1 h');
    expect(duration(135)).toBe('2 h 15 m');
    expect(duration(993)).toBe('16 h 33 m');
    expect(duration(329 * 60)).toBe('13 d 17 h');
    expect(duration(null)).toBe('—');
  });
});
