import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { embedded } from './embedded.js';

// Keep DATE columns as 'YYYY-MM-DD' strings; JS Dates would shift them by time zone.
// NUMERIC columns already come back as strings, which is what the decimal math wants.
pg.types.setTypeParser(1082, (v) => v);

const url = process.env.DATABASE_URL ?? 'postgres://kitchen:kitchen@localhost:5432/kitchen';

/**
 * The database: a pg.Pool for Postgres, or for `pglite://<dir>` (`pglite://memory` for a
 * throwaway one) an embedded PGlite behind the same pool interface. The standalone binary
 * uses PGlite so it needs no database server.
 */
export const pool = url.startsWith('pglite:') ? pglitePool(url.slice('pglite://'.length)) : postgresPool(url);

function postgresPool(connectionString) {
  const p = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5000, // fail requests (and /api/health) instead of hanging when the DB is down
  });
  // An idle connection dropped by the server (database restart or update) must not crash the
  // app; the pool discards it and the next query opens a fresh one.
  p.on('error', (err) => console.error('Database connection lost:', err.message));
  return p;
}

/**
 * Test mode: rows inserted inside runAsTestData() get is_test = true (migration 011). The
 * column default reads `app.test_data`, set for the length of each transaction, so a query
 * in test mode always runs inside one.
 */
const testMode = new AsyncLocalStorage();
export const runAsTestData = (fn) => testMode.run(true, fn);
const markTestData = (c) => c.query("SELECT set_config('app.test_data', 'on', true)");

export const query = (text, params) =>
  testMode.getStore() && !pool.inTransaction?.() ? tx((c) => c.query(text, params)) : pool.query(text, params);

/** A row is still referenced: foreign_key_violation, or restrict_violation from Postgres 18 (PGlite) on ON DELETE RESTRICT. */
export const fkViolation = (err) => err.code === '23503' || err.code === '23001';

export async function tx(fn) {
  const test = testMode.getStore();
  if (pool.tx) return pool.tx(async (c) => { if (test) await markTestData(c); return fn(c); });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (test) await markTestData(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** pg's text parsers as a PGlite `parsers` table, so both drivers return the same JS values. */
const parserCache = new WeakMap();
function parsersFor(types) {
  let table = parserCache.get(types);
  if (!table) {
    table = {};
    for (let oid = 16; oid < 4100; oid++) table[oid] = types.getTypeParser(oid, 'text');
    parserCache.set(types, table);
  }
  return table;
}

/**
 * PGlite is a single connection, so a transaction (or a client from connect()) holds it
 * exclusively until it ends; other queries wait their turn. Queries made inside tx() via the
 * module-level query() run on the transaction instead of waiting for it to finish.
 */
function pglitePool(dir) {
  const inside = new AsyncLocalStorage();
  let queue = Promise.resolve();
  const acquire = () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const ready = queue.then(() => release);
    queue = queue.then(() => held);
    return ready;
  };
  const exclusive = async (fn) => {
    if (inside.getStore()) return fn();
    const release = await acquire();
    try {
      return await inside.run(true, fn);
    } finally {
      release();
    }
  };

  const opened = openPglite(dir === 'memory' ? undefined : dir);

  async function run(config, values) {
    const db = await opened;
    const text = typeof config === 'string' ? config : config.text;
    values = (typeof config === 'object' && config.values) || values;
    const options = { parsers: parsersFor(config.types ?? pg.types) };
    let res;
    if (values?.length) {
      res = await db.query(text, values, options);
    } else {
      // No parameters: the simple protocol, which also runs multi-statement scripts (migrations).
      const all = await db.exec(text, options);
      res = all[all.length - 1] ?? { rows: [], fields: [] };
    }
    return { rows: res.rows, fields: res.fields, rowCount: res.rows.length || res.affectedRows || 0 };
  }
  const client = { query: run, release() {} };

  return {
    query: (config, values) => exclusive(() => run(config, values)),
    tx: (fn) => exclusive(async () => {
      await run('BEGIN');
      try {
        const result = await fn(client);
        await run('COMMIT');
        return result;
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
    }),
    async connect() {
      const release = await acquire();
      return { query: run, release };
    },
    inTransaction: () => !!inside.getStore(),
    on() {},
    end: () => exclusive(async () => (await opened).close()),
  };
}

async function openPglite(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  // The standalone binary embeds PGlite's files; from source they load from node_modules.
  const files = embedded?.pglite;
  if (!files) {
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    return PGlite.create({ dataDir, extensions: { pg_trgm } });
  }
  // PGlite streams extension bundles from disk, which Bun's embedded files don't support:
  // copy it to a temp file for the duration of startup.
  const tmp = await mkdtemp(path.join(tmpdir(), 'food.db-'));
  try {
    const trgm = path.join(tmp, 'pg_trgm.tar.gz');
    await writeFile(trgm, await readFile(files.pg_trgm));
    const compile = async (file) => WebAssembly.compile(await readFile(file));
    return await PGlite.create({
      dataDir,
      extensions: { pg_trgm: { name: 'pg_trgm', setup: async () => ({ bundlePath: pathToFileURL(trgm) }) } },
      pgliteWasmModule: await compile(files.wasm),
      initdbWasmModule: await compile(files.initdb),
      fsBundle: new Blob([await readFile(files.data)]),
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
