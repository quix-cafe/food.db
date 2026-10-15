// Backup/restore round trip. Same TEST_DATABASE_URL contract as api.test.js (schema is
// dropped); uploads and snapshots go to throwaway directories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import tarStream from 'tar-stream';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL is not set';

let server, base, pool, dir;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

before(async () => {
  if (skip) return;
  dir = await mkdtemp(path.join(tmpdir(), 'kitchen-backup-test-'));
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  process.env.BACKUP_DIR = path.join(dir, 'backups');
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

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

const fileForm = (field, buf, name, type) => {
  const fd = new FormData();
  fd.append(field, new Blob([buf], { type }), name);
  return fd;
};
const uploads = async () => (await readdir(process.env.UPLOAD_DIR)).sort();
const inspect = (buf) => api('POST', '/backup/inspect', fileForm('file', buf, 'backup.tar.gz', 'application/gzip'));

/** Read backup.json out of an archive, let `edit` change it, and re-pack with the same files. */
async function repack(buf, edit) {
  const entries = [];
  const extract = tarStream.extract();
  extract.on('entry', (h, stream, next) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => { entries.push([h.name, Buffer.concat(chunks)]); next(); });
  });
  await new Promise((resolve, reject) => { extract.on('finish', resolve); extract.on('error', reject); extract.end(zlib.gunzipSync(buf)); });
  const pack = tarStream.pack();
  for (const [name, body] of entries) {
    pack.entry({ name }, name === 'backup.json' ? Buffer.from(JSON.stringify(edit(JSON.parse(body)))) : body);
  }
  pack.finalize();
  const chunks = [];
  for await (const c of pack) chunks.push(c);
  return zlib.gzipSync(Buffer.concat(chunks));
}

let original;

test('backup → change everything → restore brings it all back', { skip }, async () => {
  // Data across every table.
  const flour = (await api('POST', '/ingredients', { name: 'Flour', category: 'Dry goods', uom: 'lb', purchase: { date: '2026-01-02', quantity: 1, packSize: 50, totalCost: '20.5' } })).data;
  const receipt = (await api('POST', '/receipts', (() => { const fd = new FormData(); fd.append('vendor', 'Depot'); fd.append('source', JSON.stringify({ items: [{ name: 'FLR', price: 21 }, { name: 'SALT', price: 2 }] })); fd.append('images', new Blob([JPEG], { type: 'image/jpeg' }), 'r.jpg'); return fd; })())).data;
  await api('POST', '/ingredients/purchase', { receiptId: receipt.id, items: [{ receiptLine: 0, ingredientId: flour.id, alias: 'FLR', quantity: 1, totalCost: 21 }] });
  const bread = (await api('POST', '/recipes', { name: 'Bread', baseServings: 10, targetMargin: 65, lines: [{ ingredientId: flour.id, amount: 12.5 }] })).data;
  const [breadImg] = (await api('POST', `/recipes/${bread.id}/images`, fileForm('images', PNG, 'bread.png', 'image/png'))).data;
  await api('POST', '/events', { name: 'Gala', date: '2026-11-01', guestCount: 20, recipes: [{ recipeId: bread.id, expectedServings: 20 }] });

  const summary = (await api('GET', '/backup/summary')).data;
  assert.deepEqual(summary.counts, {
    ingredients: 1, ingredient_aliases: 1, receipts: 1, ingredient_purchases: 2, receipt_lines: 2,
    recipes: 1, recipe_ingredients: 1, events: 1, event_recipes: 1, images: 2,
  });

  const stampsSql = 'SELECT id, created_at::text AS t FROM ingredient_purchases ORDER BY id';
  const stamps = (await pool.query(stampsSql)).rows;
  const res = await fetch(base + '/backup');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="kitchen-backup-.*\.tar\.gz"/);
  const archive = Buffer.from(await res.arrayBuffer());
  original = {
    archive,
    ingredients: (await api('GET', '/ingredients')).data,
    recipe: (await api('GET', `/recipes/${bread.id}`)).data,
    receipt: (await api('GET', `/receipts/${receipt.id}`)).data,
    files: await uploads(),
  };

  // Change things: delete the recipe (and its photo), add data and a new photo elsewhere.
  await api('DELETE', `/recipes/${bread.id}`);
  const soup = (await api('POST', '/recipes', { name: 'Soup', baseServings: 4 })).data;
  await api('POST', `/recipes/${soup.id}/images`, fileForm('images', JPEG, 'soup.jpg', 'image/jpeg'));
  await api('POST', '/ingredients', { name: 'Salt' });

  const inspected = await inspect(archive);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.data.counts.recipes, 1);
  assert.equal(inspected.data.counts.images, 2);
  assert.deepEqual(inspected.data.warnings, []);
  // Inspecting changes nothing.
  assert.equal((await api('GET', '/recipes')).data[0].name, 'Soup');

  const restored = await api('POST', '/backup/restore', { token: inspected.data.token });
  assert.equal(restored.status, 200);
  assert.match(restored.data.snapshot, /^before-restore-.*\.tar\.gz$/);

  assert.deepEqual((await api('GET', '/ingredients')).data, original.ingredients);
  assert.deepEqual((await pool.query(stampsSql)).rows, stamps); // microseconds survive
  assert.deepEqual((await api('GET', `/recipes/${bread.id}`)).data, original.recipe);
  assert.deepEqual((await api('GET', `/receipts/${receipt.id}`)).data, original.receipt);
  assert.deepEqual((await api('GET', '/recipes')).data.map((r) => r.name), ['Bread']);
  assert.deepEqual(await uploads(), original.files); // soup.jpg removed, bread.png back
  const img = await fetch(base.replace('/api', '') + breadImg.url);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  const again = await api('POST', '/ingredients/import-receipt', { items: [{ name: 'FLR', price: 1 }] });
  assert.equal(again.data.items[0].match.name, 'Flour'); // alias restored

  // The pre-restore state was kept and can itself be restored.
  const snaps = (await api('GET', '/backup/summary')).data.snapshots;
  assert.equal(snaps[0].name, restored.data.snapshot);
  const snap = await fetch(`${base}/backup/snapshots/${snaps[0].name}`);
  const snapInspect = await inspect(Buffer.from(await snap.arrayBuffer()));
  assert.equal(snapInspect.data.counts.ingredients, 2); // Flour + Salt
  assert.deepEqual((await api('POST', '/backup/restore', { token: inspected.data.token })).status, 410); // token used up
});

test('bad uploads and newer-version backups are refused without changes', { skip }, async () => {
  const before = (await api('GET', '/backup/summary')).data.counts;
  const junk = await inspect(Buffer.from('not a backup'));
  assert.equal(junk.status, 400);
  assert.match(junk.data.error, /isn’t a Kitchen Cost backup/);

  const future = await repack(original.archive, (d) => ({ ...d, migrations: [...d.migrations, '999_future.sql'] }));
  const refused = await inspect(future);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /newer version/);

  assert.equal((await api('GET', '/backup/snapshots/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.deepEqual((await api('GET', '/backup/summary')).data.counts, before);
});

test('backups from an older schema restore with defaults for newer columns', { skip }, async () => {
  // Pretend the backup predates receipt line tracking (migration 004).
  const old = await repack(original.archive, (d) => {
    d.migrations = d.migrations.filter((m) => !m.startsWith('004'));
    delete d.tables.receipt_lines;
    for (const r of d.tables.receipts) delete r.lines_extracted;
    return d;
  });
  const inspected = await inspect(old);
  assert.equal(inspected.data.olderVersion, true);
  assert.equal((await api('POST', '/backup/restore', { token: inspected.data.token })).status, 200);
  // lines_extracted took its default (false), so opening the receipt rebuilds and re-matches its lines.
  const receipt = (await api('GET', `/receipts/${original.receipt.id}`)).data;
  assert.deepEqual(receipt.pendingLines.map((l) => l.name), ['SALT']);
});

test('a backup from before units of measure is converted on restore', { skip }, async () => {
  // Shape the backup as the pre-006 app wrote it: a free-text unit, Use % × quantity lines.
  const old = await repack(original.archive, (d) => {
    d.migrations = d.migrations.filter((m) => !m.startsWith('006'));
    for (const i of d.tables.ingredients) delete i.uom;
    for (const p of d.tables.ingredient_purchases) { delete p.pack_size; p.unit = 'bag 50 lb'; }
    for (const l of d.tables.recipe_ingredients) { delete l.amount; l.base_quantity = '1'; l.use_percent = '25'; }
    return d;
  });
  const inspected = await inspect(old);
  assert.equal((await api('POST', '/backup/restore', { token: inspected.data.token })).status, 200);
  const [flour] = (await api('GET', '/ingredients')).data;
  assert.equal(flour.uom, 'lb');
  assert.equal(flour.latestPackSize, '50.0000');
  const recipe = (await api('GET', `/recipes/${original.recipe.id}`)).data;
  assert.equal(recipe.lines[0].amount, '12.5000'); // 25% of a 50 lb bag
  assert.equal(recipe.costing.baseCost, '5.2500'); // 12.5 lb × $21 / 50 lb
});
