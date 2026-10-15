// Costing math shared by the API and the browser, so the instant scaling in the
// recipe builder and the server's numbers can never disagree. Every amount goes
// through decimal.js; numbers are returned as strings to keep JSON float-free.

import DecimalBase from 'decimal.js';

export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });

export const DEFAULT_MARGIN = 70;
export const COST_DP = 4;
export const MONEY_DP = 2;

export class CalcError extends Error {}

const LABOR = /^labou?r$/i;

/** Labor is costed like an ingredient but always listed last: category or name "Labor". */
export const isLabor = (item) => LABOR.test((item?.category ?? '').trim()) || LABOR.test((item?.name ?? '').trim());

/** Stable reorder that keeps relative order but moves labor to the end. */
export const laborLast = (items) => [...items.filter((i) => !isLabor(i)), ...items.filter(isLabor)];

/** Parse a number/string into a Decimal, or null when blank or not numeric. */
export function toDecimal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  try {
    const d = new Decimal(typeof value === 'string' ? value.trim() : value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

const cost = (d) => d.toFixed(COST_DP);
const money = (d) => d.toFixed(MONEY_DP);

/** Price per unit of measure = store pack price / pack size (a missing pack size is 1). */
export function unitPrice(packPrice, packSize) {
  const size = toDecimal(packSize);
  return new Decimal(packPrice).div(size && size.gt(0) ? size : 1);
}

/** Line Item Cost = Price_Per_Unit × Amount_Used */
export function lineCost(pricePerUnit, amount) {
  return new Decimal(pricePerUnit).times(amount);
}

/** Scale = Expected_Servings / Base_Servings */
export function scaleFactor(expectedServings, baseServings) {
  return new Decimal(expectedServings).div(baseServings);
}

/** Recommended Price = Cost_Per_Serving / (1 − Target_Margin / 100) */
export function recommendedPrice(costPerServing, targetMargin) {
  const m = new Decimal(targetMargin);
  if (m.lt(0) || m.gte(100)) throw new CalcError('Target margin must be at least 0 and below 100');
  return new Decimal(costPerServing).div(new Decimal(1).minus(m.div(100)));
}

/** Percentage change from `previous` to `current`, or null when not computable. */
export function percentChange(previous, current) {
  const p = toDecimal(previous);
  const c = toDecimal(current);
  if (!p || !c || p.isZero()) return null;
  return c.minus(p).div(p).times(100);
}

/** Fill in whichever of unit cost / total cost is missing from the other and quantity. */
export function completePurchaseCosts({ quantity, unitCost, totalCost }) {
  const q = toDecimal(quantity);
  let u = toDecimal(unitCost);
  let t = toDecimal(totalCost);
  if (!q || q.lte(0)) throw new CalcError('Quantity must be greater than 0');
  if (u === null && t === null) throw new CalcError('Enter a unit cost or a total cost');
  if (u === null) u = t.div(q);
  if (t === null) t = u.times(q);
  return { unitCost: cost(u), totalCost: cost(t) };
}

function requirePositive(value, label) {
  const d = toDecimal(value);
  if (!d || d.lte(0)) throw new CalcError(`${label} must be greater than 0`);
  return d;
}

/**
 * Cost a recipe and scale it to `expectedServings` without touching its base values.
 *
 * lines: [{ packPrice, packSize, amount, ...passthrough }]
 *   packPrice / packSize come from the ingredient's most recent purchase (packPrice null if
 *   never bought); amount is how much of the ingredient's unit of measure the recipe uses.
 */
export function calculateRecipe({
  lines = [],
  baseServings,
  expectedServings,
  targetMargin = DEFAULT_MARGIN,
  totalYield = null,
}) {
  const base = requirePositive(baseServings, 'Base servings');
  const expected = toDecimal(expectedServings) ?? base;
  if (expected.lt(0)) throw new CalcError('Expected servings cannot be negative');
  const margin = toDecimal(targetMargin) ?? new Decimal(DEFAULT_MARGIN);
  const scale = scaleFactor(expected, base);

  let baseCost = new Decimal(0);
  const warnings = [];

  const outLines = lines.map((line) => {
    const packPrice = toDecimal(line.packPrice);
    const amount = toDecimal(line.amount) ?? new Decimal(0);
    if (amount.lt(0)) throw new CalcError('Amount used cannot be negative');
    if (packPrice === null) warnings.push(`${line.name ?? 'An ingredient'} has no purchase price yet`);

    const perUnit = packPrice === null ? new Decimal(0) : unitPrice(packPrice, line.packSize);
    const itemCost = lineCost(perUnit, amount);
    baseCost = baseCost.plus(itemCost);
    return {
      ...line,
      missingPrice: packPrice === null,
      unitPrice: packPrice === null ? null : cost(perUnit),
      baseCost: cost(itemCost),
      scaledAmount: cost(amount.times(scale)),
      scaledCost: cost(itemCost.times(scale)),
    };
  });

  const scaledCost = baseCost.times(scale);
  const costPerServing = baseCost.div(base);
  const price = recommendedPrice(costPerServing, margin).toDecimalPlaces(MONEY_DP);
  const revenue = price.times(expected);
  const profit = revenue.minus(scaledCost);
  const yieldD = toDecimal(totalYield);

  return {
    baseServings: base.toString(),
    expectedServings: expected.toString(),
    scale: scale.toDecimalPlaces(6).toString(),
    targetMargin: margin.toString(),
    lines: outLines,
    baseCost: cost(baseCost),
    scaledCost: cost(scaledCost),
    costPerServing: cost(costPerServing),
    recommendedPrice: money(price),
    profitPerServing: money(price.minus(costPerServing)),
    revenue: money(revenue),
    profit: money(profit),
    scaledYield: yieldD ? yieldD.times(scale).toDecimalPlaces(COST_DP).toString() : null,
    warnings,
  };
}

/**
 * Aggregate an event: financials across its recipes plus one consolidated shopping
 * list, one line per ingredient:
 *   amount       = Σ Amount_Used × Expected/Base   (in the ingredient's unit of measure)
 *   packsToBuy   = ceil(amount / Pack_Size)        (store packs of the latest purchase's size)
 *   usedCost     = Σ recipe line costs             (what the recipes consume; sums to totalCost)
 *   purchaseCost = packsToBuy × Pack_Price         (what buying those whole packs costs)
 *
 * recipes: [{ recipeId, name, baseServings, targetMargin, expectedServings, lines }]
 *   where lines carry { ingredientId, name, uom, packPrice, packSize, amount }.
 */
export function summarizeEvent(recipes = []) {
  let totalCost = new Decimal(0);
  let revenue = new Decimal(0);
  const shopping = new Map();
  const warnings = [];

  const recipeSummaries = recipes.map((r) => {
    const calc = calculateRecipe({
      lines: r.lines,
      baseServings: r.baseServings,
      expectedServings: r.expectedServings,
      targetMargin: r.targetMargin,
    });
    totalCost = totalCost.plus(calc.scaledCost);
    revenue = revenue.plus(calc.revenue);
    for (const w of calc.warnings) warnings.push(`${r.name}: ${w}`);

    for (const line of calc.lines) {
      const key = line.ingredientId;
      let entry = shopping.get(key);
      if (!entry) {
        entry = {
          ingredientId: line.ingredientId,
          name: line.name,
          category: line.category ?? null,
          uom: line.uom ?? null,
          packSize: toDecimal(line.packSize)?.toString() ?? null,
          packPrice: toDecimal(line.packPrice)?.toString() ?? null,
          amount: new Decimal(0),
          usedCost: new Decimal(0),
          missingPrice: false,
          recipes: [],
        };
        shopping.set(key, entry);
      }
      entry.amount = entry.amount.plus(line.scaledAmount);
      entry.usedCost = entry.usedCost.plus(line.scaledCost);
      entry.missingPrice ||= line.missingPrice;
      if (!entry.recipes.includes(r.name)) entry.recipes.push(r.name);
    }

    return {
      recipeId: r.recipeId,
      name: r.name,
      expectedServings: calc.expectedServings,
      baseServings: calc.baseServings,
      targetMargin: calc.targetMargin,
      scaledCost: calc.scaledCost,
      costPerServing: calc.costPerServing,
      recommendedPrice: calc.recommendedPrice,
      revenue: calc.revenue,
      profit: calc.profit,
    };
  });

  const profit = revenue.minus(totalCost);
  let purchaseCost = new Decimal(0);
  const shoppingList = [...shopping.values()]
    .map((e) => {
      const packs = e.amount.div(toDecimal(e.packSize) ?? 1).ceil();
      const bought = e.packPrice === null ? null : packs.times(e.packPrice);
      if (bought) purchaseCost = purchaseCost.plus(bought);
      return {
        ...e,
        amount: cost(e.amount),
        packsToBuy: packs.toString(),
        usedCost: cost(e.usedCost),
        purchaseCost: bought === null ? null : cost(bought),
      };
    })
    .sort((a, b) => isLabor(a) - isLabor(b) || a.name.localeCompare(b.name));

  return {
    recipes: recipeSummaries,
    totalCost: cost(totalCost),
    purchaseCost: cost(purchaseCost),
    revenue: money(revenue),
    profit: money(profit),
    marginPercent: revenue.isZero() ? null : profit.div(revenue).times(100).toFixed(1),
    shoppingList,
    warnings,
  };
}
