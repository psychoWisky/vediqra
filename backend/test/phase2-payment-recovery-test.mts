// TEST ONLY - Payment recovery, Phase 2: intents + idempotent checkout, shared fulfilment, webhooks, durable refunds,
// recovery workers, outbox, customer status. Runs the REAL app and services in this process against the deterministic
// Razorpay fake (test/mockRazorpay.ts) and a THROWAWAY database it builds and drops itself (vediqra_test_p2).
// It never contacts Razorpay, never touches the real database.
//   npx tsx test/phase2-payment-recovery-test.mts
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = 'vediqra_test_p2';
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
section('A. Durable intents and checkout idempotency');
// =====================================================================================================================
{
  resetAll();
  mock.orderFaults.create = 'down';
  const key = newKey();
  const cust = buyer('a1');
  const r1 = await checkout({ key, cust });
  const stuck = await one('select * from payment_intents where idempotency_key = $1', [key]);
  check('A1 the intent is committed (state preparing) BEFORE Razorpay is asked; a provider outage leaves it recoverable', r1.status === 503 && stuck?.status === 'preparing' && stuck.razorpay_order_id === null, `${r1.status} ${stuck?.status}`);
  check('A1 ...with an immutable server snapshot: amount in paise, currency, quote, customer, request hash', Number(stuck.amount_paise) === 100000 + 0 && stuck.currency === 'INR' && stuck.quote.total_amount === 1000 && stuck.customer.email === cust.email && /^[0-9a-f]{64}$/.test(stuck.snapshot_hash), `${stuck.amount_paise}`);
  check('A1 ...and the provider never received an order', mock.mockState().orders.length === 0);
  mock.orderFaults.create = null;
  const r2 = await checkout({ key, cust });
  const after = await one('select * from payment_intents where idempotency_key = $1', [key]);
  check('A2 retrying with the SAME key resumes the same intent and creates exactly one Razorpay order', r2.status === 200 && after.id === stuck.id && after.status === 'created' && mock.mockState().orders.length === 1, `${r2.status}`);
  check('A2 response carries only what the browser needs (id, amount, currency, key id, total, token), no snapshot internals', ['id', 'amount', 'currency', 'receipt', 'key_id', 'total_amount', 'status_token'].every((k) => k in r2.json) && !('quote' in r2.json) && !('customer' in r2.json) && r2.json.key_id === KEY_ID && r2.json.amount === 100000);

  const r3 = await checkout({ key, cust });
  check('A3 same key + same request again returns the same Razorpay order, amount and token (no second intent, no second order)', r3.json.id === r2.json.id && r3.json.status_token === r2.json.status_token && (await count('select count(*)::int n from payment_intents where idempotency_key = $1', [key])) === 1 && mock.mockState().orders.length === 1);
  const r4 = await checkout({ key, cust, items: [line(TEE.id, 2)] });
  check('A4 same key + a DIFFERENT cart -> 409, nothing created', r4.status === 409 && mock.mockState().orders.length === 1, JSON.stringify(r4.json));
  const r5 = await checkout({ key, cust: { ...cust, phone: '9000000001' } });
  check('A4 same key + different customer details -> 409', r5.status === 409);
  const r6 = await checkout({ cust });
  check('A5 a NEW key for the same cart is a separate checkout (its own intent and Razorpay order)', r6.status === 200 && r6.json.id !== r2.json.id && mock.mockState().orders.length === 2);

  const noKey = await api('POST', '/api/payment/create-order', { items: [line(TEE.id)], ...buyer() });
  const shortKey = await checkout({ key: 'short' });
  const before = await count('select count(*)::int n from payment_intents');
  check('A6 a missing or malformed Idempotency-Key is rejected (400) and nothing is stored', noKey.status === 400 && shortKey.status === 400 && (await count('select count(*)::int n from payment_intents')) === before);
  const badCust = await checkout({ cust: { ...buyer(), phone: '123' } });
  check('A6 invalid customer details are rejected before anything is stored', badCust.status === 400 && (await count('select count(*)::int n from payment_intents')) === before);

  // concurrency
  resetAll();
  const ckey = newKey();
  const ccust = buyer('conc');
  const results = await Promise.all(Array.from({ length: 8 }, () => checkout({ key: ckey, cust: ccust })));
  const ids = new Set(results.map((r) => r.json?.id));
  check('A7 eight simultaneous requests with one key -> one intent, one Razorpay order, identical answers', results.every((r) => r.status === 200) && ids.size === 1 && (await count('select count(*)::int n from payment_intents where idempotency_key = $1', [ckey])) === 1 && mock.mockState().orders.length === 1, `${[...ids].length} ids, ${mock.mockState().orders.length} orders`);

  // provider timeouts / ambiguous creation
  resetAll();
  mock.orderFaults.create = 'lostresp';
  const lkey = newKey(); const lcust = buyer('l');
  const l1 = await checkout({ key: lkey, cust: lcust });
  const lstuck = await one('select * from payment_intents where idempotency_key = $1', [lkey]);
  check('A8 ambiguous creation (Razorpay created the order but the answer was lost): 503, intent stays preparing, order exists at the provider', l1.status === 503 && lstuck.status === 'preparing' && mock.mockState().orders.length === 1);
  const l2 = await checkout({ key: lkey, cust: lcust });
  check('A8 the retry FINDS that order by its receipt and attaches it: still exactly one provider order', l2.status === 200 && mock.mockState().orders.length === 1 && mock.mockState().orders[0].id === l2.json.id && mock.mockState().orders[0].receipt === l2.json.receipt, `${l2.status}`);
  mock.orderFaults.create = 'lostbefore';
  const bkey = newKey(); const bcust = buyer('bb');
  const b1 = await checkout({ key: bkey, cust: bcust });
  const b2 = await checkout({ key: bkey, cust: bcust });
  check('A9 a timeout where nothing reached the provider: 503, then the retry creates exactly one order', b1.status === 503 && b2.status === 200 && mock.mockState().orders.length === 2);
  mock.orderFaults.create = 'reject';
  const rkey = newKey(); const rcust = buyer('rj');
  const x1 = await checkout({ key: rkey, cust: rcust });
  const x2 = await checkout({ key: rkey, cust: rcust });
  check('A10 a definite provider rejection: 502 and the intent stays resumable; the retry succeeds', x1.status === 502 && x2.status === 200);

  // database failure AFTER the provider created the order
  resetAll();
  const realQuery = pool.query.bind(pool);
  let failed = false;
  (pool as any).query = (...a: any[]) => {
    if (!failed && typeof a[0] === 'string' && a[0].includes('SET razorpay_order_id = $2')) { failed = true; return Promise.reject(new Error('simulated database failure')); }
    return (realQuery as any)(...a);
  };
  const dkey = newKey(); const dcust = buyer('db');
  const d1 = await checkout({ key: dkey, cust: dcust });
  (pool as any).query = realQuery;
  const dstuck = await one('select * from payment_intents where idempotency_key = $1', [dkey]);
  check('A11 database failure after the provider created the order: 500, intent still preparing, order exists only at the provider', d1.status === 500 && dstuck.status === 'preparing' && dstuck.razorpay_order_id === null && mock.mockState().orders.length === 1);
  const d2 = await checkout({ key: dkey, cust: dcust });
  check('A11 the retry reconciles by receipt (no duplicate Razorpay order)', d2.status === 200 && mock.mockState().orders.length === 1);

  // a retry returns the ORIGINAL price even if the catalogue changed
  const pkey = newKey(); const pcust = buyer('pr');
  const p1 = await checkout({ key: pkey, cust: pcust });
  await q('update products set price = 1500 where id = $1', [TEE.id]);
  const p2 = await checkout({ key: pkey, cust: pcust });
  await q('update products set price = 1000 where id = $1', [TEE.id]);
  check('A12 a retry returns the originally priced checkout (the snapshot is immutable)', p1.json.amount === 100000 && p2.json.amount === 100000 && p2.json.id === p1.json.id);

  // token: derivable, only the hash is stored
  const tk = p1.json.status_token as string;
  const row = await one('select * from payment_intents where razorpay_order_id = $1', [p1.json.id]);
  const dump = JSON.stringify(await q('select * from payment_intents'));
  check('A13 status token: >= 256 bits, only its sha256 is stored, the token itself is nowhere in the database', tk.length >= 43 && row.status_token_hash === hashStatusToken(tk) && !dump.includes(tk));
}

// =====================================================================================================================
section('B. Shared fulfilment: browser verification');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  const stock0 = await stockOf(TEE.id);
  const cust = buyer('b1');
  const { co, payId, orderId } = await paidCheckout({ cust });
  const v = await verify(orderId, payId, { order_data: { items: [line(MUG.id, 9)], total_amount: 1, name: 'Mallory', email: 'mallory@example.com' } });
  const intent = await intentOf(orderId);
  const order = await one('select * from orders where razorpay_payment_id = $1', [payId]);
  check('B1 verify-payment creates the order and keeps the response shape (200, success, order.id / custom_order_id / amount)', v.status === 200 && v.json.success && v.json.order.id === order.id && v.json.order.custom_order_id === order.custom_order_id && Number(v.json.order.amount) === 1000, JSON.stringify(v.json).slice(0, 160));
  check('B2 the browser\'s order_data is ignored: the order is the stored snapshot (1 x Tee, 1000, buyer from create-order)', Number(order.total_amount) === 1000 && order.customer_email === cust.email && order.customer_name === 'P2 Buyer' && JSON.stringify(order.items).includes(TEE.id) && !JSON.stringify(order.items).includes(MUG.id));
  check('B3 intent is fulfilled and linked: order_id, payment id, captured/fulfilled times; order is online + paid; stock taken once (50 -> 49)', intent.status === 'fulfilled' && intent.order_id === order.id && intent.razorpay_payment_id === payId && !!intent.fulfilled_at && order.payment_method === 'online' && order.status === 'paid' && (await stockOf(TEE.id)) === stock0 - 1);
  const v2 = await verify(orderId, payId);
  check('B4 verifying the same payment again returns the same order: no second order, no second stock decrement', v2.status === 200 && v2.json.order.id === order.id && (await ordersFor(payId)) === 1 && (await stockOf(TEE.id)) === stock0 - 1);
  await sleep(300);
  const outbox = await q('select kind, status from notification_outbox where order_id = $1 order by kind', [order.id]);
  check('B5 confirmation + admin e-mails were queued with the order and sent after commit (exactly one each; the confirmation also copies the owner)', outbox.length === 2 && outbox.every((o: any) => o.status === 'sent') && (await sink.to(cust.email)).length === 1 && (await sink.messages()).length === 2, JSON.stringify(outbox) + ` cust=${(await sink.to(cust.email)).length} owner=${(await sink.to('owner@example.com')).length} all=${JSON.stringify((await sink.messages()).map((m) => m.to))}`);

  const other = await paidCheckout();
  const wrong = await verify(orderId, other.payId);
  check('B6 a payment that belongs to a DIFFERENT Razorpay order is refused (400)', wrong.status === 400, JSON.stringify(wrong.json));
  const noProv = await verify(orderId, 'pay_p2_does_not_exist');
  check('B7 a payment Razorpay does not know is refused (400), nothing created', noProv.status === 400);
  capture('order_unknown_1', 'pay_unknown_1', 100000);
  const unknown = await api('POST', '/api/payment/verify-payment', { razorpay_order_id: 'order_unknown_1', razorpay_payment_id: 'pay_unknown_1', razorpay_signature: signPay('order_unknown_1', 'pay_unknown_1') });
  check('B8 a correctly signed payment for a checkout we have no record of: 409, no order (legacy fallback is off by default)', unknown.status === 409 && (await ordersFor('pay_unknown_1')) === 0);

  // authorized but not captured yet
  const auth = await paidCheckout({ payId: pid('auth'), extraPay: { status: 'authorized' } });
  const va = await verify(auth.orderId, auth.payId);
  check('B9 authorized-not-captured payment: 202 "being confirmed", no order, intent untouched', va.status === 202 && va.json.pending === true && (await ordersFor(auth.payId)) === 0 && (await intentOf(auth.orderId)).status === 'created');
  capture(auth.orderId, auth.payId, auth.co.json.amount);                      // it gets captured later
  await q(`UPDATE payment_intents SET next_check_at = now() WHERE razorpay_order_id = $1`, [auth.orderId]);
  await runRecoveryOnce();
  check('B10 ...and the recovery job completes it once Razorpay captures it', (await ordersFor(auth.payId)) === 1 && (await intentOf(auth.orderId)).status === 'fulfilled');

  // provider outage while the browser verifies
  const out1 = await paidCheckout({ payId: pid('apidown') });
  const vo = await verify(out1.orderId, out1.payId);
  check('B11 Razorpay unreachable during verification: 202 pending, the payment is not lost, intent queued for an immediate re-check', vo.status === 202 && (await intentOf(out1.orderId)).status === 'created' && (await ordersFor(out1.payId)) === 0);

  // browser closes: recovery job alone
  const closed = await paidCheckout({ payId: pid('closed') });
  await q(`UPDATE payment_intents SET next_check_at = now() WHERE razorpay_order_id = $1`, [closed.orderId]);
  const sum = await runRecoveryOnce();
  check('B12 the browser never returns and no webhook arrives: the recovery job finds the captured payment and creates the order', (await ordersFor(closed.payId)) === 1 && (await intentOf(closed.orderId)).status === 'fulfilled' && sum.fulfilled >= 1);

  // mismatches
  const mm = await paidCheckout({ payId: pid('amt') });
  capture(mm.orderId, mm.payId, mm.co.json.amount + 100);                     // replace with a wrong amount
  const sOrders = await count('select count(*)::int n from orders');
  const vm = await verify(mm.orderId, mm.payId);
  const mmi = await intentOf(mm.orderId);
  check('B13 captured amount differs from the snapshot: no order, no automatic refund, intent -> needs_review with a reason + admin alert', vm.status === 409 && vm.json.under_review === true && mmi.status === 'needs_review' && /amount mismatch/.test(mmi.review_reason) && (await count('select count(*)::int n from orders')) === sOrders && (await count('select count(*)::int n from payment_refund_attempts where intent_id = $1', [mmi.id])) === 0 && (await count(`select count(*)::int n from notification_outbox where intent_id = $1 and kind = 'admin_alert'`, [mmi.id])) === 1);
  const cm = await paidCheckout({ payId: pid('cur'), extraPay: { currency: 'USD' } });
  await verify(cm.orderId, cm.payId);
  check('B14 currency mismatch -> needs_review, no order', (await intentOf(cm.orderId)).status === 'needs_review' && (await ordersFor(cm.payId)) === 0);
  const rf = await paidCheckout({ payId: pid('prefund') });
  capture(rf.orderId, rf.payId, rf.co.json.amount);
  (mock.mockState().payments.find((p) => p.id === rf.payId) as any).amount_refunded = 5000;
  await verify(rf.orderId, rf.payId);
  check('B15 a payment already (partly) refunded at the provider is not auto-fulfilled -> needs_review', (await intentOf(rf.orderId)).status === 'needs_review' && (await ordersFor(rf.payId)) === 0);
  const again = await verify(mm.orderId, mm.payId);
  check('B16 a review case stays parked: re-verifying it neither fulfils nor refunds', again.status === 409 && (await intentOf(mm.orderId)).status === 'needs_review' && (await ordersFor(mm.payId)) === 0);

  // concurrency: browser + webhook + recovery at once
  const cc = await paidCheckout({ cust: buyer('conc2'), payId: pid('race') });
  await q(`UPDATE payment_intents SET next_check_at = now() WHERE razorpay_order_id = $1`, [cc.orderId]);
  const s1 = await stockOf(TEE.id);
  const raw = webhookBody('payment.captured', { orderId: cc.orderId, payId: cc.payId, amount: cc.co.json.amount });
  await Promise.all([
    verify(cc.orderId, cc.payId), verify(cc.orderId, cc.payId), webhook(raw), webhook(webhookBody('order.paid', { orderId: cc.orderId, payId: cc.payId, amount: cc.co.json.amount })),
    runRecoveryOnce(), fulfilCapturedPayment({ razorpayOrderId: cc.orderId, paymentId: cc.payId, amountPaise: cc.co.json.amount, currency: 'INR' }, 'recovery'),
  ]);
  await sleep(300);
  const cOrder = await q('select id from orders where razorpay_payment_id = $1', [cc.payId]);
  check('B17 browser x2 + two webhooks + recovery + direct call at the same moment -> exactly ONE order, stock taken once, one confirmation e-mail', cOrder.length === 1 && (await stockOf(TEE.id)) === s1 - 1 && (await count(`select count(*)::int n from notification_outbox where order_id = $1 and kind = 'order_confirmation'`, [cOrder[0].id])) === 1 && (await sink.to(cc.co.cust.email)).length === 1, `${cOrder.length} orders`);
}

// =====================================================================================================================
section('C. Webhooks');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  const w = await paidCheckout({ cust: buyer('wh'), payId: pid('wh') });
  const raw = webhookBody('payment.captured', { orderId: w.orderId, payId: w.payId, amount: w.co.json.amount });
  const eventsBefore = await count('select count(*)::int n from payment_webhook_events');
  const bad = await webhook(raw, { signature: 'f'.repeat(64) });
  const missing = await webhook(raw, { signature: null });
  const tampered = await webhook(raw.replace('"upi"', '"card"'), { signature: wsign(raw) });
  const wrongSecret = await webhook(raw, { secret: 'not-the-secret' });
  check('C1 invalid / missing / tampered-body / wrong-secret signatures -> 400 and NOTHING stored or fulfilled', [bad, missing, tampered, wrongSecret].every((r) => r.status === 400) && (await count('select count(*)::int n from payment_webhook_events')) === eventsBefore && (await ordersFor(w.payId)) === 0);
  const eid = `evt_${uniq()}`;
  const spaced = raw.replace(/^\{/, '{ \n  ') + '\n\n';                        // different bytes than JSON.stringify would produce
  const ok = await webhook(spaced, { eventId: eid });
  const ev = await eventRow(eid);
  check('C2 the signature is checked over the RAW bytes (a body with unusual whitespace verifies; it would not after JSON re-serialisation)', ok.status === 200 && ev?.outcome === 'applied' && !!ev.processed_at);
  check('C3 payment.captured with no browser creates the order via the shared service; the event row links the intent', (await ordersFor(w.payId)) === 1 && ev.intent_id === (await intentOf(w.orderId)).id && (await intentOf(w.orderId)).status === 'fulfilled');
  const evDump = JSON.stringify(await q('select * from payment_webhook_events'));
  check('C4 no payload, e-mail, phone, UPI id, card data or signature is stored in the event table', !/leak\.person|9812345678|okbank|4242|Leak Person/.test(evDump) && !evDump.includes(wsign(spaced)));
  const dup = await webhook(spaced, { eventId: eid });
  check('C5 a repeated delivery of the same event id is acknowledged (200 duplicate) and changes nothing', dup.status === 200 && dup.json.duplicate === true && (await ordersFor(w.payId)) === 1 && (await eventRow(eid)).attempts === 2);
  const other = await webhook(webhookBody('order.paid', { orderId: w.orderId, payId: w.payId, amount: w.co.json.amount }));
  check('C6 order.paid (a different event for the same payment) is a safe no-op: still one order', other.status === 200 && (await ordersFor(w.payId)) === 1);
  const prev = await webhook(webhookBody('payment.captured', { orderId: w.orderId, payId: w.payId, amount: w.co.json.amount }), { secret: WH_PREVIOUS });
  check('C7 a delivery signed with the PREVIOUS secret (during rotation) is accepted', prev.status === 200);

  // failed -> captured, and captured -> failed
  const f = await paidCheckout({ cust: buyer('wf'), payId: pid('wf') });
  await webhook(webhookBody('payment.failed', { orderId: f.orderId, payId: pid('failedtry'), amount: f.co.json.amount, status: 'failed', extraPayment: { error_code: 'BAD_REQUEST_ERROR' } }));
  const fi = await intentOf(f.orderId);
  check('C8 payment.failed is informational: counted on a live intent, state unchanged (created)', fi.status === 'created' && fi.failed_attempts === 1 && fi.last_failure_code === 'BAD_REQUEST_ERROR');
  await webhook(webhookBody('payment.captured', { orderId: f.orderId, payId: f.payId, amount: f.co.json.amount }));
  check('C9 a failed attempt followed by a successful one still fulfils (failed never blocks later success)', (await intentOf(f.orderId)).status === 'fulfilled' && (await ordersFor(f.payId)) === 1);
  await webhook(webhookBody('payment.failed', { orderId: f.orderId, payId: pid('late'), amount: f.co.json.amount, status: 'failed' }));
  const fi2 = await intentOf(f.orderId);
  check('C10 out of order: payment.failed arriving AFTER success cannot downgrade or change a fulfilled intent', fi2.status === 'fulfilled' && fi2.failed_attempts === 1 && (await ordersFor(f.payId)) === 1);

  // events that are not ours / not interesting / unreadable
  const unk = await webhook(webhookBody('payment.captured', { orderId: 'order_not_ours_1', payId: 'pay_not_ours_1', amount: 100 }));
  const unkEv = await one(`select outcome from payment_webhook_events where razorpay_payment_id = 'pay_not_ours_1'`);
  check('C11 a captured payment for an order we have no intent for: 200, outcome unknown_order, nothing created', unk.status === 200 && unkEv.outcome === 'unknown_order' && (await ordersFor('pay_not_ours_1')) === 0);
  const ign = await webhook(webhookBody('refund.processed', { orderId: w.orderId, payId: w.payId, amount: 100 }));
  check('C12 event types we do not handle are acknowledged and recorded as ignored', ign.status === 200 && (await one(`select outcome from payment_webhook_events where event_type = 'refund.processed'`)).outcome === 'ignored');
  const junk = '[1,2,3]';
  const junkRes = await webhook(junk);
  check('C13 a signed body that is not an event object is acknowledged without side effects', junkRes.status === 200 && junkRes.json.ignored === true);
  const noId = await webhook(webhookBody('payment.captured', { orderId: w.orderId, payId: w.payId, amount: w.co.json.amount }), { eventId: null });
  check('C14 a missing event-id header falls back to a hash of the body (still deduplicated)', noId.status === 200 && (await count(`select count(*)::int n from payment_webhook_events where event_id like 'body_%'`)) === 1);
  const empty = await api('POST', '/api/payment/webhook', undefined, { 'X-Razorpay-Signature': 'a'.repeat(64) }, '');
  check('C15 an empty body is rejected (400)', empty.status === 400);

  // processing failure -> 500, stored, retried
  const pf = await paidCheckout({ cust: buyer('pf'), payId: pid('pf') });
  mock.orderFaults.fetchPayments = 'down';
  const pfEvent = `evt_${uniq()}`;
  const pfRes = await webhook(webhookBody('order.paid', { orderId: pf.orderId }), { eventId: pfEvent });
  const pfRow = await eventRow(pfEvent);
  check('C16 a processing failure (provider outage) answers 500 (so Razorpay retries) but the event is already stored, unprocessed, with a safe error', pfRes.status === 500 && pfRow && pfRow.processed_at === null && !!pfRow.last_error && !/rzp_|Basic /.test(pfRow.last_error));
  mock.orderFaults.fetchPayments = null;
  const redeliver = await webhook(webhookBody('order.paid', { orderId: pf.orderId }), { eventId: pfEvent });
  check('C17 Razorpay\'s retry of that event succeeds and completes it', redeliver.status === 200 && (await eventRow(pfEvent)).outcome === 'applied' && (await ordersFor(pf.payId)) === 1);

  const pf2 = await paidCheckout({ cust: buyer('pf2'), payId: pid('pf2') });
  mock.orderFaults.fetchPayments = 'down';
  const pf2Event = `evt_${uniq()}`;
  await webhook(webhookBody('order.paid', { orderId: pf2.orderId }), { eventId: pf2Event });
  mock.orderFaults.fetchPayments = null;
  await backdate('payment_webhook_events', 'trg_payment_webhook_events_guard', `received_at = now() - interval '10 minutes', last_attempt_at = now() - interval '10 minutes'`, 'event_id = $1', [pf2Event]);
  const finished = await retryUnprocessedEvents();
  check('C18 even if Razorpay never retries, the recovery job finishes a stored unprocessed event via the provider', finished >= 1 && (await eventRow(pf2Event)).outcome === 'applied' && (await ordersFor(pf2.payId)) === 1);

  const savedSecret = config.razorpayWebhookSecret; const savedPrev = config.razorpayWebhookSecretPrevious;
  (config as any).razorpayWebhookSecret = ''; (config as any).razorpayWebhookSecretPrevious = '';
  const noSecret = await webhook(raw);
  (config as any).razorpayWebhookSecret = savedSecret; (config as any).razorpayWebhookSecretPrevious = savedPrev;
  check('C19 with no webhook secret configured the endpoint answers 503 (never accepts unsigned events)', noSecret.status === 503);
}

// ---- the pure normaliser / verifier
{
  section('C+. Event normalisation helper');
  const evn = normalizeWebhookEvent('e1', JSON.parse(webhookBody('payment.captured', { orderId: 'order_x1', payId: 'pay_x1', amount: 5000 })));
  check('N1 only ids, amounts, currency, status and method survive normalisation (no e-mail / contact / card / vpa)', evn.razorpayOrderId === 'order_x1' && evn.paymentId === 'pay_x1' && evn.amountPaise === 5000 && !/leak|9812|okbank|4242/.test(JSON.stringify(evn)));
  const weird = normalizeWebhookEvent('e2', { event: 'payment.captured', payload: { payment: { entity: { id: 'pay bad id!', order_id: 'order_ok1', amount: '5000', currency: 'INR', status: 'captured' } } } });
  check('N2 malformed ids and string amounts are dropped, not trusted', weird.paymentId === null && weird.amountPaise === null && weird.razorpayOrderId === 'order_ok1');
  let threw = 0; for (const bad of [null, [], 'x', { event: 5 }, { event: 'a b' }]) { try { normalizeWebhookEvent('e3', bad); } catch { threw++; } }
  check('N3 non-objects and bad event names are rejected', threw === 5);
  const body = Buffer.from('{"a":1}');
  const sig = crypto.createHmac('sha256', 's1').update(body).digest('hex');
  check('N4 signature verification: right secret ok; wrong/short/odd/absent signature or no secret rejected; either of two secrets accepted',
    verifyWebhookSignature(body, sig, ['s1']) && !verifyWebhookSignature(body, sig, ['s2']) && !verifyWebhookSignature(body, 'abc', ['s1']) && !verifyWebhookSignature(body, undefined, ['s1']) && !verifyWebhookSignature(body, sig, []) && verifyWebhookSignature(body, sig, ['s2', 's1']));
}

// =====================================================================================================================
section('D. Stock failure after capture -> one durable full refund');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  const TS = await mkProduct('P2 Scarce', 400, { track_stock: true, stock_quantity: 3 });
  const cust = buyer('sf');
  const co = await checkout({ items: [line(TS.id, 2)], cust });
  const payId = pid('stock');
  capture(co.json.id, payId, co.json.amount);
  await q('update products set stock_quantity = 0 where id = $1', [TS.id]);        // sold out between checkout and payment
  const ordersBefore = await count('select count(*)::int n from orders');
  const v = await verify(co.json.id, payId);
  await sleep(300);
  const intent = await intentOf(co.json.id);
  const attempts = await q('select * from payment_refund_attempts where intent_id = $1', [intent.id]);
  check('D1 paid but sold out: 409 telling the buyer the payment is refunded; no order; stock untouched (0)', v.status === 409 && v.json.refunded === true && /refunded/.test(v.json.error) && (await count('select count(*)::int n from orders')) === ordersBefore && (await stockOf(TS.id)) === 0, JSON.stringify(v.json).slice(0, 200));
  check('D2 exactly one refund attempt for the FULL captured amount, processed with a provider refund id; intent -> refunded', attempts.length === 1 && attempts[0].status === 'processed' && Number(attempts[0].amount_paise) === co.json.amount && /^rfnd_/.test(attempts[0].provider_refund_id) && intent.status === 'refunded');
  check('D3 the provider performed exactly one refund (stable idempotency key + receipt)', mock.mockState().refunds.length === 1 && refundCalls().length === 1 && refundCalls()[0].args[2] === attempts[0].idempotency_key && mock.mockState().refunds[0].receipt === attempts[0].receipt);
  const again = await verify(co.json.id, payId);
  const hook = await webhook(webhookBody('payment.captured', { orderId: co.json.id, payId, amount: co.json.amount }));
  await runRecoveryOnce();
  check('D4 browser retry + webhook + worker pass later: still ONE refund, no order, nothing re-queued', mock.mockState().refunds.length === 1 && (await count('select count(*)::int n from payment_refund_attempts where intent_id = $1', [intent.id])) === 1 && hook.status === 200 && again.status === 409 && (await ordersFor(payId)) === 0);
  check('D5 the buyer got one refund notice e-mail; the owner got an alert; no payment details beyond the reference', (await sink.to(cust.email)).length === 1 && (await sink.to('owner@example.com')).length >= 1);

  // Stock failure discovered by the WEBHOOK (browser never returned)
  await q('update products set stock_quantity = 1 where id = $1', [TS.id]);
  const co2 = await checkout({ items: [line(TS.id, 1)], cust: buyer('sf2') });
  const pay2 = pid('stock2');
  capture(co2.json.id, pay2, co2.json.amount);
  await q('update products set stock_quantity = 0 where id = $1', [TS.id]);
  await webhook(webhookBody('payment.captured', { orderId: co2.json.id, payId: pay2, amount: co2.json.amount }));
  check('D6 the same refund path runs when the webhook (not the browser) finds the shortage', (await intentOf(co2.json.id)).status === 'refunded' && mock.mockState().refunds.length === 2);
}

// =====================================================================================================================
section('E. Refund reconciliation, pending, failure, concurrency, crash');
// =====================================================================================================================
{
  // E1 provider performed the refund but the answer was lost
  resetAll();
  const a = await queuedRefund(pid('lostresp'));
  const r1 = await processRefundAttempt(a.attemptId);
  const k1 = refundCalls().map((c) => c.args[2]);
  const row1 = await attemptOf(a.attemptId);
  check('E1 timeout AFTER the provider refunded: attempt -> unknown (not failed, not processed); the intent is NOT marked refunded', r1 === 'unknown' && row1.status === 'unknown' && row1.attempts === 1 && (await intentOf(a.orderId)).status === 'refund_required' && mock.mockState().refunds.length === 1);
  await makeDue(a.attemptId);
  const r2 = await processRefundAttempt(a.attemptId);
  const row2 = await attemptOf(a.attemptId);
  check('E2 the next pass RECONCILES (lists the payment\'s refunds, matches our receipt) and adopts it: processed, no second submission, no second refund', r2 === 'processed' && row2.status === 'processed' && refundCalls().length === 1 && mock.mockState().refunds.length === 1 && mock.calls.some((c) => c.fn === 'payments.fetchRefunds') && (await intentOf(a.orderId)).status === 'refunded');

  // E3 request never reached the provider
  resetAll();
  const b = await queuedRefund(pid('lostbefore'));
  const b1 = await processRefundAttempt(b.attemptId);
  check('E3 timeout BEFORE the provider saw the request: unknown, nothing refunded yet', b1 === 'unknown' && mock.mockState().refunds.length === 0);
  await makeDue(b.attemptId);
  const b2 = await processRefundAttempt(b.attemptId);
  const keys = refundCalls().map((c) => c.args[2]);
  check('E4 reconciliation finds nothing, so the SAME request is sent again with the SAME idempotency key -> exactly one refund', b2 === 'processed' && keys.length === 2 && keys[0] === keys[1] && JSON.stringify(refundCalls()[0].args[1]) === JSON.stringify(refundCalls()[1].args[1]) && mock.mockState().refunds.length === 1);

  // E5 pending is not processed
  resetAll();
  const c1 = await queuedRefund(pid('refundpending'));
  const c2 = await processRefundAttempt(c1.attemptId);
  const cRow = await attemptOf(c1.attemptId);
  check('E5 a refund the provider accepted as PENDING is recorded as pending; the intent is not "refunded" yet', c2 === 'pending' && cRow.status === 'pending' && cRow.provider_status === 'pending' && /^rfnd_/.test(cRow.provider_refund_id) && (await intentOf(c1.orderId)).status === 'refund_required');
  mock.advanceRefund(cRow.provider_refund_id, 'processed');
  await makeDue(c1.attemptId);
  const c3 = await processRefundAttempt(c1.attemptId);
  check('E6 once the provider settles it, the next pass records processed and only then marks the intent refunded; still one refund', c3 === 'processed' && (await intentOf(c1.orderId)).status === 'refunded' && refundCalls().length === 1);

  resetAll();
  const d1 = await queuedRefund(pid('refundpending'));
  await processRefundAttempt(d1.attemptId);
  const dRow = await attemptOf(d1.attemptId);
  mock.advanceRefund(dRow.provider_refund_id, 'failed');
  await makeDue(d1.attemptId);
  const d2 = await processRefundAttempt(d1.attemptId);
  const dAfter = await attemptOf(d1.attemptId);
  const dIntent = await intentOf(d1.orderId);
  check('E7 a refund the provider later FAILS: attempt failed, intent -> needs_review with an admin alert (no automatic second refund)', d2 === 'needs_review' && dAfter.status === 'failed' && dIntent.status === 'needs_review' && refundCalls().length === 1 && (await count(`select count(*)::int n from notification_outbox where dedupe_key = $1`, [`refund:${d1.attemptId}:failed`])) === 1);

  resetAll();
  const e1 = await queuedRefund(pid('refundfailed'));
  const e2 = await processRefundAttempt(e1.attemptId);
  check('E8 a refund the provider reports as failed immediately goes to review, never to "processed"', e2 === 'needs_review' && (await attemptOf(e1.attemptId)).status === 'failed' && (await intentOf(e1.orderId)).status === 'needs_review');

  // E9 provider API down: nothing submitted, stays queued; after 48h goes to a human
  resetAll();
  const f1 = await queuedRefund(pid('apidown'));
  const f2 = await processRefundAttempt(f1.attemptId);
  const fRow = await attemptOf(f1.attemptId);
  check('E9 provider unreachable before submission: attempt stays queued with a retry time, no submission counted, error kind recorded', f2 === 'unknown' && fRow.status === 'queued' && fRow.attempts === 0 && !!fRow.last_error_kind && refundCalls().length === 0 && new Date(fRow.next_attempt_at).getTime() > Date.now());
  await backdate('payment_refund_attempts', 'trg_payment_refund_attempts_guard', `created_at = now() - interval '49 hours', next_attempt_at = now() - interval '1 second'`, 'id = $1', [f1.attemptId]);
  const f3 = await processRefundAttempt(f1.attemptId);
  check('E10 provider state still unobtainable after 48h: attempt + intent -> needs_review and the owner is alerted', f3 === 'needs_review' && (await attemptOf(f1.attemptId)).status === 'needs_review' && (await intentOf(f1.orderId)).status === 'needs_review' && (await count(`select count(*)::int n from notification_outbox where dedupe_key = $1`, [`refund:${f1.attemptId}:review`])) === 1);

  // E11 payment already refunded elsewhere -> never over-refund
  resetAll();
  const g1 = await queuedRefund(pid('manual'));
  await mock.mockRazorpay.payments.refundIdempotent(g1.intent.razorpay_payment_id ?? (await attemptOf(g1.attemptId)).razorpay_payment_id, { amount: Number(g1.intent.amount_paise) }, 'dashboard-refund-0001');
  mock.calls.length = 0;
  const g2 = await processRefundAttempt(g1.attemptId);
  check('E11 the payment was already refunded outside the system: nothing is sent (no over-refund), attempt -> needs_review', g2 === 'needs_review' && refundCalls().length === 0 && mock.mockState().refunds.length === 1 && (await attemptOf(g1.attemptId)).status === 'needs_review');

  // E12 two workers at the same moment
  resetAll();
  const h1 = await queuedRefund(pid('slow'));
  const both = await Promise.all([processRefundAttempt(h1.attemptId), processRefundAttempt(h1.attemptId), processRefundAttempt(h1.attemptId)]);
  check('E12 three workers on one attempt at once: exactly one does the work, one provider call, one refund', both.filter((x) => x === 'not_claimed').length === 2 && refundCalls().length === 1 && mock.mockState().refunds.length === 1 && (await attemptOf(h1.attemptId)).status === 'processed');

  // E13/E14 worker crash: status submitting with an expired lease
  resetAll();
  const i1 = await queuedRefund(pid('crashA'));
  await q(`UPDATE payment_refund_attempts SET status = 'submitting', attempts = 1, lease_until = now() - interval '1 minute', last_attempt_at = now() WHERE id = $1`, [i1.attemptId]);
  const i2 = await processRefundAttempt(i1.attemptId);
  check('E13 worker died after committing "submitting" but BEFORE calling the provider: lease expiry -> reconcile finds nothing -> same request sent -> one refund', i2 === 'processed' && mock.mockState().refunds.length === 1 && (await attemptOf(i1.attemptId)).attempts === 2);
  resetAll();
  const j1 = await queuedRefund(pid('crashB'));
  const jRow = await attemptOf(j1.attemptId);
  await mock.mockRazorpay.payments.refundIdempotent(jRow.razorpay_payment_id, { amount: Number(jRow.amount_paise), receipt: jRow.receipt, notes: { attempt_id: jRow.id, reason: 'stock_unavailable' } }, jRow.idempotency_key);
  mock.calls.length = 0;
  await q(`UPDATE payment_refund_attempts SET status = 'submitting', attempts = 1, lease_until = now() - interval '1 minute' WHERE id = $1`, [j1.attemptId]);
  const j2 = await processRefundAttempt(j1.attemptId);
  check('E14 worker died AFTER the provider refunded: lease expiry -> reconcile ADOPTS the refund, no second request', j2 === 'processed' && refundCalls().length === 0 && mock.mockState().refunds.length === 1);

  // E15 unexpected provider rejection -> review
  resetAll();
  const k = await queuedRefund(pid('rejectme'));
  const p = mock.mockState().payments.find((x) => x.order_id === k.orderId);
  (p as any).captured = false; (p as any).status = 'authorized';
  const k2 = await processRefundAttempt(k.attemptId);
  check('E15 a payment that is not captured at the provider is never refunded: needs_review', k2 === 'needs_review' && refundCalls().length === 0);

  // the DB cap
  const over = await withTx(async (c) => queueRefundAttempt(c, { id: k.intent.id, razorpay_payment_id: (await attemptOf(k.attemptId)).razorpay_payment_id, amount_paise: 1, currency: 'INR' })).then(() => 'accepted', () => 'refused');
  check('E16 the database refuses a second live refund / any refund beyond the captured amount for the same intent', over === 'refused');
}

// =====================================================================================================================
section('F. Coupon exhausted after capture');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  await q(`INSERT INTO coupons (code, discount_type, discount_value, usage_limit, per_user_limit) VALUES ('P2ONCE','fixed',100,1,5)`);
  const a = await paidCheckout({ coupon: 'P2ONCE', cust: buyer('ca'), payId: pid('ca') });
  const b = await paidCheckout({ coupon: 'P2ONCE', cust: buyer('cb'), payId: pid('cb') });
  check('F1 both checkouts were priced with the coupon while it was still available', a.co.status === 200 && b.co.status === 200 && a.co.json.amount === 90000 && b.co.json.amount === 90000, `${a.co.status}/${b.co.status} ${a.co.json?.amount}`);
  const va = await verify(a.orderId, a.payId);
  const vb = await verify(b.orderId, b.payId);
  await sleep(300);
  const ob = await one('select * from orders where razorpay_payment_id = $1', [b.payId]);
  const coupon = await one(`select used_count from coupons where code = 'P2ONCE'`);
  check('F2 the second buyer\'s order is honoured at the PAID price (900), no refund, coupon usage still recorded', va.status === 200 && vb.status === 200 && Number(ob.total_amount) === 900 && Number(ob.coupon_discount) === 100 && coupon.used_count === 2 && (await count('select count(*)::int n from payment_refund_attempts a join payment_intents i on i.id = a.intent_id where i.razorpay_order_id in ($1,$2)', [a.orderId, b.orderId])) === 0, `${va.status} ${vb.status} ${ob?.total_amount} ${ob?.coupon_discount} ${coupon.used_count} ${JSON.stringify(vb.json).slice(0,150)}`);
  check('F3 the over-limit use is surfaced to the owner as a recorded operational alert', (await count(`select count(*)::int n from notification_outbox where order_id = $1 and kind = 'admin_alert'`, [ob.id])) === 1);
}

// =====================================================================================================================
section('G. Notification outbox');
// =====================================================================================================================
{
  resetAll(); await sink.reset();
  const probe = await paidCheckout({ cust: buyer('ob'), payId: pid('ob') });
  const intent = await intentOf(probe.orderId);
  const k = `test:${uniq()}`;
  const first = await enqueueNotification(pool as any, { kind: 'admin_alert', dedupeKey: k, recipient: 'admin', intentId: intent.id, payload: { subject: 'x', reason: 'r' } });
  const second = await enqueueNotification(pool as any, { kind: 'admin_alert', dedupeKey: k, recipient: 'admin', intentId: intent.id, payload: { subject: 'x', reason: 'r' } });
  check('G1 the same dedupe key is never queued twice', first === true && second === false && (await count('select count(*)::int n from notification_outbox where dedupe_key = $1', [k])) === 1);
  const payloadsDump = JSON.stringify(await q('select payload from notification_outbox'));
  check('G2 outbox payloads hold reason codes only: no e-mail addresses, phone numbers or tokens', !/@example\.com/.test(payloadsDump.replace(/owner@example\.com/g, '')) && !/9876543210/.test(payloadsDump));

  await sink.fail(true);
  const f = await flushOutbox();
  const row = await one('select * from notification_outbox where dedupe_key = $1', [k]);
  check('G3 SMTP down: the row stays queued with attempts counted, a future retry time and a safe error', f.sent === 0 && row.status === 'queued' && row.attempts === 1 && new Date(row.next_attempt_at).getTime() > Date.now() && !!row.last_error);
  const notYet = await flushOutbox();
  check('G4 backoff is honoured: nothing is retried before next_attempt_at', notYet.sent === 0 && notYet.failed === 0 && (await one('select attempts from notification_outbox where dedupe_key = $1', [k])).attempts === 1);
  await sink.fail(false);
  await q(`UPDATE notification_outbox SET next_attempt_at = now() WHERE dedupe_key = $1`, [k]);
  const g = await flushOutbox();
  check('G5 when SMTP recovers the queued message is sent exactly once', g.sent >= 1 && (await one('select status from notification_outbox where dedupe_key = $1', [k])).status === 'sent');
  await flushOutbox();
  await sink.fail(true);
  const k2 = `test:${uniq()}`;
  await enqueueNotification(pool as any, { kind: 'admin_alert', dedupeKey: k2, recipient: 'admin', intentId: intent.id, payload: { subject: 'y', reason: 'r' } });
  for (let i = 0; i < 9; i++) { await q(`UPDATE notification_outbox SET next_attempt_at = now() WHERE dedupe_key = $1 AND status = 'queued'`, [k2]); await flushOutbox(); }
  const exhausted = await one('select status, attempts from notification_outbox where dedupe_key = $1', [k2]);
  await sink.fail(false);
  check('G6 attempts are bounded: after 8 failures the row is marked failed (and stops being retried)', exhausted.status === 'failed' && exhausted.attempts === 8, JSON.stringify(exhausted));
  const k3 = `test:${uniq()}`;
  await enqueueNotification(pool as any, { kind: 'admin_alert', dedupeKey: k3, recipient: 'admin', intentId: intent.id, payload: { subject: 'z', reason: 'r' } });
  await q(`UPDATE notification_outbox SET status = 'sending', lease_until = now() - interval '1 minute' WHERE dedupe_key = $1`, [k3]);
  await flushOutbox();
  check('G7 a row left "sending" by a crashed worker (expired lease) is picked up and sent', (await one('select status from notification_outbox where dedupe_key = $1', [k3])).status === 'sent');
  const k4 = `test:${uniq()}`;
  await enqueueNotification(pool as any, { kind: 'admin_alert', dedupeKey: k4, recipient: 'admin', intentId: intent.id, payload: { subject: 'w', reason: 'r' } });
  await q(`UPDATE notification_outbox SET status = 'sending', lease_until = now() + interval '5 minutes' WHERE dedupe_key = $1`, [k4]);
  await flushOutbox();
  check('G8 a row another worker holds under a live lease is left alone', (await one('select status from notification_outbox where dedupe_key = $1', [k4])).status === 'sending');
}

// =====================================================================================================================
section('H. Customer status lookup');
// =====================================================================================================================
{
  resetAll();
  const w = await paidCheckout({ cust: buyer('st'), payId: pid('st') });
  const token = w.co.json.status_token;
  const s1 = await api('POST', '/api/payment/status', { razorpay_order_id: w.orderId, token });
  check('H1 before payment is processed: awaiting_payment, a safe message, no personal data', s1.status === 200 && s1.json.state === 'awaiting_payment' && !/@|P2 Buyer|98765/.test(s1.text));
  await verify(w.orderId, w.payId);
  const s2 = await api('POST', '/api/payment/status', { razorpay_order_id: w.orderId, token });
  const ord = await one('select id, custom_order_id from orders where razorpay_payment_id = $1', [w.payId]);
  check('H2 after fulfilment: confirmed with the order id and number; still no personal data', s2.json.state === 'confirmed' && s2.json.order_id === ord.id && s2.json.order_number === ord.custom_order_id && !/@|P2 Buyer|98765/.test(s2.text));
  const wrong = await api('POST', '/api/payment/status', { razorpay_order_id: w.orderId, token: 'A'.repeat(43) });
  const nonexist = await api('POST', '/api/payment/status', { razorpay_order_id: 'order_nonexistent_9', token });
  const noToken = await api('POST', '/api/payment/status', { razorpay_order_id: w.orderId });
  check('H3 wrong token, unknown order and missing token all give the SAME 404 body (no enumeration)', wrong.status === 404 && nonexist.status === 404 && noToken.status === 404 && wrong.text === nonexist.text && wrong.text === noToken.text);
  const hdr = await api('POST', '/api/payment/status', { razorpay_order_id: w.orderId, token: 'x'.repeat(5000) });
  check('H4 absurd inputs are rejected the same way', hdr.status === 404);

  const rf = await queuedRefund(pid('st_refund'));
  const rs = await api('POST', '/api/payment/status', { razorpay_order_id: rf.orderId, token: rf.co.json.status_token });
  check('H5 a checkout waiting for its refund reports refund_pending', rs.json.state === 'refund_pending');
  await processRefundAttempt(rf.attemptId);
  const rs2 = await api('POST', '/api/payment/status', { razorpay_order_id: rf.orderId, token: rf.co.json.status_token });
  check('H6 ...and refunded once the provider confirmed', rs2.json.state === 'refunded');
  const rv = await api('GET', '/api/payment/review');
  const rv2 = await api('GET', '/api/payment/review', undefined, ADMIN);
  check('H7 the admin review list needs an admin token and exposes ids/amounts/reasons only', rv.status === 401 && rv2.status === 200 && Array.isArray(rv2.json.intents) && !/@example\.com|P2 Buyer/.test(rv2.text));
}

// =====================================================================================================================
section('I. Historical COD orders and admin refunds stay compatible');
// =====================================================================================================================
{
  resetAll();
  const hist = (await q(`INSERT INTO orders (custom_order_id, items, subtotal, shipping_charge, cod_charge, total_amount, customer_name, customer_email, customer_phone, payment_method, status)
    VALUES ('VEDIQRA#HIST${uniq()}', '[{"name":"old"}]'::jsonb, 2000, 0, 49, 2049, 'Old Buyer', 'old@example.com', '9876543210', 'cod', 'delivered') RETURNING id`))[0].id;
  const snap = async () => JSON.stringify((await one('select * from orders where id = $1', [hist])));
  const before = await snap();
  const w = await paidCheckout({ cust: buyer('hi'), payId: pid('hi') });
  await verify(w.orderId, w.payId);
  const stockFail = await queuedRefund(pid('hi2'));
  await processRefundAttempt(stockFail.attemptId);
  await runRecoveryOnce();
  check('I1 a historical COD order is byte-for-byte unchanged by the whole payment-recovery machinery', (await snap()) === before);
  const order = await one('select * from orders where razorpay_payment_id = $1', [w.payId]);
  const refund = await api('POST', `/api/payment/refund/${w.payId}`, { amount: 400, notes: 'partial' }, ADMIN);
  const after = await one('select status, refunded_amount from orders where id = $1', [order.id]);
  check('I2 the existing admin refund flow still works on an order created by the new fulfilment path (partial refund recorded)', refund.status === 200 && after.status === 'partially_refunded' && Number(after.refunded_amount) === 400, JSON.stringify(refund.json).slice(0, 160));
  const missing = await api('POST', `/api/payment/refund/${(await attemptOf(stockFail.attemptId)).razorpay_payment_id}`, {}, ADMIN);
  check('I3 the admin refund endpoint cannot refund a payment that has no order (those are handled only by the durable workflow)', missing.status === 404);
}

// =====================================================================================================================
section('J. Legacy browser-verification fallback (time-boxed, off by default)');
// =====================================================================================================================
{
  resetAll();
  const legacyOrder = async (amount: number) => { const o = await mock.mockRazorpay.orders.create({ amount, currency: 'INR', receipt: `receipt_${uniq()}` }); return o.id as string; };
  const oldOrder = await legacyOrder(100000);
  capture(oldOrder, 'pay_legacy_1', 100000);
  const od = { items: [line(TEE.id)], ...buyer('lg') };
  const r0 = await verify(oldOrder, 'pay_legacy_1', { order_data: od });
  check('J1 default: no INTENTS_ENABLED_AT / LEGACY_VERIFY_UNTIL -> an unknown order is refused (409) and no order is created', r0.status === 409 && (await ordersFor('pay_legacy_1')) === 0);

  await sleep(1100);                                                              // Razorpay timestamps are whole seconds
  const now = Date.now();
  (config as any).intentsEnabledAt = new Date(now); (config as any).legacyVerifyUntil = new Date(now + 3600_000);
  const r1 = await verify(oldOrder, 'pay_legacy_1', { order_data: od });
  const li = await one(`select origin, status from payment_intents where razorpay_order_id = $1`, [oldOrder]);
  check('J2 inside the window, for an order created BEFORE activation: the cart is re-priced on the server and the order is created via the shared service', r1.status === 200 && (await ordersFor('pay_legacy_1')) === 1 && li.origin === 'legacy' && li.status === 'fulfilled');
  const bad = await legacyOrder(100000);
  capture(bad, 'pay_legacy_2', 100000);
  const r2 = await verify(bad, 'pay_legacy_2', { order_data: { ...od, items: [line(TEE.id, 3)] } });
  check('J3 a cart that does not equal the amount actually captured is refused (409), nothing created', r2.status === 409 && (await ordersFor('pay_legacy_2')) === 0);
  await sleep(1100);
  const fresh = await legacyOrder(100000);                                       // created AFTER activation
  capture(fresh, 'pay_legacy_3', 100000);
  const r3 = await verify(fresh, 'pay_legacy_3', { order_data: od });
  check('J4 a Razorpay order created after activation (it should have an intent) is refused', r3.status === 409 && (await ordersFor('pay_legacy_3')) === 0);
  (config as any).legacyVerifyUntil = new Date(Date.now() - 1000);
  const closed = await legacyOrder(100000);
  capture(closed, 'pay_legacy_4', 100000);
  const r4 = await verify(closed, 'pay_legacy_4', { order_data: od });
  check('J5 after the window closes the fallback refuses again', r4.status === 409);
  (config as any).intentsEnabledAt = null; (config as any).legacyVerifyUntil = null;
  const legacyLogs = logs.filter((l) => l.includes('legacy_')).join('\n');
  check('J6 legacy adoption is logged without personal data', legacyLogs.length > 0 && !/@example\.com|9876543210/.test(legacyLogs));
}

// =====================================================================================================================
section('K. Workers: lifecycle, locking, disabled by default');
// =====================================================================================================================
{
  resetAll();
  check('K1 disabled by default: startPaymentRecovery() starts nothing', config.paymentRecoveryEnabled === false && startPaymentRecovery() === null);

  const lockHolder = await pool.connect();
  await lockHolder.query('SELECT pg_advisory_lock(874120551)');
  const blocked = await runRecoveryTick();
  await lockHolder.query('SELECT pg_advisory_unlock(874120551)'); lockHolder.release();
  const free = await runRecoveryTick();
  check('K2 only one process runs the job at a time (advisory lock): a tick while another holds the lock does nothing', blocked === null && free !== null);

  const stuck = await paidCheckout({ cust: buyer('k3'), payId: pid('k3') });
  await q(`UPDATE payment_intents SET next_check_at = now() WHERE razorpay_order_id = $1`, [stuck.orderId]);
  (config as any).paymentRecoveryEnabled = true; (config as any).paymentRecoveryIntervalMs = 15000;
  const handle = startPaymentRecovery({ firstDelayMs: 100 });
  await sleep(2500);
  const fulfilled = (await ordersFor(stuck.payId)) === 1;
  await handle!.stop();
  (config as any).paymentRecoveryEnabled = false;
  const callsAtStop = mock.calls.length;
  await sleep(1200);
  check('K3 enabled: the timer picks up a stuck captured payment on its own; stop() resolves and nothing runs afterwards', fulfilled && mock.calls.length === callsAtStop);

  // stale preparing intents
  resetAll();
  mock.orderFaults.create = 'lostresp';
  const key = newKey();
  await checkout({ key });
  const pi = await one('select * from payment_intents where idempotency_key = $1', [key]);
  await backdate('payment_intents', 'trg_payment_intents_guard', `created_at = now() - interval '5 minutes', next_check_at = NULL`, 'id = $1', [pi.id]);
  await runRecoveryOnce();
  const attached = await one('select * from payment_intents where id = $1', [pi.id]);
  check('K4 a stale preparing intent whose provider order exists (answer was lost) is attached by the worker, never duplicated', attached.status === 'created' && !!attached.razorpay_order_id && mock.mockState().orders.length === 1);

  const key2 = newKey();
  mock.orderFaults.create = 'down';
  await checkout({ key: key2 });
  mock.orderFaults.create = null;
  const pi2 = await one('select * from payment_intents where idempotency_key = $1', [key2]);
  await backdate('payment_intents', 'trg_payment_intents_guard', `created_at = now() - interval '2 hours', next_check_at = NULL`, 'id = $1', [pi2.id]);
  await runRecoveryOnce();
  check('K5 a stale preparing intent with no provider order is abandoned (never creates an order by itself)', (await one('select status from payment_intents where id = $1', [pi2.id])).status === 'abandoned' && mock.mockState().orders.length === 1);
  const late = await resolveLate(pi2.id);
  check('K6 a late payment on an abandoned intent is still honoured (found through the order receipt)', late);

  async function resolveLate(intentId: string): Promise<boolean> {
    const receipt = `vq_${intentId.replace(/-/g, '')}`;
    const o = await mock.mockRazorpay.orders.create({ amount: 100000, currency: 'INR', receipt });
    capture(o.id, pid('late'), 100000);
    const p = mock.mockState().payments.slice(-1)[0];
    const res = await webhook(webhookBody('payment.captured', { orderId: o.id, payId: p.id, amount: 100000 }));
    const i = await one('select status, razorpay_order_id from payment_intents where id = $1', [intentId]);
    return res.status === 200 && i.status === 'fulfilled' && i.razorpay_order_id === o.id;
  }

  // abandonment of a never-paid created intent
  const idle = await checkout({});
  await backdate('payment_intents', 'trg_payment_intents_guard', `created_at = now() - interval '25 hours', next_check_at = now() - interval '1 second'`, 'razorpay_order_id = $1', [idle.json.id]);
  await runRecoveryOnce();
  check('K7 a created intent nobody paid for is abandoned after 24h (and can still be revived by a late payment)', (await intentOf(idle.json.id)).status === 'abandoned');
  const idlePay = pid('revive');
  capture(idle.json.id, idlePay, idle.json.amount);
  await webhook(webhookBody('payment.captured', { orderId: idle.json.id, payId: idlePay, amount: idle.json.amount }));
  check('K8 ...a payment arriving after abandonment fulfils it', (await intentOf(idle.json.id)).status === 'fulfilled' && (await ordersFor(idlePay)) === 1);

  // provider outage in the worker: backoff, nothing lost
  const out2 = await paidCheckout({ payId: pid('k9') });
  await q(`UPDATE payment_intents SET next_check_at = now() WHERE razorpay_order_id = $1`, [out2.orderId]);
  mock.orderFaults.fetchPayments = 'down';
  const sumDown = await runRecoveryOnce();
  const afterDown = await intentOf(out2.orderId);
  mock.orderFaults.fetchPayments = null;
  check('K9 provider outage inside the worker: the error is recorded, a backoff is set, nothing is lost or fulfilled wrongly', sumDown.errors >= 1 && afterDown.check_failures >= 1 && new Date(afterDown.next_check_at).getTime() > Date.now() && afterDown.status === 'created');
  await q(`UPDATE payment_intents SET next_check_at = now() WHERE razorpay_order_id = $1`, [out2.orderId]);
  await runRecoveryOnce();
  check('K10 ...and it is completed on the next pass once the provider is back', (await ordersFor(out2.payId)) === 1);

  // no deletion of financial records
  const before = await count('select (select count(*) from payment_intents) + (select count(*) from payment_refund_attempts) + (select count(*) from payment_webhook_events) as n');
  await runRecoveryOnce();
  check('K11 the worker never deletes intents, refund attempts or webhook events', (await count('select (select count(*) from payment_intents) + (select count(*) from payment_refund_attempts) + (select count(*) from payment_webhook_events) as n')) >= before);
}

// =====================================================================================================================
section('L. Startup validation, logging safety, rate limits, invariants');
// =====================================================================================================================
{
  const cfgFile = path.join(os.tmpdir(), `p2-config-check-${uniq()}.cjs`);
  fs.writeFileSync(cfgFile, `try { require(${JSON.stringify(path.join(BACKEND, 'src', 'config'))}).assertSecureConfig(); console.log('CONFIG_OK'); } catch (e) { console.log('CONFIG_ERR ' + e.message); }`);
  const cfg = (env: Record<string, string>) => {
    const clean = { ...ENVP } as Record<string, string | undefined>;
    for (const k of ['PAYMENT_RECOVERY_ENABLED', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_PREVIOUS', 'INTENTS_ENABLED_AT', 'LEGACY_VERIFY_UNTIL']) delete clean[k];
    const r = spawnSync(process.execPath, ['--import', 'tsx', cfgFile], { cwd: BACKEND, env: { ...clean, JWT_SECRET: 'x'.repeat(40), DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd', NODE_ENV: 'development', ...env }, encoding: 'utf8' });
    return (r.stdout || '') + (r.stderr || '');
  };
  check('L1 start-up refuses PAYMENT_RECOVERY_ENABLED=true without Razorpay keys', /CONFIG_ERR .*RAZORPAY_KEY_ID/.test(cfg({ PAYMENT_RECOVERY_ENABLED: 'true' })));
  check('L2 start-up accepts recovery enabled WITH keys', /CONFIG_OK/.test(cfg({ PAYMENT_RECOVERY_ENABLED: 'true', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's' })));
  check('L3 start-up refuses a previous webhook secret without a current one, and a too-short secret', /CONFIG_ERR .*PREVIOUS/.test(cfg({ RAZORPAY_WEBHOOK_SECRET_PREVIOUS: 'abcdefghij' })) && /CONFIG_ERR .*too short/.test(cfg({ RAZORPAY_WEBHOOK_SECRET: 'abc' })));
  check('L4 default configuration (nothing set) starts fine with the worker off', /CONFIG_OK/.test(cfg({})));

  const all = logs.join('\n');
  const secretsFound = [KEY_SECRET, WH_CURRENT, WH_PREVIOUS, 'leak.person', '9812345678', 'okbank', ADMIN_PW].filter((s) => all.includes(s));
  const tokens = (await q('select id from payment_intents')).map((r: any) => statusTokenFor(r.id));
  const tokenLeak = tokens.some((t: string) => all.includes(t));
  const buyerEmails = (await q('select customer->>\'email\' as e from payment_intents')).map((r: any) => r.e).filter(Boolean);
  const emailLeak = buyerEmails.filter((e: string) => all.includes(e));
  check('L5 the application\'s own log output contains no secrets, signatures, status tokens, webhook PII or buyer e-mail addresses', secretsFound.length === 0 && !tokenLeak && emailLeak.length === 0, `${secretsFound.join(',')} ${emailLeak.slice(0, 2).join(',')} (${logs.length} log lines)`);
  const events = logs.filter((l) => l.includes('"evt":"payment.'));
  check('L6 structured payment log lines are valid single-line JSON with an event name', events.length > 20 && events.every((l) => { try { return !!JSON.parse(l).evt; } catch { return false; } }), `${events.length}`);

  let limited = 0;
  for (let i = 0; i < 80 && !limited; i++) limited = (await api('POST', '/api/payment/status', { razorpay_order_id: 'order_x', token: 'y'.repeat(30) })).status === 429 ? i + 1 : 0;
  check('L7 the status endpoint is rate limited (429 within the configured ceiling)', limited > 0 && limited <= 41, `${limited}`);

  const inv = {
    dupPay: await count('select count(*)::int n from (select razorpay_payment_id from orders where razorpay_payment_id is not null group by 1 having count(*) > 1) x'),
    fulfilledNoOrder: await count(`select count(*)::int n from payment_intents where status = 'fulfilled' and order_id is null`),
    refundedWithoutProcessed: await count(`select count(*)::int n from payment_intents i where status = 'refunded' and not exists (select 1 from payment_refund_attempts a where a.intent_id = i.id and a.status = 'processed')`),
    overRefund: await count(`select count(*)::int n from (select intent_id, sum(amount_paise) s from payment_refund_attempts where status <> 'failed' group by 1) a join payment_intents i on i.id = a.intent_id where a.s > i.amount_paise`),
    paidTwiceBothWays: await count(`select count(*)::int n from payment_intents i where order_id is not null and exists (select 1 from payment_refund_attempts a where a.intent_id = i.id)`),
  };
  check('L8 final invariants over the whole run: no duplicate payment orders, no fulfilled-without-order, no refunded-without-processed-refund, no over-refund, no intent both fulfilled and refunded', Object.values(inv).every((v) => v === 0), JSON.stringify(inv));
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
