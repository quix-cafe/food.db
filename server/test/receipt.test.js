import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReceipt } from '../src/services/receipt.js';

test('pydantic-style receipt (merchant, description, unit_price, total)', () => {
  const r = normalizeReceipt({
    merchant: 'Baldor', date: '2026-10-01', total: 12.5,
    items: [
      { description: 'Basil', quantity: 2, unit_price: 2.75, total: 5.5 },
      { description: 'Onions', quantity: null, unit_price: null, total: 7 },
    ],
  });
  assert.equal(r.vendor, 'Baldor');
  assert.equal(r.date, '2026-10-01');
  assert.deepEqual(r.items[0], { name: 'Basil', quantity: '2', unit: null, unitCost: '2.75', totalCost: '5.5' });
  assert.equal(r.items[1].quantity, '1');
  assert.equal(r.items[1].unitCost, '7');
  assert.deepEqual(r.warnings, []);
});

test('PascalCase receipt with string prices and a US date', () => {
  const r = normalizeReceipt({
    MerchantName: 'Costco', Date: '10/02/26', TotalAmount: '$40.00',
    Items: [{ Description: 'Olive oil', Price: '$33.49' }, { Price: 1 }],
  });
  assert.equal(r.vendor, 'Costco');
  assert.equal(r.date, '2026-10-02');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].totalCost, '33.49');
  assert.equal(r.warnings.length, 2); // skipped line + total mismatch
});

test('a bare list of items is accepted; bad shapes are rejected', () => {
  assert.equal(normalizeReceipt([{ name: 'Eggs', price: 4 }]).items.length, 1);
  assert.throws(() => normalizeReceipt('nope'));
  assert.throws(() => normalizeReceipt({ items: 'x' }));
});
