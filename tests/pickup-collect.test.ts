import { describe, it, expect } from 'vitest';
// Loaded by path so the front-end type-check doesn't pull in the Deno edge function code.
const PICKUP = '../supabase/functions/staff-shipping/pickup-orders.ts';
const { fulfilledFor } = await import(/* @vite-ignore */ PICKUP) as { fulfilledFor: (o: any, sh: any) => string | null };

// #39585 / SO67433 as Shopify returned it after the Cin7 sync fulfilled it.
const sh = { order_name: '#39585', line_items: [{ sku: 'PH1164WT-3', quantity: 1 }] };
const order = (remaining: number, fulfilments: any[]) => ({
  fulfillmentOrders: { nodes: [{ status: remaining ? 'OPEN' : 'CLOSED', lineItems: { nodes: [{ remainingQuantity: remaining, lineItem: { sku: 'PH1164WT-3' } }], pageInfo: { hasNextPage: false } } }] },
  fulfillments: fulfilments,
});
const f = (id: string, sku = 'PH1164WT-3', quantity = 1, status = 'SUCCESS') =>
  ({ id, status, fulfillmentLineItems: { nodes: [{ quantity, lineItem: { sku } }], pageInfo: { hasNextPage: false } } });

describe('pickup collection when Shopify is already fulfilled', () => {
  it('adopts the fulfilment the Cin7 sync created', () => {
    expect(fulfilledFor(order(0, [f('gid://shopify/Fulfillment/7020557795417')]), sh)).toBe('gid://shopify/Fulfillment/7020557795417');
  });
  it('leaves anything still open or different for review', () => {
    expect(fulfilledFor(order(1, []), sh)).toBeNull();
    expect(fulfilledFor(order(0, []), sh)).toBeNull();
    expect(fulfilledFor(order(0, [f('x', 'PH1164BK-3')]), sh)).toBeNull();
    expect(fulfilledFor(order(0, [f('x', 'PH1164WT-3', 2)]), sh)).toBeNull();
    expect(fulfilledFor(order(0, [f('x', 'PH1164WT-3', 1, 'CANCELLED')]), sh)).toBeNull();
  });
});
