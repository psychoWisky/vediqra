// TEST ONLY: the real application, with Razorpay replaced by the deterministic fake in ./mockRazorpay.
import 'dotenv/config';
import express from 'express';
import { setRazorpayClient } from '../src/services/razorpayClient';
import { mockRazorpay, calls, seedPayment, advanceRefund, mockState, resetMockState } from './mockRazorpay';
import app from '../src/app';

setRazorpayClient(mockRazorpay);
process.env.RAZORPAY_KEY_ID ||= 'rzp_test_mock';

// Test-only introspection of what the fake was asked to do. Mounted in front of the app, not part of it.
const server = express();
server.get('/__mock/calls', (_req, res) => res.json(calls));
// Clears the call log, payments, refunds and idempotency keys (Razorpay orders are kept: verify-payment needs them).
server.post('/__mock/reset', (_req, res) => { resetMockState(); res.json({ ok: true }); });
// Payment-recovery fixtures: create a payment at "Razorpay", settle a pending refund, inspect the whole fake.
server.post('/__mock/payments', express.json(), (req, res) => res.json(seedPayment(req.body)));
server.post('/__mock/refunds/:id/advance', express.json(), (req, res) => {
  try { res.json(advanceRefund(req.params.id, req.body?.status)); } catch (e: any) { res.status(400).json({ error: e.message }); }
});
server.get('/__mock/state', (_req, res) => res.json(mockState()));
server.use(app);

const port = Number(process.env.PORT) || 5000;
server.listen(port, () => console.log(`mock-razorpay test server on ${port}`));
