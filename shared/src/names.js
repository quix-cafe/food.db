// Spotting ingredients that are probably one thing under two names ("Granulated sugar" and
// "Sugar", "Tortillas" and "Tortilla 16 ct", "Chick pea" and "Chickpea") so they can be merged.
// These are suggestions only: a person confirms every merge.

import { normalizeUnit } from './units.js';

/** Grade or variety words that don't make it a different thing to buy or cost. */
export const DESCRIPTORS = new Set([
  'granulated', 'kosher', 'table', 'sea', 'fine', 'coarse', 'iodized', 'fresh', 'whole', 'raw', 'organic',
  'natural', 'plain', 'pure', 'large', 'medium', 'small', 'jumbo', 'extra', 'premium', 'classic',
]);

/**
 * Where it was grown, how a store sells it, and whose brand it is: not what it is. "LIMES SEEDLES MEXICO" is
 * limes and "SHAN GINGER PASTE" ginger paste. The brands are ones seen on receipts, store codes ("EE", "WC")
 * included; a brand of two words is in BRAND_PHRASES.
 */
const RECEIPT_FILLER = new Set([
  'usa', 'us', 'mex', 'mexico', 'imported', 'loose', 'seedless', 'seedles', 'bunch', 'bunches',
  'shan', 'national', 'hunts', 'hunt', 'goya', 'laxmi', 'khazana', 'pinar', 'mazola', 'guerrero', 'pepperidge', 'kyj', 'rajbhog',
  '3river', 'swad', 'deep', 'desi', 'kirkland', 'ks', 'gv', 'ee', 'wc', 'cf', 'ck',
]);
const BRAND_PHRASES = /\b(pep(peridge)? farms?|bombay kitchen|great value|essential everyday|hunt'?s)\b/g;

/** Receipt shorthand for whole words: "SWT BELL PEPPER", "ONIONS YELL", "CF L BRWN EGGS". */
const ABBREVIATIONS = {
  swt: 'sweet', yell: 'yellow', yel: 'yellow', ylw: 'yellow', brwn: 'brown', brn: 'brown', grn: 'green', wht: 'white',
  carr: 'carrot', chk: 'chicken', ckn: 'chicken', mush: 'mushroom', mshrm: 'mushroom', bnls: 'boneless', sknls: 'skinless',
};
const ABBREVIATION = new RegExp(`\\b(${Object.keys(ABBREVIATIONS).join('|')})\\b`, 'g');

/** Different names for one thing, made one word: green onions are scallions, dahi is yogurt. */
const SYNONYMS = [
  [/\b(green|spring) onions?\b/g, 'scallion'],
  [/\b(dahi|yoghurt)\b/g, 'yogurt'],
  [/\b(gol ?gapp?[ae]s?|golpappi|pani ?puris?)\b/g, 'panipuri'],
  [/\bcrimini\b/g, 'cremini'],
  [/\b(chick ?peas?|garbanzos?(?: beans?)?)\b/g, 'chickpea'],
  [/\bcourgettes?\b/g, 'zucchini'],
];

const NUMBER = /^x?\d+(_\d+)?$/;
const PACK_WITH_UNIT = /^x?\d+(_\d+)?(ct|count|pk|pack|pc|pcs|oz|lb|lbs|g|kg|ml|l|qt|gal|dz|doz)$/;
const PACK_UNIT = new Set(['ct', 'count', 'pk', 'pack', 'pc', 'pcs', 'oz', 'lb', 'lbs', 'g', 'kg', 'ml', 'l', 'qt', 'gal', 'dz', 'doz']);

/** Plurals and their singulars meet in one form: berries/berry → berri, potatoes → potato. */
function stem(word) {
  if (word.length <= 3) return word;
  let w = word;
  if (w.endsWith('ies')) w = `${w.slice(0, -3)}i`;
  else if (w.endsWith('oes') || /(ch|sh|x)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.endsWith('y')) w = `${w.slice(0, -1)}i`;
  else if (w.endsWith('ie')) w = w.slice(0, -1);
  return w;
}

/**
 * A name reduced to what identifies the ingredient: lowercase, no accents or punctuation,
 * receipt shorthand spelled out, other names for the same thing made one, without pack sizes
 * ("16 ct", "50LB"), grade words or where it's from, plurals folded, and the words in order
 * ("TOMATO PLUM" and "Plum tomato" are one). `dropped` lists what was taken out and `synonyms`
 * what was renamed, for explaining a match.
 */
export function nameParts(name) {
  const synonyms = [];
  const dropped = [];
  let text = String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(BRAND_PHRASES, (b) => { dropped.push(b); return ' '; })
    .replace(ABBREVIATION, (w) => ABBREVIATIONS[w]);
  for (const [pattern, one] of SYNONYMS) {
    text = text.replace(pattern, (found) => {
      if (found.replace(/\s+/g, ' ') !== one) synonyms.push(`${found} → ${one}`);
      return one;
    });
  }
  const words = text
    .replace(/(\d)\.(\d)/g, '$1_$2')
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (NUMBER.test(w) && PACK_UNIT.has(words[i + 1])) {
      dropped.push(`${w.replace('_', '.')} ${words[i + 1]}`);
      i++;
    } else if (NUMBER.test(w) || PACK_WITH_UNIT.test(w)) {
      dropped.push(w.replace('_', '.'));
    } else if (DESCRIPTORS.has(w) || RECEIPT_FILLER.has(w)) {
      dropped.push(w);
    } else {
      kept.push(stem(w));
    }
  }
  return { key: [...new Set(kept)].sort().join(' '), dropped, synonyms };
}

export const ingredientKey = (name) => nameParts(name).key;

/** Edit distance counting a swap of neighbours as one edit (optimal string alignment). */
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Typos allowed between two keys: none under 5 letters (salt/malt), one from 5, two from 10. */
const allowedEdits = (a, b) => {
  const n = Math.min(a.length, b.length);
  return n >= 10 ? 2 : n >= 5 ? 1 : 0;
};

const uses = (i) => (i.purchaseCount ?? 0) + (i.recipeCount ?? 0);
const letters = (s) => s.replace(/[^\p{L}\p{N}]/gu, '').length;
/** How specific a name is: its letters, counting grade words but not pack sizes or where it's from. */
const specificity = (name) => {
  const { key, dropped } = nameParts(name);
  return letters(key) + dropped.filter((w) => !/\d/.test(w) && !RECEIPT_FILLER.has(w) && !w.match(BRAND_PHRASES)).reduce((n, w) => n + letters(w), 0);
};
/** A receipt's own wording, all capitals ("CILANTRO MEX"), rather than a name someone typed. */
const shouted = (name) => /\p{Lu}{2}/u.test(name) && name === name.toUpperCase();

/**
 * Which of two duplicates to keep: one measured in a real unit (lb, oz, g…) over box/bag/each,
 * then a typed name over a receipt's capitals ("Potato" over "POTATOES IDAHO US"), then the more
 * specific name ("Granulated sugar" over "Sugar"), then the one with more history.
 */
export function preferredKeep(a, b) {
  const measured = (i) => (normalizeUnit(i.uom) ? 1 : 0);
  const order = measured(b) - measured(a)
    || Number(shouted(a.name)) - Number(shouted(b.name))
    || specificity(b.name) - specificity(a.name)
    || uses(b) - uses(a);
  return order > 0 ? b : a;
}

const quote = (s) => `“${s}”`;
const list = (items) => items.map(quote).join(' and ');

/**
 * Likely duplicate pairs among `ingredients` ({ id, name, uom, purchaseCount?, recipeCount? }),
 * strongest first: a receipt name saved for one is the other's name; the names match once pack
 * sizes, grade words and plurals are set aside; or they're spelled almost the same. Labor and
 * pairs in `dismissed` ([[idA, idB]]) are left out. Each pair is { keep, merge, kind, reason },
 * `keep` being the suggested survivor.
 */
export function findDuplicates(ingredients, { aliases = [], dismissed = [] } = {}) {
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const skip = new Set(dismissed.map(([a, b]) => pairKey(a, b)));
  const items = ingredients.map((i) => ({ ...i, ...nameParts(i.name) }));
  const byId = new Map(items.map((i) => [i.id, i]));
  const found = new Map();
  const add = (a, b, kind, reason) => {
    const k = pairKey(a.id, b.id);
    if (a.id === b.id || skip.has(k) || found.has(k)) return;
    const keep = preferredKeep(a, b);
    found.set(k, { keep: strip(keep), merge: strip(keep === a ? b : a), kind, reason });
  };

  const byKey = Map.groupBy(items.filter((i) => i.key), (i) => i.key);
  for (const al of aliases) {
    const owner = byId.get(al.ingredientId);
    const key = ingredientKey(al.alias);
    if (!owner || !key) continue;
    for (const other of byKey.get(key) ?? []) {
      add(owner, other, 'alias', `${quote(al.alias)} is a receipt name saved for ${owner.name}`);
    }
  }

  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        const extra = [...a.dropped.filter((w) => !b.dropped.includes(w)), ...b.dropped.filter((w) => !a.dropped.includes(w))];
        const renamed = [...a.synonyms, ...b.synonyms].filter((x, k, all) => all.indexOf(x) === k);
        add(a, b, 'name', extra.length
          ? `The names differ only by ${list(extra)}`
          : renamed.length
            ? `${quote(a.name)} and ${quote(b.name)} are names for the same thing`
            : 'The names differ only by plural, spacing or punctuation');
      }
    }
  }

  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = [keys[i].replace(/ /g, ''), keys[j].replace(/ /g, '')];
      const max = allowedEdits(a, b);
      if (a !== b && (max === 0 || Math.abs(a.length - b.length) > max || editDistance(a, b) > max)) continue;
      const reason = a === b ? 'The names differ only by spacing' : 'The names are spelled almost the same';
      for (const x of byKey.get(keys[i])) for (const y of byKey.get(keys[j])) add(x, y, 'spelling', reason);
    }
  }

  // Close names, compared on the words that say what it is (3+ letters, no receipt filler, so store codes like
  // "EE" and "WC" fall away): the same words ("EE PEAS CARR" and "WC PEAS AND CARR"); one more word that doesn't
  // make it something else to buy ("Potato" and "POTATOES IDAHO US", but not "Ground Chicken" and "Chicken");
  // or one different word each, after two or more alike, which is usually the brand ("SHAN GINGER PASTE" and
  // "National Ginger Paste"), unless it's a color or a word like "powder".
  const plain = (w) => w.length >= 3 && !PRODUCT_WORDS.has(w) && !COLORS.has(w);
  const keyed = [...byKey.keys()].map((k) => ({ key: k, core: k.split(' ').filter((w) => w.length >= 3 && !RECEIPT_NOISE.has(w)) }))
    .filter((k) => k.core.length);
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const [a, b] = [keyed[i], keyed[j]];
      const onlyA = a.core.filter((w) => !b.core.includes(w));
      const onlyB = b.core.filter((w) => !a.core.includes(w));
      const shared = a.core.length - onlyA.length;
      const pairsOf = (reason) => {
        for (const x of byKey.get(a.key)) for (const y of byKey.get(b.key)) add(x, y, 'words', reason(x, y));
      };
      if (!onlyA.length && !onlyB.length) {
        pairsOf((x, y) => `${quote(x.name)} and ${quote(y.name)} differ only by short words like store codes`);
      } else if (onlyA.length + onlyB.length === 1 && plain(onlyA[0] ?? onlyB[0])) {
        const [small, extra] = onlyA.length ? [b, onlyA[0]] : [a, onlyB[0]];
        pairsOf((x, y) => {
          const [s1, b1] = byKey.get(small.key).includes(x) ? [x, y] : [y, x];
          return `${quote(b1.name)} is ${quote(s1.name)} with “${extra}” added`;
        });
      } else if (onlyA.length === 1 && onlyB.length === 1 && shared >= 2 && plain(onlyA[0]) && plain(onlyB[0])) {
        pairsOf((x, y) => `${quote(x.name)} and ${quote(y.name)} differ only by “${onlyA[0]}” and “${onlyB[0]}”, maybe the brand`);
      }
    }
  }

  const rank = { alias: 0, name: 1, spelling: 2, words: 3 };
  return [...found.values()].sort((p, q) => rank[p.kind] - rank[q.kind] || p.merge.name.localeCompare(q.merge.name));
}

function strip({ key, dropped, ...ingredient }) {
  return ingredient;
}

/** Words that make an ingredient a different thing to buy: ground chicken isn't chicken, cilantro stems aren't cilantro. */
const PRODUCT_WORDS = new Set([
  'ground', 'stem', 'pickled', 'paste', 'sauce', 'powder', 'vinegar', 'oil', 'juice', 'dried', 'frozen', 'canned',
  'sweet', 'smoked', 'sliced', 'diced', 'minced', 'chopped', 'leaf', 'seed', 'flake', 'milk', 'cream', 'butter', 'and',
  // cuts: a thigh isn't a leg, and boneless isn't bone-in
  'thigh', 'leg', 'breast', 'wing', 'drumstick', 'tender', 'fillet', 'loin', 'rib', 'boneless', 'skinless', 'bone',
]);

/** Receipt shorthand and filler that say nothing about which ingredient a line is (stemmed, as matchWords compares them). */
const RECEIPT_NOISE = new Set([
  'org', 'pkg', 'bag', 'box', 'btl', 'can', 'jar', 'bulk', 'brand', 'item', 'the', 'and', 'with', 'for',
  'groceri', 'meat', 'produce', 'deli', 'misc', 'food', 'gal',
]);

/** Colors say which kind, never which ingredient: "Khazana Basmati (Red)" isn't red onion. */
const COLORS = new Set(['red', 'green', 'yellow', 'white', 'black', 'brown', 'orange', 'purple', 'gold', 'golden']);

/** The words of a name worth matching on: stemmed, 3+ letters, no pack sizes, grade words or receipt filler. */
const matchWords = (name) => [...new Set(ingredientKey(name).split(' ')
  .filter((w) => w.length >= 3 && !/\d/.test(w) && !RECEIPT_NOISE.has(w)))];

/**
 * A receipt name that says nothing about what was bought ("GROCERY", "Grocery item", "MEAT"):
 * some stores print one on every line, so it's never saved or applied as a receipt name.
 */
export const isGenericName = (name) => !!String(name ?? '').trim() && !matchWords(name).length;

/** A receipt's words, with neighbours run together too ("CHICK PEAS" also reads "chickpea"). */
function receiptWords(name) {
  const words = matchWords(name);
  const all = ingredientKey(name).split(' ');
  // ingredientKey sorts its words, so pair them as printed instead.
  const printed = String(name ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i + 1 < printed.length; i++) {
    const joined = ingredientKey(printed[i] + printed[i + 1]);
    if (joined.length >= 5 && !all.includes(joined)) words.push(joined);
  }
  return [...new Set(words)];
}

/**
 * Ingredients a receipt's wording might be, by the words they share: "KS ORG BABY SPINACH 2LB"
 * finds "Baby spinach" and "Spinach". A receipt word of 4+ letters also matches a word it begins,
 * for stores that cut words short ("TOMAT" finds tomatoes). Each of `ingredients` ({ id, name,
 * aliases?: [] , … }) scores its best name or saved receipt name: the most words matched, then the
 * largest share of its own words. Best first, at most `limit`; each comes back with `words`, the
 * words it matched on.
 */
export function wordMatches(receiptName, ingredients, limit = 5) {
  const wanted = receiptWords(receiptName);
  if (!wanted.length) return [];
  const printed = matchWords(receiptName).length;
  const exactly = (w) => wanted.includes(w);
  const hit = (w) => exactly(w) || wanted.some((r) => r.length >= 4 && w.startsWith(r));
  const scored = [];
  for (const ing of ingredients) {
    let best = null;
    for (const name of [ing.name, ...(ing.aliases ?? [])]) {
      const own = matchWords(name);
      const words = own.filter(hit);
      if (!words.length || words.every((w) => COLORS.has(w))) continue;
      const score = { words, exact: words.filter(exactly).length, share: words.length / own.length };
      if (!best || words.length > best.words.length || (words.length === best.words.length && (score.exact > best.exact || (score.exact === best.exact && score.share > best.share)))) best = score;
    }
    if (best) scored.push({ ing, ...best });
  }
  scored.sort((a, b) => b.words.length - a.words.length || b.exact - a.exact || b.share - a.share || a.ing.name.length - b.ing.name.length);
  return scored
    .slice(0, limit)
    .map(({ ing, words, share }, i) => ({
      ...ing,
      words,
      // Strong: every word of its name is on the receipt, they're at least half the receipt's words, and nothing else does as well.
      strong: i === 0 && share === 1 && words.length * 2 >= printed
        && !(scored[1] && scored[1].share === 1 && scored[1].words.length === words.length),
    }));
}

/**
 * A tidier name for a new ingredient than the receipt's wording, and the pack size printed in it:
 * "Laxmi Garam Masala Powder 14oz" → "Laxmi Garam Masala Powder", 14 oz; "SWT BELL PEPPER 4P" →
 * "Sweet Bell Pepper", 4 each; "CILANTRO MEX" → "Cilantro". Capitals are tidied only on an all-capitals
 * name. The receipt's wording is kept as a receipt name, so it still matches.
 */
export function receiptName(text) {
  let rest = String(text ?? '').trim();
  let packSize = null;
  let uom = null;
  // "4P" is a 4-pack and "2L" two litres, but "OMG 3 L BRWN EGG" is omega-3 large eggs: those two only when written together.
  const size = /(?:^|\s)(\d+(?:\.\d+)?)(?:\s*(oz|lb|lbs|g|kg|ml|qt|gal|ct|count|pk|pack)|(l|p))\b\.?/i.exec(rest);
  if (size) {
    packSize = String(Number(size[1]));
    const unit = (size[2] ?? size[3]).toLowerCase();
    uom = ['ct', 'count', 'pk', 'pack', 'p'].includes(unit) ? 'each' : unit === 'lbs' ? 'lb' : unit;
    rest = (rest.slice(0, size.index) + rest.slice(size.index + size[0].length)).trim();
  }
  rest = rest.replace(new RegExp(BRAND_PHRASES.source, 'gi'), ' ').trim();
  const caps = rest === rest.toUpperCase();
  const words = rest.split(/\s+/).filter((w) => w && !RECEIPT_FILLER.has(w.toLowerCase()));
  const name = words
    .map((w) => {
      const lower = w.toLowerCase();
      const full = ABBREVIATIONS[lower] ?? (caps ? lower : w);
      return caps ? full.replace(/(^|[-/(])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : full;
    })
    .join(' ')
    .replace(/[\s,;:-]+$/, '');
  return { name: name || String(text ?? '').trim(), packSize, uom };
}
