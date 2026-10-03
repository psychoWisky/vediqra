import express, { Request, Response } from 'express';
import crypto from 'crypto';
import config from '../config';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { paymentLimiter, refundLimiter } from '../middleware/rateLimit';
import { priceCart, PricingError, StockError } from '../services/pricing';
import { getRazorpay } from '../services/razorpayClient';
import { refundPayment } from '../services/refunds';
import { cleanCustomer, createOrder } from '../services/orderService';
import {
  sendOrderConfirmationEmail,
  sendAdminNotification,
} from '../services/gmailService';

const router = express.Router();

const sendError = (res: Response, error: any, log: string) => {
  if (error instanceof PricingError) return res.status(error.status).json({ success: false, error: error.message });
  console.error(log, error);
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

/** Paid, but the goods ran out before the order could be saved: refund and tell the customer. */
async function refundAfterStockFailure(res: Response, paymentId: string, reason: string) {
  let refunded = false;
  try {
    await getRazorpay().payments.refund(paymentId, {
      notes: { reason: `Out of stock after payment: ${reason}`.slice(0, 250) },
    });
    refunded = true;
  } catch (e) {
    console.error('AUTO-REFUND FAILED - refund this payment manually:', paymentId, e);
  }
  return res.status(409).json({
    success: false,
    error: refunded
      ? `Sorry, ${reason} Your payment has been refunded.`
      : `Sorry, ${reason} Your payment could not be refunded automatically; please contact support with payment id ${paymentId}.`,
    refunded,
  });
}

// PUBLIC (rate limited): create a Razorpay order. The amount is calculated here from the cart —
// any amount sent by the browser is ignored.
router.post('/create-order', paymentLimiter, async (req: Request, res: Response) => {
  try {
    const { items, coupon_code, email } = req.body || {};
    const quote = await priceCart(pool, items, {
      couponCode: coupon_code,
      email: typeof email === 'string' ? email.trim().toLowerCase() : undefined,
      paymentMethod: 'online',
    });

    const amountPaise = Math.round(quote.total_amount * 100);
    if (amountPaise < 100) throw new PricingError('Order total is too low for online payment');

    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1 as unknown as boolean, // Razorpay accepts 1; the SDK typings only list boolean
    });

    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      key_id: config.razorpayKeyId, // public key id, so the storefront needs no hardcoded key
      total_amount: quote.total_amount,
    });
  } catch (error: any) {
    if (error instanceof PricingError) return sendError(res, error, '');
    console.error('Razorpay order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// PUBLIC (rate limited): verify the payment signature, then save the order with server-computed totals.
router.post('/verify-payment', paymentLimiter, async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const data = req.body?.order_data || {};

    if (
      typeof razorpay_order_id !== 'string' ||
      typeof razorpay_payment_id !== 'string' ||
      typeof razorpay_signature !== 'string'
    ) {
      return res.status(400).json({ success: false, error: 'Missing payment details' });
    }

    const customer = cleanCustomer(data);

    // Signature proves Razorpay confirmed this payment for this Razorpay order.
    const expected = crypto
      .createHmac('sha256', config.razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(razorpay_signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }

    // A retry of a payment that already produced an order: return that order (stock was taken the first time).
    const existing = await pool.query('SELECT * FROM orders WHERE razorpay_payment_id = $1', [razorpay_payment_id]);
    if (existing.rows[0]) return res.json(verifiedResponse(existing.rows[0], razorpay_payment_id));

    // Stock policy: nothing is reserved when the Razorpay order is created (the customer may never pay).
    // Stock is taken atomically when the PAID order is saved below. If it ran out in between, the
    // customer has paid for something we cannot supply, so the payment is refunded (best effort).
    let quote;
    try {
      // Recompute the cart on the server and make sure it is exactly what was charged, so a paid order
      // cannot be re-used to obtain a different (more expensive) basket.
      quote = await priceCart(pool, data.items, {
        couponCode: data.coupon_code,
        email: customer.email,
        paymentMethod: 'online',
      });
    } catch (e: any) {
      if (e instanceof StockError) return await refundAfterStockFailure(res, razorpay_payment_id, e.message);
      throw e;
    }
    const rzpOrder: any = await getRazorpay().orders.fetch(razorpay_order_id);
    if (Number(rzpOrder.amount) !== Math.round(quote.total_amount * 100)) {
      console.error('Payment amount mismatch', {
        razorpay_order_id, razorpay_payment_id, charged: rzpOrder.amount, expected: Math.round(quote.total_amount * 100),
      });
      return res.status(409).json({
        success: false,
        error: 'Your cart total changed since payment started. Please contact support with your payment id.',
      });
    }

    let order;
    try {
      order = await createOrder({
        quote,
        customer,
        paymentMethod: 'online',
        payment: { order_id: razorpay_order_id, payment_id: razorpay_payment_id, signature: razorpay_signature },
      });
    } catch (e: any) {
      if (e instanceof StockError) return await refundAfterStockFailure(res, razorpay_payment_id, e.message);
      throw e;
    }

    Promise.allSettled([
      sendOrderConfirmationEmail(order),
      sendAdminNotification(order),
    ]);

    res.json(verifiedResponse(order, razorpay_payment_id));
  } catch (error: any) {
    sendError(res, error, 'Payment verification error:');
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
    });

    res.json({
      success: true,
      message: result.duplicate
        ? 'This refund request was already processed'
        : result.order.status === 'refunded' ? 'Order fully refunded' : 'Partial refund recorded',
      duplicate: result.duplicate,
      refund: result.refund,
      order_status: result.order.status,
      refunded_amount: Number(result.order.refunded_amount),
      stock_restored: result.stockRestored,
    });
  } catch (error: any) {
    if (error instanceof PricingError) return res.status(error.status).json({ success: false, error: error.message });
    console.error('Refund error:', error);
    res.status(500).json({ success: false, error: 'Failed to process refund' });
  }
});

export default router;
