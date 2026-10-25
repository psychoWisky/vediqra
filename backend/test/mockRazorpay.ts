// Deterministic Razorpay fake + a server that uses it. TEST ONLY - never imported by the application.
//   npx tsx test/serve-with-mock.ts            (PORT defaults to 5000)
//
// LEGACY refund call (payments.refund, no idempotency header) - behaviour chosen by the payment id, unchanged:
//   *fail*      the provider call throws (network error / outage)
//   *rejected*  the provider answers with status "failed"
//   *noid*      the provider answers without a refund id
//   *pending*   the provider accepts the refund with status "pending"
//   *slow*      the provider takes 400 ms (used to prove simultaneous refunds are serialised)
//   anything else: status "processed"
// The legacy call does NOT touch the payment store below, so the existing admin-refund tests are unaffected.
//
// NEW calls modelled on Razorpay's documented contract (payments.fetch, orders.fetchPayments, payments.fetchRefunds,
// payments.refundIdempotent). Payments are created by the test with seedPayment() (or POST /__mock/payments).
// refundIdempotent behaviour, also chosen by the payment id:
//   *refundpending*  the refund is created "pending" until advanceRefund() settles it
//   *refundfailed*   the refund is created "failed" (it does not count against the refundable amount)
//   *lostresp*       the provider PERFORMS the refund, but the first answer for each key is lost (timeout, outcome unknown)
//   *lostbefore*     the first request for each key never reaches the provider (timeout, nothing happened)
//   *slow*           takes 400 ms; a same-key request meanwhile gets 409 "in progress"
//   *apidown*        every call fails as unreachable
// Modelled contract (Razorpay docs): key = 10+ chars of letters/digits/-/_; same key + identical body is safe to
// repeat; same key + different body is a 409 "Different request with the same idempotency key ..."; same key while the
// first request is running is a 409. ASSUMPTIONS (not stated in the docs): a replay returns the original refund; keys
// never expire; a rejected (4xx) request does not consume its key; refunds in "pending" count against the refundable
// amount (failed ones do not).
import crypto from 'node:crypto';
import { RazorpayLike, RazorpayApiError, ProviderPayment, ProviderRefund, ProviderOrder, canonicalRefundBody } from '../src/services/razorpayClient';

export const calls: { fn: string; args: any[] }[] = [];
const rzpOrders = new Map<string, ProviderOrder>();

/** Test controls for order creation. 'lostresp' = created at the provider but the answer is lost; 'lostbefore' = never created; 'reject' = 400. Each applies once. */
/** Test control: while true, the refunds LIST hides every refund (eventual-consistency lag); payments.fetch still shows the effect. */
/** Test control: milliseconds payments.fetch takes (to hold webhook processing open). */
export const delays = { paymentFetch: 0 };
export const listLag = { refunds: false };
export const orderFaults: { create: null | 'lostresp' | 'lostbefore' | 'reject' | 'down'; fetchByReceipt: null | 'down'; fetchPayments: null | 'down' } = { create: null, fetchByReceipt: null, fetchPayments: null };
let seq = 0;

interface MockPayment extends ProviderPayment {}
interface MockRefund extends ProviderRefund { idempotency_key: string }
const payments = new Map<string, MockPayment>();
const refunds = new Map<string, MockRefund>();
const keys = new Map<string, { hash: string; refundId?: string; inFlight?: boolean; lostSent?: boolean; lostBeforeSent?: boolean }>();

const KEY_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

const httpError = (status: number, code: string, description: string, extra: Partial<ConstructorParameters<typeof RazorpayApiError>[0]> = {}) =>
  new RazorpayApiError({
    kind: 'http', status, code, description, message: `Razorpay returned HTTP ${status} (${code}): ${description}`,
    retryable: status >= 500 || status === 429, ...extra,
  });
const unreachable = (isWrite: boolean) =>
  new RazorpayApiError({ kind: 'network', message: 'Razorpay could not be reached', retryable: true, outcomeUnknown: isWrite });

// ---------------------------------------------------------------------------------------------- test controls
export interface SeedPayment {
  id: string; order_id: string; amount: number; currency?: string; status?: string; method?: string;
  error_code?: string; error_description?: string;
}
export function seedPayment(p: SeedPayment): ProviderPayment {
  const payment: MockPayment = {
    id: p.id, order_id: p.order_id, amount: p.amount, currency: p.currency || 'INR', status: p.status || 'captured',
    captured: (p.status || 'captured') === 'captured', method: p.method || 'upi', amount_refunded: 0, refund_status: null,
    error_code: p.error_code || null, error_description: p.error_description || null, created_at: Math.floor(Date.now() / 1000),
  };
  payments.set(p.id, payment);
  return payment;
}

const recount = (paymentId: string) => {
  const pay = payments.get(paymentId);
  if (!pay) return;
  pay.amount_refunded = [...refunds.values()].filter((r) => r.payment_id === paymentId && r.status !== 'failed').reduce((s, r) => s + r.amount, 0);
  pay.refund_status = pay.amount_refunded === 0 ? null : pay.amount_refunded >= pay.amount ? 'full' : 'partial';
  pay.status = pay.refund_status === 'full' ? 'refunded' : pay.status === 'refunded' ? 'captured' : pay.status;
};

/** Settle a pending refund (what Razorpay does later, on its own). */
export function advanceRefund(refundId: string, status: 'processed' | 'failed'): ProviderRefund {
  const r = refunds.get(refundId);
  if (!r) throw new Error('no such refund');
  if (r.status !== 'pending') throw new Error(`refund is ${r.status}, not pending`);
  r.status = status;
  recount(r.payment_id as string);
  return view(r);
}

export function mockState() {
  return {
    orders: [...rzpOrders.values()],
    payments: [...payments.values()],
    refunds: [...refunds.values()],
    refundCount: refunds.size,
    keys: [...keys.keys()],
  };
}

/** Forget every Razorpay ORDER too (resetMockState keeps them). For tests that count provider orders. */
export function clearOrders(): void { rzpOrders.clear(); }

/** Clears payments, refunds and idempotency keys and the call log. Razorpay ORDERS are kept (verify-payment needs them). */
export function resetMockState(): void {
  payments.clear(); refunds.clear(); keys.clear(); calls.length = 0; orderFaults.create = null; orderFaults.fetchByReceipt = null; orderFaults.fetchPayments = null; listLag.refunds = false; delays.paymentFetch = 0;
}

const view = (r: MockRefund): ProviderRefund => {
  const { idempotency_key: _k, ...rest } = r;
  return { ...rest, notes: { ...rest.notes } };
};

// ---------------------------------------------------------------------------------------------------- the fake
export const mockRazorpay: RazorpayLike = {
  orders: {
    async create(params: any) {
      calls.push({ fn: 'orders.create', args: [params] });
      const fault = orderFaults.create;
      if (fault === 'down') throw unreachable(true);
      if (fault === 'lostbefore') { orderFaults.create = null; throw new RazorpayApiError({ kind: 'timeout', message: 'Razorpay did not answer in time', retryable: true, outcomeUnknown: true }); }
      if (fault === 'reject') { orderFaults.create = null; throw httpError(400, 'BAD_REQUEST_ERROR', 'The amount must be at least INR 1.00'); }
      // Razorpay documents receipts as unique per account; a repeat is rejected.
      if (params.receipt && [...rzpOrders.values()].some((o) => o.receipt === params.receipt)) {
        throw httpError(400, 'BAD_REQUEST_ERROR', 'Order receipt should be unique.');
      }
      const id = `order_mock_${++seq}`;
      const order: ProviderOrder = { id, amount: params.amount, currency: params.currency, receipt: params.receipt ?? null, status: 'created', amount_paid: 0, created_at: Math.floor(Date.now() / 1000) };
      rzpOrders.set(id, order);
      if (fault === 'lostresp') { orderFaults.create = null; throw new RazorpayApiError({ kind: 'timeout', message: 'Razorpay did not answer in time', retryable: true, outcomeUnknown: true }); }
      return { ...order };
    },
    async fetch(id: string) {
      calls.push({ fn: 'orders.fetch', args: [id] });
      const o = rzpOrders.get(id);
      if (!o) throw httpError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      return { ...o };
    },
    async fetchByReceipt(receipt: string) {
      calls.push({ fn: 'orders.fetchByReceipt', args: [receipt] });
      if (orderFaults.fetchByReceipt === 'down') throw unreachable(false);
      const items = [...rzpOrders.values()].filter((o) => o.receipt === receipt).map((o) => ({ ...o }));
      return { count: items.length, items };
    },
    async fetchPayments(orderId: string) {
      calls.push({ fn: 'orders.fetchPayments', args: [orderId] });
      if (orderId.includes('apidown') || orderFaults.fetchPayments === 'down') throw unreachable(false);
      const items = [...payments.values()].filter((p) => p.order_id === orderId).map((p) => ({ ...p }));
      if (items.length === 0 && !rzpOrders.has(orderId)) throw httpError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      return { count: items.length, items };
    },
  },
  payments: {
    async refund(paymentId: string, params: any) {
      calls.push({ fn: 'payments.refund', args: [paymentId, params] });
      if (paymentId.includes('slow')) await new Promise((r) => setTimeout(r, 400));
      if (paymentId.includes('fail')) throw new Error('provider unreachable');
      if (paymentId.includes('rejected')) return { id: `rfnd_mock_${++seq}`, status: 'failed', amount: params.amount };
      if (paymentId.includes('noid')) return { status: 'processed', amount: params.amount };
      return { id: `rfnd_mock_${++seq}`, payment_id: paymentId, amount: params.amount, status: paymentId.includes('pending') ? 'pending' : 'processed' };
    },

    async fetch(paymentId: string) {
      calls.push({ fn: 'payments.fetch', args: [paymentId] });
      if (delays.paymentFetch > 0) await new Promise((r) => setTimeout(r, delays.paymentFetch));
      if (paymentId.includes('apidown')) throw unreachable(false);
      const p = payments.get(paymentId);
      if (!p) throw httpError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      return { ...p };
    },

    async fetchRefunds(paymentId: string) {
      calls.push({ fn: 'payments.fetchRefunds', args: [paymentId] });
      if (paymentId.includes('apidown')) throw unreachable(false);
      if (!payments.has(paymentId)) throw httpError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      const items = listLag.refunds ? [] : [...refunds.values()].filter((r) => r.payment_id === paymentId).reverse().map(view);
      return { count: items.length, items };
    },

    async refundIdempotent(paymentId: string, request, idempotencyKey: string) {
      calls.push({ fn: 'payments.refundIdempotent', args: [paymentId, request, idempotencyKey] });
      const body = canonicalRefundBody(request);                       // same local validation as the real client
      if (paymentId.includes('apidown')) throw unreachable(true);
      if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) {
        throw httpError(400, 'BAD_REQUEST_ERROR', 'Idempotency key must be at least 10 characters and contain only letters, numbers, hyphens and underscores');
      }
      const hash = crypto.createHash('sha256').update(`${paymentId}|${body}`).digest('hex');
      const seen = keys.get(idempotencyKey);

      if (seen) {
        if (seen.hash !== hash) {
          throw httpError(409, 'BAD_REQUEST_ERROR', 'Different request with the same idempotency key has already been processed.', { idempotencyConflict: true });
        }
        if (seen.inFlight) {
          throw httpError(409, 'BAD_REQUEST_ERROR', 'A request with this idempotency key is still being processed.', { inProgress: true, retryable: true, outcomeUnknown: true });
        }
        if (seen.refundId) return view(refunds.get(seen.refundId) as MockRefund);   // replay: the original refund, nothing new
      }

      // first sight of this key
      if (paymentId.includes('lostbefore') && !seen?.lostBeforeSent) {
        keys.set(idempotencyKey, { hash, lostBeforeSent: true });      // remembered only so the second try goes through
        throw new RazorpayApiError({ kind: 'timeout', message: 'Razorpay did not answer in time', retryable: true, outcomeUnknown: true });
      }
      const entry = seen ?? { hash };
      keys.set(idempotencyKey, entry);
      entry.inFlight = true;
      try {
        if (paymentId.includes('slow')) await new Promise((r) => setTimeout(r, 400));
        const pay = payments.get(paymentId);
        if (!pay) throw httpError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
        if (!pay.captured) throw httpError(400, 'BAD_REQUEST_ERROR', 'The payment has not been captured');
        const refundable = pay.amount - pay.amount_refunded;
        if (request.amount > refundable) {
          throw httpError(400, 'BAD_REQUEST_ERROR', 'The refund amount provided is greater than the amount captured / refundable');
        }
        const status = paymentId.includes('refundfailed') ? 'failed' : paymentId.includes('refundpending') ? 'pending' : 'processed';
        const refund: MockRefund = {
          id: `rfnd_mock_${++seq}`, payment_id: paymentId, amount: request.amount, currency: pay.currency, status,
          receipt: request.receipt ?? null, notes: { ...(request.notes || {}) }, created_at: Math.floor(Date.now() / 1000), idempotency_key: idempotencyKey,
        };
        refunds.set(refund.id, refund);
        entry.refundId = refund.id;
        recount(paymentId);
        if (paymentId.includes('lostresp') && !entry.lostSent) {
          entry.lostSent = true;                                          // done at the provider, but the answer never arrives
          throw new RazorpayApiError({ kind: 'timeout', message: 'Razorpay did not answer in time', retryable: true, outcomeUnknown: true });
        }
        return view(refund);
      } catch (e) {
        if (!entry.refundId) keys.delete(idempotencyKey);                // a rejected request does not consume the key
        throw e;
      } finally {
        entry.inFlight = false;
      }
    },
  },
};
