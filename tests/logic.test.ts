import { describe, it, expect } from 'vitest';
import {
  gradingRecord, needsPin, bridgeBody, discountedLines, nzDate, validSerial, GRADING_TESTS, HttpError, pickRequest, cin7ErrorText,
} from '../supabase/functions/staff-portal/logic.ts';

const allPass = Object.fromEntries(GRADING_TESTS.map(t => [t, 'Pass']));

describe('gradingRecord', () => {
  it('takes the tester and date from the session, not the terminal', () => {
    const r = gradingRecord({ grade: '2', colour: 'Black', destination: 'Ready For Sale', tests: allPass, tester: 'Someone else', date: '2020-01-01' }, 'Crystal', '2026-10-30');
    expect(r.tester).toBe('Crystal');
    expect(r.date).toBe('2026-10-30');
    expect(r.location).toBe('Cabinet');
  });
  it('maps Repairs and Locked to their own location', () => {
    expect(gradingRecord({ grade: '3', colour: 'Blue', destination: 'Repairs', tests: { ...allPass, Display: 'Fail' }, status: 'Cracked' }, 'Li', '2026-10-30').location).toBe('Repairs');
    expect(gradingRecord({ grade: '3', colour: 'Blue', destination: 'Locked', tests: allPass }, 'Li', '2026-10-30').location).toBe('Locked');
  });
  it('requires device status when a test fails', () => {
    expect(() => gradingRecord({ grade: '3', colour: 'Blue', destination: 'Repairs', tests: { ...allPass, Speakers: 'Fail' } }, 'Li', '2026-10-30')).toThrow(/Device status/);
  });
  it('rejects missing tests, bad battery and placeholder colour', () => {
    expect(() => gradingRecord({ grade: '1', colour: 'Black', destination: 'Ready For Sale', tests: {} }, 'Li', 'd')).toThrow(HttpError);
    expect(() => gradingRecord({ grade: '1', colour: 'Black', destination: 'Ready For Sale', tests: allPass, battery: '101' }, 'Li', 'd')).toThrow(/Battery/);
    expect(() => gradingRecord({ grade: '1', colour: 'x', destination: 'Ready For Sale', tests: allPass }, 'Li', 'd')).toThrow(/colour/);
    expect(() => gradingRecord({ grade: '1', colour: '#N/A', destination: 'Ready For Sale', tests: allPass }, 'Li', 'd')).toThrow(/colour/);
    expect(() => gradingRecord({ grade: '4', colour: 'Black', destination: 'Ready For Sale', tests: allPass }, 'Li', 'd')).toThrow(/grade/);
  });
});

describe('needsPin', () => {
  it('asks again only for sensitive actions', () => {
    expect(needsPin('grading', 'save', {})).toBe(false);
    expect(needsPin('grading', 'save', { recordId: '6ca9a746-6aeb-406d-9c7f-27ee24aed081' })).toBe(true);
    expect(needsPin('grading', 'link', { recordId: '6ca9a746-6aeb-406d-9c7f-27ee24aed081' })).toBe(false);
    expect(needsPin('shipping', 'scan', {})).toBe(false);
    expect(needsPin('shipping', 'override', {})).toBe(true);
    expect(needsPin('sales', 'invoice', {})).toBe(true);
    expect(needsPin('sales', 'void', {})).toBe(true);
    expect(needsPin('sales', 'create', {})).toBe(false);
    expect(needsPin('admin', 'staff', {})).toBe(false);
    expect(needsPin('admin', 'reset_pin', {})).toBe(true);
  });
});

describe('bridgeBody', () => {
  it('always sends the signed-in staff and only allowed fields', () => {
    const b = bridgeBody('shipping', 'scan', { imei: '123', staff: 'Mallory', owner: 'x', pin: '1111', salesOrderNumber: 'SO1' }, { id: 'abc', name: 'David' });
    expect(b).toEqual({ action: 'scan', staff: 'David', owner: 'abc', imei: '123', salesOrderNumber: 'SO1' });
  });
});

describe('helpers', () => {
  it('counts lines sold below catalogue price', () => {
    expect(discountedLines({ lines: [{ price: 100, catalogue_price: 120 }, { price: 50, catalogue_price: 50 }, { price: 0, catalogue_price: 10 }] })).toBe(2);
    expect(discountedLines(undefined)).toBe(0);
  });
  it('uses the New Zealand calendar date', () => {
    expect(nzDate(new Date('2026-10-30T11:30:00Z'))).toBe('2026-10-31');
  });
  it('validates serials', () => {
    expect(validSerial(' 353911108940264 ')).toBe('353911108940264');
    expect(() => validSerial('12')).toThrow();
    expect(() => validSerial("1;drop")).toThrow();
  });
});

describe('pickRequest', () => {
  it('authorises every order line from the sale location, keeping non-inventory add-ons', () => {
    const r = pickRequest('t1', 'Ready For Sale', [
      { ProductID: 'p1', SKU: 'PH12128BU-1', Name: 'iPhone 12', Quantity: 1, NonInventory: false },
      { ProductID: 'p2', SKU: 'ACSCNPRFTPH', Name: 'Screen protector', Quantity: 1, NonInventory: true },
      { ProductID: 'p3', SKU: 'ZERO', Name: 'Nothing', Quantity: 0 },
    ]);
    expect(r).toEqual({ TaskID: 't1', Status: 'AUTHORISED', Lines: [
      { ProductID: 'p1', SKU: 'PH12128BU-1', Name: 'iPhone 12', Location: 'Ready For Sale', Quantity: 1, NonInventory: false },
      { ProductID: 'p2', SKU: 'ACSCNPRFTPH', Name: 'Screen protector', Location: 'Ready For Sale', Quantity: 1, NonInventory: true },
    ] });
  });
  it('refuses an order with nothing to pick', () => {
    expect(() => pickRequest('t1', 'Ready For Sale', [])).toThrow(HttpError);
    expect(() => pickRequest('t1', '', [{ ProductID: 'p', Quantity: 1 }])).toThrow(HttpError);
  });
  it('reads Cin7 error arrays', () => {
    expect(cin7ErrorText([{ ErrorCode: 400, Exception: 'Not enough stock' }], 400)).toBe('Not enough stock');
    expect(cin7ErrorText(null, 503)).toBe('Cin7 request failed (HTTP 503).');
  });
});
