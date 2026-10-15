import { Router } from 'express';
import { completePurchaseCosts, percentChange, CalcError } from '@kitchen/shared';
import { query, tx } from '../db.js';
import { LATEST_PURCHASE, INGREDIENT_COLUMNS } from '../sql.js';
import { normalizeReceipt } from '../services/receipt.js';
import { resolveName, matchItems } from '../matching.js';
import { HttpError, badRequest, notFound, text, number, date, uuid, array, today } from '../validate.js';

const router = Router();
const PRICE_HIKE_THRESHOLD = Number(process.env.PRICE_HIKE_THRESHOLD ?? 10);

function ingredientFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'name' in body) out.name = text(body.name, 'Name', { required: true });
  if (!partial || 'category' in body) out.category = text(body.category, 'Category', { max: 80 });
  if (!partial || 'uom' in body) out.uom = text(body.uom, 'Unit of measurement', { max: 20 }) ?? (partial ? undefined : 'each');
  if (partial && out.uom === undefined) delete out.uom;
  return out;
}

const PURCHASE_COLUMNS = `id, ingredient_id AS "ingredientId", purchase_date AS "date", vendor, quantity,
  coalesce(pack_size, 1) AS "packSize", unit_cost AS "unitCost", total_cost AS "totalCost",
  round(unit_cost / coalesce(pack_size, 1), 4) AS "unitPrice", receipt_id AS "receiptId", created_at AS "createdAt"`;

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
    packSize: number(p.packSize, 'Pack size', { min: 0, minExclusive: true }) ?? '1',
    ...costs,
  };
}

async function insertPurchase(client, ingredientId, p, receiptId = null) {
  const { rows } = await client.query(
    `INSERT INTO ingredient_purchases
       (ingredient_id, purchase_date, vendor, quantity, pack_size, unit_cost, total_cost, receipt_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${PURCHASE_COLUMNS}`,
    [ingredientId, p.date, p.vendor, p.quantity, p.packSize, p.unitCost, p.totalCost, receiptId],
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
    where.push(`(i.name ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM ingredient_aliases a WHERE a.ingredient_id = i.id AND a.alias ILIKE $${params.length}))`);
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
        `INSERT INTO ingredients (name, category, uom) VALUES ($1,$2,$3) RETURNING id`,
        [fields.name, fields.category, fields.uom],
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

// Commit reviewed purchases (from the receipt grid or a manual form). Items are matched
// to an existing ingredient by id, saved alias or case-insensitive name; unknown names
// are created. `alias` (the name as the receipt printed it) is remembered for next time
// when it differs from the ingredient's name.
router.post('/purchase', async (req, res) => {
  const items = array(req.body?.items, 'items');
  if (!items.length) throw badRequest('Add at least one item to save');
  const shared = { date: req.body?.date, vendor: req.body?.vendor };
  const receiptId = uuid(req.body?.receiptId, 'Receipt', { required: false });

  const prepared = items.map((item, i) => {
    try {
      return {
        ingredientId: uuid(item.ingredientId, 'Ingredient', { required: false }),
        name: text(item.name, 'Item name'),
        alias: text(item.alias, 'Receipt name'),
        uom: text(item.uom, 'Unit of measurement', { max: 20 }),
        receiptLine: number(item.receiptLine, 'Receipt line', { integer: true, min: 0 }),
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
    if (p.receiptLine !== null && !receiptId) throw badRequest(`Row ${i + 1}: a receipt line needs a receiptId`);
  });

  const result = await tx(async (c) => {
    if (receiptId) {
      const { rowCount } = await c.query('SELECT 1 FROM receipts WHERE id = $1', [receiptId]);
      if (!rowCount) throw notFound('Receipt');
    }
    const purchases = [];
    const created = [];
    const aliases = [];
    const renamed = [];
    for (const item of prepared) {
      let id = item.ingredientId;
      let name;
      let uom = null;
      if (id) {
        const { rows } = await c.query('SELECT name, uom FROM ingredients WHERE id = $1', [id]);
        if (!rows[0]) throw notFound('Ingredient');
        ({ name, uom } = rows[0]);
      } else {
        const known = await resolveName(c, item.name);
        if (known) {
          ({ id, name, uom } = known);
        } else {
          const { rows } = await c.query(
            `INSERT INTO ingredients (name, category, uom) VALUES ($1, $2, $3) RETURNING id`,
            [item.name, item.category, item.uom ?? 'each'],
          );
          uom = item.uom ?? 'each';
          ({ id } = rows[0]);
          name = item.name;
          created.push({ id, name });
        }
      }
      // Pack sizes are in the ingredient's unit; a purchase can't quietly switch it.
      if (item.uom && uom && item.uom.toLowerCase() !== uom.toLowerCase()) {
        throw badRequest(`${name} is measured in ${uom}, not ${item.uom}. Enter the pack size in ${uom}.`);
      }
      if (item.uom && !uom) await c.query('UPDATE ingredients SET uom = $1 WHERE id = $2', [item.uom, id]);
      if (item.ingredientId && item.name && item.name !== name && item.name.toLowerCase() === name.toLowerCase()) {
        // A chosen ingredient sent with its name recased: the reviewer is fixing the spelling.
        // (A bare name never renames; it only resolves.)
        await c.query('UPDATE ingredients SET name = $1 WHERE id = $2', [item.name, id]);
        name = item.name;
        renamed.push({ id, name });
      }
      if (item.alias && item.alias.toLowerCase() !== name.toLowerCase()) {
        // Re-pointing an existing alias is deliberate: the reviewer chose this ingredient.
        await c.query(
          `INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ($1, $2)
           ON CONFLICT ((lower(alias))) DO UPDATE SET ingredient_id = EXCLUDED.ingredient_id`,
          [id, item.alias],
        );
        aliases.push({ alias: item.alias, ingredientId: id, ingredient: name });
      }
      const purchase = await insertPurchase(c, id, item.purchase, receiptId);
      if (item.receiptLine !== null) {
        const { rowCount } = await c.query(
          `UPDATE receipt_lines SET purchase_id = $1 WHERE receipt_id = $2 AND position = $3 AND purchase_id IS NULL`,
          [purchase.id, receiptId, item.receiptLine],
        );
        if (!rowCount) {
          const { rowCount: exists } = await c.query('SELECT 1 FROM receipt_lines WHERE receipt_id = $1 AND position = $2', [receiptId, item.receiptLine]);
          if (!exists) throw notFound('Receipt line');
          throw new HttpError(409, `“${item.alias ?? item.name ?? name}” was already saved from this receipt. Reload to see its current state.`);
        }
        purchase.receiptLine = item.receiptLine;
      }
      purchases.push(purchase);
    }
    return { purchases, createdIngredients: created, aliasesSaved: aliases, renamedIngredients: renamed };
  });
  res.status(201).json(result);
});

// Parse receipt JSON from the external extractor into rows for review. Saves nothing.
router.post('/import-receipt', async (req, res) => {
  const receipt = normalizeReceipt(req.body);

  // `match`: resolved without asking; `suggestion`: offered to the reviewer, never applied.
  await matchItems({ query }, receipt.items);
  res.json(receipt);
});

router.get('/:id', async (req, res) => {
  res.json(await getIngredient(uuid(req.params.id, 'id')));
});

router.patch('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const fields = ingredientFields(req.body ?? {}, { partial: true });
  const cols = { name: 'name', category: 'category', uom: 'uom' };
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

router.delete('/:id/aliases/:aliasId', async (req, res) => {
  const { rowCount } = await query('DELETE FROM ingredient_aliases WHERE id = $1 AND ingredient_id = $2', [
    uuid(req.params.aliasId, 'aliasId'),
    uuid(req.params.id, 'id'),
  ]);
  if (!rowCount) throw notFound('Alias');
  res.status(204).end();
});

// Time series of every purchase, with price-movement flags.
router.get('/:id/history', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const ingredient = await getIngredient(id);
  const { rows } = await query(
    `SELECT ${PURCHASE_COLUMNS}
     FROM ingredient_purchases WHERE ingredient_id = $1
     ORDER BY purchase_date, created_at`,
    [id],
  );

  // Compare each purchase's price per unit of measure with the previous purchase, from
  // whichever store and in whatever pack size.
  let prev = null;
  const purchases = rows.map((p) => {
    const change = prev ? percentChange(prev.unitPrice, p.unitPrice) : null;
    const out = {
      ...p,
      changePercent: change ? change.toFixed(1) : null,
      priceHike: change ? change.gte(PRICE_HIKE_THRESHOLD) : false,
      previous: prev ? { vendor: prev.vendor, unitPrice: prev.unitPrice, packSize: prev.packSize, date: prev.date } : null,
    };
    prev = p;
    return out;
  });

  const vendors = new Map();
  for (const p of purchases) {
    const name = p.vendor ?? 'Unknown vendor';
    const v = vendors.get(name) ?? { vendor: name, purchases: 0 };
    v.purchases += 1;
    v.latestUnitPrice = p.unitPrice;
    v.latestPackSize = p.packSize;
    v.latestPackPrice = p.unitCost;
    v.latestDate = p.date;
    vendors.set(name, v);
  }

  const { rows: aliases } = await query(
    `SELECT id, alias, created_at AS "createdAt" FROM ingredient_aliases WHERE ingredient_id = $1 ORDER BY lower(alias)`,
    [id],
  );

  res.json({
    ingredient,
    aliases,
    priceHikeThreshold: PRICE_HIKE_THRESHOLD,
    purchases: purchases.reverse(),
    vendors: [...vendors.values()],
  });
});

export default router;
