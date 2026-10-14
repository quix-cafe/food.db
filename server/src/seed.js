// Loads a small sample kitchen (ingredients with price history, recipes, one event).
// Refuses to run against a database that already has ingredients.

import { pool, tx } from './db.js';
import { migrate } from './migrate.js';

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA');

// [name, category, yield %, [[daysAgo, vendor, qty, unit, unitCost], ...]]
const INGREDIENTS = [
  ['All-purpose flour', 'Dry goods', 100, [[120, 'Restaurant Depot', 1, 'bag 50 lb', '24.80'], [60, 'Restaurant Depot', 1, 'bag 50 lb', '25.40'], [12, 'Restaurant Depot', 1, 'bag 50 lb', '28.90']]],
  ['Unsalted butter', 'Dairy', 100, [[90, 'Sysco', 2, 'case 36 lb', '118.00'], [30, 'Sysco', 1, 'case 36 lb', '121.50'], [8, 'Costco', 1, 'case 36 lb', '112.75']]],
  ['Large eggs', 'Dairy', 100, [[45, 'Sysco', 2, 'case 15 dz', '41.20'], [5, 'Sysco', 2, 'case 15 dz', '47.80']]],
  ['San Marzano tomatoes', 'Canned', 100, [[70, 'Restaurant Depot', 6, 'can 28 oz', '4.15'], [20, 'Restaurant Depot', 6, 'can 28 oz', '4.25']]],
  ['Yellow onions', 'Produce', 90, [[25, 'Baldor', 1, 'sack 50 lb', '32.00'], [4, 'Baldor', 1, 'sack 50 lb', '34.50']]],
  ['Garlic, peeled', 'Produce', 95, [[30, 'Baldor', 1, 'jar 5 lb', '18.60']]],
  ['Extra virgin olive oil', 'Oils', 100, [[100, 'Costco', 1, 'tin 3 L', '29.99'], [15, 'Costco', 1, 'tin 3 L', '33.49']]],
  ['Parmigiano Reggiano', 'Dairy', 85, [[40, 'Sysco', 1, 'wheel quarter 18 lb', '189.00']]],
  ['Fresh basil', 'Produce', 70, [[6, 'Baldor', 4, 'bunch', '2.75']]],
  ['Chicken thighs, boneless', 'Protein', 92, [[50, 'Sysco', 1, 'case 40 lb', '96.00'], [10, 'Sysco', 1, 'case 40 lb', '104.80']]],
  ['Kosher salt', 'Dry goods', 100, [[150, 'Restaurant Depot', 1, 'box 3 lb', '3.89']]],
  ['Granulated sugar', 'Dry goods', 100, [[80, 'Restaurant Depot', 1, 'bag 25 lb', '17.40']]],
];

// [name, baseServings, totalYield, yieldUnit, margin, [[ingredient, qty, use%], ...]]
const RECIPES = [
  ['Marinara sauce', 20, 6, 'qt', 72, [['San Marzano tomatoes', 6, 100], ['Yellow onions', 1, 4], ['Garlic, peeled', 1, 6], ['Extra virgin olive oil', 1, 8], ['Fresh basil', 2, 100], ['Kosher salt', 1, 5]]],
  ['Brown butter shortbread', 48, 48, 'cookies', 75, [['All-purpose flour', 1, 6], ['Unsalted butter', 1, 6], ['Granulated sugar', 1, 4], ['Kosher salt', 1, 1]]],
  ['Chicken cacciatore', 12, 12, 'plates', 68, [['Chicken thighs, boneless', 1, 30], ['San Marzano tomatoes', 3, 100], ['Yellow onions', 1, 6], ['Garlic, peeled', 1, 3], ['Extra virgin olive oil', 1, 4], ['Parmigiano Reggiano', 1, 2]]],
];

await migrate();
const { rows } = await pool.query('SELECT count(*)::int AS n FROM ingredients');
if (rows[0].n > 0) {
  console.log('Database already has ingredients; skipping seed.');
} else {
  await tx(async (c) => {
    const ids = new Map();
    for (const [name, category, yieldPct, purchases] of INGREDIENTS) {
      const { rows } = await c.query(
        'INSERT INTO ingredients (name, category, default_yield_percent) VALUES ($1,$2,$3) RETURNING id',
        [name, category, yieldPct],
      );
      ids.set(name, rows[0].id);
      for (const [ago, vendor, qty, unit, unitCost] of purchases) {
        await c.query(
          `INSERT INTO ingredient_purchases (ingredient_id, purchase_date, vendor, quantity, unit, unit_cost, total_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$6::numeric * $4::numeric)`,
          [rows[0].id, daysAgo(ago), vendor, qty, unit, unitCost],
        );
      }
    }
    const recipeIds = [];
    for (const [name, servings, yieldQty, yieldUnit, margin, lines] of RECIPES) {
      const { rows } = await c.query(
        `INSERT INTO recipes (name, base_servings, total_yield, yield_unit, target_margin) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, servings, yieldQty, yieldUnit, margin],
      );
      recipeIds.push(rows[0].id);
      for (const [position, [ingredient, qty, usePct]] of lines.entries()) {
        await c.query(
          'INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, use_percent, base_quantity) VALUES ($1,$2,$3,$4,$5)',
          [rows[0].id, position, ids.get(ingredient), usePct, qty],
        );
      }
    }
    const { rows: ev } = await c.query(
      `INSERT INTO events (name, event_date, guest_count) VALUES ('Harvest dinner', $1, 60) RETURNING id`,
      [daysAgo(-10)],
    );
    for (const [i, servings] of [[1, 60], [2, 60]]) {
      await c.query('INSERT INTO event_recipes (event_id, recipe_id, expected_servings) VALUES ($1,$2,$3)', [ev[0].id, recipeIds[i], servings]);
    }
  });
  console.log(`Seeded ${INGREDIENTS.length} ingredients, ${RECIPES.length} recipes and 1 event.`);
}
await pool.end();
