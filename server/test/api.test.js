// Integration tests against a real Postgres. Requires TEST_DATABASE_URL; that
// database's tables are dropped and recreated on every run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL is not set';

let server, base, pool;

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = url;
  ({ pool } = await import('../src/db.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrate } = await import('../src/migrate.js');
  await migrate({ log: () => {} });
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await pool?.end();
});

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

const ids = {};

test('manual entry creates an ingredient with its first purchase', { skip }, async () => {
  const { status, data } = await api('POST', '/ingredients', {
    name: 'Flour', category: 'Dry goods', uom: 'lb',
    purchase: { date: '2026-01-10', vendor: 'Depot', quantity: 2, packSize: 50, totalCost: '40' },
  });
  assert.equal(status, 201);
  assert.equal(data.uom, 'lb');
  assert.equal(data.latestPackPrice, '20.0000'); // one 50 lb bag
  assert.equal(data.latestPackSize, '50.0000');
  assert.equal(data.latestUnitPrice, '0.4000'); // per lb
  ids.flour = data.id;

  const dup = await api('POST', '/ingredients', { name: 'flour' });
  assert.equal(dup.status, 409);
});

test('recurring purchases keep history and the latest price wins', { skip }, async () => {
  const { status, data } = await api('POST', '/ingredients/purchase', {
    vendor: 'Depot',
    items: [
      { name: 'FLOUR', date: '2026-02-10', quantity: 1, packSize: 50, unitCost: '25' },
      { name: 'Eggs', category: 'Dairy', uom: 'each', date: '2026-02-10', quantity: 30, totalCost: '9' },
    ],
  });
  assert.equal(status, 201);
  assert.equal(data.purchases.length, 2);
  assert.deepEqual(data.createdIngredients.map((c) => c.name), ['Eggs']);
  ids.eggs = data.createdIngredients[0].id;

  const hist = await api('GET', `/ingredients/${ids.flour}/history`);
  assert.equal(hist.data.purchases.length, 2);
  assert.equal(hist.data.purchases[0].changePercent, '25.0');
  assert.equal(hist.data.purchases[0].priceHike, true);
  assert.equal(hist.data.ingredient.latestUnitPrice, '0.5000');
  assert.equal(hist.data.purchases[0].unitPrice, '0.5000');

  const list = await api('GET', '/ingredients?q=flo');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].purchaseCount, 2);
});

test('purchase validation reports the row', { skip }, async () => {
  const { status, data } = await api('POST', '/ingredients/purchase', { items: [{ name: 'X', quantity: 0, unitCost: 1 }] });
  assert.equal(status, 400);
  assert.match(data.error, /^Row 1:/);
});

test('recipe costing uses latest price and scales statelessly', { skip }, async () => {
  const created = await api('POST', '/recipes', {
    name: 'Pasta', baseServings: 4, targetMargin: 70,
    lines: [
      { ingredientId: ids.flour, amount: 5 }, // 5 lb × 0.50 = 2.50
      { ingredientId: ids.eggs, amount: 5 }, // 5 × 0.30 = 1.50
    ],
  });
  assert.equal(created.status, 201);
  ids.pasta = created.data.id;
  assert.equal(created.data.costing.baseCost, '4.0000');
  assert.equal(created.data.costing.costPerServing, '1.0000');
  assert.deepEqual(created.data.costing.lines.map((l) => [l.uom, l.packSize, l.packPrice, l.unitPrice]), [['lb', '50.0000', '25.0000', '0.5000'], ['each', '1.0000', '0.3000', '0.3000']]);

  const calc = await api('POST', '/recipes/calculate', {
    baseServings: 4, expectedServings: 8,
    lines: [{ ingredientId: ids.flour, amount: 5 }],
  });
  assert.equal(calc.data.scaledCost, '5.0000');

  const again = await api('GET', `/recipes/${ids.pasta}`);
  assert.equal(again.data.baseServings, 4);

  const dup = await api('POST', `/recipes/${ids.pasta}/duplicate`);
  assert.equal(dup.data.name, 'Pasta (copy)');
  assert.equal(dup.data.lines.length, 2);

  const gallery = await api('GET', '/recipes');
  assert.equal(gallery.data.length, 2);
  assert.ok(gallery.data[0].lastPriceSync);
});

test('ingredients used by a recipe cannot be deleted', { skip }, async () => {
  const { status } = await api('DELETE', `/ingredients/${ids.flour}`);
  assert.equal(status, 409);
});

test('event summary aggregates cost, revenue and shopping list', { skip }, async () => {
  const ev = await api('POST', '/events', { name: 'Gala', date: '2026-11-01', guestCount: 8 });
  assert.equal(ev.status, 201);
  const added = await api('POST', `/events/${ev.data.id}/recipes`, { recipeId: ids.pasta, expectedServings: 8 });
  assert.equal(added.data.recipes.length, 1);

  const { data } = await api('GET', `/events/${ev.data.id}/summary`);
  assert.equal(data.totalCost, '8.0000');
  assert.equal(data.revenue, '26.64'); // 3.33 × 8
  const flour = data.shoppingList.find((l) => l.name === 'Flour');
  assert.equal(flour.amount, '10.0000'); // 5 lb × 2
  assert.equal(flour.uom, 'lb');
  assert.equal(flour.packsToBuy, '1'); // one 50 lb bag
  assert.equal(flour.purchaseCost, '25.0000'); // the whole bag
  assert.equal(flour.usedCost, '5.0000'); // 10 lb × 0.50
});

test('a needed amount set on the shopping list replaces the scaled total', { skip }, async () => {
  const ev = (await api('GET', '/events')).data.find((e) => e.name === 'Gala');
  const before = (await api('GET', `/events/${ev.id}/summary`)).data;
  assert.equal((await api('PUT', `/events/${ev.id}/amounts/${ids.eggs}`, { amount: 3 })).status, 204);
  const set = (await api('GET', `/events/${ev.id}/summary`)).data;
  const eggs = set.shoppingList.find((l) => l.name === 'Eggs');
  assert.deepEqual([eggs.amount, eggs.calculatedAmount, eggs.amountSet], ['3.0000', '10.0000', true]);
  assert.equal(set.adjustment, '-2.1000'); // 7 fewer eggs × 0.30
  assert.equal(set.totalCost, '5.9000');
  assert.equal((await api('PUT', `/events/${ev.id}/amounts/${ids.eggs}`, { amount: -1 })).status, 400);
  assert.equal((await api('DELETE', `/events/${ev.id}/amounts/${ids.eggs}`)).status, 204);
  assert.equal((await api('GET', `/events/${ev.id}/summary`)).data.totalCost, before.totalCost);
});

test('validation errors are 400s with readable messages', { skip }, async () => {
  const r = await api('POST', '/recipes', { name: 'Bad', baseServings: 0 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Base servings/);
  const e = await api('POST', '/events', { name: 'X', date: '2026-02-30' });
  assert.equal(e.status, 400);
});

test('receipt JSON import suggests existing ingredients and saves nothing', { skip }, async () => {
  const before = await api('GET', '/ingredients');
  const { status, data } = await api('POST', '/ingredients/import-receipt', {
    store_name: 'Depot', items: [{ name: 'flour', price: 26 }, { name: 'Saffron threads', price: 12 }],
  });
  assert.equal(status, 200);
  assert.equal(data.items[0].match.id, ids.flour);
  assert.equal(data.items[1].match, null);
  const afterList = await api('GET', '/ingredients');
  assert.equal(afterList.data.length, before.data.length);
});

test('receipt names become aliases and auto-resolve on the next import', { skip }, async () => {
  const receipt = { vendor: 'Depot', items: [{ name: 'AP FLR 50#', price: 27 }, { name: 'LMN JUICE', price: 4 }] };

  const first = await api('POST', '/ingredients/import-receipt', receipt);
  assert.equal(first.data.items[0].match, null);

  // Row 1 mapped to an existing ingredient; row 2 typed as a new name.
  const saved = await api('POST', '/ingredients/purchase', {
    vendor: 'Depot',
    items: [
      { ingredientId: ids.flour, alias: 'AP FLR 50#', quantity: 1, totalCost: 27 },
      { name: 'Lemon juice', category: 'Produce', alias: 'LMN JUICE', quantity: 1, totalCost: 4 },
    ],
  });
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.data.aliasesSaved.map((a) => [a.alias, a.ingredient]), [['AP FLR 50#', 'Flour'], ['LMN JUICE', 'Lemon juice']]);
  assert.deepEqual(saved.data.createdIngredients.map((c) => c.name), ['Lemon juice']);

  const again = await api('POST', '/ingredients/import-receipt', { items: [{ name: 'ap flr 50#', price: 28 }, { name: 'LMN JUICE', price: 4 }] });
  assert.deepEqual(again.data.items.map((i) => [i.match?.name, i.match?.via]), [['Flour', 'alias'], ['Lemon juice', 'alias']]);

  // Committing by the receipt name alone also resolves through the alias.
  const byAlias = await api('POST', '/ingredients/purchase', { items: [{ name: 'AP FLR 50#', quantity: 1, totalCost: 28 }] });
  assert.equal(byAlias.data.createdIngredients.length, 0);
  assert.equal(byAlias.data.purchases[0].ingredientId, ids.flour);

  // Search finds an ingredient by alias; the drawer lists and removes aliases.
  const search = await api('GET', '/ingredients?q=flr');
  assert.deepEqual(search.data.map((i) => i.name), ['Flour']);
  const hist = await api('GET', `/ingredients/${ids.flour}/history`);
  assert.deepEqual(hist.data.aliases.map((a) => a.alias), ['AP FLR 50#']);
  const del = await api('DELETE', `/ingredients/${ids.flour}/aliases/${hist.data.aliases[0].id}`);
  assert.equal(del.status, 204);
  const after = await api('POST', '/ingredients/import-receipt', { items: [{ name: 'AP FLR 50#', price: 28 }] });
  assert.equal(after.data.items[0].match, null);
});

test('an alias equal to the ingredient name is not stored', { skip }, async () => {
  const r = await api('POST', '/ingredients/purchase', { items: [{ ingredientId: ids.flour, alias: 'FLOUR', quantity: 1, totalCost: 1 }] });
  assert.deepEqual(r.data.aliasesSaved, []);
});

test('price movement compares against the previous purchase from any store', { skip }, async () => {
  // A smaller bag elsewhere: compared per lb, not per bag.
  await api('POST', '/ingredients/purchase', { vendor: 'Mart', items: [{ ingredientId: ids.flour, date: '2026-03-01', quantity: 1, packSize: 25, unitCost: '15' }] });
  const hist = (await api('GET', `/ingredients/${ids.flour}/history`)).data;
  const mart = hist.purchases.find((p) => p.vendor === 'Mart');
  assert.equal(mart.unitPrice, '0.6000');
  assert.equal(mart.changePercent, '20.0'); // vs Depot's $0.50/lb
  assert.equal(mart.priceHike, true);
  assert.deepEqual(mart.previous, { vendor: 'Depot', unitPrice: '0.5000', packSize: '50.0000', date: '2026-02-10' });

  // A mis-entered pack size can be corrected; the price paid stays.
  const fixed = await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, { packSize: 30 });
  assert.deepEqual([fixed.data.packSize, fixed.data.unitCost, fixed.data.unitPrice], ['30.0000', '15.0000', '0.5000']);
  assert.equal((await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, { packSize: 0 })).status, 400);
  assert.equal((await api('PATCH', `/ingredients/${ids.eggs}/purchases/${mart.id}`, { packSize: 5 })).status, 404);
  await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, { packSize: 25 });

  // Pack sizes are in the ingredient's unit; another unit is refused.
  const wrong = await api('POST', '/ingredients/purchase', { items: [{ ingredientId: ids.flour, uom: 'kg', quantity: 1, packSize: 10, unitCost: 9 }] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /measured in lb/);
});

test('a capitalization-only rename on review renames the ingredient', { skip }, async () => {
  const fix = await api('POST', '/ingredients/purchase', { items: [{ ingredientId: ids.flour, name: 'FLOUR', alias: 'AP FLR', quantity: 1, totalCost: 1 }] });
  assert.deepEqual(fix.data.renamedIngredients.map((i) => i.name), ['FLOUR']);
  assert.deepEqual(fix.data.aliasesSaved.map((a) => a.ingredient), ['FLOUR']);
  const back = await api('POST', '/ingredients/purchase', { items: [{ ingredientId: ids.flour, name: 'Flour', quantity: 1, totalCost: 1 }] });
  assert.deepEqual(back.data.renamedIngredients.map((i) => i.name), ['Flour']);
  // A bare name only resolves, and a different name sent with an id is ignored.
  const other = await api('POST', '/ingredients/purchase', { items: [{ name: 'FLOUR', quantity: 1, totalCost: 1 }, { ingredientId: ids.flour, name: 'Bread flour', quantity: 1, totalCost: 1 }] });
  assert.deepEqual(other.data.renamedIngredients, []);
  assert.equal((await api('GET', `/ingredients/${ids.flour}`)).data.name, 'Flour');
});

test('recipe amounts can exceed a pack and margins keep 6 decimals', { skip }, async () => {
  const r = await api('POST', '/recipes', { name: 'Double', baseServings: 1, targetMargin: '70.833333', lines: [{ ingredientId: ids.flour, amount: '120' }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.lines[0].amount, '120.0000');
  assert.equal(r.data.targetMargin, '70.833333');
  assert.equal((await api('POST', '/recipes', { name: 'Neg', baseServings: 1, lines: [{ ingredientId: ids.flour, amount: '-1' }] })).status, 400);
});

test('spice blends: breakdown, use in a recipe as tsp, and an event batch line', { skip }, async () => {
  const paprika = (await api('POST', '/ingredients', { name: 'Paprika', category: 'Spices', uom: 'oz', purchase: { quantity: 1, packSize: 4, totalCost: 8 } })).data;
  const blend = await api('POST', '/blends', {
    name: 'House rub', notes: 'For chicken', servings: 4,
    items: [{ ingredientId: paprika.id, amount: '2', unit: 'Tablespoons' }, { name: 'Salt', amount: '1 1/2', unit: 'tsp' }, { name: 'Cayenne', amount: '8', unit: 'pinch' }],
  });
  assert.equal(blend.status, 201);
  assert.equal(blend.data.totalTsp, '8.0000'); // 6 + 1.5 + 0.5
  assert.equal(blend.data.servings, 4);
  assert.equal((await api('POST', '/blends', { name: 'X', servings: 0, items: [] })).status, 400);
  assert.deepEqual(blend.data.items.map((i) => [i.name, i.unit, i.share]), [['Paprika', 'tbsp', '75.0'], ['Salt', 'tsp', '18.8'], ['Cayenne', 'pinch', '6.3']]);
  assert.equal(blend.data.cost, '1.0582'); // 15 g of paprika at $2/oz
  assert.equal(blend.data.costComplete, false);

  const bad = await api('POST', '/blends', { name: 'X', items: [{ name: 'Salt', amount: 1, unit: 'handful' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /isn’t a unit/);

  const recipe = await api('POST', '/recipes', { name: 'Rubbed chicken', baseServings: 2, lines: [{ blendId: blend.data.id, amount: 4 }] });
  assert.equal(recipe.status, 201);
  const line = recipe.data.costing.lines[0];
  assert.deepEqual([line.name, line.uom, line.packSize, line.packPrice, line.unitPrice, line.baseCost], ['House rub', 'tsp', '8.0000', '1.0582', '0.1323', '0.5291']);

  const ev = (await api('POST', '/events', { name: 'Cookout', date: '2026-12-01', recipes: [{ recipeId: recipe.data.id, expectedServings: 6 }] })).data;
  const shop = (await api('GET', `/events/${ev.id}/summary`)).data.shoppingList;
  const rub = shop.find((l) => l.blendId === blend.data.id);
  assert.deepEqual([rub.amount, rub.packsToBuy, rub.leftover], ['12.0000', '2', '4.0000']); // 12 tsp in 8 tsp batches

  assert.equal((await api('DELETE', `/blends/${blend.data.id}`)).status, 409); // used by the recipe
  assert.equal((await api('DELETE', `/ingredients/${paprika.id}`)).status, 409); // used by the blend
  const list = (await api('GET', '/blends?q=house')).data;
  assert.deepEqual(list.map((b) => b.name), ['House rub']);
});

test('test mode marks new data, and clearing it keeps whatever real data uses', { skip }, async () => {
  const { mkdtemp, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  process.env.BACKUP_DIR = await mkdtemp(`${tmpdir()}/food.db-test-`);
  const test = { 'x-test-data': '1' };
  const purchase = (packSize, totalCost) => ({ date: '2026-06-01', vendor: 'Depot', quantity: 1, packSize, totalCost });

  const rice = (await api('POST', '/ingredients', { name: 'Rice', category: 'Dry goods', uom: 'lb', purchase: purchase(10, '10') })).data;
  assert.equal(rice.isTest, false);
  // In test mode: a new ingredient, a newer purchase of a real one, a recipe and an event.
  const oats = (await api('POST', '/ingredients', { name: 'Test oats', uom: 'lb', purchase: purchase(1, '3') }, test)).data;
  const saffron = (await api('POST', '/ingredients', { name: 'Test saffron', uom: 'g', purchase: purchase(1, '9') }, test)).data;
  assert.equal(oats.isTest, true);
  assert.equal((await api('POST', `/ingredients/${rice.id}/purchases`, { ...purchase(10, '20'), date: '2026-07-01' }, test)).status, 201);
  assert.equal((await api('GET', `/ingredients/${rice.id}`)).data.latestUnitPrice, '2.0000');
  const porridge = (await api('POST', '/recipes', { name: 'Test porridge', baseServings: 1, lines: [{ ingredientId: oats.id, amount: 1 }] }, test)).data;
  const ev = (await api('POST', '/events', { name: 'Test brunch', date: '2026-12-01', recipes: [{ recipeId: porridge.id, expectedServings: 2 }] }, test)).data;
  assert.equal(porridge.isTest, true);
  assert.equal(ev.isTest, true);
  // A real recipe that uses a test ingredient keeps that ingredient.
  const paella = (await api('POST', '/recipes', { name: 'Paella', baseServings: 4, lines: [{ ingredientId: saffron.id, amount: 1 }] })).data;
  assert.equal(paella.isTest, false);

  // Labor is never test data, even when added and re-rated in test mode.
  const labor = (await api('POST', '/ingredients', { name: 'Labor', category: 'Labor', uom: 'hr', purchase: purchase(1, '20') }, test)).data;
  assert.equal(labor.isTest, false);
  assert.equal((await api('POST', `/ingredients/${labor.id}/purchases`, { ...purchase(1, '25'), date: '2026-07-01' }, test)).status, 201);

  const preview = (await api('GET', '/test-data')).data;
  assert.deepEqual(preview.deleted, { events: 1, recipes: 1, blends: 0, ingredients: 1, purchases: 1, receipts: 0 });
  assert.deepEqual(preview.kept.ingredients, ['Test saffron']);
  assert.equal((await api('GET', `/events/${ev.id}`)).status, 200); // a preview changes nothing

  const cleared = (await api('POST', '/test-data/clear', undefined, test)).data;
  assert.deepEqual(cleared.deleted, preview.deleted);
  assert.ok((await readdir(process.env.BACKUP_DIR)).includes(cleared.snapshot));
  assert.equal((await api('GET', `/events/${ev.id}`)).status, 404);
  assert.equal((await api('GET', `/recipes/${porridge.id}`)).status, 404);
  assert.equal((await api('GET', `/ingredients/${oats.id}`)).status, 404);
  assert.equal((await api('GET', `/ingredients/${rice.id}`)).data.latestUnitPrice, '1.0000'); // back to the real price
  assert.equal((await api('GET', `/recipes/${paella.id}`)).status, 200);
  assert.equal((await api('GET', `/ingredients/${saffron.id}`)).data.isTest, true);
  assert.equal((await api('GET', `/ingredients/${labor.id}`)).data.latestUnitPrice, '25.0000');
});

test('a database migrated before migrations 001–010 were squashed is recognised', { skip }, async () => {
  const { migrate } = await import('../src/migrate.js');
  const legacy = ['001_init.sql', '002_ingredient_aliases.sql', '003_receipts_and_images.sql', '004_receipt_lines.sql',
    '005_used_multiplier_and_price.sql', '006_units_of_measure.sql', '007_drop_legacy_columns.sql', '008_event_amounts.sql',
    '009_spice_blends.sql', '010_blend_servings.sql'];
  await pool.query("DELETE FROM schema_migrations WHERE name = '001_schema.sql'");
  await pool.query('INSERT INTO schema_migrations (name) SELECT unnest($1::text[])', [legacy]);
  await migrate({ log: () => {} });
  const { rows } = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  assert.deepEqual(rows.map((r) => r.name), ['001_schema.sql', '011_test_data.sql', '012_labor_never_test.sql', '013_event_results.sql']);
});

test('event results: set with the event, kept when a save leaves them out, cleared when blank', { skip }, async () => {
  const ev = (await api('POST', '/events', { name: 'Gala', date: '2026-09-01', guestCount: 40 })).data;
  assert.equal(ev.actualGuests, null);
  const base = { name: 'Gala', date: '2026-09-01', guestCount: 40 };
  const saved = await api('PUT', `/events/${ev.id}`, { ...base, actualGuests: 38, actualRevenue: '1520.5', actualCost: '610', notes: 'Ran out of bread' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.data.actualGuests, saved.data.actualRevenue, saved.data.actualCost, saved.data.notes], [38, '1520.50', '610.00', 'Ran out of bread']);
  const renamed = (await api('PUT', `/events/${ev.id}`, { ...base, name: 'Autumn gala' })).data; // no results in the body
  assert.deepEqual([renamed.name, renamed.actualGuests, renamed.actualRevenue], ['Autumn gala', 38, '1520.50']);
  const cleared = (await api('PUT', `/events/${ev.id}`, { ...base, actualCost: '' })).data;
  assert.equal(cleared.actualCost, null);
  assert.equal(cleared.actualRevenue, '1520.50');
  assert.equal((await api('PUT', `/events/${ev.id}`, { ...base, actualGuests: -1 })).status, 400);
});

test('CSV exports: ingredients, price history and an event shopping list', { skip }, async () => {
  const csv = async (path) => {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=".+\.csv"/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM, for Excel
    return bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
  };
  await api('POST', '/ingredients', { name: '=Sum trick, "quoted"', uom: 'each', purchase: { date: '2026-03-01', vendor: 'Depot', quantity: 1, packSize: 1, totalCost: '2' } });

  const ingredients = await csv('/export/ingredients.csv');
  assert.equal(ingredients[0], 'Ingredient,Category,Unit,Unit price,Pack size,Pack price,Vendor,Last bought,Test data,ID');
  // A formula-looking name is defused and quoted; numbers are left alone.
  assert.ok(ingredients.some((l) => l.startsWith(`"'=Sum trick, ""quoted""",,each,2.0000,1.0000,2.0000,Depot,2026-03-01,,`)));

  const history = await csv('/export/purchases.csv');
  assert.equal(history[0], 'Date,Ingredient,Category,Vendor,Packs bought,Pack size,Unit,Pack price,Total,Unit price,Receipt ID,Test data,Ingredient ID');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM ingredient_purchases');
  assert.equal(history.length - 1, rows[0].n);

  const flour = (await api('GET', '/ingredients?q=flour')).data[0];
  const recipe = (await api('POST', '/recipes', { name: 'Flatbread', baseServings: 4, lines: [{ ingredientId: flour.id, amount: 2 }] })).data;
  const ev = (await api('POST', '/events', { name: 'Bread & Co. night', date: '2026-11-02', recipes: [{ recipeId: recipe.id, expectedServings: 8 }] })).data;
  const res = await fetch(`${base}/events/${ev.id}/shopping-list.csv`);
  assert.match(res.headers.get('content-disposition'), /filename="bread-co-night-2026-11-02-shopping-list.csv"/);
  const list = (await res.text()).trimEnd().split('\r\n'); // text() drops the BOM
  assert.equal(list[0], 'Ingredient,Category,Needed,Unit,Packs to buy,Pack size,Total cost,Used cost,Leftover,Vendor,Used in');
  assert.match(list[1], /^Flour,Dry goods,4\.0000,lb,\d+,.*,Flatbread$/); // 2 lb × 8/4 servings
});
