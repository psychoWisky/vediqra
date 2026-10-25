// Razorpay webhook handling: verify -> persist the event id -> process -> record the outcome.
//
// Response contract (Razorpay retries any non-2xx for about a day with backoff - the exact schedule is not verified here):
//   2xx  signature valid AND the event is stored AND (processed, or a duplicate of a processed event, or deliberately ignored)
//   400  bad signature / unreadable body (never stored; retrying cannot help)
//   503  webhook secret not configured (retry once an operator fixes the configuration)
//   500  our own failure (database/provider outage): the stored event stays unprocessed and the retry - or the recovery job -
//        finishes it
// What is stored: event id, type, order/payment ids, timestamps and the outcome. Never the body, headers or signature.
import config from '../../config';
import { pool } from '../../utils/db';
import { plog, safeError, sha256Hex } from './common';
import { getRazorpay } from '../razorpayClient';
import {
  FulfilResult, factsFromProviderPayment, findIntentByRazorpayOrder, fulfilCapturedPayment, reconcileIntentWithProvider, resolveIntentForUnknownOrder,
} from './fulfilment';
import { NormalizedEvent, normalizeWebhookEvent, verifyWebhookSignature, WebhookPayloadError } from './webhookEvent';

export type EventOutcome = 'applied' | 'noop' | 'ignored' | 'needs_review' | 'unknown_order';
export const WEBHOOK_MAX_ATTEMPTS = 8;

const outcomeFor = (r: FulfilResult): EventOutcome => {
  switch (r.outcome) {
    case 'fulfilled': case 'refund_required': return 'applied';
    case 'already_fulfilled': case 'noop': return 'noop';
    case 'needs_review': return 'needs_review';
    case 'unknown_order': return 'unknown_order';
  }
};

async function markProcessed(eventId: string, outcome: EventOutcome, intentId?: string): Promise<void> {
  await pool.query(
    `UPDATE payment_webhook_events SET processed_at = now(), outcome = $2, intent_id = COALESCE($3::uuid, intent_id), last_error = NULL
      WHERE event_id = $1 AND processed_at IS NULL`,
    [eventId, outcome, intentId ?? null]
  );
}

/** Apply one normalised event. Throws on infrastructure failure (the caller answers 500 and keeps the event unprocessed). */
async function applyEvent(ev: NormalizedEvent): Promise<{ outcome: EventOutcome; intentId?: string }> {
  switch (ev.type) {
    case 'payment.captured':
    case 'order.paid': {
      if (!ev.razorpayOrderId) return { outcome: 'ignored' };
      if (ev.paymentStatus && ev.paymentStatus !== 'captured') return { outcome: 'ignored' };
      const intent = await findIntentByRazorpayOrder(ev.razorpayOrderId) ?? await resolveIntentForUnknownOrder(ev.razorpayOrderId);
      if (!intent) return { outcome: 'unknown_order' };
      // The event name and payload are only a HINT. What was captured, for how much and against which order is read from
      // Razorpay (the same reconciliation the browser path uses). A provider outage throws -> 500 -> retried.
      if (!ev.paymentId) {
        const r = await reconcileIntentWithProvider(intent);
        return { outcome: r.result ? outcomeFor(r.result) : 'noop', intentId: intent.id };
      }
      const payment = await getRazorpay().payments.fetch(ev.paymentId);
      if (payment.order_id !== ev.razorpayOrderId) return { outcome: 'needs_review', intentId: intent.id };
      if (!payment.captured) return { outcome: 'noop', intentId: intent.id };      // not captured (yet): recovery re-checks
      const facts = factsFromProviderPayment(payment);
      if (!facts) return { outcome: 'needs_review', intentId: intent.id };
      const r = await fulfilCapturedPayment(facts, 'webhook', intent);
      return { outcome: outcomeFor(r), intentId: r.intentId };
    }
    case 'payment.failed': {
      // Informational. A failed attempt can be followed by a successful one, so this never changes the intent's state.
      if (!ev.razorpayOrderId) return { outcome: 'ignored' };
      const intent = await findIntentByRazorpayOrder(ev.razorpayOrderId);
      if (!intent) return { outcome: 'unknown_order' };
      const upd = await pool.query(
        `UPDATE payment_intents SET failed_attempts = failed_attempts + 1, last_failure_code = $2
          WHERE id = $1 AND status IN ('created','abandoned')`,
        [intent.id, ev.errorCode]
      );
      return { outcome: (upd.rowCount ?? 0) > 0 ? 'applied' : 'noop', intentId: intent.id };
    }
    default:
      return { outcome: 'ignored' };
  }
}

export interface WebhookReply { status: number; body: Record<string, unknown>; headers?: Record<string, string> }

// Capacity guard: at most this many events are being PROCESSED (database / provider work) in this process at once. Beyond that
// the event is answered 503 + Retry-After before anything is stored, which Razorpay treats as a failed delivery and retries.
let inFlight = 0;

export async function handleWebhook(rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>): Promise<WebhookReply> {
  const secrets = [config.razorpayWebhookSecret, config.razorpayWebhookSecretPrevious].filter(Boolean);
  if (secrets.length === 0) {
    plog('error', 'webhook_not_configured');
    return { status: 503, body: { error: 'webhook not configured' } };
  }
  const header = (name: string): string | undefined => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return { status: 400, body: { error: 'empty body' } };
  if (!verifyWebhookSignature(rawBody, header('x-razorpay-signature'), secrets)) {
    plog('warn', 'webhook_bad_signature');
    return { status: 400, body: { error: 'invalid signature' } };
  }

  if (inFlight >= config.webhookMaxConcurrent) {
    plog('warn', 'webhook_busy', { count: inFlight });
    return { status: 503, body: { error: 'busy, please retry' }, headers: { 'Retry-After': '5' } };
  }
  inFlight++;
  try {
    return await processVerified(rawBody, header);
  } finally {
    inFlight--;
  }
}

async function processVerified(rawBody: Buffer, header: (name: string) => string | undefined): Promise<WebhookReply> {
  let ev: NormalizedEvent;
  try {
    const eventId = (header('x-razorpay-event-id') || '').trim() || `body_${sha256Hex(rawBody.toString('utf8'))}`;
    if (eventId.length > 128) throw new WebhookPayloadError('event id too long');
    ev = normalizeWebhookEvent(eventId, JSON.parse(rawBody.toString('utf8')));
  } catch {
    // Signed by Razorpay but not something we can read. A retry would be byte-identical, so it is acknowledged - but it is
    // RECORDED (id + 'unreadable', outcome needs_review) so a legitimate notification is never silently lost; the payment
    // itself is still found by the recovery job, which asks Razorpay about every open checkout.
    const fallbackId = (header('x-razorpay-event-id') || '').trim().slice(0, 128) || `body_${sha256Hex(rawBody.toString('utf8'))}`;
    await pool.query(
      `INSERT INTO payment_webhook_events (event_id, event_type, processed_at, outcome, last_error)
       VALUES ($1, 'unreadable', now(), 'needs_review', 'signed body was not a readable event')
       ON CONFLICT (event_id) DO NOTHING`, [fallbackId]
    ).catch(() => {});
    plog('warn', 'webhook_unreadable', { event: fallbackId });
    return { status: 200, body: { received: true, ignored: true } };
  }

  try {
    // Persist BEFORE acknowledging or processing. The primary key makes a repeated delivery of the same event a no-op.
    const stored = await pool.query(
      `INSERT INTO payment_webhook_events (event_id, event_type, razorpay_order_id, razorpay_payment_id, event_created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id) DO UPDATE SET attempts = payment_webhook_events.attempts + 1, last_attempt_at = now()
       RETURNING processed_at, outcome`,
      [ev.eventId, ev.type, ev.razorpayOrderId, ev.paymentId, ev.createdAt]
    );
    if (stored.rows[0].processed_at) return { status: 200, body: { received: true, duplicate: true } };

    const { outcome, intentId } = await applyEvent(ev);
    await markProcessed(ev.eventId, outcome, intentId);
    plog('info', 'webhook_processed', { event: ev.eventId, type: ev.type, outcome, intent: intentId });
    return { status: 200, body: { received: true } };
  } catch (e) {
    await pool.query(`UPDATE payment_webhook_events SET last_error = $2 WHERE event_id = $1`, [ev.eventId, safeError(e, 400)]).catch(() => {});
    plog('error', 'webhook_failed', { event: ev.eventId, type: ev.type, error: safeError(e, 150), reason: 'will be retried' });
    return { status: 500, body: { error: 'processing failed, please retry' } };
  }
}

/**
 * Recovery job: finish stored events that were never processed (we answered 500, or crashed after storing). The payload is
 * not kept, so the provider is asked about the order instead - which is the authoritative source anyway.
 */
export async function retryUnprocessedEvents(limit = 20): Promise<number> {
  const due = await pool.query(
    `UPDATE payment_webhook_events SET attempts = attempts + 1, last_attempt_at = now()
      WHERE event_id IN (
        SELECT event_id FROM payment_webhook_events
         WHERE processed_at IS NULL AND received_at < now() - interval '1 minute'
           AND last_attempt_at < now() - LEAST(interval '1 hour', interval '1 minute' * power(2, LEAST(attempts, 10)))
         ORDER BY received_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING event_id, event_type, razorpay_order_id, attempts`,
    [limit]
  );
  let done = 0;
  for (const row of due.rows) {
    try {
      if ((row.event_type === 'payment.captured' || row.event_type === 'order.paid') && row.razorpay_order_id) {
        const intent = await findIntentByRazorpayOrder(row.razorpay_order_id) ?? await resolveIntentForUnknownOrder(row.razorpay_order_id);
        if (!intent) { await markProcessed(row.event_id, 'unknown_order'); done++; continue; }
        const r = await reconcileIntentWithProvider(intent);
        await markProcessed(row.event_id, r.result ? outcomeFor(r.result) : 'noop', intent.id);
      } else {
        await markProcessed(row.event_id, 'ignored');
      }
      done++;
    } catch (e) {
      await pool.query('UPDATE payment_webhook_events SET last_error = $2 WHERE event_id = $1', [row.event_id, safeError(e, 400)]).catch(() => {});
      if (row.attempts >= WEBHOOK_MAX_ATTEMPTS) {
        await markProcessed(row.event_id, 'needs_review').catch(() => {});
        plog('error', 'webhook_gave_up', { event: row.event_id, attempts: row.attempts });
      }
    }
  }
  return done;
}
