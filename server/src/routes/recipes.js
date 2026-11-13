import { Router } from 'express';
import { DEFAULT_MARGIN, Decimal, calculateRecipe, canonicalUom, lineAmountInUom, parseAmount } from '@kitchen/shared';
import { query, tx, fkViolation } from '../db.js';
import { LATEST_PURCHASE, RECIPE_COLUMNS, RECIPE_LINES } from '../sql.js';
import { blendAsLine, loadBlends } from '../blends.js';
import { badRequest, notFound, text, number, uuid, array } from '../validate.js';
import { listImages, copyImages, imageRoutes, deleteImageOwner } from '../images.js';

const router = Router();

/** An amount used, typed as a decimal or a fraction ("1/2", "1 1/2", "½"). */
const amountUsed = (value, field, opts) => number(parseAmount(value)?.toString() ?? value, field, opts);

/** Load recipes by id with their lines (each carrying the ingredient's latest price). */
export async function loadRecipes(ids, client = { query }) {
  if (!ids.length) return [];
  const [{ rows: recipes }, { rows: lines }] = await Promise.all([
    client.query(`SELECT ${RECIPE_COLUMNS} FROM recipes r WHERE r.id = ANY($1::uuid[])`, [ids]),
    client.query(RECIPE_LINES, [ids]),
  ]);
  const blendIds = [...new Set(lines.filter((l) => l.blendId).map((l) => l.blendId))];
  if (blendIds.length) {
    const blends = new Map((await loadBlends(blendIds, client)).map((b) => [b.id, b]));
    for (const l of lines) if (l.blendId) Object.assign(l, blendAsLine(blends.get(l.blendId)));
  }
  const byRecipe = Map.groupBy(lines, (l) => l.recipeId);
  const images = await listImages(client, 'recipe', ids);
  return recipes.map((r) => ({ ...r, lines: byRecipe.get(r.id) ?? [], images: images.get(r.id) ?? [] }));
}

export function withCosting(recipe, expectedServings) {
  const costing = calculateRecipe({
    lines: recipe.lines,
    baseServings: recipe.baseServings,
    expectedServings: expectedServings ?? recipe.baseServings,
    targetMargin: recipe.targetMargin,
    targetPrice: recipe.targetPrice,
    totalYield: recipe.totalYield,
  });
  const syncTimes = recipe.lines.map((l) => l.priceSyncedAt).filter(Boolean);
  return {
    ...recipe,
    lastPriceSync: syncTimes.length ? new Date(Math.max(...syncTimes.map((t) => new Date(t)))).toISOString() : null,
    costing,
  };
}

/** Keep a deal entered for a recipe, to fill in on its next event. Test mode too: it only ever fills in a box. */
export const rememberDeal = (c, recipeId, qty, price) => c.query(
  'UPDATE recipes SET deal_qty = $2, deal_price = $3 WHERE id = $1',
  [recipeId, qty, price],
);

function recipeFields(body) {
  const lines = array(body.lines, 'lines').map((l, i) => {
    const row = `Line ${i + 1}`;
    const blendId = uuid(l.blendId, `${row}: spice blend`, { required: false });
    return {
      ingredientId: blendId ? null : uuid(l.ingredientId, `${row}: ingredient`),
      blendId,
      amount: amountUsed(l.amount, `${row}: amount used`, { required: true, min: 0 }),
      // Measured in another kitchen unit than the ingredient's own (cups of rice bought by the lb); checked in writeLines.
      unit: blendId ? null : canonicalUom(text(l.unit, `${row}: unit`, { max: 20 })),
    };
  });
  return {
    name: text(body.name, 'Recipe name', { required: true }),
    baseServings: number(body.baseServings, 'Base servings', { required: true, integer: true, min: 1 }),
    totalYield: number(body.totalYield, 'Total yield', { min: 0 }),
    yieldUnit: text(body.yieldUnit, 'Yield unit', { max: 30 }),
    targetMargin: number(body.targetMargin, 'Target margin', { min: 0, max: 100, maxExclusive: true }) ?? String(DEFAULT_MARGIN),
    // Set by hand: kept when ingredient costs change. Blank lets the price follow the margin.
    targetPrice: number(body.targetPrice, 'Menu price', { min: 0, minExclusive: true }),
    lines,
  };
}

/** A line's unit as stored: null for the ingredient's own, and a 400 for one that can't be converted to it. */
async function lineUnits(c, lines) {
  const ids = [...new Set(lines.filter((l) => l.unit).map((l) => l.ingredientId))];
  if (!ids.length) return lines.map(() => null);
  const { rows } = await c.query('SELECT id, name, uom, cup_grams AS "cupGrams" FROM ingredients WHERE id = ANY($1::uuid[])', [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return lines.map((l) => {
    const ing = byId.get(l.ingredientId);
    if (!l.unit || !ing || l.unit === ing.uom) return null; // an unknown ingredient fails on insert
    if (lineAmountInUom(1, l.unit, ing) === null) {
      throw badRequest(`${ing.name} is bought by the ${ing.uom}, and a ${l.unit} of it can’t be converted: set what a cup of it weighs in its details`);
    }
    return l.unit;
  });
}

async function writeLines(c, recipeId, lines) {
  const units = await lineUnits(c, lines);
  await c.query('DELETE FROM recipe_ingredients WHERE recipe_id = $1', [recipeId]);
  for (const [position, l] of lines.entries()) {
    await c.query(
      `INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, blend_id, amount, unit) VALUES ($1,$2,$3,$4,$5,$6)`,
      [recipeId, position, l.ingredientId, l.blendId, l.amount, units[position]],
    );
  }
}

async function getOne(id) {
  const [recipe] = await loadRecipes([id]);
  if (!recipe) throw notFound('Recipe');
  return withCosting(recipe);
}


// Gallery: every recipe with cost per serving at base servings.
router.get('/', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where = 'WHERE name ILIKE $1';
  }
  const { rows } = await query(`SELECT id FROM recipes ${where} ORDER BY lower(name)`, params);
  const recipes = await loadRecipes(rows.map((r) => r.id));
  const order = new Map(rows.map((r, i) => [r.id, i]));
  res.json(
    recipes
      .sort((a, b) => order.get(a.id) - order.get(b.id))
      .map((r) => {
        const { lines, costing, images, ...rest } = withCosting(r);
        return {
          ...rest,
          coverImage: images[0] ?? null,
          imageCount: images.length,
          ingredientCount: lines.length,
          missingPrices: lines.filter((l) => l.packPrice === null).length,
          costPerServing: costing.costPerServing,
          recommendedPrice: costing.recommendedPrice,
          targetMargin: costing.targetMargin, // the margin a set price makes
          priceSet: costing.priceSet,
          profitPerServing: costing.profitPerServing,
          baseCost: costing.baseCost,
          batchProfit: costing.profit, // the batch as written, sold at the recommended price
        };
      }),
  );
});

// Stateless costing: nothing is read from or written to recipes.
router.post('/calculate', async (req, res) => {
  const body = req.body ?? {};
  const lines = array(body.lines, 'lines').map((l, i) => ({
    ingredientId: uuid(l.ingredientId, `Line ${i + 1}: ingredient`, { required: false }),
    name: l.name,
    packPrice: number(l.packPrice, `Line ${i + 1}: pack price`, { min: 0 }),
    packSize: number(l.packSize, `Line ${i + 1}: pack size`, { min: 0, minExclusive: true }),
    amount: amountUsed(l.amount, `Line ${i + 1}: amount used`, { min: 0 }) ?? '0',
  }));

  // Lines given by ingredient id (without an explicit pack price) use the most recent purchase.
  const ids = lines.filter((l) => l.ingredientId && l.packPrice === null).map((l) => l.ingredientId);
  if (ids.length) {
    const { rows } = await query(
      `SELECT i.id, i.name, i.uom, lp.unit_cost, lp.pack_size FROM ingredients i ${LATEST_PURCHASE} WHERE i.id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const l of lines) {
      const r = byId.get(l.ingredientId);
      if (l.ingredientId && l.packPrice === null) {
        if (!r) throw notFound('Ingredient');
        Object.assign(l, { packPrice: r.unit_cost, packSize: r.pack_size, uom: r.uom, name: l.name ?? r.name });
      }
    }
  }

  res.json(
    calculateRecipe({
      lines,
      baseServings: number(body.baseServings, 'Base servings', { required: true, min: 0, minExclusive: true }),
      expectedServings: number(body.expectedServings, 'Expected servings', { min: 0 }),
      targetMargin: number(body.targetMargin, 'Target margin', { min: 0, max: 100, maxExclusive: true }) ?? undefined,
      targetPrice: number(body.targetPrice, 'Menu price', { min: 0, minExclusive: true }),
      totalYield: body.totalYield,
    }),
  );
});

router.get('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const expected = number(req.query.servings, 'servings', { min: 0 });
  const [recipe] = await loadRecipes([id]);
  if (!recipe) throw notFound('Recipe');
  res.json(withCosting(recipe, expected));
});

router.post('/', async (req, res) => {
  const f = recipeFields(req.body ?? {});
  try {
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO recipes (name, base_servings, total_yield, yield_unit, target_margin, target_price)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [f.name, f.baseServings, f.totalYield, f.yieldUnit, f.targetMargin, f.targetPrice],
      );
      await writeLines(c, rows[0].id, f.lines);
      return rows[0].id;
    });
    res.status(201).json(await getOne(id));
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the ingredients or spice blends no longer exists');
    throw err;
  }
});

router.put('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const f = recipeFields(req.body ?? {});
  try {
    await tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE recipes SET name=$2, base_servings=$3, total_yield=$4, yield_unit=$5, target_margin=$6, target_price=$7, updated_at=now()
         WHERE id=$1`,
        [id, f.name, f.baseServings, f.totalYield, f.yieldUnit, f.targetMargin, f.targetPrice],
      );
      if (!rowCount) throw notFound('Recipe');
      await writeLines(c, id, f.lines);
    });
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the ingredients or spice blends no longer exists');
    throw err;
  }
  res.json(await getOne(id));
});

router.post('/:id/duplicate', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const newId = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO recipes (name, base_servings, total_yield, yield_unit, target_margin, target_price, deal_qty, deal_price)
       SELECT name || ' (copy)', base_servings, total_yield, yield_unit, target_margin, target_price, deal_qty, deal_price FROM recipes WHERE id = $1
       RETURNING id`,
      [id],
    );
    if (!rows[0]) throw notFound('Recipe');
    await c.query(
      `INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, blend_id, amount, unit)
       SELECT $2, position, ingredient_id, blend_id, amount, unit FROM recipe_ingredients WHERE recipe_id = $1`,
      [id, rows[0].id],
    );
    await copyImages(c, 'recipe', id, rows[0].id);
    return rows[0].id;
  });
  res.status(201).json(await getOne(newId));
});

router.delete('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  await deleteImageOwner('recipe', id);
  res.status(204).end();
});

// Set the menu price by hand from elsewhere, as typing it in the recipe does: the margin it makes is saved with it.
router.put('/:id/price', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const price = number(req.body?.targetPrice, 'Menu price', { required: true, min: 0, minExclusive: true });
  const [recipe] = await loadRecipes([id]);
  if (!recipe) throw notFound('Recipe');
  const { costPerServing } = withCosting(recipe).costing;
  if (Number(costPerServing) === 0) throw badRequest('Add priced ingredients first');
  if (new Decimal(price).lt(costPerServing)) throw badRequest(`Can’t be below the cost per serving ($${new Decimal(costPerServing).toFixed(2)})`);
  const margin = calculateRecipe({ ...recipe, targetPrice: price }).targetMargin;
  await query('UPDATE recipes SET target_price = $2, target_margin = $3, updated_at = now() WHERE id = $1', [id, price, margin]);
  res.status(204).end();
});

// A deal taken off an event before its autosave ran would otherwise never reach the recipe.
router.put('/:id/deal', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const qty = number(req.body?.dealQty, 'Deal servings', { required: true, integer: true, min: 2 });
  const price = number(req.body?.dealPrice, 'Deal price', { required: true, min: 0, minExclusive: true });
  await rememberDeal({ query }, id, qty, price);
  res.status(204).end();
});

imageRoutes(router, 'recipe');

export default router;
