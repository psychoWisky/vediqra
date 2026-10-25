// Payment recovery worker: an in-process timer (no external queue). Each tick:
//   1. stuck `preparing` intents      -> find (never create) the Razorpay order they may have made, or abandon them
//   2. `created` / `abandoned` intents -> ask Razorpay whether the order was paid, and fulfil/refund/review accordingly
//   3. refund attempts                 -> submit / reconcile / settle (see refunds.ts)
//   4. notification outbox             -> send queued e-mails
//   5. unprocessed webhook events      -> finish them via the provider
// Safety: one tick at a time per process (setTimeout chain), one tick at a time across processes (Postgres advisory lock),
// and every row is claimed with a lease / next-check time pushed forward in the claiming statement (FOR UPDATE SKIP LOCKED),
// so overlapping workers never process the same row twice. Nothing here deletes financial or recovery records.
import config from '../../config';
import { pool } from '../../utils/db';
import { IntentRow, reconcilePreparing } from './intents';
import { reconcileIntentWithProvider } from './fulfilment';
import { dueRefundAttemptIds, processRefundAttempt } from './refunds';
import { flushOutbox } from './outbox';
import { dueAdminRefundIds, processAdminRefund } from '../refunds';
import { dueStockTaskIds, processStockTask } from '../stockRestoration';
import { retryUnprocessedEvents } from './webhook';
import { backoffMs, plog, safeError } from './common';

const ADVISORY_LOCK_KEY = 874_120_551;     // arbitrary, unique to this job
const BATCH = 20;
const ABANDON_CREATED_AFTER_HOURS = 24;
const WATCH_ABANDONED_DAYS = 7;

export interface RecoverySummary {
  preparing: number; checked: number; fulfilled: number; abandoned: number; refunds: number; outboxSent: number; events: number; errors: number;
}

async function claimIntents(where: string, limit: number): Promise<IntentRow[]> {
  const r = await pool.query(
    `UPDATE payment_intents SET last_checked_at = now(), next_check_at = now() + interval '5 minutes'
      WHERE id IN (SELECT id FROM payment_intents WHERE ${where} ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [limit]
  );
  return r.rows;
}

const ageHours = (d: Date) => (Date.now() - new Date(d).getTime()) / 3600_000;

async function checkOne(intent: IntentRow, summary: RecoverySummary): Promise<void> {
  try {
    const { found, result } = await reconcileIntentWithProvider(intent);
    summary.checked++;
    if (found === 'captured') {
      if (result?.outcome === 'fulfilled') summary.fulfilled++;
      await pool.query(`UPDATE payment_intents SET check_failures = 0, next_check_at = NULL WHERE id = $1`, [intent.id]);
      return;
    }
    if (found === 'authorized') {
      await pool.query(`UPDATE payment_intents SET check_failures = 0, next_check_at = now() + interval '5 minutes' WHERE id = $1`, [intent.id]);
      return;
    }
    // Nothing paid. Poll quickly while the checkout is fresh, then less and less often.
    const age = ageHours(intent.created_at);
    if (intent.status === 'created' && age >= ABANDON_CREATED_AFTER_HOURS) {
      await pool.query(`UPDATE payment_intents SET status = 'abandoned', check_failures = 0, next_check_at = now() + interval '1 day' WHERE id = $1 AND status = 'created'`, [intent.id]);
      summary.abandoned++;
      return;
    }
    if (intent.status === 'abandoned' && age >= WATCH_ABANDONED_DAYS * 24) {
      await pool.query(`UPDATE payment_intents SET next_check_at = NULL WHERE id = $1`, [intent.id]);   // stop watching; a late webhook still works
      return;
    }
    const wait = intent.status === 'abandoned' ? 24 * 3600_000 : backoffMs(intent.check_failures, 10 * 60_000, 3600_000);
    await pool.query(`UPDATE payment_intents SET next_check_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`, [intent.id, String(wait)]);
  } catch (e) {
    summary.errors++;
    const wait = backoffMs(intent.check_failures, 60_000, 3600_000);
    await pool.query(
      `UPDATE payment_intents SET check_failures = check_failures + 1, last_error = $2, next_check_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1`,
      [intent.id, safeError(e, 400), String(wait)]
    ).catch(() => {});
    plog('warn', 'recovery_check_failed', { intent: intent.id, error: safeError(e, 150) });
  }
}

/** One pass over every kind of recoverable work. Never throws. */
export async function runRecoveryOnce(): Promise<RecoverySummary> {
  const s: RecoverySummary = { preparing: 0, checked: 0, fulfilled: 0, abandoned: 0, refunds: 0, outboxSent: 0, events: 0, errors: 0 };

  try {
    for (const intent of await claimIntents(`status = 'preparing' AND created_at < now() - interval '2 minutes' AND (next_check_at IS NULL OR next_check_at <= now())`, BATCH)) {
      try {
        const r = await reconcilePreparing(intent);
        s.preparing++;
        if (r === 'abandoned') s.abandoned++;
      } catch (e) {
        s.errors++;
        plog('warn', 'recovery_preparing_failed', { intent: intent.id, error: safeError(e, 150) });
      }
    }
  } catch (e) { s.errors++; plog('error', 'recovery_preparing_claim_failed', { error: safeError(e, 150) }); }

  try {
    for (const intent of await claimIntents(`status IN ('created','abandoned') AND razorpay_order_id IS NOT NULL AND next_check_at IS NOT NULL AND next_check_at <= now()`, BATCH)) {
      await checkOne(intent, s);
    }
  } catch (e) { s.errors++; plog('error', 'recovery_intent_claim_failed', { error: safeError(e, 150) }); }

  try {
    for (const id of await dueRefundAttemptIds(10)) {
      const r = await processRefundAttempt(id);
      if (r !== 'not_claimed') s.refunds++;
    }
  } catch (e) { s.errors++; plog('error', 'recovery_refunds_failed', { error: safeError(e, 150) }); }

  try {
    for (const id of await dueAdminRefundIds(10)) {
      const r = await processAdminRefund(id);
      if (r !== 'not_claimed') s.refunds++;
    }
  } catch (e) { s.errors++; plog('error', 'recovery_admin_refunds_failed', { error: safeError(e, 150) }); }

  try {
    for (const id of await dueStockTaskIds(10)) await processStockTask(id);
  } catch (e) { s.errors++; plog('error', 'recovery_stock_tasks_failed', { error: safeError(e, 150) }); }

  try { s.outboxSent = (await flushOutbox(undefined, BATCH)).sent; } catch (e) { s.errors++; }
  try { s.events = await retryUnprocessedEvents(BATCH); } catch (e) { s.errors++; plog('error', 'recovery_events_failed', { error: safeError(e, 150) }); }
  return s;
}

/** One tick under the cross-process advisory lock. Returns null when another process is running the job. */
export async function runRecoveryTick(): Promise<RecoverySummary | null> {
  const lockClient = await pool.connect();
  try {
    const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY])).rows[0].ok;
    if (!got) return null;
    try {
      return await runRecoveryOnce();
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

export interface RecoveryHandle { stop: () => Promise<void> }

/** Start the background job if PAYMENT_RECOVERY_ENABLED=true; otherwise do nothing (the safe default). */
export function startPaymentRecovery(opts: { firstDelayMs?: number } = {}): RecoveryHandle | null {
  if (!config.paymentRecoveryEnabled) {
    console.log('ℹ️ Payment recovery worker is disabled (set PAYMENT_RECOVERY_ENABLED=true to enable).');
    return null;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const loop = () => {
    timer = null;
    if (stopped) return;
    running = (async () => {
      try {
        const t0 = Date.now();
        const summary = await runRecoveryTick();
        if (summary && (summary.checked || summary.refunds || summary.outboxSent || summary.events || summary.preparing || summary.errors)) {
          plog('info', 'recovery_tick', { count: summary.checked + summary.refunds + summary.outboxSent + summary.events + summary.preparing, ms: Date.now() - t0 });
        }
      } catch (e) {
        plog('error', 'recovery_tick_failed', { error: safeError(e, 150) });
      } finally {
        running = null;
        if (!stopped) timer = setTimeout(loop, config.paymentRecoveryIntervalMs);
      }
    })();
  };
  timer = setTimeout(loop, opts.firstDelayMs ?? 5_000);          // first pass shortly after start-up
  plog('info', 'recovery_started', { count: config.paymentRecoveryIntervalMs });

  return {
    stop: async () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (running) await running.catch(() => {});
      plog('info', 'recovery_stopped');
    },
  };
}
