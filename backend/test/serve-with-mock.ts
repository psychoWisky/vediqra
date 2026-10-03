// TEST ONLY: the real application, with Razorpay replaced by the deterministic fake in ./mockRazorpay.
import 'dotenv/config';
import express from 'express';
import { setRazorpayClient } from '../src/services/razorpayClient';
import { mockRazorpay, calls } from './mockRazorpay';
import app from '../src/app';

setRazorpayClient(mockRazorpay);
process.env.RAZORPAY_KEY_ID ||= 'rzp_test_mock';

// Test-only introspection of what the fake was asked to do. Mounted in front of the app, not part of it.
const server = express();
server.get('/__mock/calls', (_req, res) => res.json(calls));
server.post('/__mock/reset', (_req, res) => { calls.length = 0; res.json({ ok: true }); });
server.use(app);

const port = Number(process.env.PORT) || 5000;
server.listen(port, () => console.log(`mock-razorpay test server on ${port}`));
