import { Router } from 'express';
import { combinePurchases, completePurchaseCosts, findDuplicates, percentChange, CalcError } from '@kitchen/shared';
import { query, tx, fkViolation } from '../db.js';
import { LATEST_PURCHASE, INGREDIENT_COLUMNS } from '../sql.js';
import { normalizeReceipt } from '../services/receipt.js';
import { ambiguousName, resolveName, matchItems } from '../matching.js';
import { mergeIngredients } from '../merge.js';
import { HttpError, badRequest, notFound, text, number, date, uuid, array, today } from '../validate.js';

const router = Router();
const PRICE_HIKE_THRESHOLD = Number(process.env.PRICE_HIKE_THRESHOLD ?? 10);

function ingredientFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'name' in body) out.name = text(body.name, 'Name', { required: true });
  if (!partial || 'category' in body) out.category = text(body.category, 'Category', { max: 80 });
  if (!partial || 'uom' in body) out.uom = text(body.uom, 'Unit of measurement', { max: 20 }) ?? (partial ? undefined : 'each');
  if (partial && out.uom === undefined) delete out.uom;
  // What one unit weighs, in grams (blank clears it); only sent from the ingredient's details.
  if ('unitGrams' in body) out.unitGrams = number(body.unitGrams, 'Weight of one unit', { min: 0, minExclusive: true });
  return out;
}

const PURCHASE_COLUMNS = `id, ingredient_id AS "ingredientId", purchase_date AS "date", vendor, quantity,
  pack_size AS "packSize", unit_cost AS "unitCost", total_cost AS "totalCost",
  round(unit_cost / pack_size, 4) AS "unitPrice", receipt_id AS "receiptId", created_at AS "createdAt", is_test AS "isTest"`;

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
            (SELECT count(*)::int FROM ingredient_purchases p WHERE p.ingredient_id = i.id) AS "purchaseCount",
            -- Recipes using it directly or through a Spice Lab blend or sauce, each once.
            (SELECT count(DISTINCT ri.recipe_id)::int FROM recipe_ingredients ri
              WHERE ri.ingredient_id = i.id
                 OR ri.blend_id IN (SELECT si.blend_id FROM spice_blend_items si WHERE si.ingredient_id = i.id)) AS "recipeCount"
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

// Every vendor name in use, for suggestions when correcting a purchase's vendor.
router.get('/vendors', async (_req, res) => {
  const { rows } = await query(
    `SELECT vendor FROM ingredient_purchases WHERE vendor IS NOT NULL
     UNION SELECT vendor FROM receipts WHERE vendor IS NOT NULL
     ORDER BY vendor`,
  );
  res.json(rows.map((r) => r.vendor));
});

// Ingredients that are probably one thing under two names (findDuplicates in shared/src/names.js).
router.get('/duplicates', async (_req, res) => {
  const [{ rows: ingredients }, { rows: aliases }, { rows: dismissed }] = await Promise.all([
    query(`SELECT ${INGREDIENT_COLUMNS},
             (SELECT count(*)::int FROM ingredient_purchases p WHERE p.ingredient_id = i.id) AS "purchaseCount",
             (SELECT count(DISTINCT ri.recipe_id)::int FROM recipe_ingredients ri WHERE ri.ingredient_id = i.id) AS "recipeCount"
           FROM ingredients i ${LATEST_PURCHASE}`),
    query('SELECT ingredient_id AS "ingredientId", alias FROM ingredient_aliases'),
    query('SELECT ingredient_a AS a, ingredient_b AS b FROM ingredient_pair_dismissals'),
  ]);
  res.json(findDuplicates(ingredients, { aliases, dismissed: dismissed.map((d) => [d.a, d.b]) }));
});

// "Not the same": stop suggesting this pair.
router.post('/duplicates/dismiss', async (req, res) => {
  const ids = array(req.body?.ids, 'ids').map((v, i) => uuid(v, `Ingredient ${i + 1}`));
  if (ids.length !== 2 || ids[0] === ids[1]) throw badRequest('Give the two ingredients that aren’t the same');
  try {
    await query(
      `INSERT INTO ingredient_pair_dismissals (ingredient_a, ingredient_b)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)) ON CONFLICT DO NOTHING`,
      ids,
    );
  } catch (err) {
    if (fkViolation(err)) throw notFound('Ingredient');
    throw err;
  }
  res.status(204).end();
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
        // The reviewer saw this receipt name as ambiguous (not matched through its alias).
        skipAlias: item.skipAlias === true,
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
        const known = await resolveName(c, item.name, { aliases: !item.skipAlias });
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
        await keepOldName(c, id, name, item.name);
        name = item.name;
        renamed.push({ id, name });
      }
      if (item.alias && item.alias !== name) {
        // Re-pointing an existing alias is deliberate: the reviewer chose this ingredient.
        await c.query(
          `INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ($1, $2)
           ON CONFLICT ((lower(alias))) DO UPDATE SET ingredient_id = EXCLUDED.ingredient_id`,
          [id, item.alias],
        );
        aliases.push({ alias: item.alias, ingredientId: id, ingredient: name });
      }
      const purchase = await insertPurchase(c, id, item.purchase, receiptId);
      let wording = item.alias ?? item.name;
      if (item.receiptLine !== null) {
        const { rows: line, rowCount } = await c.query(
          `UPDATE receipt_lines SET purchase_id = $1 WHERE receipt_id = $2 AND position = $3 AND purchase_id IS NULL RETURNING name`,
          [purchase.id, receiptId, item.receiptLine],
        );
        if (rowCount) wording = line[0].name; // what the receipt printed, even when a saved alias matched it
        if (!rowCount) {
          const { rowCount: exists } = await c.query('SELECT 1 FROM receipt_lines WHERE receipt_id = $1 AND position = $2', [receiptId, item.receiptLine]);
          if (!exists) throw notFound('Receipt line');
          throw new HttpError(409, `“${item.alias ?? item.name ?? name}” was already saved from this receipt. Reload to see its current state.`);
        }
        purchase.receiptLine = item.receiptLine;
      }
      // For the "saved" summary: what it was saved as, and the receipt's wording when that differs.
      purchase.ingredientName = name;
      purchase.uom = uom ?? item.uom ?? null;
      purchase.receiptName = wording && wording.toLowerCase() !== name.toLowerCase() ? wording : null;
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

/**
 * A rename keeps the old name as a receipt name, even when only its capitals changed (a receipt
 * may still print "GINGER PASTE"), as a merge does. Receipt names match whatever the case, so one
 * already saved in other capitals is kept as it was; an alias that is now exactly the name goes.
 */
async function keepOldName(c, id, oldName, newName) {
  if (oldName === newName) return;
  await c.query('DELETE FROM ingredient_aliases WHERE ingredient_id = $1 AND alias = $2', [id, newName]);
  await c.query(
    `INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ($1, $2)
     ON CONFLICT ((lower(alias))) DO UPDATE SET ingredient_id = EXCLUDED.ingredient_id`,
    [id, oldName],
  );
}

router.patch('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const fields = ingredientFields(req.body ?? {}, { partial: true });
  const cols = { name: 'name', category: 'category', uom: 'uom', unitGrams: 'unit_grams' };
  const keys = Object.keys(fields);
  if (keys.length) {
    try {
      await tx(async (c) => {
        const { rows: [old] } = await c.query('SELECT name FROM ingredients WHERE id = $1 FOR UPDATE', [id]);
        if (!old) throw notFound('Ingredient');
        await c.query(
          `UPDATE ingredients SET ${keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...keys.map((k) => fields[k])],
        );
        if (fields.name) await keepOldName(c, id, old.name, fields.name);
      });
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
    if (fkViolation(err)) throw new HttpError(409, 'This ingredient is used in a recipe or spice blend. Remove it from those first.');
    throw err;
  }
  res.status(204).end();
});

// Merge this ingredient into `intoId` (server/src/merge.js). `factor` converts its unit into the
// kept one's when they can't be converted exactly (1 box = 1.625 lb); `dryRun` previews it.
router.post('/:id/merge', async (req, res) => {
  const factor = number(req.body?.factor, 'Conversion', { min: 0, minExclusive: true });
  res.json(await mergeIngredients({
    sourceId: uuid(req.params.id, 'id'),
    intoId: uuid(req.body?.intoId, 'Ingredient to merge into'),
    factor,
    dryRun: req.body?.dryRun === true,
  }));
});

// Add one purchase to an existing ingredient.
router.post('/:id/purchases', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  await getIngredient(id);
  const purchase = await insertPurchase({ query }, id, purchaseFields(req.body ?? {}));
  res.status(201).json(purchase);
});

// Correct a purchase's pack size (a mis-entered "case 36 lb"). The one field that can change:
// the price paid stays as recorded, so the price history remains append-only.
// Correct a mis-entered pack size or a missing or wrong vendor. The price paid isn't changed.
router.patch('/:id/purchases/:purchaseId', async (req, res) => {
  const body = req.body ?? {};
  const sets = [];
  const values = [uuid(req.params.purchaseId, 'purchaseId'), uuid(req.params.id, 'id')];
  if ('packSize' in body) {
    values.push(number(body.packSize, 'Pack size', { required: true, min: 0, minExclusive: true }));
    sets.push(`pack_size = $${values.length}`);
  }
  if ('vendor' in body) {
    values.push(text(body.vendor, 'Vendor', { max: 120 })); // blank clears it
    sets.push(`vendor = $${values.length}`);
  }
  if (!sets.length) throw badRequest('Nothing to change: send packSize or vendor');
  const { rows } = await query(
    `UPDATE ingredient_purchases SET ${sets.join(', ')} WHERE id = $1 AND ingredient_id = $2 RETURNING ${PURCHASE_COLUMNS}`,
    values,
  );
  if (!rows[0]) throw notFound('Purchase');
  res.json(rows[0]);
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

// Time series of every purchase and of every trip (a receipt's lines averaged), with
// price-movement flags between trips.
router.get('/:id/history', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const ingredient = await getIngredient(id);
  const { rows } = await query(
    `SELECT ${PURCHASE_COLUMNS}
     FROM ingredient_purchases WHERE ingredient_id = $1
     ORDER BY purchase_date, created_at`,
    [id],
  );

  // A trip is one receipt's lines of this ingredient (two packs of chicken at different
  // weights), averaged into one price; a purchase without a receipt is a trip of its own.
  const groups = new Map();
  for (const p of rows) {
    const key = p.receiptId ?? p.id;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  // Compare each trip's price per unit of measure with the previous trip, from whichever
  // store and in whatever pack size.
  let prev = null;
  const trips = [...groups].map(([tripId, lines]) => {
    const last = lines.at(-1);
    const price = lines.length > 1
      ? combinePurchases(lines)
      : { quantity: last.quantity, packSize: last.packSize, unitCost: last.unitCost, totalCost: last.totalCost, unitPrice: last.unitPrice };
    const change = prev ? percentChange(prev.unitPrice, price.unitPrice) : null;
    const trip = {
      id: tripId,
      receiptId: last.receiptId,
      date: last.date,
      vendor: last.vendor,
      lines: lines.length,
      purchaseIds: lines.map((l) => l.id),
      ...price,
      changePercent: change ? change.toFixed(1) : null,
      priceHike: change ? change.gte(PRICE_HIKE_THRESHOLD) : false,
      previous: prev ? { vendor: prev.vendor, unitPrice: prev.unitPrice, packSize: prev.packSize, date: prev.date } : null,
    };
    prev = trip;
    return trip;
  });

  // Each purchase names its trip; only a trip of one line carries its price change.
  const tripOf = new Map(trips.flatMap((t) => t.purchaseIds.map((pid) => [pid, t])));
  const purchases = rows.map((p) => {
    const t = tripOf.get(p.id);
    const alone = t.lines === 1;
    return {
      ...p,
      tripId: t.id,
      tripLines: t.lines,
      changePercent: alone ? t.changePercent : null,
      priceHike: alone && t.priceHike,
      previous: alone ? t.previous : null,
    };
  });

  const vendors = new Map();
  for (const t of trips) {
    const name = t.vendor ?? 'Unknown vendor';
    const v = vendors.get(name) ?? { vendor: name, purchases: 0 };
    v.purchases += 1;
    v.latestUnitPrice = t.unitPrice;
    v.latestPackSize = t.packSize;
    v.latestPackPrice = t.unitCost;
    v.latestDate = t.date;
    vendors.set(name, v);
  }

  const { rows: aliases } = await query(
    `SELECT a.id, a.alias, a.created_at AS "createdAt", ${ambiguousName('a.alias')} AS ambiguous
       FROM ingredient_aliases a WHERE a.ingredient_id = $1 ORDER BY lower(a.alias)`,
    [id],
  );

  // Where it's used: recipes listing it directly (amount in its UOM), and Spice Lab blends and
  // sauces holding it, each with the recipes that use that blend.
  const { rows: recipes } = await query(
    `SELECT r.id, r.name, sum(ri.amount)::text AS amount, r.is_test AS "isTest"
       FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id
      WHERE ri.ingredient_id = $1 GROUP BY r.id ORDER BY lower(r.name)`,
    [id],
  );
  const { rows: blends } = await query(
    `SELECT b.id, b.name, b.kind,
            coalesce((SELECT json_agg(json_build_object('id', r.id, 'name', r.name) ORDER BY lower(r.name))
                        FROM recipes r WHERE r.id IN (SELECT recipe_id FROM recipe_ingredients WHERE blend_id = b.id)), '[]') AS recipes
       FROM spice_blends b
      WHERE b.id IN (SELECT blend_id FROM spice_blend_items WHERE ingredient_id = $1)
      ORDER BY lower(b.name)`,
    [id],
  );

  res.json({
    ingredient,
    aliases,
    usedIn: { recipes, blends },
    priceHikeThreshold: PRICE_HIKE_THRESHOLD,
    purchases: purchases.reverse(),
    trips: trips.reverse(),
    vendors: [...vendors.values()],
  });
});

export default router;
