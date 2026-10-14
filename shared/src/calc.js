// Costing math shared by the API and the browser, so the instant scaling in the
// recipe builder and the server's numbers can never disagree. Every amount goes
// through decimal.js; numbers are returned as strings to keep JSON float-free.

import DecimalBase from 'decimal.js';

export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });

export const DEFAULT_MARGIN = 70;
export const COST_DP = 4;
export const MONEY_DP = 2;

export class CalcError extends Error {}

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

/** Line Item Cost = Unit_Cost × (Use_Percent / 100) × Quantity */
export function lineCost(unitCost, usePercent, quantity) {
  return new Decimal(unitCost).times(new Decimal(usePercent).div(100)).times(quantity);
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
 * lines: [{ unitCost, usePercent, baseQuantity, ...passthrough }]
 *   unitCost is the ingredient's most recent purchase price (null if never bought).
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
    const unitCost = toDecimal(line.unitCost);
    const usePercent = toDecimal(line.usePercent) ?? new Decimal(100);
    const quantity = toDecimal(line.baseQuantity) ?? new Decimal(0);
    if (usePercent.lt(0) || usePercent.gt(100)) throw new CalcError('Use % must be between 0 and 100');
    if (quantity.lt(0)) throw new CalcError('Quantity cannot be negative');
    if (unitCost === null) warnings.push(`${line.name ?? 'An ingredient'} has no purchase price yet`);

    const itemCost = lineCost(unitCost ?? 0, usePercent, quantity);
    baseCost = baseCost.plus(itemCost);
    const scaledQuantity = quantity.times(scale);
    return {
      ...line,
      missingPrice: unitCost === null,
      baseCost: cost(itemCost),
      scaledQuantity: cost(scaledQuantity),
      // Fraction of purchase units actually consumed, after Use %.
      scaledUsage: cost(scaledQuantity.times(usePercent).div(100)),
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
 * list. Shopping lines are grouped by ingredient and unit:
 *   quantity  = Σ Base_Quantity × Expected/Base             (spec §7)
 *   usage     = Σ Base_Quantity × Expected/Base × Use%/100  (fraction actually consumed)
 *   unitsToBuy = ceil(usage)
 *
 * recipes: [{ recipeId, name, baseServings, targetMargin, expectedServings, lines }]
 *   where lines carry { ingredientId, name, unit, unitCost, usePercent, baseQuantity }.
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
      const key = `${line.ingredientId}|${line.unit ?? ''}`;
      let entry = shopping.get(key);
      if (!entry) {
        entry = {
          ingredientId: line.ingredientId,
          name: line.name,
          unit: line.unit ?? null,
          quantity: new Decimal(0),
          usage: new Decimal(0),
          estimatedCost: new Decimal(0),
          missingPrice: false,
          recipes: [],
        };
        shopping.set(key, entry);
      }
      entry.quantity = entry.quantity.plus(line.scaledQuantity);
      entry.usage = entry.usage.plus(line.scaledUsage);
      entry.estimatedCost = entry.estimatedCost.plus(line.scaledCost);
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
  const shoppingList = [...shopping.values()]
    .map((e) => ({
      ...e,
      quantity: cost(e.quantity),
      usage: cost(e.usage),
      unitsToBuy: e.usage.ceil().toString(),
      estimatedCost: cost(e.estimatedCost),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    recipes: recipeSummaries,
    totalCost: cost(totalCost),
    revenue: money(revenue),
    profit: money(profit),
    marginPercent: revenue.isZero() ? null : profit.div(revenue).times(100).toFixed(1),
    shoppingList,
    warnings,
  };
}
