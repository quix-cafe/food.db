// Merging an ingredient into another that is the same thing under a different name. Everything
// that points at the one merged away moves to the one kept, converted into the kept one's unit
// of measure, and its name is remembered as a receipt name. A dry run does the same work in a
// transaction that is rolled back, to preview what would change.

import { Decimal, calculateRecipe, isLabor, normalizeUnit, unitRatio } from '@kitchen/shared';
import { tx } from './db.js';
import { INGREDIENT_COLUMNS, LATEST_PURCHASE } from './sql.js';
import { loadRecipes } from './routes/recipes.js';
import { badRequest, notFound } from './validate.js';

class DryRun extends Error {}

/** Merge `sourceId` into `intoId`; `factor` is how many of the kept unit one source unit is. */
export async function mergeIngredients({ sourceId, intoId, factor = null, dryRun = false }) {
  if (sourceId === intoId) throw badRequest('Choose a different ingredient to merge into');
  let result;
  await tx(async (c) => {
    result = await mergeIn(c, sourceId, intoId, factor);
    if (dryRun) throw new DryRun();
  }).catch((err) => { if (!(err instanceof DryRun)) throw err; });
  return { ...result, dryRun };
}

async function mergeIn(c, sourceId, intoId, factorInput) {
  const load = async (id) => (await c.query(`SELECT ${INGREDIENT_COLUMNS} FROM ingredients i ${LATEST_PURCHASE} WHERE i.id = $1`, [id])).rows[0];
  const [source, into] = [await load(sourceId), await load(intoId)];
  if (!source || !into) throw notFound('Ingredient');
  if (isLabor(source) || isLabor(into)) throw badRequest('Labor is a rate, not an ingredient, so it can’t be merged');
  const factor = factorInput ? new Decimal(factorInput) : unitRatio(source.uom, into.uom);
  if (!factor) throw badRequest(`How many ${into.uom} is 1 ${source.uom} of ${source.name}? Enter it to convert purchases and recipe amounts.`);
  const f = factor.toString();

  // Recipes whose cost can change: those using either ingredient, directly or in a spice blend.
  const { rows: affected } = await c.query(
    `SELECT DISTINCT ri.recipe_id AS id FROM recipe_ingredients ri
     WHERE ri.ingredient_id = ANY($1::uuid[])
        OR ri.blend_id IN (SELECT blend_id FROM spice_blend_items WHERE ingredient_id = ANY($1::uuid[]))`,
    [[source.id, into.id]],
  );
  const recipeIds = affected.map((r) => r.id);
  const before = await costs(c, recipeIds);

  // Purchases: pack sizes into the kept unit; the price paid stays, so price per unit converts.
  const { rowCount: purchasesMoved } = await c.query(
    'UPDATE ingredient_purchases SET ingredient_id = $2, pack_size = round(pack_size * $3, 4) WHERE ingredient_id = $1',
    [source.id, into.id, f],
  ).catch(tooSmall('A purchase’s pack size'));

  // Recipe lines: amounts into the kept unit. A recipe that lists both ends with one line.
  const { rows: lines } = await c.query(
    `SELECT ri.recipe_id, ri.position, ri.ingredient_id, ri.amount, r.name
     FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id
     WHERE ri.ingredient_id = ANY($1::uuid[]) ORDER BY ri.recipe_id, ri.position`,
    [[source.id, into.id]],
  );
  const lineChanges = new Map();
  for (const [recipeId, rows] of Map.groupBy(lines, (l) => l.recipe_id)) {
    const moved = rows.filter((l) => l.ingredient_id === source.id);
    if (!moved.length) continue;
    const converted = moved.map((l) => new Decimal(l.amount).times(factor).toDecimalPlaces(4));
    lineChanges.set(recipeId, {
      lines: moved.map((l, i) => ({ from: l.amount, to: converted[i].toFixed(4) })),
      combined: rows.length > 1,
    });
    const total = rows.reduce((sum, l) => sum.plus(l.ingredient_id === source.id ? converted[moved.indexOf(l)] : l.amount), new Decimal(0));
    const [first, ...rest] = rows;
    await c.query('UPDATE recipe_ingredients SET ingredient_id = $3, amount = $4 WHERE recipe_id = $1 AND position = $2',
      [recipeId, first.position, into.id, total.toFixed(4)]);
    for (const l of rest) await c.query('DELETE FROM recipe_ingredients WHERE recipe_id = $1 AND position = $2', [recipeId, l.position]);
  }

  // Amounts set by hand on an event's shopping list, added together if both had one.
  const { rows: events } = await c.query(
    `WITH moved AS (DELETE FROM event_amounts WHERE ingredient_id = $1 RETURNING event_id, amount)
     INSERT INTO event_amounts (event_id, ingredient_id, amount)
       SELECT event_id, $2, round(amount * $3, 4) FROM moved
     ON CONFLICT (event_id, ingredient_id) DO UPDATE SET amount = event_amounts.amount + EXCLUDED.amount
     RETURNING (SELECT name FROM events e WHERE e.id = event_id) AS name`,
    [source.id, into.id, f],
  );

  // Spice blends measure in kitchen units, so their amounts don't change.
  const { rows: blends } = await c.query(
    `UPDATE spice_blend_items si SET ingredient_id = $2 WHERE ingredient_id = $1
     RETURNING (SELECT name FROM spice_blends b WHERE b.id = si.blend_id) AS name`,
    [source.id, into.id],
  );
  const blendNames = [...new Set(blends.map((b) => b.name))];
  const warnings = [];
  if (blendNames.length && !normalizeUnit(into.uom)) {
    warnings.push(`Spice Lab can’t cost ${into.name} in ${into.uom}, so ${blendNames.join(', ')} will leave it out of the cost.`);
  }

  // Receipt names move over, and the merged name becomes one (a receipt may still print it).
  await c.query('UPDATE ingredient_aliases SET ingredient_id = $2 WHERE ingredient_id = $1', [source.id, into.id]);
  await c.query('DELETE FROM ingredient_aliases WHERE ingredient_id = $1 AND alias = $2', [into.id, into.name]);
  const aliasesAdded = [];
  if (source.name !== into.name) {
    await c.query(
      `INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ($1, $2)
       ON CONFLICT ((lower(alias))) DO UPDATE SET ingredient_id = EXCLUDED.ingredient_id`,
      [into.id, source.name],
    );
    aliasesAdded.push(source.name);
  }

  // Real data wins over test data, and a missing category is filled in.
  await c.query('UPDATE ingredients SET is_test = is_test AND $2, category = coalesce(category, $3) WHERE id = $1',
    [into.id, source.isTest, source.category]);
  await c.query('DELETE FROM ingredients WHERE id = $1', [source.id]);

  const kept = await load(into.id);
  const after = await costs(c, recipeIds);
  return {
    kept: pick(kept),
    merged: pick(source),
    factor: factor.toString(),
    priceBefore: into.latestUnitPrice,
    priceAfter: kept.latestUnitPrice,
    purchasesMoved,
    recipes: before.map((b) => {
      const a = after.find((r) => r.id === b.id);
      return {
        id: b.id,
        name: b.name,
        lines: lineChanges.get(b.id)?.lines ?? [],
        combined: lineChanges.get(b.id)?.combined ?? false,
        costPerServingBefore: b.costPerServing,
        costPerServingAfter: a.costPerServing,
        priceBefore: b.recommendedPrice,
        priceAfter: a.recommendedPrice,
      };
    }),
    blends: blendNames,
    events: [...new Set(events.map((e) => e.name))],
    aliasesAdded,
    warnings,
  };
}

async function costs(c, ids) {
  const recipes = await loadRecipes(ids, c);
  return recipes
    .map((r) => {
      const costing = calculateRecipe({ lines: r.lines, baseServings: r.baseServings, targetMargin: r.targetMargin, totalYield: r.totalYield });
      return { id: r.id, name: r.name, costPerServing: costing.costPerServing, recommendedPrice: costing.recommendedPrice };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const pick = ({ id, name, uom, category, isTest, latestUnitPrice }) => ({ id, name, uom, category, isTest, latestUnitPrice });

/** A conversion so small that a pack size rounds to nothing breaks the pack_size > 0 check. */
const tooSmall = (what) => (err) => {
  if (err.code === '23514') throw badRequest(`${what} would round to 0 with that conversion. Check the number.`);
  throw err;
};
