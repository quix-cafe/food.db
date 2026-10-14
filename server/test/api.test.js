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
    name: 'Flour', category: 'Dry goods', defaultYieldPercent: 100,
    purchase: { date: '2026-01-10', vendor: 'Depot', quantity: 2, unit: 'bag', totalCost: '40' },
  });
  assert.equal(status, 201);
  assert.equal(data.latestUnitCost, '20.0000');
  ids.flour = data.id;

  const dup = await api('POST', '/ingredients', { name: 'flour' });
  assert.equal(dup.status, 409);
});

test('recurring purchases keep history and the latest price wins', { skip }, async () => {
  const { status, data } = await api('POST', '/ingredients/purchase', {
    vendor: 'Depot',
    items: [
      { name: 'FLOUR', date: '2026-02-10', quantity: 1, unit: 'bag', unitCost: '25' },
      { name: 'Eggs', category: 'Dairy', date: '2026-02-10', quantity: 30, unit: 'ea', totalCost: '9' },
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
  assert.equal(hist.data.ingredient.latestUnitCost, '25.0000');

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
      { ingredientId: ids.flour, baseQuantity: 1, usePercent: 10 }, // 2.50
      { ingredientId: ids.eggs, baseQuantity: 5, usePercent: 100 }, // 1.50
    ],
  });
  assert.equal(created.status, 201);
  ids.pasta = created.data.id;
  assert.equal(created.data.costing.baseCost, '4.0000');
  assert.equal(created.data.costing.costPerServing, '1.0000');

  const calc = await api('POST', '/recipes/calculate', {
    baseServings: 4, expectedServings: 8,
    lines: [{ ingredientId: ids.flour, baseQuantity: 1, usePercent: 10 }],
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
  assert.equal(flour.quantity, '2.0000');
  assert.equal(flour.usage, '0.2000');
  assert.equal(flour.unitsToBuy, '1');
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
