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

  // Packs set by hand: one bag already in stock, so buy one. The trip costs less; the food doesn't.
  const menu = [{ recipeId: 'a', name: 'Bread', baseServings: 10, expectedServings: 20, targetMargin: 70, lines: [{ ...flour, amount: '25' }] },
    { recipeId: 'b', name: 'Pasta', baseServings: 4, expectedServings: 4, targetMargin: 50, lines: [{ ...flour, amount: '5' }] }];
  const set = summarizeEvent(menu, {}, { packs: { f: '1.00' } });
  const [one] = set.shoppingList;
  assert.deepEqual([one.packsToBuy, one.calculatedPacks, one.packsSet, one.purchaseCost, one.leftover], ['1', '2', true, '20.0000', '-5.0000']); // 5 lb from stock
  assert.deepEqual([set.purchaseCost, set.packsAdjustment, set.totalCost], ['20.0000', '-20.0000', '22.0000']);
  assert.equal(s.packsAdjustment, '0.0000');
  assert.equal(s.shoppingList[0].packsSet, undefined);
});

test('purchase cost completion', () => {
  assert.deepEqual(completePurchaseCosts({ quantity: 4, totalCost: '10' }), { unitCost: '2.5000', totalCost: '10.0000' });
  assert.deepEqual(completePurchaseCosts({ quantity: 3, unitCost: '1.1' }), { unitCost: '1.1000', totalCost: '3.3000' });
  assert.throws(() => completePurchaseCosts({ quantity: 0, unitCost: 1 }), CalcError);
  // Both given: rounding is fine (2.46 lb at $2.39 printed $5.88), a quantity typed over the weight isn't.
  assert.deepEqual(completePurchaseCosts({ quantity: '2.46', unitCost: '2.39', totalCost: '5.88' }), { unitCost: '2.3900', totalCost: '5.8800' });
  assert.deepEqual(completePurchaseCosts({ quantity: 6, unitCost: '0.3317', totalCost: '1.99' }), { unitCost: '0.3317', totalCost: '1.9900' });
  assert.throws(() => completePurchaseCosts({ quantity: 5, unitCost: '4.99', totalCost: '1.05' }), /5 × \$4\.99 is \$24\.95, but the total is \$1\.05/);
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

test('an event’s labor is its hours × rate, part of its cost but not its shopping list', () => {
  const recipe = { recipeId: 'a', name: 'R', baseServings: 1, expectedServings: 1, salePrice: '50', lines: [{ ingredientId: 'z', name: 'Zest', packPrice: '1', amount: '1' }] };
  const s = summarizeEvent([recipe], {}, { labor: { hours: '2.5', rate: '20' }, vendorFee: '5' });
  assert.deepEqual(s.labor, { hours: '2.5', rate: '20.00', cost: '50.00' });
  assert.deepEqual([s.totalCost, s.profit, s.recipes[0].scaledCost], ['51.0000', '-6.00', '1.0000']);
  assert.deepEqual(s.shoppingList.map((l) => l.name), ['Zest']);
  // No rate yet: hours cost nothing.
  assert.deepEqual(summarizeEvent([recipe], {}, { labor: { hours: '3', rate: null } }).labor, { hours: '3', rate: null, cost: '0.00' });
  assert.deepEqual(summarizeEvent([recipe]).labor, { hours: '0', rate: null, cost: '0.00' });
});

test('a personal chef job or supper club shares its rate out by food cost', async () => {
  const r = (id, cost) => ({ recipeId: id, name: id, baseServings: 1, expectedServings: 10, salePrice: '99', dealQty: 2, dealPrice: '5', lines: [{ ingredientId: id, name: id, packPrice: cost, packSize: '1', amount: '1' }] });
  const menu = [r('a', '3'), r('b', '1')]; // $30 and $10 of food

  // Supper club: 10 tickets at $40. Hoamsy takes 25% first, so revenue is the $300 left, shared out;
  // every dish makes the same margin percent.
  const supper = (more) => summarizeEvent(menu, {}, { format: { kind: 'supper_club', flatPrice: '40', tickets: '10', hoamsyPercent: '25', ...more }, labor: { hours: '2', rate: '20' }, vendorFee: '10' });
  const club = supper();
  assert.deepEqual([club.kind, club.flat.gross, club.hoamsyFee, club.revenue, club.totalCost, club.profit], ['supper_club', '400.00', '100.00', '300.00', '80.0000', '210.00']);
  // Labor and the vendor fee ($50) are paid back at cost first; the $250 left is the dishes' revenue,
  // so each dish's margin is on its food (84%), while the event's is 70%.
  assert.equal(club.flat.passThrough, '50.00');
  assert.deepEqual(club.recipes.map((x) => [x.share, x.revenue, x.profit, x.marginPerServing, x.marginPercent, x.salePrice, x.dealQty]),
    [['75.0', '187.50', '157.50', '15.7500', '84.0', null, null], ['25.0', '62.50', '52.50', '5.2500', '84.0', null, null]]);
  assert.equal(club.marginPercent, '70.0');
  // $28 a plate sells the $40 of food at 75% ($160) and covers $40 of labor and the $10 vendor fee:
  // $280 of tickets, $210 after Hoamsy. What's left after labor and fees is the food's 75% margin.
  assert.equal(club.flat.suggestedPrice, '28.00');
  const at = supper({ flatPrice: '28' });
  assert.deepEqual([at.revenue, at.profit], ['210.00', '120.00']); // 120 = 75% of 160
  assert.ok(at.recipes.every((x) => x.marginPercent === '75.0')); // at that price every dish is at 75% on its food
  // Gross margin is the food's: $40 of the $160 left once labor and the fee are paid back, the 75%
  // the dishes show; net is profit over all $210 kept.
  assert.deepEqual([at.grossMarginPercent, at.marginPercent], ['75.0', '57.1']);
  // A market's gross margin is its revenue less the food: $50 on the 2-for-$5 deal, $40 of food.
  const sold = summarizeEvent(menu, {}, { vendorFee: '10', labor: { hours: '1', rate: '20' } });
  assert.deepEqual([sold.revenue, sold.grossMarginPercent, sold.marginPercent], ['50.00', '20.0', '-40.0']);
  // A fee or labor adds its own amount, spread over the tickets after Hoamsy: $30 more is $4 a plate.
  const fee30 = summarizeEvent(menu, {}, { format: { kind: 'supper_club', flatPrice: '40', tickets: '10', hoamsyPercent: '25' }, labor: { hours: '2', rate: '20' }, vendorFee: '40' });
  // Without a Hoamsy fee (unticked), the tickets are all revenue.
  const none = supper({ hoamsyPercent: null });
  assert.deepEqual([none.hoamsyFee, none.revenue, none.flat.hoamsyPercent, none.flat.suggestedPrice], ['0.00', '400.00', null, '21.00']); // $210 over 10 tickets
  assert.equal(fee30.flat.suggestedPrice, '32.00');
  // Its own Hoamsy fee.
  assert.deepEqual([supper({ hoamsyPercent: '20' }).hoamsyFee, supper({ hoamsyPercent: '20' }).revenue], ['80.00', '320.00']);
  assert.throws(() => supper({ hoamsyPercent: '100' }), /Hoamsy/);

  // Personal chef: a $300 rate plus the $40 of groceries at cost; no Hoamsy fee.
  const chef = summarizeEvent(menu, {}, { format: { kind: 'personal_chef', flatPrice: '300' } });
  assert.deepEqual([chef.revenue, chef.profit, chef.hoamsyFee, chef.flat.groceries], ['340.00', '300.00', '0.00', '40.00']);
  assert.deepEqual(chef.recipes.map((x) => [x.revenue, x.profit, x.marginPerServing, x.marginPercent]), [['255.00', '225.00', '22.5000', '88.2'], ['85.00', '75.00', '7.5000', '88.2']]);
  assert.equal(chef.marginPercent, '88.2');
  // $120 sells the $40 of food at 75%: $160 billed, $120 kept.
  assert.equal(chef.flat.suggestedPrice, '120.00');
  assert.equal(summarizeEvent(menu, {}, { format: { kind: 'personal_chef', flatPrice: '120' } }).marginPercent, '75.0');
  // An amount set by hand is billed with the groceries; the dishes' revenue still adds up, at the event's margin.
  const set = summarizeEvent(menu, { a: '4' }, { format: { kind: 'personal_chef', flatPrice: '300' }, labor: { hours: '1', rate: '20' } });
  assert.deepEqual([set.flat.groceries, set.revenue], ['22.00', '322.00']); // a: 4 bought instead of the 10 the servings need, $18 less
  // The dishes' revenue and the labor paid back at cost add up to the event's.
  assert.equal((set.recipes.reduce((sum, x) => sum + Number(x.revenue), 0) + Number(set.labor.cost)).toFixed(2), set.revenue);
  assert.deepEqual(set.recipes.map((x) => x.marginPercent), ['92.7', '92.7']);
  // A $50 vendor fee and $60 of labor add $50 and $60, not four times as much.
  const busy = summarizeEvent(menu, {}, { format: { kind: 'personal_chef', flatPrice: '300' }, vendorFee: '50', labor: { hours: '3', rate: '20' } });
  assert.equal(busy.flat.suggestedPrice, '230.00');
  // With no labor or fees, gross and net margin agree.
  assert.deepEqual([chef.grossMarginPercent, chef.marginPercent], ['88.2', '88.2']);

  // A market is unchanged, and has no flat item.
  const market = summarizeEvent(menu);
  assert.deepEqual([market.kind, market.flat, market.hoamsyFee], ['market', null, '0.00']);
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
  assert.equal(plain.servingUnit, 'tacos');
  assert.equal(summarizeEvent([{ ...recipe, servingSize: '3', salePrice: '14', dealPrice: '27', dealQty: 2 }]).recipes[0].revenue, '270.00');
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

test('an event price replaces the recipe price, and a deal sells N servings for a price', () => {
  // Cost $1.20 a serving at 70% margin: the recipe sells for $4.00.
  const recipe = { recipeId: 'a', name: 'Tacos', baseServings: 10, expectedServings: 25, targetMargin: 70,
    lines: [{ ingredientId: 'm', name: 'Meat', packPrice: '12', packSize: '1', amount: '1' }] };
  const plain = summarizeEvent([recipe]).recipes[0];
  assert.deepEqual([plain.salePrice, plain.priceSet, plain.revenue, plain.marginPerServing, plain.marginPercent], ['4.00', false, '100.00', '2.8000', '70.0']);

  // $5 here, and 2 for $9: 12 deals in 25 servings.
  const s = summarizeEvent([{ ...recipe, salePrice: '5', dealPrice: '9', dealQty: 2 }]);
  const r = s.recipes[0];
  assert.deepEqual([r.recommendedPrice, r.salePrice, r.priceSet, r.discount, r.revenue, r.profit], ['4.00', '5.00', true, '12.00', '113.00', '83.00']);
  assert.deepEqual([r.netPrice, r.marginPerServing, r.marginPercent, r.dealPrice, r.dealQty], ['4.5000', '3.3000', '73.3', '9.00', 2]);
  assert.deepEqual([s.revenue, s.profit], ['113.00', '83.00']);

  // A deal that isn't cheaper doesn't count: 3 at $5 is already $15. A free item has no margin percent.
  const notCheaper = eventPricing({ costPerServing: '1', recommendedPrice: '5', dealPrice: '15', dealQty: 3, expectedServings: 6 });
  assert.deepEqual([notCheaper.dealPrice, notCheaper.dealQty, notCheaper.discount, notCheaper.revenue], [null, null, '0.00', '30.00']);
  assert.equal(eventPricing({ costPerServing: '1', recommendedPrice: '3', salePrice: '0' }).marginPercent, null);
  assert.throws(() => eventPricing({ costPerServing: '1', recommendedPrice: '3', dealPrice: '1', dealQty: 1 }), /2 or more/);
});

test('a sale line: the deal applies by itself as often as it fits, and given-away items are free', () => {
  const taco = { salePrice: '6', dealPrice: '15', dealQty: 3 };
  assert.deepEqual(saleItem({ ...taco, quantity: 2 }), { quantity: 2, unitPrice: '6.00', deals: 0, discount: '0.00', amount: '12.00' });
  assert.deepEqual(saleItem({ ...taco, quantity: 3 }), { quantity: 3, unitPrice: '6.00', deals: 1, discount: '3.00', amount: '15.00' });
  assert.equal(saleItem({ ...taco, quantity: 4 }).amount, '21.00');
  assert.deepEqual(saleItem({ ...taco, quantity: 6 }).deals, 2);
  assert.deepEqual(saleItem({ ...taco, quantity: 3, free: true }), { quantity: 3, unitPrice: '6.00', deals: 0, discount: '0.00', amount: '0.00' });
  assert.equal(saleItem({ salePrice: '3', quantity: 2 }).deals, 0); // no deal on this recipe
  assert.equal(saleItem({ salePrice: '4', dealPrice: '15', dealQty: 3, quantity: 3 }).amount, '12.00'); // never dearer than without it
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

test('order timing: making and total, counting up while in progress', () => {
  const t = (mmss) => `2026-11-10T12:${mmss}.000Z`;
  const now = new Date(t('30:00')).getTime();
  const placed = { createdAt: t('10:00') };
  // Placed on the POS: in progress from the start.
  assert.deepEqual(orderTimes({ ...placed, status: 'in_progress', inProgressAt: t('10:00') }, now), { making: 1200, total: 1200, running: 'making' });
  const done = { ...placed, status: 'completed', inProgressAt: t('10:00'), completedAt: t('25:30') };
  assert.deepEqual(orderTimes(done, now), { making: 930, total: 930, running: null });
  // Never started: only the total. Handed over on the spot: nothing.
  assert.deepEqual(orderTimes({ ...placed, status: 'completed', completedAt: t('12:00') }, now), { making: null, total: 120, running: null });
  assert.deepEqual(orderTimes({ ...placed, status: 'completed' }, now), { making: null, total: null, running: null });
  // Cancelled: nothing runs.
  assert.deepEqual(orderTimes({ ...placed, status: 'cancelled', inProgressAt: t('15:00') }, now), { making: null, total: null, running: null });
  // A browser clock behind the server's never shows negative time.
  assert.equal(orderTimes({ createdAt: t('31:00'), inProgressAt: t('31:00'), status: 'in_progress' }, now).making, 0);

  const summary = orderTimingSummary([
    done,
    { ...placed, status: 'completed', completedAt: t('12:00') },
    { ...placed, status: 'completed' }, // handed over: not timed
    { ...done, status: 'cancelled' }, // cancelled: not counted
    { ...placed, status: 'in_progress', inProgressAt: t('10:00') },
  ]);
  assert.deepEqual(summary, { count: 2, making: 930, total: 525 });
  assert.deepEqual(orderTimingSummary([]), { count: 0, making: null, total: null });
});

test('a sauce’s own sale price replaces its cost at the default margin', () => {
  const blend = { name: 'Green', container: '1 qt', batchSize: '32', servingOz: '2', cost: '8' }; // $0.50 a serving
  assert.equal(sauceContainer(blend).recommendedPrice, '2.00');
  assert.equal(sauceContainer({ ...blend, salePrice: '3' }).recommendedPrice, '3.00');
  assert.equal(sauceContainer({ ...blend, salePrice: null }).recommendedPrice, '2.00');
  assert.equal(sauceContainer({ ...blend, salePrice: '0' }).recommendedPrice, '0.00'); // given away is a price
  // Unpriced ingredients: no default, but the sauce's own price stands.
  assert.equal(sauceContainer({ ...blend, cost: null }).recommendedPrice, null);
  const own = sauceContainer({ ...blend, cost: null, salePrice: '3' });
  assert.deepEqual([own.recommendedPrice, own.costPerServing], ['3.00', null]);
  assert.equal(sauceContainer({ ...blend, salePrice: '3' }, '1 gal').recommendedPrice, '3.00'); // per serving, whatever the container
});
