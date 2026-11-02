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

// Save an event's plan from its latest version, as a page that has just loaded it would.
async function saveEvent(id, body) {
  const { data } = await api('GET', `/events/${id}`);
  return api('PUT', `/events/${id}`, { version: data.version, ...body });
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
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
  assert.equal(list.data[0].purchaseCount, 3); // two bags, then one
  // Packs bought: 30 eggs on one line are 30; a weighed 1.46 lb is one buy.
  const all = (await api('GET', '/ingredients')).data;
  assert.equal(all.find((i) => i.name === 'Eggs').purchaseCount, 30);
  const weighed = await api('POST', '/ingredients/purchase', { items: [{ name: 'Plum tomatoes', uom: 'lb', quantity: 1.46, packSize: 1, unitCost: '1.79' }] });
  const tomato = (await api('GET', '/ingredients?q=plum')).data[0];
  assert.equal(tomato.purchaseCount, 1);
  await api('DELETE', `/ingredients/${weighed.data.purchases[0].ingredientId}/purchases/${weighed.data.purchases[0].id}`);
  await api('DELETE', `/ingredients/${tomato.id}`);
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
  // Amounts can be fractions, as in the Spice Lab.
  const half = await api('POST', '/recipes/calculate', { baseServings: 1, lines: [{ ingredientId: ids.flour, amount: '1 1/2' }] });
  assert.equal(half.data.lines[0].amount, '1.5');
  assert.equal((await api('POST', '/recipes/calculate', { baseServings: 1, lines: [{ ingredientId: ids.flour, amount: '1/0' }] })).status, 400);

  const again = await api('GET', `/recipes/${ids.pasta}`);
  assert.equal(again.data.baseServings, 4);

  const dup = await api('POST', `/recipes/${ids.pasta}/duplicate`);
  assert.equal(dup.data.name, 'Pasta (copy)');
  assert.equal(dup.data.lines.length, 2);

  const gallery = await api('GET', '/recipes');
  assert.equal(gallery.data.length, 2);
  assert.ok(gallery.data[0].lastPriceSync);
  assert.deepEqual([gallery.data[0].ingredientCount, gallery.data[0].laborMinutes], [2, null]);

  // The gallery lists labor as minutes, apart from the ingredient count.
  const labor = (await api('POST', '/ingredients', { name: 'Labor', category: 'Labor', uom: 'hr', purchase: { quantity: 1, packSize: 1, totalCost: 20 } })).data;
  const timed = (await api('POST', '/recipes', { name: 'Timed', baseServings: 1, lines: [{ ingredientId: ids.flour, amount: 1 }, { ingredientId: labor.id, amount: '0.75' }] })).data;
  const card = (await api('GET', '/recipes')).data.find((r) => r.id === timed.id);
  assert.deepEqual([card.ingredientCount, card.laborMinutes], [1, '45']);
  await api('DELETE', `/recipes/${timed.id}`);
  await api('DELETE', `/ingredients/${labor.id}`);
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

test('a serving size set for one event carries through costing, orders and copies', { skip }, async () => {
  const taco = (await api('POST', '/recipes', { name: 'Taco', baseServings: 4, totalYield: 4, yieldUnit: 'tacos', targetMargin: 70, lines: [{ ingredientId: ids.flour, amount: 8 }] })).data; // $1 a taco
  const ev = (await api('POST', '/events', { name: 'Taco night', date: '2026-11-03' })).data;
  const put = (recipe) => saveEvent(ev.id, { name: ev.name, date: ev.date, recipes: [{ recipeId: taco.id, expectedServings: 10, ...recipe }] });
  const summary = async (id = ev.id) => (await api('GET', `/events/${id}/summary`)).data;

  assert.equal((await put({ servingSize: '3', salePrice: '14' })).data.recipes[0].servingSize, '3.0000');
  let s = await summary();
  let [r] = s.recipes;
  assert.deepEqual([r.expectedServings, r.servingLabel, r.costPerServing, r.salePrice, r.scaledCost, r.revenue], ['10', '3 tacos', '3.0000', '14.00', '30.0000', '140.00']);
  assert.equal(s.shoppingList.find((l) => l.ingredientId === ids.flour).amount, '60.0000'); // 30 tacos × 2 lb

  // An order is charged per serving, and names what it was.
  const sold = await api('POST', `/events/${ev.id}/sales`, { paymentMethod: 'cash', status: 'placed', items: [{ recipeId: taco.id, quantity: 2 }] });
  assert.deepEqual([sold.data.sales[0].items[0].name, sold.data.sales[0].total], ['Taco (3 tacos)', '28.00']);
  assert.equal(sold.data.totals.byRecipe[0].sold, 2);

  // Left out of a body it stays, a copy keeps it, and blank goes back to the recipe's.
  await put({});
  const copy = (await api('POST', `/events/${ev.id}/duplicate`)).data;
  assert.equal((await summary(copy.id)).recipes[0].servingLabel, '3 tacos');
  await api('POST', `/events/${ev.id}/recipes`, { recipeId: taco.id, expectedServings: 10 });
  assert.equal((await summary()).recipes[0].servingLabel, '3 tacos');
  await put({ servingSize: '' });
  [r] = (await summary()).recipes;
  assert.deepEqual([r.servingLabel, r.costPerServing, r.salePrice, r.scaledCost], [null, '1.0000', '14.00', '10.0000']);

  for (const bad of ['0', '-1', 'lots']) assert.equal((await put({ servingSize: bad })).status, 400);
  await api('DELETE', `/events/${copy.id}`);
  await api('DELETE', `/events/${ev.id}`);
  await api('DELETE', `/recipes/${taco.id}`);
});

test('a sale price and a deal can be set per event', { skip }, async () => {
  const ev = (await api('POST', '/events', { name: 'Street fair', date: '2026-11-02' })).data;
  const summary = async () => (await api('GET', `/events/${ev.id}/summary`)).data;

  // Added from the gallery with a $4 price and "buy 2, get $1 off".
  const added = await api('POST', `/events/${ev.id}/recipes`, { recipeId: ids.pasta, expectedServings: 8, salePrice: '4', discountAmount: '1', discountQty: '2' });
  assert.deepEqual(added.data.recipes.map((r) => [r.salePrice, r.discountAmount, r.discountQty]), [['4.00', '1.00', 2]]);
  let r = (await summary()).recipes[0];
  assert.deepEqual([r.recommendedPrice, r.salePrice, r.discount, r.revenue, r.profit, r.marginPerServing], ['3.33', '4.00', '4.00', '28.00', '20.00', '2.5000']);

  // The planner's autosave without pricing keeps it; re-adding with new servings keeps it too.
  await saveEvent(ev.id, { name: ev.name, date: ev.date, recipes: [{ recipeId: ids.pasta, expectedServings: 10 }] });
  await api('POST', `/events/${ev.id}/recipes`, { recipeId: ids.pasta, expectedServings: 8 });
  r = (await summary()).recipes[0];
  assert.deepEqual([r.salePrice, r.discountAmount, r.discountQty], ['4.00', '1.00', 2]);

  // A per-serving discount; then blanks go back to the recipe's price and no deal.
  await saveEvent(ev.id, { name: ev.name, date: ev.date, recipes: [{ recipeId: ids.pasta, expectedServings: 8, salePrice: '4.5', discountAmount: '0.25', discountQty: '' }] });
  r = (await summary()).recipes[0];
  assert.deepEqual([r.salePrice, r.discountQty, r.revenue], ['4.50', 1, '34.00']);
  await saveEvent(ev.id, { name: ev.name, date: ev.date, recipes: [{ recipeId: ids.pasta, expectedServings: 8, salePrice: '', discountAmount: '', discountQty: '' }] });
  r = (await summary()).recipes[0];
  assert.deepEqual([r.salePrice, r.priceSet, r.discountAmount, r.revenue], ['3.33', false, null, '26.64']);

  for (const bad of [{ salePrice: '-1' }, { discountAmount: '1', discountQty: '0' }, { discountAmount: 'lots' }]) {
    assert.equal((await api('POST', `/events/${ev.id}/recipes`, { recipeId: ids.pasta, expectedServings: 8, ...bad })).status, 400);
  }
  await api('DELETE', `/events/${ev.id}`);
});

test('a vendor fee is set with the event and comes off its profit', { skip }, async () => {
  const ev = (await api('POST', '/events', { name: 'Farmers market', date: '2026-11-04', vendorFee: '25' })).data;
  assert.equal(ev.vendorFee, '25.00');
  await api('POST', `/events/${ev.id}/recipes`, { recipeId: ids.pasta, expectedServings: 8 });
  let s = (await api('GET', `/events/${ev.id}/summary`)).data;
  assert.deepEqual([s.totalCost, s.revenue, s.vendorFee, s.profit], ['8.0000', '26.64', '25.00', '-6.36']);

  // The planner's autosave changes it; a save that leaves it out keeps it; blank clears it.
  const put = (body) => saveEvent(ev.id, { name: ev.name, date: ev.date, ...body });
  assert.equal((await put({ vendorFee: '10.5' })).data.vendorFee, '10.50');
  assert.equal((await put({})).data.vendorFee, '10.50');
  assert.equal((await api('GET', `/events/${ev.id}/summary`)).data.profit, '8.14');
  assert.equal((await put({ vendorFee: '-1' })).status, 400);
  assert.equal((await put({ vendorFee: '' })).data.vendorFee, null);
  s = (await api('GET', `/events/${ev.id}/summary`)).data;
  assert.deepEqual([s.vendorFee, s.profit], ['0.00', '18.64']);
  await api('DELETE', `/events/${ev.id}`);
});

test('orders: a name and a status through the queue, and cancelled ones count toward nothing', { skip }, async () => {
  const ev = (await api('POST', '/events', { name: 'Order night', date: '2026-11-04' })).data;
  await api('POST', `/events/${ev.id}/recipes`, { recipeId: ids.pasta, expectedServings: 20, salePrice: '4' });
  const place = (body) => api('POST', `/events/${ev.id}/sales`, { paymentMethod: 'cash', items: [{ recipeId: ids.pasta, quantity: 2 }], ...body });
  const patch = (saleId, body) => api('PATCH', `/events/${ev.id}/sales/${saleId}`, body);

  // A sale sent with neither: nameless, and handed over already.
  let r = await place({});
  assert.deepEqual([r.data.sales[0].customerName, r.data.sales[0].status], [null, 'completed']);
  r = await place({ customerName: 'Ana' }); // named, still handed over on the spot
  assert.deepEqual([r.data.sales[0].customerName, r.data.sales[0].status], ['Ana', 'completed']);
  assert.equal((await api('DELETE', `/events/${ev.id}/sales/${r.data.sales[0].id}`)).status, 204);
  r = await place({ customerName: '  Sam ', status: 'placed' });
  const order = r.data.sales[0];
  assert.deepEqual([order.customerName, order.status, order.total], ['Sam', 'placed', '8.00']);
  assert.deepEqual(r.data.totals.byStatus, { placed: 1, in_progress: 0, completed: 1, cancelled: 0 });
  assert.equal((await place({ status: 'lost' })).status, 400);

  // Its status moves any way, and only a real change restamps it.
  r = await patch(order.id, { status: 'in_progress' });
  const started = r.data.sales.find((s) => s.id === order.id);
  assert.deepEqual([started.status, started.customerName], ['in_progress', 'Sam']);
  r = await patch(order.id, { customerName: 'Sam B' });
  const renamed = r.data.sales.find((s) => s.id === order.id);
  assert.deepEqual([renamed.status, renamed.customerName, renamed.statusChangedAt], ['in_progress', 'Sam B', started.statusChangedAt]);
  assert.equal((await patch(order.id, { customerName: '' })).data.sales.find((s) => s.id === order.id).customerName, null);
  assert.equal((await patch(order.id, { status: 'lost' })).status, 400);
  assert.equal((await patch('00000000-0000-0000-0000-000000000000', { status: 'placed' })).status, 404);

  // Timing: each stage is stamped once, stepping back clears what hasn't happened yet.
  const timed = async (body) => (await patch(order.id, body)).data.sales.find((s) => s.id === order.id);
  let o = await timed({ status: 'in_progress' });
  assert.ok(o.inProgressAt);
  assert.equal(o.completedAt, null);
  const startedAt = o.inProgressAt;
  o = await timed({ status: 'completed' });
  assert.equal(o.inProgressAt, startedAt);
  assert.ok(o.completedAt);
  const finishedAt = o.completedAt;
  o = await timed({ status: 'completed' });
  assert.equal(o.completedAt, finishedAt);
  o = await timed({ status: 'cancelled' });
  assert.equal(o.completedAt, finishedAt);
  o = await timed({ status: 'in_progress' });
  assert.deepEqual([o.inProgressAt, o.completedAt], [startedAt, null]);
  o = await timed({ status: 'placed' });
  assert.deepEqual([o.inProgressAt, o.completedAt], [null, null]);
  o = await timed({ status: 'completed' }); // never started
  assert.equal(o.inProgressAt, null);
  assert.ok(o.completedAt);
  await timed({ status: 'in_progress' });
  // Handed over on the spot, or placed already started.
  const spot = (await place({ customerName: 'Spot' })).data.sales[0];
  assert.deepEqual([spot.inProgressAt, spot.completedAt], [null, null]);
  await api('DELETE', `/events/${ev.id}/sales/${spot.id}`);
  const going = (await place({ status: 'in_progress' })).data.sales[0];
  assert.ok(going.inProgressAt);
  await api('DELETE', `/events/${ev.id}/sales/${going.id}`);

  // The events list tells the Orders page what's open.
  const listed = async () => (await api('GET', '/events')).data.find((e) => e.id === ev.id);
  assert.deepEqual([(await listed()).openOrders, (await listed()).recipeCount, (await listed()).sauceCount], [1, 1, 0]);
  assert.ok((await listed()).lastOrderAt);

  // Cancelled: still listed, out of every total; reopened, back in.
  r = await patch(order.id, { status: 'cancelled' });
  assert.equal(r.data.sales.length, 2);
  assert.deepEqual([r.data.totals.sales, r.data.totals.sold, r.data.totals.revenue, r.data.totals.byMethod.cash.amount, r.data.totals.byRecipe[0].sold], [1, 2, '8.00', '8.00', 2]);
  assert.equal(r.data.totals.byStatus.cancelled, 1);
  assert.equal((await listed()).openOrders, 0);
  r = await patch(order.id, { status: 'placed' });
  assert.deepEqual([r.data.totals.sales, r.data.totals.revenue], [2, '16.00']);
  await api('DELETE', `/events/${ev.id}`);
});

test('sales recorded during an event: lines, deals, giveaways, totals and undo', { skip }, async () => {
  const ev = (await api('POST', '/events', { name: 'Night market', date: '2026-11-03' })).data;
  await api('POST', `/events/${ev.id}/recipes`, { recipeId: ids.pasta, expectedServings: 20, salePrice: '4', discountAmount: '1', discountQty: '2' });
  const sell = (paymentMethod, items) => api('POST', `/events/${ev.id}/sales`, { paymentMethod, items });

  assert.deepEqual((await api('GET', `/events/${ev.id}/sales`)).data.totals.sold, 0);
  // 3 on the deal (one deal applies), paid by card.
  let r = await sell('card', [{ recipeId: ids.pasta, quantity: 3, dealUsed: true }]);
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.sales[0].items.map((i) => [i.name, i.quantity, i.unitPrice, i.deals, i.discount, i.amount]), [['Pasta', 3, '4.00', 1, '1.00', '11.00']]);
  assert.equal(r.data.sales[0].total, '11.00');
  // 1 for cash, 2 given away (no charge, no deal).
  await sell('cash', [{ recipeId: ids.pasta, quantity: 1 }]);
  r = await sell('free', [{ recipeId: ids.pasta, quantity: 2, dealUsed: true }]);
  const t = r.data.totals;
  assert.deepEqual([t.sales, t.sold, t.givenAway, t.deals, t.discounts, t.revenue], [3, 4, 2, 1, '1.00', '15.00']);
  assert.deepEqual([t.byMethod.card, t.byMethod.cash, t.byMethod.free, t.byMethod.venmo], [
    { sales: 1, amount: '11.00', fees: '0.00' }, { sales: 1, amount: '4.00', fees: '0.00' }, { sales: 1, amount: '0.00', fees: '0.00' }, { sales: 0, amount: '0.00', fees: '0.00' },
  ]);
  assert.deepEqual(t.byRecipe.map((x) => [x.name, x.sold, x.givenAway, x.revenue]), [['Pasta', 4, 2, '15.00']]);

  // A price change later doesn't rewrite what was sold.
  await api('POST', `/events/${ev.id}/recipes`, { recipeId: ids.pasta, expectedServings: 20, salePrice: '5' });
  await sell('venmo', [{ recipeId: ids.pasta, quantity: 1 }]);
  r = await api('GET', `/events/${ev.id}/sales`);
  assert.deepEqual(r.data.sales.map((s) => s.total), ['5.00', '0.00', '4.00', '11.00']);
  // Venmo's fee goes on top: charge (5 + 0.10) ÷ 0.981 = $5.20 (up to the cent), so 1.9% + $0.10 of it leaves $5.
  assert.deepEqual([r.data.sales[0].fee, r.data.totals.fees, r.data.totals.charged, r.data.totals.byMethod.venmo.fees], ['0.20', '0.20', '20.20', '0.20']);
  const app = await sell('cashapp', [{ recipeId: ids.pasta, quantity: 2 }]); // (10 + 0.15) ÷ 0.974 = $10.43
  assert.equal(app.data.sales[0].fee, '0.43');
  await api('DELETE', `/events/${ev.id}/sales/${app.data.sales[0].id}`);

  // Undo the newest; refusals.
  assert.equal((await api('DELETE', `/events/${ev.id}/sales/${r.data.sales[0].id}`)).status, 204);
  assert.equal((await api('GET', `/events/${ev.id}/sales`)).data.totals.revenue, '15.00');
  for (const [method, items, msg] of [
    ['bitcoin', [{ recipeId: ids.pasta, quantity: 1 }], /how it was paid/],
    ['cash', [], /at least one item/],
    ['cash', [{ recipeId: ids.pasta, quantity: 0 }], /quantity/],
    ['cash', [{ recipeId: ids.pasta, quantity: 1, dealUsed: true }], /needs 2 or more/],
    ['cash', [{ recipeId: ids.eggs, quantity: 1 }], /menu/],
  ]) {
    const bad = await sell(method, items);
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, msg);
  }
  assert.equal((await api('GET', '/events/00000000-0000-0000-0000-000000000000/sales')).status, 404);
  await api('DELETE', `/events/${ev.id}`);
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
  // Duplicating copies the plan, the set amount included, under a new name and date.
  const copy = await api('POST', `/events/${ev.id}/duplicate`, { name: 'Gala 2', date: '2027-01-02' });
  assert.equal(copy.status, 201);
  assert.deepEqual([copy.data.name, copy.data.date, copy.data.recipes.length], ['Gala 2', '2027-01-02', set.recipes.length]);
  assert.equal((await api('GET', `/events/${copy.data.id}/summary`)).data.totalCost, set.totalCost);
  const plain = (await api('POST', `/events/${ev.id}/duplicate`, {})).data;
  assert.deepEqual([plain.name, plain.date], ['Gala (copy)', ev.date]);
  assert.equal((await api('POST', `/events/${ids.eggs}/duplicate`, {})).status, 404);
  for (const e of [copy.data, plain]) await api('DELETE', `/events/${e.id}`);
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
  // Unmatched wording offers ingredients sharing its words; nothing is applied.
  const words = (await api('POST', '/ingredients/import-receipt', { items: [{ name: 'KS ORG BREAD FLOUR 25LB', price: 18 }] })).data.items[0];
  assert.equal(words.match, null);
  assert.deepEqual(words.candidates.map((c) => [c.name, c.words]), [['Flour', ['flour']]]);
  assert.equal(words.suggestion.id, ids.flour);
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
  assert.deepEqual(saved.data.purchases.map((p) => [p.ingredientName, p.receiptName, p.uom]), [['Flour', 'AP FLR 50#', 'lb'], ['Lemon juice', 'LMN JUICE', 'each']]);

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

test('an alias equal to the ingredient name is not stored, but a capitalization of it is', { skip }, async () => {
  const same = await api('POST', '/ingredients/purchase', { items: [{ ingredientId: ids.flour, alias: 'Flour', quantity: 1, totalCost: 1 }] });
  assert.deepEqual(same.data.aliasesSaved, []);
  const shouted = await api('POST', '/ingredients/purchase', { items: [{ ingredientId: ids.flour, alias: 'FLOUR', quantity: 1, totalCost: 1 }] });
  assert.deepEqual(shouted.data.aliasesSaved.map((a) => a.alias), ['FLOUR']);
  await pool.query("DELETE FROM ingredient_aliases WHERE alias = 'FLOUR'");
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

  // So can a missing or wrong vendor, without touching the pack size; blank clears it.
  const renamed = await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, { vendor: '  Food Mart ' });
  assert.deepEqual([renamed.data.vendor, renamed.data.packSize], ['Food Mart', '25.0000']);
  assert.ok((await api('GET', '/ingredients/vendors')).data.includes('Food Mart'));
  assert.equal((await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, { vendor: '' })).data.vendor, null);
  assert.equal((await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, { vendor: 'x'.repeat(121) })).status, 400);
  assert.equal((await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, {})).status, 400);
  await api('PATCH', `/ingredients/${ids.flour}/purchases/${mart.id}`, { vendor: 'Mart' });

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

test('renaming an ingredient keeps its old name as a receipt name', { skip }, async () => {
  const ing = (await api('POST', '/ingredients', { name: 'NATIONAL GINGER OASTE', uom: 'each' })).data;
  const aliases = async () => (await pool.query('SELECT alias FROM ingredient_aliases WHERE ingredient_id = $1 ORDER BY alias', [ing.id])).rows.map((r) => r.alias);
  await api('PATCH', `/ingredients/${ing.id}`, { name: 'National Ginger Oaste' }); // recasing is kept too
  assert.deepEqual(await aliases(), ['NATIONAL GINGER OASTE']);
  const renamed = await api('PATCH', `/ingredients/${ing.id}`, { name: 'Ginger Paste' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await aliases(), ['NATIONAL GINGER OASTE']); // the same name in other capitals: kept as first saved
  const found = (await api('POST', '/ingredients/import-receipt', { items: [{ name: 'NATIONAL GINGER OASTE', price: 3 }] })).data;
  assert.equal(found.items[0].match?.id, ing.id);
  // Renaming back drops the alias that now equals the name.
  await api('PATCH', `/ingredients/${ing.id}`, { name: 'National Ginger Oaste' });
  assert.deepEqual(await aliases(), ['Ginger Paste', 'NATIONAL GINGER OASTE']);
});

test('what one box weighs lets a sauce price an ingredient sold by the box', { skip }, async () => {
  const garlic = (await api('POST', '/ingredients', { name: 'Garlic box', uom: 'box', purchase: { quantity: 1, packSize: 1, totalCost: 5.99 } })).data;
  const sauce = (await api('POST', '/blends', { name: 'Garlic sauce', kind: 'sauce', container: '1 qt', items: [{ ingredientId: garlic.id, amount: 1, unit: 'oz' }] })).data;
  assert.equal(sauce.cost, '0.2264'); // until it's set, a box is taken as 750 g: 28.3495 / 750 × $5.99
  const set = await api('PATCH', `/ingredients/${garlic.id}`, { unitGrams: '85' });
  assert.equal(set.data.unitGrams, '85.0000');
  assert.equal((await api('GET', `/blends/${sauce.id}`)).data.cost, '1.9978');
  assert.equal((await api('PATCH', `/ingredients/${garlic.id}`, { unitGrams: '-1' })).status, 400);
  await api('PATCH', `/ingredients/${garlic.id}`, { unitGrams: '' });
  assert.equal((await api('GET', `/ingredients/${garlic.id}`)).data.unitGrams, null);
});

test('recipe amounts can exceed a pack and margins keep 6 decimals', { skip }, async () => {
  const r = await api('POST', '/recipes', { name: 'Double', baseServings: 1, targetMargin: '70.833333', lines: [{ ingredientId: ids.flour, amount: '120' }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.lines[0].amount, '120.0000');
  assert.equal(r.data.targetMargin, '70.833333');
  assert.equal((await api('POST', '/recipes', { name: 'Neg', baseServings: 1, lines: [{ ingredientId: ids.flour, amount: '-1' }] })).status, 400);
});

test('a menu price set by hand stays when costs change; the margin moves instead', { skip }, async () => {
  const butter = (await api('POST', '/ingredients', {
    name: 'Price-set butter', uom: 'lb', purchase: { date: '2026-05-01', vendor: 'Depot', quantity: 1, packSize: 1, unitCost: '4' },
  })).data;
  const body = { name: 'Toast', baseServings: 1, targetMargin: '60', targetPrice: '10', lines: [{ ingredientId: butter.id, amount: 1 }] };
  const r = (await api('POST', '/recipes', body)).data;
  assert.equal(r.targetPrice, '10.00');
  assert.deepEqual([r.costing.recommendedPrice, r.costing.targetMargin, r.costing.priceSet], ['10.00', '60', true]);

  // Butter goes up: the price holds, the margin drops. The gallery and events see the same.
  await api('POST', `/ingredients/${butter.id}/purchases`, { date: '2026-06-01', vendor: 'Depot', quantity: 1, packSize: 1, unitCost: '6' });
  const after = (await api('GET', `/recipes/${r.id}`)).data.costing;
  assert.deepEqual([after.recommendedPrice, after.targetMargin], ['10.00', '40']);
  const card = (await api('GET', '/recipes')).data.find((x) => x.id === r.id);
  assert.deepEqual([card.recommendedPrice, card.targetMargin, card.priceSet], ['10.00', '40', true]);

  // Let go, the price follows the cost at the saved margin again.
  const freed = (await api('PUT', `/recipes/${r.id}`, { ...body, targetPrice: '' })).data;
  assert.deepEqual([freed.targetPrice, freed.costing.recommendedPrice, freed.costing.priceSet], [null, '15.00', false]);
  assert.equal((await api('PUT', `/recipes/${r.id}`, { ...body, targetPrice: '0' })).status, 400);
  await api('DELETE', `/recipes/${r.id}`);
  await api('DELETE', `/ingredients/${butter.id}`);
});

test('spice blends: breakdown, use in a recipe in grams, and an event batch line', { skip }, async () => {
  const paprika = (await api('POST', '/ingredients', { name: 'Paprika', category: 'Spices', uom: 'oz', purchase: { quantity: 1, packSize: 4, totalCost: 8 } })).data;
  const blend = await api('POST', '/blends', {
    name: 'House rub', notes: 'For chicken', servings: 4,
    items: [{ ingredientId: paprika.id, amount: '2', unit: 'Tablespoons' }, { name: 'Salt', amount: '1 1/2', unit: 'tsp' }, { name: 'Cayenne', amount: '8', unit: 'pinch' }],
  });
  assert.equal(blend.status, 201);
  assert.equal(blend.data.totalGrams, '20.0000'); // 6 + 1.5 + 0.5 tsp at 2.5 g
  assert.equal(blend.data.servings, 4);
  assert.equal((await api('POST', '/blends', { name: 'X', servings: 0, items: [] })).status, 400);
  assert.deepEqual(blend.data.items.map((i) => [i.name, i.unit, i.share]), [['Paprika', 'tbsp', '75.0'], ['Salt', 'tsp', '18.8'], ['Cayenne', 'pinch', '6.3']]);
  assert.equal(blend.data.cost, '1.0582'); // 15 g of paprika at $2/oz
  assert.equal(blend.data.costComplete, false);

  const bad = await api('POST', '/blends', { name: 'X', items: [{ name: 'Salt', amount: 1, unit: 'handful' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /isn’t a unit/);

  const recipe = await api('POST', '/recipes', { name: 'Rubbed chicken', baseServings: 2, lines: [{ blendId: blend.data.id, amount: 10 }] });
  assert.equal(recipe.status, 201);
  const line = recipe.data.costing.lines[0];
  assert.deepEqual([line.name, line.uom, line.packSize, line.packPrice, line.unitPrice, line.baseCost], ['House rub', 'g', '20.0000', '1.0582', '0.0529', '0.5291']);

  const ev = (await api('POST', '/events', { name: 'Cookout', date: '2026-12-01', recipes: [{ recipeId: recipe.data.id, expectedServings: 6 }] })).data;
  const shop = (await api('GET', `/events/${ev.id}/summary`)).data.shoppingList;
  const rub = shop.find((l) => l.blendId === blend.data.id);
  assert.deepEqual([rub.amount, rub.packsToBuy, rub.leftover], ['30.0000', '2', '10.0000']); // 30 g in 20 g batches

  assert.equal((await api('DELETE', `/blends/${blend.data.id}`)).status, 409); // used by the recipe
  assert.equal((await api('DELETE', `/ingredients/${paprika.id}`)).status, 409); // used by the blend
  const list = (await api('GET', '/blends?q=house')).data;
  assert.deepEqual(list.map((b) => b.name), ['House rub']);
});

test('a sauce’s own sale price: the event’s default, under an event’s own, and what an order charges', { skip }, async () => {
  const body = { name: 'Priced sauce', kind: 'sauce', container: '1 qt', servingOz: '2', items: [{ name: 'Water', amount: '1', unit: 'cup' }] };
  const made = await api('POST', '/blends', { ...body, salePrice: '1.5' });
  assert.equal(made.status, 201);
  assert.equal(made.data.salePrice, '1.50');
  assert.equal((await api('POST', '/blends', { ...body, name: 'Bad', salePrice: '-1' })).status, 400);
  // Spice blends have no price of their own.
  assert.equal((await api('POST', '/blends', { name: 'Rub', items: [], salePrice: '9' })).data.salePrice, null);

  const date = '2026-11-05';
  const ev = (await api('POST', '/events', { name: 'Sauce night', date })).data;
  const sauces = (extra = {}) => saveEvent(ev.id, { name: 'Sauce night', date, sauces: [{ blendId: made.data.id, servings: 16, ...extra }] });
  await sauces();
  const priced = async () => (await api('GET', `/events/${ev.id}/summary`)).data.sauces[0];
  let s = await priced();
  assert.deepEqual([s.recommendedPrice, s.salePrice, s.revenue], ['1.50', '1.50', '24.00']); // no ingredient has a price, the sauce still does
  const sold = await api('POST', `/events/${ev.id}/sales`, { paymentMethod: 'cash', items: [{ blendId: made.data.id, quantity: 2 }] });
  assert.deepEqual([sold.data.sales[0].items[0].unitPrice, sold.data.sales[0].total], ['1.50', '3.00']);

  // The event's own price wins; left blank again, the sauce's returns.
  await sauces({ salePrice: '2' });
  s = await priced();
  assert.deepEqual([s.recommendedPrice, s.salePrice], ['1.50', '2.00']);
  await sauces({ salePrice: '' });
  assert.equal((await priced()).salePrice, '1.50');

  // Changing or clearing the sauce's price moves the event, not what was already sold.
  await api('PUT', `/blends/${made.data.id}`, { ...body, salePrice: '1.75' });
  assert.equal((await priced()).salePrice, '1.75');
  const cleared = await api('PUT', `/blends/${made.data.id}`, { ...body, salePrice: '' });
  assert.equal(cleared.data.salePrice, null);
  assert.equal((await api('GET', `/events/${ev.id}/sales`)).data.sales[0].items[0].unitPrice, '1.50');
  await api('DELETE', `/events/${ev.id}`);
});

test('sauces: a container batch in oz, bunches, and items in the ingredient’s own unit', { skip }, async () => {
  const herb = (await api('POST', '/ingredients', { name: 'Parsley', category: 'Produce', uom: 'bunch', purchase: { quantity: 1, packSize: 1, totalCost: 2 } })).data;
  const nuts = (await api('POST', '/ingredients', { name: 'Pine nuts', category: 'Pantry', uom: 'box', purchase: { quantity: 1, packSize: 1, totalCost: 10 } })).data;
  const sauce = await api('POST', '/blends', {
    name: 'Green sauce', kind: 'sauce', container: '1 qt', servings: 32,
    items: [{ ingredientId: herb.id, amount: '3', unit: 'bunches' }, { ingredientId: nuts.id, amount: '0.5', unit: 'Box' }, { name: 'Oil', amount: '1', unit: 'cup' }],
  });
  assert.equal(sauce.status, 201);
  assert.deepEqual([sauce.data.kind, sauce.data.container, sauce.data.uom, sauce.data.batchSize], ['sauce', '1 qt', 'oz', '32.0000']);
  assert.deepEqual(sauce.data.items.map((i) => i.unit), ['bunch', 'box', 'cup']);
  assert.equal(sauce.data.cost, '11.0000'); // 3 bunches at $2 + half a $10 box
  assert.equal((await api('POST', '/blends', { name: 'X', kind: 'sauce', container: '2 qt', items: [] })).status, 400);
  assert.equal((await api('POST', '/blends', { name: 'X', items: [{ ingredientId: herb.id, amount: 1, unit: 'box' }] })).status, 400); // not its unit

  // Servings given without a serving size are spread over the container: 32 in a quart are 1 oz each.
  assert.deepEqual([sauce.data.servingOz, sauce.data.servings], ['1.0000', 32]);
  assert.equal((await api('POST', '/blends', { name: 'X', kind: 'sauce', container: '1/4 qt', servingOz: 9, items: [] })).status, 400); // more than the container
  // Kind stays as created; the container can change.
  const put = await api('PUT', `/blends/${sauce.data.id}`, { ...sauce.data, kind: 'spice', container: '1/2 qt', servingOz: '0.5', items: sauce.data.items });
  assert.equal(put.status, 200);
  assert.deepEqual([put.data.kind, put.data.batchSize, put.data.servings], ['sauce', '16.0000', 32]);

  const recipe = await api('POST', '/recipes', { name: 'Sauced', baseServings: 1, lines: [{ blendId: sauce.data.id, amount: 4 }] });
  const line = recipe.data.costing.lines[0];
  assert.deepEqual([line.category, line.uom, line.packSize, line.baseCost], ['Sauce', 'oz', '16.0000', '2.7500']); // 4 of 16 oz

  // A sauce on an event: sold by the serving, made in whole containers whose ingredients join the shopping list.
  const ev = (await api('POST', '/events', {
    name: 'Market', date: '2026-12-02',
    recipes: [{ recipeId: recipe.data.id, expectedServings: 2 }],
    sauces: [{ blendId: sauce.data.id, servings: 40, container: '1/4 qt', salePrice: '0.75' }],
  })).data;
  assert.deepEqual(ev.sauces.map((b) => [b.name, b.servings, b.container, b.salePrice]), [['Green sauce', 40, '1/4 qt', '0.75']]);
  const sum = (await api('GET', `/events/${ev.id}/summary`)).data;
  const [green] = sum.sauces;
  // The 16 oz batch makes 32 servings for $11; a 1/4 qt holds 16, so 40 servings take 3 containers (1.5 batches).
  assert.deepEqual([green.servingsPerContainer, green.containers, green.costPerServing], ['16', 3, '0.3438']);
  assert.deepEqual([green.scaledCost, green.revenue, green.profit], ['16.5000', '30.00', '13.50']);
  const parsley = sum.shoppingList.find((l) => l.ingredientId === herb.id);
  assert.deepEqual([parsley.amount, parsley.recipes], ['4.5000', ['Green sauce']]); // 3 bunches × 1/2 × 3
  const oil = sum.shoppingList.find((l) => l.name === 'Oil');
  assert.deepEqual([oil.amount, oil.uom, oil.missingPrice, oil.ingredientId], ['1.5000', 'cup', true, null]);
  assert.equal(sum.shoppingList.find((l) => l.blendId === sauce.data.id).amount, '8.0000'); // the recipe's own use, as batches
  assert.equal(sum.totalCost, '22.0000'); // 2 × $2.75 + 3 × $5.50
  assert.equal(sum.revenue, (Number(sum.recipes[0].revenue) + 30).toFixed(2));

  const sale = await api('POST', `/events/${ev.id}/sales`, { paymentMethod: 'cash', items: [{ blendId: sauce.data.id, quantity: 2 }] });
  assert.equal(sale.status, 201);
  assert.deepEqual([sale.data.sales[0].items[0].name, sale.data.sales[0].total], ['Green sauce', '1.50']);
  assert.equal(sale.data.totals.byRecipe[0].blendId, sauce.data.id);
  const copied = (await api('POST', `/events/${ev.id}/duplicate`, {})).data; // the sauces, not the sales
  assert.deepEqual(copied.sauces.map((b) => b.blendId), [sauce.data.id]);
  assert.equal((await api('GET', `/events/${copied.id}/sales`)).data.sales.length, 0);
  await api('DELETE', `/events/${copied.id}`);

  assert.equal((await saveEvent(ev.id, { name: 'Market', date: '2026-12-02', sauces: [{ blendId: sauce.data.id, servings: 0 }] })).status, 400);
  assert.equal((await api('DELETE', `/blends/${sauce.data.id}`)).status, 409);
  // The ingredient drawer lists where parsley is used: through the sauce, in the Sauced recipe.
  const used = (await api('GET', `/ingredients/${herb.id}/history`)).data.usedIn;
  assert.deepEqual(used.recipes, []);
  const listed = (await api('GET', '/ingredients?q=Parsley')).data;
  assert.equal(listed.find((i) => i.id === herb.id).useCount, 2); // the sauce, and Sauced through it
  const found = (await api('GET', '/search?q=green')).data;
  assert.deepEqual([found.sauces.map((b) => b.name), found.blends, found.recipes], [['Green sauce'], [], []]);
  assert.deepEqual((await api('GET', '/search?q=50%25')).data.ingredients, []); // % is matched literally
  assert.deepEqual(used.blends.map((b) => [b.name, b.kind, b.recipes.map((r) => r.name)]), [['Green sauce', 'sauce', ['Sauced']]]);
  // Pricing left out keeps what the event had.
  const kept = await saveEvent(ev.id, { name: 'Market', date: '2026-12-02', sauces: [{ blendId: sauce.data.id, servings: 10 }] });
  assert.deepEqual([kept.data.sauces[0].salePrice, kept.data.sauces[0].container], ['0.75', '1/2 qt']); // no container: the sauce's own
  const cleared = await saveEvent(ev.id, { name: 'Market', date: '2026-12-02', sauces: [] });
  assert.deepEqual(cleared.data.sauces, []);
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

test('a database listing migrations this version doesn’t have is refused', { skip }, async () => {
  const { migrate } = await import('../src/migrate.js');
  await pool.query("INSERT INTO schema_migrations (name) VALUES ('011_test_data.sql')");
  await assert.rejects(migrate({ log: () => {} }), /older version of food\.db \(it lists 011_test_data\.sql\)/);
  await pool.query("DELETE FROM schema_migrations WHERE name = '011_test_data.sql'");
});

test('a migration since combined into the schema is dropped, not refused', { skip }, async () => {
  const { migrate } = await import('../src/migrate.js');
  await pool.query("INSERT INTO schema_migrations (name) VALUES ('002_sauce_serving_oz.sql'), ('003_recipe_target_price.sql')");
  await migrate({ log: () => {} });
  const { rows } = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  assert.deepEqual(rows.map((r) => r.name), ['001_schema.sql', '002_event_orders.sql', '003_order_timing.sql', '004_sauce_sale_price.sql', '005_event_serving_size.sql', '006_event_version.sql']);
});

test('event versions: a save from an old copy of the plan is refused and changes nothing', { skip }, async () => {
  const taco = (await api('POST', '/recipes', { name: 'Version taco', baseServings: 10, lines: [{ ingredientId: ids.flour, amount: 1 }] })).data;
  const ev = (await api('POST', '/events', { name: 'Versions', date: '2026-12-03', recipes: [{ recipeId: taco.id, expectedServings: 30 }] })).data;
  assert.equal(ev.version, 1);
  const base = { name: 'Versions', date: '2026-12-03' };

  // One window prices the taco.
  const priced = await api('PUT', `/events/${ev.id}`, { ...base, version: 1, recipes: [{ recipeId: taco.id, expectedServings: 10, salePrice: '14', servingSize: '3' }] });
  assert.equal(priced.status, 200);
  assert.equal(priced.data.version, 2);

  // A window still holding version 1 saves its blank pricing: refused, and the prices stay.
  const stale = await api('PUT', `/events/${ev.id}`, { ...base, version: 1, recipes: [{ recipeId: taco.id, expectedServings: 30, salePrice: '', servingSize: '' }] });
  assert.equal(stale.status, 409);
  const kept = (await api('GET', `/events/${ev.id}`)).data;
  assert.equal(kept.version, 2);
  assert.equal(kept.recipes[0].expectedServings, 10);
  assert.equal(kept.recipes[0].salePrice, '14.00');
  assert.equal(kept.recipes[0].servingSize, '3.0000');

  // A page from before versions sends none at all: refused too, not treated as current.
  assert.equal((await api('PUT', `/events/${ev.id}`, { ...base, recipes: [] })).status, 409);
  assert.equal((await api('GET', `/events/${ev.id}`)).data.recipes.length, 1);

  // Adding from the gallery moves the version, so a window open on the plan finds out.
  const added = await api('POST', `/events/${ev.id}/recipes`, { recipeId: taco.id, expectedServings: 12 });
  assert.equal(added.data.version, 3);
  assert.equal((await api('PUT', `/events/${ev.id}`, { ...base, version: 2, recipes: [] })).status, 409);

  // A bad version and a missing event still answer as such.
  assert.equal((await api('PUT', `/events/${ev.id}`, { ...base, version: 'x' })).status, 400);
  assert.equal((await api('PUT', '/events/00000000-0000-0000-0000-000000000000', { ...base, version: 1 })).status, 404);
});

test('dashboard: upcoming events in date order, figures leave out test data and cancelled orders', { skip }, async () => {
  const today = '2031-06-15';
  const get = async (headers) => (await api('GET', `/dashboard?today=${today}`, undefined, headers)).data;
  const before = await get();
  const r = (await api('POST', '/recipes', { name: 'Dash taco', baseServings: 10, lines: [{ ingredientId: ids.flour, amount: 1 }] })).data;
  const event = (name, on, headers) => api('POST', '/events', { name, date: on, recipes: [{ recipeId: r.id, expectedServings: 8 }] }, headers);
  const later = (await event('Later', '2031-07-01')).data;
  const soon = (await event('Today', today)).data;
  const past = (await event('Last week', '2031-06-08')).data;
  await event('Old', '2031-01-01');
  await event('Pretend', '2031-06-16', { 'x-test-data': '1' });

  const sell = (status) => api('POST', `/events/${past.id}/sales`, { paymentMethod: 'cash', status, items: [{ recipeId: r.id, quantity: 2 }] });
  const kept = (await sell('completed')).data.sales[0];
  await sell('cancelled');
  const lineAmount = Number(kept.amount ?? kept.items?.[0]?.amount);
  await api('POST', '/ingredients/purchase', { items: [{ name: 'Dash salt', uom: 'lb', date: '2031-06-10', quantity: 2, packSize: 1, unitCost: '3' }] });
  await api('POST', '/ingredients/purchase', { items: [{ name: 'Dash pepper', uom: 'lb', date: '2031-01-10', quantity: 1, packSize: 1, unitCost: '9' }] });

  const d = await get();
  assert.deepEqual(d.upcomingEvents.map((e) => e.id).slice(0, 2), [soon.id, later.id]);
  assert.equal(d.upcomingEvents[0].recipeCount, 1);
  assert.equal(d.upcomingEvents[0].totalServings, 8);
  assert.equal(d.upcoming, before.upcoming + 2);
  assert.equal(d.events, before.events + 4);
  assert.equal(d.recipes, before.recipes + 1);
  assert.ok(Number(d.averageMargin) > 0);
  assert.equal(d.lastEvent.id, past.id);
  assert.equal(d.lastEvent.orders, 1);
  assert.equal(Number(d.lastEvent.revenue), lineAmount);
  assert.equal(d.sales.orders, before.sales.orders + 1);
  assert.equal(Number(d.sales.revenue), Number(before.sales.revenue) + lineAmount);
  assert.equal(Number(d.spend.spent), Number(before.spend.spent) + 6); // the January purchase is too old
  assert.equal(d.spend.trips, before.spend.trips + 1);
  assert.equal(d.ingredients, before.ingredients + 2);

  // In test mode, test data counts too.
  const inTest = await get({ 'x-test-data': '1' });
  assert.equal(inTest.upcoming, d.upcoming + 1);
  assert.equal(inTest.upcomingEvents.find((e) => e.name === 'Pretend').isTest, true);

  assert.equal((await api('GET', '/dashboard?today=nope')).status, 400);
});

test('event results: set with the event, kept when a save leaves them out, cleared when blank', { skip }, async () => {
  const ev = (await api('POST', '/events', { name: 'Gala', date: '2026-09-01', guestCount: 40 })).data;
  assert.equal(ev.actualGuests, null);
  const base = { name: 'Gala', date: '2026-09-01', guestCount: 40 };
  const saved = await saveEvent(ev.id, { ...base, actualGuests: 38, actualRevenue: '1520.5', actualCost: '610', notes: 'Ran out of bread' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.data.actualGuests, saved.data.actualRevenue, saved.data.actualCost, saved.data.notes], [38, '1520.50', '610.00', 'Ran out of bread']);
  const renamed = (await saveEvent(ev.id, { ...base, name: 'Autumn gala' })).data; // no results in the body
  assert.deepEqual([renamed.name, renamed.actualGuests, renamed.actualRevenue], ['Autumn gala', 38, '1520.50']);
  const cleared = (await saveEvent(ev.id, { ...base, actualCost: '' })).data;
  assert.equal(cleared.actualCost, null);
  assert.equal(cleared.actualRevenue, '1520.50');
  assert.equal((await saveEvent(ev.id, { ...base, actualGuests: -1 })).status, 400);
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

test('duplicate suggestions, "not the same", and merging with a conversion', { skip }, async () => {
  const purchase = (date, packSize, unitCost) => ({ date, vendor: 'Depot', quantity: 1, packSize, unitCost });
  const kept = (await api('POST', '/ingredients', { name: 'Granulated sugar', category: 'Dry goods', uom: 'lb', purchase: purchase('2026-07-26', 25, '17.40') })).data;
  const sugar = (await api('POST', '/ingredients', { name: 'Sugar', uom: 'box', purchase: purchase('2026-10-17', 1, '1.245') })).data;
  await pool.query(`INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ($1, 'DOMINO SUGAR')`, [sugar.id]);

  const pairFor = (list) => list.find((p) => p.merge.id === sugar.id || p.keep.id === sugar.id);
  const pair = pairFor((await api('GET', '/ingredients/duplicates')).data);
  assert.deepEqual([pair.merge.name, pair.keep.name, pair.kind], ['Sugar', 'Granulated sugar', 'name']); // lb is a real unit
  assert.equal(pair.reason, 'The names differ only by “granulated”');
  assert.equal(pair.keep.purchaseCount, 1);
  assert.equal((await api('POST', '/ingredients/duplicates/dismiss', { ids: [sugar.id, sugar.id] })).status, 400);
  assert.equal((await api('POST', '/ingredients/duplicates/dismiss', { ids: [kept.id, sugar.id] })).status, 204);
  assert.equal((await api('POST', '/ingredients/duplicates/dismiss', { ids: [sugar.id, kept.id] })).status, 204); // once per pair
  assert.equal(pairFor((await api('GET', '/ingredients/duplicates')).data), undefined);

  // A recipe with both, one with just Sugar, a blend, and a hand-set event amount.
  const cookies = (await api('POST', '/recipes', { name: 'Sugar cookies', baseServings: 10, lines: [{ ingredientId: sugar.id, amount: '0.5' }, { ingredientId: kept.id, amount: 1 }] })).data;
  const lemonade = (await api('POST', '/recipes', { name: 'Lemonade', baseServings: 4, lines: [{ ingredientId: sugar.id, amount: '0.2' }] })).data;
  const rub = (await api('POST', '/blends', { name: 'Sweet rub', items: [{ ingredientId: sugar.id, amount: 1, unit: 'tsp' }] })).data;
  const ev = (await api('POST', '/events', { name: 'Bake sale', date: '2026-11-20', recipes: [{ recipeId: lemonade.id, expectedServings: 8 }] })).data;
  assert.equal((await api('PUT', `/events/${ev.id}/amounts/${sugar.id}`, { amount: 2 })).status, 204);

  const merge = (body) => api('POST', `/ingredients/${sugar.id}/merge`, { intoId: kept.id, ...body });
  const noFactor = await merge({});
  assert.equal(noFactor.status, 400);
  assert.match(noFactor.data.error, /How many lb is 1 box of Sugar/);
  assert.equal((await merge({ factor: 0 })).status, 400);
  assert.equal((await api('POST', `/ingredients/${kept.id}/merge`, { intoId: kept.id })).status, 400);
  const labor = (await api('GET', '/ingredients?q=Labor')).data.find((i) => i.name === 'Labor');
  assert.match((await api('POST', `/ingredients/${kept.id}/merge`, { intoId: labor.id })).data.error, /Labor/);

  // 1 box = 1.5 lb. The preview changes nothing.
  const preview = await merge({ factor: '1.5', dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.dryRun, true);
  assert.equal(preview.data.purchasesMoved, 1);
  assert.deepEqual([preview.data.priceBefore, preview.data.priceAfter], ['0.6960', '0.8300']); // the box is the newest price: $1.245 / 1.5 lb
  const c = preview.data.recipes.find((r) => r.id === cookies.id);
  assert.deepEqual(c.lines, [{ from: '0.5000', to: '0.7500' }]);
  assert.equal(c.combined, true);
  assert.deepEqual([c.costPerServingBefore, c.costPerServingAfter], ['0.1319', '0.1453']); // (0.6225 + 0.696) / 10 → 1.75 lb × 0.83 / 10
  const l = preview.data.recipes.find((r) => r.id === lemonade.id);
  assert.deepEqual([l.costPerServingBefore, l.costPerServingAfter], ['0.0623', '0.0623']); // converted, so the same cost
  assert.deepEqual([preview.data.blends, preview.data.events, preview.data.aliasesAdded], [['Sweet rub'], ['Bake sale'], ['Sugar']]);
  assert.equal((await api('GET', `/ingredients/${sugar.id}`)).status, 200);

  const done = await merge({ factor: '1.5' });
  assert.equal(done.status, 200);
  assert.equal(done.data.dryRun, false);
  assert.equal((await api('GET', `/ingredients/${sugar.id}`)).status, 404);
  const hist = (await api('GET', `/ingredients/${kept.id}/history`)).data;
  assert.deepEqual(hist.purchases.map((p) => [p.packSize, p.unitCost]), [['1.5000', '1.2450'], ['25.0000', '17.4000']]);
  assert.deepEqual(hist.aliases.map((a) => a.alias), ['DOMINO SUGAR', 'Sugar']);
  assert.equal(hist.ingredient.category, 'Dry goods');
  const cookieLines = (await api('GET', `/recipes/${cookies.id}`)).data.lines;
  assert.deepEqual(cookieLines.map((x) => [x.ingredientId, x.amount]), [[kept.id, '1.7500']]); // 1 lb + 0.5 box × 1.5
  assert.equal((await api('GET', `/recipes/${lemonade.id}`)).data.lines[0].amount, '0.3000');
  assert.equal((await api('GET', `/blends/${rub.id}`)).data.items[0].ingredientId, kept.id);
  const { rows } = await pool.query('SELECT amount FROM event_amounts WHERE event_id = $1', [ev.id]);
  assert.deepEqual(rows, [{ amount: '3.0000' }]);
  const receipt = (await api('POST', '/ingredients/import-receipt', { items: [{ name: 'Sugar', quantity: 1, price: '1.99' }] })).data;
  assert.equal(receipt.items[0].match.id, kept.id); // its old name now resolves
});

test('merging converts between weights by itself, and real data wins over test data', { skip }, async () => {
  const test = { 'x-test-data': '1' };
  const cocoa = (await api('POST', '/ingredients', { name: 'Cocoa powder', uom: 'lb', purchase: { date: '2026-09-01', quantity: 1, packSize: 5, unitCost: '20' } }, test)).data;
  const small = (await api('POST', '/ingredients', { name: 'Cocoa powder 8 oz', category: 'Baking', uom: 'oz', purchase: { date: '2026-01-01', quantity: 1, packSize: 8, unitCost: '4' } })).data;
  const brownies = (await api('POST', '/recipes', { name: 'Brownies', baseServings: 12, lines: [{ ingredientId: small.id, amount: 4 }] })).data;
  const { data } = await api('POST', `/ingredients/${small.id}/merge`, { intoId: cocoa.id });
  assert.equal(data.factor, '0.0625');
  assert.equal(data.kept.isTest, false);
  assert.equal(data.kept.category, 'Baking'); // filled in from the merged one
  assert.equal(data.priceAfter, '4.0000'); // the 5 lb purchase is newer than the 8 oz one
  assert.equal((await api('GET', `/recipes/${brownies.id}`)).data.lines[0].amount, '0.2500');
  const packs = (await api('GET', `/ingredients/${cocoa.id}/history`)).data.purchases.map((p) => p.packSize);
  assert.deepEqual(packs, ['5.0000', '0.5000']);
});

test('a generic receipt name is only suggested, never matched automatically', { skip }, async () => {
  const make = async (name) => (await api('POST', '/ingredients/purchase', { items: [{ name, uom: 'lb', quantity: 1, totalCost: 1 }] })).data.purchases[0].ingredientId;
  const leg = await make('Chicken leg');
  const chickpea = await make('Chickpeas dried');
  const names = (item) => item.choices?.map((c) => c.name);

  // A store that prints "Grocery" on every line. Before anything is saved there's nothing to offer.
  const fd = new FormData();
  fd.append('vendor', 'Corner Market');
  fd.append('source', JSON.stringify({ items: [{ name: 'Grocery', price: 4.34 }, { name: 'Grocery', price: 1.99 }, { name: 'Grocery', price: 5.11 }] }));
  const receipt = (await api('POST', '/receipts', fd)).data;
  assert.deepEqual(receipt.pendingLines.map((l) => [l.match, l.choices]), [[null, null], [null, null], [null, null]]);

  // The first line saved alone remembers "Grocery" → Chicken leg; the rest of the receipt then only suggests it,
  // because the name is on several of its lines.
  await api('POST', '/ingredients/purchase', { receiptId: receipt.id, items: [{ receiptLine: 0, ingredientId: leg, alias: 'Grocery', quantity: 1, totalCost: 4.34 }] });
  let detail = (await api('GET', `/receipts/${receipt.id}`)).data;
  assert.deepEqual(detail.pendingLines.map((l) => [l.match, names(l), l.ambiguous]), [[null, ['Chicken leg'], 'receipt'], [null, ['Chicken leg'], 'receipt']]);

  // Saved as kept rows (as the review shows them: a new "Grocery"), they don't go through the alias.
  const kept = await api('POST', '/ingredients/purchase', { receiptId: receipt.id, items: [{ receiptLine: 1, name: 'Grocery', skipAlias: true, quantity: 1, totalCost: 1.99 }] });
  assert.deepEqual(kept.data.createdIngredients.map((c) => c.name), ['Grocery']);
  await api('DELETE', `/ingredients/${kept.data.createdIngredients[0].id}`);

  // Once one receipt has saved "Grocery" as two ingredients, a single "Grocery" line is only suggested too.
  await api('POST', '/ingredients/purchase', { receiptId: receipt.id, items: [{ receiptLine: 2, ingredientId: chickpea, alias: 'Grocery', quantity: 1, totalCost: 5.11 }] });
  const next = (await api('POST', '/ingredients/import-receipt', { items: [{ name: 'GROCERY', price: 3 }] })).data.items[0];
  assert.equal(next.match, null);
  assert.equal(next.ambiguous, 'history');
  assert.deepEqual(next.choices.map((c) => [c.name, c.times]), [['Chicken leg', 1], ['Chickpeas dried', 1]]);
  assert.equal(next.suggestion.name, 'Chicken leg');
  const created = await api('POST', '/ingredients/purchase', { items: [{ name: 'Grocery', quantity: 1, totalCost: 3 }] });
  assert.deepEqual(created.data.createdIngredients.map((c) => c.name), ['Grocery']);
  await api('DELETE', `/ingredients/${created.data.createdIngredients[0].id}`);

  // The drawer marks it (the alias now points at the last choice).
  const aliases = (await api('GET', `/ingredients/${chickpea}/history`)).data.aliases;
  assert.deepEqual(aliases.map((a) => [a.alias, a.ambiguous]), [['Grocery', true]]);

  // An ordinary receipt name still matches by itself, unless it's on several lines of the new receipt.
  await api('POST', '/ingredients/purchase', { items: [{ ingredientId: leg, alias: 'CHK LEG', quantity: 1, totalCost: 4 }] });
  const one = (await api('POST', '/ingredients/import-receipt', { items: [{ name: 'CHK LEG', price: 4 }] })).data.items[0];
  assert.deepEqual([one.match?.name, one.match?.via, one.choices], ['Chicken leg', 'alias', null]);
  const two = (await api('POST', '/ingredients/import-receipt', { items: [{ name: 'CHK LEG', price: 4 }, { name: 'CHK LEG', price: 6 }] })).data.items;
  assert.deepEqual(two.map((i) => [i.match, names(i), i.ambiguous]), [[null, ['Chicken leg'], 'receipt'], [null, ['Chicken leg'], 'receipt']]);
  // Identical lines are combined into one first, so they still match.
  const same = (await api('POST', '/ingredients/import-receipt', { items: [{ name: 'CHK LEG', price: 4 }, { name: 'CHK LEG', price: 4 }] })).data.items;
  assert.deepEqual(same.map((i) => i.match?.name), ['Chicken leg']);
});

test('several lines of one ingredient on one receipt are one averaged price, not a price change', { skip }, async () => {
  const first = await api('POST', '/ingredients/purchase', {
    vendor: 'Butcher',
    items: [{ name: 'Chicken thighs', uom: 'lb', date: '2026-03-01', quantity: 1, packSize: 2, totalCost: '8' }], // $4.00/lb
  });
  const thighs = first.data.purchases[0].ingredientId;

  // Two packs of different weights, $4.00/lb and $4.50/lb: $16.85 for 4 lb is $4.2125/lb.
  const fd = new FormData();
  fd.append('vendor', 'Butcher');
  fd.append('source', JSON.stringify({ items: [{ name: 'CHKN THIGH', price: 9.2 }, { name: 'CHKN THIGH', price: 7.65 }] }));
  const receipt = (await api('POST', '/receipts', fd)).data;
  const saved = await api('POST', '/ingredients/purchase', {
    receiptId: receipt.id,
    vendor: 'Butcher',
    items: [
      { receiptLine: 0, ingredientId: thighs, date: '2026-03-08', quantity: 1, packSize: 2.3, totalCost: '9.20' },
      { receiptLine: 1, ingredientId: thighs, date: '2026-03-08', quantity: 1, packSize: 1.7, totalCost: '7.65' },
    ],
  });
  assert.equal(saved.status, 201);

  const hist = (await api('GET', `/ingredients/${thighs}/history`)).data;
  assert.equal(hist.ingredient.latestUnitPrice, '4.2125');
  assert.equal(hist.ingredient.latestPackSize, '2.0000'); // the average pack, so a shopping list buys whole packs
  assert.equal(hist.ingredient.latestPackPrice, '8.4250');
  assert.equal(hist.ingredient.latestLines, 2);

  assert.equal(hist.purchases.length, 3);
  assert.deepEqual(hist.trips.map((t) => [t.lines, t.unitPrice, t.changePercent, t.priceHike]), [[2, '4.2125', '5.3', false], [1, '4.0000', null, false]]);
  assert.equal(hist.trips[0].receiptId, receipt.id);
  assert.equal(hist.trips[0].totalCost, '16.8500');
  // The Ingredients list counts every pack bought: three, though two share a receipt.
  assert.equal((await api('GET', '/ingredients')).data.find((i) => i.id === thighs).purchaseCount, 3);
  // The header search finds the receipt by its vendor.
  const found = (await api('GET', '/search?q=butch')).data;
  assert.deepEqual(found.purchases.map((r) => [r.id, r.lines]), [[receipt.id, 2]]);
  // Within the receipt, the $4.50/lb pack isn't a 12.5% hike over the $4.00/lb one.
  assert.deepEqual(hist.purchases.slice(0, 2).map((p) => [p.tripId, p.tripLines, p.changePercent, p.priceHike]),
    [[receipt.id, 2, null, false], [receipt.id, 2, null, false]]);
  assert.deepEqual(hist.vendors.map((v) => [v.vendor, v.purchases, v.latestUnitPrice]), [['Butcher', 2, '4.2125']]);

  // Recipes cost at the average.
  const calc = await api('POST', '/recipes/calculate', { baseServings: 1, lines: [{ ingredientId: thighs, amount: 1 }] });
  assert.equal(calc.data.lines[0].unitPrice, '4.2125');

  // Removing one line leaves the other as the latest price.
  await api('DELETE', `/ingredients/${thighs}/purchases/${hist.purchases[1].id}`);
  const after = (await api('GET', `/ingredients/${thighs}/history`)).data;
  assert.equal(after.ingredient.latestUnitPrice, '4.5000');
  assert.equal(after.ingredient.latestLines, 1);
  assert.equal(after.trips[0].changePercent, '12.5');
});
