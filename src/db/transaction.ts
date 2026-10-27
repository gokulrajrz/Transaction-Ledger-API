import type { Pool, PoolClient } from 'pg';

export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  let committing = false;
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    active = true;
    const value = await work(client);
    committing = true;
    await client.query('COMMIT');
    active = false;
    return value;
  } catch (error) {
    // If COMMIT failed over the network its outcome may be unknown. Never retry here.
    discard = committing || !active;
    if (active) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
