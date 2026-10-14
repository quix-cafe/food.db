import { Router } from 'express';
import { completePurchaseCosts, percentChange, CalcError } from '@kitchen/shared';
import { query, tx } from '../db.js';
import { LATEST_PURCHASE, INGREDIENT_COLUMNS } from '../sql.js';
import { normalizeReceipt } from '../services/receipt.js';
import { HttpError, badRequest, notFound, text, number, date, uuid, array, today } from '../validate.js';

const router = Router();
const PRICE_HIKE_THRESHOLD = Number(process.env.PRICE_HIKE_THRESHOLD ?? 10);

function ingredientFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'name' in body) out.name = text(body.name, 'Name', { required: true });
  if (!partial || 'category' in body) out.category = text(body.category, 'Category', { max: 80 });
  if (!partial || 'defaultYieldPercent' in body) {
    out.defaultYieldPercent = number(body.defaultYieldPercent, 'Default yield %', { min: 0, minExclusive: true, max: 100 }) ?? '100';
  }
  return out;
}

function purchaseFields(p) {
  const quantity = number(p.quantity, 'Quantity', { required: true, min: 0, minExclusive: true });
  const unitCost = number(p.unitCost, 'Unit cost', { min: 0 });
  const totalCost = number(p.totalCost, 'Total cost', { min: 0 });
  let costs;
  try {
    costs = completePurchaseCosts({ quantity, unitCost, totalCost });
  } catch (err) {
    if (err instanceof CalcError) throw badRequest(err.message);
    throw err;
  }
  return {
    date: date(p.date, 'Date') ?? today(),
    vendor: text(p.vendor, 'Vendor', { max: 120 }),
    quantity,
    weight: number(p.weight, 'Weight', { min: 0 }),
    unit: text(p.unit, 'Unit', { max: 30 }),
    ...costs,
  };
}

async function insertPurchase(client, ingredientId, p) {
  const { rows } = await client.query(
    `INSERT INTO ingredient_purchases
       (ingredient_id, purchase_date, vendor, quantity, weight, unit, unit_cost, total_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, ingredient_id AS "ingredientId", purchase_date AS "date", vendor, quantity, weight, unit,
               unit_cost AS "unitCost", total_cost AS "totalCost", created_at AS "createdAt"`,
    [ingredientId, p.date, p.vendor, p.quantity, p.weight, p.unit, p.unitCost, p.totalCost],
  );
  return rows[0];
}

async function getIngredient(id, client = { query }) {
  const { rows } = await client.query(`SELECT ${INGREDIENT_COLUMNS} FROM ingredients i ${LATEST_PURCHASE} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw notFound('Ingredient');
  return rows[0];
}

const uniqueViolation = (err) => err.code === '23505';

// GET /api/ingredients?q=&category=
router.get('/', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where.push(`i.name ILIKE $${params.length}`);
  }
  if (req.query.category) {
    params.push(String(req.query.category));
    where.push(`i.category = $${params.length}`);
  }
  const { rows } = await query(
    `SELECT ${INGREDIENT_COLUMNS},
            (SELECT count(*)::int FROM ingredient_purchases p WHERE p.ingredient_id = i.id) AS "purchaseCount"
     FROM ingredients i ${LATEST_PURCHASE}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY lower(i.name)`,
    params,
  );
  res.json(rows);
});

router.get('/categories', async (_req, res) => {
  const { rows } = await query(`SELECT DISTINCT category FROM ingredients WHERE category IS NOT NULL ORDER BY category`);
  res.json(rows.map((r) => r.category));
});

// Manual entry: create the master record and, optionally, its first purchase.
router.post('/', async (req, res) => {
  const fields = ingredientFields(req.body ?? {});
  const purchase = req.body?.purchase ? purchaseFields(req.body.purchase) : null;
  try {
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ingredients (name, category, default_yield_percent) VALUES ($1,$2,$3) RETURNING id`,
        [fields.name, fields.category, fields.defaultYieldPercent],
      );
      if (purchase) await insertPurchase(c, rows[0].id, purchase);
      return rows[0].id;
    });
    res.status(201).json(await getIngredient(id));
  } catch (err) {
    if (uniqueViolation(err)) throw new HttpError(409, `“${fields.name}” is already in the database. Add a purchase to it instead.`);
    throw err;
  }
});

// Commit reviewed purchases (from the OCR grid or a manual form). Items are matched
// to an existing ingredient by id or case-insensitive name; unknown names are created.
router.post('/purchase', async (req, res) => {
  const items = array(req.body?.items, 'items');
  if (!items.length) throw badRequest('Add at least one item to save');
  const shared = { date: req.body?.date, vendor: req.body?.vendor };

  const prepared = items.map((item, i) => {
    try {
      return {
        ingredientId: uuid(item.ingredientId, 'Ingredient', { required: false }),
        name: text(item.name, 'Item name'),
        category: text(item.category, 'Category', { max: 80 }),
        purchase: purchaseFields({ ...shared, ...Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && v !== null && v !== '')) }),
      };
    } catch (err) {
      if (err instanceof HttpError) throw badRequest(`Row ${i + 1}: ${err.message}`);
      throw err;
    }
  });
  prepared.forEach((p, i) => {
    if (!p.ingredientId && !p.name) throw badRequest(`Row ${i + 1}: Item name is required`);
  });

  const result = await tx(async (c) => {
    const purchases = [];
    const created = [];
    for (const item of prepared) {
      let id = item.ingredientId;
      if (id) {
        const { rowCount } = await c.query('SELECT 1 FROM ingredients WHERE id = $1', [id]);
        if (!rowCount) throw notFound('Ingredient');
      } else {
        const { rows } = await c.query(
          `INSERT INTO ingredients (name, category) VALUES ($1, $2)
           ON CONFLICT ((lower(name))) DO UPDATE SET name = ingredients.name
           RETURNING id, (xmax = 0) AS inserted`,
          [item.name, item.category],
        );
        id = rows[0].id;
        if (rows[0].inserted) created.push({ id, name: item.name });
      }
      purchases.push(await insertPurchase(c, id, item.purchase));
    }
    return { purchases, createdIngredients: created };
  });
  res.status(201).json(result);
});

// Parse receipt JSON from the external extractor into rows for review. Saves nothing.
router.post('/import-receipt', async (req, res) => {
  const receipt = normalizeReceipt(req.body);

  // Suggest an existing ingredient for each line (exact name first, then trigram similarity).
  for (const item of receipt.items) {
    const { rows } = await query(
      `SELECT id, name, category, similarity(name, $1) AS score
       FROM ingredients
       WHERE lower(name) = lower($1) OR similarity(name, $1) > 0.3
       ORDER BY (lower(name) = lower($1)) DESC, score DESC
       LIMIT 1`,
      [item.name],
    );
    item.match = rows[0] ? { id: rows[0].id, name: rows[0].name, category: rows[0].category, score: Number(rows[0].score) } : null;
  }
  res.json(receipt);
});

router.get('/:id', async (req, res) => {
  res.json(await getIngredient(uuid(req.params.id, 'id')));
});

router.patch('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const fields = ingredientFields(req.body ?? {}, { partial: true });
  const cols = { name: 'name', category: 'category', defaultYieldPercent: 'default_yield_percent' };
  const keys = Object.keys(fields);
  if (keys.length) {
    try {
      const { rowCount } = await query(
        `UPDATE ingredients SET ${keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...keys.map((k) => fields[k])],
      );
      if (!rowCount) throw notFound('Ingredient');
    } catch (err) {
      if (uniqueViolation(err)) throw new HttpError(409, `Another ingredient is already named “${fields.name}”`);
      throw err;
    }
  }
  res.json(await getIngredient(id));
});

router.delete('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  try {
    const { rowCount } = await query('DELETE FROM ingredients WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Ingredient');
  } catch (err) {
    if (err.code === '23503') throw new HttpError(409, 'This ingredient is used in a recipe. Remove it from those recipes first.');
    throw err;
  }
  res.status(204).end();
});

// Add one purchase to an existing ingredient.
router.post('/:id/purchases', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  await getIngredient(id);
  const purchase = await insertPurchase({ query }, id, purchaseFields(req.body ?? {}));
  res.status(201).json(purchase);
});

router.delete('/:id/purchases/:purchaseId', async (req, res) => {
  const { rowCount } = await query('DELETE FROM ingredient_purchases WHERE id = $1 AND ingredient_id = $2', [
    uuid(req.params.purchaseId, 'purchaseId'),
    uuid(req.params.id, 'id'),
  ]);
  if (!rowCount) throw notFound('Purchase');
  res.status(204).end();
});

// Time series of every purchase, with per-vendor price-hike flags.
router.get('/:id/history', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const ingredient = await getIngredient(id);
  const { rows } = await query(
    `SELECT id, purchase_date AS "date", vendor, quantity, weight, unit,
            unit_cost AS "unitCost", total_cost AS "totalCost", created_at AS "createdAt"
     FROM ingredient_purchases WHERE ingredient_id = $1
     ORDER BY purchase_date, created_at`,
    [id],
  );

  // Compare each purchase with the previous one from the same vendor in the same unit.
  const previous = new Map();
  const purchases = rows.map((p) => {
    const key = `${p.vendor ?? ''}|${p.unit ?? ''}`;
    const prev = previous.get(key);
    const change = prev ? percentChange(prev.unitCost, p.unitCost) : null;
    previous.set(key, p);
    return {
      ...p,
      changePercent: change ? change.toFixed(1) : null,
      priceHike: change ? change.gte(PRICE_HIKE_THRESHOLD) : false,
    };
  });

  const vendors = new Map();
  for (const p of purchases) {
    const name = p.vendor ?? 'Unknown vendor';
    const v = vendors.get(name) ?? { vendor: name, purchases: 0 };
    v.purchases += 1;
    v.latestUnitCost = p.unitCost;
    v.latestUnit = p.unit;
    v.latestDate = p.date;
    v.latestChangePercent = p.changePercent;
    v.priceHike = p.priceHike;
    vendors.set(name, v);
  }

  res.json({
    ingredient,
    priceHikeThreshold: PRICE_HIKE_THRESHOLD,
    purchases: purchases.reverse(),
    vendors: [...vendors.values()],
  });
});

export default router;
