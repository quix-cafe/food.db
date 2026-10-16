import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db.js';
import { embedded } from './embedded.js';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Migrations 001–010, squashed into BASELINE. Databases and backups from before list these instead. */
const SQUASHED = [
  '001_init.sql', '002_ingredient_aliases.sql', '003_receipts_and_images.sql', '004_receipt_lines.sql',
  '005_used_multiplier_and_price.sql', '006_units_of_measure.sql', '007_drop_legacy_columns.sql',
  '008_event_amounts.sql', '009_spice_blends.sql', '010_blend_servings.sql',
];
const BASELINE = '001_schema.sql';

/**
 * A migration list in this build's names: the squashed ones become BASELINE. `oldest` is the
 * earliest squashed migration the list must include; returns null when it doesn't.
 */
export function currentNames(names, oldest = SQUASHED.at(-1)) {
  if (!names.some((n) => SQUASHED.includes(n))) return names;
  if (!names.includes(oldest)) return null;
  return [BASELINE, ...names.filter((n) => !SQUASHED.includes(n))];
}

/** Apply any migrations/*.sql files not yet recorded, in filename order. */
export async function migrate({ log = console.log } = {}) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const recorded = rows.map((r) => r.name);
  const names = currentNames(recorded);
  if (!names) throw new Error('This database is from a development version of food.db older than 1.0.0 and can’t be upgraded.');
  if (names !== recorded) {
    // A database from before the squash: it has BASELINE's schema already.
    await tx(async (c) => {
      await c.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [SQUASHED]);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [BASELINE]);
    });
  }
  const applied = new Set(names);
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
