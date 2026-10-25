import Razorpay from 'razorpay';
import config from '../config';
import { PricingError } from './pricing';

// ---------------------------------------------------------------------------------------------------------------
// Provider data shapes. Payments are deliberately reduced to the fields payment recovery needs: Razorpay's payment
// object also carries the customer's email, phone, card details and UPI id, which must never reach our logs or
// database, so they are dropped here at the boundary.
// ---------------------------------------------------------------------------------------------------------------
export interface ProviderPayment {
  id: string;
  order_id: string | null;
  amount: number;                 // paise
  currency: string;
  status: string;                 // created | authorized | captured | refunded | failed
  captured: boolean;
  method: string | null;          // upi | card | netbanking | ... (not personal data)
  amount_refunded: number;        // paise
  refund_status: string | null;   // null | partial | full
  error_code: string | null;
  error_description: string | null;
  created_at: number | null;      // unix seconds
}

export interface ProviderRefund {
  id: string;
  payment_id: string | null;
  amount: number;                 // paise
  currency: string | null;
  status: string;                 // pending | processed | failed
  receipt: string | null;
  notes: Record<string, unknown>;
  created_at: number | null;
}

export interface ProviderCollection<T> { count: number; items: T[] }

/** A Razorpay order, reduced to what payment recovery needs (notes and offers are dropped). */
export interface ProviderOrder {
  id: string;
  amount: number;                 // paise
  currency: string;
  receipt: string | null;
  status: string;                 // created | attempted | paid
  amount_paid: number;
  created_at: number | null;      // unix seconds
}

export interface RefundRequest {
  /** Paise. Pass it explicitly (and identically) on every retry: the provider rejects a changed body for a used key. */
  amount: number;
  speed?: 'normal' | 'optimum';
  receipt?: string;
  notes?: Record<string, string | number>;
}

export type ProviderErrorKind =
  | 'timeout'            // no answer within the deadline
  | 'network'            // could not reach the provider / connection dropped
  | 'http'               // the provider answered with an error status
  | 'invalid_response'   // 2xx but not the JSON we expect
  | 'invalid_request';   // refused locally before anything was sent

/**
 * A failed provider call. `outcomeUnknown` is the important field for money-moving calls: when it is true the
 * provider MAY have performed the action even though we got no usable answer, so the caller must reconcile (list the
 * payment's refunds) or retry with the SAME idempotency key; it must never assume "nothing happened" and must never
 * start over with a new key. The message and fields carry only the provider's error code and description, never
 * credentials, headers or request/response bodies.
 */
export class RazorpayApiError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly description?: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  /** 409 where a request with this idempotency key is still being processed (retry later, same key). */
  readonly inProgress: boolean;
  /** 409 where this key was already used with a DIFFERENT body: a bug in the caller, never retry. */
  readonly idempotencyConflict: boolean;

  constructor(init: {
    kind: ProviderErrorKind; message: string; status?: number; code?: string; description?: string;
    retryable?: boolean; outcomeUnknown?: boolean; inProgress?: boolean; idempotencyConflict?: boolean;
  }) {
    super(init.message);
    this.name = 'RazorpayApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.description = init.description;
    this.retryable = init.retryable ?? false;
    this.outcomeUnknown = init.outcomeUnknown ?? false;
    this.inProgress = init.inProgress ?? false;
    this.idempotencyConflict = init.idempotencyConflict ?? false;
  }
}

/** The small part of the Razorpay API this app uses; tests substitute a deterministic fake. */
export interface RazorpayLike {
  orders: {
    /**
     * Create an order. `receipt` must be unique per Razorpay account (documented), which is what makes a lost answer
     * recoverable: the caller looks the order up again by receipt instead of creating a second one.
     */
    create: (params: any) => Promise<any>;
    fetch: (id: string) => Promise<any>;
    /** Orders carrying exactly this receipt (empty when none exists). */
    fetchByReceipt: (receipt: string) => Promise<ProviderCollection<ProviderOrder>>;
    /** Every payment attempt for an order (failed and captured). */
    fetchPayments: (orderId: string) => Promise<ProviderCollection<ProviderPayment>>;
  };
  payments: {
    /**
     * Refund call used by the admin flow. Without `idempotencyKey` it is the original SDK call (no header, no timeout).
     * WITH a key it goes over direct HTTPS with X-Refund-Idempotency, so repeating the same request after a lost answer
     * returns the original refund instead of paying out twice. `params.amount` must then be whole paise.
     */
    refund: (paymentId: string, params: any, idempotencyKey?: string) => Promise<any>;
    fetch: (paymentId: string) => Promise<ProviderPayment>;
    /** All refunds for a payment, for reconciling an attempt whose outcome is unknown. */
    fetchRefunds: (paymentId: string) => Promise<ProviderCollection<ProviderRefund>>;
    /**
     * Create a refund with Razorpay's X-Refund-Idempotency header. The same key with an identical body is safe to
     * repeat; the same key with a different body is rejected by the provider. Never retried here: the caller owns
     * the key and decides what to do after an error.
     */
    refundIdempotent: (paymentId: string, request: RefundRequest, idempotencyKey: string) => Promise<ProviderRefund>;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Direct HTTPS. The installed SDK (razorpay 2.9.8) only forwards the X-Razorpay-Account header, so it cannot send
// X-Refund-Idempotency, and it has no timeout and turns network failures into an unrelated TypeError. The calls below
// (all new ones) therefore use fetch with an explicit deadline and classified errors.
// ---------------------------------------------------------------------------------------------------------------
const ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
// Razorpay: at least 10 characters, letters, digits, hyphen and underscore only.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;
const MAX_RESPONSE_CHARS = 1_000_000;

function assertId(label: string, value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new RazorpayApiError({ kind: 'invalid_request', message: `Invalid ${label}` });
  }
  return value;
}

const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const int = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export function toProviderPayment(raw: any): ProviderPayment {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    throw new RazorpayApiError({ kind: 'invalid_response', message: 'Unexpected payment response from the provider' });
  }
  return {
    id: raw.id,
    order_id: str(raw.order_id),
    amount: int(raw.amount),
    currency: str(raw.currency, 8) || '',
    status: str(raw.status, 32) || '',
    captured: raw.captured === true || raw.status === 'captured',
    method: str(raw.method, 32),
    amount_refunded: int(raw.amount_refunded),
    refund_status: str(raw.refund_status, 16),
    error_code: str(raw.error_code, 80),
    error_description: str(raw.error_description),
    created_at: Number.isFinite(Number(raw.created_at)) ? Number(raw.created_at) : null,
  };
}

export function toProviderOrder(raw: any): ProviderOrder {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    throw new RazorpayApiError({ kind: 'invalid_response', message: 'Unexpected order response from the provider' });
  }
  return {
    id: raw.id,
    amount: int(raw.amount),
    currency: str(raw.currency, 8) || '',
    receipt: str(raw.receipt, 80),
    status: str(raw.status, 32) || '',
    amount_paid: int(raw.amount_paid),
    created_at: Number.isFinite(Number(raw.created_at)) ? Number(raw.created_at) : null,
  };
}

export function toProviderRefund(raw: any): ProviderRefund {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    throw new RazorpayApiError({ kind: 'invalid_response', message: 'Unexpected refund response from the provider' });
  }
  return {
    id: raw.id,
    payment_id: str(raw.payment_id),
    amount: int(raw.amount),
    currency: str(raw.currency, 8),
    status: str(raw.status, 32) || '',
    receipt: str(raw.receipt),
    // Razorpay returns [] (an empty array) when there are no notes.
    notes: raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes) ? { ...raw.notes } : {},
    created_at: Number.isFinite(Number(raw.created_at)) ? Number(raw.created_at) : null,
  };
}

function toCollection<T>(raw: any, map: (x: any) => T): ProviderCollection<T> {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    throw new RazorpayApiError({ kind: 'invalid_response', message: 'Unexpected collection response from the provider' });
  }
  const items = raw.items.map(map);
  return { count: Number.isFinite(Number(raw.count)) ? Number(raw.count) : items.length, items };
}

/**
 * The exact JSON body for a refund, with a fixed field order and sorted notes, so every retry with the same inputs
 * produces byte-identical text (Razorpay rejects a changed body for a reused idempotency key).
 */
export function canonicalRefundBody(request: RefundRequest): string {
  const { amount, speed, receipt, notes } = request;
  if (!Number.isInteger(amount) || amount < 1) {
    throw new RazorpayApiError({ kind: 'invalid_request', message: 'Refund amount must be a whole number of paise (at least 1)' });
  }
  if (speed !== undefined && speed !== 'normal' && speed !== 'optimum') {
    throw new RazorpayApiError({ kind: 'invalid_request', message: 'Invalid refund speed' });
  }
  if (receipt !== undefined && (typeof receipt !== 'string' || !receipt || receipt.length > 40)) {
    throw new RazorpayApiError({ kind: 'invalid_request', message: 'Refund receipt must be 1-40 characters' });
  }
  const body: Record<string, unknown> = { amount };
  if (speed !== undefined) body.speed = speed;
  if (receipt !== undefined) body.receipt = receipt;
  if (notes !== undefined) {
    const keys = Object.keys(notes).sort();
    if (keys.length > 15) throw new RazorpayApiError({ kind: 'invalid_request', message: 'A refund can carry at most 15 notes' });
    body.notes = Object.fromEntries(keys.map((k) => [k, notes[k]]));
  }
  return JSON.stringify(body);
}

function providerError(status: number, text: string, isWrite: boolean): RazorpayApiError {
  let code: string | undefined;
  let description: string | undefined;
  try {
    const err = JSON.parse(text)?.error;
    code = str(err?.code, 80) ?? undefined;
    description = str(err?.description) ?? undefined;
  } catch { /* not JSON: keep only the status */ }

  const conflict = status === 409;
  const different = conflict && /different request/i.test(description || '');
  const inProgress = conflict && !different;
  // 5xx and an in-progress 409 leave a write's outcome uncertain; 4xx (other than 409) and 429 mean it was not performed.
  const outcomeUnknown = isWrite && (status >= 500 || inProgress);
  return new RazorpayApiError({
    kind: 'http',
    message: `Razorpay returned HTTP ${status}${code ? ` (${code})` : ''}${description ? `: ${description}` : ''}`,
    status, code, description,
    retryable: status >= 500 || status === 429 || inProgress,
    outcomeUnknown,
    inProgress,
    idempotencyConflict: different,
  });
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<unknown> {
  if (!config.razorpayKeyId || !config.razorpayKeySecret) throw new PricingError('Online payments are not configured', 503);
  const isWrite = method !== 'GET';
  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(`${config.razorpayApiBase}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body,
      redirect: 'error',                                   // never forward credentials to another host
      signal: AbortSignal.timeout(config.razorpayTimeoutMs),
    });
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new RazorpayApiError({
      kind: timedOut ? 'timeout' : 'network',
      message: timedOut ? 'Razorpay did not answer in time' : 'Razorpay could not be reached',
      retryable: true,
      outcomeUnknown: isWrite,                             // the request may have been received and acted on
    });
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new RazorpayApiError({ kind: 'network', message: 'The Razorpay response was cut off', status: res.status, retryable: true, outcomeUnknown: isWrite });
  }
  if (!res.ok) throw providerError(res.status, text.slice(0, 5000), isWrite);
  if (text.length > MAX_RESPONSE_CHARS) throw new RazorpayApiError({ kind: 'invalid_response', message: 'Razorpay response too large', status: res.status, outcomeUnknown: isWrite });
  try {
    return JSON.parse(text);
  } catch {
    throw new RazorpayApiError({ kind: 'invalid_response', message: 'Razorpay returned a response that is not JSON', status: res.status, outcomeUnknown: isWrite });
  }
}

async function getDirectIdempotentRefund(paymentId: string, params: any, idempotencyKey: string): Promise<ProviderRefund> {
  const id = assertId('payment id', paymentId);
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new RazorpayApiError({ kind: 'invalid_request', message: 'Invalid idempotency key (10+ characters: letters, digits, - and _)' });
  }
  const body = canonicalRefundBody({ amount: params.amount, notes: params.notes, ...(params.receipt !== undefined ? { receipt: params.receipt } : {}) });
  return toProviderRefund(await request('POST', `/v1/payments/${encodeURIComponent(id)}/refund`, { body, headers: { 'X-Refund-Idempotency': idempotencyKey } }));
}

let client: RazorpayLike | null = null;

function buildClient(): RazorpayLike {
  const sdk = new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpayKeySecret }) as any;
  return {
    orders: {
      // Direct HTTPS (not the SDK): the SDK has no timeout, so a stalled connection would hang checkout forever, and it
      // reports network failures as an unrelated TypeError. Here a lost answer is a classified, recoverable error.
      create: async (params) => {
        const body = JSON.stringify(params);
        return toProviderOrder(await request('POST', '/v1/orders', { body }));
      },
      fetch: async (id) =>
        toProviderOrder(await request('GET', `/v1/orders/${encodeURIComponent(assertId('order id', id))}`)),
      fetchByReceipt: async (receipt) => {
        if (typeof receipt !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(receipt)) {
          throw new RazorpayApiError({ kind: 'invalid_request', message: 'Invalid receipt' });
        }
        return toCollection(await request('GET', `/v1/orders?receipt=${encodeURIComponent(receipt)}&count=10`), toProviderOrder);
      },
      fetchPayments: async (orderId) =>
        toCollection(await request('GET', `/v1/orders/${encodeURIComponent(assertId('order id', orderId))}/payments`), toProviderPayment),
    },
    payments: {
      refund: async (paymentId, params, idempotencyKey) => {
        if (idempotencyKey === undefined) return sdk.payments.refund(paymentId, params);
        return getDirectIdempotentRefund(paymentId, params, idempotencyKey);
      },
      fetch: async (paymentId) =>
        toProviderPayment(await request('GET', `/v1/payments/${encodeURIComponent(assertId('payment id', paymentId))}`)),
      fetchRefunds: async (paymentId) =>
        toCollection(await request('GET', `/v1/payments/${encodeURIComponent(assertId('payment id', paymentId))}/refunds`), toProviderRefund),
      refundIdempotent: async (paymentId, refundRequest, idempotencyKey) => {
        const id = assertId('payment id', paymentId);
        if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
          throw new RazorpayApiError({ kind: 'invalid_request', message: 'Invalid idempotency key (10+ characters: letters, digits, - and _)' });
        }
        const body = canonicalRefundBody(refundRequest);
        return toProviderRefund(await request('POST', `/v1/payments/${encodeURIComponent(id)}/refund`, { body, headers: { 'X-Refund-Idempotency': idempotencyKey } }));
      },
    },
  };
}

/** Created on first use so the API starts (and every non-payment route works) without Razorpay keys. */
export function getRazorpay(): RazorpayLike {
  if (client) return client;
  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    throw new PricingError('Online payments are not configured', 503);
  }
  client = buildClient();
  return client;
}

/** Test seam: install a fake client (or pass null to go back to the real SDK). */
export function setRazorpayClient(fake: RazorpayLike | null): void {
  client = fake;
}
