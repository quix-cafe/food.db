import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRecipe,
  summarizeEvent,
  lineCost,
  recommendedPrice,
  completePurchaseCosts,
  percentChange,
  toDecimal,
  CalcError,
} from '../src/calc.js';

test('line cost applies use percent (5% of a bulk item costs 5%)', () => {
  assert.equal(lineCost('40', '5', '1').toString(), '2');
  assert.equal(lineCost('2.50', '100', '3').toString(), '7.5');
});

test('no floating point drift', () => {
  assert.equal(lineCost('0.1', '100', '3').toString(), '0.3');
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
      { name: 'Flour', unitCost: '20', usePercent: '10', baseQuantity: '1' }, // 2.00
      { name: 'Eggs', unitCost: '0.5', usePercent: '100', baseQuantity: '4' }, // 2.00
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
  assert.equal(r.lines[1].scaledQuantity, '10.0000');
  assert.equal(r.lines[0].scaledUsage, '0.2500');
});

test('missing prices cost zero and warn', () => {
  const r = calculateRecipe({ baseServings: 1, lines: [{ name: 'Saffron', unitCost: null, baseQuantity: 1 }] });
  assert.equal(r.baseCost, '0.0000');
  assert.equal(r.lines[0].missingPrice, true);
  assert.equal(r.warnings.length, 1);
});

test('invalid inputs throw CalcError', () => {
  assert.throws(() => calculateRecipe({ baseServings: 0 }), CalcError);
  assert.throws(() => calculateRecipe({ baseServings: 1, lines: [{ unitCost: 1, usePercent: 120, baseQuantity: 1 }] }), CalcError);
});

test('event aggregates shopping list across recipes by ingredient and unit', () => {
  const flour = { ingredientId: 'f', name: 'Flour', unit: 'bag', unitCost: '20' };
  const s = summarizeEvent([
    { recipeId: 'a', name: 'Bread', baseServings: 10, expectedServings: 20, targetMargin: 70,
      lines: [{ ...flour, usePercent: '25', baseQuantity: '1' }] },
    { recipeId: 'b', name: 'Pasta', baseServings: 4, expectedServings: 4, targetMargin: 50,
      lines: [{ ...flour, usePercent: '10', baseQuantity: '1' }] },
  ]);
  assert.equal(s.shoppingList.length, 1);
  const line = s.shoppingList[0];
  assert.equal(line.quantity, '3.0000'); // 1×2 + 1×1
  assert.equal(line.usage, '0.6000'); // 0.5 + 0.1
  assert.equal(line.unitsToBuy, '1');
  assert.equal(line.estimatedCost, '12.0000');
  assert.deepEqual(line.recipes, ['Bread', 'Pasta']);
  assert.equal(s.totalCost, '12.0000');
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
