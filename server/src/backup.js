// Whole-app backup and restore: every table plus the image files, as one .tar.gz.
//
//   backup.json        { app, format, createdAt, migrations, counts, tables: { name: rows } }
//   uploads/<file>     each image referenced by the `images` table
//
// Restores accept backups from this or an older schema (missing columns take their
// defaults); a backup from a newer schema is refused.

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import tarStream from 'tar-stream';
import pg from 'pg';
import { pool, tx } from './db.js';
import { repoRoot, uploadDir } from './images.js';
import { HttpError } from './validate.js';
import { currentNames } from './migrate.js';

const APP = 'food.db';
const FORMAT = 1;
/** Oldest schema a backup can come from: 007 dropped the columns earlier backups depend on. */
const MIN_MIGRATION = '007_drop_legacy_columns.sql';

/** Insert order respects foreign keys; TRUNCATE takes them all at once. */
export const TABLES = [
  'ingredients', 'ingredient_aliases', 'receipts', 'ingredient_purchases', 'receipt_lines',
  'spice_blends', 'spice_blend_items', 'recipes', 'recipe_ingredients', 'events', 'event_recipes', 'event_amounts', 'images',
];

const IMAGE_FILE = /^[A-Za-z0-9-]+\.(jpg|png|webp|gif)$/;
const SNAPSHOT_FILE = /^before-(restore|clearing-test-data)-[0-9TZ-]+\.tar\.gz$/;
const KEEP_SNAPSHOTS = 10;

export const backupDir = () => path.resolve(repoRoot, process.env.BACKUP_DIR ?? 'data/backups');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
export const backupFilename = () => `food.db-backup-${stamp()}.tar.gz`;

async function currentMigrations(client = pool) {
  const { rows } = await client.query('SELECT name FROM schema_migrations ORDER BY name');
  return rows.map((r) => r.name);
}

/** Row counts for each table, plus the total size of stored images. */
export async function summarizeCurrent() {
  const counts = {};
  for (const t of TABLES) counts[t] = (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  const { rows } = await pool.query('SELECT coalesce(sum(size_bytes), 0)::bigint AS bytes FROM images');
  return { counts, imageBytes: Number(rows[0].bytes) };
}

// Read timestamps as Postgres prints them: JS Dates would drop the microseconds.
const TIMESTAMP_OIDS = new Set([1114, 1184]);
const exactTypes = { getTypeParser: (oid, format) => (TIMESTAMP_OIDS.has(oid) ? (v) => v : pg.types.getTypeParser(oid, format)) };

const addEntry = (pack, header, body) =>
  new Promise((resolve, reject) => pack.entry(header, body, (err) => (err ? reject(err) : resolve())));

/** Write a full backup as .tar.gz to `out` (an HTTP response or a file stream). */
export async function writeBackup(out) {
  const client = await pool.connect();
  const tables = {};
  let migrations;
  try {
    // One consistent snapshot of every table.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const t of TABLES) tables[t] = (await client.query({ text: `SELECT * FROM ${t}`, types: exactTypes })).rows;
    migrations = await currentMigrations(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const files = [];
  const missingFiles = [];
  for (const img of tables.images) {
    const file = path.join(uploadDir(), img.filename);
    if (await stat(file).catch(() => null)) files.push(img.filename);
    else missingFiles.push(img.filename);
  }

  const data = {
    app: APP,
    format: FORMAT,
    createdAt: new Date().toISOString(),
    migrations,
    counts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])),
    missingFiles,
    tables,
  };

  const pack = tarStream.pack();
  const done = pipeline(pack, zlib.createGzip(), out);
  await addEntry(pack, { name: 'backup.json', mtime: new Date() }, Buffer.from(JSON.stringify(data)));
  for (const f of files) {
    await addEntry(pack, { name: `uploads/${f}` }, await readFile(path.join(uploadDir(), f)));
  }
  pack.finalize();
  await done;
  return data.counts;
}

/** Unpack an uploaded archive into `dir`; image files land in dir/uploads. */
async function unpack(archivePath, dir) {
  await mkdir(path.join(dir, 'uploads'), { recursive: true });
  const extract = tarStream.extract();
  let json = null;
  const files = new Set();
  extract.on('entry', (header, stream, next) => {
    const done = (err) => next(err);
    if (header.type !== 'file') {
      stream.resume();
      return stream.on('end', () => done());
    }
    if (header.name === 'backup.json') {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        json = Buffer.concat(chunks).toString('utf8');
        done();
      });
      stream.on('error', done);
      return;
    }
    const base = header.name.startsWith('uploads/') ? header.name.slice('uploads/'.length) : null;
    if (base && IMAGE_FILE.test(base)) {
      pipeline(stream, createWriteStream(path.join(dir, 'uploads', base))).then(() => {
        files.add(base);
        done();
      }, done);
      return;
    }
    stream.resume(); // anything else in the archive is ignored
    stream.on('end', () => done());
  });
  try {
    await pipeline(createReadStream(archivePath), zlib.createGunzip(), extract);
  } catch {
    throw new HttpError(400, 'That file isn’t a food.db backup. Choose a .tar.gz file downloaded from this page.');
  }
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new HttpError(400, 'That archive has no readable backup.json, so it isn’t a food.db backup.');
  }
  return { data, files };
}

/** Check an unpacked backup can be restored here; returns a summary for the confirm screen. */
async function validate(data, files) {
  if (data?.app !== APP || typeof data.tables !== 'object' || !Array.isArray(data.migrations)) {
    throw new HttpError(400, 'That archive isn’t a food.db backup.');
  }
  if (data.format !== FORMAT) throw new HttpError(400, `Backup format ${data.format} isn’t supported by this version.`);
  // Restore fills in anything a backup from 007 on lacks (missing columns take their defaults).
  const migrations = currentNames(data.migrations, MIN_MIGRATION);
  if (!migrations) {
    throw new HttpError(409, 'This backup is from a version older than the units-of-measure update and can’t be restored.');
  }
  const known = new Set(await currentMigrations());
  const newer = migrations.filter((m) => !known.has(m));
  if (newer.length) {
    throw new HttpError(409, `This backup was made by a newer version of food.db (it includes ${newer.join(', ')}). Update the app, then restore.`);
  }

  const warnings = [];
  for (const t of TABLES) {
    if (data.tables[t] !== undefined && !Array.isArray(data.tables[t])) throw new HttpError(400, `Backup table ${t} is malformed.`);
  }
  // Image rows without their file would be broken links; leave them out.
  const images = data.tables.images ?? [];
  const usable = images.filter((img) => IMAGE_FILE.test(img.filename ?? '') && files.has(img.filename));
  if (usable.length < images.length) {
    const n = images.length - usable.length;
    warnings.push(`${n} photo${n === 1 ? ' is' : 's are'} missing from the archive and will be skipped.`);
    data.tables.images = usable;
  }
  return {
    createdAt: data.createdAt,
    counts: Object.fromEntries(TABLES.map((t) => [t, data.tables[t]?.length ?? 0])),
    olderVersion: migrations.length < known.size,
    warnings,
  };
}

// Uploaded backups wait here between "inspect" and "restore".
const staged = new Map();
const STAGE_TTL_MS = 30 * 60 * 1000;

async function dropStage(token) {
  const s = staged.get(token);
  staged.delete(token);
  if (s) await rm(s.dir, { recursive: true, force: true });
}

async function sweepStages() {
  for (const [token, s] of staged) if (s.expires < Date.now()) await dropStage(token);
}

/** Unpack and check an uploaded backup; returns a token to restore it with. */
export async function inspectBackup(archivePath) {
  await sweepStages();
  const dir = await mkdtemp(path.join(tmpdir(), 'kitchen-restore-'));
  try {
    const { data, files } = await unpack(archivePath, dir);
    const summary = await validate(data, files);
    const token = randomUUID();
    staged.set(token, { dir, data, expires: Date.now() + STAGE_TTL_MS });
    return { token, ...summary };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function pruneSnapshots() {
  const names = (await listSnapshots()).map((s) => s.name);
  for (const name of names.slice(KEEP_SNAPSHOTS)) await rm(path.join(backupDir(), name), { force: true });
}

export async function listSnapshots() {
  const dir = backupDir();
  const names = (await readdir(dir).catch(() => [])).filter((n) => SNAPSHOT_FILE.test(n));
  const out = [];
  for (const name of names) {
    const s = await stat(path.join(dir, name));
    out.push({ name, bytes: s.size, createdAt: s.mtime.toISOString() });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Save the current data to BACKUP_DIR as before-<reason>-<time>.tar.gz; returns the file name. */
export async function saveSnapshot(reason) {
  await mkdir(backupDir(), { recursive: true });
  const snapshot = `before-${reason}-${stamp()}.tar.gz`;
  const tmp = path.join(backupDir(), `.${snapshot}.partial`);
  await writeBackup(createWriteStream(tmp));
  await rename(tmp, path.join(backupDir(), snapshot));
  await pruneSnapshots();
  return snapshot;
}

export function snapshotPath(name) {
  if (!SNAPSHOT_FILE.test(name)) return null;
  return path.join(backupDir(), name);
}

/**
 * Replace all data with a staged backup. The current data is saved as a snapshot first.
 * Tables are replaced in one transaction; image files are copied in before it commits and
 * files no longer referenced are removed after.
 */
export async function restoreBackup(token) {
  await sweepStages();
  const stage = staged.get(token);
  if (!stage) throw new HttpError(410, 'That upload has expired. Choose the backup file again.');
  staged.delete(token); // one restore per upload

  try {
    const snapshot = await saveSnapshot('restore');

    const { data } = stage;
    const dest = uploadDir();
    await mkdir(dest, { recursive: true });
    const existing = new Set(await readdir(dest));
    const copied = [];
    for (const img of data.tables.images ?? []) {
      if (existing.has(img.filename)) continue; // same UUID name = same file
      await copyFile(path.join(stage.dir, 'uploads', img.filename), path.join(dest, img.filename));
      copied.push(img.filename);
    }

    try {
      await tx(async (c) => {
        const { rows } = await c.query(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)`,
          [TABLES],
        );
        const columns = Map.groupBy(rows, (r) => r.table_name);
        await c.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
        for (const t of TABLES) {
          const list = data.tables[t] ?? [];
          if (!list.length) continue;
          // Only columns the backup has; anything newer than the backup takes its default.
          const present = new Set(list.flatMap((r) => Object.keys(r)));
          const cols = (columns.get(t) ?? []).map((r) => r.column_name).filter((c2) => present.has(c2));
          const ident = cols.map((c2) => `"${c2}"`).join(', ');
          await c.query(
            `INSERT INTO ${t} (${ident}) SELECT ${ident} FROM jsonb_populate_recordset(null::${t}, $1::jsonb)`,
            [JSON.stringify(list)],
          );
        }
      });
    } catch (err) {
      await Promise.all(copied.map((f) => rm(path.join(dest, f), { force: true })));
      if (err.code?.startsWith?.('23')) throw new HttpError(400, `The backup’s data is inconsistent and was not restored (${err.detail ?? err.message}).`);
      throw err;
    }

    const keep = new Set((data.tables.images ?? []).map((i) => i.filename));
    for (const f of await readdir(dest)) if (!keep.has(f)) await rm(path.join(dest, f), { force: true });

    return {
      snapshot,
      counts: Object.fromEntries(TABLES.map((t) => [t, data.tables[t]?.length ?? 0])),
    };
  } finally {
    await rm(stage.dir, { recursive: true, force: true });
  }
}
