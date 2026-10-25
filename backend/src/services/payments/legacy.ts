// Time-boxed bridge for payments started BEFORE payment intents existed (the Razorpay order was created by the old code and
// has no intent). Off unless BOTH INTENTS_ENABLED_AT and LEGACY_VERIFY_UNTIL are set; the window is at most 24 hours after
// INTENTS_ENABLED_AT (enforced at start-up); and it only accepts Razorpay orders created before INTENTS_ENABLED_AT.
// It does NOT trust the browser: the caller has already verified the payment signature and fetched the payment from Razorpay;
// the cart/customer from the browser are re-priced on the server and must equal the amount actually captured.
import crypto from 'crypto';
import config from '../../config';
import { pool } from '../../utils/db';
import { priceCart, PricingError } from '../pricing';
import { cleanCustomer } from '../orderService';
import { getRazorpay, ProviderPayment } from '../razorpayClient';
import { hashStatusToken, plog, statusTokenFor } from './common';
import { IntentRow, requestHash } from './intents';

export function legacyWindowOpen(now: Date = new Date()): boolean {
  const from = config.intentsEnabledAt;
  const until = config.legacyVerifyUntil;
  return !!from && !!until && now.getTime() >= from.getTime() && now.getTime() <= until.getTime();
}

export async function adoptLegacyPayment(input: { razorpayOrderId: string; payment: ProviderPayment; orderData: any }): Promise<IntentRow> {
  const { razorpayOrderId, payment, orderData } = input;
  if (!legacyWindowOpen()) throw new PricingError('This payment cannot be matched to a checkout. Please contact support with your payment id.', 409);

  const providerOrder = await getRazorpay().orders.fetch(razorpayOrderId);
  const createdMs = providerOrder.created_at === null ? NaN : Number(providerOrder.created_at) * 1000;
  if (!Number.isFinite(createdMs) || createdMs >= (config.intentsEnabledAt as Date).getTime()) {
    throw new PricingError('This payment cannot be matched to a checkout. Please contact support with your payment id.', 409);
  }
  if (providerOrder.amount !== payment.amount || providerOrder.currency !== payment.currency) {
    throw new PricingError('This payment cannot be matched to a checkout. Please contact support with your payment id.', 409);
  }

  const customer = cleanCustomer(orderData);
  // Re-price from the database. The soft stock check is skipped: the customer has already paid, and the atomic decrement at
  // fulfilment turns a shortage into a refund instead of a rejected request.
  const quote = await priceCart(pool, orderData?.items, {
    couponCode: orderData?.coupon_code, email: customer.email, paymentMethod: 'online', skipStockCheck: true,
  });
  if (Math.round(quote.total_amount * 100) !== payment.amount) {
    plog('warn', 'legacy_amount_mismatch', { razorpayOrder: razorpayOrderId, payment: payment.id, amountPaise: payment.amount });
    throw new PricingError('Your cart total changed since payment started. Please contact support with your payment id.', 409);
  }

  const id = crypto.randomUUID();
  const inserted = await pool.query(
    `INSERT INTO payment_intents (id, origin, status, snapshot_hash, razorpay_order_id, amount_paise, currency, quote, customer, coupon_code, status_token_hash)
     VALUES ($1,'legacy','created',$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
     ON CONFLICT (razorpay_order_id) DO NOTHING RETURNING *`,
    [id, requestHash(orderData?.items, orderData?.coupon_code, customer), razorpayOrderId, payment.amount, payment.currency,
      JSON.stringify(quote), JSON.stringify(customer), quote.coupon?.code ?? null, hashStatusToken(statusTokenFor(id))]
  );
  const intent: IntentRow = inserted.rows[0]
    ?? (await pool.query('SELECT * FROM payment_intents WHERE razorpay_order_id = $1', [razorpayOrderId])).rows[0];
  plog('warn', 'legacy_intent_adopted', { intent: intent.id, razorpayOrder: razorpayOrderId, payment: payment.id });
  return intent;
}
