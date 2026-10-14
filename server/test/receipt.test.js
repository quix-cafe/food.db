import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeReceipt } from '../src/services/receipt.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../tests/${name}`, import.meta.url), 'utf8'));
const byName = (r, name) => r.items.filter((i) => i.name === name);

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
  assert.deepEqual(r.items[0], { name: 'Basil', category: null, quantity: '2', unit: null, unitCost: '2.75', totalCost: '5.5', note: null });
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

test('tests/receipt1.json: sections map, discount and PRICE YOU PAY lines, weighed produce', () => {
  const r = normalizeReceipt(fixture('receipt1.json'));
  assert.equal(r.vendor, 'Weis Markets #49');
  assert.equal(r.date, null);
  assert.equal(r.items.length, 12);
  assert.deepEqual(r.warnings, []);

  const [coke] = byName(r, 'CLASSIC COKE 24PK PC');
  assert.equal(coke.category, 'Grocery');
  assert.equal(coke.totalCost, '12.99'); // 13.99 − 1.00, confirmed by PRICE YOU PAY
  assert.match(coke.note, /\$1\.00 off \(COKE 24 PKG\)/);

  const [turkey] = byName(r, 'PK TURK BRST CUTLE');
  assert.equal(turkey.totalCost, '6.19'); // 8.25 − 2.06 markdown
  assert.equal(turkey.category, 'Meat');

  assert.deepEqual(byName(r, '4011 BANANAS')[0], {
    name: '4011 BANANAS', category: 'Produce', quantity: '2.21', unit: 'lb', unitCost: '0.59', totalCost: '1.3', note: null,
  });

  const eggo = byName(r, 'EGGO MINI PANCK');
  assert.equal(eggo.length, 1);
  assert.equal(eggo[0].quantity, '4');
  assert.equal(eggo[0].unitCost, '3.69');
  assert.equal(eggo[0].totalCost, '14.76');
  assert.equal(eggo[0].category, 'Frozen Food');

  assert.ok(!r.items.some((i) => /PRICE YOU PAY|COKE 24 PKG|MARKDOWN/.test(i.name)));
});

test('tests/receipt2.json: grouped entries, coupon, quantity detail, subtotal reconciles', () => {
  const r = normalizeReceipt(fixture('receipt2.json'));
  assert.equal(r.vendor, 'Target');
  assert.equal(r.date, '2016-03-06');
  assert.equal(r.totalLabel, 'subtotal');
  assert.equal(r.printedTotal, '246.00');
  // Lines reconcile to the subtotal exactly; only the order-level RedCard saving is flagged.
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /\$11\.55.*redcard_savings/);

  const sum = r.items.reduce((a, i) => a + Math.round(Number(i.totalCost) * 100), 0);
  assert.equal(sum, 24600);

  assert.deepEqual(byName(r, 'OREO COOKIE')[0], {
    name: 'OREO COOKIE', category: 'Grocery', quantity: '2', unit: 'ea', unitCost: '2.99', totalCost: '5.98', note: null,
  });
  const motts = byName(r, 'MOTTS FRTSN');
  assert.equal(motts.length, 2);
  assert.equal(motts[0].totalCost, '1'); // 1.50 − 0.50 Cartwheel coupon
  assert.match(motts[0].note, /Cartwheel MfrCpn/);
  assert.equal(motts[1].quantity, '3');

  assert.equal(byName(r, 'BREYERS')[0].quantity, '2');
  assert.equal(byName(r, 'BISSELL')[0].category, 'Home');
  assert.equal(byName(r, 'UPUP HOUSEH')[0].category, 'Cleaning Supplies');
  assert.ok(!r.items.some((i) => /Cartwheel|Saved/.test(i.name)));
});
