import { Router } from 'express';
import { CalcError, Decimal, SAUCE_CONTAINERS, paymentFee, saleItem, summarizeEvent } from '@kitchen/shared';
import { query, tx, fkViolation } from '../db.js';
import { loadRecipes } from './recipes.js';
import { loadBlends } from '../blends.js';
import { badRequest, notFound, text, number, date, uuid, array } from '../validate.js';
import { sendCsv, slug } from '../csv.js';

const router = Router();

const EVENT_COLUMNS = `e.id, e.name, e.event_date AS "date", e.guest_count AS "guestCount", e.created_at AS "createdAt", e.is_test AS "isTest",
  e.actual_guests AS "actualGuests", e.actual_revenue AS "actualRevenue", e.actual_cost AS "actualCost", e.notes,
  e.vendor_fee AS "vendorFee"`;

/** The vendor fee and after-the-event results, as columns to set: only the fields present in the body (blank clears one). */
function resultFields(body) {
  const fields = {
    vendorFee: ['vendor_fee', (v) => number(v, 'Vendor fee', { min: 0 })],
    actualGuests: ['actual_guests', (v) => number(v, 'Actual guests', { integer: true, min: 0 })],
    actualRevenue: ['actual_revenue', (v) => number(v, 'Actual revenue', { min: 0 })],
    actualCost: ['actual_cost', (v) => number(v, 'Actual spend', { min: 0 })],
    notes: ['notes', (v) => text(v, 'Notes', { max: 5000 })],
  };
  return Object.entries(fields).filter(([key]) => key in body).map(([key, [column, check]]) => [column, check(body[key])]);
}

/**
 * A recipe's price at this event: `salePrice` per serving (blank: the recipe's own price) and an
 * optional deal of `discountAmount` off every `discountQty` servings (blank count: per serving).
 * Returns only the fields present in `r`, as columns.
 */
function pricingFields(r, label) {
  const out = {};
  if ('salePrice' in r) out.sale_price = number(r.salePrice, `${label}: sale price`, { min: 0 });
  if ('discountAmount' in r || 'discountQty' in r) {
    const amount = number(r.discountAmount, `${label}: discount`, { min: 0 });
    const qty = number(r.discountQty, `${label}: discount servings`, { integer: true, min: 1 });
    const none = amount === null || Number(amount) === 0;
    out.discount_amount = none ? null : amount;
    out.discount_qty = none || qty === 1 ? null : qty;
  }
  return out;
}

const PRICING_COLUMNS = ['sale_price', 'discount_amount', 'discount_qty'];

function eventFields(body) {
  const recipes = body.recipes === undefined
    ? undefined
    : array(body.recipes, 'recipes').map((r, i) => ({
        recipeId: uuid(r.recipeId, `Recipe ${i + 1}`),
        expectedServings: number(r.expectedServings, `Recipe ${i + 1}: servings`, { required: true, integer: true, min: 0 }),
        pricing: pricingFields(r, `Recipe ${i + 1}`),
      }));
  if (recipes && new Set(recipes.map((r) => r.recipeId)).size !== recipes.length) {
    throw badRequest('Each recipe can only be added to an event once');
  }
  // Sauces are sold by the serving and made in containers of `container` size; no deals.
  const sauces = body.sauces === undefined
    ? undefined
    : array(body.sauces, 'sauces').map((b, i) => {
        const container = b.container == null || b.container === '' ? null : b.container;
        if (container !== null && !Object.hasOwn(SAUCE_CONTAINERS, container)) {
          throw badRequest(`Sauce ${i + 1}: container must be one of ${Object.keys(SAUCE_CONTAINERS).join(', ')}`);
        }
        return {
          blendId: uuid(b.blendId, `Sauce ${i + 1}`),
          servings: number(b.servings, `Sauce ${i + 1}: servings`, { required: true, integer: true, min: 1 }),
          container,
          pricing: { sale_price: number(b.salePrice, `Sauce ${i + 1}: sale price`, { min: 0 }) },
        };
      });
  if (sauces && new Set(sauces.map((b) => b.blendId)).size !== sauces.length) {
    throw badRequest('Each sauce can only be added to an event once');
  }
  return {
    sauces,
    name: text(body.name, 'Event name', { required: true }),
    date: date(body.date, 'Event date', { required: true }),
    guestCount: number(body.guestCount, 'Guest count', { integer: true, min: 0 }),
    recipes,
  };
}

// Pricing fields left out of a recipe keep what the event had for it.
async function replaceRecipes(c, eventId, recipes) {
  const { rows } = await c.query(`SELECT recipe_id, ${PRICING_COLUMNS.join(', ')} FROM event_recipes WHERE event_id = $1`, [eventId]);
  const before = new Map(rows.map((r) => [r.recipe_id, r]));
  await c.query('DELETE FROM event_recipes WHERE event_id = $1', [eventId]);
  for (const r of recipes) {
    const p = { ...Object.fromEntries(PRICING_COLUMNS.map((col) => [col, before.get(r.recipeId)?.[col] ?? null])), ...r.pricing };
    await c.query(
      `INSERT INTO event_recipes (event_id, recipe_id, expected_servings, ${PRICING_COLUMNS.join(', ')}) VALUES ($1,$2,$3,$4,$5,$6)`,
      [eventId, r.recipeId, r.expectedServings, ...PRICING_COLUMNS.map((col) => p[col])],
    );
  }
}

// Like replaceRecipes: a sale price left out keeps what the event had for that sauce.
async function replaceSauces(c, eventId, sauces, body) {
  const { rows } = await c.query('SELECT blend_id, sale_price FROM event_blends WHERE event_id = $1', [eventId]);
  const before = new Map(rows.map((r) => [r.blend_id, r.sale_price]));
  await c.query('DELETE FROM event_blends WHERE event_id = $1', [eventId]);
  for (const [i, b] of sauces.entries()) {
    const price = 'salePrice' in body.sauces[i] ? b.pricing.sale_price : before.get(b.blendId) ?? null;
    await c.query(
      'INSERT INTO event_blends (event_id, blend_id, servings, container, sale_price) VALUES ($1,$2,$3,$4,$5)',
      [eventId, b.blendId, b.servings, b.container, price],
    );
  }
}

async function getEvent(id) {
  const { rows } = await query(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1`, [id]);
  if (!rows[0]) throw notFound('Event');
  const { rows: recipes } = await query(
    `SELECT er.recipe_id AS "recipeId", r.name, r.base_servings AS "baseServings",
            er.expected_servings AS "expectedServings", er.sale_price AS "salePrice",
            er.discount_amount AS "discountAmount", er.discount_qty AS "discountQty"
     FROM event_recipes er JOIN recipes r ON r.id = er.recipe_id
     WHERE er.event_id = $1 ORDER BY lower(r.name)`,
    [id],
  );
  const { rows: sauces } = await query(
    `SELECT eb.blend_id AS "blendId", b.name, coalesce(eb.container, b.container) AS container, eb.servings,
            eb.sale_price AS "salePrice"
     FROM event_blends eb JOIN spice_blends b ON b.id = eb.blend_id
     WHERE eb.event_id = $1 ORDER BY lower(b.name)`,
    [id],
  );
  return { ...rows[0], recipes, sauces };
}


// GET /api/events?date=YYYY-MM-DD
router.get('/', async (req, res) => {
  const day = date(req.query.date, 'date');
  const { rows } = await query(
    `SELECT ${EVENT_COLUMNS},
            count(er.recipe_id)::int AS "recipeCount",
            coalesce(sum(er.expected_servings), 0)::int AS "totalServings"
     FROM events e LEFT JOIN event_recipes er ON er.event_id = e.id
     ${day ? 'WHERE e.event_date = $1' : ''}
     GROUP BY e.id
     ORDER BY e.event_date DESC, lower(e.name)`,
    day ? [day] : [],
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const f = eventFields(req.body ?? {});
  try {
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO events (name, event_date, guest_count, vendor_fee) VALUES ($1,$2,$3,$4) RETURNING id',
        [f.name, f.date, f.guestCount, number(req.body?.vendorFee, 'Vendor fee', { min: 0 })],
      );
      if (f.recipes) await replaceRecipes(c, rows[0].id, f.recipes);
      if (f.sauces) await replaceSauces(c, rows[0].id, f.sauces, req.body);
      return rows[0].id;
    });
    res.status(201).json(await getEvent(id));
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the recipes or sauces no longer exists');
    throw err;
  }
});

router.get('/:id', async (req, res) => {
  res.json(await getEvent(uuid(req.params.id, 'id')));
});

router.put('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const f = eventFields(req.body ?? {});
  const results = resultFields(req.body ?? {});
  try {
    await tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE events SET name=$2, event_date=$3, guest_count=$4${results.map(([col], i) => `, ${col}=$${i + 5}`).join('')} WHERE id=$1`,
        [id, f.name, f.date, f.guestCount, ...results.map(([, v]) => v)],
      );
      if (!rowCount) throw notFound('Event');
      if (f.recipes) await replaceRecipes(c, id, f.recipes);
      if (f.sauces) await replaceSauces(c, id, f.sauces, req.body);
    });
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the recipes or sauces no longer exists');
    throw err;
  }
  res.json(await getEvent(id));
});

// Attach (or update) a single recipe — used by "Add to Event" in the gallery.
router.post('/:id/recipes', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const recipeId = uuid(req.body?.recipeId, 'Recipe');
  const servings = number(req.body?.expectedServings, 'Servings', { required: true, integer: true, min: 0 });
  // Pricing left out of the body: the recipe's own price for a new entry, unchanged for an existing one.
  const pricing = Object.entries(pricingFields(req.body ?? {}, 'Recipe'));
  try {
    await query(
      `INSERT INTO event_recipes (event_id, recipe_id, expected_servings${pricing.map(([col]) => `, ${col}`).join('')})
       VALUES ($1,$2,$3${pricing.map((_, i) => `,$${i + 4}`).join('')})
       ON CONFLICT (event_id, recipe_id) DO UPDATE SET expected_servings = EXCLUDED.expected_servings${pricing.map(([col]) => `, ${col} = EXCLUDED.${col}`).join('')}`,
      [id, recipeId, servings, ...pricing.map(([, v]) => v)],
    );
  } catch (err) {
    if (fkViolation(err)) throw notFound('Event or recipe');
    throw err;
  }
  res.status(201).json(await getEvent(id));
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await query('DELETE FROM events WHERE id = $1', [uuid(req.params.id, 'id')]);
  if (!rowCount) throw notFound('Event');
  res.status(204).end();
});

async function eventSummary(id) {
  const event = await getEvent(id);
  const recipes = await loadRecipes(event.recipes.map((r) => r.recipeId));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const blends = new Map((await loadBlends(event.sauces.map((b) => b.blendId))).map((b) => [b.id, b]));
  const summary = summarizeEvent(
    event.recipes.map((er) => {
      const r = byId.get(er.recipeId);
      return {
        recipeId: r.id,
        name: r.name,
        baseServings: r.baseServings,
        targetMargin: r.targetMargin,
        expectedServings: er.expectedServings,
        salePrice: er.salePrice,
        discountAmount: er.discountAmount,
        discountQty: er.discountQty,
        lines: r.lines,
      };
    }),
    await loadAmounts(event.id),
    {
      vendorFee: event.vendorFee,
      sauces: event.sauces.map((b) => ({ ...b, blend: blends.get(b.blendId) })),
    },
  );
  return { event, ...summary };
}

// Aggregated financials and the consolidated shopping list.
router.get('/:id/summary', async (req, res) => {
  res.json(await eventSummary(uuid(req.params.id, 'id')));
});

router.get('/:id/shopping-list.csv', async (req, res) => {
  const { event, shoppingList } = await eventSummary(uuid(req.params.id, 'id'));
  sendCsv(res, `${slug(event.name)}-${event.date}-shopping-list.csv`, [
    ['Ingredient', 'name', { text: true }],
    ['Category', 'category', { text: true }],
    ['Needed', 'amount'],
    ['Unit', 'uom', { text: true }],
    ['Packs to buy', 'packsToBuy'],
    ['Pack size', (l) => l.packSize],
    ['Total cost', 'purchaseCost'],
    ['Used cost', 'usedCost'],
    ['Leftover', 'leftover'],
    ['Vendor', 'vendor', { text: true }],
    ['Used in', (l) => l.recipes.join('; '), { text: true }],
  ], shoppingList);
});

// ---------- Sales recorded during the event ----------

const PAYMENT_METHODS = ['cash', 'card', 'venmo', 'cashapp', 'free'];

/** Every recorded sale (newest first) and the running totals: per recipe, per payment method, overall. */
async function salesReport(eventId) {
  const { rows: sales } = await query(
    `SELECT s.id, s.payment_method AS "paymentMethod", s.created_at AS "createdAt", s.fee::text AS fee,
            json_agg(json_build_object(
              'recipeId', i.recipe_id, 'blendId', i.blend_id, 'name', i.name, 'quantity', i.quantity, 'unitPrice', i.unit_price::text,
              'deals', i.deals, 'discount', i.discount::text, 'amount', i.amount::text) ORDER BY i.position) AS items
       FROM event_sales s JOIN event_sale_items i ON i.sale_id = s.id
      WHERE s.event_id = $1
      GROUP BY s.id ORDER BY s.created_at DESC, s.id`,
    [eventId],
  );
  const zero = () => new Decimal(0);
  const recipes = new Map();
  const methods = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, { sales: 0, amount: zero(), fees: zero() }]));
  let fees = zero();
  let sold = 0;
  let givenAway = 0;
  let deals = 0;
  let discounts = zero();
  let revenue = zero();
  for (const sale of sales) {
    const free = sale.paymentMethod === 'free';
    sale.total = sale.items.reduce((sum, i) => sum.plus(i.amount), zero()).toFixed(2);
    methods[sale.paymentMethod].sales += 1;
    methods[sale.paymentMethod].amount = methods[sale.paymentMethod].amount.plus(sale.total);
    methods[sale.paymentMethod].fees = methods[sale.paymentMethod].fees.plus(sale.fee);
    fees = fees.plus(sale.fee);
    revenue = revenue.plus(sale.total);
    for (const i of sale.items) {
      const key = i.recipeId ?? (i.blendId && `blend:${i.blendId}`) ?? `name:${i.name}`;
      const r = recipes.get(key) ?? { recipeId: i.recipeId, blendId: i.blendId, name: i.name, sold: 0, givenAway: 0, deals: 0, revenue: zero() };
      if (free) r.givenAway += i.quantity;
      else r.sold += i.quantity;
      r.deals += i.deals;
      r.revenue = r.revenue.plus(i.amount);
      recipes.set(key, r);
      if (free) givenAway += i.quantity;
      else sold += i.quantity;
      deals += i.deals;
      discounts = discounts.plus(i.discount);
    }
  }
  return {
    sales,
    totals: {
      sales: sales.length,
      sold,
      givenAway,
      deals,
      discounts: discounts.toFixed(2),
      revenue: revenue.toFixed(2),
      fees: fees.toFixed(2), // charged on top for Venmo and Cash App, and kept by them
      charged: revenue.plus(fees).toFixed(2), // what customers paid
      byMethod: Object.fromEntries(Object.entries(methods).map(([m, v]) => [m, { sales: v.sales, amount: v.amount.toFixed(2), fees: v.fees.toFixed(2) }])),
      byRecipe: [...recipes.values()].map((r) => ({ ...r, revenue: r.revenue.toFixed(2) })),
    },
  };
}

router.get('/:id/sales', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  await getEvent(id); // 404 for an unknown event
  res.json(await salesReport(id));
});

// Record one line: the items a customer bought and how they paid ('free': given away).
// Prices and deals come from the event's current pricing, not the request.
router.post('/:id/sales', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const method = req.body?.paymentMethod;
  if (!PAYMENT_METHODS.includes(method)) throw badRequest('Choose how it was paid: cash, card, Venmo, Cash App, or given away');
  // An item is a recipe ({ recipeId }) or a sauce sold by the container ({ blendId }).
  const items = array(req.body?.items, 'items').map((it, i) => ({
    ...(it?.blendId ? { blendId: uuid(it.blendId, `Item ${i + 1}`) } : { recipeId: uuid(it?.recipeId, `Item ${i + 1}`) }),
    quantity: number(it?.quantity, `Item ${i + 1}: quantity`, { required: true, integer: true, min: 1 }),
    dealUsed: it?.dealUsed === true,
  }));
  if (!items.length) throw badRequest('Add at least one item to the sale');
  const itemKey = (it) => it.recipeId ?? `blend:${it.blendId}`;
  if (new Set(items.map(itemKey)).size !== items.length) throw badRequest('List each recipe once, with its quantity');

  const { recipes, sauces } = await eventSummary(id);
  const byId = new Map([
    ...recipes.map((r) => [r.recipeId, r]),
    ...sauces.map((b) => [`blend:${b.blendId}`, { ...b, recipeId: null }]),
  ]);
  const free = method === 'free';
  const lines = items.map((it) => {
    const r = byId.get(itemKey(it));
    if (!r) throw badRequest(it.blendId ? 'That sauce isn’t on this event’s menu' : 'That recipe isn’t on this event’s menu');
    if (it.dealUsed && !free) {
      if (!r.discountAmount) throw badRequest(`${r.name} has no deal at this event`);
      if (it.quantity < (r.discountQty ?? 1)) throw badRequest(`${r.name}’s deal needs ${r.discountQty} or more`);
    }
    try {
      return { name: r.name, recipeId: r.recipeId, blendId: r.blendId ?? null, ...saleItem({ ...r, quantity: it.quantity, dealUsed: it.dealUsed, free }) };
    } catch (err) {
      if (err instanceof CalcError) throw badRequest(err.message);
      throw err;
    }
  });
  await tx(async (c) => {
    const total = lines.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
    const { rows } = await c.query(
      'INSERT INTO event_sales (event_id, payment_method, fee) VALUES ($1, $2, $3) RETURNING id',
      [id, method, paymentFee(method, total)],
    );
    for (const [position, l] of lines.entries()) {
      await c.query(
        `INSERT INTO event_sale_items (sale_id, position, recipe_id, blend_id, name, quantity, unit_price, deals, discount, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [rows[0].id, position, l.recipeId, l.blendId, l.name, l.quantity, l.unitPrice, l.deals, l.discount, l.amount],
      );
    }
  });
  res.status(201).json(await salesReport(id));
});

// Undo a recorded sale.
router.delete('/:id/sales/:saleId', async (req, res) => {
  const { rowCount } = await query('DELETE FROM event_sales WHERE id = $1 AND event_id = $2', [
    uuid(req.params.saleId, 'saleId'), uuid(req.params.id, 'id'),
  ]);
  if (!rowCount) throw notFound('Sale');
  res.status(204).end();
});

async function loadAmounts(eventId) {
  const { rows } = await query('SELECT ingredient_id, amount FROM event_amounts WHERE event_id = $1', [eventId]);
  return Object.fromEntries(rows.map((r) => [r.ingredient_id, r.amount]));
}

// Set the shopping list's "needed" amount for one ingredient by hand (labor), or clear it
// to go back to the recipes' scaled total.
router.put('/:id/amounts/:ingredientId', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const ingredientId = uuid(req.params.ingredientId, 'ingredientId');
  const amount = number(req.body?.amount, 'Needed', { required: true, min: 0 });
  try {
    await query(
      `INSERT INTO event_amounts (event_id, ingredient_id, amount) VALUES ($1,$2,$3)
       ON CONFLICT (event_id, ingredient_id) DO UPDATE SET amount = EXCLUDED.amount`,
      [id, ingredientId, amount],
    );
  } catch (err) {
    if (fkViolation(err)) throw notFound('Event or ingredient');
    throw err;
  }
  res.status(204).end();
});

router.delete('/:id/amounts/:ingredientId', async (req, res) => {
  await query('DELETE FROM event_amounts WHERE event_id = $1 AND ingredient_id = $2', [
    uuid(req.params.id, 'id'), uuid(req.params.ingredientId, 'ingredientId'),
  ]);
  res.status(204).end();
});

export default router;
