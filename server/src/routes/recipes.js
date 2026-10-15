import { Router } from 'express';
import { calculateRecipe } from '@kitchen/shared';
import { query, tx, fkViolation } from '../db.js';
import { LATEST_PURCHASE, RECIPE_COLUMNS, RECIPE_LINES } from '../sql.js';
import { blendAsLine, loadBlends } from '../blends.js';
import { badRequest, notFound, text, number, uuid, array } from '../validate.js';
import { uploadImages, attachImages, listImages, copyImages, ownedFilenames, removeFiles, reorderImages } from '../images.js';

const router = Router();

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

function withCosting(recipe, expectedServings) {
  const costing = calculateRecipe({
    lines: recipe.lines,
    baseServings: recipe.baseServings,
    expectedServings: expectedServings ?? recipe.baseServings,
    targetMargin: recipe.targetMargin,
    totalYield: recipe.totalYield,
  });
  const syncTimes = recipe.lines.map((l) => l.priceSyncedAt).filter(Boolean);
  return {
    ...recipe,
    lastPriceSync: syncTimes.length ? new Date(Math.max(...syncTimes.map((t) => new Date(t)))).toISOString() : null,
    costing,
  };
}

function recipeFields(body) {
  const lines = array(body.lines, 'lines').map((l, i) => {
    const row = `Line ${i + 1}`;
    const blendId = uuid(l.blendId, `${row}: spice blend`, { required: false });
    return {
      ingredientId: blendId ? null : uuid(l.ingredientId, `${row}: ingredient`),
      blendId,
      amount: number(l.amount, `${row}: amount used`, { required: true, min: 0 }),
    };
  });
  return {
    name: text(body.name, 'Recipe name', { required: true }),
    baseServings: number(body.baseServings, 'Base servings', { required: true, integer: true, min: 1 }),
    totalYield: number(body.totalYield, 'Total yield', { min: 0 }),
    yieldUnit: text(body.yieldUnit, 'Yield unit', { max: 30 }),
    targetMargin: number(body.targetMargin, 'Target margin', { min: 0, max: 100, maxExclusive: true }) ?? '70',
    lines,
  };
}

async function writeLines(c, recipeId, lines) {
  await c.query('DELETE FROM recipe_ingredients WHERE recipe_id = $1', [recipeId]);
  for (const [position, l] of lines.entries()) {
    await c.query(
      `INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, blend_id, amount) VALUES ($1,$2,$3,$4,$5)`,
      [recipeId, position, l.ingredientId, l.blendId, l.amount],
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
          baseCost: costing.baseCost,
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
    amount: number(l.amount, `Line ${i + 1}: amount used`, { min: 0 }) ?? '0',
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
        `INSERT INTO recipes (name, base_servings, total_yield, yield_unit, target_margin)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [f.name, f.baseServings, f.totalYield, f.yieldUnit, f.targetMargin],
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
        `UPDATE recipes SET name=$2, base_servings=$3, total_yield=$4, yield_unit=$5, target_margin=$6, updated_at=now()
         WHERE id=$1`,
        [id, f.name, f.baseServings, f.totalYield, f.yieldUnit, f.targetMargin],
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
      `INSERT INTO recipes (name, base_servings, total_yield, yield_unit, target_margin)
       SELECT name || ' (copy)', base_servings, total_yield, yield_unit, target_margin FROM recipes WHERE id = $1
       RETURNING id`,
      [id],
    );
    if (!rows[0]) throw notFound('Recipe');
    await c.query(
      `INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, blend_id, amount)
       SELECT $2, position, ingredient_id, blend_id, amount FROM recipe_ingredients WHERE recipe_id = $1`,
      [id, rows[0].id],
    );
    await copyImages(c, 'recipe', id, rows[0].id);
    return rows[0].id;
  });
  res.status(201).json(await getOne(newId));
});

router.delete('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const files = await tx(async (c) => {
    const names = await ownedFilenames(c, 'recipe', id);
    const { rowCount } = await c.query('DELETE FROM recipes WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Recipe');
    return names;
  });
  await removeFiles(files);
  res.status(204).end();
});

// Photos: multipart `images` (up to 20 per request), appended after existing ones.
router.post('/:id/images', uploadImages, async (req, res) => {
  const id = uuid(req.params.id, 'id');
  if (!req.files?.length) throw badRequest('Attach at least one image in the "images" field');
  const added = await tx(async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM recipes WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Recipe');
    return attachImages(c, 'recipe', id, req.files);
  });
  res.status(201).json(added);
});

// The first image is the recipe's cover.
router.put('/:id/images/order', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const ids = array(req.body?.imageIds, 'imageIds').map((v, i) => uuid(v, `Image ${i + 1}`));
  await tx((c) => reorderImages(c, 'recipe', id, ids));
  res.json((await listImages({ query }, 'recipe', [id])).get(id));
});

export default router;
