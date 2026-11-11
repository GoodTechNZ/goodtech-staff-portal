// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const calls: any[] = [];
vi.mock('../src/api.ts', () => ({
  call: async (action: string, body: any) => {
    calls.push({ action, body });
    return { links: { SO67212: 'https://inventory.dearsystems.com/Sale#abc~abc~tabOrder', '#39430': 'https://admin.shopify.com/store/goodtech/orders/7617373962329' } };
  },
}));

import { orderRef, isOrderRef } from '../src/orderlinks.ts';

describe('order links', () => {
  it('links SO and # numbers in one lookup and leaves other text alone', async () => {
    const a = orderRef('SO67212') as HTMLAnchorElement;
    const b = orderRef('#39430') as HTMLAnchorElement;
    const c = orderRef('SO99999') as HTMLAnchorElement;
    document.body.append(a, b, c);
    expect(orderRef('Order')).toBe('Order');
    expect(orderRef('1467573')).toBe('1467573');
    await new Promise(r => setTimeout(r, 60));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.refs.sort()).toEqual(['#39430', 'SO67212', 'SO99999']);
    expect(a.href).toBe('https://inventory.dearsystems.com/Sale#abc~abc~tabOrder');
    expect(b.href).toBe('https://admin.shopify.com/store/goodtech/orders/7617373962329');
    expect(b.target).toBe('_blank');
    expect(c.hasAttribute('href')).toBe(false);
    expect(isOrderRef('so67212')).toBe(true);
  });
});
