// The ONE place a captured Razorpay payment becomes an order (or a queued refund, or a review case).
// Browser verification, webhooks and the recovery job all call fulfilCapturedPayment(); none of them creates orders itself.
//
// Transaction boundary: the intent row is locked FOR UPDATE, and in that single transaction we save the order, take stock,
// consume the coupon, mark the intent fulfilled and queue the notifications. A crash anywhere rolls the lot back and the
// payment is picked up again; a repeat after commit finds `fulfilled` and changes nothing. No e-mail is sent before commit.
//
// What is trusted: only the intent's stored snapshot (server-priced at create-order time). Nothing from the browser's
// cart, totals or order_data is used. Provider facts are compared with the snapshot; any difference goes to review.
import type { PoolClient } from 'pg';
import { pool } from '../../utils/db';
import { createOrderInTx, CleanCustomer } from '../orderService';
import { StockError } from '../pricing';
import { getRazorpay, ProviderPayment, RazorpayApiError } from '../razorpayClient';
import { IntentRow, attachProviderOrder } from './intents';
import { intentIdFromReceipt, plog, safeError } from './common';
import { enqueueNotification, flushOutbox } from './outbox';
import { processRefundAttempt, queueRefundAttempt } from './refunds';
import { withTx } from './tx';

export type FulfilSource = 'browser' | 'webhook' | 'recovery' | 'legacy';

/** What the provider says about one captured payment. Never includes customer contact or card data. */
export interface CaptureFacts {
  razorpayOrderId: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  method?: string | null;
  signature?: string | null;          // browser path only (stored on the order, as before)
  refundedPaise?: number;             // already refunded at the provider (anything > 0 is not auto-fulfilled)
}

export type FulfilOutcome = 'fulfilled' | 'already_fulfilled' | 'refund_required' | 'needs_review' | 'noop' | 'unknown_order';

export interface FulfilResult {
  outcome: FulfilOutcome;
  intentId?: string;
  intentStatus?: string;
  order?: any;
  reason?: string;
  refundAttemptId?: string;
  couponOverLimit?: boolean;
}

export function factsFromProviderPayment(p: ProviderPayment, signature?: string | null): CaptureFacts | null {
  if (!p.order_id) return null;
  return { razorpayOrderId: p.order_id, paymentId: p.id, amountPaise: p.amount, currency: p.currency, method: p.method, signature, refundedPaise: p.amount_refunded };
}

export async function findIntentByRazorpayOrder(razorpayOrderId: string): Promise<IntentRow | undefined> {
  return (await pool.query('SELECT * FROM payment_intents WHERE razorpay_order_id = $1', [razorpayOrderId])).rows[0];
}

/**
 * An order id we have no intent for. It may still be ours: if the intent's Razorpay order was created but never attached
 * (the answer was lost and the process died), the provider order carries our receipt. Look it up and attach it.
 * Throws on a provider outage (the caller retries); returns undefined when the order is not ours.
 */
export async function resolveIntentForUnknownOrder(razorpayOrderId: string): Promise<IntentRow | undefined> {
  const order = await getRazorpay().orders.fetch(razorpayOrderId).catch((e: unknown) => {
    if (e instanceof RazorpayApiError && e.status !== undefined && e.status >= 400 && e.status < 500) return null;   // not an order of ours / not found
    throw e;
  });
  const intentId = intentIdFromReceipt(order?.receipt);
  if (!order || !intentId) return undefined;
  const intent = (await pool.query('SELECT * FROM payment_intents WHERE id = $1', [intentId])).rows[0] as IntentRow | undefined;
  if (!intent) return undefined;
  if (intent.razorpay_order_id) return intent.razorpay_order_id === razorpayOrderId ? intent : undefined;
  if (Number(order.amount) !== Number(intent.amount_paise) || order.currency !== intent.currency) return undefined;
  plog('warn', 'order_attached_late', { intent: intent.id, razorpayOrder: razorpayOrderId });
  return attachProviderOrder(intent.id, razorpayOrderId);
}

const clip = (s: string, n = 290) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Park an intent for a human, in the caller's transaction, and raise an alert. No refund and no order is created. */
async function review(c: PoolClient, intent: IntentRow, reason: string, alertKey: string): Promise<FulfilResult> {
  await c.query(`UPDATE payment_intents SET status = 'needs_review', review_reason = $2 WHERE id = $1 AND status IN ('created','abandoned','refund_required')`, [intent.id, clip(reason)]);
  await enqueueNotification(c, {
    kind: 'admin_alert', dedupeKey: `intent:${intent.id}:review:${alertKey}`, recipient: 'admin', intentId: intent.id,
    payload: { subject: 'Payment needs review', reason: alertKey, detail: clip(reason, 250) },
  });
  plog('warn', 'needs_review', { intent: intent.id, reason: alertKey });
  return { outcome: 'needs_review', intentId: intent.id, intentStatus: 'needs_review', reason };
}

async function alertOnly(c: PoolClient, intent: IntentRow, alertKey: string, detail: string): Promise<void> {
  await enqueueNotification(c, {
    kind: 'admin_alert', dedupeKey: `intent:${intent.id}:alert:${alertKey}`, recipient: 'admin', intentId: intent.id,
    payload: { subject: 'Payment needs attention', reason: alertKey, detail: clip(detail, 250) },
  });
}

async function decide(c: PoolClient, intent: IntentRow, facts: CaptureFacts, source: FulfilSource): Promise<FulfilResult> {
  const base = { intentId: intent.id, intentStatus: intent.status };

  // Terminal / admin-owned states never move automatically. A DIFFERENT payment on the same Razorpay order is a possible
  // double charge: nothing is refunded automatically, an administrator is told.
  if (['fulfilled', 'refunded', 'refund_required', 'needs_review'].includes(intent.status)) {
    if (intent.razorpay_payment_id && intent.razorpay_payment_id !== facts.paymentId) {
      await alertOnly(c, intent, `duplicate_payment:${facts.paymentId}`, `A second payment (${facts.paymentId}) was captured for this checkout. Check Razorpay and refund it if it is a duplicate.`);
      return { outcome: 'noop', ...base, reason: 'a different payment was already recorded for this checkout' };
    }
    if (intent.status === 'needs_review' && !intent.razorpay_payment_id) return { outcome: 'noop', ...base, reason: 'checkout is under review' };
    if (intent.status === 'fulfilled') {
      const order = (await c.query('SELECT * FROM orders WHERE id = $1', [intent.order_id])).rows[0];
      return { outcome: 'already_fulfilled', ...base, order };
    }
    return { outcome: 'noop', ...base };
  }

  // created / abandoned (a late payment on an abandoned checkout is honoured)
  if (facts.currency !== intent.currency) return review(c, intent, `currency mismatch: payment ${facts.paymentId} is ${facts.currency}, expected ${intent.currency}`, 'currency_mismatch');
  if (facts.amountPaise !== Number(intent.amount_paise)) {
    return review(c, intent, `amount mismatch: payment ${facts.paymentId} captured ${facts.amountPaise} paise, expected ${intent.amount_paise}`, 'amount_mismatch');
  }
  if ((facts.refundedPaise ?? 0) > 0) return review(c, intent, `payment ${facts.paymentId} was already refunded at the provider before the order was created`, 'refunded_before_fulfilment');

  await c.query('SAVEPOINT fulfil');
  try {
    const { order, couponOverLimit } = await createOrderInTx(c, {
      quote: intent.quote,
      customer: intent.customer as CleanCustomer,
      paymentMethod: 'online',
      payment: { order_id: facts.razorpayOrderId, payment_id: facts.paymentId, signature: facts.signature ?? null },
    }, { couponPolicy: 'honour' });

    await c.query(
      `UPDATE payment_intents SET razorpay_payment_id = $2, payment_method = $3, captured_at = now(), order_id = $4,
              fulfilled_at = now(), status = 'fulfilled', last_error = NULL, review_reason = NULL
        WHERE id = $1`,
      [intent.id, facts.paymentId, facts.method ?? null, order.id]
    );
    await enqueueNotification(c, { kind: 'order_confirmation', dedupeKey: `order:${order.id}:confirmation`, recipient: 'customer', orderId: order.id, intentId: intent.id });
    await enqueueNotification(c, { kind: 'admin_new_order', dedupeKey: `order:${order.id}:admin`, recipient: 'admin', orderId: order.id, intentId: intent.id });
    if (couponOverLimit) {
      // Policy: the customer already paid the discounted price, so the order stands; the overshoot is surfaced to the owner.
      await enqueueNotification(c, {
        kind: 'admin_alert', dedupeKey: `order:${order.id}:coupon-over-limit`, recipient: 'admin', orderId: order.id, intentId: intent.id,
        payload: { subject: 'Coupon limit exceeded by a paid order', reason: 'coupon_over_limit', detail: `coupon ${intent.coupon_code ?? ''} was used beyond its limit by a payment already made` },
      });
    }
    await c.query('RELEASE SAVEPOINT fulfil');
    plog('info', 'fulfilled', { intent: intent.id, order: order.id, payment: facts.paymentId, source, amountPaise: facts.amountPaise });
    return { outcome: 'fulfilled', intentId: intent.id, intentStatus: 'fulfilled', order, couponOverLimit };
  } catch (e: any) {
    await c.query('ROLLBACK TO SAVEPOINT fulfil');
    if (e instanceof StockError) {
      // Paid, but the goods are gone: refund the FULL amount through the durable refund workflow (queued in this same transaction).
      await c.query(
        `UPDATE payment_intents SET status = 'refund_required', razorpay_payment_id = $2, payment_method = $3, captured_at = now(), last_error = $4 WHERE id = $1`,
        [intent.id, facts.paymentId, facts.method ?? null, clip(e.message, 400)]
      );
      const attemptId = await queueRefundAttempt(c, { id: intent.id, razorpay_payment_id: facts.paymentId, amount_paise: intent.amount_paise, currency: intent.currency });
      await enqueueNotification(c, {
        kind: 'payment_refund_notice', dedupeKey: `intent:${intent.id}:refund-notice`, recipient: 'customer', intentId: intent.id,
        payload: { reasonText: `${e.message}` },
      });
      await alertOnly(c, intent, 'stock_failure_refund', `Paid but out of stock; a full refund of attempt ${attemptId} was queued.`);
      plog('warn', 'stock_failure_refund_queued', { intent: intent.id, payment: facts.paymentId, attempt: attemptId, source });
      return { outcome: 'refund_required', ...base, intentStatus: 'refund_required', refundAttemptId: attemptId, reason: e.message };
    }
    if (e?.code === '23505') {
      // An order already carries this payment id (it did not come through this path): do not guess, ask a human.
      return review(c, intent, `an order already exists for payment ${facts.paymentId}`, 'order_already_exists');
    }
    throw e;
  }
}

/** After commit, best effort: send the queued e-mails and start the refund. Failures stay queued for the recovery job. */
async function afterCommit(result: FulfilResult): Promise<void> {
  try {
    if (result.refundAttemptId) await processRefundAttempt(result.refundAttemptId);
    if (result.intentId && (result.outcome === 'fulfilled' || result.outcome === 'refund_required' || result.outcome === 'needs_review' || result.outcome === 'noop')) {
      // Not awaited: SMTP can take tens of seconds and must not delay the buyer's response. flushOutbox never throws and
      // leaves failures queued for the worker.
      void flushOutbox({ intentId: result.intentId });
    }
  } catch (e) {
    plog('error', 'after_commit_failed', { intent: result.intentId, error: safeError(e, 150) });
  }
}

/**
 * Turn a captured payment into exactly one order, or one refund, or a review case. Idempotent and safe to run concurrently
 * from the browser, webhook and recovery paths. Throws on infrastructure errors (nothing is committed; retry later).
 */
export async function fulfilCapturedPayment(facts: CaptureFacts, source: FulfilSource, known?: IntentRow): Promise<FulfilResult> {
  const intent0 = known ?? await findIntentByRazorpayOrder(facts.razorpayOrderId) ?? await resolveIntentForUnknownOrder(facts.razorpayOrderId);
  if (!intent0) return { outcome: 'unknown_order' };

  const result = await withTx(async (c) => {
    const locked = (await c.query('SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE', [intent0.id])).rows[0] as IntentRow;
    if (locked.razorpay_order_id !== facts.razorpayOrderId) {
      return { outcome: 'noop', intentId: locked.id, intentStatus: locked.status, reason: 'payment belongs to a different Razorpay order' } as FulfilResult;
    }
    return decide(c, locked, facts, source);
  });
  await afterCommit(result);
  return result;
}

/**
 * Ask the provider what happened to an intent's Razorpay order and act on it (used by the recovery job and for webhook events
 * that arrived without enough detail). Returns what it found.
 */
export async function reconcileIntentWithProvider(intent: IntentRow): Promise<{ found: 'captured' | 'authorized' | 'failed_only' | 'none'; result?: FulfilResult }> {
  if (!intent.razorpay_order_id) return { found: 'none' };
  const payments = await getRazorpay().orders.fetchPayments(intent.razorpay_order_id);
  const captured = payments.items.filter((p) => p.captured && p.order_id === intent.razorpay_order_id)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  if (captured.length === 0) {
    if (payments.items.some((p) => p.status === 'authorized')) return { found: 'authorized' };
    return { found: payments.items.length ? 'failed_only' : 'none' };
  }
  const facts = factsFromProviderPayment(captured[0]);
  if (!facts) return { found: 'none' };
  const result = await fulfilCapturedPayment(facts, 'recovery', intent);
  for (const extra of captured.slice(1)) {
    await fulfilCapturedPayment({ ...factsFromProviderPayment(extra)! }, 'recovery', intent);   // records a duplicate-payment alert
  }
  return { found: 'captured', result };
}
