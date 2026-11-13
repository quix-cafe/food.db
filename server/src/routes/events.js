import { Router } from 'express';
import { CalcError, Decimal, EVENT_KINDS, ORDER_STATUSES, SAUCE_CONTAINERS, menuItemName, paymentFee, saleItem, summarizeEvent } from '@kitchen/shared';
import { query, tx, fkViolation } from '../db.js';
import { loadRecipes, rememberDeal } from './recipes.js';
import { loadBlends } from '../blends.js';
import { HttpError, badRequest, notFound, text, number, date, uuid, array } from '../validate.js';
import { sendCsv, slug } from '../csv.js';
import { lastEdit, lastOrder, orderHistory } from '../audit.js';

const router = Router();

const EVENT_COLUMNS = `e.id, e.name, e.event_date AS "date", e.guest_count AS "guestCount", e.created_at AS "createdAt", e.is_test AS "isTest",
  e.actual_guests AS "actualGuests", e.actual_revenue AS "actualRevenue", e.actual_cost AS "actualCost", e.notes,
  e.vendor_fee AS "vendorFee", e.kind, e.flat_price AS "flatPrice", e.hoamsy_percent AS "hoamsyPercent", e.labor_hours AS "laborHours", e.labor_rate AS "laborRate", e.version`;

const eventKind = (v) => {
  if (!EVENT_KINDS.includes(v)) throw badRequest('The event type must be a market, personal cheffing or a supper club');
  return v;
};

/** The vendor fee, type and rate, and after-the-event results, as columns to set: only the fields present in the body (blank clears one). */
function resultFields(body) {
  const fields = {
    vendorFee: ['vendor_fee', (v) => number(v, 'Vendor fee', { min: 0 })],
    kind: ['kind', eventKind],
    flatPrice: ['flat_price', (v) => number(v, body.kind === 'supper_club' ? 'Plate price' : 'Flat rate', { min: 0 })],
    hoamsyPercent: ['hoamsy_percent', (v) => number(v, 'Hoamsy fee', { min: 0, max: 100, maxExclusive: true })],
    actualGuests: ['actual_guests', (v) => number(v, 'Actual guests', { integer: true, min: 0 })],
    actualRevenue: ['actual_revenue', (v) => number(v, 'Actual revenue', { min: 0 })],
    actualCost: ['actual_cost', (v) => number(v, 'Actual spend', { min: 0 })],
    notes: ['notes', (v) => text(v, 'Notes', { max: 5000 })],
  };
  return Object.entries(fields).filter(([key]) => key in body).map(([key, [column, check]]) => [column, check(body[key])]);
}

/**
 * A recipe's price at this event: `salePrice` per serving (blank: the recipe's own price) and an
 * optional deal of `dealQty` servings for `dealPrice` ("3 for $15"),
 * for a serving of `servingSize` in the recipe's yield unit (blank: the recipe's own size).
 * Returns only the fields present in `r`, as columns.
 */
function pricingFields(r, label) {
  const out = {};
  if ('salePrice' in r) out.sale_price = number(r.salePrice, `${label}: sale price`, { min: 0 });
  if ('servingSize' in r) out.serving_size = number(r.servingSize, `${label}: size per serving`, { min: 0.0001 });
  if ('dealPrice' in r || 'dealQty' in r) {
    out.deal_price = number(r.dealPrice, `${label}: deal price`, { min: 0, minExclusive: true });
    out.deal_qty = number(r.dealQty, `${label}: deal servings`, { integer: true, min: 2 });
    if ((out.deal_price === null) !== (out.deal_qty === null)) throw badRequest(`${label}: a deal needs how many and a price`);
  }
  return out;
}

const PRICING_COLUMNS = ['sale_price', 'deal_price', 'deal_qty', 'serving_size'];

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
      `INSERT INTO event_recipes (event_id, recipe_id, expected_servings, ${PRICING_COLUMNS.join(', ')}) VALUES ($1,$2,$3${PRICING_COLUMNS.map((_, i) => `,$${i + 4}`).join('')})`,
      [eventId, r.recipeId, r.expectedServings, ...PRICING_COLUMNS.map((col) => p[col])],
    );
    const had = before.get(r.recipeId);
    if (r.pricing.deal_qty && (r.pricing.deal_qty !== had?.deal_qty || Number(r.pricing.deal_price) !== Number(had?.deal_price))) await rememberDeal(c, r.recipeId, r.pricing.deal_qty, r.pricing.deal_price);
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
            er.deal_price AS "dealPrice", er.deal_qty AS "dealQty", er.serving_size AS "servingSize"
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
            coalesce(sum(er.expected_servings), 0)::int AS "totalServings",
            (SELECT count(*)::int FROM event_blends eb WHERE eb.event_id = e.id) AS "sauceCount",
            (SELECT count(*)::int FROM event_sales s WHERE s.event_id = e.id AND s.status = 'in_progress') AS "openOrders",
            (SELECT max(s.created_at) FROM event_sales s WHERE s.event_id = e.id) AS "lastOrderAt"
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
        // Labor's rate starts at the newest event's, the rate most likely still paid.
        `INSERT INTO events (name, event_date, guest_count, vendor_fee, kind, flat_price, labor_rate)
         VALUES ($1,$2,$3,$4,$5,$6, (SELECT labor_rate FROM events WHERE labor_rate IS NOT NULL ORDER BY created_at DESC LIMIT 1)) RETURNING id`,
        [f.name, f.date, f.guestCount, number(req.body?.vendorFee, 'Vendor fee', { min: 0 }),
          req.body?.kind === undefined ? 'market' : eventKind(req.body.kind), number(req.body?.flatPrice, 'Rate', { min: 0 })],
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

// The event page's own read and save say who last edited the plan and entered an order; nothing else needs to look it up.
const eventForPage = async (id, req) => ({ ...await getEvent(id), lastEditedBy: await lastEdit(id, req.ip), lastOrderBy: await lastOrder(id) });

router.get('/:id', async (req, res) => {
  res.json(await eventForPage(uuid(req.params.id, 'id'), req));
});

router.put('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const f = eventFields(req.body ?? {});
  const results = resultFields(req.body ?? {});
  // Required, so a page from before versions (or any old copy of the plan) can't save over newer work.
  const version = number(req.body?.version, 'Version', { integer: true, min: 1 });
  if (version === null) throw new HttpError(409, 'This page is out of date. Refresh it, then make your change again.');
  try {
    await tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE events SET name=$3, event_date=$4, guest_count=$5, version=version+1${results.map(([col], i) => `, ${col}=$${i + 6}`).join('')} WHERE id=$1 AND version=$2`,
        [id, version, f.name, f.date, f.guestCount, ...results.map(([, v]) => v)],
      );
      if (!rowCount) {
        const { rowCount: exists } = await c.query('SELECT 1 FROM events WHERE id = $1', [id]);
        throw exists ? new HttpError(409, 'This event was changed somewhere else.') : notFound('Event');
      }
      if (f.recipes) await replaceRecipes(c, id, f.recipes);
      if (f.sauces) await replaceSauces(c, id, f.sauces, req.body);
    });
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the recipes or sauces no longer exists');
    throw err;
  }
  res.json(await eventForPage(id, req));
});

// Attach (or update) a single recipe — used by "Add to Event" in the gallery.
router.post('/:id/recipes', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const recipeId = uuid(req.body?.recipeId, 'Recipe');
  const servings = number(req.body?.expectedServings, 'Servings', { required: true, integer: true, min: 0 });
  // Pricing left out of the body: the recipe's own price for a new entry, unchanged for an existing one.
  const pricing = Object.entries(pricingFields(req.body ?? {}, 'Recipe'));
  try {
    await tx(async (c) => {
      await c.query(
        `INSERT INTO event_recipes (event_id, recipe_id, expected_servings${pricing.map(([col]) => `, ${col}`).join('')})
         VALUES ($1,$2,$3${pricing.map((_, i) => `,$${i + 4}`).join('')})
         ON CONFLICT (event_id, recipe_id) DO UPDATE SET expected_servings = EXCLUDED.expected_servings${pricing.map(([col]) => `, ${col} = EXCLUDED.${col}`).join('')}`,
        [id, recipeId, servings, ...pricing.map(([, v]) => v)],
      );
      await c.query('UPDATE events SET version = version + 1 WHERE id = $1', [id]);
      const deal = Object.fromEntries(pricing);
      if (deal.deal_qty) await rememberDeal(c, recipeId, deal.deal_qty, deal.deal_price);
    });
  } catch (err) {
    if (fkViolation(err)) throw notFound('Event or recipe');
    throw err;
  }
  res.status(201).json(await getEvent(id));
});

// A copy of the plan (guests, vendor fee, recipes and sauces with their pricing, amounts set on
// the shopping list) under a new name and date; results, notes and sales stay with the original.
router.post('/:id/duplicate', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const name = text(req.body?.name, 'Event name');
  const day = date(req.body?.date, 'Date');
  const newId = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO events (name, event_date, guest_count, vendor_fee, kind, flat_price, hoamsy_percent, labor_hours, labor_rate)
       SELECT coalesce($2, name || ' (copy)'), coalesce($3::date, event_date), guest_count, vendor_fee, kind, flat_price, hoamsy_percent, labor_hours, labor_rate FROM events WHERE id = $1
       RETURNING id`,
      [id, name, day],
    );
    if (!rows[0]) throw notFound('Event');
    const copy = rows[0].id;
    await c.query(
      `INSERT INTO event_recipes (event_id, recipe_id, expected_servings, ${PRICING_COLUMNS.join(', ')})
       SELECT $2, recipe_id, expected_servings, ${PRICING_COLUMNS.join(', ')} FROM event_recipes WHERE event_id = $1`,
      [id, copy],
    );
    await c.query(
      `INSERT INTO event_blends (event_id, blend_id, servings, container, sale_price)
       SELECT $2, blend_id, servings, container, sale_price FROM event_blends WHERE event_id = $1`,
      [id, copy],
    );
    await c.query(
      `INSERT INTO event_amounts (event_id, ingredient_id, amount) SELECT $2, ingredient_id, amount FROM event_amounts WHERE event_id = $1`,
      [id, copy],
    );
    await c.query(
      `INSERT INTO event_packs (event_id, ingredient_id, packs) SELECT $2, ingredient_id, packs FROM event_packs WHERE event_id = $1`,
      [id, copy],
    );
    return copy;
  });
  res.status(201).json(await getEvent(newId));
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
        totalYield: r.totalYield,
        yieldUnit: r.yieldUnit,
        servingSize: er.servingSize,
        targetMargin: r.targetMargin,
        targetPrice: r.targetPrice,
        expectedServings: er.expectedServings,
        salePrice: er.salePrice,
        dealPrice: er.dealPrice,
        dealQty: er.dealQty,
        lines: r.lines,
      };
    }),
    await loadAmounts(event.id),
    {
      packs: await loadPacks(event.id),
      vendorFee: event.vendorFee,
      sauces: event.sauces.map((b) => ({ ...b, blend: blends.get(b.blendId) })),
      labor: { hours: event.laborHours, rate: event.laborRate },
      format: { kind: event.kind, flatPrice: event.flatPrice, tickets: event.guestCount, hoamsyPercent: event.hoamsyPercent },
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

const orderStatus = (value) => {
  if (!ORDER_STATUSES.includes(value)) throw badRequest('Status must be in progress, completed or cancelled');
  return value;
};

/** Every recorded sale (newest first) and the running totals, which leave out cancelled orders: per recipe, per payment method, overall. */
async function salesReport(eventId) {
  const { rows: sales } = await query(
    `SELECT s.id, s.payment_method AS "paymentMethod", s.created_at AS "createdAt", s.fee::text AS fee,
            s.customer_name AS "customerName", s.note, s.status, s.status_changed_at AS "statusChangedAt",
            s.in_progress_at AS "inProgressAt", s.completed_at AS "completedAt",
            json_agg(json_build_object(
              'recipeId', i.recipe_id, 'blendId', i.blend_id, 'name', i.name, 'quantity', i.quantity, 'unitPrice', i.unit_price::text,
              'deals', i.deals, 'discount', i.discount::text, 'amount', i.amount::text, 'note', i.note) ORDER BY i.position) AS items
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
  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const sale of sales) {
    const free = sale.paymentMethod === 'free';
    sale.total = sale.items.reduce((sum, i) => sum.plus(i.amount), zero()).toFixed(2);
    byStatus[sale.status] += 1;
    if (sale.status === 'cancelled') continue;
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
      sales: sales.length - byStatus.cancelled,
      byStatus,
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
  const report = await salesReport(id);
  if (req.query.history) report.history = await orderHistory(report.sales.map((s) => s.id));
  res.json(report);
});

// Record one line: the items a customer bought and how they paid ('free': given away), with
// the customer's name and notes for the kitchen (on the order, and on each item) if given. It's
// completed unless a `status` says it's still to be made (in_progress, started now).
// Prices and deals come from the event's current pricing, not the request.
router.post('/:id/sales', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const method = req.body?.paymentMethod;
  if (!PAYMENT_METHODS.includes(method)) throw badRequest('Choose how it was paid: cash, card, Venmo, Cash App, or given away');
  const customerName = text(req.body?.customerName, 'Name', { max: 120 });
  const note = text(req.body?.note, 'Note', { max: 500 });
  const status = req.body?.status === undefined ? 'completed' : orderStatus(req.body.status);
  // An item is a recipe ({ recipeId }) or a sauce sold by the container ({ blendId }).
  const items = array(req.body?.items, 'items').map((it, i) => ({
    ...(it?.blendId ? { blendId: uuid(it.blendId, `Item ${i + 1}`) } : { recipeId: uuid(it?.recipeId, `Item ${i + 1}`) }),
    quantity: number(it?.quantity, `Item ${i + 1}: quantity`, { required: true, integer: true, min: 1 }),
    note: text(it?.note, `Item ${i + 1}: note`, { max: 300 }),
  }));
  if (!items.length) throw badRequest('Add at least one item to the sale');
  const itemKey = (it) => it.recipeId ?? `blend:${it.blendId}`;
  if (new Set(items.map(itemKey)).size !== items.length) throw badRequest('List each recipe once, with its quantity');

  const summary = await eventSummary(id);
  // A personal chef job or supper club is paid for up front: its POS only sends orders to the
  // kitchen, every dish free (the summary gives them no price).
  if (summary.kind !== 'market' && method !== 'free') throw badRequest('This event’s dishes are paid for up front: place them as an order, with no payment');
  const byId = new Map([
    ...summary.recipes.map((r) => [r.recipeId, r]),
    ...summary.sauces.map((b) => [`blend:${b.blendId}`, { ...b, recipeId: null }]),
  ]);
  const free = method === 'free';
  const lines = items.map((it) => {
    const r = byId.get(itemKey(it));
    if (!r) {
      throw badRequest(it.blendId ? 'That sauce isn’t on this event’s menu' : 'That recipe isn’t on this event’s menu');
    }
    try {
      return { name: menuItemName(r), note: it.note, recipeId: r.recipeId, blendId: r.blendId ?? null, recipeServings: r.recipeServings ?? '1', ...saleItem({ ...r, quantity: it.quantity, free }) };
    } catch (err) {
      if (err instanceof CalcError) throw badRequest(err.message);
      throw err;
    }
  });
  await tx(async (c) => {
    const total = lines.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
    const { rows } = await c.query(
      `INSERT INTO event_sales (event_id, payment_method, fee, customer_name, note, status, in_progress_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'in_progress' THEN now() END) RETURNING id`,
      [id, method, paymentFee(method, total), customerName, note, status],
    );
    for (const [position, l] of lines.entries()) {
      await c.query(
        `INSERT INTO event_sale_items (sale_id, position, recipe_id, blend_id, name, quantity, unit_price, deals, discount, amount, recipe_servings, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [rows[0].id, position, l.recipeId, l.blendId, l.name, l.quantity, l.unitPrice, l.deals, l.discount, l.amount, l.recipeServings, l.note],
      );
    }
  });
  res.status(201).json(await salesReport(id));
});

// Change an order's name, note or status, at any point and in any direction: only the fields
// present. Back to in progress (reopened) keeps its start and clears its end.
router.patch('/:id/sales/:saleId', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const body = req.body ?? {};
  const name = 'customerName' in body;
  const note = 'note' in body;
  const status = 'status' in body ? orderStatus(body.status) : null;
  const { rowCount } = await query(
    `UPDATE event_sales SET
       customer_name = CASE WHEN $3 THEN $4 ELSE customer_name END,
       note = CASE WHEN $6 THEN $7 ELSE note END,
       status = coalesce($5, status),
       status_changed_at = CASE WHEN status IS DISTINCT FROM coalesce($5, status) THEN now() ELSE status_changed_at END,
       in_progress_at = CASE WHEN $5 = 'in_progress' THEN coalesce(in_progress_at, now()) ELSE in_progress_at END,
       completed_at = CASE WHEN $5 = 'in_progress' THEN NULL WHEN $5 = 'completed' AND status <> 'completed' THEN now() ELSE completed_at END
     WHERE id = $1 AND event_id = $2`,
    [uuid(req.params.saleId, 'saleId'), id, name, name ? text(body.customerName, 'Name', { max: 120 }) : null, status,
      note, note ? text(body.note, 'Note', { max: 500 }) : null],
  );
  if (!rowCount) throw notFound('Order');
  res.json(await salesReport(id));
});

// Undo a recorded sale.
router.delete('/:id/sales/:saleId', async (req, res) => {
  const { rowCount } = await query('DELETE FROM event_sales WHERE id = $1 AND event_id = $2', [
    uuid(req.params.saleId, 'saleId'), uuid(req.params.id, 'id'),
  ]);
  if (!rowCount) throw notFound('Sale');
  res.status(204).end();
});

async function loadPacks(eventId) {
  const { rows } = await query('SELECT ingredient_id, packs FROM event_packs WHERE event_id = $1', [eventId]);
  return Object.fromEntries(rows.map((r) => [r.ingredient_id, r.packs]));
}

async function loadAmounts(eventId) {
  const { rows } = await query('SELECT ingredient_id, amount FROM event_amounts WHERE event_id = $1', [eventId]);
  return Object.fromEntries(rows.map((r) => [r.ingredient_id, r.amount]));
}

// The event's labor, from its Financials: `hours` and the hourly `rate`, only the fields present
// (a blank rate clears it). Apart from the plan's versioned save, which never sends them.
router.put('/:id/labor', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const body = req.body ?? {};
  const sets = [];
  if ('hours' in body) sets.push(['labor_hours', number(body.hours, 'Hours', { required: true, min: 0, max: 999999 })]);
  if ('rate' in body) sets.push(['labor_rate', number(body.rate, 'Rate', { min: 0, max: 99999999 })]);
  if (!sets.length) throw badRequest('Send hours or a rate');
  const { rowCount } = await query(
    `UPDATE events SET ${sets.map(([col], i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...sets.map(([, v]) => v)],
  );
  if (!rowCount) throw notFound('Event');
  res.json(await eventSummary(id));
});

// Set the shopping list's "needed" amount for one ingredient by hand, or clear it
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

// Set the shopping list's packs to buy for one ingredient by hand (stock on hand, a spare), or
// clear it to go back to whole packs covering what's needed. Answers with the new summary.
router.put('/:id/packs/:ingredientId', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const ingredientId = uuid(req.params.ingredientId, 'ingredientId');
  const packs = number(req.body?.packs, 'Packs to buy', { required: true, min: 0, max: 99999999 });
  try {
    await query(
      `INSERT INTO event_packs (event_id, ingredient_id, packs) VALUES ($1,$2,round($3::numeric, 2))
       ON CONFLICT (event_id, ingredient_id) DO UPDATE SET packs = EXCLUDED.packs`,
      [id, ingredientId, packs],
    );
  } catch (err) {
    if (fkViolation(err)) throw notFound('Event or ingredient');
    throw err;
  }
  res.json(await eventSummary(id));
});

router.delete('/:id/packs/:ingredientId', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  await query('DELETE FROM event_packs WHERE event_id = $1 AND ingredient_id = $2', [id, uuid(req.params.ingredientId, 'ingredientId')]);
  res.json(await eventSummary(id));
});

router.delete('/:id/amounts/:ingredientId', async (req, res) => {
  await query('DELETE FROM event_amounts WHERE event_id = $1 AND ingredient_id = $2', [
    uuid(req.params.id, 'id'), uuid(req.params.ingredientId, 'ingredientId'),
  ]);
  res.status(204).end();
});

export default router;
