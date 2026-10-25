// The only supported way to close a payment-review case where money was returned outside the automatic workflow (for
// example the owner refunded in the Razorpay dashboard). It never trusts an operator's word: the refund must exist at
// Razorpay for THIS payment, be fully `processed`, and equal the captured amount. Anything else stays in review.
// There is deliberately no action that marks an intent fulfilled or refunded without provider evidence.
import { pool } from '../../utils/db';
import { PricingError } from '../pricing';
import { getRazorpay, RazorpayApiError } from '../razorpayClient';
import { plog } from './common';
import { queueRefundAttempt } from './refunds';
import { withTx } from './tx';

const REFUND_ID = /^[A-Za-z0-9_-]{3,64}$/;

export async function adoptProviderRefund(input: { intentId: string; providerRefundId: string; admin: string; note?: string }) {
  const { intentId, providerRefundId } = input;
  if (!REFUND_ID.test(providerRefundId)) throw new PricingError('Invalid provider refund id', 400);
  const note = (input.note || '').trim().slice(0, 500);

  const intent = (await pool.query('SELECT * FROM payment_intents WHERE id = $1', [intentId])).rows[0];
  if (!intent) throw new PricingError('Payment case not found', 404);
  if (!['needs_review', 'refund_required'].includes(intent.status)) throw new PricingError(`This case is ${intent.status}; only cases under review can be closed this way.`, 409);
  if (!intent.razorpay_payment_id) throw new PricingError('This case has no captured payment to match a refund against.', 409);

  // Evidence comes from Razorpay, never from the request.
  let refund;
  try {
    const list = await getRazorpay().payments.fetchRefunds(intent.razorpay_payment_id);
    refund = list.items.find((r) => r.id === providerRefundId);
  } catch (e) {
    if (e instanceof RazorpayApiError) throw new PricingError('Razorpay could not be asked right now; try again shortly.', 503);
    throw e;
  }
  if (!refund) throw new PricingError('Razorpay has no such refund for this payment.', 409);
  if (refund.status !== 'processed') throw new PricingError(`That refund is ${refund.status} at Razorpay, not processed; the case stays open.`, 409);
  if (Number(refund.amount) !== Number(intent.amount_paise) || (refund.currency && refund.currency !== intent.currency)) {
    throw new PricingError('The refund amount/currency does not equal the captured payment; the case stays open for a person to resolve.', 409);
  }

  const result = await withTx(async (c) => {
    const locked = (await c.query('SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE', [intentId])).rows[0];
    if (!['needs_review', 'refund_required'].includes(locked.status)) throw new PricingError(`This case is now ${locked.status}.`, 409);

    const live = (await c.query(
      `SELECT * FROM payment_refund_attempts WHERE intent_id = $1 AND status IN ('queued','submitting','unknown','pending','needs_review') ORDER BY created_at LIMIT 1 FOR UPDATE`, [intentId])).rows[0];
    let attemptId: string;
    if (live) {
      attemptId = live.id;
      if (live.status === 'queued') {
        await c.query(`UPDATE payment_refund_attempts SET status = 'submitting', attempts = attempts + 1, last_attempt_at = now(), lease_until = now() + interval '1 minute' WHERE id = $1`, [live.id]);
      }
    } else {
      attemptId = await queueRefundAttempt(c, { id: intentId, razorpay_payment_id: locked.razorpay_payment_id, amount_paise: locked.amount_paise, currency: locked.currency }, 'manual_review');
      await c.query(`UPDATE payment_refund_attempts SET status = 'submitting', attempts = 1, last_attempt_at = now(), lease_until = now() + interval '1 minute' WHERE id = $1`, [attemptId]);
    }
    const audit = `closed by ${input.admin} against provider refund ${providerRefundId}${note ? `: ${note}` : ''}`.slice(0, 1900);
    await c.query(
      `UPDATE payment_refund_attempts SET status = 'processed', provider_refund_id = $2, provider_status = 'processed', settled_at = now(),
              lease_until = NULL, resolved_at = now(), resolution_note = $3, last_error = NULL WHERE id = $1`,
      [attemptId, providerRefundId, audit]
    );
    await c.query(`UPDATE payment_intents SET status = 'refunded', reviewed_at = now(), resolution_note = $2 WHERE id = $1`, [intentId, audit]);
    return { attemptId };
  }).catch((e: any) => {
    if (e?.code === '23505') throw new PricingError('That provider refund is already recorded against another case.', 409);
    throw e;
  });
  plog('info', 'review_refund_adopted', { intent: intentId, attempt: result.attemptId, refund: providerRefundId });
  return { intent_id: intentId, attempt_id: result.attemptId, status: 'refunded' };
}

/**
 * Close a review case whose captured amount differs from the priced checkout (so no refund attempt can represent it):
 * the owner refunds the payment in the Razorpay dashboard, then acknowledges here. Evidence is fetched from Razorpay: the
 * payment must belong to this checkout's Razorpay order and be refunded in FULL. The intent keeps its `needs_review`
 * state (the database has no terminal state for an amount that differs from the quote); `reviewed_at` and the audit note
 * take it off the open list.
 */
export async function acknowledgeReviewWithProviderEvidence(input: { intentId: string; paymentId: string; admin: string; note?: string }) {
  if (!REFUND_ID.test(input.paymentId)) throw new PricingError('Invalid payment id', 400);
  const intent = (await pool.query('SELECT * FROM payment_intents WHERE id = $1', [input.intentId])).rows[0];
  if (!intent) throw new PricingError('Payment case not found', 404);
  if (intent.status !== 'needs_review') throw new PricingError(`This case is ${intent.status}; only cases under review can be acknowledged.`, 409);
  if (intent.reviewed_at) throw new PricingError('This case was already acknowledged.', 409);

  let payment;
  try {
    payment = await getRazorpay().payments.fetch(input.paymentId);
  } catch (e) {
    if (e instanceof RazorpayApiError) throw new PricingError('Razorpay could not be asked right now; try again shortly.', 503);
    throw e;
  }
  if (payment.order_id !== intent.razorpay_order_id) throw new PricingError('That payment belongs to a different Razorpay order.', 409);
  if (!(payment.amount > 0) || Number(payment.amount_refunded) < Number(payment.amount)) {
    throw new PricingError('Razorpay does not show this payment as fully refunded; the case stays open.', 409);
  }
  const audit = `acknowledged by ${input.admin}: payment ${input.paymentId} fully refunded at Razorpay (${payment.amount_refunded}/${payment.amount} paise)${input.note ? `: ${input.note.trim().slice(0, 400)}` : ''}`.slice(0, 1900);
  const upd = await pool.query(
    `UPDATE payment_intents SET reviewed_at = now(), resolution_note = $2 WHERE id = $1 AND status = 'needs_review' AND reviewed_at IS NULL RETURNING id`,
    [input.intentId, audit]
  );
  if (upd.rowCount === 0) throw new PricingError('This case changed while it was being acknowledged.', 409);
  plog('info', 'review_acknowledged', { intent: input.intentId, payment: input.paymentId });
  return { intent_id: input.intentId, status: 'needs_review', acknowledged: true };
}
