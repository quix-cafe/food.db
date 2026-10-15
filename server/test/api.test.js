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

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
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
