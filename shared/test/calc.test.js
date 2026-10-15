import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRecipe,
  summarizeEvent,
  lineCost,
  unitPrice,
  recommendedPrice,
  completePurchaseCosts,
  percentChange,
  toDecimal,
  CalcError,
} from '../src/calc.js';

test('price per unit divides the store pack price by its size', () => {
  assert.equal(unitPrice('112.75', '36').toFixed(4), '3.1319');
  assert.equal(unitPrice('2.50', null).toString(), '2.5'); // no pack size = 1
  assert.equal(lineCost('2.50', '3').toString(), '7.5');
});

test('no floating point drift', () => {
  assert.equal(lineCost('0.1', '3').toString(), '0.3');
});

test('recommended price at 70% margin', () => {
  assert.equal(recommendedPrice('3', 70).toString(), '10');
  assert.throws(() => recommendedPrice('3', 100), CalcError);
});

test('recipe scaling leaves base cost unchanged and scales cost/quantity', () => {
  const r = calculateRecipe({
    baseServings: 4,
    expectedServings: 10,
    targetMargin: 70,
    totalYield: 2,
    lines: [
      { name: 'Flour', packPrice: '20', packSize: '50', amount: '5' }, // 5 lb of a 50 lb bag = 2.00
      { name: 'Eggs', packPrice: '0.5', amount: '4' }, // 2.00
    ],
  });
  assert.equal(r.baseCost, '4.0000');
  assert.equal(r.scale, '2.5');
  assert.equal(r.scaledCost, '10.0000');
  assert.equal(r.costPerServing, '1.0000');
  assert.equal(r.recommendedPrice, '3.33');
  assert.equal(r.profitPerServing, '2.33');
  assert.equal(r.revenue, '33.30');
  assert.equal(r.profit, '23.30');
  assert.equal(r.scaledYield, '5');
  assert.equal(r.lines[0].unitPrice, '0.4000');
  assert.equal(r.lines[0].scaledAmount, '12.5000');
});

test('missing prices cost zero and warn', () => {
  const r = calculateRecipe({ baseServings: 1, lines: [{ name: 'Saffron', packPrice: null, amount: 1 }] });
  assert.equal(r.baseCost, '0.0000');
  assert.equal(r.lines[0].missingPrice, true);
  assert.equal(r.warnings.length, 1);
});

test('invalid inputs throw CalcError', () => {
  assert.throws(() => calculateRecipe({ baseServings: 0 }), CalcError);
  assert.throws(() => calculateRecipe({ baseServings: 1, lines: [{ packPrice: 1, amount: -5 }] }), CalcError);
});

test('event shopping list sums amounts per ingredient and rounds up to whole packs', () => {
  const flour = { ingredientId: 'f', name: 'Flour', uom: 'lb', packPrice: '20', packSize: '50' };
  const s = summarizeEvent([
    { recipeId: 'a', name: 'Bread', baseServings: 10, expectedServings: 20, targetMargin: 70,
      lines: [{ ...flour, amount: '25' }] },
    { recipeId: 'b', name: 'Pasta', baseServings: 4, expectedServings: 4, targetMargin: 50,
      lines: [{ ...flour, amount: '5' }] },
  ]);
  assert.equal(s.shoppingList.length, 1);
  const line = s.shoppingList[0];
  assert.equal(line.amount, '55.0000'); // 25×2 + 5×1 lb
  assert.equal(line.packsToBuy, '2'); // 55 lb in 50 lb bags
  assert.equal(line.uom, 'lb');
  assert.equal(line.usedCost, '22.0000'); // 55 × 0.40
  assert.equal(line.purchaseCost, '40.0000'); // two whole $20 bags
  assert.equal(s.purchaseCost, '40.0000');
  assert.deepEqual(line.recipes, ['Bread', 'Pasta']);
  assert.equal(s.totalCost, '22.0000');
});

test('purchase cost completion', () => {
  assert.deepEqual(completePurchaseCosts({ quantity: 4, totalCost: '10' }), { unitCost: '2.5000', totalCost: '10.0000' });
  assert.deepEqual(completePurchaseCosts({ quantity: 3, unitCost: '1.1' }), { unitCost: '1.1000', totalCost: '3.3000' });
  assert.throws(() => completePurchaseCosts({ quantity: 0, unitCost: 1 }), CalcError);
});

test('helpers', () => {
  assert.equal(percentChange('10', '12').toString(), '20');
  assert.equal(percentChange('0', '12'), null);
  assert.equal(toDecimal('abc'), null);
  assert.equal(toDecimal(''), null);
});

test('amounts above one pack multiply the cost', () => {
  const r = calculateRecipe({ lines: [{ packPrice: '3', packSize: '1', amount: '2.5' }], baseServings: 1 });
  assert.equal(r.baseCost, '7.5000');
});

test('labor is recognised by category or name and listed last', async () => {
  const { isLabor, laborLast } = await import('../src/calc.js');
  assert.equal(isLabor({ name: 'Prep', category: 'Labor' }), true);
  assert.equal(isLabor({ name: 'labour' }), true);
  assert.equal(isLabor({ name: 'Flour', category: 'Dry goods' }), false);
  assert.deepEqual(laborLast([{ name: 'Labor' }, { name: 'B' }, { name: 'A' }]).map((x) => x.name), ['B', 'A', 'Labor']);
  const s = summarizeEvent([{ recipeId: 'a', name: 'R', baseServings: 1, expectedServings: 1, lines: [
    { ingredientId: 'l', name: 'Aaa labor', category: 'Labor', packPrice: '20', amount: '1' },
    { ingredientId: 'z', name: 'Zest', packPrice: '1', amount: '1' },
  ] }]);
  assert.deepEqual(s.shoppingList.map((l) => l.name), ['Zest', 'Aaa labor']);
});
