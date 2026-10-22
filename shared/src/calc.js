// Costing math shared by the API and the browser, so the instant scaling in the
// recipe builder and the server's numbers can never disagree. Every amount goes
// through decimal.js; numbers are returned as strings to keep JSON float-free.

import DecimalBase from 'decimal.js';
import { SAUCE_CONTAINERS, SAUCE_GRAMS_PER_TSP, SPICE_GRAMS_PER_TSP, convertUnits } from './units.js';

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

/**
 * One shopping trip's purchases of one ingredient (the lines of one receipt) as a single
 * average pack: pack price and pack size are averaged per pack bought, so the price per unit
 * is what the trip spent ÷ how much it bought. Same rounding as `LATEST_PURCHASE` in SQL.
 */
export function combinePurchases(purchases) {
  const sum = (f) => purchases.reduce((s, p) => s.plus(f(p)), new Decimal(0));
  const quantity = sum((p) => p.quantity);
  const unitCost = sum((p) => new Decimal(p.quantity).times(p.unitCost)).div(quantity).toDecimalPlaces(COST_DP);
  const packSize = sum((p) => new Decimal(p.quantity).times(p.packSize ?? 1)).div(quantity).toDecimalPlaces(COST_DP);
  return {
    quantity: cost(quantity),
    packSize: cost(packSize),
    unitCost: cost(unitCost),
    totalCost: cost(sum((p) => p.totalCost)),
    unitPrice: cost(unitPrice(unitCost, packSize)),
  };
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
 *   leftover     = packsToBuy × Pack_Size − amount (what's left of those packs, in the UOM)
 *
 * recipes: [{ recipeId, name, baseServings, targetMargin, expectedServings, lines }]
 *   where lines carry { ingredientId, name, uom, packPrice, packSize, amount }.
 * amounts: { [ingredientId]: amount } set by hand for the event (e.g. labor). It replaces
 *   the scaled total; usedCost becomes amount × price per unit, and the difference from the
 *   recipes' cost is reported as `adjustment` and included in totalCost and profit.
 */
/**
 * A recipe's price at one event. `salePrice` (per serving) replaces the recipe's own target price
 * when set. A deal takes `discountAmount` off every `discountQty` servings ("buy 2, get $1 off" is
 * $1 per 2; the default is per serving) and is assumed to apply to every serving sold, so the
 * projection is the cautious one. Margin per serving is after the discount.
 */
export function eventPricing({ costPerServing, recommendedPrice, salePrice = null, discountAmount = null, discountQty = null, expectedServings = 0 }) {
  const listPrice = (toDecimal(salePrice) ?? toDecimal(recommendedPrice) ?? new Decimal(0)).toDecimalPlaces(MONEY_DP);
  const off = toDecimal(discountAmount) ?? new Decimal(0);
  const per = toDecimal(discountQty) ?? new Decimal(1);
  if (listPrice.lt(0) || off.lt(0)) throw new CalcError('Prices and discounts cannot be negative');
  if (!per.isInteger() || per.lt(1)) throw new CalcError('A discount applies per 1 or more servings');
  const expected = toDecimal(expectedServings) ?? new Decimal(0);
  const netPrice = listPrice.minus(off.div(per));
  const margin = netPrice.minus(toDecimal(costPerServing) ?? 0);
  const discount = off.times(expected.div(per).floor());
  return {
    salePrice: money(listPrice),
    priceSet: toDecimal(salePrice) !== null,
    discountAmount: off.isZero() ? null : money(off),
    discountQty: off.isZero() ? null : per.toNumber(),
    netPrice: cost(netPrice),
    marginPerServing: cost(margin),
    marginPercent: netPrice.gt(0) ? margin.div(netPrice).times(100).toFixed(1) : null,
    discount: money(discount),
    revenue: money(listPrice.times(expected).minus(discount)),
  };
}

/** What a payment app keeps from each payment: percent of what's paid plus a fixed fee. */
export const PAYMENT_FEES = {
  venmo: { percent: '1.9', fixed: '0.10' },
  cashapp: { percent: '2.6', fixed: '0.15' },
};

/**
 * The fee added on top of a sale line of `amount` paid by `method`: the customer is charged
 * amount + fee, and the app's cut of that whole charge is the fee, so the sale nets `amount`.
 * charge = (amount + fixed) ÷ (1 − percent), rounded up to the cent. 0 for cash, card,
 * giveaways and $0 lines.
 */
export function paymentFee(method, amount) {
  const f = PAYMENT_FEES[method];
  const a = toDecimal(amount);
  if (!f || !a || a.lte(0)) return money(new Decimal(0));
  const charge = a.plus(f.fixed).div(new Decimal(1).minus(new Decimal(f.percent).div(100))).toDecimalPlaces(MONEY_DP, Decimal.ROUND_UP);
  return money(charge.minus(a));
}

/**
 * One recipe on a sale recorded during an event: what it's charged. With `dealUsed`, the
 * recipe's deal applies as many times as the quantity allows (3 on "buy 2, $1 off" is one deal).
 * Items given away (`free`) are charged nothing and use no deal.
 */
export function saleItem({ quantity, salePrice, discountAmount = null, discountQty = null, dealUsed = false, free = false }) {
  const q = toDecimal(quantity);
  if (!q || !q.isInteger() || q.lt(1)) throw new CalcError('Quantity must be a whole number, 1 or more');
  const price = toDecimal(salePrice) ?? new Decimal(0);
  const off = toDecimal(discountAmount) ?? new Decimal(0);
  const per = toDecimal(discountQty) ?? new Decimal(1);
  const deals = dealUsed && !free && off.gt(0) ? q.div(per).floor() : new Decimal(0);
  const discount = off.times(deals);
  const amount = free ? new Decimal(0) : Decimal.max(0, price.times(q).minus(discount));
  return { quantity: q.toNumber(), unitPrice: money(price), deals: deals.toNumber(), discount: money(discount), amount: money(amount) };
}

/**
 * A sauce made at an event in `container`s (default: the sauce's own): one container is
 * `scale` of the sauce's batch and holds `servingsPerContainer` of its servings. It's sold by
 * the serving: the batch cost ÷ the batch's servings, by default priced at the default margin,
 * as a recipe's would be. blend: a loadBlends row.
 */
export function sauceContainer(blend, container = null) {
  const size = container ?? blend.container;
  const oz = SAUCE_CONTAINERS[size];
  const batch = toDecimal(blend.batchSize);
  if (!oz || !batch || batch.lte(0)) throw new CalcError(`${blend.name}: pick a container`);
  const scale = new Decimal(oz).div(batch);
  const servings = new Decimal(blend.servings ?? 1);
  const perServing = toDecimal(blend.cost)?.div(servings) ?? null;
  return {
    container: size,
    containerOz: oz,
    scale,
    servingsPerContainer: servings.times(scale).toString(),
    costPerServing: perServing === null ? null : cost(perServing),
    recommendedPrice: perServing === null ? null : money(recommendedPrice(perServing, DEFAULT_MARGIN)),
  };
}

/**
 * `vendorFee`: what the event charges for the stand, taken off the profit (not part of the food cost).
 * `sauces`: [{ blend (a loadBlends row), servings, container, salePrice }] — a sauce on the menu,
 *   sold by the serving (no deals) and made in whole containers: its cost is the containers
 *   made, and their ingredients join the shopping list.
 */
export function summarizeEvent(recipes = [], amounts = {}, { vendorFee = null, sauces = [] } = {}) {
  const fee = toDecimal(vendorFee) ?? new Decimal(0);
  let totalCost = new Decimal(0);
  let revenue = new Decimal(0);
  const shopping = new Map();
  const warnings = [];

  // A spice blend line is its own entry (packs = batches to make), never merged with an ingredient.
  const addToList = (line, amount, used, missingPrice, source, key = line.ingredientId ?? `blend:${line.blendId}`) => {
    let entry = shopping.get(key);
    if (!entry) {
      entry = {
        key,
        ingredientId: line.ingredientId ?? null,
        blendId: line.blendId ?? null,
        name: line.name,
        category: line.category ?? null,
        vendor: line.vendor ?? null,
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
    entry.amount = entry.amount.plus(amount);
    entry.usedCost = entry.usedCost.plus(used);
    entry.missingPrice ||= missingPrice;
    if (!entry.recipes.includes(source)) entry.recipes.push(source);
  };

  const recipeSummaries = recipes.map((r) => {
    const calc = calculateRecipe({
      lines: r.lines,
      baseServings: r.baseServings,
      expectedServings: r.expectedServings,
      targetMargin: r.targetMargin,
    });
    const pricing = eventPricing({
      costPerServing: calc.costPerServing,
      recommendedPrice: calc.recommendedPrice,
      salePrice: r.salePrice,
      discountAmount: r.discountAmount,
      discountQty: r.discountQty,
      expectedServings: calc.expectedServings,
    });
    totalCost = totalCost.plus(calc.scaledCost);
    revenue = revenue.plus(pricing.revenue);
    for (const w of calc.warnings) warnings.push(`${r.name}: ${w}`);

    for (const line of calc.lines) addToList(line, line.scaledAmount, line.scaledCost, line.missingPrice, r.name);

    return {
      recipeId: r.recipeId,
      name: r.name,
      expectedServings: calc.expectedServings,
      baseServings: calc.baseServings,
      targetMargin: calc.targetMargin,
      scaledCost: calc.scaledCost,
      costPerServing: calc.costPerServing,
      recommendedPrice: calc.recommendedPrice, // the recipe's own target price
      ...pricing, // salePrice (what it sells for here), discount, revenue, margin per serving
      profit: money(new Decimal(pricing.revenue).minus(calc.scaledCost)),
    };
  });

  const sauceSummaries = sauces.map((s) => {
    const { blend } = s;
    const n = toDecimal(s.servings);
    if (!n || !n.isInteger() || n.lt(1)) throw new CalcError(`${blend.name}: servings must be a whole number, 1 or more`);
    const c = sauceContainer(blend, s.container);
    const containers = n.div(c.servingsPerContainer).ceil();
    const scale = c.scale.times(containers); // of the sauce's batch, for every container made
    const density = blend.kind === 'sauce' ? SAUCE_GRAMS_PER_TSP : SPICE_GRAMS_PER_TSP;
    let used = new Decimal(0);
    for (const it of blend.items) {
      const amount = toDecimal(it.amount).times(scale);
      const inUom = it.ingredientId && it.uom ? convertUnits(amount, it.unit, it.uom, density) : null;
      const price = toDecimal(it.packPrice);
      if (inUom) {
        const itemCost = price === null ? new Decimal(0) : unitPrice(price, it.packSize).times(inUom);
        used = used.plus(itemCost);
        addToList({ ...it, blendId: null }, inUom, itemCost, price === null, blend.name);
      } else {
        // A typed name, or a unit that can't become the ingredient's: listed as written, unpriced.
        addToList({ ...it, ingredientId: null, blendId: null, uom: it.unit, packSize: null, packPrice: null }, amount, new Decimal(0), true, blend.name, `item:${it.name.toLowerCase()}:${it.unit}`);
        if (it.ingredientId) warnings.push(`${blend.name}: ${it.name} is in ${it.unit}, which can’t be priced in ${it.uom}`);
      }
    }
    const pricing = eventPricing({
      costPerServing: c.costPerServing ?? 0,
      recommendedPrice: c.recommendedPrice,
      salePrice: s.salePrice,
      expectedServings: n,
    });
    totalCost = totalCost.plus(used);
    revenue = revenue.plus(pricing.revenue);
    return {
      blendId: blend.id,
      name: blend.name,
      container: c.container,
      containerOz: c.containerOz,
      containers: containers.toNumber(),
      servingsPerContainer: c.servingsPerContainer,
      expectedServings: n.toNumber(),
      costPerServing: c.costPerServing ?? cost(new Decimal(0)),
      recommendedPrice: c.recommendedPrice,
      scaledCost: cost(used),
      ...pricing,
      profit: money(new Decimal(pricing.revenue).minus(used)),
    };
  });

  let adjustment = new Decimal(0);
  for (const e of shopping.values()) {
    const set = toDecimal(amounts[e.ingredientId]);
    if (set === null) continue;
    const used = e.packPrice === null ? new Decimal(0) : unitPrice(e.packPrice, e.packSize).times(set);
    adjustment = adjustment.plus(used.minus(e.usedCost));
    Object.assign(e, { calculatedAmount: cost(e.amount), amount: set, usedCost: used, amountSet: true });
  }
  totalCost = totalCost.plus(adjustment);

  const profit = revenue.minus(totalCost).minus(fee);
  let purchaseCost = new Decimal(0);
  const shoppingList = [...shopping.values()]
    .map((e) => {
      const size = toDecimal(e.packSize) ?? new Decimal(1);
      const packs = e.amount.div(size).ceil();
      const bought = e.packPrice === null ? null : packs.times(e.packPrice);
      if (bought) purchaseCost = purchaseCost.plus(bought);
      return {
        ...e,
        amount: cost(e.amount),
        packsToBuy: packs.toString(),
        leftover: cost(packs.times(size).minus(e.amount)),
        usedCost: cost(e.usedCost),
        purchaseCost: bought === null ? null : cost(bought),
      };
    })
    .sort((a, b) => isLabor(a) - isLabor(b) || a.name.localeCompare(b.name));

  return {
    recipes: recipeSummaries,
    sauces: sauceSummaries,
    totalCost: cost(totalCost),
    adjustment: cost(adjustment),
    purchaseCost: cost(purchaseCost),
    revenue: money(revenue),
    vendorFee: money(fee),
    profit: money(profit),
    marginPercent: revenue.isZero() ? null : profit.div(revenue).times(100).toFixed(1),
    shoppingList,
    warnings,
  };
}
export * from './units.js';
export * from './names.js';
