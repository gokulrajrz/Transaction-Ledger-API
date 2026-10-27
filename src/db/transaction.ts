import type { Pool, PoolClient } from 'pg';

export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  mode: 'write' | 'snapshot' = 'write',
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  let committing = false;
  let discard = false;
  let connectionError: Error | undefined;
  const onError = (error: Error) => {
    connectionError ??= error;
    discard = true;
  };
  // A checked-out client's transport errors do not reach pool.on('error').
  client.on('error', onError);
  try {
    await client.query(
      mode === 'snapshot'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN ISOLATION LEVEL READ COMMITTED',
    );
    active = true;
    const value = await work(client);
    if (connectionError) throw connectionError;
    committing = true;
    await client.query('COMMIT');
    if (connectionError) throw connectionError;
    active = false;
    return value;
  } catch (error) {
    // If COMMIT failed over the network its outcome may be unknown. Never retry here.
    discard ||= committing || !active;
    if (active && !connectionError) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    try {
      // release installs the pool's idle error listener before ours is removed.
      client.release(discard);
    } finally {
      client.removeListener('error', onError);
    }
  }
}
