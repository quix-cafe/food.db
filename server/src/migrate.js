import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db.js';
import { embedded } from './embedded.js';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Apply any migrations/*.sql files not yet recorded, in filename order. */
export async function migrate({ log = console.log } = {}) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = embedded?.migrations ?? (await readdir(dir)).filter((f) => f.endsWith('.sql')).map((name) => ({ name }));
  files.sort((a, b) => a.name.localeCompare(b.name));
  for (const { name: file, sql: bundled } of files) {
    if (applied.has(file)) continue;
    const sql = bundled ?? await readFile(dir + file, 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    log(`migrated ${file}`);
  }
}

// `npm run migrate`. (Never in the binary, where every module shares the executable's path.)
if (!embedded && process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  await pool.end();
}
