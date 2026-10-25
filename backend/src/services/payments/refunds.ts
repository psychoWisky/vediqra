// Durable refund workflow (used when a captured payment cannot become an order, e.g. the goods sold out after payment).
//
// Rules this file enforces:
//  * The attempt row (stable idempotency key, receipt, amount) is COMMITTED before any provider call.
//  * The provider request is identical on every try: same key, same body (amount, receipt, notes) - a lost answer is NEVER a
//    reason for a new key.
//  * An uncertain outcome (timeout, dropped connection, 5xx, "in progress") becomes `unknown`. An `unknown` attempt is first
//    RECONCILED by listing the payment's refunds (matched by our receipt / attempt id); only if the provider has no such
//    refund is the same request sent again, with the same key.
//  * `pending` is not `processed`: the intent only becomes `refunded` once the provider says processed.
//  * The refund never exceeds the captured amount (database guard + a provider-side check before the first submission).
//  * When the provider's state cannot be established, or the provider refuses, the attempt goes to `needs_review` with an
//    admin alert; nothing is retried blindly.
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../utils/db';
import { getRazorpay, RazorpayApiError, ProviderRefund } from '../razorpayClient';
import { backoffMs, plog, safeError } from './common';
import { enqueueNotification } from './outbox';
import { withTx } from './tx';

const LEASE_SECONDS = 120;
export const REFUND_MAX_SUBMISSIONS = 8;
const GIVE_UP_AFTER_HOURS = 48;          // an unresolved (unknown/pending) attempt older than this goes to a human
const PENDING_GIVE_UP_DAYS = 7;

interface AttemptRow {
  id: string; intent_id: string; razorpay_payment_id: string; purpose: string; idempotency_key: string; receipt: string;
  amount_paise: string | number; currency: string; status: string; provider_refund_id: string | null; attempts: number;
  created_at: Date;
}

/** Queue a refund attempt in the caller's transaction. The intent must already be `refund_required` (the database checks). */
export async function queueRefundAttempt(client: PoolClient, intent: { id: string; razorpay_payment_id: string; amount_paise: number | string; currency: string }, purpose: 'stock_failure' | 'manual_review' = 'stock_failure'): Promise<string> {
  const id = crypto.randomUUID();
  const hex = id.replace(/-/g, '');
  await client.query(
    `INSERT INTO payment_refund_attempts (id, intent_id, razorpay_payment_id, purpose, idempotency_key, receipt, amount_paise, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, intent.id, intent.razorpay_payment_id, purpose, `rfd_${hex}`, `rf_${hex}`, intent.amount_paise, intent.currency]
  );
  return id;
}

/** Move an attempt (and, for a stock-failure refund, its intent) to needs_review and tell the admin. Idempotent. */
async function toReview(row: AttemptRow, reason: string): Promise<'needs_review'> {
  await withTx(async (c) => {
    const upd = await c.query(
      `UPDATE payment_refund_attempts SET status = 'needs_review', review_reason = $2, lease_until = NULL
        WHERE id = $1 AND status NOT IN ('processed','failed','needs_review') RETURNING id`,
      [row.id, reason.slice(0, 290)]
    );
    if (upd.rowCount === 0) return;
    await c.query(
      `UPDATE payment_intents SET status = 'needs_review', review_reason = $2 WHERE id = $1 AND status = 'refund_required'`,
      [row.intent_id, `refund needs a human: ${reason}`.slice(0, 290)]
    );
    await enqueueNotification(c, {
      kind: 'admin_alert', dedupeKey: `refund:${row.id}:review`, recipient: 'admin', intentId: row.intent_id,
      payload: { subject: 'Refund needs review', reason: 'refund_needs_review', detail: reason.slice(0, 250) },
    });
  });
  plog('error', 'refund_needs_review', { attempt: row.id, intent: row.intent_id, payment: row.razorpay_payment_id, reason });
  return 'needs_review';
}

async function markProcessed(row: AttemptRow, refund: ProviderRefund): Promise<'processed'> {
  await withTx(async (c) => {
    await c.query(
      `UPDATE payment_refund_attempts SET status = 'processed', provider_refund_id = $2, provider_status = 'processed',
              settled_at = now(), lease_until = NULL, last_error = NULL, last_error_kind = NULL
        WHERE id = $1 AND status NOT IN ('processed','failed')`,
      [row.id, refund.id]
    );
    await c.query(
      `UPDATE payment_intents SET status = 'refunded' WHERE id = $1 AND status IN ('refund_required','needs_review')`,
      [row.intent_id]
    );
  });
  plog('info', 'refund_processed', { attempt: row.id, intent: row.intent_id, refund: refund.id, amountPaise: Number(row.amount_paise) });
  return 'processed';
}

async function markPending(row: AttemptRow, refund: ProviderRefund): Promise<'pending'> {
  const wait = backoffMs(Math.min(row.attempts, 6), 5 * 60_000, 6 * 3600_000);
  await pool.query(
    `UPDATE payment_refund_attempts SET status = 'pending', provider_refund_id = $2, provider_status = 'pending', lease_until = NULL,
            last_error = NULL, last_error_kind = NULL, next_attempt_at = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1 AND status NOT IN ('processed','failed')`,
    [row.id, refund.id, String(wait)]
  );
  plog('info', 'refund_pending', { attempt: row.id, refund: refund.id });
  return 'pending';
}

async function markFailed(row: AttemptRow, refund: ProviderRefund): Promise<'needs_review'> {
  // The provider says this refund definitively failed. A new refund is a financial decision, so a human makes it.
  await withTx(async (c) => {
    await c.query(
      `UPDATE payment_refund_attempts SET status = 'failed', provider_refund_id = $2, provider_status = 'failed', settled_at = now(),
              lease_until = NULL, last_error_kind = 'provider_failed'
        WHERE id = $1 AND status NOT IN ('processed','failed')`,
      [row.id, refund.id]
    );
    await c.query(
      `UPDATE payment_intents SET status = 'needs_review', review_reason = 'the provider reported the refund as failed' WHERE id = $1 AND status = 'refund_required'`,
      [row.intent_id]
    );
    await enqueueNotification(c, {
      kind: 'admin_alert', dedupeKey: `refund:${row.id}:failed`, recipient: 'admin', intentId: row.intent_id,
      payload: { subject: 'Refund failed at Razorpay', reason: 'refund_failed', detail: `refund ${refund.id}` },
    });
  });
  plog('error', 'refund_failed', { attempt: row.id, intent: row.intent_id, refund: refund.id });
  return 'needs_review';
}

async function adopt(row: AttemptRow, refund: ProviderRefund): Promise<'processed' | 'pending' | 'needs_review'> {
  if (Number(refund.amount) !== Number(row.amount_paise)) {
    return toReview(row, `provider refund ${refund.id} has amount ${refund.amount}, expected ${row.amount_paise}`);
  }
  if (refund.status === 'processed') return markProcessed(row, refund);
  if (refund.status === 'pending') return markPending(row, refund);
  if (refund.status === 'failed') return markFailed(row, refund);
  return toReview(row, `provider refund ${refund.id} has unexpected status ${refund.status}`);
}

/**
 * Record an uncertain/transient outcome and schedule a retry. A row that was `submitting` becomes `unknown` (a provider call
 * may have been performed); a `queued` row stays queued (nothing was sent), an `unknown`/`pending` row keeps its state.
 */
async function defer(row: AttemptRow, kind: string, err: unknown): Promise<'unknown'> {
  const wait = backoffMs(Math.min(row.attempts, 10), 30_000, 3600_000);
  await pool.query(
    `UPDATE payment_refund_attempts SET status = CASE WHEN status = 'submitting' THEN 'unknown' ELSE status END, lease_until = NULL, last_error_kind = $2, last_error = $3,
            next_attempt_at = now() + ($4 || ' milliseconds')::interval
      WHERE id = $1 AND status NOT IN ('processed','failed','needs_review')`,
    [row.id, kind.slice(0, 40), safeError(err, 400), String(wait)]
  );
  plog('warn', 'refund_deferred', { attempt: row.id, kind, attempts: row.attempts, error: safeError(err, 120) });
  return 'unknown';
}

const ageHours = (d: Date) => (Date.now() - new Date(d).getTime()) / 3600_000;

async function submit(row: AttemptRow): Promise<string> {
  if (row.attempts >= REFUND_MAX_SUBMISSIONS) return toReview(row, `${row.attempts} submissions without a confirmed result`);
  const rzp = getRazorpay();

  // Cap: never ask the provider for more than is still refundable on the payment.
  let payment;
  try {
    payment = await rzp.payments.fetch(row.razorpay_payment_id);
  } catch (e) {
    return defer(row, e instanceof RazorpayApiError ? e.kind : 'error', e);
  }
  if (!payment.captured) return toReview(row, `payment is ${payment.status}, not captured`);
  if (Number(payment.amount_refunded) + Number(row.amount_paise) > Number(payment.amount)) {
    if (row.attempts > 0) {
      // WE already sent this request, so the refund on the payment is very probably ours and the provider's refund LIST just
      // has not caught up. Do not conclude anything: wait and look again (the 48 h limit still hands it to a person).
      return defer(row, 'provider_state_lag', new Error('payment shows a refund but the refund list does not yet include ours'));
    }
    return toReview(row, 'payment already refunded outside this system (dashboard or another process); nothing was sent');
  }

  // Commit "submitting" BEFORE the provider call, so a crash mid-call is recognised afterwards (lease expiry -> reconcile).
  const moved = await pool.query(
    `UPDATE payment_refund_attempts SET status = 'submitting', attempts = attempts + 1, last_attempt_at = now(),
            submitted_at = COALESCE(submitted_at, now()), lease_until = now() + interval '${LEASE_SECONDS} seconds'
      WHERE id = $1 AND status IN ('queued','unknown','pending','submitting') RETURNING attempts`,
    [row.id]
  );
  if (moved.rowCount === 0) return 'not_claimed';
  const sentRow = { ...row, attempts: moved.rows[0].attempts };

  try {
    const refund = await rzp.payments.refundIdempotent(
      row.razorpay_payment_id,
      { amount: Number(row.amount_paise), receipt: row.receipt, notes: { attempt_id: row.id, reason: 'stock_unavailable' } },
      row.idempotency_key,
    );
    return await adopt(sentRow, refund);
  } catch (e) {
    if (e instanceof RazorpayApiError) {
      if (e.idempotencyConflict) return toReview(sentRow, 'provider reports the idempotency key was used with a different request');
      if (e.outcomeUnknown || e.retryable || e.kind === 'invalid_response') return defer(sentRow, e.kind, e);
      if (e.kind === 'invalid_request') return toReview(sentRow, `refund request refused locally: ${safeError(e, 150)}`);
      // The provider answered with a definite refusal (4xx).
      return toReview(sentRow, `provider refused the refund (${e.status ?? ''} ${e.code ?? ''}): ${(e.description || '').slice(0, 150)}`);
    }
    return defer(sentRow, 'error', e);
  }
}

async function step(row: AttemptRow): Promise<string> {
  if (ageHours(row.created_at) > GIVE_UP_AFTER_HOURS && row.status !== 'pending') {
    return toReview(row, `still unresolved after ${GIVE_UP_AFTER_HOURS} hours; the provider state could not be established`);
  }
  if (row.status === 'pending' && ageHours(row.created_at) > PENDING_GIVE_UP_DAYS * 24) {
    return toReview(row, `refund still pending at the provider after ${PENDING_GIVE_UP_DAYS} days`);
  }
  if (row.status === 'queued') return submit(row);

  // unknown / pending / submitting with an expired lease: ask the provider what exists BEFORE anything is sent again.
  let list;
  try {
    list = await getRazorpay().payments.fetchRefunds(row.razorpay_payment_id);
  } catch (e) {
    return defer(row, e instanceof RazorpayApiError ? e.kind : 'error', e);
  }
  const match = list.items.find((r) => r.receipt === row.receipt || (r.notes && (r.notes as any).attempt_id === row.id)
    || (row.provider_refund_id !== null && r.id === row.provider_refund_id));
  if (match) return adopt(row, match);
  if (row.status === 'pending') return toReview(row, `provider no longer lists the pending refund ${row.provider_refund_id}`);
  return submit(row);    // nothing at the provider: the SAME request goes again with the SAME key
}

/**
 * Work on one refund attempt if it is due and nobody else holds it. Safe to call from several workers/processes at once:
 * the claim is a single atomic UPDATE on the lease.
 */
export async function processRefundAttempt(id: string): Promise<string> {
  const claimed = await pool.query(
    `UPDATE payment_refund_attempts SET lease_until = now() + interval '${LEASE_SECONDS} seconds'
      WHERE id = $1 AND status IN ('queued','unknown','pending','submitting') AND next_attempt_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
      RETURNING *`,
    [id]
  );
  const row: AttemptRow | undefined = claimed.rows[0];
  if (!row) return 'not_claimed';
  try {
    return await step(row);
  } catch (e) {
    plog('error', 'refund_step_failed', { attempt: id, error: safeError(e, 150) });
    await pool.query(`UPDATE payment_refund_attempts SET lease_until = NULL, last_error = $2 WHERE id = $1 AND status NOT IN ('processed','failed','needs_review')`, [id, safeError(e, 400)]).catch(() => {});
    return 'error';
  }
}

/** Ids of attempts that are due (queued, unknown, pending, or submitting with an expired lease). */
export async function dueRefundAttemptIds(limit = 10): Promise<string[]> {
  const r = await pool.query(
    `SELECT id FROM payment_refund_attempts
      WHERE status IN ('queued','unknown','pending','submitting') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_attempt_at LIMIT $1`,
    [limit]
  );
  return r.rows.map((x) => x.id);
}
