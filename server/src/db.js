import pg from 'pg';

// Keep DATE columns as 'YYYY-MM-DD' strings; JS Dates would shift them by time zone.
// NUMERIC columns already come back as strings, which is what the decimal math wants.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://kitchen:kitchen@localhost:5432/kitchen',
});

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
