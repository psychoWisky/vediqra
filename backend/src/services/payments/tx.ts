import type { PoolClient } from 'pg';
import { pool } from '../../utils/db';

/** Run `fn` in one transaction on its own connection: COMMIT on success, ROLLBACK (and rethrow) on any error. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
