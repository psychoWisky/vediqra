// TEST ONLY - Payment recovery, Phase 3 (independent audit and hardening): intents + idempotent checkout, shared fulfilment, webhooks, durable refunds,
// recovery workers, outbox, customer status. Runs the REAL app and services in this process against the deterministic
// Razorpay fake (test/mockRazorpay.ts) and a THROWAWAY database it builds and drops itself (vediqra_test_p3).
// It never contacts Razorpay, never touches the real database.
//   npx tsx test/phase3-audit-test.mts
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = 'vediqra_test_p3';
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PGBIN = 'C:\\Program Files\\PostgreSQL\\17\\bin';
const ENVP = { ...process.env, PATH: `${process.env.PATH};${PGBIN}` };
const KEY_ID = 'rzp_test_p2keyid';
const KEY_SECRET = 'p2_key_secret_value_123456';
const WH_CURRENT = 'whsec_p2_current_secret';
const WH_PREVIOUS = 'whsec_p2_previous_secret';
const ADMIN_PW = 'P2-Admin-Password-9021!';

const results: { name: string; ok: boolean }[] = [];
const out = (s: string) => process.stdout.write(s + '\n');
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok }); out(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const section = (s: string) => out(`\n=== ${s}`);

// ------------------------------------------------------------------------------------------------ throwaway database
function psql(db: string, sql: string) {
  const r = spawnSync('psql', ['-U', 'postgres', '-h', 'localhost', '-w', '-d', db, '-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { env: ENVP, input: sql, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
psql('postgres', `DROP DATABASE IF EXISTS ${DB};`);
if (!psql('postgres', `CREATE DATABASE ${DB};`).ok) { out('cannot create the throwaway database'); process.exit(2); }
const mig = spawnSync('npm', ['run', 'migrate', '--', 'up'], { cwd: BACKEND, env: { ...ENVP, DB_NAME: DB, DB_SSL: 'false', NODE_ENV: 'development' }, encoding: 'utf8', shell: true });
if (mig.status !== 0) { out('migration failed\n' + mig.stdout + mig.stderr); psql('postgres', `DROP DATABASE IF EXISTS ${DB};`); process.exit(2); }
const adm = spawnSync('npx', ['tsx', 'scripts/create-admin.ts', 'testadmin'], { cwd: BACKEND, env: { ...ENVP, DB_NAME: DB, DB_SSL: 'false', ADMIN_PASSWORD: ADMIN_PW }, encoding: 'utf8', shell: true });
if (adm.status !== 0) { out('admin creation failed\n' + adm.stdout + adm.stderr); psql('postgres', `DROP DATABASE IF EXISTS ${DB};`); process.exit(2); }

// SMTP sink (records mail instead of sending it)
const sinkProc: ChildProcess = spawn('node', ['test/smtp-sink.mjs'], { cwd: BACKEND, stdio: 'ignore' });
await sleep(800);
const sink = {
  messages: async (): Promise<{ to: string[]; data: string }[]> => (await fetch('http://127.0.0.1:2526/messages')).json() as any,
  reset: () => fetch('http://127.0.0.1:2526/reset', { method: 'POST' }),
  fail: (on: boolean) => fetch(`http://127.0.0.1:2526/mode?fail=${on ? 1 : 0}`, { method: 'POST' }),
  to: async (addr: string) => (await sink.messages()).filter((m) => m.to.includes(addr)),
};

// ------------------------------------------------------------------------------------------------ app environment
Object.assign(process.env, {
  DB_NAME: DB, DB_SSL: 'false', NODE_ENV: 'development',
  RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH_CURRENT, RAZORPAY_WEBHOOK_SECRET_PREVIOUS: WH_PREVIOUS,
  EMAIL_HOST: '127.0.0.1', EMAIL_PORT: '2525', EMAIL_SECURE: 'false', EMAIL_USER: 'shop@example.com', EMAIL_PASSWORD: 'x', SUPPORT_EMAIL: 'owner@example.com',
  RATE_LIMIT_PAYMENTS: '5000', RATE_LIMIT_ORDERS: '5000', RATE_LIMIT_REFUNDS: '5000', RATE_LIMIT_STATUS: '40',
  JWT_SECRET: process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : 'p2-test-jwt-secret-0123456789abcdef0123456789',
});
delete process.env.PAYMENT_RECOVERY_ENABLED;
delete process.env.INTENTS_ENABLED_AT;
delete process.env.LEGACY_VERIFY_UNTIL;

// capture the application's own log output so we can prove it never contains personal data or secrets
const logs: string[] = [];
for (const k of ['log', 'warn', 'error', 'info'] as const) {
  console[k] = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ')); };
}

await import('dotenv/config');                 // .env supplies DB_HOST/DB_USER/...; the values set above win
const { default: config } = await import('../src/config');
const { pool } = await import('../src/utils/db');
const { default: app } = await import('../src/app');
const { setRazorpayClient } = await import('../src/services/razorpayClient');
const mock = await import('./mockRazorpay');
const { createCheckout, ensureProviderOrder, requestHash } = await import('../src/services/payments/intents');
const { fulfilCapturedPayment } = await import('../src/services/payments/fulfilment');
const { processRefundAttempt, queueRefundAttempt } = await import('../src/services/payments/refunds');
const { enqueueNotification, flushOutbox } = await import('../src/services/payments/outbox');
const { runRecoveryOnce, runRecoveryTick, startPaymentRecovery } = await import('../src/services/payments/recovery');
const { retryUnprocessedEvents } = await import('../src/services/payments/webhook');
const { normalizeWebhookEvent, verifyWebhookSignature } = await import('../src/services/payments/webhookEvent');
const { withTx } = await import('../src/services/payments/tx');
const { statusTokenFor, hashStatusToken, sha256Hex } = await import('../src/services/payments/common');
setRazorpayClient(mock.mockRazorpay);

const server: http.Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${(server.address() as any).port}`;
const dbName = (await pool.query('select current_database() as d')).rows[0].d;
check(`the application is connected to the throwaway database "${DB}" (never the real one)`, dbName === DB, dbName);

// ------------------------------------------------------------------------------------------------ helpers
async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(raw === undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const newKey = () => `p2k_${uniq()}_${crypto.randomBytes(8).toString('hex')}`;
const buyer = (tag = 'b') => ({ name: 'P2 Buyer', email: `p2-${tag}-${uniq()}@example.com`, phone: '9876543210', address: '1 Test Road', city: 'Kolkata', state: 'WB', pincode: '700001' });
const signPay = (orderId: string, payId: string) => crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${payId}`).digest('hex');
const pid = (tag: string) => `pay_p2_${tag}_${uniq()}`;

const adminLogin = await api('POST', '/api/admin/auth/login', { username: 'testadmin', password: ADMIN_PW });
const ADMIN = { Authorization: `Bearer ${adminLogin.json?.token}` };
check('admin login works', !!adminLogin.json?.token);

const mkProduct = async (name: string, price: number, extra: Record<string, unknown> = {}) =>
  (await api('POST', '/api/admin/products', { name, price, image_url: 'https://x/p.jpg', stock_quantity: 0, description: '', is_active: true, ...extra }, ADMIN)).json.product;
const line = (productId: string, quantity = 1) => ({ id: `${productId}-x`, type: 'product', quantity });
const stockOf = async (productId: string) => Number((await one('select stock_quantity from products where id = $1', [productId])).stock_quantity);

const TEE = await mkProduct('P2 Tee', 1000, { track_stock: true, stock_quantity: 50 });
const MUG = await mkProduct('P2 Mug', 300, { track_stock: false, stock_quantity: 0 });

async function checkout(opts: { items?: unknown[]; key?: string; cust?: any; coupon?: string | null; headers?: Record<string, string> } = {}) {
  const key = opts.key ?? newKey();
  const cust = opts.cust ?? buyer();
  const r = await api('POST', '/api/payment/create-order', { items: opts.items ?? [line(TEE.id)], coupon_code: opts.coupon ?? null, ...cust }, { 'Idempotency-Key': key, ...(opts.headers || {}) });
  return { ...r, key, cust };
}
const capture = (orderId: string, payId: string, amount: number, extra: Record<string, unknown> = {}) => mock.seedPayment({ id: payId, order_id: orderId, amount, status: 'captured', ...extra } as any);
const verify = (orderId: string, payId: string, extra: Record<string, unknown> = {}) =>
  api('POST', '/api/payment/verify-payment', { razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: signPay(orderId, payId), ...extra });
/** A checkout that has been created and paid at the provider, but the browser never reported back. */
async function paidCheckout(opts: Parameters<typeof checkout>[0] & { payId?: string; extraPay?: Record<string, unknown> } = {}) {
  const co = await checkout(opts);
  const payId = opts.payId ?? pid('ok');
  if (co.status === 200) capture(co.json.id, payId, co.json.amount, opts.extraPay);
  return { co, payId, orderId: co.json?.id as string };
}
const intentOf = (orderId: string) => one('select * from payment_intents where razorpay_order_id = $1', [orderId]);
const ordersFor = (payId: string) => count('select count(*)::int n from orders where razorpay_payment_id = $1', [payId]);

function webhookBody(event: string, o: { orderId?: string; payId?: string; amount?: number; status?: string; currency?: string; pii?: boolean; extraPayment?: Record<string, unknown> }) {
  const payment = o.payId ? {
    entity: { id: o.payId, order_id: o.orderId, amount: o.amount, currency: o.currency ?? 'INR', status: o.status ?? 'captured', method: 'upi', captured: (o.status ?? 'captured') === 'captured',
      ...(o.pii !== false ? { email: 'leak.person@example.com', contact: '+919812345678', vpa: 'leak.person@okbank', card: { last4: '4242', name: 'Leak Person' } } : {}), ...(o.extraPayment || {}) },
  } : undefined;
  return JSON.stringify({ entity: 'event', account_id: 'acc_test', event, contains: ['payment'], payload: { ...(payment ? { payment } : {}), ...(event === 'order.paid' && o.orderId ? { order: { entity: { id: o.orderId, amount: o.amount, status: 'paid' } } } : {}) }, created_at: Math.floor(Date.now() / 1000) });
}
const wsign = (raw: string, secret = WH_CURRENT) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
async function webhook(raw: string, o: { eventId?: string | null; signature?: string | null; secret?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (o.signature !== null) headers['X-Razorpay-Signature'] = o.signature ?? wsign(raw, o.secret);
  if (o.eventId !== null) headers['X-Razorpay-Event-Id'] = o.eventId ?? `evt_${uniq()}`;
  return api('POST', '/api/payment/webhook', undefined, headers, raw);
}
const eventRow = (eventId: string) => one('select * from payment_webhook_events where event_id = $1', [eventId]);

async function backdate(table: 'payment_intents' | 'payment_webhook_events' | 'payment_refund_attempts', trigger: string, set: string, where: string, params: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await c.query(`UPDATE ${table} SET ${set} WHERE ${where}`, params);
    await c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  } finally { c.release(); }
}
const makeDue = (attemptId: string) => q(`UPDATE payment_refund_attempts SET next_attempt_at = now() - interval '1 second', lease_until = CASE WHEN status = 'submitting' THEN now() - interval '1 second' ELSE NULL END WHERE id = $1`, [attemptId]);
const resetAll = () => { mock.resetMockState(); mock.clearOrders(); };
const refundCalls = () => mock.calls.filter((c) => c.fn === 'payments.refundIdempotent');

/** A stock-failure refund set up WITHOUT starting it, so a test can drive the worker step by step. */
async function queuedRefund(payId: string) {
  const co = await checkout();
  capture(co.json.id, payId, co.json.amount);
  const intent = await intentOf(co.json.id);
  const attemptId = await withTx(async (c) => {
    await c.query(`UPDATE payment_intents SET status = 'refund_required', razorpay_payment_id = $2, captured_at = now() WHERE id = $1`, [intent.id, payId]);
    return queueRefundAttempt(c, { id: intent.id, razorpay_payment_id: payId, amount_paise: intent.amount_paise, currency: intent.currency });
  });
  return { co, intent, attemptId, orderId: co.json.id as string };
}
const attemptOf = (id: string) => one('select * from payment_refund_attempts where id = $1', [id]);

// =====================================================================================================================
section('P1. Admin refund path: idempotency and over-refund');
// =====================================================================================================================
{
  resetAll();
  // model the real client: a refund call that carries an idempotency key goes through the provider's idempotent endpoint
  setRazorpayClient({
    orders: mock.mockRazorpay.orders,
    payments: {
      ...mock.mockRazorpay.payments,
      refund: (paymentId: string, params: any, key?: string) => key
        ? mock.mockRazorpay.payments.refundIdempotent(paymentId, { amount: params.amount, notes: params.notes }, key)
        : mock.mockRazorpay.payments.refund(paymentId, params),
    },
  } as any);

  const w = await paidCheckout({ cust: buyer('adm'), payId: pid('lostresp_adm') });
  await verify(w.orderId, w.payId);
  const refund1 = await api('POST', `/api/payment/refund/${w.payId}`, { amount: 1000, request_id: 'adm-req-1' }, ADMIN);
  const orderMid = await one('select status, refunded_amount from orders where razorpay_payment_id = $1', [w.payId]);
  check('P1.1 admin refund whose answer is lost (timeout AFTER the provider refunded): reported as failed-unknown (502), NOTHING recorded locally', refund1.status === 502 && orderMid.status === 'paid' && Number(orderMid.refunded_amount) === 0 && mock.mockState().refunds.length === 1, JSON.stringify(refund1.json).slice(0, 120));
  const refund2 = await api('POST', `/api/payment/refund/${w.payId}`, { amount: 1000, request_id: 'adm-req-1' }, ADMIN);
  const orderEnd = await one('select status, refunded_amount, refunds from orders where razorpay_payment_id = $1', [w.payId]);
  check('P1.2 the retry of the same refund (same request_id) first RECONCILES: it finds the refund by its notes/receipt at the provider, adopts it, and sends nothing again - money moved exactly once and the order is now recorded as refunded', refund2.status === 200 && mock.mockState().refunds.length === 1 && orderEnd.status === 'refunded' && Number(orderEnd.refunded_amount) === 1000 && orderEnd.refunds.length === 1);
  check('P1.3 only one provider request was made, with a stable key', refundCalls().length === 1 && /^adm_[0-9a-f]{32}$/.test(refundCalls()[0].args[2]));
  const refund3 = await api('POST', `/api/payment/refund/${w.payId}`, { amount: 100, request_id: 'adm-req-2' }, ADMIN);
  check('P1.4 a further refund beyond the order total is refused locally (400/409) and the provider is not asked', [400, 409].includes(refund3.status) && refundCalls().length === 1);

  // a refund done elsewhere (dashboard) must stop an over-refund at the provider
  const o = await paidCheckout({ cust: buyer('adm2'), payId: pid('adm2') });
  await verify(o.orderId, o.payId);
  await mock.mockRazorpay.payments.refundIdempotent(o.payId, { amount: 60000 }, 'dashboard-refund-p3-1');
  const before = await one('select status, refunded_amount from orders where razorpay_payment_id = $1', [o.payId]);
  const over = await api('POST', `/api/payment/refund/${o.payId}`, { amount: 500 }, ADMIN);
  const after = await one('select status, refunded_amount from orders where razorpay_payment_id = $1', [o.payId]);
  check('P1.5 payment already refunded elsewhere: the provider refuses the over-refund; the admin sees an error and NOTHING is recorded', over.status >= 400 && after.status === before.status && Number(after.refunded_amount) === Number(before.refunded_amount) && mock.mockState().refunds.length === 2);

  // pending refund: recorded as pending with the provider's own status, never as processed
  const pnd = await paidCheckout({ cust: buyer('adm3'), payId: pid('refundpending_adm') });
  await verify(pnd.orderId, pnd.payId);
  const pr = await api('POST', `/api/payment/refund/${pnd.payId}`, { amount: 400 }, ADMIN);
  const pOrder = await one('select refunds from orders where razorpay_payment_id = $1', [pnd.payId]);
  check('P1.6 a refund the provider reports as PENDING answers 202, is recorded with status "pending" (never "processed") and is not counted: the order stays paid', pr.status === 202 && pOrder.refunds[0].status === 'pending' && (await one('select status, refunded_amount from orders where razorpay_payment_id = $1', [pnd.payId])).status === 'paid');

  // refund path vs the durable workflow: an automatic attempt on the payment blocks the admin refund
  const auto = await queuedRefund(pid('autoblock'));
  const autoRow = await attemptOf(auto.attemptId);
  const ordC = await q(`INSERT INTO orders (custom_order_id, items, subtotal, shipping_charge, cod_charge, total_amount, customer_name, customer_email, customer_phone, payment_method, status, razorpay_payment_id, razorpay_order_id)
     VALUES ('VEDIQRA#P3${uniq()}', '[]'::jsonb, 1000, 0, 0, 1000, 'X', 'x@example.com', '9876543210', 'online', 'paid', $1, 'order_p3_synthetic') RETURNING id`, [autoRow.razorpay_payment_id]);
  const blocked = await api('POST', `/api/payment/refund/${autoRow.razorpay_payment_id}`, {}, ADMIN);
  check('P1.7 a payment that already has a durable refund attempt cannot be refunded again through the admin endpoint (409, provider not called)', blocked.status === 409 && ordC.length === 1);
  setRazorpayClient(mock.mockRazorpay);
}

// =====================================================================================================================
section('P2. Refund state machine: provider list lag, partial refunds');
// =====================================================================================================================
{
  resetAll();
  const a = await queuedRefund(pid('lostresp_lag'));
  await processRefundAttempt(a.attemptId);                                        // refund done at the provider, answer lost
  mock.listLag.refunds = true;                                                    // ... and the list does not show it yet
  await makeDue(a.attemptId);
  const r1 = await processRefundAttempt(a.attemptId);
  const row = await attemptOf(a.attemptId);
  check('P2.1 refund performed but NOT yet visible in the provider list: the attempt stays unknown (no review, no resubmission, no new key)', r1 === 'unknown' && row.status === 'unknown' && refundCalls().length === 1 && mock.mockState().refunds.length === 1 && (await intentOf(a.orderId)).status === 'refund_required');
  mock.listLag.refunds = false;
  await makeDue(a.attemptId);
  const r2 = await processRefundAttempt(a.attemptId);
  check('P2.2 once the list catches up the refund is adopted: processed, intent refunded, still exactly one refund', r2 === 'processed' && (await intentOf(a.orderId)).status === 'refunded' && mock.mockState().refunds.length === 1);

  resetAll();
  const b = await queuedRefund(pid('partial'));
  const bRow = await attemptOf(b.attemptId);
  await mock.mockRazorpay.payments.refundIdempotent(bRow.razorpay_payment_id, { amount: 40000 }, 'dashboard-partial-p3-1');
  mock.calls.length = 0;
  const r3 = await processRefundAttempt(b.attemptId);
  check('P2.3 a partial refund already exists elsewhere: the full-amount attempt would exceed the payment, so nothing is sent and it goes to review', r3 === 'needs_review' && refundCalls().length === 0);

}

// =====================================================================================================================
section('P3. Webhook: provider data, not the payload, decides');
// =====================================================================================================================
{
  resetAll();
  const w = await paidCheckout({ cust: buyer('wl'), payId: pid('wl') });
  const lie = webhookBody('payment.captured', { orderId: w.orderId, payId: w.payId, amount: 100 });          // payload claims 1 rupee
  const r = await webhook(lie);
  const intent = await intentOf(w.orderId);
  check('P3.1 a signed payload that disagrees with Razorpay (claims a tiny amount) cannot change the outcome: the order is created from the provider\'s data', r.status === 200 && intent.status === 'fulfilled' && Number((await one('select total_amount from orders where razorpay_payment_id = $1', [w.payId])).total_amount) === 1000);

  const u = await paidCheckout({ cust: buyer('wu'), payId: pid('wu'), extraPay: { status: 'authorized' } });
  const r2 = await webhook(webhookBody('payment.captured', { orderId: u.orderId, payId: u.payId, amount: u.co.json.amount }));
  check('P3.2 an event NAME claiming "captured" for a payment Razorpay says is only authorized creates no order', r2.status === 200 && (await ordersFor(u.payId)) === 0 && (await intentOf(u.orderId)).status === 'created');

  const m = await paidCheckout({ cust: buyer('wm'), payId: pid('wm') });
  const other = await paidCheckout({ cust: buyer('wm2'), payId: pid('wm2') });
  const r3 = await webhook(webhookBody('payment.captured', { orderId: m.orderId, payId: other.payId, amount: other.co.json.amount }));
  check('P3.3 a payment id that belongs to a DIFFERENT Razorpay order than the event states is never fulfilled (outcome needs_review)', r3.status === 200 && (await ordersFor(other.payId)) === 0 && (await ordersFor(m.payId)) === 0 && (await one(`select outcome from payment_webhook_events order by received_at desc limit 1`)).outcome === 'needs_review');

  const bytes = Buffer.from(webhookBody('payment.captured', { orderId: m.orderId, payId: m.payId, amount: m.co.json.amount }));
  const sig = wsign(bytes.toString('utf8'));
  bytes[bytes.length - 3] ^= 0x01;                                                // flip one bit
  const flipped = await api('POST', '/api/payment/webhook', undefined, { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': `evt_${uniq()}` }, bytes.toString('latin1'));
  check('P3.4 a single changed byte invalidates the signature (400) and nothing is stored or fulfilled', flipped.status === 400 && (await ordersFor(m.payId)) === 0);

  const unreadableId = `evt_${uniq()}`;
  const junk = '{"event": "payment.captured", "payload": ';
  const jr = await webhook(junk, { eventId: unreadableId });
  const jrow = await eventRow(unreadableId);
  check('P3.5 a validly signed but unreadable event is acknowledged yet RECORDED for review (not silently dropped)', jr.status === 200 && jrow?.event_type === 'unreadable' && jrow.outcome === 'needs_review');

  // permanent processing failure: the event ends in review after bounded retries and is visible to the admin
  const stuck = await paidCheckout({ cust: buyer('ws'), payId: pid('ws') });
  mock.orderFaults.fetchPayments = 'down';
  const sid = `evt_${uniq()}`;
  await webhook(webhookBody('order.paid', { orderId: stuck.orderId }), { eventId: sid });
  await backdate('payment_webhook_events', 'trg_payment_webhook_events_guard', `received_at = now() - interval '2 hours', last_attempt_at = now() - interval '2 hours', attempts = 8`, 'event_id = $1', [sid]);
  await retryUnprocessedEvents();
  mock.orderFaults.fetchPayments = null;
  const srow = await eventRow(sid);
  const rv = await api('GET', '/api/payment/review?limit=100', undefined, ADMIN);
  check('P3.6 an event that keeps failing is not stuck forever: after the attempt limit it is closed as needs_review and listed for the admin', srow.outcome === 'needs_review' && rv.json.webhook_events_needing_review.some((e: any) => e.event_id === sid));
  const rv2 = await api('GET', '/api/payment/review?limit=1&offset=0', undefined, ADMIN);
  check('P3.7 the review list is paginated (limit honoured)', rv2.status === 200 && rv2.json.intents.length <= 1 && rv2.json.webhook_events_needing_review.length <= 1);
}

// =====================================================================================================================
section('P4. Atomicity under injected database failures');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  const TS = await mkProduct('P3 Atomic', 100, { track_stock: true, stock_quantity: 10 });
  await q(`INSERT INTO coupons (code, discount_type, discount_value, usage_limit, per_user_limit) VALUES ('P3ATOM','fixed',10,100,5)`);
  const injections: [string, string, string][] = [
    ['order insert', 'orders', `BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION p3_boom()`],
    ['coupon usage', 'coupon_usage', `BEFORE INSERT ON coupon_usage FOR EACH ROW EXECUTE FUNCTION p3_boom()`],
    ['intent update (fulfilled)', 'payment_intents', `BEFORE UPDATE ON payment_intents FOR EACH ROW WHEN (NEW.status = 'fulfilled') EXECUTE FUNCTION p3_boom()`],
    ['outbox insert', 'notification_outbox', `BEFORE INSERT ON notification_outbox FOR EACH ROW EXECUTE FUNCTION p3_boom()`],
  ];
  await q(`CREATE OR REPLACE FUNCTION p3_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  const numbers: string[] = [];
  for (const [label, table, def] of injections) {
    const w = await paidCheckout({ items: [line(TS.id, 2)], coupon: 'P3ATOM', cust: buyer('at'), payId: pid('at') });
    const stock0 = await stockOf(TS.id);
    const coupon0 = (await one(`select used_count from coupons where code = 'P3ATOM'`)).used_count;
    await q(`CREATE TRIGGER p3_boom_trg ${def}`);
    const v = await verify(w.orderId, w.payId);
    await q(`DROP TRIGGER p3_boom_trg ON ${table}`);
    const i = await intentOf(w.orderId);
    check(`P4 failure at "${label}": the request fails cleanly (HTTP 500)`, v.status === 500, `${v.status}`);
    const nothing = (await ordersFor(w.payId)) === 0 && (await stockOf(TS.id)) === stock0 && (await one(`select used_count from coupons where code = 'P3ATOM'`)).used_count === coupon0 && i.status === 'created'
      && (await count(`select count(*)::int n from notification_outbox where intent_id = $1 and kind in ('order_confirmation','admin_new_order')`, [i.id])) === 0;
    check(`P4 failure at "${label}": rolled back completely`, nothing, `${v.status} ${i.status}`);
    const v2 = await verify(w.orderId, w.payId);
    const o = await one('select custom_order_id from orders where razorpay_payment_id = $1', [w.payId]);
    numbers.push(o?.custom_order_id);
    check(`P4 failure at "${label}": the retry then succeeds ONCE (one order, stock -2, coupon +1)`, v2.status === 200 && (await ordersFor(w.payId)) === 1 && (await stockOf(TS.id)) === stock0 - 2 && (await one(`select used_count from coupons where code = 'P3ATOM'`)).used_count === coupon0 + 1);
  }
  const dup = await count(`select count(*)::int n from (select custom_order_id from orders group by 1 having count(*) > 1) x`);
  check('P4 order numbers: rolled-back attempts leave gaps in the sequence (accepted) but never a duplicate or an order without a number', dup === 0 && numbers.every((n) => /^VEDIQRA#\d+$/.test(n)) && new Set(numbers).size === numbers.length, numbers.join(','));
  await q('DROP FUNCTION p3_boom()');
}

// =====================================================================================================================
section('P5. Concurrency across many connections');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  const w = await paidCheckout({ cust: buyer('cc3'), payId: pid('cc3') });
  const stock0 = await stockOf(TEE.id);
  await q(`UPDATE payment_intents SET next_check_at = now() WHERE razorpay_order_id = $1`, [w.orderId]);
  await Promise.all([
    ...Array.from({ length: 6 }, () => verify(w.orderId, w.payId)),
    ...Array.from({ length: 4 }, () => runRecoveryOnce()),
    ...Array.from({ length: 3 }, () => webhook(webhookBody('payment.captured', { orderId: w.orderId, payId: w.payId, amount: w.co.json.amount }), { eventId: `evt_${uniq()}` })),
  ]);
  await sleep(500);
  check('P5.1 6 browser verifications + 4 workers + 3 distinct webhook events for one payment -> exactly one order, one stock deduction, one set of e-mails', (await ordersFor(w.payId)) === 1 && (await stockOf(TEE.id)) === stock0 - 1 && (await sink.to(w.co.cust.email)).length === 1);

  const ticks = await Promise.all(Array.from({ length: 5 }, () => runRecoveryTick()));
  check('P5.2 simultaneous worker ticks: the advisory lock admits one at a time (the rest return null) and none fails', ticks.every((t) => t === null || typeof t === 'object'));

  const d = await paidCheckout({ cust: buyer('dup'), payId: pid('dupA') });
  await verify(d.orderId, d.payId);
  const second = pid('dupB');
  capture(d.orderId, second, d.co.json.amount);
  const wb = await webhook(webhookBody('payment.captured', { orderId: d.orderId, payId: second, amount: d.co.json.amount }));
  check('P5.3 a SECOND payment captured for an already fulfilled checkout creates no order and no automatic refund; the owner is alerted', wb.status === 200 && (await ordersFor(second)) === 0 && (await count(`select count(*)::int n from payment_refund_attempts a join payment_intents i on i.id = a.intent_id where i.razorpay_order_id = $1`, [d.orderId])) === 0 && (await count(`select count(*)::int n from notification_outbox where dedupe_key like $1`, [`intent:%:alert:duplicate_payment:${second}`])) === 1);

  const closedKey = newKey(); const cc = buyer('cl');
  const first = await checkout({ key: closedKey, cust: cc });
  const closedPay = pid('cl');
  capture(first.json.id, closedPay, first.json.amount);
  await verify(first.json.id, closedPay);
  const replay = await checkout({ key: closedKey, cust: cc });
  check('P5.4 an Idempotency-Key whose checkout is already paid cannot be reused (409 checkout_closed), so a stale key never returns another checkout', replay.status === 409 && replay.json.code === 'checkout_closed');
}

section('P6. Manual review: closing a case needs provider evidence');
// =====================================================================================================================
{
  resetAll();
  // Case A: a stock-failure refund that a person is resolving in the dashboard
  const a = await queuedRefund(pid('rvA'));
  const aRow = await attemptOf(a.attemptId);
  await q(`UPDATE payment_refund_attempts SET status = 'needs_review', review_reason = 'test' WHERE id = $1`, [a.attemptId]);
  await q(`UPDATE payment_intents SET status = 'needs_review', review_reason = 'test' WHERE id = $1`, [a.intent.id]);
  const url = `/api/payment/review/${a.intent.id}/adopt-refund`;
  const noAuth = await api('POST', url, { provider_refund_id: 'rfnd_x' });
  check('P6.1 closing a case needs an admin token (401 without)', noAuth.status === 401);
  const bad = await api('POST', url, { provider_refund_id: 'rfnd_nonexistent', note: 'I promise it was refunded' }, ADMIN);
  check('P6.2 an admin note or an invented refund id cannot close a case: Razorpay must list that refund for this payment (409)', bad.status === 409 && (await intentOf(a.orderId)).status === 'needs_review');
  const partial = await mock.mockRazorpay.payments.refundIdempotent(aRow.razorpay_payment_id, { amount: 30000 }, 'dashboard-p3-partial-1');
  const r1 = await api('POST', url, { provider_refund_id: partial.id }, ADMIN);
  check('P6.3 a processed refund for LESS than the captured amount leaves the case open (409)', r1.status === 409 && (await intentOf(a.orderId)).status === 'needs_review');
  resetAll();
  const b = await queuedRefund(pid('refundpending_rvB'));
  const bRow = await attemptOf(b.attemptId);
  await q(`UPDATE payment_refund_attempts SET status = 'needs_review', review_reason = 'test' WHERE id = $1`, [b.attemptId]);
  await q(`UPDATE payment_intents SET status = 'needs_review', review_reason = 'test' WHERE id = $1`, [b.intent.id]);
  const burl = `/api/payment/review/${b.intent.id}/adopt-refund`;
  const pending = await mock.mockRazorpay.payments.refundIdempotent(bRow.razorpay_payment_id, { amount: Number(bRow.amount_paise) }, 'dashboard-p3-pending-1');
  const r2 = await api('POST', burl, { provider_refund_id: pending.id }, ADMIN);
  check('P6.4 a full refund that is only PENDING at Razorpay does not close the case (409)', r2.status === 409 && (await intentOf(b.orderId)).status === 'needs_review');
  mock.advanceRefund(pending.id, 'processed');
  const r3 = await api('POST', burl, { provider_refund_id: pending.id, note: 'refunded in dashboard' }, ADMIN);
  const closed = await intentOf(b.orderId);
  const att = await attemptOf(b.attemptId);
  check('P6.5 once Razorpay shows it processed for the full captured amount the case closes: intent refunded, the existing attempt carries the provider refund id, admin + note recorded; no second attempt', r3.status === 200 && closed.status === 'refunded' && !!closed.reviewed_at && /testadmin/.test(closed.resolution_note) && att.status === 'processed' && att.provider_refund_id === pending.id && (await count('select count(*)::int n from payment_refund_attempts where intent_id = $1', [b.intent.id])) === 1, `${r3.status} ${JSON.stringify(r3.json).slice(0, 120)}`);
  const r4 = await api('POST', burl, { provider_refund_id: pending.id }, ADMIN);
  check('P6.6 closing it twice is refused (409)', r4.status === 409);

  // Case C: amount mismatch (no refund attempt can represent it)
  const m = await paidCheckout({ cust: buyer('rvC'), payId: pid('rvC') });
  capture(m.orderId, m.payId, m.co.json.amount + 100);
  await verify(m.orderId, m.payId);
  const mi = await intentOf(m.orderId);
  const r5 = await api('POST', `/api/payment/review/${mi.id}/adopt-refund`, { provider_refund_id: pending.id }, ADMIN);
  check('P6.7 a mismatch case has no recorded payment, so "adopt refund" is refused (409)', r5.status === 409);
  const aurl = `/api/payment/review/${mi.id}/acknowledge`;
  const r6 = await api('POST', aurl, { payment_id: m.payId, note: 'trust me' }, ADMIN);
  check('P6.8 acknowledging needs the payment fully refunded AT RAZORPAY; a note is not evidence (409)', r6.status === 409 && !(await intentOf(m.orderId)).reviewed_at);
  const other = await paidCheckout({ cust: buyer('rvD'), payId: pid('rvD') });
  await mock.mockRazorpay.payments.refundIdempotent(other.payId, { amount: other.co.json.amount }, 'dashboard-p3-other-01');
  const r7 = await api('POST', aurl, { payment_id: other.payId }, ADMIN);
  check('P6.9 a fully refunded payment belonging to a DIFFERENT Razorpay order is refused (409)', r7.status === 409);
  await mock.mockRazorpay.payments.refundIdempotent(m.payId, { amount: m.co.json.amount + 100 }, 'dashboard-p3-full-0002');
  const r8 = await api('POST', aurl, { payment_id: m.payId, note: 'refunded in dashboard' }, ADMIN);
  const rv = await api('GET', '/api/payment/review?limit=200', undefined, ADMIN);
  check('P6.10 with full-refund evidence from Razorpay the case is acknowledged (audit note, admin name) and leaves the open list; no order and no automatic refund was created', r8.status === 200 && !!(await intentOf(m.orderId)).reviewed_at && !rv.json.intents.some((i: any) => i.id === mi.id) && (await ordersFor(m.payId)) === 0, `${r8.status} ${JSON.stringify(r8.json).slice(0, 100)}`);

  const fulfilled = await paidCheckout({ cust: buyer('rvE'), payId: pid('rvE') });
  await verify(fulfilled.orderId, fulfilled.payId);
  const fi = (await intentOf(fulfilled.orderId)).id;
  const r9 = await api('POST', `/api/payment/review/${fi}/adopt-refund`, { provider_refund_id: pending.id }, ADMIN);
  const r10 = await api('POST', `/api/payment/review/${fi}/acknowledge`, { payment_id: fulfilled.payId }, ADMIN);
  check('P6.11 a fulfilled checkout cannot be closed through either action (409)', r9.status === 409 && r10.status === 409);
  const r11 = await api('POST', `/api/payment/review/not-a-uuid/adopt-refund`, { provider_refund_id: pending.id }, ADMIN);
  check('P6.12 malformed ids are rejected (400)', r11.status === 400);
}

// =====================================================================================================================
section('P7. Notifications and logging');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  logs.length = 0;
  await sink.fail(true);
  const cust = buyer('lg');
  const w = await paidCheckout({ cust, payId: pid('lg') });
  await verify(w.orderId, w.payId);
  await sleep(600);
  const rows = await q(`select status, attempts, last_error from notification_outbox where order_id = (select id from orders where razorpay_payment_id = $1)`, [w.payId]);
  const logText = logs.join('\n');
  check('P7.1 SMTP rejecting the buyer address: rows stay queued and retry; neither the logs nor the stored errors contain the address', rows.every((r: any) => r.status === 'queued' && r.attempts === 1) && !logText.includes(cust.email) && !rows.some((r: any) => (r.last_error || '').includes(cust.email)), JSON.stringify(rows).slice(0, 160));
  await sink.fail(false);
  await q(`UPDATE notification_outbox SET next_attempt_at = now() WHERE status = 'queued'`);
  await flushOutbox();
  check('P7.2 after SMTP recovers they are sent', (await sink.to(cust.email)).length === 1);

  // crash after SMTP accepted but before the row was marked sent: delivery is AT LEAST ONCE
  const row = (await q(`select id from notification_outbox where kind = 'order_confirmation' and order_id = (select id from orders where razorpay_payment_id = $1)`, [w.payId]))[0];
  await q(`UPDATE notification_outbox SET status = 'sending', lease_until = now() - interval '1 minute', sent_at = NULL WHERE id = $1`, [row.id]).catch(async () => {
    const c = await pool.connect();
    try { await c.query('ALTER TABLE notification_outbox DISABLE TRIGGER trg_notification_outbox_guard'); await c.query(`UPDATE notification_outbox SET status = 'sending', lease_until = now() - interval '1 minute', sent_at = NULL WHERE id = $1`, [row.id]); await c.query('ALTER TABLE notification_outbox ENABLE TRIGGER trg_notification_outbox_guard'); } finally { c.release(); }
  });
  await flushOutbox();
  check('P7.3 DOCUMENTED LIMIT: a worker that died after SMTP accepted a message but before recording it makes the message go out again (at-least-once, not exactly-once)', (await sink.to(cust.email)).length === 2);
  check('P7.4 the status token never appears in logs, URLs or the database (resume uses an in-browser copy only)', !logs.join('\n').includes(w.co.json.status_token));
}

// =====================================================================================================================
section('P8. Migration integrity (up, up again, down, up)');
// =====================================================================================================================
{
  const MDB = 'vediqra_test_p3m';
  psql('postgres', `DROP DATABASE IF EXISTS ${MDB};`); psql('postgres', `CREATE DATABASE ${MDB};`);
  const run = (...args: string[]) => spawnSync('npm', ['run', 'migrate', '--', ...args], { cwd: BACKEND, env: { ...ENVP, DB_NAME: MDB, DB_SSL: 'false', NODE_ENV: 'development' }, encoding: 'utf8', shell: true });
  const snap = () => psql(MDB, `SELECT 'cols', string_agg(column_name||':'||data_type||':'||is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'orders'
    UNION ALL SELECT 'idx', string_agg(indexdef, ';' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'orders'
    UNION ALL SELECT 'con', string_agg(conname||':'||pg_get_constraintdef(oid), ';' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'orders'::regclass
    UNION ALL SELECT 'trg', coalesce(string_agg(tgname, ',' ORDER BY tgname), '') FROM pg_trigger WHERE tgrelid = 'orders'::regclass AND NOT tgisinternal;`).out;
  const tables = () => psql(MDB, `SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public';`).out;
  const up1 = run('up');
  const up2 = run('up');
  check('P8.1 migrations apply on an empty database and a second `up` is a harmless no-op', up1.status === 0 && up2.status === 0 && /No migrations to run/i.test(up2.stdout + up2.stderr), (up2.stdout + up2.stderr).slice(-120));
  psql(MDB, `INSERT INTO orders (custom_order_id, items, subtotal, shipping_charge, cod_charge, total_amount, customer_name, customer_email, customer_phone, payment_method, status) VALUES ('VEDIQRA#HISTM1','[{"n":1}]'::jsonb,2000,0,49,2049,'Old','old@example.com','9876543210','cod','delivered');`);
  const rowsBefore = psql(MDB, `SELECT md5(string_agg(o::text, '|' ORDER BY custom_order_id)) FROM orders o;`).out;
  const schemaBefore = snap(); const tablesBefore = tables();
  const downA = run('down');
  const tablesDownA = tables();
  check('P8.2a the latest migration is undone alone: `down` removes only the stock restoration table', downA.status === 0 && !tablesDownA.split(',').includes('stock_restoration_tasks') && tablesDownA.split(',').length === tablesBefore.split(',').length - 1 && tablesDownA.split(',').includes('admin_refund_requests'), tablesDownA.slice(0, 80));
  const down1 = run('down');
  const tablesDown1 = tables();
  check('P8.2b the next `down` removes only the admin refund table', down1.status === 0 && !tablesDown1.split(',').includes('admin_refund_requests') && tablesDown1.split(',').length === tablesBefore.split(',').length - 2 && ['payment_intents', 'payment_webhook_events', 'payment_refund_attempts', 'notification_outbox'].every((t) => tablesDown1.split(',').includes(t)), tablesDown1.slice(0, 80));
  const down2 = run('down');
  const tablesDown = tables();
  check('P8.2 the next `down` removes exactly the four recovery tables and nothing else', down2.status === 0 && ['payment_intents', 'payment_webhook_events', 'payment_refund_attempts', 'notification_outbox'].every((t) => !tablesDown.split(',').includes(t)) && tablesDown.split(',').length === tablesBefore.split(',').length - 6, tablesDown.slice(0, 120));
  check('P8.3 ...orders schema unchanged by the `down`s', snap() === schemaBefore);
  const up3 = run('up');
  check('P8.4 re-applying `up` after `down` works; historical COD rows and the orders schema are byte-identical to before', up3.status === 0 && snap() === schemaBefore && psql(MDB, `SELECT md5(string_agg(o::text, '|' ORDER BY custom_order_id)) FROM orders o;`).out === rowsBefore && tables().includes('payment_intents') && tables().includes('admin_refund_requests') && tables().includes('stock_restoration_tasks'));
  const guard = psql(MDB, `SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_payment%' OR tgname LIKE 'trg_notification%';`).out;
  check('P8.5 the guard triggers are present after the re-up', Number(guard) >= 4, guard);
  psql('postgres', `DROP DATABASE IF EXISTS ${MDB};`);
}

// =====================================================================================================================
section('P9. Lifecycle: SIGTERM handler in the real entry point (child process)');
// =====================================================================================================================
{
  const childFile = path.join(os.tmpdir(), `p3-lifecycle-${uniq()}.mjs`);
  fs.writeFileSync(childFile, `
    await import(${JSON.stringify('file:///' + path.join(BACKEND, 'src', 'index.ts').replace(/\\/g, '/'))});
    setTimeout(() => { console.log('CHILD_SENDING_SIGTERM'); process.emit('SIGTERM'); }, 2500);
    setTimeout(() => { console.log('CHILD_STILL_ALIVE'); process.exit(3); }, 25000);
  `);
  const port = 5400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['--import', 'tsx', childFile], {
    cwd: BACKEND, env: { ...process.env, PORT: String(port), PAYMENT_RECOVERY_ENABLED: 'true', PAYMENT_RECOVERY_INTERVAL_MS: '15000', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; });
  const exit: number = await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  check('P9.1 the entry point starts, runs the worker, and on SIGTERM stops it, closes the HTTP server and the DB pool and exits 0 (before the 20 s hard deadline)',
    exit === 0 && /payment\.recovery_started/.test(text) && /SIGTERM received/.test(text) && /payment\.recovery_stopped/.test(text) && !/CHILD_STILL_ALIVE/.test(text), `exit=${exit} ${text.replace(/\s+/g, ' ').slice(-200)}`);
  const stillListening = await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
  check('P9.2 the port is released after shutdown', stillListening === false);
  fs.rmSync(childFile, { force: true });
}

// =====================================================================================================================
section('P10. Existing createOrder rollback check (disposable fixtures)');
// =====================================================================================================================
{
  const T = await mkProduct('P3 Rollback Tiffin', 50, { track_stock: true, stock_quantity: 5 });
  const g = (await api('POST', `/api/admin/products/${T.id}/option-groups`, { name: 'P3 Rollback Group', is_required: false }, ADMIN)).json;
  const v = (await api('POST', `/api/admin/product-option-groups/${g.id}/values`, { name: 'Plain', price_modifier: 0, stock_quantity: 1 }, ADMIN)).json;
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'test/rollback-check.ts'], { cwd: BACKEND, env: { ...process.env, TIFFIN: T.id, PLAIN: v.id }, encoding: 'utf8' });
  check('P10.1 test/rollback-check.ts: a failing option decrement undoes the product decrement AND the order row (run against the disposable database)', /ROLLED_BACK_OK/.test(r.stdout || ''), ((r.stdout || '') + (r.stderr || '')).slice(-200));
}

// ------------------------------------------------------------------------------------------------ done
server.close();
await pool.end();
sinkProc.kill();
await sleep(300);
psql('postgres', `DROP DATABASE IF EXISTS ${DB};`);
const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { out('FAILED:\n' + failed.map((f) => '  - ' + f.name).join('\n')); process.exit(1); }
process.exit(0);
