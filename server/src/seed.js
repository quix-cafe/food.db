// Loads a small sample kitchen (ingredients with price history, recipes, one event).
// Refuses to run against a database that already has ingredients.

import { pool, tx } from './db.js';
import { migrate } from './migrate.js';

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA');

// [name, category, unit of measure, [[daysAgo, vendor, qty, pack size, pack price], ...]]
const INGREDIENTS = [
  ['All-purpose flour', 'Dry goods', 'lb', [[120, 'Restaurant Depot', 1, 50, '24.80'], [60, 'Restaurant Depot', 1, 50, '25.40'], [12, 'Restaurant Depot', 1, 50, '28.90']]],
  ['Unsalted butter', 'Dairy', 'lb', [[90, 'Sysco', 2, 36, '118.00'], [30, 'Sysco', 1, 36, '121.50'], [8, 'Costco', 1, 36, '112.75']]],
  ['Large eggs', 'Dairy', 'dz', [[45, 'Sysco', 2, 15, '41.20'], [5, 'Sysco', 2, 15, '47.80']]],
  ['San Marzano tomatoes', 'Canned', 'oz', [[70, 'Restaurant Depot', 6, 28, '4.15'], [20, 'Restaurant Depot', 6, 28, '4.25']]],
  ['Yellow onions', 'Produce', 'lb', [[25, 'Baldor', 1, 50, '32.00'], [4, 'Baldor', 1, 50, '34.50']]],
  ['Garlic, peeled', 'Produce', 'lb', [[30, 'Baldor', 1, 5, '18.60']]],
  ['Extra virgin olive oil', 'Oils', 'L', [[100, 'Costco', 1, 3, '29.99'], [15, 'Costco', 1, 3, '33.49']]],
  ['Parmigiano Reggiano', 'Dairy', 'lb', [[40, 'Sysco', 1, 18, '189.00']]],
  ['Fresh basil', 'Produce', 'bunch', [[6, 'Baldor', 4, 1, '2.75']]],
  ['Chicken thighs, boneless', 'Protein', 'lb', [[50, 'Sysco', 1, 40, '96.00'], [10, 'Sysco', 1, 40, '104.80']]],
  ['Kosher salt', 'Dry goods', 'lb', [[150, 'Restaurant Depot', 1, 3, '3.89']]],
  ['Granulated sugar', 'Dry goods', 'lb', [[80, 'Restaurant Depot', 1, 25, '17.40']]],
];

// [name, baseServings, totalYield, yieldUnit, margin, [[ingredient, amount used], ...]]
const RECIPES = [
  ['Marinara sauce', 20, 6, 'qt', 72, [['San Marzano tomatoes', 168], ['Yellow onions', 2], ['Garlic, peeled', 0.3], ['Extra virgin olive oil', 0.24], ['Fresh basil', 2], ['Kosher salt', 0.15]]],
  ['Brown butter shortbread', 48, 48, 'cookies', 75, [['All-purpose flour', 3], ['Unsalted butter', 2.16], ['Granulated sugar', 1], ['Kosher salt', 0.03]]],
  ['Chicken cacciatore', 12, 12, 'plates', 68, [['Chicken thighs, boneless', 12], ['San Marzano tomatoes', 84], ['Yellow onions', 3], ['Garlic, peeled', 0.15], ['Extra virgin olive oil', 0.12], ['Parmigiano Reggiano', 0.36]]],
];

await migrate();
const { rows } = await pool.query('SELECT count(*)::int AS n FROM ingredients');
if (rows[0].n > 0) {
  console.log('Database already has ingredients; skipping seed.');
} else {
  await tx(async (c) => {
    const ids = new Map();
    for (const [name, category, uom, purchases] of INGREDIENTS) {
      const { rows } = await c.query(
        'INSERT INTO ingredients (name, category, uom) VALUES ($1,$2,$3) RETURNING id',
        [name, category, uom],
      );
      ids.set(name, rows[0].id);
      for (const [ago, vendor, qty, packSize, packPrice] of purchases) {
        await c.query(
          `INSERT INTO ingredient_purchases (ingredient_id, purchase_date, vendor, quantity, pack_size, unit_cost, total_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$6::numeric * $4::numeric)`,
          [rows[0].id, daysAgo(ago), vendor, qty, packSize, packPrice],
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
      for (const [position, [ingredient, amount]] of lines.entries()) {
        await c.query(
          'INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, amount) VALUES ($1,$2,$3,$4)',
          [rows[0].id, position, ids.get(ingredient), amount],
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
