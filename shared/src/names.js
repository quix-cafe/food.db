// Spotting ingredients that are probably one thing under two names ("Granulated sugar" and
// "Sugar", "Tortillas" and "Tortilla 16 ct", "Chick pea" and "Chickpea") so they can be merged.
// These are suggestions only: a person confirms every merge.

import { isLabor } from './calc.js';
import { normalizeUnit } from './units.js';

/** Grade or variety words that don't make it a different thing to buy or cost. */
export const DESCRIPTORS = new Set([
  'granulated', 'kosher', 'table', 'sea', 'fine', 'coarse', 'iodized', 'fresh', 'whole', 'raw', 'organic',
  'natural', 'plain', 'pure', 'large', 'medium', 'small', 'jumbo', 'extra', 'premium', 'classic',
]);

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
 * without pack sizes ("16 ct", "50LB") or grade words, plurals folded. `dropped` lists what was
 * taken out, for explaining a match.
 */
export function nameParts(name) {
  const words = String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(\d)\.(\d)/g, '$1_$2')
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  const kept = [];
  const dropped = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (NUMBER.test(w) && PACK_UNIT.has(words[i + 1])) {
      dropped.push(`${w.replace('_', '.')} ${words[i + 1]}`);
      i++;
    } else if (NUMBER.test(w) || PACK_WITH_UNIT.test(w)) {
      dropped.push(w.replace('_', '.'));
    } else if (DESCRIPTORS.has(w)) {
      dropped.push(w);
    } else {
      kept.push(stem(w));
    }
  }
  return { key: kept.join(' '), dropped };
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
/** How specific a name is: its letters, counting grade words but not pack sizes. */
const specificity = (name) => {
  const { key, dropped } = nameParts(name);
  return letters(key) + dropped.filter((w) => !/\d/.test(w)).reduce((n, w) => n + letters(w), 0);
};

/**
 * Which of two duplicates to keep: one measured in a real unit (lb, oz, g…) over box/bag/each,
 * then the more specific name ("Granulated sugar" over "Sugar"), then the one with more history.
 */
export function preferredKeep(a, b) {
  const measured = (i) => (normalizeUnit(i.uom) ? 1 : 0);
  const order = measured(b) - measured(a)
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
  const items = ingredients.filter((i) => !isLabor(i)).map((i) => ({ ...i, ...nameParts(i.name) }));
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
        add(a, b, 'name', extra.length
          ? `The names differ only by ${list(extra)}`
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

  const rank = { alias: 0, name: 1, spelling: 2 };
  return [...found.values()].sort((p, q) => rank[p.kind] - rank[q.kind] || p.merge.name.localeCompare(q.merge.name));
}

function strip({ key, dropped, ...ingredient }) {
  return ingredient;
}
