import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRecipe,
  summarizeEvent,
  eventPricing,
  eventServing,
  menuItemName,
  amountLabel,
  saleItem,
  anticipateEvent,
  sauceContainer,
  orderTimes,
  orderTimingSummary,
  lineCost,
  unitPrice,
  recommendedPrice,
  completePurchaseCosts,
  combinePurchases,
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
  assert.equal(line.leftover, '45.0000'); // 100 lb bought − 55 lb used
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

test('combinePurchases: one receipt\'s lines as one average pack', () => {
  // 2.3 lb for $9.20 and 1.7 lb for $7.65: $16.85 for 4 lb.
  assert.deepEqual(combinePurchases([
    { quantity: '1', packSize: '2.3', unitCost: '9.20', totalCost: '9.20' },
    { quantity: '1', packSize: '1.7', unitCost: '7.65', totalCost: '7.65' },
  ]), { quantity: '2.0000', packSize: '2.0000', unitCost: '8.4250', totalCost: '16.8500', unitPrice: '4.2125' });
  // Weighted by packs bought: 3 × 1 lb at $5 and 1 × 2 lb at $6 is $21 for 5 lb.
  const r = combinePurchases([
    { quantity: 3, packSize: 1, unitCost: 5, totalCost: 15 },
    { quantity: 1, packSize: 2, unitCost: 6, totalCost: 6 },
  ]);
  assert.equal(r.unitPrice, '4.2000');
  assert.equal(r.packSize, '1.2500');
  // One line is itself.
  assert.deepEqual(combinePurchases([{ quantity: 2, packSize: 50, unitCost: 20, totalCost: 40 }]),
    { quantity: '2.0000', packSize: '50.0000', unitCost: '20.0000', totalCost: '40.0000', unitPrice: '0.4000' });
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
  assert.deepEqual([s.recipes[0].scaledCost, s.recipes[0].laborCost], ['21.0000', '20.0000']); // labor's share, for Financials
});

test('an amount set for the event replaces the scaled total and adjusts the event cost', () => {
  const recipe = { recipeId: 'a', name: 'Cookies', baseServings: 48, expectedServings: 90, targetMargin: 70,
    lines: [{ ingredientId: 'l', name: 'Labor', category: 'Labor', uom: 'hours', packPrice: '20', packSize: '1', amount: '0.5' }] };
  const scaled = summarizeEvent([recipe]);
  assert.equal(scaled.shoppingList[0].amount, '0.9375');
  assert.equal(scaled.totalCost, '18.7500');
  const set = summarizeEvent([recipe], { l: '0.5' });
  const line = set.shoppingList[0];
  assert.equal(line.amount, '0.5000');
  assert.equal(line.calculatedAmount, '0.9375');
  assert.equal(line.amountSet, true);
  assert.equal(line.usedCost, '10.0000');
  assert.equal(line.packsToBuy, '1');
  assert.equal(set.adjustment, '-8.7500');
  assert.equal(set.totalCost, '10.0000');
  assert.equal(set.recipes[0].scaledCost, '18.7500'); // per-recipe figures stay as the recipes say
});

test('a serving set for one event: 3 tacos for $14 scales the cost, the food and the default price', () => {
  // 30 tacos for $30 and $4.50 each: a recipe's serving is one taco.
  const recipe = { recipeId: 'a', name: 'Chicken Taco', baseServings: 30, totalYield: '30', yieldUnit: 'tacos', targetPrice: '4.50', expectedServings: 20,
    lines: [{ ingredientId: 'c', name: 'Chicken', uom: 'lb', packPrice: '30', packSize: '10', amount: '10' }] };
  const r = summarizeEvent([{ ...recipe, servingSize: '3', salePrice: '14' }]);
  const [t] = r.recipes;
  // 20 servings are 60 tacos: 20 lb of chicken at $3, sold at $14 a serving.
  assert.deepEqual([t.expectedServings, t.costPerServing, t.salePrice, t.recommendedPrice, t.servingLabel], ['20', '3.0000', '14.00', '13.50', '3 tacos']);
  assert.deepEqual([t.scaledCost, t.revenue, t.profit, t.marginPerServing], ['60.0000', '280.00', '220.00', '11.0000']);
  assert.deepEqual([r.shoppingList[0].amount, r.shoppingList[0].packsToBuy], ['20.0000', '2']);
  assert.equal(menuItemName(t), 'Chicken Taco (3 tacos)');
  // No size: as before, and a deal still counts event servings.
  const plain = summarizeEvent([recipe]).recipes[0];
  assert.deepEqual([plain.costPerServing, plain.salePrice, plain.scaledCost, plain.servingLabel], ['1.0000', '4.50', '20.0000', null]);
  assert.equal(menuItemName(plain), 'Chicken Taco');
  assert.equal(summarizeEvent([{ ...recipe, servingSize: '3', salePrice: '14', discountAmount: '1', discountQty: 2 }]).recipes[0].revenue, '270.00');
});

test('a serving is measured in the recipe’s unit, against the recipe’s own size', () => {
  // Fuchka: 15 servings of 5 puff, so 10 puff are 2 of its servings.
  const fuchka = { baseServings: 15, totalYield: '75', yieldUnit: 'puff', costPerServing: '1.1650', recommendedPrice: '10.00' };
  const big = eventServing(fuchka, '10');
  assert.deepEqual([big.ratio.toString(), big.costPerServing, big.recommendedPrice, big.servingLabel], ['2', '2.3300', '20.00', '10 puff']);
  assert.deepEqual([eventServing(fuchka).ratio.toString(), eventServing(fuchka).recipeSize.toString(), eventServing(fuchka).servingLabel], ['1', '5', null]);
  // Nothing usable falls back to the recipe's size; without a total yield, the size is its servings.
  assert.equal(eventServing(fuchka, '0').ratio.toString(), '1');
  assert.equal(eventServing(fuchka, null).ratio.toString(), '1');
  const noYield = eventServing({ baseServings: 4, costPerServing: '1' }, '2');
  assert.deepEqual([noYield.ratio.toString(), noYield.unit, noYield.servingLabel], ['2', 'servings', '2 servings']);
  assert.equal(amountLabel(1, 'tacos'), '1 taco');
  assert.equal(amountLabel('1.5', 'tacos'), '1.5 tacos');
  assert.equal(amountLabel(1, 'glass'), '1 glass');
});

test('an event price replaces the recipe price, and a deal comes off every N servings', () => {
  // Cost $1.20 a serving at 70% margin: the recipe sells for $4.00.
  const recipe = { recipeId: 'a', name: 'Tacos', baseServings: 10, expectedServings: 25, targetMargin: 70,
    lines: [{ ingredientId: 'm', name: 'Meat', packPrice: '12', packSize: '1', amount: '1' }] };
  const plain = summarizeEvent([recipe]).recipes[0];
  assert.deepEqual([plain.salePrice, plain.priceSet, plain.revenue, plain.marginPerServing, plain.marginPercent], ['4.00', false, '100.00', '2.8000', '70.0']);

  // $5 here, and buy 2 get $1 off: 12 deals in 25 servings.
  const s = summarizeEvent([{ ...recipe, salePrice: '5', discountAmount: '1', discountQty: 2 }]);
  const r = s.recipes[0];
  assert.deepEqual([r.recommendedPrice, r.salePrice, r.priceSet, r.discount, r.revenue, r.profit], ['4.00', '5.00', true, '12.00', '113.00', '83.00']);
  assert.deepEqual([r.netPrice, r.marginPerServing, r.marginPercent, r.discountAmount, r.discountQty], ['4.5000', '3.3000', '73.3', '1.00', 2]);
  assert.deepEqual([s.revenue, s.profit], ['113.00', '83.00']);

  // A discount alone is per serving; a free item has no margin percent.
  assert.equal(eventPricing({ costPerServing: '1', recommendedPrice: '3', discountAmount: '0.5', expectedServings: 3 }).revenue, '7.50');
  assert.equal(eventPricing({ costPerServing: '1', recommendedPrice: '3', salePrice: '0' }).marginPercent, null);
  assert.throws(() => eventPricing({ costPerServing: '1', recommendedPrice: '3', discountAmount: '1', discountQty: 0 }), /1 or more/);
});

test('a sale line: the deal applies as often as it fits, and given-away items are free', () => {
  const taco = { salePrice: '4', discountAmount: '1', discountQty: 2 };
  assert.deepEqual(saleItem({ ...taco, quantity: 3 }), { quantity: 3, unitPrice: '4.00', deals: 0, discount: '0.00', amount: '12.00' });
  assert.deepEqual(saleItem({ ...taco, quantity: 3, dealUsed: true }), { quantity: 3, unitPrice: '4.00', deals: 1, discount: '1.00', amount: '11.00' });
  assert.deepEqual(saleItem({ ...taco, quantity: 4, dealUsed: true }).amount, '14.00');
  assert.deepEqual(saleItem({ ...taco, quantity: 2, dealUsed: true, free: true }), { quantity: 2, unitPrice: '4.00', deals: 0, discount: '0.00', amount: '0.00' });
  assert.equal(saleItem({ salePrice: '3', quantity: 2, dealUsed: true }).deals, 0); // no deal on this recipe
  assert.throws(() => saleItem({ salePrice: '3', quantity: 0 }), /1 or more/);
});

test('a vendor fee comes off the event profit, not the food cost', () => {
  const recipe = { recipeId: 'a', name: 'Tacos', baseServings: 10, expectedServings: 25, targetMargin: 70,
    lines: [{ ingredientId: 'm', name: 'Meat', packPrice: '12', packSize: '1', amount: '1' }] };
  const s = summarizeEvent([recipe], {}, { vendorFee: '40' });
  assert.deepEqual([s.totalCost, s.revenue, s.vendorFee, s.profit, s.marginPercent], ['30.0000', '100.00', '40.00', '30.00', '30.0']);
  assert.equal(summarizeEvent([recipe]).vendorFee, '0.00');
});

test('the event orders are probably for: today, then open orders, then the next, then the latest', () => {
  const ev = (id, date, more = {}) => ({ id, date, recipeCount: 1, sauceCount: 0, openOrders: 0, lastOrderAt: null, ...more });
  const pick = (events) => anticipateEvent(events, '2026-11-10')?.id;
  const past = ev('past', '2026-11-01');
  const older = ev('older', '2026-10-01');
  const soon = ev('soon', '2026-11-12');
  const later = ev('later', '2026-12-01');
  const open = ev('open', '2026-11-09', { openOrders: 2 });
  const today = ev('today', '2026-11-10');
  assert.equal(pick([]), undefined);
  assert.equal(pick([older, past]), 'past');
  assert.equal(pick([past, later, soon]), 'soon');
  assert.equal(pick([soon, past, open]), 'open');
  assert.equal(pick([open, soon, today]), 'today'); // yesterday's forgotten order doesn't outrank today
  // Two today: the one with the queue, then the one with the latest order.
  assert.equal(pick([today, ev('busy', '2026-11-10', { openOrders: 1 })]), 'busy');
  assert.equal(pick([ev('a', '2026-11-10', { lastOrderAt: '2026-11-10T10:00:00.000Z' }), ev('b', '2026-11-10', { lastOrderAt: '2026-11-10T11:00:00.000Z' })]), 'b');
  // Today wins even with nothing to sell yet, unless another event today has a menu, a sauce counting as one.
  const empty = ev('empty', '2026-11-10', { recipeCount: 0 });
  assert.equal(pick([empty, soon, open]), 'empty');
  assert.equal(pick([empty, ev('sauce', '2026-11-10', { recipeCount: 0, sauceCount: 1 })]), 'sauce');
  // Other days: skipped while another event has a menu.
  assert.equal(pick([ev('emptySoon', '2026-11-11', { recipeCount: 0 }), later]), 'later');
});

test('order timing: waiting, making and total, counting up on the current stage', () => {
  const t = (mmss) => `2026-11-10T12:${mmss}.000Z`;
  const now = new Date(t('30:00')).getTime();
  const placed = { createdAt: t('10:00') };
  assert.deepEqual(orderTimes({ ...placed, status: 'placed' }, now), { waiting: 1200, making: null, total: 1200, running: 'waiting' });
  assert.deepEqual(orderTimes({ ...placed, status: 'in_progress', inProgressAt: t('15:00') }, now), { waiting: 300, making: 900, total: 1200, running: 'making' });
  const done = { ...placed, status: 'completed', inProgressAt: t('15:00'), completedAt: t('25:30') };
  assert.deepEqual(orderTimes(done, now), { waiting: 300, making: 630, total: 930, running: null });
  // Never started: only the total. Handed over on the spot: nothing.
  assert.deepEqual(orderTimes({ ...placed, status: 'completed', completedAt: t('12:00') }, now), { waiting: null, making: null, total: 120, running: null });
  assert.deepEqual(orderTimes({ ...placed, status: 'completed' }, now), { waiting: null, making: null, total: null, running: null });
  // Cancelled: what was reached stays, and nothing runs.
  assert.deepEqual(orderTimes({ ...placed, status: 'cancelled', inProgressAt: t('15:00') }, now), { waiting: 300, making: null, total: null, running: null });
  // A browser clock behind the server's never shows negative time.
  assert.equal(orderTimes({ createdAt: t('31:00'), status: 'placed' }, now).waiting, 0);

  const summary = orderTimingSummary([
    done,
    { ...placed, status: 'completed', completedAt: t('12:00') },
    { ...placed, status: 'completed' }, // handed over: not timed
    { ...done, status: 'cancelled' }, // cancelled: not counted
    { ...placed, status: 'placed' },
  ]);
  assert.deepEqual(summary, { count: 2, waiting: 300, making: 630, total: 525 });
  assert.deepEqual(orderTimingSummary([]), { count: 0, waiting: null, making: null, total: null });
});

test('a sauce’s own sale price replaces its cost at the default margin', () => {
  const blend = { name: 'Green', container: '1 qt', batchSize: '32', servingOz: '2', cost: '8' }; // $0.50 a serving
  assert.equal(sauceContainer(blend).recommendedPrice, '1.67');
  assert.equal(sauceContainer({ ...blend, salePrice: '3' }).recommendedPrice, '3.00');
  assert.equal(sauceContainer({ ...blend, salePrice: null }).recommendedPrice, '1.67');
  assert.equal(sauceContainer({ ...blend, salePrice: '0' }).recommendedPrice, '0.00'); // given away is a price
  // Unpriced ingredients: no default, but the sauce's own price stands.
  assert.equal(sauceContainer({ ...blend, cost: null }).recommendedPrice, null);
  const own = sauceContainer({ ...blend, cost: null, salePrice: '3' });
  assert.deepEqual([own.recommendedPrice, own.costPerServing], ['3.00', null]);
  assert.equal(sauceContainer({ ...blend, salePrice: '3' }, '1 gal').recommendedPrice, '3.00'); // per serving, whatever the container
});
