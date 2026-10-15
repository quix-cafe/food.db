import pg from 'pg';

// Keep DATE columns as 'YYYY-MM-DD' strings; JS Dates would shift them by time zone.
// NUMERIC columns already come back as strings, which is what the decimal math wants.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://kitchen:kitchen@localhost:5432/kitchen',
  connectionTimeoutMillis: 5000, // fail requests (and /api/health) instead of hanging when the DB is down
});
// An idle connection dropped by the server (database restart or update) must not crash the
// app; the pool discards it and the next query opens a fresh one.
pool.on('error', (err) => console.error('Database connection lost:', err.message));

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
