import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, findDuplicates, ingredientKey, isGenericName, nameParts, preferredKeep, receiptName, wordMatches } from '../src/calc.js';

test('names reduce to what identifies the ingredient', () => {
  assert.equal(ingredientKey('Granulated sugar'), 'sugar');
  assert.equal(ingredientKey('Kosher Salt'), 'salt');
  assert.equal(ingredientKey('Tortilla 16 ct'), 'tortilla');
  assert.equal(ingredientKey('White Corn Tortillas'), 'corn tortilla white'); // words in order, so word order doesn't matter
  assert.equal(ingredientKey('AP FLOUR 50LB'), 'ap flour');
  assert.equal(ingredientKey('Potatoes'), ingredientKey('potato'));
  assert.equal(ingredientKey('Berries'), ingredientKey('berry'));
  assert.equal(ingredientKey('Thai Chilies'), ingredientKey('Thai chili'));
  assert.equal(ingredientKey('Peaches'), ingredientKey('Peach'));
  assert.equal(ingredientKey('Jalapeño'), 'jalapeno');
  assert.equal(ingredientKey('Swiss chard'), 'chard swiss');
  assert.equal(ingredientKey('Asparagus'), 'asparagus');
  assert.equal(ingredientKey('Mustard oil 1.5 lb'), 'mustard oil');
  assert.equal(ingredientKey('Fresh'), '');
  assert.deepEqual(nameParts('Tortilla 16 ct').dropped, ['16 ct']);
  assert.deepEqual(nameParts('Large eggs x12').dropped, ['large', 'x12']);
  // Receipt wording: word order, where it's from, shorthand and other names for the same thing.
  assert.equal(ingredientKey('TOMATO PLUM USA MEX'), ingredientKey('Plum Tomato'));
  assert.equal(ingredientKey('LIMES SEEDLES MEXICO'), ingredientKey('Lime'));
  assert.equal(ingredientKey('ONIONS YELL SPANISH'), ingredientKey('Spanish yellow onions'));
  assert.equal(ingredientKey('SWT BELL PEPPER'), ingredientKey('Sweet bell pepper'));
  assert.equal(ingredientKey('Green onions'), ingredientKey('Scallion'));
  assert.equal(ingredientKey('Dahi'), ingredientKey('Yogurt'));
  assert.equal(ingredientKey('Golgappa'), ingredientKey('Pani puri'));
  assert.equal(ingredientKey('Chick Peas'), ingredientKey('Chickpea'));
  assert.deepEqual(nameParts('Green onions').synonyms, ['green onions → scallion']);
  assert.equal(ingredientKey('SHAN GINGER PASTE'), ingredientKey('Ginger paste'));
  assert.equal(ingredientKey('PEP FARM PUFF PASTRY'), ingredientKey('Puff Pastry'));
  assert.equal(ingredientKey('HUNTS TOMATO PASTE'), ingredientKey('Tomato paste'));
});

test('a receipt name that says nothing about what was bought', () => {
  for (const name of ['GROCERY', 'Grocery item', 'MEAT', 'PRODUCE']) assert.equal(isGenericName(name), true, name);
  for (const name of ['GROUND MEAT', 'CILANTRO', '']) assert.equal(isGenericName(name), false, name);
});

test('a tidier name for a new ingredient, with the pack size printed in it', () => {
  assert.deepEqual(receiptName('Laxmi Garam Masala Powder 14oz'), { name: 'Garam Masala Powder', packSize: '14', uom: 'oz' });
  assert.deepEqual(receiptName('SWT BELL PEPPER 4P'), { name: 'Sweet Bell Pepper', packSize: '4', uom: 'each' });
  assert.deepEqual(receiptName('CILANTRO MEX'), { name: 'Cilantro', packSize: null, uom: null });
  assert.deepEqual(receiptName('Khazana Basmati Rice 10 LBS'), { name: 'Basmati Rice', packSize: '10', uom: 'lb' });
  assert.deepEqual(receiptName('OMG 3 L BRWN EGG'), { name: 'Omg 3 L Brown Egg', packSize: null, uom: null }); // omega-3 large, not 3 litres
  assert.deepEqual(receiptName('GREEN ONION/SCALLI'), { name: 'Green Onion/Scalli', packSize: null, uom: null });
  // Brands seen on receipts drop out; the receipt's wording stays the receipt name.
  assert.deepEqual(receiptName('SHAN GINGER PASTE'), { name: 'Ginger Paste', packSize: null, uom: null });
  assert.deepEqual(receiptName('PEP FARM PUFF PASTRY'), { name: 'Puff Pastry', packSize: null, uom: null });
  assert.deepEqual(receiptName("Hunt's Tomato Paste 6oz"), { name: 'Tomato Paste', packSize: '6', uom: 'oz' });
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
    ing('Potato', { uom: 'lb', recipeCount: 2 }), ing('POTATOES IDAHO US', { uom: 'lb' }), ing('Sweet potato', { uom: 'lb' }),
    ing('CILANTRO MEX', { uom: 'bunch' }),
    ing('Red Onion', { purchaseCount: 3 }), ing('Red Onoin'), ing('Pickled Red Onion'),
    ing('Chicken', { uom: 'lb' }), ing('Ground Chicken', { uom: 'lb' }),
    ing('Cilantro', { uom: 'bunch', recipeCount: 4 }), ing('Cilantro stems'),
    ing('Malt'),
  ];
  assert.deepEqual(pairs(list), [
    ['Chick pea', 'Chickpea', 'name'],
    ['CILANTRO MEX', 'Cilantro', 'name'], // a typed name over a receipt's capitals
    ['Salt', 'Kosher salt', 'name'],
    ['Sugar', 'Granulated sugar', 'name'],
    ['Tortilla 16 ct', 'Tortillas', 'name'],
    ['Red Onoin', 'Red Onion', 'spelling'],
    ['POTATOES IDAHO US', 'Potato', 'words'], // but not Sweet potato, Ground Chicken or Cilantro stems
  ]);
  const salt = findDuplicates(list).find((p) => p.merge.name === 'Salt');
  assert.equal(salt.reason, 'The names differ only by “kosher”');
  assert.equal(findDuplicates(list).find((p) => p.kind === 'spelling').reason, 'The names are spelled almost the same');
  assert.equal(findDuplicates(list).find((p) => p.merge.name === 'Chick pea').reason, '“Chick pea” and “Chickpea” are names for the same thing');
  assert.equal(findDuplicates(list).find((p) => p.kind === 'words').reason, '“POTATOES IDAHO US” is “Potato” with “idaho” added');
});

test('duplicates: store codes and brands', () => {
  const list = [
    ing('EE PEAS CARR'), ing('WC PEAS AND CARR', { recipeCount: 1 }),
    ing('SHAN GINGER PASTE'), ing('National Ginger Paste'),
    ing('Bell Pepper Red', { uom: 'lb' }), ing('Bell Pepper Green', { uom: 'lb' }), // colors are kinds, not brands
    ing('Garlic powder'), ing('Garlic paste'),
  ];
  assert.deepEqual(pairs(list), [
    ['SHAN GINGER PASTE', 'National Ginger Paste', 'name'], // both brands are known, so the names are one; typed capitals win
    ['EE PEAS CARR', 'WC PEAS AND CARR', 'words'],
  ]);
  // Brands not seen before: one word different each, after two alike.
  const brands = findDuplicates([ing('Acme Ginger Paste'), ing('Zeta Ginger Paste')]);
  assert.equal(brands[0].reason, '“Acme Ginger Paste” and “Zeta Ginger Paste” differ only by “acme” and “zeta”, maybe the brand');
  // Cuts aren't brands.
  assert.deepEqual(pairs([ing('Skinless Chicken Leg'), ing('Boneless Chicken Thigh'), ing('Chicken Thigh and leg')]), []);
});

test('duplicates: a saved receipt name, and pairs marked not the same', () => {
  const list = [ing('Granulated sugar', { uom: 'lb' }), ing('Cane sugar', { uom: 'lb' }), ing('Sugar', { uom: 'lb' })];
  const aliases = [{ ingredientId: 'granulated-sugar', alias: 'CANE SUGAR' }];
  const found = findDuplicates(list, { aliases });
  assert.deepEqual(found.map((p) => [p.merge.name, p.keep.name, p.kind]), [
    ['Cane sugar', 'Granulated sugar', 'alias'],
    ['Sugar', 'Granulated sugar', 'name'],
    ['Sugar', 'Cane sugar', 'words'],
  ]);
  assert.equal(found[0].reason, '“CANE SUGAR” is a receipt name saved for Granulated sugar');
  assert.deepEqual(pairs(list, { aliases, dismissed: [['sugar', 'granulated-sugar'], ['cane-sugar', 'sugar']] }), [['Cane sugar', 'Granulated sugar', 'alias']]);
});

test('the suggested keeper: a real unit, then the more specific name, then more history', () => {
  assert.equal(preferredKeep(ing('Sugar', { uom: 'lb' }), ing('Granulated sugar', { uom: 'box' })).name, 'Sugar');
  assert.equal(preferredKeep(ing('Sugar', { uom: 'lb' }), ing('Granulated sugar', { uom: 'lb' })).name, 'Granulated sugar');
  // A pack size in the name isn't more specific.
  assert.equal(preferredKeep(ing('Cocoa powder 8 oz', { uom: 'oz' }), ing('Cocoa powder', { uom: 'lb', purchaseCount: 2 })).name, 'Cocoa powder');
  assert.equal(preferredKeep(ing('Onion', { purchaseCount: 1 }), ing('Onions', { purchaseCount: 2, recipeCount: 1 })).name, 'Onions');
});

test('receipt wording finds ingredients that share its words', () => {
  const ingredients = [
    { id: 1, name: 'Baby spinach' },
    { id: 2, name: 'Spinach' },
    { id: 3, name: 'Chicken thighs, boneless' },
    { id: 4, name: 'Chicken' },
    { id: 5, name: 'Plum tomatoes' },
    { id: 6, name: 'Romaine', aliases: ['KS ROMAINE HEARTS'] },
  ];
  const ids = (name) => wordMatches(name, ingredients).map((m) => m.id);
  assert.deepEqual(ids('KS ORG BABY SPINACH 2LB'), [1, 2]);
  assert.deepEqual(ids('CHICKEN THIGH BNLS'), [3, 4]); // two words beat one
  assert.deepEqual(ids('PLUM TOMAT'), [5]); // a cut-short word matches the word it begins
  assert.deepEqual(ids('ROMAINE HEARTS 3CT'), [6]); // through a saved receipt name
  assert.deepEqual(wordMatches('KS ORG 2LB', ingredients), []); // nothing but filler
  assert.deepEqual(wordMatches('PLUM TOMAT', ingredients)[0].words, ['plum', 'tomato']);
});

test('receipt wording: whole words over cut-short ones, colors alone, and a strong match', () => {
  const ingredients = [
    { id: 'chicken', name: 'Chicken' }, { id: 'chickpea', name: 'Chickpea' }, { id: 'onion', name: 'Onion Red' },
    { id: 'cilantro', name: 'Cilantro' }, { id: 'stems', name: 'Cilantro stems' }, { id: 'potato', name: 'Potato' },
  ];
  const ids = (name) => wordMatches(name, ingredients).map((m) => m.id);
  assert.deepEqual(ids('Goya Chick Peas 29oz'), ['chickpea']); // "chick" no longer finds Chicken first
  assert.deepEqual(ids('Khazana Basmati Ultra (Red) 10lb'), []); // only a color in common
  assert.deepEqual(ids('GROCERY'), []);
  const [cilantro, stems] = wordMatches('CILANTRO MEX', ingredients);
  assert.equal(cilantro.strong, true); // all its words, and nothing else as good
  assert.equal(stems.strong, false);
  assert.equal(wordMatches('POTATOES IDAHO US', ingredients)[0].strong, true);
  assert.equal(wordMatches('KOREAN SWT POTATO', ingredients)[0].strong, false); // two of its three words aren't Potato
});
