// Costing math shared by the API and the browser, so the instant scaling in the
// recipe builder and the server's numbers can never disagree. Every amount goes
// through decimal.js; numbers are returned as strings to keep JSON float-free.

import DecimalBase from 'decimal.js';
import { SAUCE_CONTAINERS, SAUCE_GRAMS_PER_TSP, SPICE_GRAMS_PER_TSP, itemAmounts, lineAmountInUom } from './units.js';

export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });

export const DEFAULT_MARGIN = 75;
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

/**
 * Fill in whichever of unit cost / total cost is missing from the other and quantity. Given both,
 * they must agree: quantity × unit cost may differ from the total by rounding (2.46 lb at $2.39 is
 * $5.8794, printed $5.88), but not by more than a cent and a hair per unit.
 */
export function completePurchaseCosts({ quantity, unitCost, totalCost }) {
  const q = toDecimal(quantity);
  let u = toDecimal(unitCost);
  let t = toDecimal(totalCost);
  if (!q || q.lte(0)) throw new CalcError('Quantity must be greater than 0');
  if (u === null && t === null) throw new CalcError('Enter a unit cost or a total cost');
  if (u !== null && t !== null && u.times(q).minus(t).abs().gt(q.times('0.00005').plus('0.01'))) {
    throw new CalcError(`${q.toString()} × $${u.toFixed(2)} is $${u.times(q).toFixed(2)}, but the total is $${t.toFixed(2)}. Correct the quantity, the price or the total so they agree.`);
  }
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
 * lines: [{ packPrice, packSize, amount, unit?, uom?, cupGrams?, ...passthrough }]
 *   packPrice / packSize come from the ingredient's most recent purchase (packPrice null if
 *   never bought); amount is how much the recipe uses, in `unit` when the line has one (cups of
 *   rice bought by the lb, converted by lineAmountInUom), else in the ingredient's unit of
 *   measure. A line whose unit can't be converted costs nothing and says so (`unitProblem`).
 *   `scaledAmount` is in the ingredient's unit of measure (for shopping), `scaledLineAmount` in the line's.
 * targetPrice: a menu price set by hand. It's the price whatever the cost, and `targetMargin`
 *   comes back as the margin it makes (below 0 once the cost passes it); `priceSet` says so.
 *   Without one, the price follows the cost at targetMargin.
 */
export function calculateRecipe({
  lines = [],
  baseServings,
  expectedServings,
  targetMargin = DEFAULT_MARGIN,
  totalYield = null,
  targetPrice = null,
}) {
  const base = requirePositive(baseServings, 'Base servings');
  const setPrice = toDecimal(targetPrice);
  if (setPrice !== null && setPrice.lte(0)) throw new CalcError('Menu price must be greater than 0');
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

    const used = lineAmountInUom(amount, line.unit, line);
    if (used === null) warnings.push(`${line.name ?? 'An ingredient'}: can’t convert ${line.unit} to ${line.uom ?? 'its unit'}; set what a cup of it weighs`);

    const perUnit = packPrice === null ? new Decimal(0) : unitPrice(packPrice, line.packSize);
    const itemCost = lineCost(perUnit, used ?? 0);
    baseCost = baseCost.plus(itemCost);
    return {
      ...line,
      missingPrice: packPrice === null,
      unitProblem: used === null,
      unitPrice: packPrice === null ? null : cost(perUnit),
      amountInUom: used === null ? null : cost(used),
      baseCost: cost(itemCost),
      scaledAmount: cost((used ?? new Decimal(0)).times(scale)),
      scaledLineAmount: cost(amount.times(scale)),
      scaledCost: cost(itemCost.times(scale)),
    };
  });

  const scaledCost = baseCost.times(scale);
  const costPerServing = baseCost.div(base);
  const price = setPrice ? setPrice.toDecimalPlaces(MONEY_DP) : recommendedPrice(costPerServing, margin).toDecimalPlaces(MONEY_DP);
  // A set price makes whatever margin it makes; 6 decimals, like a margin derived from a typed price.
  const madeMargin = setPrice ? new Decimal(1).minus(costPerServing.div(price)).times(100).toDecimalPlaces(6) : margin;
  const revenue = price.times(expected);
  const profit = revenue.minus(scaledCost);
  const yieldD = toDecimal(totalYield);

  return {
    baseServings: base.toString(),
    expectedServings: expected.toString(),
    scale: scale.toDecimalPlaces(6).toString(),
    targetMargin: madeMargin.toString(),
    priceSet: !!setPrice,
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
 * packs: { [ingredientId]: packs } — packs to buy set by hand (stock on hand, a spare): they
 *   replace packsToBuy (`packsSet`, with `calculatedPacks`), so purchaseCost and leftover follow
 *   (below 0: the rest comes from stock), never the food cost; `packsAdjustment` is what they
 *   changed purchaseCost by.
 *
 * recipes: [{ recipeId, name, baseServings, targetMargin, expectedServings, servingSize?, totalYield?, yieldUnit?, lines }]
 *   where lines carry { ingredientId, name, uom, packPrice, packSize, amount }. expectedServings
 *   count this event's servings, so `servingSize` scales the food by eventServing's ratio.
 * amounts: { [ingredientId]: amount } set by hand for the event. It replaces
 *   the scaled total; usedCost becomes amount × price per unit, and the difference from the
 *   recipes' cost is reported as `adjustment` and included in totalCost and profit.
 */
/** What a deal of `dealQty` for `dealPrice` saves each time it applies; null with no deal, or one that isn't cheaper. */
function dealSaving(price, dealPrice, dealQty) {
  const together = toDecimal(dealPrice);
  const qty = toDecimal(dealQty);
  if (!together || !qty) return null;
  const saving = price.times(qty).minus(together);
  return saving.gt(0) ? saving : null;
}

/**
 * A recipe's price at one event. `salePrice` (per serving) replaces the recipe's own target price
 * when set. A deal sells `dealQty` servings for `dealPrice` ("3 for $15") and is assumed to apply to
 * every serving sold, so the projection is the cautious one. Margin per serving is after the deal.
 * A deal that isn't cheaper than the servings at their price doesn't count, and comes back null.
 */
export function eventPricing({ costPerServing, recommendedPrice, salePrice = null, dealPrice = null, dealQty = null, expectedServings = 0 }) {
  const listPrice = (toDecimal(salePrice) ?? toDecimal(recommendedPrice) ?? new Decimal(0)).toDecimalPlaces(MONEY_DP);
  const qty = toDecimal(dealQty);
  if (listPrice.lt(0) || toDecimal(dealPrice)?.lt(0)) throw new CalcError('Prices and deals cannot be negative');
  if (qty && (!qty.isInteger() || qty.lt(2))) throw new CalcError('A deal is for 2 or more servings');
  const expected = toDecimal(expectedServings) ?? new Decimal(0);
  const saving = dealSaving(listPrice, dealPrice, dealQty);
  const netPrice = saving ? listPrice.minus(saving.div(qty)) : listPrice;
  const margin = netPrice.minus(toDecimal(costPerServing) ?? 0);
  const discount = saving ? saving.times(expected.div(qty).floor()) : new Decimal(0);
  return {
    salePrice: money(listPrice),
    priceSet: toDecimal(salePrice) !== null,
    dealPrice: saving ? money(toDecimal(dealPrice)) : null,
    dealQty: saving ? qty.toNumber() : null,
    netPrice: cost(netPrice),
    marginPerServing: cost(margin),
    marginPercent: netPrice.gt(0) ? margin.div(netPrice).times(100).toFixed(1) : null,
    discount: money(discount),
    revenue: money(listPrice.times(expected).minus(discount)),
  };
}

/** "3 tacos", in the unit as the recipe writes it, but "1 taco" for one of a plural. */
export function amountLabel(amount, unit) {
  const n = new Decimal(amount).toDecimalPlaces(2);
  return `${n.toString()} ${n.eq(1) ? unit.replace(/([^s])s$/, '$1') : unit}`;
}

/**
 * What one serving of a recipe is at an event. `servingSize` is in the recipe's yield unit ("3" tacos);
 * unset (or not above 0) it's the recipe's own size, total yield ÷ servings. `ratio` is how many of the
 * recipe's servings one event serving takes, and the cost and default price come back per event serving.
 * A recipe with no total yield measures its size in its own servings.
 */
export function eventServing({ baseServings, totalYield = null, yieldUnit = null, costPerServing = null, recommendedPrice = null }, servingSize = null) {
  const set = toDecimal(servingSize);
  const size = set?.gt(0) ? set : null;
  const total = toDecimal(totalYield);
  const hasYield = !!total?.gt(0);
  const unit = String(yieldUnit ?? '').trim() || (hasYield ? 'units' : 'servings');
  const ratio = !size ? new Decimal(1) : hasYield ? size.times(baseServings).div(total) : size;
  const perServing = toDecimal(costPerServing);
  const price = toDecimal(recommendedPrice);
  return {
    ratio,
    unit,
    recipeSize: hasYield ? total.div(baseServings) : new Decimal(1),
    servingLabel: size ? amountLabel(size, unit) : null,
    costPerServing: perServing === null ? null : cost(perServing.times(ratio)),
    recommendedPrice: price === null ? null : money(price.times(ratio)),
  };
}

/** A menu item's name on tickets and order lines, with its size at this event when one is set. */
export const menuItemName = ({ name, servingLabel = null }) => (servingLabel ? `${name} (${servingLabel})` : name);

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
 * One recipe on a sale recorded during an event: what it's charged. The recipe's deal applies by
 * itself as many times as the quantity allows (4 on "3 for $15" is one deal and one at full price).
 * Items given away (`free`) are charged nothing and use no deal.
 */
export function saleItem({ quantity, salePrice, dealPrice = null, dealQty = null, free = false }) {
  const q = toDecimal(quantity);
  if (!q || !q.isInteger() || q.lt(1)) throw new CalcError('Quantity must be a whole number, 1 or more');
  const price = toDecimal(salePrice) ?? new Decimal(0);
  const saving = free ? null : dealSaving(price, dealPrice, dealQty);
  const deals = saving ? q.div(dealQty).floor() : new Decimal(0);
  const discount = saving ? saving.times(deals) : new Decimal(0);
  const amount = free ? new Decimal(0) : price.times(q).minus(discount);
  return { quantity: q.toNumber(), unitPrice: money(price), deals: deals.toNumber(), discount: money(discount), amount: money(amount) };
}

/** Where an order is. An order goes straight to the kitchen, so it's in progress until it's done; a cancelled one counts toward nothing. */
export const ORDER_STATUSES = ['in_progress', 'completed', 'cancelled'];
export const OPEN_ORDER_STATUSES = ['in_progress'];

/**
 * How long an order has taken, in whole seconds: `making` from started (normally when it was
 * placed) to completed, `total` from placed to completed, each null when it doesn't apply (a sale
 * handed over on the spot). An open order counts up to `now` and is named by `running`.
 * Timestamps come from the server.
 */
export function orderTimes({ createdAt, inProgressAt = null, completedAt = null, status }, now = Date.now()) {
  const at = (t) => new Date(t).getTime();
  const span = (from, to) => (from === null || to === null ? null : Math.max(0, Math.floor((to - from) / 1000)));
  const placed = at(createdAt);
  const started = inProgressAt ? at(inProgressAt) : null;
  const ended = completedAt ? at(completedAt) : null;
  const isMaking = status === 'in_progress';
  return {
    making: span(started, ended ?? (isMaking ? now : null)),
    total: span(started === null && ended === null ? null : placed, ended ?? (isMaking ? now : null)),
    running: isMaking ? 'making' : null,
  };
}

/** Average seconds per stage over the completed orders that were timed; null where none were. */
export function orderTimingSummary(sales) {
  const timed = sales.filter((s) => s.status === 'completed' && s.completedAt).map((s) => orderTimes(s));
  const average = (key) => {
    const seen = timed.map((t) => t[key]).filter((v) => v !== null);
    return seen.length ? Math.round(seen.reduce((a, b) => a + b, 0) / seen.length) : null;
  };
  return { count: timed.length, making: average('making'), total: average('total') };
}

/**
 * The event orders are probably being taken for, from the events list and today's date
 * (YYYY-MM-DD): one today, even with an empty menu (of several, one with a menu, then the
 * busiest), else one with orders still open, else the next one coming up, else the latest. Past
 * today, events with something to sell come first. Null if none.
 */
export function anticipateEvent(events, today) {
  const hasMenu = (e) => e.recipeCount + e.sauceCount > 0;
  const ready = events.filter(hasMenu);
  const pool = ready.length ? ready : events;
  const newest = (a, b) => String(b.lastOrderAt ?? '').localeCompare(String(a.lastOrderAt ?? ''));
  const busiest = (a, b) => b.openOrders - a.openOrders || newest(a, b);
  const byDate = (a, b) => a.date.localeCompare(b.date);
  return events.filter((e) => e.date === today).sort((a, b) => hasMenu(b) - hasMenu(a) || busiest(a, b))[0]
    ?? pool.filter((e) => e.openOrders > 0).sort(byDate).at(-1)
    ?? pool.filter((e) => e.date > today).sort(byDate)[0]
    ?? [...pool].sort(byDate).at(-1)
    ?? null;
}

/**
 * A sauce made at an event in `container`s (default: the sauce's own): one container is
 * `scale` of the sauce's batch and holds `servingsPerContainer` servings of `servingOz` oz.
 * It's sold by the serving: the batch cost × serving oz ÷ batch oz, by default priced at the
 * default margin, as a recipe's would be, unless the sauce has its own `salePrice`. blend: a loadBlends row.
 */
export function sauceContainer(blend, container = null) {
  const size = container ?? blend.container;
  const oz = SAUCE_CONTAINERS[size];
  const batch = toDecimal(blend.batchSize);
  if (!oz || !batch || batch.lte(0)) throw new CalcError(`${blend.name}: pick a container`);
  const scale = new Decimal(oz).div(batch);
  const servingOz = toDecimal(blend.servingOz) ?? batch.div(blend.servings ?? 1);
  if (servingOz.lte(0)) throw new CalcError(`${blend.name}: set a serving size`);
  const perServing = toDecimal(blend.cost)?.times(servingOz).div(batch) ?? null;
  const own = toDecimal(blend.salePrice);
  return {
    container: size,
    containerOz: oz,
    scale,
    servingOz: cost(servingOz),
    servingsPerContainer: new Decimal(oz).div(servingOz).toDecimalPlaces(COST_DP).toString(),
    costPerServing: perServing === null ? null : cost(perServing),
    recommendedPrice: own ? money(own) : perServing === null ? null : money(recommendedPrice(perServing, DEFAULT_MARGIN)),
  };
}

/**
 * How an event makes its money. A market sells each recipe by the serving at its own price. A
 * personal chef job is a flat rate plus the groceries at cost; a supper club sells tickets, each a
 * plate of everything on the menu at one price, and Hoamsy keeps a share of every ticket.
 */
export const EVENT_KINDS = ['market', 'personal_chef', 'supper_club'];
export const HOAMSY_FEE_PERCENT = 25; // filled in when a supper club's Hoamsy fee is ticked; each can set its own

/**
 * `vendorFee`: what the event charges for the stand, taken off the profit (not part of the food cost).
 * `sauces`: [{ blend (a loadBlends row), servings, container, salePrice }] — a sauce on the menu,
 *   sold by the serving (no deals) and made in whole containers: its cost is the containers
 *   made, and their ingredients join the shopping list.
 * labor: { hours, rate } — the event's own labor (not in recipes, not bought): hours × rate is
 *   part of totalCost, and comes back as `labor` with its `cost`.
 * format: { kind, flatPrice, tickets, hoamsyPercent } — a personal chef job (`flatPrice` the flat
 *   rate) or supper club (`flatPrice` a ticket, × `tickets`) has no per-recipe prices. Labor and the
 *   vendor fee are passed through at cost (`flat.passThrough`): they're paid out first, and what's
 *   left of the rate (for a personal chef job, plus the groceries the client pays for) is shared out
 *   by each item's share of the food cost as its revenue. Its margin per serving is that less its
 *   food and its share of amounts set by hand, so it's a margin on food, like a market recipe's; its
 *   `profit` is revenue less its own food, so the Financials columns add up.
 *   A supper club with a Hoamsy fee (`hoamsyPercent`; none without one) has it taken off its tickets
 *   first: only what's left is revenue, and that is what's shared out. `flat.suggestedPrice` is the
 *   plate price or flat rate that sells the food at DEFAULT_MARGIN and covers labor and the vendor
 *   fee at cost (so a $50 fee adds $50 of revenue, not $200).
 * The summary's `grossMarginPercent` is the food's revenue less the food (amounts set by hand
 *   included) over the food's revenue: the revenue, or at a flat-rate event what's left of it once
 *   labor and the vendor fee are paid back, so it's the dishes' margin (75% at `suggestedPrice`).
 *   `marginPercent` is the net margin, profit over all the revenue. A supper club's revenue is what's
 *   left after Hoamsy's fee.
 */
export function summarizeEvent(recipes = [], amounts = {}, { vendorFee = null, sauces = [], labor = null, format = null, packs = {} } = {}) {
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
        priceDate: line.priceDate ?? null, // of the latest purchase, which vendor is from
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
    if (source && !entry.recipes.includes(source)) entry.recipes.push(source);
  };

  const recipeSummaries = recipes.map((r) => {
    const sold = toDecimal(r.expectedServings) ?? new Decimal(r.baseServings);
    const { ratio } = eventServing(r, r.servingSize);
    const calc = calculateRecipe({
      lines: r.lines,
      baseServings: r.baseServings,
      expectedServings: sold.times(ratio),
      targetMargin: r.targetMargin,
      targetPrice: r.targetPrice,
    });
    const served = eventServing({ ...r, costPerServing: calc.costPerServing, recommendedPrice: calc.recommendedPrice }, r.servingSize);
    const pricing = eventPricing({
      costPerServing: served.costPerServing,
      recommendedPrice: served.recommendedPrice,
      salePrice: r.salePrice,
      dealPrice: r.dealPrice,
      dealQty: r.dealQty,
      expectedServings: sold,
    });
    totalCost = totalCost.plus(calc.scaledCost);
    revenue = revenue.plus(pricing.revenue);
    for (const w of calc.warnings) warnings.push(`${r.name}: ${w}`);

    for (const line of calc.lines) addToList(line, line.scaledAmount, line.scaledCost, line.missingPrice, r.name);

    return {
      recipeId: r.recipeId,
      name: r.name,
      expectedServings: sold.toString(),
      baseServings: calc.baseServings,
      targetMargin: calc.targetMargin,
      scaledCost: calc.scaledCost,
      servingSize: r.servingSize ?? null, // at this event; null: the recipe's own
      servingLabel: served.servingLabel,
      servingUnit: served.unit,
      recipeServings: served.ratio.toString(), // of the recipe's own size, in one event serving
      costPerServing: served.costPerServing,
      recommendedPrice: served.recommendedPrice, // the recipe's own target price, for this size of serving
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
      const inUom = it.ingredientId && it.uom ? itemAmounts(amount, it.unit, it, density).inUom : null;
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
  const hours = toDecimal(labor?.hours) ?? new Decimal(0);
  const rate = toDecimal(labor?.rate);
  const laborCost = rate ? hours.times(rate) : new Decimal(0);
  totalCost = totalCost.plus(laborCost);

  const kind = EVENT_KINDS.includes(format?.kind) ? format.kind : 'market';
  let hoamsyFee = new Decimal(0);
  let flat = null;
  if (kind !== 'market') {
    const items = [...recipeSummaries, ...sauceSummaries];
    const food = items.map((i) => new Decimal(i.scaledCost));
    const totalFood = food.reduce((a, b) => a.plus(b), new Decimal(0));
    const price = toDecimal(format.flatPrice) ?? new Decimal(0);
    if (price.lt(0)) throw new CalcError('The rate cannot be negative');
    const supper = kind === 'supper_club';
    const tickets = supper ? toDecimal(format.tickets) ?? new Decimal(0) : null;
    // Hoamsy's fee is optional: a supper club without a percent has none.
    const hoamsyOn = supper && toDecimal(format.hoamsyPercent) !== null;
    const hoamsy = hoamsyOn ? toDecimal(format.hoamsyPercent) : new Decimal(0);
    if (hoamsy.lt(0) || hoamsy.gte(100)) throw new CalcError('The Hoamsy fee must be from 0 to under 100%');
    const keep = new Decimal(1).minus(hoamsy.div(100)); // of each ticket, after Hoamsy's cut
    const gross = supper ? price.times(tickets) : price;
    hoamsyFee = gross.minus(gross.times(keep));
    const pool = gross.minus(hoamsyFee);
    const groceries = kind === 'personal_chef' ? totalFood.plus(adjustment) : new Decimal(0);
    // Labor and the vendor fee are passed through at cost: they're paid out of the money first, and
    // only what's left is shared across the menu as its revenue, so a dish's margin is on its food.
    const passThrough = laborCost.plus(fee);
    const forFood = pool.plus(groceries).minus(passThrough);
    items.forEach((item, i) => {
      const share = totalFood.gt(0) ? food[i].div(totalFood) : new Decimal(1).div(items.length);
      // A personal chef job's groceries are billed in full (amounts set by hand too), each item its share;
      // amounts set by hand are food, so each item carries its share of them.
      const itemRevenue = forFood.times(share);
      const made = itemRevenue.minus(food[i]).minus(adjustment.times(share));
      const servings = new Decimal(item.expectedServings);
      Object.assign(item, {
        salePrice: null,
        priceSet: false,
        dealPrice: null,
        dealQty: null,
        discount: money(new Decimal(0)),
        share: share.times(100).toFixed(1),
        netPrice: servings.gt(0) ? cost(itemRevenue.div(servings)) : null,
        marginPerServing: servings.gt(0) ? cost(made.div(servings)) : null,
        marginPercent: itemRevenue.gt(0) ? made.div(itemRevenue).times(100).toFixed(1) : null,
        revenue: money(itemRevenue),
        profit: money(itemRevenue.minus(food[i])),
      });
    });
    revenue = pool.plus(groceries);
    // The price that sells the food at DEFAULT_MARGIN, as a recipe's price does (cost ÷ (1 − margin)),
    // and covers labor and the vendor fee at cost: those are fixed amounts, so each adds its own
    // amount (spread over the tickets after Hoamsy's cut), not a marked-up one.
    const foodCost = totalFood.plus(adjustment);
    const needed = foodCost.div(new Decimal(1).minus(new Decimal(DEFAULT_MARGIN).div(100))).plus(laborCost).plus(fee);
    const suggested = supper
      ? (tickets.gt(0) ? needed.div(keep).div(tickets) : null)
      : Decimal.max(0, needed.minus(groceries));
    const up = (d) => (d === null ? null : d.toDecimalPlaces(MONEY_DP, Decimal.ROUND_UP).toFixed(MONEY_DP));
    flat = {
      flatPrice: money(price),
      tickets: tickets?.toString() ?? null,
      hoamsyPercent: hoamsyOn ? hoamsy.toString() : null, // null: no Hoamsy fee
      gross: money(gross), // what the tickets bring in, before Hoamsy's fee
      pool: money(pool), // what's shared out across the menu
      groceries: money(groceries),
      passThrough: money(passThrough), // labor and the vendor fee, paid back at cost before the menu's share
      suggestedPrice: up(suggested),
    };
  }

  // Hoamsy's fee came off the top, so it's already out of the revenue.
  const profit = revenue.minus(totalCost).minus(fee);
  const allFood = totalCost.minus(laborCost); // what the food comes to, amounts set by hand included
  // The food's revenue: at a flat-rate event, what's left once labor and the vendor fee are paid back.
  const foodRevenue = flat ? revenue.minus(laborCost).minus(fee) : revenue;
  let purchaseCost = new Decimal(0);
  let packsAdjustment = new Decimal(0); // what packs set by hand changed the trip's cost by
  const shoppingList = [...shopping.values()]
    .map((e) => {
      const size = toDecimal(e.packSize) ?? new Decimal(1);
      const calculated = e.amount.div(size).ceil();
      // Packs set by hand (stock on hand, a spare) change what the trip buys, never the food cost.
      const set = e.ingredientId ? toDecimal(packs[e.ingredientId]) : null;
      const n = set ?? calculated;
      const bought = e.packPrice === null ? null : n.times(e.packPrice);
      if (bought) purchaseCost = purchaseCost.plus(bought);
      if (set !== null && e.packPrice !== null) packsAdjustment = packsAdjustment.plus(set.minus(calculated).times(e.packPrice));
      return {
        ...e,
        amount: cost(e.amount),
        packsToBuy: n.toString(),
        ...(set !== null && { packsSet: true, calculatedPacks: calculated.toString() }),
        leftover: cost(n.times(size).minus(e.amount)), // below 0: the rest comes from stock
        usedCost: cost(e.usedCost),
        purchaseCost: bought === null ? null : cost(bought),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    recipes: recipeSummaries,
    sauces: sauceSummaries,
    totalCost: cost(totalCost),
    adjustment: cost(adjustment),
    purchaseCost: cost(purchaseCost),
    packsAdjustment: cost(packsAdjustment),
    revenue: money(revenue),
    kind,
    flat, // a personal chef job's or supper club's rate, tickets and what it all comes to; null at a market
    vendorFee: money(fee),
    hoamsyFee: money(hoamsyFee),
    labor: { hours: hours.toString(), rate: rate === null ? null : money(rate), cost: money(laborCost) },
    profit: money(profit),
    grossMarginPercent: foodRevenue.lte(0) ? null : foodRevenue.minus(allFood).div(foodRevenue).times(100).toFixed(1),
    marginPercent: revenue.isZero() ? null : profit.div(revenue).times(100).toFixed(1), // net
    shoppingList,
    warnings,
  };
}
export * from './units.js';
export * from './names.js';
