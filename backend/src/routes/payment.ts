import express, { Request, Response } from 'express';
import crypto from 'crypto';
import config from '../config';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { paymentLimiter, refundLimiter, statusLimiter } from '../middleware/rateLimit';
import { PricingError } from '../services/pricing';
import { getRazorpay, RazorpayApiError } from '../services/razorpayClient';
import { refundPayment, resolveReviewedAdminRefund } from '../services/refunds';
import {
  CheckoutClosedError, createCheckout, lookupCustomerStatus,
} from '../services/payments/intents';
import {
  factsFromProviderPayment, findIntentByRazorpayOrder, fulfilCapturedPayment, resolveIntentForUnknownOrder, FulfilResult,
} from '../services/payments/fulfilment';
import { adoptLegacyPayment, legacyWindowOpen } from '../services/payments/legacy';
import { plog, safeError } from '../services/payments/common';
import { acknowledgeReviewWithProviderEvidence, adoptProviderRefund } from '../services/payments/review';

const router = express.Router();

const ID = /^[A-Za-z0-9_-]{3,64}$/;

const sendError = (res: Response, error: any, log: string) => {
  if (error instanceof CheckoutClosedError) return res.status(error.status).json({ success: false, error: error.message, code: 'checkout_closed' });
  if (error instanceof PricingError) return res.status(error.status).json({ success: false, error: error.message });
  console.error(log, safeError(error));
  return res.status(500).json({ success: false, error: 'Payment request failed' });
};

const verifiedResponse = (order: any, paymentId: string) => ({
  success: true,
  message: 'Payment verified successfully',
  order: {
    id: order.id,
    custom_order_id: order.custom_order_id,
    tracking_id: order.custom_order_id,
    payment_id: paymentId,
    amount: order.total_amount,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    created_at: order.created_at,
  },
});

// PUBLIC (rate limited): start a checkout. The server prices the cart and stores the checkout (an "intent") BEFORE it asks
// Razorpay for an order; any amount sent by the browser is ignored. Requires an Idempotency-Key header: repeating the
// request with the same key returns the same checkout instead of creating another.
router.post('/create-order', paymentLimiter, async (req: Request, res: Response) => {
  try {
    const key = (req.header('Idempotency-Key') || '').trim();
    res.json(await createCheckout({ key, body: req.body || {} }));
  } catch (error: any) {
    sendError(res, error, 'Create-order error:');
  }
});

/** The buyer's browser could not get a final answer yet; the payment is safe and will be completed in the background. */
const pending = (res: Response, extra: Record<string, unknown> = {}) =>
  res.status(202).json({
    success: false, pending: true,
    message: 'Your payment was received and we are confirming your order. You will get an email shortly; you do not need to pay again.',
    ...extra,
  });

async function refundReply(res: Response, result: FulfilResult) {
  const attempt = result.refundAttemptId
    ? (await pool.query('SELECT status FROM payment_refund_attempts WHERE id = $1', [result.refundAttemptId])).rows[0]
    : undefined;
  const refunded = attempt?.status === 'processed';
  const why = result.reason ? `${result.reason}` : 'an item you ordered is no longer available.';
  return res.status(409).json({
    success: false,
    error: refunded
      ? `Sorry, ${why} Your payment has been refunded.`
      : `Sorry, ${why} Your payment is being refunded to your original payment method.`,
    refunded,
    refund_pending: !refunded,
  });
}

// PUBLIC (rate limited): the browser reports a finished payment. Nothing the browser says about the cart or the total is
// used: the payment is checked against Razorpay, matched to the stored checkout by its Razorpay order id, and handed to the
// shared fulfilment service (the same one the webhook and the recovery job use).
router.post('/verify-payment', paymentLimiter, async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (
      typeof razorpay_order_id !== 'string' || typeof razorpay_payment_id !== 'string' || typeof razorpay_signature !== 'string' ||
      !ID.test(razorpay_order_id) || !ID.test(razorpay_payment_id)
    ) {
      return res.status(400).json({ success: false, error: 'Missing payment details' });
    }

    // The signature proves Razorpay confirmed this payment for this Razorpay order.
    const expected = crypto.createHmac('sha256', config.razorpayKeySecret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(razorpay_signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }

    let intent = await findIntentByRazorpayOrder(razorpay_order_id);
    if (!intent) {
      // Not attached yet? The Razorpay order may carry our receipt (an order creation whose answer was lost).
      try { intent = await resolveIntentForUnknownOrder(razorpay_order_id); } catch { /* provider trouble: handled when the payment is fetched below */ }
    }

    // The authoritative record of what was paid. If Razorpay cannot be asked right now the payment is NOT lost: the recovery
    // job and the webhook will finish it, so tell the buyer it is being confirmed.
    let payment;
    try {
      payment = await getRazorpay().payments.fetch(razorpay_payment_id);
    } catch (e) {
      if (e instanceof RazorpayApiError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) {
        return res.status(400).json({ success: false, error: 'This payment could not be found.' });
      }
      plog('warn', 'verify_provider_unavailable', { razorpayOrder: razorpay_order_id, payment: razorpay_payment_id, error: safeError(e, 120) });
      if (intent) await pool.query(`UPDATE payment_intents SET next_check_at = now() WHERE id = $1 AND status IN ('created','abandoned')`, [intent.id]).catch(() => {});
      return pending(res);
    }
    if (payment.order_id !== razorpay_order_id) {
      return res.status(400).json({ success: false, error: 'This payment does not belong to this order.' });
    }

    if (!intent) {
      if (!legacyWindowOpen()) {
        plog('warn', 'verify_unknown_order', { razorpayOrder: razorpay_order_id, payment: razorpay_payment_id });
        return res.status(409).json({ success: false, error: 'We could not match this payment to a checkout. Please contact support with your payment id.' });
      }
      intent = await adoptLegacyPayment({ razorpayOrderId: razorpay_order_id, payment, orderData: req.body?.order_data });
    }

    if (payment.status === 'failed') return res.status(402).json({ success: false, error: 'The payment was not successful.' });
    if (!payment.captured) {
      await pool.query(`UPDATE payment_intents SET next_check_at = now() + interval '1 minute' WHERE id = $1 AND status IN ('created','abandoned')`, [intent.id]).catch(() => {});
      return pending(res);
    }

    const facts = factsFromProviderPayment(payment, razorpay_signature);
    if (!facts) return res.status(400).json({ success: false, error: 'This payment does not belong to this order.' });
    const result = await fulfilCapturedPayment(facts, 'browser', intent);

    switch (result.outcome) {
      case 'fulfilled':
      case 'already_fulfilled':
        if (result.order && result.order.razorpay_payment_id === razorpay_payment_id) return res.json(verifiedResponse(result.order, razorpay_payment_id));
        return res.status(409).json({ success: false, error: 'A different payment was already used for this order. Please contact support with your payment id.' });
      case 'refund_required':
        return refundReply(res, result);
      case 'needs_review':
        return res.status(409).json({ success: false, under_review: true, error: 'Your payment is being checked by our team. If you were charged you will hear from us shortly; please contact support with your payment id.' });
      default:
        if (result.intentStatus === 'refund_required' || result.intentStatus === 'refunded') {
          return res.status(409).json({ success: false, error: 'Your payment is being refunded to your original payment method.', refund_pending: true });
        }
        if (result.intentStatus === 'needs_review') {
          return res.status(409).json({ success: false, under_review: true, error: 'Your payment is being checked by our team. Please contact support with your payment id.' });
        }
        return pending(res);
    }
  } catch (error: any) {
    sendError(res, error, 'Payment verification error:');
  }
});

// PUBLIC (rate limited): what happened to my checkout? Needs the Razorpay order id AND the status token returned by
// create-order. A wrong token and an unknown order give the same 404, and no personal data is returned.
router.post('/status', statusLimiter, async (req: Request, res: Response) => {
  try {
    const status = await lookupCustomerStatus(req.body?.razorpay_order_id, req.body?.token);
    if (!status) return res.status(404).json({ error: 'Not found' });
    res.json(status);
  } catch (error: any) {
    console.error('Status lookup error:', safeError(error));
    res.status(500).json({ error: 'Status lookup failed' });
  }
});

// ADMIN ONLY: payments that need a person. Ids, amounts and reasons only - no customer details.
// ?limit (1-200, default 50) and ?offset page each list.
router.get('/review', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset), 10) || 0, 0);
    const [intents, attempts, events, unprocessed, adminRefunds, stockTasks] = await Promise.all([
      pool.query(
        `SELECT id, status, razorpay_order_id, razorpay_payment_id, amount_paise, review_reason, last_error, created_at, updated_at
           FROM payment_intents WHERE status IN ('needs_review','refund_required') AND reviewed_at IS NULL ORDER BY updated_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query(
        `SELECT id, intent_id, razorpay_payment_id, purpose, status, amount_paise, provider_refund_id, attempts, review_reason, last_error_kind, created_at
           FROM payment_refund_attempts WHERE status IN ('needs_review','unknown','pending','submitting','queued') ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query(
        `SELECT event_id, event_type, razorpay_order_id, razorpay_payment_id, received_at, attempts, last_error
           FROM payment_webhook_events WHERE outcome = 'needs_review' ORDER BY received_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query(`SELECT count(*)::int AS n FROM payment_webhook_events WHERE processed_at IS NULL`),
      pool.query(
        `SELECT id, order_id, razorpay_payment_id, request_id, status, amount_paise, provider_refund_id, attempts, review_reason, last_error_kind, created_at
           FROM admin_refund_requests WHERE status IN ('needs_review','unknown','pending','submitting','queued') ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query(
        `SELECT id, order_id, status, attempts, last_error, created_at FROM stock_restoration_tasks WHERE status <> 'done' ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
    ]);
    res.json({ intents: intents.rows, refund_attempts: attempts.rows, webhook_events_needing_review: events.rows, unprocessed_webhook_events: unprocessed.rows[0].n, admin_refund_requests: adminRefunds.rows, stock_restoration_tasks: stockTasks.rows });
  } catch (error: any) {
    console.error('Review list error:', safeError(error));
    res.status(500).json({ error: 'Failed to load payment review list' });
  }
});

// ADMIN ONLY: close a review case whose money was returned outside the automatic workflow (e.g. a dashboard refund).
// The refund id is verified AT RAZORPAY (same payment, status processed, amount = captured amount); a note alone changes
// nothing. The action and the admin's name are recorded on the intent and the refund attempt.
router.post('/review/:intentId/adopt-refund', requireAuth, refundLimiter, async (req: Request, res: Response) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.intentId)) return res.status(400).json({ success: false, error: 'Invalid case id' });
    const { provider_refund_id, note } = req.body || {};
    if (typeof provider_refund_id !== 'string') return res.status(400).json({ success: false, error: 'provider_refund_id is required' });
    const r = await adoptProviderRefund({ intentId: req.params.intentId, providerRefundId: provider_refund_id, admin: req.admin?.username || 'admin', note: typeof note === 'string' ? note : undefined });
    res.json({ success: true, ...r });
  } catch (error: any) {
    if (error instanceof PricingError) return res.status(error.status).json({ success: false, error: error.message });
    console.error('Adopt refund error:', safeError(error));
    res.status(500).json({ success: false, error: 'Failed to close the case' });
  }
});

// ADMIN ONLY: take an amount/identity-mismatch case off the open list once the payment is fully refunded AT RAZORPAY.
router.post('/review/:intentId/acknowledge', requireAuth, refundLimiter, async (req: Request, res: Response) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.intentId)) return res.status(400).json({ success: false, error: 'Invalid case id' });
    const { payment_id, note } = req.body || {};
    if (typeof payment_id !== 'string') return res.status(400).json({ success: false, error: 'payment_id is required' });
    const r = await acknowledgeReviewWithProviderEvidence({ intentId: req.params.intentId, paymentId: payment_id, admin: req.admin?.username || 'admin', note: typeof note === 'string' ? note : undefined });
    res.json({ success: true, ...r });
  } catch (error: any) {
    if (error instanceof PricingError) return res.status(error.status).json({ success: false, error: error.message });
    console.error('Acknowledge error:', safeError(error));
    res.status(500).json({ success: false, error: 'Failed to acknowledge the case' });
  }
});

// ADMIN ONLY: close an admin refund that ended in needs_review. The named Razorpay refund is verified at Razorpay (listed for the
// request's payment, same amount and currency, final status, and the payment's total refunded amount reconciles) before anything changes.
router.post('/review/admin-refund/:requestId/resolve', requireAuth, refundLimiter, async (req: Request, res: Response) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.requestId)) return res.status(400).json({ success: false, error: 'Invalid request id' });
    const { provider_refund_id } = req.body || {};
    if (typeof provider_refund_id !== 'string') return res.status(400).json({ success: false, error: 'provider_refund_id is required' });
    res.json({ success: true, ...(await resolveReviewedAdminRefund({ requestId: req.params.requestId, providerRefundId: provider_refund_id, admin: req.admin?.username || 'admin' })) });
  } catch (error: any) {
    if (error instanceof PricingError) return res.status(error.status).json({ success: false, error: error.message });
    console.error('Resolve admin refund error:', safeError(error));
    res.status(500).json({ success: false, error: 'Failed to resolve the refund request' });
  }
});

// ADMIN ONLY: payment details by Razorpay order id.
router.get('/order/:orderId', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT razorpay_order_id, razorpay_payment_id, payment_method, status, total_amount, custom_order_id
       FROM orders WHERE razorpay_order_id = $1`,
      [req.params.orderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// ADMIN ONLY: refund an online payment. `amount` is in rupees (omitted = the full refundable balance).
// Optional `request_id` makes a retry safe: the same id returns the recorded refund without a second provider call.
// Success is reported only when Razorpay confirmed the refund; partial refunds set the order to 'partially_refunded'.
router.post('/refund/:paymentId', requireAuth, refundLimiter, async (req: Request, res: Response) => {
  try {
    const { amount, notes, request_id } = req.body || {};
    if (amount !== undefined && !(Number(amount) > 0)) return res.status(400).json({ success: false, error: 'Invalid refund amount' });
    if (request_id !== undefined && (typeof request_id !== 'string' || request_id.length > 100)) {
      return res.status(400).json({ success: false, error: 'Invalid request_id' });
    }

    const result = await refundPayment({
      paymentId: req.params.paymentId,
      amount: amount === undefined ? undefined : Number(amount),
      requestId: request_id,
      reason: typeof notes === 'string' ? notes : undefined,
      requestedBy: req.admin?.username,
    });

    const summary = {
      request_id: result.requestId,
      refund_status: result.state,
      order_status: result.order.status,
      refunded_amount: Number(result.order.refunded_amount),   // provider-CONFIRMED (processed) refunds only
    };
    if (result.state === 'processed') {
      return res.json({
        success: true,
        message: result.duplicate ? 'This refund request was already processed' : result.order.status === 'refunded' ? 'Order fully refunded' : 'Partial refund recorded',
        duplicate: result.duplicate, refund: result.refund, stock_restored: result.stockRestored, ...summary,
      });
    }
    if (result.state === 'pending') {
      // accepted by Razorpay but not yet paid out: nothing is counted as refunded until it is processed
      return res.status(202).json({
        success: true, pending: true,
        message: 'Razorpay accepted the refund and is still processing it. The order is not marked refunded until Razorpay confirms it; this is checked automatically.',
        refund: result.refund, ...summary,
      });
    }
    return res.status(result.state === 'failed' ? 502 : result.state === 'needs_review' ? 409 : 502).json({ success: false, error: result.error, ...summary });
  } catch (error: any) {
    if (error instanceof PricingError) return res.status(error.status).json({ success: false, error: error.message });
    console.error('Refund error:', error);
    res.status(500).json({ success: false, error: 'Failed to process refund' });
  }
});

export default router;
