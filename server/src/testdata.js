// Clearing test data: rows marked is_test (migration 011, set while the app is in test mode).
// Anything real data still uses is kept, so clearing never changes a real recipe, blend or
// event; those test rows stay marked and go on a later clear once nothing real needs them.

import { tx } from './db.js';
import { removeFiles } from './images.js';
import { saveSnapshot } from './backup.js';

class DryRun extends Error {}

/** Delete test rows in dependency order; returns counts deleted, what was kept, and image files to remove. */
async function clearIn(c) {
  const count = async (sql) => (await c.query(sql)).rowCount;
  const filenames = async (where) =>
    (await c.query(`SELECT filename FROM images WHERE ${where}`)).rows.map((r) => r.filename);

  const deleted = {};
  deleted.events = await count('DELETE FROM events WHERE is_test');
  const recipes = 'is_test AND NOT EXISTS (SELECT 1 FROM event_recipes er WHERE er.recipe_id = recipes.id)';
  const files = await filenames(`recipe_id IN (SELECT id FROM recipes WHERE ${recipes})`);
  deleted.recipes = await count(`DELETE FROM recipes WHERE ${recipes}`);
  deleted.blends = await count(`DELETE FROM spice_blends b WHERE is_test
    AND NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.blend_id = b.id)`);
  deleted.ingredients = await count(`DELETE FROM ingredients i WHERE is_test
    AND NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.ingredient_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM spice_blend_items bi WHERE bi.ingredient_id = i.id)`);
  // Test purchases of real ingredients; a kept test ingredient keeps its prices.
  deleted.purchases = await count(`DELETE FROM ingredient_purchases p WHERE is_test
    AND NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.id = p.ingredient_id AND i.is_test)`);
  files.push(...await filenames('receipt_id IN (SELECT id FROM receipts WHERE is_test)'));
  deleted.receipts = await count('DELETE FROM receipts WHERE is_test');

  const names = async (table) => (await c.query(`SELECT name FROM ${table} WHERE is_test ORDER BY lower(name)`)).rows.map((r) => r.name);
  const kept = { recipes: await names('recipes'), blends: await names('spice_blends'), ingredients: await names('ingredients') };
  return { deleted, kept, files };
}

/** What clearing would do right now, without changing anything. */
export async function previewTestData() {
  let result;
  await tx(async (c) => {
    result = await clearIn(c);
    throw new DryRun();
  }).catch((err) => { if (!(err instanceof DryRun)) throw err; });
  const { files, ...rest } = result;
  return rest;
}

/** Delete the test data, after saving a snapshot of everything. */
export async function clearTestData() {
  const snapshot = await saveSnapshot('clearing-test-data');
  const { files, ...rest } = await tx(clearIn);
  await removeFiles(files);
  return { snapshot, ...rest };
}
