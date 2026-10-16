// Integration tests for recipe/receipt images. Same TEST_DATABASE_URL contract as
// api.test.js (schema is dropped); files go to a throwaway UPLOAD_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL is not set';

let server, base, pool, dir;

// 1×1 PNG and a minimal JPEG header (content isn't decoded, only sniffed).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]);

before(async () => {
  if (skip) return;
  dir = await mkdtemp(path.join(tmpdir(), 'kitchen-images-'));
  process.env.UPLOAD_DIR = dir;
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
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function api(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

function form(files, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [name, buf, type] of files) fd.append('images', new Blob([buf], { type }), name);
  return fd;
}

const filesOnDisk = async () => (await readdir(dir)).sort();

test('recipe images: upload, serve, cover order, duplicate, delete', { skip }, async () => {
  const recipe = (await api('POST', '/recipes', { name: 'Tart', baseServings: 8 })).data;

  const up = await api('POST', `/recipes/${recipe.id}/images`, form([['a.png', PNG, 'image/png'], ['b.jpg', JPEG, 'image/jpeg']]));
  assert.equal(up.status, 201);
  assert.deepEqual(up.data.map((i) => i.originalName), ['a.png', 'b.jpg']);
  assert.equal((await filesOnDisk()).length, 2);

  const img = await fetch(base.replace('/api', '') + up.data[0].url);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  // Make the second image the cover.
  const order = await api('PUT', `/recipes/${recipe.id}/images/order`, { imageIds: [up.data[1].id, up.data[0].id] });
  assert.deepEqual(order.data.map((i) => i.originalName), ['b.jpg', 'a.png']);
  const gallery = await api('GET', '/recipes');
  assert.equal(gallery.data[0].coverImage.originalName, 'b.jpg');
  assert.equal(gallery.data[0].imageCount, 2);

  const bad = await api('PUT', `/recipes/${recipe.id}/images/order`, { imageIds: [up.data[0].id] });
  assert.equal(bad.status, 400);

  const copy = (await api('POST', `/recipes/${recipe.id}/duplicate`)).data;
  assert.equal(copy.images.length, 2);
  assert.notEqual(copy.images[0].id, up.data[1].id);
  assert.equal((await filesOnDisk()).length, 4);

  assert.equal((await api('DELETE', `/images/${up.data[0].id}`)).status, 204);
  assert.equal((await filesOnDisk()).length, 3);

  assert.equal((await api('DELETE', `/recipes/${copy.id}`)).status, 204);
  assert.equal((await filesOnDisk()).length, 1);
  assert.equal((await api('GET', `/recipes/${recipe.id}`)).data.images.length, 1);
});

test('non-images and HEIC are rejected without writing files', { skip }, async () => {
  const recipe = (await api('POST', '/recipes', { name: 'Soup', baseServings: 4 })).data;
  const before = await filesOnDisk();
  const txt = await api('POST', `/recipes/${recipe.id}/images`, form([['notes.png', Buffer.from('hello'), 'image/png']]));
  assert.equal(txt.status, 400);
  assert.match(txt.data.error, /isn’t a JPEG, PNG/);
  const heic = await api('POST', `/recipes/${recipe.id}/images`, form([['IMG_1.heic', HEIC, 'image/heic']]));
  assert.equal(heic.status, 400);
  assert.match(heic.data.error, /HEIC/);
  assert.deepEqual(await filesOnDisk(), before);
});

test('receipts store photos and source JSON, and link their purchases', { skip }, async () => {
  const source = { store: { name: 'Weis' }, items: [{ name: 'Basil', price: 2 }] };
  const created = await api('POST', '/receipts', form([['r1.jpg', JPEG, 'image/jpeg'], ['r2.jpg', JPEG, 'image/jpeg']], {
    vendor: 'Weis', date: '2026-10-01', source: JSON.stringify(source),
  }));
  assert.equal(created.status, 201);
  assert.equal(created.data.images.length, 2);
  assert.deepEqual(created.data.source, source);
  const receiptId = created.data.id;

  const saved = await api('POST', '/ingredients/purchase', { receiptId, vendor: 'Weis', date: '2026-10-01', items: [{ name: 'Basil', quantity: 1, totalCost: 2 }] });
  assert.equal(saved.data.purchases[0].receiptId, receiptId);

  const detail = (await api('GET', `/receipts/${receiptId}`)).data;
  assert.deepEqual(detail.purchases.map((p) => p.ingredientName), ['Basil']);
  assert.equal(detail.lineCount, 1);
  assert.equal(detail.savedTotal, '2.0000');

  const history = (await api('GET', `/ingredients/${saved.data.purchases[0].ingredientId}/history`)).data;
  assert.equal(history.purchases[0].receiptId, receiptId);

  const list = (await api('GET', '/receipts')).data;
  assert.equal(list[0].images.length, 2);

  const filesBefore = (await filesOnDisk()).length;
  assert.equal((await api('DELETE', `/receipts/${receiptId}`)).status, 204);
  assert.equal((await filesOnDisk()).length, filesBefore - 2);
  // The purchase survives as price history, unlinked.
  const after = (await api('GET', `/ingredients/${saved.data.purchases[0].ingredientId}/history`)).data;
  assert.equal(after.purchases[0].receiptId, null);

  const missing = await api('POST', '/ingredients/purchase', { receiptId, items: [{ name: 'Basil', quantity: 1, totalCost: 2 }] });
  assert.equal(missing.status, 404);
});

test('receipt lines skipped during review can be saved later', { skip }, async () => {
  const source = { vendor: 'Weis', items: [{ name: 'FLR AP', price: 20 }, { name: 'LMNS', quantity: 2, unit_price: 1.5 }, { name: 'DONATION', price: 1 }] };
  const receipt = (await api('POST', '/receipts', form([], { vendor: 'Weis', date: '2026-10-02', source: JSON.stringify(source) }))).data;
  assert.equal(receipt.pendingLines.length, 3);
  assert.deepEqual(receipt.pendingLines.map((l) => [l.line, l.name, l.quantity, l.totalCost]), [[0, 'FLR AP', '1', '20'], [1, 'LMNS', '2', '3'], [2, 'DONATION', '1', '1']]);

  // Review screen saves only line 0 (renamed → alias).
  const first = await api('POST', '/ingredients/purchase', {
    receiptId: receipt.id, vendor: 'Weis', date: '2026-10-02',
    items: [{ receiptLine: 0, name: 'Flour, all-purpose', alias: 'FLR AP', quantity: 1, totalCost: 20 }],
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.purchases[0].receiptLine, 0);

  let detail = (await api('GET', `/receipts/${receipt.id}`)).data;
  assert.deepEqual(detail.pendingLines.map((l) => l.name), ['LMNS', 'DONATION']);
  assert.equal(detail.pendingCount, 2);

  // Later, from the receipt page: save line 1 adjusted, as a new ingredient with an alias.
  const later = await api('POST', '/ingredients/purchase', {
    receiptId: receipt.id, vendor: 'Weis', date: '2026-10-02',
    items: [{ receiptLine: 1, name: 'Lemons', alias: 'LMNS', category: 'Produce', quantity: 2, uom: 'each', unitCost: '1.40' }],
  });
  assert.equal(later.status, 201);
  detail = (await api('GET', `/receipts/${receipt.id}`)).data;
  assert.deepEqual(detail.pendingLines.map((l) => l.name), ['DONATION']);
  assert.equal(detail.purchases.length, 2);
  assert.equal((await api('GET', '/receipts')).data.find((r) => r.id === receipt.id).pendingCount, 1);

  // Saving the same line twice is refused; an unknown line is a 404.
  const again = await api('POST', '/ingredients/purchase', { receiptId: receipt.id, items: [{ receiptLine: 1, name: 'Lemons', quantity: 1, totalCost: 1 }] });
  assert.equal(again.status, 409);
  const unknown = await api('POST', '/ingredients/purchase', { receiptId: receipt.id, items: [{ receiptLine: 9, name: 'X', quantity: 1, totalCost: 1 }] });
  assert.equal(unknown.status, 404);
  const noReceipt = await api('POST', '/ingredients/purchase', { items: [{ receiptLine: 0, name: 'X', quantity: 1, totalCost: 1 }] });
  assert.equal(noReceipt.status, 400);

  // Deleting the purchase puts its line back to unsaved; the alias now resolves it.
  const lemon = later.data.purchases[0];
  assert.equal((await api('DELETE', `/ingredients/${lemon.ingredientId}/purchases/${lemon.id}`)).status, 204);
  detail = (await api('GET', `/receipts/${receipt.id}`)).data;
  assert.deepEqual(detail.pendingLines.map((l) => [l.name, l.match?.name, l.match?.via]), [['LMNS', 'Lemons', 'alias'], ['DONATION', undefined, undefined]]);
});

test('a receipt uploaded with photos in test mode is test data', { skip }, async () => {
  const created = await api('POST', '/receipts', form([['r.jpg', JPEG, 'image/jpeg']], { vendor: 'Test store', date: '2026-10-03', source: '{}' }), { 'x-test-data': '1' });
  assert.equal(created.status, 201);
  assert.equal((await api('GET', '/receipts')).data.find((r) => r.id === created.data.id).isTest, true);
  const real = await api('POST', '/receipts', form([['r.jpg', JPEG, 'image/jpeg']], { vendor: 'Real store', date: '2026-10-03', source: '{}' }));
  assert.equal((await api('GET', '/receipts')).data.find((r) => r.id === real.data.id).isTest, false);
});
