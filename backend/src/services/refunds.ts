import { pool } from '../utils/db';
import { PricingError } from './pricing';
import { getRazorpay } from './razorpayClient';
import { restoreOrderStock } from './orderService';

/** The payment provider did not confirm the refund (or could not be reached). Nothing was recorded. */
export class RefundProviderError extends PricingError {
  constructor(message: string) {
    super(message, 502);
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface RefundResult {
  order: any;
  refund: { id: string; request_id?: string; amount: number; status: string; created_at: string };
  duplicate: boolean;        // true when request_id was already processed: no provider call was made
  stockRestored: boolean;
}

/**
 * Refund (part of) an online payment.
 *
 * Model
 *  - orders.refunded_amount is the running total of provider-CONFIRMED refunds; orders.refunds lists them.
 *  - status becomes 'partially_refunded' while refunded_amount < total_amount and 'refunded' once it is fully covered.
 *  - Nothing is recorded, and no success is reported, unless Razorpay returned a refund id with a non-failed status.
 *  - The order row is locked for the whole operation, so two refund requests for one order run one after the
 *    other and the second sees the first one's result (a full refund can never be issued twice, and refunds can
 *    never add up to more than the order total).
 *  - `requestId` makes a retry safe: the same id returns the recorded refund without calling the provider again.
 *  - A full refund also gives the order's stock back (once), in a separate step after the refund is recorded so a
 *    stock problem can never hide a refund that really happened.
 *
 * If the provider call fails or times out we cannot know whether money moved. We record nothing and report a
 * 502 telling the admin to check the Razorpay dashboard before retrying.
 */
export async function refundPayment(input: {
  paymentId: string;
  amount?: number;          // rupees; omitted = whatever is still refundable
  requestId?: string;
  reason?: string;
}): Promise<RefundResult> {
  const client = await pool.connect();
  let finished: Omit<RefundResult, 'stockRestored'> | null = null;
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM orders WHERE razorpay_payment_id = $1 FOR UPDATE', [input.paymentId]);
    const order = locked.rows[0];
    if (!order) throw new PricingError('Order not found', 404);

    const refunds: any[] = Array.isArray(order.refunds) ? order.refunds : [];
    if (input.requestId) {
      const seen = refunds.find((r) => r.request_id === input.requestId);
      if (seen) {
        await client.query('COMMIT');
        return { order, refund: seen, duplicate: true, stockRestored: false };
      }
    }

    const total = Number(order.total_amount);
    const refundedSoFar = Number(order.refunded_amount);
    const remaining = round2(total - refundedSoFar);
    if (remaining <= 0) throw new PricingError('This order is already fully refunded', 409);

    const amount = input.amount === undefined ? remaining : round2(Number(input.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new PricingError('Invalid refund amount', 400);
    if (amount > remaining) throw new PricingError(`Refund exceeds the refundable balance (₹${remaining.toFixed(2)} left)`, 400);

    const amountPaise = Math.round(amount * 100);
    let confirmation: any;
    try {
      confirmation = await getRazorpay().payments.refund(input.paymentId, {
        amount: amountPaise,
        notes: {
          order_id: order.id,
          custom_order_id: order.custom_order_id,
          reason: (input.reason || 'Customer requested refund').slice(0, 200),
        },
      });
    } catch (e: any) {
      if (e instanceof PricingError) throw e; // e.g. payments not configured
      console.error('Refund provider error - state unknown, nothing recorded:', input.paymentId, e?.error || e?.message || e);
      throw new RefundProviderError(
        'The payment provider did not confirm the refund. Nothing was recorded. Check the Razorpay dashboard before trying again.'
      );
    }

    const status = String(confirmation?.status || '');
    if (!confirmation?.id || !status || status === 'failed') {
      throw new RefundProviderError(`The payment provider did not confirm the refund (status: ${status || 'none'}). Nothing was recorded.`);
    }

    const entry = {
      id: String(confirmation.id),
      ...(input.requestId ? { request_id: input.requestId } : {}),
      amount,
      status,                                   // 'processed' or 'pending' (accepted, still settling)
      created_at: new Date().toISOString(),
    };
    const newRefunded = round2(refundedSoFar + amount);
    const fully = newRefunded >= total;

    const updated = await client.query(
      `UPDATE orders
          SET refunds = refunds || $2::jsonb,
              refunded_amount = $3,
              status = $4,
              refund_data = $5,
              refunded_at = CASE WHEN $6 THEN now() ELSE refunded_at END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [order.id, JSON.stringify([entry]), newRefunded, fully ? 'refunded' : 'partially_refunded', JSON.stringify(confirmation), fully]
    );
    await client.query('COMMIT');
    finished = { order: updated.rows[0], refund: entry, duplicate: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  let stockRestored = false;
  if (finished.order.status === 'refunded') {
    try {
      stockRestored = (await restoreOrderStock(finished.order.id)).restored;
    } catch (e) {
      console.error('Refund recorded but stock restoration failed (retry by cancelling the order):', finished.order.id, e);
    }
  }
  return { ...finished, stockRestored };
}
