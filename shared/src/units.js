// Kitchen units for spice blends: everything converts to teaspoons, so a blend's pie chart
// slices are true to size. Weights convert through an approximate density for ground spices.

import { Decimal, toDecimal, unitPrice } from './calc.js';

/** Volume units, in teaspoons. */
const TSP = {
  smidgen: 1 / 32, pinch: 1 / 16, dash: 1 / 8,
  tsp: 1, tbsp: 3, 'fl oz': 6, cup: 48, pt: 96, qt: 192, gal: 768,
  ml: 0.202884, l: 202.884,
};

/** Weight units, in grams. */
const GRAMS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

/** Ground spices weigh roughly 2–3 g per teaspoon; used only to put weights and volumes on one scale. */
export const SPICE_GRAMS_PER_TSP = 2.5;

/** Units offered when building a blend, smallest first. */
export const BLEND_UNITS = ['pinch', 'dash', 'tsp', 'tbsp', 'cup', 'g', 'oz'];

const ALIASES = {
  teaspoon: 'tsp', t: 'tsp', tablespoon: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  'fluid ounce': 'fl oz', floz: 'fl oz', ounce: 'oz', gram: 'g', gm: 'g', kilogram: 'kg',
  pound: 'lb', lbs: 'lb', liter: 'l', litre: 'l', milliliter: 'ml', millilitre: 'ml',
  pint: 'pt', quart: 'qt', gallon: 'gal', cups: 'cup', pinches: 'pinch', dashes: 'dash',
};

/** Canonical unit name ("Tablespoons" → "tbsp"), or null when it isn't a known kitchen unit. */
export function normalizeUnit(unit) {
  let u = String(unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!u) return null;
  if (TSP[u] !== undefined || GRAMS[u] !== undefined) return u;
  if (ALIASES[u]) return ALIASES[u];
  const singular = u.replace(/(es|s)$/, '');
  if (TSP[singular] !== undefined || GRAMS[singular] !== undefined) return singular;
  return ALIASES[singular] ?? null;
}

const kind = (u) => (TSP[u] !== undefined ? 'volume' : GRAMS[u] !== undefined ? 'weight' : null);

/** Convert `amount` between kitchen units (weight ↔ volume via the spice density); null if either unit is unknown. */
export function convertUnits(amount, from, to) {
  const a = toDecimal(amount);
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (a === null || !f || !t) return null;
  const tsp = kind(f) === 'volume' ? a.times(TSP[f]) : a.times(GRAMS[f]).div(SPICE_GRAMS_PER_TSP);
  return kind(t) === 'volume' ? tsp.div(TSP[t]) : tsp.times(SPICE_GRAMS_PER_TSP).div(GRAMS[t]);
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
 * Break a blend down for its pie chart and cost.
 * items: [{ name, amount, unit, packPrice?, packSize?, uom? }] — the price fields come from a
 *   linked ingredient's latest purchase. An item costs packPrice / packSize per `uom`,
 *   converted from the blend's unit; it's left out of the cost when that isn't possible
 *   (no price, or an ingredient measured "each").
 */
export function calculateBlend(items = []) {
  let totalTsp = new Decimal(0);
  let cost = new Decimal(0);
  let costed = 0;
  const rows = items.map((it) => {
    const tsp = convertUnits(it.amount, it.unit, 'tsp');
    if (tsp) totalTsp = totalTsp.plus(tsp);
    let itemCost = null;
    const price = toDecimal(it.packPrice);
    if (price !== null && it.uom) {
      const inUom = convertUnits(it.amount, it.unit, it.uom);
      if (inUom) itemCost = unitPrice(price, it.packSize).times(inUom);
    }
    if (itemCost) {
      cost = cost.plus(itemCost);
      costed += 1;
    }
    return { ...it, tsp, itemCost };
  });
  return {
    items: rows.map((r) => ({
      ...r,
      tsp: r.tsp ? r.tsp.toFixed(4) : null,
      share: r.tsp && !totalTsp.isZero() ? r.tsp.div(totalTsp).times(100).toFixed(1) : null,
      cost: r.itemCost ? r.itemCost.toFixed(4) : null,
      itemCost: undefined,
    })),
    totalTsp: totalTsp.toFixed(4),
    cost: costed ? cost.toFixed(4) : null,
    costComplete: costed === items.length && items.length > 0,
    costPerTsp: costed && !totalTsp.isZero() ? cost.div(totalTsp).toFixed(4) : null,
  };
}
