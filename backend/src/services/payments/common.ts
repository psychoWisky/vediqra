// Shared helpers for payment recovery: hashing, status tokens, backoff and SAFE structured logging.
import crypto from 'crypto';
import config from '../../config';

export const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted at every level, so equal data always serialises to the same text (hashing). */
export function canonicalJson(value: unknown): string {
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Compare two strings without leaking where they differ (length differences are not secret here). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * The customer's status token for an intent: HMAC of the intent id under a server secret (256 bits). Only its sha256 is
 * stored. It is derived rather than stored, so a repeated create-order (same Idempotency-Key) can hand the browser the
 * same token again. It is never logged.
 */
export function statusTokenFor(intentId: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(`vediqra-status-v1:${intentId}`).digest('base64url');
}
export const hashStatusToken = (token: string): string => sha256Hex(token);

/** Provider-side receipt for an intent: 35 characters (limit 40), unique per intent; lets a lost order creation be found again. */
export const receiptForIntent = (intentId: string): string => `vq_${intentId.replace(/-/g, '')}`;
export const intentIdFromReceipt = (receipt: string | null | undefined): string | null => {
  const m = /^vq_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(receipt || '');
  return m ? m.slice(1).join('-') : null;
};

/** Exponential backoff with +-10% jitter. `attempt` starts at 0 for the first retry. */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 20)));
  return Math.round(raw * (0.9 + Math.random() * 0.2));
}

/** A short error text that is safe to store and log: no stack, no credentials, bounded length. */
export function safeError(e: unknown, max = 300): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, ' ')
    .replace(/(rzp_(live|test)_\w+|Basic [A-Za-z0-9+/=]+|Bearer [\w.-]+)/g, '[redacted]')
    .replace(/[^\s<>"',;()]+@[^\s<>"',;()]+/g, '[email]')      // SMTP errors quote recipient addresses
    .slice(0, max);
}

// ----------------------------------------------------------------------------------------------------- logging
// One JSON line per event. Only the fields below are ever printed (ids, states, counts); anything else is dropped, so a
// caller cannot leak an e-mail address, phone number, signature, header or raw payload by passing it by mistake.
const LOGGABLE = new Set([
  'intent', 'order', 'razorpayOrder', 'payment', 'refund', 'attempt', 'event', 'type', 'source', 'outcome', 'status',
  'from', 'to', 'reason', 'attempts', 'count', 'kind', 'error', 'code', 'ms', 'worker', 'amountPaise',
]);

export function plog(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const line: Record<string, unknown> = { t: new Date().toISOString(), evt: `payment.${event}` };
  for (const [k, v] of Object.entries(fields)) {
    if (!LOGGABLE.has(k) || v === undefined || v === null) continue;
    line[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}
