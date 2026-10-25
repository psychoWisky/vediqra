import crypto from 'crypto';
import { pool } from '../utils/db';
import { PricingError } from './pricing';
import { getRazorpay, RazorpayApiError } from './razorpayClient';
import { enqueueStockRestoration, processStockTaskForOrder } from './stockRestoration';
import { backoffMs, plog, safeError } from './payments/common';
import { withTx } from './payments/tx';

/** Admin refunds, run through the same durable workflow as automatic ones (table admin_refund_requests).
 *
 * Guarantees
 *  - The request row (stable idempotency key, receipt, amount) is COMMITTED before Razorpay is called, and every try sends the
 *    identical request. A lost answer therefore never produces a second refund: the retry replays the same key, and a worker
 *    first looks for our refund in the provider's list before resending anything.
 *  - Only a refund Razorpay reports as `processed` is counted: orders.refunded_amount and the order status ('partially_refunded' /
 *    'refunded') move only then. A `pending` refund is shown in orders.refunds as pending and changes nothing else; an
 *    uncertain one (timeout, 5xx, no refund id) is `unknown` and is not recorded on the order at all.
 *  - At most one unresolved refund per order (database unique index): a new refund cannot start while an earlier one is uncertain,
 *    so refunds can never add up beyond the order total (also enforced by a trigger).
 *  - A full refund gives the order's stock back once, after the refund is confirmed processed.
 */
const LEASE_SECONDS = 120;
export const ADMIN_REFUND_MAX_SUBMISSIONS = 8;
const GIVE_UP_AFTER_HOURS = 48;
const PENDING_GIVE_UP_DAYS = 7;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type RefundState = 'processed' | 'pending' | 'unknown' | 'failed' | 'needs_review';

export interface RefundResult {
  order: any;
  /** The refund entry as recorded on the order (null while nothing is recorded, e.g. uncertain or failed). */
  refund: { id: string; request_id?: string; amount: number; status: string; created_at: string } | null;
  state: RefundState;
  duplicate: boolean;        // true when this request_id had already been settled: no provider call was made
  stockRestored: boolean;
  requestId: string;         // the id to repeat to retry this exact refund (generated when the admin sent none)
  error?: string;
}

interface Row {
  id: string; order_id: string; razorpay_payment_id: string; request_id: string | null; reason: string | null;
  amount_paise: string | number; status: string; provider_refund_id: string | null; attempts: number; created_at: Date;
  idempotency_key: string; receipt: string;
}

const ageHours = (d: Date) => (Date.now() - new Date(d).getTime()) / 3600_000;

// ---------------------------------------------------------------------------------------------- order bookkeeping
/** Reflect a provider-confirmed state on the order, in the caller's transaction. Only `processed` moves the money totals. */
async function applyToOrder(c: { query: (t: string, v?: any[]) => Promise<any> }, row: Row, state: 'processed' | 'pending' | 'failed', providerRefundId: string | null, raw?: unknown) {
  const locked = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [row.order_id])).rows[0];
  const refunds: any[] = Array.isArray(locked.refunds) ? [...locked.refunds] : [];
  const amount = round2(Number(row.amount_paise) / 100);
  const idx = providerRefundId ? refunds.findIndex((r) => r.id === providerRefundId) : -1;
  const entry = { id: providerRefundId, ...(row.request_id ? { request_id: row.request_id } : {}), amount, status: state, created_at: idx >= 0 ? refunds[idx].created_at : new Date().toISOString() };
  if (idx >= 0) refunds[idx] = entry; else if (providerRefundId && state !== 'failed') refunds.push(entry);   // a failed refund is not a ledger entry

  if (state !== 'processed') {
    await c.query('UPDATE orders SET refunds = $2::jsonb, updated_at = now() WHERE id = $1', [row.order_id, JSON.stringify(refunds)]);
    return { order: (await c.query('SELECT * FROM orders WHERE id = $1', [row.order_id])).rows[0], entry };
  }
  const newRefunded = round2(Number(locked.refunded_amount) + amount);
  const fully = newRefunded >= Number(locked.total_amount);
  const updated = await c.query(
    `UPDATE orders SET refunds = $2::jsonb, refunded_amount = $3, status = $4, refund_data = $5,
            refunded_at = CASE WHEN $6 THEN now() ELSE refunded_at END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [row.order_id, JSON.stringify(refunds), newRefunded, fully ? 'refunded' : 'partially_refunded', JSON.stringify(raw ?? entry), fully]
  );
  // A FULL refund gives the stock back. The task is written in THIS transaction (refund settled + order updated + task),
  // so a crash afterwards can never leave a refunded order without a pending restoration.
  if (fully) await enqueueStockRestoration(c, row.order_id, row.id);
  return { order: updated.rows[0], entry };
}

/** After commit, best effort: do the stock restoration now. If this process dies first, the worker finds the task. */
async function afterSettled(order: any): Promise<void> {
  if (order?.status !== 'refunded') return;
  try {
    await processStockTaskForOrder(order.id);
  } catch (e) {
    console.error('Stock restoration will be retried by the worker:', order.id, safeError(e, 120));
  }
}

// ------------------------------------------------------------------------------------------------ state changes
async function settle(row: Row, state: 'processed' | 'pending' | 'failed', refund: { id: string | null; raw?: unknown }) {
  return withTx(async (c) => {
    if (state === 'processed') {
      await c.query(
        `UPDATE admin_refund_requests SET status = 'processed', provider_refund_id = $2, provider_status = 'processed', settled_at = now(),
                lease_until = NULL, last_error = NULL, last_error_kind = NULL WHERE id = $1 AND status NOT IN ('processed','failed')`, [row.id, refund.id]);
    } else if (state === 'pending') {
      const wait = backoffMs(Math.min(row.attempts, 6), 5 * 60_000, 6 * 3600_000);
      await c.query(
        `UPDATE admin_refund_requests SET status = 'pending', provider_refund_id = $2, provider_status = 'pending', lease_until = NULL,
                last_error = NULL, last_error_kind = NULL, next_attempt_at = now() + ($3 || ' milliseconds')::interval
          WHERE id = $1 AND status NOT IN ('processed','failed')`, [row.id, refund.id, String(wait)]);
    } else {
      await c.query(
        `UPDATE admin_refund_requests SET status = 'failed', provider_refund_id = COALESCE($2, provider_refund_id),
                provider_status = CASE WHEN $2::text IS NULL THEN provider_status ELSE 'failed' END, settled_at = now(), lease_until = NULL
          WHERE id = $1 AND status NOT IN ('processed','failed')`, [row.id, refund.id]);
    }
    return applyToOrder(c, row, state, refund.id, refund.raw);
  });
}

async function toReview(row: Row, reason: string): Promise<RefundState> {
  await pool.query(
    `UPDATE admin_refund_requests SET status = 'needs_review', review_reason = $2, lease_until = NULL
      WHERE id = $1 AND status NOT IN ('processed','failed','needs_review')`, [row.id, reason.slice(0, 290)]);
  plog('error', 'admin_refund_needs_review', { attempt: row.id, reason });
  return 'needs_review';
}

async function defer(row: Row, kind: string, err: unknown): Promise<RefundState> {
  const wait = backoffMs(Math.min(row.attempts, 10), 30_000, 3600_000);
  await pool.query(
    `UPDATE admin_refund_requests SET status = CASE WHEN status = 'submitting' THEN 'unknown' ELSE status END, lease_until = NULL,
            last_error_kind = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval
      WHERE id = $1 AND status NOT IN ('processed','failed','needs_review')`, [row.id, kind.slice(0, 40), safeError(err, 400), String(wait)]);
  plog('warn', 'admin_refund_deferred', { attempt: row.id, kind, attempts: row.attempts });
  return 'unknown';
}

/** Interpret whatever the provider returned (SDK object or ProviderRefund). A missing id or status is NOT a success. */
async function adopt(row: Row, resp: any): Promise<RefundState> {
  const id = typeof resp?.id === 'string' && resp.id ? resp.id : null;
  const status = typeof resp?.status === 'string' ? resp.status : '';
  if (!id || !status) return defer(row, 'invalid_response', new Error('the provider did not return a refund id and status'));
  if (resp.amount !== undefined && Number(resp.amount) !== Number(row.amount_paise)) {
    return toReview(row, `provider refund ${id} has amount ${resp.amount}, expected ${row.amount_paise}`);
  }
  if (status === 'processed') { await settle(row, 'processed', { id, raw: resp }); return 'processed'; }
  if (status === 'pending') { await settle(row, 'pending', { id, raw: resp }); return 'pending'; }
  if (status === 'failed') { await settle(row, 'failed', { id }); return 'failed'; }
  return toReview(row, `provider refund ${id} has unexpected status ${status}`);
}

async function submit(row: Row): Promise<RefundState> {
  if (row.attempts >= ADMIN_REFUND_MAX_SUBMISSIONS) return toReview(row, `${row.attempts} submissions without a confirmed result`);
  // Commit "submitting" BEFORE the provider call, so a crash mid-call is recognised afterwards (lease expiry -> reconcile).
  const moved = await pool.query(
    `UPDATE admin_refund_requests SET status = 'submitting', attempts = attempts + 1, last_attempt_at = now(),
            lease_until = now() + interval '${LEASE_SECONDS} seconds'
      WHERE id = $1 AND status IN ('queued','unknown','pending','submitting') RETURNING attempts`, [row.id]);
  if (moved.rowCount === 0) return 'unknown';
  const sent = { ...row, attempts: moved.rows[0].attempts };
  const order = (await pool.query('SELECT id, custom_order_id FROM orders WHERE id = $1', [row.order_id])).rows[0];
  try {
    const resp = await getRazorpay().payments.refund(row.razorpay_payment_id, {
      amount: Number(row.amount_paise),
      receipt: row.receipt,
      notes: { admin_request: row.id, order_id: order.id, custom_order_id: order.custom_order_id, reason: (row.reason || 'Customer requested refund').slice(0, 200) },
    }, row.idempotency_key);
    return await adopt(sent, resp);
  } catch (e) {
    if (e instanceof RazorpayApiError) {
      if (e.idempotencyConflict) return toReview(sent, 'provider reports the idempotency key was used with a different request');
      if (e.outcomeUnknown || e.retryable || e.kind === 'invalid_response') return defer(sent, e.kind, e);
      if (e.kind === 'invalid_request') return toReview(sent, `refund request refused locally: ${safeError(e, 150)}`);
      // a definite 4xx refusal: the provider did NOT perform the refund
      await settle(sent, 'failed', { id: null });
      await pool.query(`UPDATE admin_refund_requests SET last_error_kind = 'provider_refused', last_error = $2 WHERE id = $1`, [row.id, safeError(e, 400)]);
      return 'failed';
    }
    if (e instanceof PricingError) return defer(sent, 'not_configured', e);       // e.g. keys missing: nothing was sent
    return defer(sent, 'error', e);                                                  // cannot tell what happened: stay uncertain
  }
}

async function step(row: Row): Promise<RefundState> {
  if (ageHours(row.created_at) > GIVE_UP_AFTER_HOURS && row.status !== 'pending') {
    return toReview(row, `still unresolved after ${GIVE_UP_AFTER_HOURS} hours; the provider state could not be established`);
  }
  if (row.status === 'pending' && ageHours(row.created_at) > PENDING_GIVE_UP_DAYS * 24) {
    return toReview(row, `refund still pending at the provider after ${PENDING_GIVE_UP_DAYS} days`);
  }
  if (row.status === 'queued') return submit(row);

  // unknown / pending / submitting with an expired lease: ask the provider what exists BEFORE sending anything again
  let list;
  try {
    list = await getRazorpay().payments.fetchRefunds(row.razorpay_payment_id);
  } catch (e) {
    return defer(row, e instanceof RazorpayApiError ? e.kind : 'error', e);
  }
  const match = list.items.find((r) => r.receipt === row.receipt || (r.notes && (r.notes as any).admin_request === row.id)
    || (row.provider_refund_id !== null && r.id === row.provider_refund_id));
  if (match) return adopt(row, match);
  if (row.status === 'pending') return toReview(row, `provider no longer lists the pending refund ${row.provider_refund_id}`);
  return submit(row);        // not at the provider: the SAME request goes again with the SAME key
}

async function runClaimed(row: Row): Promise<RefundState> {
  try {
    const state = await step(row);
    if (state === 'processed') {
      const order = (await pool.query('SELECT * FROM orders WHERE id = $1', [row.order_id])).rows[0];
      await afterSettled(order);      // a full refund gives stock back once (durable task; also when the worker, not the admin, settled it)
    }
    return state;
  } catch (e) {
    plog('error', 'admin_refund_step_failed', { attempt: row.id, error: safeError(e, 150) });
    await pool.query(`UPDATE admin_refund_requests SET lease_until = NULL, last_error = $2 WHERE id = $1 AND status NOT IN ('processed','failed','needs_review')`, [row.id, safeError(e, 400)]).catch(() => {});
    return 'unknown';
  }
}

/** Work on one admin refund if it is due and nobody else holds it (atomic lease claim). */
export async function processAdminRefund(id: string): Promise<RefundState | 'not_claimed'> {
  const claimed = await pool.query(
    `UPDATE admin_refund_requests SET lease_until = now() + interval '${LEASE_SECONDS} seconds'
      WHERE id = $1 AND status IN ('queued','unknown','pending','submitting') AND next_attempt_at <= now()
        AND (lease_until IS NULL OR lease_until < now()) RETURNING *`, [id]);
  const row: Row | undefined = claimed.rows[0];
  return row ? runClaimed(row) : 'not_claimed';
}

export async function dueAdminRefundIds(limit = 10): Promise<string[]> {
  const r = await pool.query(
    `SELECT id FROM admin_refund_requests WHERE status IN ('queued','unknown','pending','submitting') AND next_attempt_at <= now()
        AND (lease_until IS NULL OR lease_until < now()) ORDER BY next_attempt_at LIMIT $1`, [limit]);
  return r.rows.map((x) => x.id);
}

// ---------------------------------------------------------------------------------------------------- the entry point
const messageFor = (state: RefundState): string => {
  switch (state) {
    case 'unknown': return 'The payment provider did not confirm the refund, and it may or may not have been made. Nothing was recorded on the order. It is re-checked automatically; repeat the same request (same request_id) to retry it, and check the Razorpay dashboard before refunding any other amount.';
    case 'failed': return 'The payment provider did not perform the refund. Nothing was recorded.';
    case 'needs_review': return 'This refund needs a person: the payment provider\'s state could not be established. Check the Razorpay dashboard and the payment review list.';
    default: return '';
  }
};

export async function refundPayment(input: {
  paymentId: string;
  amount?: number;          // rupees; omitted = whatever is still refundable
  requestId?: string;
  reason?: string;
  requestedBy?: string;
}): Promise<RefundResult> {
  // 1. validate and record the request durably (no provider call yet)
  const created = await withTx(async (c) => {
    const order = (await c.query('SELECT * FROM orders WHERE razorpay_payment_id = $1 FOR UPDATE', [input.paymentId])).rows[0];
    if (!order) throw new PricingError('Order not found', 404);

    const automatic = await c.query(`SELECT 1 FROM payment_refund_attempts WHERE razorpay_payment_id = $1 AND status <> 'failed' LIMIT 1`, [input.paymentId]);
    if (automatic.rowCount) throw new PricingError('This payment already has an automatic refund in progress or completed. Check the payment review list before refunding again.', 409);

    const total = Number(order.total_amount);
    const processedSoFar = Number(order.refunded_amount);
    const unresolved = (await c.query(`SELECT * FROM admin_refund_requests WHERE order_id = $1 AND status IN ('queued','submitting','unknown','pending','needs_review')`, [order.id])).rows[0];

    // the same request_id again: never a second refund
    if (input.requestId) {
      const same = (await c.query('SELECT * FROM admin_refund_requests WHERE order_id = $1 AND request_id = $2', [order.id, input.requestId])).rows[0];
      if (same) {
        if (same.lease_until && new Date(same.lease_until).getTime() > Date.now()) throw new PricingError('This refund is being processed right now; wait for it to finish.', 409);
        return { row: same as Row, duplicate: true };
      }
    }
    const remainingAfterProcessed = round2(total - processedSoFar);
    if (remainingAfterProcessed <= 0) throw new PricingError('This order is already fully refunded', 409);
    const reserved = unresolved ? round2(Number(unresolved.amount_paise) / 100) : 0;
    const remaining = round2(remainingAfterProcessed - reserved);

    const amount = input.amount === undefined ? undefined : round2(Number(input.amount));
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) throw new PricingError('Invalid refund amount', 400);

    if (unresolved) {
      // A retry of the SAME refund (no request_id given, same amount) resumes it; anything else must wait for it.
      const sameAmount = Math.round((amount === undefined ? remainingAfterProcessed : amount) * 100) === Number(unresolved.amount_paise);
      const busy = unresolved.lease_until && new Date(unresolved.lease_until).getTime() > Date.now();      // another request is talking to the provider right now
      if (!input.requestId && sameAmount && !busy) return { row: unresolved as Row, duplicate: false };
      throw new PricingError(`An earlier refund of ₹${reserved.toFixed(2)} for this order is still ${unresolved.status === 'pending' ? 'pending at the payment provider' : 'unresolved'}. It must finish before another refund can start (repeat it with request_id "${unresolved.request_id}" to retry it).`, 409);
    }

    const useAmount = amount === undefined ? remaining : amount;
    if (useAmount > remaining) throw new PricingError(`Refund exceeds the refundable balance (₹${remaining.toFixed(2)} left)`, 400);

    const id = crypto.randomUUID();
    const hex = id.replace(/-/g, '');
    await c.query(
      `INSERT INTO admin_refund_requests (id, order_id, razorpay_payment_id, request_id, requested_by, reason, amount_paise, idempotency_key, receipt, lease_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '${LEASE_SECONDS} seconds')`,
      [id, order.id, input.paymentId, input.requestId || `auto-${hex.slice(0, 12)}`, (input.requestedBy || '').slice(0, 100) || null,
        (input.reason || '').slice(0, 500) || null, Math.round(useAmount * 100), `adm_${hex}`, `ar_${hex}`]
    );
    return { row: (await c.query('SELECT * FROM admin_refund_requests WHERE id = $1', [id])).rows[0] as Row, duplicate: false, ownsLease: true };
  });

  const row = created.row;
  const rowNow = async () => (await pool.query('SELECT * FROM admin_refund_requests WHERE id = $1', [row.id])).rows[0];
  const orderNow = async () => (await pool.query('SELECT * FROM orders WHERE id = $1', [row.order_id])).rows[0];

  // 2. a duplicate of an already-settled request returns its recorded result without calling the provider
  let cur = await rowNow();
  if (created.duplicate && ['processed', 'failed'].includes(cur.status)) {
    const order = await orderNow();
    const entry = (order.refunds as any[]).find((r) => r.id === cur.provider_refund_id) || null;
    return { order, refund: cur.status === 'processed' ? entry : null, state: cur.status, duplicate: true, stockRestored: false, requestId: cur.request_id, ...(cur.status === 'failed' ? { error: messageFor('failed') } : {}) };
  }

  // 3. do the provider work now (outside any transaction); the worker finishes whatever is left uncertain
  if (!['processed', 'failed', 'needs_review'].includes(cur.status)) {
    if ((created as any).ownsLease) await runClaimed(row);                       // the creator already holds the lease
    else {
      await pool.query(`UPDATE admin_refund_requests SET next_attempt_at = now() WHERE id = $1 AND status IN ('queued','unknown') AND next_attempt_at > now()`, [row.id]);
      await processAdminRefund(row.id);
    }
    cur = await rowNow();
  }
  const order = await orderNow();
  const state: RefundState = cur.status === 'submitting' || cur.status === 'queued' ? 'unknown' : cur.status;
  const entry = (order.refunds as any[]).find((r) => r.id === cur.provider_refund_id) || null;
  const stockRestored = state === 'processed' && order.stock_restored_at ? true : false;
  return {
    order, refund: state === 'processed' || state === 'pending' ? entry : null, state,
    duplicate: created.duplicate, stockRestored, requestId: cur.request_id,
    ...(['unknown', 'failed', 'needs_review'].includes(state) ? { error: messageFor(state) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------- review resolution
/**
 * Close an admin refund that ended in `needs_review`, using ONLY evidence read from Razorpay. The caller names the provider refund;
 * everything else is checked here:
 *  - the refund is listed by Razorpay for THIS request's payment (so the payment association is proven),
 *  - its amount equals the request's amount and its currency the request's currency,
 *  - its status is final: `processed` settles the request as processed (order, ledger and stock task updated in the same transaction
 *    as for any processed refund); `failed` settles it as failed (nothing moved, order untouched, the order is unblocked);
 *    `pending` is refused (the request stays under review until Razorpay settles it),
 *  - the payment's total refunded amount at Razorpay equals what the order has already recorded, plus this refund if it is processed.
 *    Any other refund on the payment (e.g. one made in the dashboard as well) is a discrepancy a person must investigate first.
 * There is deliberately no way to settle a request without a provider refund id: an operator's note is not evidence, and the absence of
 * a refund in a list cannot prove that none was made.
 */
export async function resolveReviewedAdminRefund(input: { requestId: string; providerRefundId: string; admin: string }) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(input.providerRefundId)) throw new PricingError('Invalid provider refund id', 400);
  const row: (Row & { currency: string }) | undefined = (await pool.query('SELECT * FROM admin_refund_requests WHERE id = $1', [input.requestId])).rows[0];
  if (!row) throw new PricingError('Refund request not found', 404);
  if (row.status !== 'needs_review') throw new PricingError(`This refund request is ${row.status}, not under review.`, 409);

  let refund, payment;
  try {
    const list = await getRazorpay().payments.fetchRefunds(row.razorpay_payment_id);
    refund = list.items.find((r) => r.id === input.providerRefundId);
    payment = await getRazorpay().payments.fetch(row.razorpay_payment_id);
  } catch (e) {
    if (e instanceof RazorpayApiError) throw new PricingError('Razorpay could not be asked right now; try again shortly.', 503);
    throw e;
  }
  if (!refund) throw new PricingError('Razorpay does not list that refund for this payment.', 409);
  if (Number(refund.amount) !== Number(row.amount_paise) || (refund.currency && refund.currency !== row.currency)) {
    throw new PricingError('That refund\'s amount or currency differs from this request; it stays under review.', 409);
  }
  if (refund.status !== 'processed' && refund.status !== 'failed') {
    throw new PricingError(`That refund is ${refund.status} at Razorpay; wait until it is processed or failed.`, 409);
  }
  const order = (await pool.query('SELECT refunded_amount FROM orders WHERE id = $1', [row.order_id])).rows[0];
  const recordedPaise = Math.round(Number(order.refunded_amount) * 100);
  const expected = recordedPaise + (refund.status === 'processed' ? Number(row.amount_paise) : 0);
  if (Number(payment.amount_refunded) !== expected) {
    throw new PricingError('The total refunded on this payment at Razorpay does not match what is recorded plus this refund; another refund exists or is missing. A person must reconcile it first.', 409);
  }

  const claimed = await pool.query(
    `UPDATE admin_refund_requests SET lease_until = now() + interval '${LEASE_SECONDS} seconds', review_reason = $2
      WHERE id = $1 AND status = 'needs_review' RETURNING *`, [row.id, `resolved by ${input.admin.slice(0, 60)} against provider refund ${refund.id}`]);
  if (claimed.rowCount === 0) throw new PricingError('This request changed while it was being resolved.', 409);
  const state = refund.status === 'processed' ? 'processed' : 'failed';
  await settle({ ...row, review_reason: undefined } as Row, state, { id: refund.id, raw: refund });
  if (state === 'processed') {
    const o = (await pool.query('SELECT * FROM orders WHERE id = $1', [row.order_id])).rows[0];
    await afterSettled(o);
  }
  plog('info', 'admin_refund_review_resolved', { attempt: row.id, refund: refund.id, outcome: state });
  return { request_id: row.id, refund_status: state, order: (await pool.query('SELECT status, refunded_amount FROM orders WHERE id = $1', [row.order_id])).rows[0] };
}
