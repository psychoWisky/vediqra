// Durable checkout intents: what the server priced and who is buying is committed BEFORE the Razorpay order exists, so a
// payment can always be traced back to an immutable snapshot, whatever happens to the browser afterwards.
import crypto from 'crypto';
import config from '../../config';
import { pool } from '../../utils/db';
import { priceCart, PricingError } from '../pricing';
import { cleanCustomer } from '../orderService';
import { getRazorpay, RazorpayApiError, ProviderOrder } from '../razorpayClient';
import {
  canonicalJson, hashStatusToken, plog, receiptForIntent, safeEqual, safeError, sha256Hex, statusTokenFor,
} from './common';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The checkout this Idempotency-Key belonged to has ended (paid, expired or cancelled): start a new attempt with a new key. */
export class CheckoutClosedError extends PricingError {
  constructor() {
    super('This checkout attempt has already ended. Please start a new one.', 409);
  }
}
/** Razorpay could not be reached or did not answer: the same request (same key) is safe to repeat. */
export class ProviderUnavailableError extends PricingError {
  constructor(message = 'The payment service is busy. Please try again in a moment.') {
    super(message, 503);
  }
}

export interface IntentRow {
  id: string; idempotency_key: string | null; snapshot_hash: string; origin: string; status: string;
  razorpay_order_id: string | null; amount_paise: string | number; currency: string; quote: any; customer: any;
  coupon_code: string | null; status_token_hash: string | null; razorpay_payment_id: string | null; order_id: string | null;
  captured_at: Date | null; created_at: Date; check_failures: number; review_reason: string | null; last_error: string | null;
  payment_method: string | null;
}

export interface CheckoutResponse {
  id: string; amount: number; currency: string; receipt: string; key_id: string; total_amount: number; status_token: string;
}

/**
 * Hash of the buyer's request (cart lines as sent, coupon, normalised customer). The same Idempotency-Key may be repeated
 * only with the same hash. Prices are NOT part of it: a repeat must return the original checkout even if prices changed.
 */
export function requestHash(items: unknown, couponCode: unknown, customer: unknown): string {
  const coupon = typeof couponCode === 'string' && couponCode.trim() ? couponCode.trim().toUpperCase() : null;
  return sha256Hex(canonicalJson({ v: 1, items, coupon, customer }));
}

const selectByKey = async (key: string): Promise<IntentRow | undefined> =>
  (await pool.query('SELECT * FROM payment_intents WHERE idempotency_key = $1', [key])).rows[0];

function responseFor(intent: IntentRow): CheckoutResponse {
  return {
    id: intent.razorpay_order_id as string,
    amount: Number(intent.amount_paise),
    currency: intent.currency,
    receipt: receiptForIntent(intent.id),
    key_id: config.razorpayKeyId,          // public key id, so the storefront needs no hardcoded key
    total_amount: Number(intent.amount_paise) / 100,
    status_token: statusTokenFor(intent.id),
  };
}

/** Find the Razorpay order that carries this intent's receipt (it exists if a creation call succeeded but its answer was lost). */
async function findProviderOrder(intent: IntentRow): Promise<ProviderOrder | null> {
  const found = await getRazorpay().orders.fetchByReceipt(receiptForIntent(intent.id));
  const hit = found.items.find((o) => o.receipt === receiptForIntent(intent.id));
  if (!hit) return null;
  if (hit.amount !== Number(intent.amount_paise) || hit.currency !== intent.currency) {
    throw new Error(`provider order ${hit.id} does not match intent ${intent.id} (amount or currency)`);
  }
  return hit;
}

/** Attach a provider order to a preparing/abandoned intent. If another request attached one first, THAT one wins. */
export async function attachProviderOrder(intentId: string, razorpayOrderId: string): Promise<IntentRow> {
  const upd = await pool.query(
    `UPDATE payment_intents
        SET razorpay_order_id = $2, status = CASE WHEN status = 'preparing' THEN 'created' ELSE status END,
            next_check_at = COALESCE(next_check_at, now() + interval '15 minutes')
      WHERE id = $1 AND razorpay_order_id IS NULL AND status IN ('preparing','abandoned')
      RETURNING *`,
    [intentId, razorpayOrderId]
  );
  if (upd.rows[0]) return upd.rows[0];
  const cur = (await pool.query('SELECT * FROM payment_intents WHERE id = $1', [intentId])).rows[0];
  if (!cur) throw new Error('intent disappeared');
  return cur;
}

/**
 * Make sure the intent has its Razorpay order, reconciling an earlier ambiguous creation: look the order up by receipt
 * first; create it only when it does not exist. Safe to run concurrently (receipts are unique at Razorpay, and the attach
 * keeps the first order attached). Leaves the intent `preparing` on any failure so the next call (or the recovery job)
 * resumes it.
 */
export async function ensureProviderOrder(intent: IntentRow): Promise<IntentRow> {
  if (intent.razorpay_order_id) return intent;
  const rzp = getRazorpay();
  const receipt = receiptForIntent(intent.id);
  try {
    let order = await findProviderOrder(intent);
    if (!order) {
      try {
        order = await rzp.orders.create({
          amount: Number(intent.amount_paise), currency: intent.currency, receipt,
          payment_capture: 1, notes: { intent: intent.id },
        }) as ProviderOrder;
      } catch (e) {
        // A concurrent request created it between our lookup and our create (receipts are unique): use that one.
        if (e instanceof RazorpayApiError && e.status === 400 && /receipt/i.test(e.description || '')) {
          order = await findProviderOrder(intent);
        }
        if (!order) throw e;
      }
    }
    return await attachProviderOrder(intent.id, order.id);
  } catch (e) {
    plog('warn', 'order_creation_unresolved', { intent: intent.id, kind: e instanceof RazorpayApiError ? e.kind : 'error', error: safeError(e, 150) });
    if (e instanceof RazorpayApiError) {
      if (e.outcomeUnknown || e.retryable) throw new ProviderUnavailableError();
      throw new PricingError('The payment service could not start this payment. Please try again.', 502);
    }
    throw e;
  }
}

/**
 * Recovery of a `preparing` intent that nobody came back for: look for the order it may have created at Razorpay and attach it;
 * if there is none and the intent is old, abandon it (a late payment on a Razorpay order we cannot see is still found later
 * through its receipt, see resolveIntentForUnknownOrder). Never creates an order.
 */
export async function reconcilePreparing(intent: IntentRow, abandonAfterMs = 30 * 60_000): Promise<'attached' | 'abandoned' | 'waiting'> {
  if (intent.razorpay_order_id) return 'attached';
  const found = await findProviderOrder(intent);
  if (found) { await attachProviderOrder(intent.id, found.id); return 'attached'; }
  if (Date.now() - new Date(intent.created_at).getTime() >= abandonAfterMs) {
    await pool.query(`UPDATE payment_intents SET status = 'abandoned', next_check_at = now() + interval '1 day' WHERE id = $1 AND status = 'preparing'`, [intent.id]);
    return 'abandoned';
  }
  return 'waiting';
}

/**
 * POST /create-order. Persists the intent (state `preparing`) BEFORE calling Razorpay.
 *  - same Idempotency-Key + same request -> the existing checkout (no second intent, no second Razorpay order)
 *  - same key + different request -> 409
 *  - concurrent first requests with one key -> exactly one intent (unique key + ON CONFLICT)
 */
export async function createCheckout(input: { key: string; body: any }): Promise<CheckoutResponse> {
  const { key, body } = input;
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new PricingError('An Idempotency-Key header (16-128 letters, digits, - or _) is required.', 400);
  }
  const customer = cleanCustomer(body);
  const items = body?.items;
  const hash = requestHash(items, body?.coupon_code, customer);

  const resume = async (existing: IntentRow): Promise<CheckoutResponse> => {
    if (existing.snapshot_hash !== hash) {
      throw new PricingError('This Idempotency-Key was already used for a different checkout.', 409);
    }
    if (existing.status !== 'preparing' && existing.status !== 'created') throw new CheckoutClosedError();
    return responseFor(await ensureProviderOrder(existing));
  };

  const prior = await selectByKey(key);
  if (prior) return resume(prior);

  const quote = await priceCart(pool, items, {
    couponCode: body?.coupon_code,
    email: customer.email,
    paymentMethod: 'online',
  });
  const amountPaise = Math.round(quote.total_amount * 100);
  if (amountPaise < 100) throw new PricingError('Order total is too low for online payment');

  const id = crypto.randomUUID();
  const inserted = await pool.query(
    `INSERT INTO payment_intents (id, idempotency_key, snapshot_hash, amount_paise, currency, quote, customer, coupon_code, status_token_hash)
     VALUES ($1,$2,$3,$4,'INR',$5::jsonb,$6::jsonb,$7,$8)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [id, key, hash, amountPaise, JSON.stringify(quote), JSON.stringify(customer), quote.coupon?.code ?? null, hashStatusToken(statusTokenFor(id))]
  );
  let intent: IntentRow | undefined = inserted.rows[0];
  if (!intent) {                                    // lost the race to a concurrent request with the same key
    const winner = await selectByKey(key);
    if (!winner) throw new Error('intent insert conflicted but no row exists');
    return resume(winner);
  }
  plog('info', 'intent_created', { intent: intent.id, amountPaise });
  intent = await ensureProviderOrder(intent);
  return responseFor(intent);
}

// ------------------------------------------------------------------------------------------------ status lookup
export interface CustomerStatus {
  state: 'awaiting_payment' | 'confirmed' | 'refund_pending' | 'refunded' | 'under_review';
  message: string;
  order_id?: string;
  order_number?: string;
}

const NOT_A_TOKEN = 'x'.repeat(43);

/**
 * What a buyer may see about their checkout. Returns null for BOTH "no such checkout" and "wrong token" (identical, so the
 * endpoint cannot be used to discover which Razorpay order ids exist). No personal data is returned.
 */
export async function lookupCustomerStatus(razorpayOrderId: unknown, token: unknown): Promise<CustomerStatus | null> {
  const okShape = typeof razorpayOrderId === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(razorpayOrderId)
    && typeof token === 'string' && token.length >= 20 && token.length <= 100;
  const row = okShape
    ? (await pool.query(
      `SELECT i.status, i.status_token_hash, i.order_id, o.custom_order_id
         FROM payment_intents i LEFT JOIN orders o ON o.id = i.order_id WHERE i.razorpay_order_id = $1`, [razorpayOrderId])).rows[0]
    : undefined;
  // Always hash and compare, so a missing checkout takes the same path as a wrong token.
  const given = hashStatusToken(okShape ? (token as string) : NOT_A_TOKEN);
  const stored = row?.status_token_hash || hashStatusToken('no-such-checkout');
  if (!row || !row.status_token_hash || !safeEqual(given, stored)) return null;

  switch (row.status) {
    case 'fulfilled':
      return { state: 'confirmed', message: 'Your payment was received and your order is confirmed.', order_id: row.order_id, order_number: row.custom_order_id };
    case 'refund_required':
      return { state: 'refund_pending', message: 'An item became unavailable after your payment. Your payment is being refunded to your original payment method.' };
    case 'refunded':
      return { state: 'refunded', message: 'Your payment has been refunded to your original payment method.' };
    case 'needs_review':
      return { state: 'under_review', message: 'Our team is checking your payment. If you were charged you will hear from us shortly; you can also contact support with your payment reference.' };
    default:
      return { state: 'awaiting_payment', message: 'We have not seen a completed payment for this checkout yet. If you were charged, your order will be confirmed automatically.' };
  }
}
