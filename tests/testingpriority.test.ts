// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderPriority, priorityRows } from '../src/screens/testingpriority.ts';

const d = {
  total: 106, tiers: { urgent: 30, high: 25, medium: 20, low: 31, urgentModels: 12 },
  bySo: [{ so: '1467573', n: 51 }, { so: '1466384', n: 13 }],
  rows: [
    { tier: 1, model: 'iPhone 13', gb: '128GB', untested: 21, testNow: 21, sold30: 68, rfs: 15, cover: 6.6, sos: { '1467573': 21 } },
    { tier: 2, model: 'iPhone 15', gb: '128GB', untested: 1, testNow: 1, sold30: 22, rfs: 7, cover: 9.5, sos: { '1466384': 1 } },
    { tier: 4, model: 'Galaxy S20 5G', gb: '128GB', untested: 3, testNow: 0, sold30: 0, rfs: 4, cover: null, sos: { '1466385': 3 } },
  ],
  asnSyncedAt: '2026-11-11T18:20:00Z', demandAt: '2026-11-11T18:40:00Z',
};

describe('testing priority', () => {
  it('filters by tier', () => {
    expect(priorityRows(d, 'urgent').map(r => r.model)).toEqual(['iPhone 13']);
    expect(priorityRows(d, 'high')).toHaveLength(2);
    expect(priorityRows(d, 'all')).toHaveLength(3);
  });
  it('shows the summary, test-now counts and SOs', () => {
    const el = document.createElement('div');
    el.append(...renderPriority(d, 'urgent', () => {}));
    const text = el.textContent!;
    expect(text).toContain('106 to test');
    expect(text).toContain('30 urgent (12 models)');
    expect(text).toContain('iPhone 13 128GB');
    expect(text).toContain('1467573×21');
    expect(text).not.toContain('iPhone 15');
    expect(text).toContain('1467573 (51)');
  });
  it('switches what is shown', () => {
    let chosen = '';
    const el = document.createElement('div');
    el.append(...renderPriority(d, 'urgent', s => { chosen = s; }));
    [...el.querySelectorAll('button')].find(b => b.textContent === 'All')!.click();
    expect(chosen).toBe('all');
  });
});
