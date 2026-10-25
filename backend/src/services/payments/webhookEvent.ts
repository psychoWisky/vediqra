// Pure helpers for Razorpay webhooks: signature check and normalisation of the event into a small, personal-data-free
// record. Nothing else from the payload (email, contact, card, vpa, notes ...) ever leaves this file.
import crypto from 'crypto';

export class WebhookPayloadError extends Error {}

/**
 * Razorpay signs the RAW request body: hex HMAC-SHA256 with the webhook secret, in X-Razorpay-Signature. `secrets` is the
 * current secret and, during a rotation, the previous one. Returns false for a missing/odd signature or no secret.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secrets: string[]): boolean {
  if (!signature || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const given = Buffer.from(signature.toLowerCase(), 'hex');
  let ok = false;
  for (const secret of secrets.filter(Boolean)) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    // evaluate every secret (no early exit) so timing does not reveal which one matched
    if (crypto.timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

export interface NormalizedEvent {
  eventId: string;
  type: string;
  createdAt: Date | null;
  razorpayOrderId: string | null;
  paymentId: string | null;
  amountPaise: number | null;
  currency: string | null;
  paymentStatus: string | null;      // captured | authorized | failed | ...
  method: string | null;
  refundedPaise: number;
  errorCode: string | null;
}

const ID = /^[A-Za-z0-9_-]{3,64}$/;
const TYPE = /^[A-Za-z0-9_.]{1,80}$/;
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const paise = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * `eventId` comes from the x-razorpay-event-id header (falls back to a hash of the body in the route). Throws
 * WebhookPayloadError for anything that is not a recognisable event.
 */
export function normalizeWebhookEvent(eventId: string, body: unknown): NormalizedEvent {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WebhookPayloadError('payload is not an object');
  const b = body as Record<string, any>;
  if (typeof b.event !== 'string' || !TYPE.test(b.event)) throw new WebhookPayloadError('missing event type');
  const payment = b.payload?.payment?.entity;
  const order = b.payload?.order?.entity;
  const created = typeof b.created_at === 'number' && Number.isFinite(b.created_at) ? new Date(b.created_at * 1000) : null;

  const paymentOk = payment && typeof payment === 'object';
  return {
    eventId,
    type: b.event,
    createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
    razorpayOrderId: id(paymentOk ? payment.order_id : null) ?? id(order && typeof order === 'object' ? order.id : null),
    paymentId: paymentOk ? id(payment.id) : null,
    amountPaise: paymentOk ? paise(payment.amount) : null,
    currency: paymentOk ? text(payment.currency, 8) : null,
    paymentStatus: paymentOk ? text(payment.status, 32) : null,
    method: paymentOk ? text(payment.method, 32) : null,
    refundedPaise: paymentOk ? (paise(payment.amount_refunded) ?? 0) : 0,
    errorCode: paymentOk ? text(payment.error_code, 80) : null,
  };
}
