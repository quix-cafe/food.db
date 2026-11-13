// Kitchen units for spice blends: everything converts to grams, so a blend's pie chart
// slices are true to size. Volumes convert through an approximate density for ground spices.

import { Decimal, toDecimal, unitPrice } from './calc.js';

/** Volume units, in teaspoons. */
const TSP = {
  smidgen: 1 / 32, pinch: 1 / 16, dash: 1 / 8,
  tsp: 1, tbsp: 3, 'fl oz': 6, cup: 48, pt: 96, qt: 192, gal: 768,
  ml: 0.202884, l: 202.884,
};

/** Weight units, in grams. */
const GRAMS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

/** Counted units, by a typical weight in grams: a bunch of herbs is about 75 g (2.6 oz), a clove of garlic 7 g (8 to 2 oz). */
const COUNT_GRAMS = { bunch: 75, clove: 7 };

/** Ground spices weigh roughly 2–3 g per teaspoon; used only to put weights and volumes on one scale. */
export const SPICE_GRAMS_PER_TSP = 2.5;

/** Sauces are mostly liquid, so their volumes weigh about what water does (4.93 g per tsp). */
export const SAUCE_GRAMS_PER_TSP = 4.93;

/** Units offered when building a blend, smallest first. */
export const BLEND_UNITS = ['pinch', 'dash', 'tsp', 'tbsp', 'cup', 'g', 'oz', 'bunch'];

/** Units offered when building a sauce, smallest first. */
export const SAUCE_UNITS = ['pinch', 'dash', 'tsp', 'tbsp', 'fl oz', 'cup', 'pt', 'qt', 'gal', 'g', 'oz', 'lb', 'bunch'];

/** A spice blend is measured in this unit: its batch size, and its amount on a recipe line. */
export const BLEND_UOM = 'g';

/** A sauce is measured in (fluid) ounces; one batch fills one of these containers. */
export const SAUCE_UOM = 'oz';
export const SAUCE_CONTAINERS = { '1/4 qt': 8, '1/2 qt': 16, '1 qt': 32, '1 gal': 128 };

const ALIASES = {
  teaspoon: 'tsp', t: 'tsp', tablespoon: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  'fluid ounce': 'fl oz', floz: 'fl oz', ounce: 'oz', gram: 'g', gm: 'g', kilogram: 'kg',
  pound: 'lb', lbs: 'lb', liter: 'l', litre: 'l', milliliter: 'ml', millilitre: 'ml',
  pint: 'pt', quart: 'qt', gallon: 'gal', cups: 'cup', pinches: 'pinch', dashes: 'dash', bunches: 'bunch', bn: 'bunch', cloves: 'clove',
};

/** Garlic itself, not a product made from it ("Garlic powder"). */
const FRESH_GARLIC = /\bgarlic\b(?!.*\b(powder|granulated|salt|oil|paste|sauce|bread)\b)/i;

/** Units only some ingredients can be measured in, by name: garlic comes in cloves. */
export function unitsForName(name) {
  return FRESH_GARLIC.test(String(name ?? '')) ? ['clove'] : [];
}

/**
 * How an ingredient's unit of measure is stored, so "Lb", "LBS" and "lb" are one unit: a kitchen
 * unit's own name, "each" for ea/ct/pc, anything else lowercased ("Box" → "box"). Null when blank.
 */
export function canonicalUom(unit) {
  const u = String(unit ?? '').trim().replace(/\s+/g, ' ');
  if (!u) return null;
  if (/^(ea|each|ct|pc|pcs|piece|pieces|count)$/i.test(u)) return 'each';
  return normalizeUnit(u) ?? u.toLowerCase();
}

/** Canonical unit name ("Tablespoons" → "tbsp"), or null when it isn't a known kitchen unit. */
export function normalizeUnit(unit) {
  let u = String(unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!u) return null;
  if (kind(u)) return u;
  if (ALIASES[u]) return ALIASES[u];
  const singular = u.replace(/(es|s)$/, '');
  if (kind(singular)) return singular;
  return ALIASES[singular] ?? null;
}

const kind = (u) => (TSP[u] !== undefined ? 'volume' : GRAMS[u] !== undefined ? 'weight' : COUNT_GRAMS[u] !== undefined ? 'count' : null);

const sameUnit = (a, b) => {
  const x = String(a ?? '').trim().toLowerCase();
  return !!x && x === String(b ?? '').trim().toLowerCase();
};

/**
 * Convert `amount` between kitchen units: weight ↔ volume via `gramsPerTsp` (the spice density
 * unless given), and a bunch by its typical weight. Any unit converts to itself, so an item can
 * be measured in its ingredient's own unit ("box"). Null if either unit is unknown.
 */
export function convertUnits(amount, from, to, gramsPerTsp = SPICE_GRAMS_PER_TSP) {
  const a = toDecimal(amount);
  if (a !== null && sameUnit(from, to)) return a;
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (a === null || !f || !t) return null;
  const grams = { volume: TSP, weight: GRAMS, count: COUNT_GRAMS };
  const tsp = kind(f) === 'volume' ? a.times(TSP[f]) : a.times(grams[kind(f)][f]).div(gramsPerTsp);
  return kind(t) === 'volume' ? tsp.div(TSP[t]) : tsp.times(gramsPerTsp).div(grams[kind(t)][t]);
}

/**
 * How many `to` one `from` is, between ingredient units of measure: 1 for the same unit, and
 * weight↔weight or volume↔volume exactly. Never across weight and volume (the spice density
 * above is wrong for most ingredients); null when there's no exact answer (box → lb).
 */
export function unitRatio(from, to) {
  if (sameUnit(from, to)) return new Decimal(1);
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (!f || !t || kind(f) !== kind(t) || kind(f) === 'count') return null;
  return kind(f) === 'volume' ? new Decimal(TSP[f]).div(TSP[t]) : new Decimal(GRAMS[f]).div(GRAMS[t]);
}

/** Kitchen units a recipe line can be measured in, by kind. */
const RECIPE_UNITS = { weight: ['oz', 'lb', 'g', 'kg'], volume: ['tsp', 'tbsp', 'cup', 'fl oz', 'pt', 'qt', 'gal', 'ml', 'l'] };

/**
 * What one cup of an ingredient weighs, in grams, when it doesn't say: a few dry goods and
 * liquids by name (rice about 185 g), else null. Liquids come first, so "Rice vinegar" is a liquid.
 */
const CUP_GRAMS_BY_NAME = [
  [/\b(water|milk|stock|broth|vinegar|juice|cream)\b/i, 240], [/\boil\b/i, 218],
  [/\bflour\b/i, 125], [/\bbrown sugar\b/i, 220], [/\bpowdered sugar\b/i, 120], [/\bsugar\b/i, 200],
  [/\brice\b(?!.*\b(noodles?|paper|cakes?)\b)/i, 185], [/\bquinoa\b/i, 170], [/\blentils?\b/i, 190],
  [/\b(oats?|oatmeal)\b/i, 90], [/\b(dried beans?|chickpeas?|chick peas)\b/i, 180], [/\bsalt\b/i, 290],
];
export function estimatedCupGrams(name) {
  const hit = CUP_GRAMS_BY_NAME.find(([re]) => re.test(String(name ?? '')));
  return hit ? hit[1] : null;
}

/** What a cup of the ingredient weighs: its own `cupGrams`, else estimatedCupGrams by name; null when unknown. */
export const cupGramsOf = ({ cupGrams = null, name = null } = {}) => toDecimal(cupGrams) ?? (estimatedCupGrams(name) === null ? null : new Decimal(estimatedCupGrams(name)));

/**
 * A recipe line's `amount` in `unit` (null or blank: the ingredient's own) as the ingredient's
 * `uom`: the same unit as is, weight↔weight and volume↔volume exactly, and weight↔volume through
 * what a cup of it weighs (cupGramsOf: rice bought by the lb and used by the cup). Null when it
 * can't be worked out.
 */
export function lineAmountInUom(amount, unit, ingredient = {}) {
  const a = toDecimal(amount);
  const { uom = null } = ingredient;
  if (a === null) return null;
  if (!String(unit ?? '').trim() || sameUnit(unit, uom)) return a;
  const ratio = unitRatio(unit, uom);
  if (ratio) return a.times(ratio);
  const f = normalizeUnit(unit);
  const t = normalizeUnit(uom);
  const kinds = new Set([f && kind(f), t && kind(t)]);
  if (!kinds.has('weight') || !kinds.has('volume')) return null;
  const cup = cupGramsOf(ingredient);
  return cup ? convertUnits(a, f, t, cup.div(TSP.cup)) : null;
}

/**
 * The units a recipe line of this ingredient can be measured in: its own unit first, then the
 * kitchen units of the same kind, then (when a cup of it has a weight) those of the other kind.
 * Only its own for a unit kitchen measures don't reach (each, box).
 */
export function recipeUnits(ingredient = {}) {
  const own = ingredient.uom ?? 'each';
  const k = normalizeUnit(own) && kind(normalizeUnit(own));
  if (k !== 'weight' && k !== 'volume') return [own];
  const other = k === 'weight' ? 'volume' : 'weight';
  const units = [own, ...RECIPE_UNITS[k].filter((u) => u !== normalizeUnit(own))];
  if (cupGramsOf(ingredient)) units.push(...RECIPE_UNITS[other]);
  return units;
}

/** Parse "1 1/2", "3/4", "½" or "0.5" into a Decimal; null if it isn't an amount. */
export function parseAmount(text) {
  const s = String(text ?? '').trim()
    .replace(/½/g, ' 1/2').replace(/¼/g, ' 1/4').replace(/¾/g, ' 3/4').replace(/⅓/g, ' 1/3').replace(/⅔/g, ' 2/3').replace(/⅛/g, ' 1/8')
    .trim();
  const m = s.match(/^(\d+(?:\.\d+)?)?\s*(?:(\d+)\s*\/\s*(\d+))?$/);
  if (!s || !m || (!m[1] && !m[2])) return toDecimal(s);
  let d = new Decimal(m[1] ?? 0);
  if (m[2]) {
    if (Number(m[3]) === 0) return null;
    d = d.plus(new Decimal(m[2]).div(m[3]));
  }
  return d;
}

/**
 * Amounts ("1 1/2", "30") for a new size per serving: a bigger serving takes proportionally more of
 * everything, so cost per serving follows. Unchanged unless both sizes are above 0, or for an
 * amount that isn't a number yet.
 */
export function scaleAmounts(amounts, fromSize, toSize) {
  const from = parseAmount(fromSize);
  const to = parseAmount(toSize);
  if (!from?.gt(0) || !to?.gt(0)) return amounts;
  return amounts.map((a) => parseAmount(a)?.times(to).div(from).toDecimalPlaces(4).toString() ?? a);
}

/** One of a unit kitchen measures can't reach is taken to weigh about this: a box 750 g, a small fresh chili 2 g, anything else (can, jar, each) 75 g like a bunch. */
export const ESTIMATED_UNIT_GRAMS = COUNT_GRAMS.bunch;
const ESTIMATED_GRAMS_BY_UNIT = { box: 750, boxes: 750, chili: 2, chilis: 2, chilies: 2, chile: 2, chiles: 2 };

/** The estimated weight in grams of one `unit` when its ingredient doesn't say. */
export function estimatedUnitGrams(unit) {
  return ESTIMATED_GRAMS_BY_UNIT[String(unit ?? '').trim().toLowerCase()] ?? ESTIMATED_UNIT_GRAMS;
}

/**
 * An item's `amount` in `unit` as grams (for a blend's pie chart) and in its ingredient's `uom`
 * (for its cost), each null when it can't be worked out. `unitGrams` is what one of the
 * ingredient's units weighs ("1 box = 85 g"), for units like box that kitchen units can't reach;
 * without it one weighs estimatedUnitGrams (a box 750 g, others 75 g).
 */
export function itemAmounts(amount, unit, { uom = null, unitGrams = null } = {}, gramsPerTsp = SPICE_GRAMS_PER_TSP) {
  const a = toDecimal(amount);
  const per = toDecimal(unitGrams) ?? new Decimal(estimatedUnitGrams(uom));
  let grams = convertUnits(amount, unit, BLEND_UOM, gramsPerTsp);
  if (!grams && a !== null && String(unit ?? '').trim() && !normalizeUnit(unit)) {
    grams = a.times(sameUnit(unit, uom) ? per : estimatedUnitGrams(unit));
  }
  let inUom = uom ? convertUnits(amount, unit, uom, gramsPerTsp) : null;
  if (!inUom && grams && uom && !normalizeUnit(uom)) inUom = grams.div(per);
  return { grams, inUom };
}

/**
 * Break a blend down for its pie chart and cost.
 * items: [{ name, amount, unit, packPrice?, packSize?, uom?, unitGrams? }] — the price fields come from a
 *   linked ingredient's latest purchase. An item costs packPrice / packSize per `uom`,
 *   converted from the blend's unit; it's left out of the cost when that isn't possible
 *   (no price, or an ingredient measured "each" with the item in tsp).
 * kind 'sauce' weighs volumes like water, and its batch is its container (in oz) rather
 *   than the weight of what goes in. `uom` and `batchSize` are how a recipe measures it.
 *   Its `servingOz` is the serving size (a sauce saved without one: the container ÷ its servings).
 */
export function calculateBlend(items = [], { kind: blendKind = 'spice', container = null, servings = 1, servingOz = null } = {}) {
  const sauce = blendKind === 'sauce';
  const density = sauce ? SAUCE_GRAMS_PER_TSP : SPICE_GRAMS_PER_TSP;
  let totalGrams = new Decimal(0);
  let cost = new Decimal(0);
  let costed = 0;
  const rows = items.map((it) => {
    const { grams, inUom } = itemAmounts(it.amount, it.unit, it, density);
    if (grams) totalGrams = totalGrams.plus(grams);
    let itemCost = null;
    const price = toDecimal(it.packPrice);
    if (price !== null && inUom) itemCost = unitPrice(price, it.packSize).times(inUom);
    if (itemCost) {
      cost = cost.plus(itemCost);
      costed += 1;
    }
    return { ...it, grams, itemCost };
  });
  const batch = sauce && SAUCE_CONTAINERS[container] ? new Decimal(SAUCE_CONTAINERS[container]) : null;
  const serving = sauce ? toDecimal(servingOz) ?? (batch ? batch.div(toDecimal(servings) ?? 1) : null) : null;
  return {
    items: rows.map((r) => ({
      ...r,
      grams: r.grams ? r.grams.toFixed(4) : null,
      share: r.grams && !totalGrams.isZero() ? r.grams.div(totalGrams).times(100).toFixed(1) : null,
      cost: r.itemCost ? r.itemCost.toFixed(4) : null,
      itemCost: undefined,
    })),
    totalGrams: totalGrams.toFixed(4),
    uom: sauce ? SAUCE_UOM : BLEND_UOM,
    batchSize: sauce ? (batch ? batch.toFixed(4) : null) : totalGrams.toFixed(4),
    ...(sauce ? { servingOz: serving && serving.gt(0) ? serving.toFixed(4) : null } : {}),
    cost: costed ? cost.toFixed(4) : null,
    costComplete: costed === items.length && items.length > 0,
    costPerGram: costed && !totalGrams.isZero() ? cost.div(totalGrams).toFixed(4) : null,
  };
}
