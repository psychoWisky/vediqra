// Deterministic Razorpay fake + a server that uses it. TEST ONLY - never imported by the application.
//   npx tsx test/serve-with-mock.ts            (PORT defaults to 5000)
// Behaviour is chosen by the payment id, so tests need no configuration:
//   *fail*      the provider call throws (network error / outage)
//   *rejected*  the provider answers with status "failed"
//   *noid*      the provider answers without a refund id
//   *pending*   the provider accepts the refund with status "pending"
//   *slow*      the provider takes 400 ms (used to prove simultaneous refunds are serialised)
//   anything else: status "processed"
import { RazorpayLike } from '../src/services/razorpayClient';

export const calls: { fn: string; args: any[] }[] = [];
const rzpOrders = new Map<string, { amount: number; currency: string }>();
let seq = 0;

export const mockRazorpay: RazorpayLike = {
  orders: {
    async create(params: any) {
      const id = `order_mock_${++seq}`;
      rzpOrders.set(id, { amount: params.amount, currency: params.currency });
      calls.push({ fn: 'orders.create', args: [params] });
      return { id, amount: params.amount, currency: params.currency, receipt: params.receipt };
    },
    async fetch(id: string) {
      calls.push({ fn: 'orders.fetch', args: [id] });
      const o = rzpOrders.get(id);
      if (!o) throw new Error('no such order');
      return { id, ...o };
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
  },
};
