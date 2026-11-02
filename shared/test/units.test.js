import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateBlend, convertUnits, itemAmounts, normalizeUnit, parseAmount, unitRatio, unitsForName } from '../src/calc.js';

test('unit ratios between ingredient units are exact and never cross weight and volume', () => {
  assert.equal(unitRatio('oz', 'lb').toString(), '0.0625');
  assert.equal(unitRatio('lb', 'oz').toString(), '16');
  assert.equal(unitRatio('ml', 'L').toString(), '0.001');
  assert.equal(unitRatio('Box', 'box').toString(), '1');
  assert.equal(unitRatio('lb', 'tsp'), null);
  assert.equal(unitRatio('fl oz', 'oz'), null);
  assert.equal(unitRatio('each', 'lb'), null);
  assert.equal(unitRatio('box', 'lb'), null);
});

test('kitchen units normalise and convert to teaspoons', () => {
  assert.equal(normalizeUnit('Tablespoons'), 'tbsp');
  assert.equal(normalizeUnit('pinches'), 'pinch');
  assert.equal(normalizeUnit('tsp.'), 'tsp');
  assert.equal(normalizeUnit('handful'), null);
  assert.equal(convertUnits(1, 'tbsp', 'tsp').toString(), '3');
  assert.equal(convertUnits(2, 'dash', 'tsp').toString(), '0.25');
  assert.equal(convertUnits(16, 'pinch', 'tsp').toString(), '1');
  assert.equal(convertUnits(1, 'cup', 'tbsp').toString(), '16');
  assert.equal(convertUnits(5, 'g', 'tsp').toString(), '2'); // 2.5 g per tsp
  assert.equal(convertUnits(1, 'oz', 'g').toFixed(4), '28.3495');
  assert.equal(convertUnits(1, 'tsp', 'each'), null);
});

test('a bunch converts only to itself exactly, and any unit converts to itself', () => {
  assert.equal(normalizeUnit('Bunches'), 'bunch');
  assert.equal(convertUnits(2, 'bunch', 'g').toString(), '150');
  assert.equal(convertUnits(2, 'Box', 'box').toString(), '2');
  assert.equal(unitRatio('bunch', 'lb'), null);
  assert.equal(unitRatio('bunch', 'bunch').toString(), '1');
});

test('garlic can be measured in cloves, which cost through their weight', () => {
  assert.equal(normalizeUnit('Cloves'), 'clove');
  assert.equal(convertUnits(2, 'clove', 'g').toString(), '14');
  assert.equal(unitRatio('clove', 'lb'), null);
  assert.deepEqual(unitsForName('Garlic'), ['clove']);
  assert.deepEqual(unitsForName('Garlic, peeled'), ['clove']);
  assert.deepEqual(unitsForName('Garlic powder'), []);
  assert.deepEqual(unitsForName('Thai Chilies'), []);
  // By the pound: 2 cloves are 14 g of a 453.592 g lb.
  assert.equal(itemAmounts(2, 'clove', { uom: 'lb' }).inUom.toFixed(4), '0.0309');
  // By the box, through a box's weight, in a sauce's density too.
  const box = { name: 'Garlic', uom: 'box', packPrice: '7.50', packSize: '1' };
  const s = calculateBlend([{ amount: '3', unit: 'clove', ...box }], { kind: 'sauce', container: '1 qt' });
  assert.equal(s.totalGrams, '21.0000');
  assert.equal(s.cost, '0.2100'); // 21 g of a 750 g box × $7.50
});

test('a chili weighs a couple of grams, unless its ingredient says otherwise', () => {
  assert.equal(itemAmounts(7, 'chili', { uom: 'chili' }).grams.toString(), '14');
  assert.equal(itemAmounts(1, 'oz', { uom: 'chili' }).inUom.toFixed(2), '14.17');
  assert.equal(itemAmounts(7, 'chili', { uom: 'chili', unitGrams: '15' }).grams.toString(), '105');
  // Counted in its own unit, its cost doesn't depend on the weight.
  const b = calculateBlend([{ name: 'Thai Chilies', amount: '7', unit: 'chili', uom: 'chili', packPrice: '3', packSize: '30' }]);
  assert.equal(b.cost, '0.7000');
});

test('a sauce weighs volumes like water and its batch is its container', () => {
  const s = calculateBlend([{ name: 'Oil', amount: '1', unit: 'cup' }], { kind: 'sauce', container: '1/4 qt' });
  assert.equal(s.totalGrams, '236.6400'); // 48 tsp at 4.93 g
  assert.deepEqual([s.uom, s.batchSize], ['oz', '8.0000']);
  const b = calculateBlend([{ name: 'Salt', amount: '1', unit: 'tsp' }]);
  assert.deepEqual([b.uom, b.batchSize], ['g', '2.5000']);
});

test('amounts accept fractions', () => {
  assert.equal(parseAmount('1 1/2').toString(), '1.5');
  assert.equal(parseAmount('3/4').toString(), '0.75');
  assert.equal(parseAmount('½').toString(), '0.5');
  assert.equal(parseAmount('2½').toString(), '2.5');
  assert.equal(parseAmount('0.25').toString(), '0.25');
  assert.equal(parseAmount('1/0'), null);
  assert.equal(parseAmount('salt'), null);
});

test('a blend breaks down by weight and costs what it can', () => {
  const b = calculateBlend([
    { name: 'Paprika', amount: '2', unit: 'tbsp', packPrice: '6', packSize: '3', uom: 'oz' }, // 6 tsp
    { name: 'Salt', amount: '1', unit: 'tsp' }, // no price
    { name: 'Cayenne', amount: '8', unit: 'pinch' }, // 0.5 tsp
    { name: 'Garlic powder', amount: '5', unit: 'g', packPrice: '4', packSize: '1', uom: 'jar' }, // 2 tsp; a jar taken as 75 g
  ]);
  assert.equal(b.totalGrams, '23.7500'); // 9.5 tsp at 2.5 g
  assert.equal(b.items[2].grams, '1.2500');
  assert.deepEqual(b.items.map((i) => i.share), ['63.2', '10.5', '5.3', '21.1']);
  // Paprika: 6 tsp × 2.5 g = 15 g = 0.5291 oz × $2/oz
  assert.equal(b.items[0].cost, '1.0582');
  assert.equal(b.items[3].cost, '0.2667'); // 5 g of a 75 g jar × $4
  assert.equal(b.cost, '1.3249');
  assert.equal(b.costComplete, false);
  assert.equal(calculateBlend([]).cost, null);
});

test('an ingredient sold by the box converts through what one box weighs', () => {
  const garlic = { uom: 'box', unitGrams: '85', packPrice: '5.99', packSize: '1' };
  // 1 oz of a box weighing 85 g: 28.3495 / 85 of a box.
  const { grams, inUom } = itemAmounts(1, 'oz', garlic);
  assert.equal(grams.toFixed(4), '28.3495');
  assert.equal(inUom.toFixed(4), '0.3335');
  // Measured in boxes: the pie chart gets its weight too.
  assert.equal(itemAmounts('0.1', 'box', garlic).grams.toFixed(1), '8.5');
  // No weight set: a box is taken as about 750 g, so it still has a slice and a price.
  assert.equal(itemAmounts(1, 'oz', { uom: 'box' }).inUom.toFixed(4), '0.0378');
  assert.equal(itemAmounts(1, 'box', { uom: 'box' }).grams.toString(), '750');
  assert.equal(itemAmounts(2, 'can', { uom: 'can' }).grams.toString(), '150'); // other units: 75 g
  assert.equal(itemAmounts(1, 'tsp', { uom: 'each' }).inUom.toFixed(4), '0.0333'); // 2.5 g of a 75 g each
  const b = calculateBlend([{ name: 'Garlic', amount: '1', unit: 'oz', ...garlic }], { kind: 'sauce', container: '1 qt' });
  assert.equal(b.cost, '1.9978'); // 28.3495 / 85 of a box × $5.99
});
