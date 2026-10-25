// Durable, idempotent "give the stock back after a full refund".
//
// Which refunds create a task: ONLY a full admin refund that settles as `processed` and takes the order to `refunded`. A partial
// refund never does (the goods are not coming back), and the automatic stock-failure refund never does (no order exists and no
// stock was taken). Cancellation keeps its own existing restoration in applyAdminOrderUpdate.
//
// Crash safety: the task row is inserted in the SAME transaction that settles the refund and updates the order
// (enqueueStockRestoration, called from refunds.ts). The task is completed in the SAME transaction that returns the stock
// (processStockTask). A crash anywhere leaves a queued/expired-lease task which the worker retries; orders.stock_restored_at,
// written under the order row lock together with the stock increments, makes every retry or concurrent worker a no-op.
// No HTTP or e-mail happens inside these transactions.
import { pool } from '../utils/db';
import { restoreStockInTx } from './orderService';
import { backoffMs, plog, safeError } from './payments/common';

const LEASE_SECONDS = 120;
export const STOCK_TASK_MAX_ATTEMPTS = 10;

/** Insert the task inside the caller's (refund-settling) transaction. Idempotent per order. */
export async function enqueueStockRestoration(client: { query: (t: string, v?: any[]) => Promise<any> }, orderId: string, adminRefundRequestId: string | null): Promise<void> {
  await client.query(
    `INSERT INTO stock_restoration_tasks (order_id, admin_refund_request_id) VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`,
    [orderId, adminRefundRequestId]
  );
}

/** Claim (atomic lease) and run one task. Returns what happened; never throws. */
export async function processStockTask(id: string): Promise<'done' | 'not_claimed' | 'retry' | 'needs_review'> {
  const claimed = await pool.query(
    `UPDATE stock_restoration_tasks SET status = 'restoring', attempts = attempts + 1, lease_until = now() + interval '${LEASE_SECONDS} seconds'
      WHERE id = $1 AND status IN ('queued','restoring') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      RETURNING order_id, attempts`, [id]);
  const task = claimed.rows[0];
  if (!task) return 'not_claimed';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // returns the stock and stamps orders.stock_restored_at under the order row lock (a no-op if already restored)
    const res = await restoreStockInTx(client, task.order_id);
    await client.query(
      `UPDATE stock_restoration_tasks SET status = 'done', completed_at = now(), lease_until = NULL, last_error = NULL, result = $2 WHERE id = $1`,
      [id, (res.restored ? 'restored' : res.reason || 'nothing to do').slice(0, 190)]
    );
    await client.query('COMMIT');
    if (res.restored) plog('info', 'stock_restored', { order: task.order_id });
    return 'done';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    const failed = task.attempts >= STOCK_TASK_MAX_ATTEMPTS;
    const wait = backoffMs(Math.min(task.attempts, 8), 30_000, 3600_000);
    await pool.query(
      `UPDATE stock_restoration_tasks SET status = $2, lease_until = NULL, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval WHERE id = $1 AND status <> 'done'`,
      [id, failed ? 'needs_review' : 'queued', safeError(e, 400), String(wait)]
    ).catch(() => {});
    plog(failed ? 'error' : 'warn', 'stock_restore_failed', { order: task.order_id, attempts: task.attempts, error: safeError(e, 120) });
    return failed ? 'needs_review' : 'retry';
  } finally {
    client.release();
  }
}

export async function processStockTaskForOrder(orderId: string): Promise<void> {
  const r = await pool.query('SELECT id FROM stock_restoration_tasks WHERE order_id = $1', [orderId]);
  if (r.rows[0]) await processStockTask(r.rows[0].id);
}

export async function dueStockTaskIds(limit = 10): Promise<string[]> {
  const r = await pool.query(
    `SELECT id FROM stock_restoration_tasks WHERE status IN ('queued','restoring') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_attempt_at LIMIT $1`, [limit]);
  return r.rows.map((x) => x.id);
}
