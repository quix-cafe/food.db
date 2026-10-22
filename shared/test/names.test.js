import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, findDuplicates, ingredientKey, nameParts, preferredKeep } from '../src/calc.js';

test('names reduce to what identifies the ingredient', () => {
  assert.equal(ingredientKey('Granulated sugar'), 'sugar');
  assert.equal(ingredientKey('Kosher Salt'), 'salt');
  assert.equal(ingredientKey('Tortilla 16 ct'), 'tortilla');
  assert.equal(ingredientKey('White Corn Tortillas'), 'white corn tortilla');
  assert.equal(ingredientKey('AP FLOUR 50LB'), 'ap flour');
  assert.equal(ingredientKey('Potatoes'), ingredientKey('potato'));
  assert.equal(ingredientKey('Berries'), ingredientKey('berry'));
  assert.equal(ingredientKey('Thai Chilies'), ingredientKey('Thai chili'));
  assert.equal(ingredientKey('Peaches'), ingredientKey('Peach'));
  assert.equal(ingredientKey('Jalapeño'), 'jalapeno');
  assert.equal(ingredientKey('Swiss chard'), 'swiss chard');
  assert.equal(ingredientKey('Asparagus'), 'asparagus');
  assert.equal(ingredientKey('Mustard oil 1.5 lb'), 'mustard oil');
  assert.equal(ingredientKey('Fresh'), '');
  assert.deepEqual(nameParts('Tortilla 16 ct').dropped, ['16 ct']);
  assert.deepEqual(nameParts('Large eggs x12').dropped, ['large', 'x12']);
});

test('edit distance counts a swap as one edit', () => {
  assert.equal(editDistance('onion', 'onoin'), 1);
  assert.equal(editDistance('cilantro', 'cilantro'), 0);
  assert.equal(editDistance('sauce', 'paste'), 3);
});

const ing = (name, extra = {}) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, uom: 'each', ...extra });
const pairs = (list, opts) => findDuplicates(list, opts).map((p) => [p.merge.name, p.keep.name, p.kind]);

test('duplicates: grade words, pack sizes, plurals, spacing and typos', () => {
  const list = [
    ing('Sugar', { uom: 'box' }), ing('Granulated sugar', { uom: 'lb' }),
    ing('Salt', { uom: 'box' }), ing('Kosher salt', { uom: 'lb' }),
    ing('Tortilla 16 ct'), ing('Tortillas', { purchaseCount: 1 }), ing('White Corn Tortillas'),
    ing('Chick pea'), ing('Chickpea', { purchaseCount: 2 }),
    ing('Red Onion', { purchaseCount: 3 }), ing('Red Onoin'), ing('Pickled Red Onion'),
    ing('Chicken', { uom: 'lb' }), ing('Ground Chicken', { uom: 'lb' }),
    ing('Cilantro'), ing('Cilantro stems'),
    ing('Malt'), ing('Labor', { category: 'Labor' }), ing('Labour'),
  ];
  assert.deepEqual(pairs(list), [
    ['Salt', 'Kosher salt', 'name'],
    ['Sugar', 'Granulated sugar', 'name'],
    ['Tortilla 16 ct', 'Tortillas', 'name'],
    ['Chick pea', 'Chickpea', 'spelling'],
    ['Red Onoin', 'Red Onion', 'spelling'],
  ]);
  const [salt] = findDuplicates(list);
  assert.equal(salt.reason, 'The names differ only by “kosher”');
  assert.equal(findDuplicates(list).find((p) => p.kind === 'spelling').reason, 'The names differ only by spacing');
});

test('duplicates: a saved receipt name, and pairs marked not the same', () => {
  const list = [ing('Granulated sugar', { uom: 'lb' }), ing('Cane sugar', { uom: 'lb' }), ing('Sugar', { uom: 'lb' })];
  const aliases = [{ ingredientId: 'granulated-sugar', alias: 'CANE SUGAR' }];
  const found = findDuplicates(list, { aliases });
  assert.deepEqual(found.map((p) => [p.merge.name, p.keep.name, p.kind]), [
    ['Cane sugar', 'Granulated sugar', 'alias'],
    ['Sugar', 'Granulated sugar', 'name'],
  ]);
  assert.equal(found[0].reason, '“CANE SUGAR” is a receipt name saved for Granulated sugar');
  assert.deepEqual(pairs(list, { aliases, dismissed: [['sugar', 'granulated-sugar']] }), [['Cane sugar', 'Granulated sugar', 'alias']]);
});

test('the suggested keeper: a real unit, then the more specific name, then more history', () => {
  assert.equal(preferredKeep(ing('Sugar', { uom: 'lb' }), ing('Granulated sugar', { uom: 'box' })).name, 'Sugar');
  assert.equal(preferredKeep(ing('Sugar', { uom: 'lb' }), ing('Granulated sugar', { uom: 'lb' })).name, 'Granulated sugar');
  // A pack size in the name isn't more specific.
  assert.equal(preferredKeep(ing('Cocoa powder 8 oz', { uom: 'oz' }), ing('Cocoa powder', { uom: 'lb', purchaseCount: 2 })).name, 'Cocoa powder');
  assert.equal(preferredKeep(ing('Onion', { purchaseCount: 1 }), ing('Onions', { purchaseCount: 2, recipeCount: 1 })).name, 'Onions');
});
