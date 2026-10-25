// TEST ONLY - Pre-test-mode safety patch (admin refunds through the durable workflow, webhook abuse protection): intents + idempotent checkout, shared fulfilment, webhooks, durable refunds,
// recovery workers, outbox, customer status. Runs the REAL app and services in this process against the deterministic
// Razorpay fake (test/mockRazorpay.ts) and a THROWAWAY database it builds and drops itself (vediqra_test_p4).
// It never contacts Razorpay, never touches the real database.
//   npx tsx test/safety-patch-test.mts
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = 'vediqra_test_p4';
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
  RATE_LIMIT_PAYMENTS: '5000', RATE_LIMIT_ORDERS: '5000', RATE_LIMIT_REFUNDS: '5000', RATE_LIMIT_STATUS: '40', RATE_LIMIT_WEBHOOK: '12', WEBHOOK_MAX_CONCURRENT: '3',
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
const { processAdminRefund } = await import('../src/services/refunds');
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

// model the real client: a refund call that carries an idempotency key goes through the provider's idempotent endpoint
setRazorpayClient({
  orders: mock.mockRazorpay.orders,
  payments: {
    ...mock.mockRazorpay.payments,
    refund: (paymentId: string, params: any, key?: string) => key
      ? mock.mockRazorpay.payments.refundIdempotent(paymentId, { amount: params.amount, receipt: params.receipt, notes: params.notes }, key)
      : mock.mockRazorpay.payments.refund(paymentId, params),
  },
} as any);
const refund = (payId: string, body: Record<string, unknown> = {}) => api('POST', `/api/payment/refund/${payId}`, body, ADMIN);
const orderOf = (payId: string) => one('select id, status, refunded_amount, refunds, stock_restored_at from orders where razorpay_payment_id = $1', [payId]);
const reqOf = (payId: string) => q('select * from admin_refund_requests where razorpay_payment_id = $1 order by created_at', [payId]);
/** a paid, fulfilled order (1000) whose payment id carries a provider behaviour keyword */
/** a request a worker had moved to "submitting" and then died, so its lease has expired */
async function crashRow(payId: string, reqId: string, key: string, receipt: string) {
  const rows = await q(`INSERT INTO admin_refund_requests (order_id, razorpay_payment_id, request_id, amount_paise, idempotency_key, receipt)
    VALUES ((SELECT id FROM orders WHERE razorpay_payment_id = $1), $1, $2, 100000, $3, $4) RETURNING id`, [payId, reqId, key, receipt]);
  await q(`UPDATE admin_refund_requests SET status = 'submitting', attempts = 1, lease_until = now() - interval '1 minute' WHERE id = $1`, [rows[0].id]);
  return rows;
}
async function paidOrder(tag: string, items: unknown[] = [line(TEE.id)]) {
  const w = await paidCheckout({ cust: buyer(tag), payId: pid(tag), items });
  await verify(w.orderId, w.payId);
  return w;
}

// =====================================================================================================================
section('R. Admin refunds through the durable workflow');
// =====================================================================================================================
{
  resetAll();
  // ---- processed, partial, full, stock
  const stock0 = await stockOf(TEE.id);
  const a = await paidOrder('r1');
  const r1 = await refund(a.payId, { amount: 400, request_id: 'r1-a' });
  const o1 = await orderOf(a.payId);
  const row1 = (await reqOf(a.payId))[0];
  check('R1 processed partial refund: 200, order partially_refunded, refunded_amount 400, request row processed with the provider refund id', r1.status === 200 && r1.json.refund_status === 'processed' && o1.status === 'partially_refunded' && Number(o1.refunded_amount) === 400 && row1.status === 'processed' && /^rfnd_/.test(row1.provider_refund_id) && o1.refunds[0].status === 'processed');
  check('R1 ...stock is NOT restored by a partial refund', o1.stock_restored_at === null && (await stockOf(TEE.id)) === stock0 - 1);
  const dup = await refund(a.payId, { amount: 400, request_id: 'r1-a' });
  check('R1 the same request_id again returns the recorded refund (duplicate), no second provider call, nothing counted twice', dup.status === 200 && dup.json.duplicate === true && Number(dup.json.refunded_amount) === 400 && refundCalls().length === 1);
  const tooMuch = await refund(a.payId, { amount: 700 });
  check('R7 a partial refund beyond what is left (600) is refused (400) before any provider call', tooMuch.status === 400 && /600/.test(tooMuch.json.error) && refundCalls().length === 1);
  const full = await refund(a.payId, {});
  const o1b = await orderOf(a.payId);
  check('R1 refunding the rest completes the refund: order refunded, refunded_amount = total, stock restored exactly once, ledger of 2 processed entries', full.status === 200 && o1b.status === 'refunded' && Number(o1b.refunded_amount) === 1000 && o1b.stock_restored_at !== null && (await stockOf(TEE.id)) === stock0 && o1b.refunds.length === 2 && full.json.stock_restored === true);
  const again = await refund(a.payId, {});
  check('R1 refunding a fully refunded order -> 409, provider not asked', again.status === 409 && refundCalls().length === 2);

  // ---- pending: reported accurately, not counted, reconciled later
  const p = await paidOrder('refundpending_r2');
  const pr = await refund(p.payId, { amount: 1000, request_id: 'r2-a' });
  const po = await orderOf(p.payId);
  check('R2 a refund Razorpay reports as PENDING: HTTP 202 "pending"; the order is NOT marked refunded (still paid, refunded_amount 0); the ledger shows it as pending', pr.status === 202 && pr.json.pending === true && pr.json.refund_status === 'pending' && po.status === 'paid' && Number(po.refunded_amount) === 0 && po.refunds[0].status === 'pending' && po.stock_restored_at === null);
  const blocked = await refund(p.payId, { amount: 100 });
  check('R2 while it is pending a different refund is held back (409) so nothing can add up beyond the total', blocked.status === 409 && refundCalls().length === 3);
  const pend = (await reqOf(p.payId))[0];
  mock.advanceRefund(pend.provider_refund_id, 'processed');
  await q(`UPDATE admin_refund_requests SET next_attempt_at = now() - interval '1 second', lease_until = NULL WHERE id = $1`, [pend.id]);
  await runRecoveryOnce();
  const po2 = await orderOf(p.payId);
  check('R2 once Razorpay settles it, the worker records processed: order refunded, amount counted once, stock restored, ledger entry updated in place', po2.status === 'refunded' && Number(po2.refunded_amount) === 1000 && po2.refunds.length === 1 && po2.refunds[0].status === 'processed' && po2.stock_restored_at !== null && (await reqOf(p.payId))[0].status === 'processed' && refundCalls().length === 3);

  // pending that later FAILS
  const pf = await paidOrder('refundpending_r2f');
  await refund(pf.payId, { amount: 300, request_id: 'r2f' });
  const pfr = (await reqOf(pf.payId))[0];
  mock.advanceRefund(pfr.provider_refund_id, 'failed');
  await q(`UPDATE admin_refund_requests SET next_attempt_at = now() - interval '1 second', lease_until = NULL WHERE id = $1`, [pfr.id]);
  await runRecoveryOnce();
  const pfo = await orderOf(pf.payId);
  check('R2 a pending refund that Razorpay later FAILS: request failed, ledger entry failed, the order is untouched (paid, 0 refunded) and a new refund may be requested', (await reqOf(pf.payId))[0].status === 'failed' && pfo.status === 'paid' && Number(pfo.refunded_amount) === 0 && pfo.refunds[0].status === 'failed');

  // ---- definitive failure
  const f = await paidOrder('refundfailed_r3');
  const fr = await refund(f.payId, { amount: 200 });
  const fo = await orderOf(f.payId);
  check('R3 a refund Razorpay reports as failed: 502, nothing counted, order untouched, no ledger entry', fr.status === 502 && fr.json.success === false && fo.status === 'paid' && Number(fo.refunded_amount) === 0 && fo.refunds.length === 0 && (await reqOf(f.payId))[0].status === 'failed');
  const fr2 = await refund(f.payId, { amount: 200 });
  check('R3 after a DEFINITIVE failure a new refund request is allowed (new request, new key)', fr2.status === 502 && (await reqOf(f.payId)).length === 2 && new Set((await reqOf(f.payId)).map((r: any) => r.idempotency_key)).size === 2);

  // ---- timeout after the provider accepted
  const l = await paidOrder('lostresp_r4');
  const callsBefore = refundCalls().length;
  const l1 = await refund(l.payId, { amount: 1000, request_id: 'r4' });
  const lo = await orderOf(l.payId);
  check('R4 timeout AFTER the provider accepted: 502 "unknown"; nothing is recorded on the order; the provider did refund', l1.status === 502 && l1.json.refund_status === 'unknown' && lo.status === 'paid' && Number(lo.refunded_amount) === 0 && lo.refunds.length === 0 && mock.mockState().refunds.filter((x) => x.payment_id === l.payId).length === 1 && (await reqOf(l.payId))[0].status === 'unknown');
  const other = await refund(l.payId, { amount: 100 });
  check('R4 a DIFFERENT refund on that order is held back while the outcome is unknown (409)', other.status === 409);
  await q(`UPDATE admin_refund_requests SET next_attempt_at = now() - interval '1 second', lease_until = NULL WHERE razorpay_payment_id = $1`, [l.payId]);
  const l2 = await refund(l.payId, { amount: 1000, request_id: 'r4' });
  const lo2 = await orderOf(l.payId);
  check('R4 the retry (same request_id) reconciles: adopts the refund found at the provider, sends NOTHING again, and only now records it - exactly one refund exists', l2.status === 200 && lo2.status === 'refunded' && Number(lo2.refunded_amount) === 1000 && refundCalls().length === callsBefore + 1 && mock.mockState().refunds.filter((x) => x.payment_id === l.payId).length === 1);

  // ---- retry without request_id resumes the same refund
  const l3 = await paidOrder('lostresp_r4b');
  await refund(l3.payId, { amount: 250 });
  await q(`UPDATE admin_refund_requests SET next_attempt_at = now() - interval '1 second', lease_until = NULL WHERE razorpay_payment_id = $1`, [l3.payId]);
  const l3b = await refund(l3.payId, { amount: 250 });
  check('R4 a plain retry (no request_id, same amount) resumes the SAME request rather than creating a second one', l3b.status === 200 && (await reqOf(l3.payId)).length === 1 && mock.mockState().refunds.filter((x) => x.payment_id === l3.payId).length === 1);

  // ---- request never reached the provider
  const lb = await paidOrder('lostbefore_r5');
  const lb1 = await refund(lb.payId, { amount: 1000, request_id: 'r5' });
  await q(`UPDATE admin_refund_requests SET next_attempt_at = now() - interval '1 second', lease_until = NULL WHERE razorpay_payment_id = $1`, [lb.payId]);
  const lb2 = await refund(lb.payId, { amount: 1000, request_id: 'r5' });
  const lbCalls = refundCalls().filter((c) => c.args[0] === lb.payId);
  check('R5 request lost BEFORE the provider: first try unknown, the retry resends the identical request with the SAME key, one refund results', lb1.status === 502 && lb2.status === 200 && lbCalls.length === 2 && lbCalls[0].args[2] === lbCalls[1].args[2] && JSON.stringify(lbCalls[0].args[1]) === JSON.stringify(lbCalls[1].args[1]) && mock.mockState().refunds.filter((x) => x.payment_id === lb.payId).length === 1);

  // ---- concurrent admin requests
  const c = await paidOrder('slow_r6');
  const callsC = refundCalls().length;
  const all = await Promise.all([refund(c.payId, {}), refund(c.payId, {}), refund(c.payId, {}), refund(c.payId, { amount: 500 })]);
  check('R6 four simultaneous admin refunds for one order: exactly one succeeds, the rest are refused (409), ONE provider refund', all.filter((x) => x.status === 200).length === 1 && all.filter((x) => x.status === 409).length === 3 && refundCalls().length === callsC + 1 && mock.mockState().refunds.filter((x) => x.payment_id === c.payId).length === 1 && Number((await orderOf(c.payId)).refunded_amount) === 1000);

  // ---- crash while submitting
  const cr = await paidOrder('crash_r8');
  const crRow = await crashRow(cr.payId, 'r8', 'adm_crash0000000000000000000000000001', 'ar_crash_r8');
  const crCalls = refundCalls().length;
  await processAdminRefund(crRow[0].id);
  check('R8 a worker that died mid-call (expired lease), provider had NOT acted: reconcile finds nothing, the same request goes again once, refund processed', (await reqOf(cr.payId))[0].status === 'processed' && refundCalls().length === crCalls + 1 && mock.mockState().refunds.filter((x) => x.payment_id === cr.payId).length === 1);
  const cr2 = await paidOrder('crash_r8b');
  await mock.mockRazorpay.payments.refundIdempotent(cr2.payId, { amount: 100000, receipt: 'ar_crash_r8b', notes: { admin_request: 'x' } }, 'adm_crash0000000000000000000000000002');
  const cr2Row = await crashRow(cr2.payId, 'r8b', 'adm_crash0000000000000000000000000002', 'ar_crash_r8b');
  const cr2Calls = refundCalls().length;
  await processAdminRefund(cr2Row[0].id);
  check('R8 worker died AFTER the provider refunded: reconcile adopts that refund (matched by our receipt), nothing is sent again', (await reqOf(cr2.payId))[0].status === 'processed' && refundCalls().length === cr2Calls && mock.mockState().refunds.filter((x) => x.payment_id === cr2.payId).length === 1);

  // ---- database guards
  const g = await paidOrder('guard_r9');
  const orderId = (await orderOf(g.payId)).id;
  const insertReq = (suffix: string, amount: number, status = 'queued') => q(`INSERT INTO admin_refund_requests (order_id, razorpay_payment_id, request_id, amount_paise, idempotency_key, receipt, status) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [orderId, g.payId, `g-${suffix}`, amount, `adm_guard${suffix}0000000000000000`, `ar_guard_${suffix}`, status]);
  const verdict = (p: Promise<unknown>) => p.then(() => 'accepted', (e) => (e as Error).message.slice(0, 200));
  const over = await verdict(insertReq('over', 100001));
  check('R9 the database refuses an admin refund larger than the order total', /exceed|check/i.test(over), over);
  await insertReq('one', 40000);
  const second = await verdict(insertReq('two', 10000));
  check('R9 the database allows only ONE unresolved refund per order (unique index)', /unique|duplicate/i.test(second), second);
  const skip = await verdict(q(`UPDATE admin_refund_requests SET status = 'processed', provider_refund_id = 'rfnd_x1x', provider_status = 'processed', settled_at = now() WHERE request_id = 'g-one'`));
  check('R9 a request cannot jump from queued to processed (must pass through submitting)', /not allowed/i.test(skip), skip);
  const noConfirm = await verdict(q(`UPDATE admin_refund_requests SET status = 'submitting', lease_until = now() + interval '1 minute' WHERE request_id = 'g-one'`).then(() => q(`UPDATE admin_refund_requests SET status = 'processed' WHERE request_id = 'g-one'`)));
  check('R9 "processed" without a provider refund id, provider status and settle time is refused', /arr_processed_confirmed|check/i.test(noConfirm), noConfirm);
  await q(`UPDATE admin_refund_requests SET status = 'failed', settled_at = now(), lease_until = NULL WHERE request_id = 'g-one'`);
  const reopen = await verdict(q(`UPDATE admin_refund_requests SET status = 'submitting', lease_until = now() + interval '1 minute' WHERE request_id = 'g-one'`));
  check('R9 a settled (failed) request can never be reopened', /not allowed/i.test(reopen), reopen);
  const mutate = await verdict(q(`UPDATE admin_refund_requests SET amount_paise = 5 WHERE request_id = 'g-one'`));
  check('R9 the request itself (amount, key, receipt, payment) is immutable', /immutable/i.test(mutate), mutate);

  // ---- admin and the automatic workflow cannot both refund one payment
  const auto = await queuedRefund(pid('autoblock2'));
  const autoRow = await attemptOf(auto.attemptId);
  await q(`INSERT INTO orders (custom_order_id, items, subtotal, shipping_charge, cod_charge, total_amount, customer_name, customer_email, customer_phone, payment_method, status, razorpay_payment_id, razorpay_order_id)
     VALUES ('VEDIQRA#SAFE${uniq()}', '[]'::jsonb, 1000, 0, 0, 1000, 'X', 'x@example.com', '9876543210', 'online', 'paid', $1, 'order_safe_synthetic')`, [autoRow.razorpay_payment_id]);
  const bypass = await refund(autoRow.razorpay_payment_id, {});
  check('R10 the admin endpoint cannot bypass an automatic refund attempt for the same payment (409, provider not asked)', bypass.status === 409 && (await reqOf(autoRow.razorpay_payment_id)).length === 0);

  // ---- consistency over the whole run
  const inv = {
    orderVsProcessed: await count(`select count(*)::int n from orders o where o.payment_method = 'online' and exists (select 1 from admin_refund_requests r where r.order_id = o.id)
       and round(o.refunded_amount * 100) <> coalesce((select sum(amount_paise) from admin_refund_requests r where r.order_id = o.id and r.status = 'processed'), 0)`),
    refundedWithoutProcessed: await count(`select count(*)::int n from orders o where o.status = 'refunded' and o.id in (select order_id from admin_refund_requests) and not exists (select 1 from admin_refund_requests r where r.order_id = o.id and r.status = 'processed')`),
    refundedWithUnresolved: await count(`select count(*)::int n from orders o where o.status in ('refunded','partially_refunded') and exists (select 1 from admin_refund_requests r where r.order_id = o.id and r.status in ('pending','unknown','submitting','queued'))`) ,
    overRefund: await count(`select count(*)::int n from orders where refunded_amount > total_amount`),
  };
  check('R11 consistency over the whole run: refunded_amount equals the processed requests, no order is "refunded" without a processed refund, none exceeds its total', inv.orderVsProcessed === 0 && inv.refundedWithoutProcessed === 0 && inv.overRefund === 0, JSON.stringify(inv));

  // ---- historical COD order unchanged
  const hist = (await q(`INSERT INTO orders (custom_order_id, items, subtotal, shipping_charge, cod_charge, total_amount, customer_name, customer_email, customer_phone, payment_method, status, refunded_amount, refunds)
     VALUES ('VEDIQRA#HISTS${uniq()}', '[{"name":"old"}]'::jsonb, 2000, 0, 49, 2049, 'Old', 'old@example.com', '9876543210', 'cod', 'partially_refunded', 100, '[{"id":"rfnd_legacy1","amount":100,"status":"processed"}]'::jsonb) RETURNING id`))[0].id;
  const snap = JSON.stringify(await one('select * from orders where id = $1', [hist]));
  await runRecoveryOnce();
  check('R12 a historical COD order with a legacy-recorded partial refund is untouched', JSON.stringify(await one('select * from orders where id = $1', [hist])) === snap);
}

// =====================================================================================================================
section('W. Webhook abuse protection');
// =====================================================================================================================
{
  resetAll();
  // 1. capacity guard (503 + Retry-After) - before any database work
  const mk = async (n: number) => Promise.all(Array.from({ length: n }, (_, i) => paidCheckout({ cust: buyer(`wc${i}`), payId: pid(`wc${i}`) })));
  const set = await mk(5);
  mock.delays.paymentFetch = 700;                                                // keeps each event "in processing"
  const raws = set.map((s) => webhookBody('payment.captured', { orderId: s.orderId, payId: s.payId, amount: s.co.json.amount }));
  const ids = set.map(() => `evt_${uniq()}`);
  const results = await Promise.all(raws.map((raw, i) => webhook(raw, { eventId: ids[i] })));
  mock.delays.paymentFetch = 0;
  const busy = results.filter((r) => r.status === 503);
  check('W1 more events than WEBHOOK_MAX_CONCURRENT (3) at once: the extra ones get 503 + Retry-After; the others are processed', config.webhookMaxConcurrent === 3 && busy.length === 2 && results.filter((r) => r.status === 200).length === 3, results.map((r) => r.status).join(','));
  const busyIdx = results.map((r, i) => (r.status === 503 ? i : -1)).filter((i) => i >= 0);
  check('W2 a turned-away event leaves no trace in the database (it was refused before anything was stored) and its order is untouched', (await Promise.all(busyIdx.map(async (i) => (await eventRow(ids[i])) === undefined && (await ordersFor(set[i].payId)) === 0))).every(Boolean));
  const retried = await Promise.all(busyIdx.map((i) => webhook(raws[i], { eventId: ids[i] })));
  check('W3 Razorpay\'s redelivery of those events (same ids) succeeds and fulfils them', retried.every((r) => r.status === 200) && (await Promise.all(busyIdx.map((i) => ordersFor(set[i].payId)))).every((n) => n === 1));
  const busyRes = await api('POST', '/api/payment/webhook', undefined, { 'X-Razorpay-Signature': 'bad' }, '{}');
  check('W4 the capacity guard does not weaken signature checking: an unsigned request is still a plain 400', busyRes.status === 400);

  // 2. normal retries stay under the limit
  const one1 = set[0];
  const raw = raws[0];
  const dups = [];
  for (let i = 0; i < 3; i++) dups.push(await webhook(raw, { eventId: ids[0] }));
  check('W5 normal provider retries of one event (3 more deliveries) are all accepted as duplicates', dups.every((r) => r.status === 200 && r.json.duplicate === true) && (await ordersFor(one1.payId)) === 1);

  // 3. the per-IP limit: 12 per minute in this run
  logs.length = 0;
  const eventsBefore = await count('select count(*)::int n from payment_webhook_events');
  let first429 = 0; let last: any = null;
  for (let i = 0; i < 30 && !first429; i++) {
    last = await webhook(webhookBody('payment.failed', { orderId: 'order_flood_1', payId: 'pay_flood_1', amount: 100, status: 'failed' }), { eventId: `evt_${uniq()}` });
    if (last.status === 429) first429 = i + 1;
  }
  check('W6 a flood is answered 429 once the per-minute ceiling is passed (ceiling 12 in this run, minus requests already made)', first429 > 0 && first429 <= 13, `first 429 at request ${first429}`);
  const rejectedBefore = await count('select count(*)::int n from payment_webhook_events');
  const rej = await api('POST', '/api/payment/webhook', undefined, { 'X-Razorpay-Signature': wsign('{"x":1}'), 'X-Razorpay-Event-Id': 'evt_after_limit' }, '{"x":1}');
  check('W7 a rejected request carries Retry-After, a retryable status, and did no database work (no event stored)', rej.status === 429 && /rate limited/.test(rej.text) && (await count('select count(*)::int n from payment_webhook_events')) === rejectedBefore && rejectedBefore >= eventsBefore);
  const rejHeaders = await fetch(BASE + '/api/payment/webhook', { method: 'POST', headers: { 'X-Razorpay-Signature': 'deadbeef'.repeat(8), 'Content-Type': 'application/json' }, body: '{"secretish":"payload-marker"}' });
  check('W8 429 responses include Retry-After', rejHeaders.status === 429 && rejHeaders.headers.get('retry-after') === '30');
  const logText = logs.join('\n');
  check('W9 limiting logs no signature, payload, secret or customer data', !logText.includes('deadbeef') && !logText.includes('payload-marker') && !logText.includes(WH_CURRENT) && !/p2-[a-z0-9-]+@example[.]com|leak[.]person/.test(logText), logText.split(String.fromCharCode(10)).filter((l) => /deadbeef|payload-marker|p2-[a-z0-9-]+@example[.]com/.test(l)).join(' | ').slice(0, 200));
  const other = await api('POST', '/api/payment/status', { razorpay_order_id: 'order_x1', token: 'y'.repeat(30) });
  check('W10 the webhook limiter is separate from the customer endpoints (status lookups are unaffected)', other.status === 404);
}

{
  const cfgFile = path.join(os.tmpdir(), `p4-config-check-${uniq()}.cjs`);
  fs.writeFileSync(cfgFile, `const c = require(${JSON.stringify(path.join(BACKEND, 'src', 'config'))}).default; console.log('MAXC=' + c.webhookMaxConcurrent);`);
  const probe = (env: Record<string, string>) => {
    const clean = { ...ENVP } as Record<string, string | undefined>;
    delete clean.WEBHOOK_MAX_CONCURRENT;
    const r = spawnSync(process.execPath, ['--import', 'tsx', cfgFile], { cwd: BACKEND, env: { ...clean, NODE_ENV: 'development', ...env }, encoding: 'utf8' });
    return (r.stdout || '').match(/MAXC=(\d+)/)?.[1];
  };
  check('W11 WEBHOOK_MAX_CONCURRENT: default 25, honoured, clamped to 1..500', probe({}) === '25' && probe({ WEBHOOK_MAX_CONCURRENT: '7' }) === '7' && probe({ WEBHOOK_MAX_CONCURRENT: '0' }) === '1' && probe({ WEBHOOK_MAX_CONCURRENT: '99999' }) === '500' && probe({ WEBHOOK_MAX_CONCURRENT: 'abc' }) === '25');
  const rlFile = path.join(os.tmpdir(), `p4-rl-check-${uniq()}.cjs`);
  void rlFile;
}

// =====================================================================================================================
section('S. Durable stock restoration after a full admin refund');
// =====================================================================================================================
{
  const { processStockTask, dueStockTaskIds } = await import('../src/services/stockRestoration');
  resetAll();
  const taskOf = (orderId: string) => one('select * from stock_restoration_tasks where order_id = $1', [orderId]);
  const dueNow = (orderId: string) => q(`UPDATE stock_restoration_tasks SET next_attempt_at = now() - interval '1 second', lease_until = CASE WHEN status = 'restoring' THEN now() - interval '1 second' ELSE NULL END WHERE order_id = $1`, [orderId]);

  // S1: the task is written WITH the settlement and completed in one transaction
  const base = await stockOf(TEE.id);
  const a = await paidOrder('s1');
  const ord = await orderOf(a.payId);
  check('S1 setup: the sale took one unit', (await stockOf(TEE.id)) === base - 1);
  await refund(a.payId, { amount: 300, request_id: 's1-part' });
  check('S1 a PARTIAL refund creates no restoration task and restores nothing', (await taskOf(ord.id)) === undefined && (await stockOf(TEE.id)) === base - 1);
  await refund(a.payId, { amount: 700, request_id: 's1-rest' });
  const t1 = await taskOf(ord.id);
  check('S1 the refund that completes the order creates exactly one task (linked to its refund request), completes it, and restores the unit once', t1.status === 'done' && t1.result === 'restored' && !!t1.admin_refund_request_id && (await stockOf(TEE.id)) === base && (await orderOf(a.payId)).stock_restored_at !== null);

  // S2: crash AFTER the refund settled but BEFORE the restoration ran
  const b = await paidOrder('s2');
  const bOrder = await orderOf(b.payId);
  const stockB0 = await stockOf(TEE.id);
  const realQuery = pool.query.bind(pool);
  let crashed = false;
  (pool as any).query = (...args: any[]) => {
    if (!crashed && typeof args[0] === 'string' && args[0].includes("UPDATE stock_restoration_tasks SET status = 'restoring'")) { crashed = true; return Promise.reject(new Error('simulated crash before restoration')); }
    return (realQuery as any)(...args);
  };
  const rb = await refund(b.payId, {});
  (pool as any).query = realQuery;
  const t2 = await taskOf(bOrder.id);
  check('S2 crash between settlement and restoration: the refund is recorded (order refunded) AND the task is pending; stock not yet back - no silent divergence', crashed && rb.status === 200 && (await orderOf(b.payId)).status === 'refunded' && t2.status === 'queued' && (await orderOf(b.payId)).stock_restored_at === null && (await stockOf(TEE.id)) === stockB0);
  const refundsBefore = refundCalls().length;
  await runRecoveryOnce();
  const t2b = await taskOf(bOrder.id);
  check('S2 after the restart the worker finds the task and restores the stock exactly once; no provider call is made', t2b.status === 'done' && (await stockOf(TEE.id)) === stockB0 + 1 && (await orderOf(b.payId)).stock_restored_at !== null && refundCalls().length === refundsBefore);

  // S3: worker died while holding the lease
  const c = await paidOrder('s3');
  const cOrder = await orderOf(c.payId);
  const stockC0 = await stockOf(TEE.id);
  (pool as any).query = (...args: any[]) => (typeof args[0] === 'string' && args[0].includes("UPDATE stock_restoration_tasks SET status = 'restoring'") ? Promise.reject(new Error('crash')) : (realQuery as any)(...args));
  await refund(c.payId, {});
  (pool as any).query = realQuery;
  await q(`UPDATE stock_restoration_tasks SET status = 'restoring', attempts = 1, lease_until = now() + interval '5 minutes' WHERE order_id = $1`, [cOrder.id]);
  await runRecoveryOnce();
  check('S3 a task under a live lease is left alone', (await taskOf(cOrder.id)).status === 'restoring' && (await stockOf(TEE.id)) === stockC0);
  await dueNow(cOrder.id);
  await runRecoveryOnce();
  check('S3 once the lease has expired the task is reclaimed and completed (stock back once)', (await taskOf(cOrder.id)).status === 'done' && (await stockOf(TEE.id)) === stockC0 + 1);

  // S4: many workers at once
  const d = await paidOrder('s4', [line(TEE.id, 2)]);
  const dOrder = await orderOf(d.payId);
  const stockD0 = await stockOf(TEE.id);
  (pool as any).query = (...args: any[]) => (typeof args[0] === 'string' && args[0].includes("UPDATE stock_restoration_tasks SET status = 'restoring'") ? Promise.reject(new Error('crash')) : (realQuery as any)(...args));
  await refund(d.payId, {});
  (pool as any).query = realQuery;
  const tid = (await taskOf(dOrder.id)).id;
  const outcomes = await Promise.all([...Array.from({ length: 6 }, () => processStockTask(tid)), runRecoveryOnce(), runRecoveryOnce(), runRecoveryOnce()]);
  void outcomes;
  check('S4 six direct runs + three worker passes at once: the two units come back exactly ONCE, one task completed', (await stockOf(TEE.id)) === stockD0 + 2 && (await taskOf(dOrder.id)).status === 'done');
  const again = await processStockTask(tid);
  check('S4 running a completed task again is a no-op', again === 'not_claimed' && (await stockOf(TEE.id)) === stockD0 + 2);

  // S5: an order cancelled first (stock already returned) and refunded later must not return stock twice
  const e = await paidOrder('s5');
  const eOrder = await orderOf(e.payId);
  const stockE0 = await stockOf(TEE.id);
  const cancel = await api('PUT', `/api/admin/orders/${eOrder.id}`, { status: 'cancelled' }, ADMIN);
  const stockE1 = await stockOf(TEE.id);
  await refund(e.payId, {});
  const te = await taskOf(eOrder.id);
  check('S5 cancelled (stock returned) then fully refunded: the task completes as "already restored" and the stock is NOT returned a second time', cancel.status === 200 && stockE1 === stockE0 + 1 && te.status === 'done' && /already restored/.test(te.result) && (await stockOf(TEE.id)) === stockE1);

  // S6: automatic stock-failure refunds and historical orders
  const histId = (await q(`INSERT INTO orders (custom_order_id, items, subtotal, shipping_charge, cod_charge, total_amount, customer_name, customer_email, customer_phone, payment_method, status, refunded_amount, refunds, stock_movements, razorpay_payment_id, razorpay_order_id)
     VALUES ('VEDIQRA#HSTK${uniq()}', '[]'::jsonb, 1000, 0, 0, 1000, 'H', 'h@example.com', '9876543210', 'online', 'refunded', 1000, '[{"id":"rfnd_old1","amount":1000,"status":"processed"}]'::jsonb, $1::jsonb, 'pay_hist_stock_1', 'order_hist_stock_1') RETURNING id`, [JSON.stringify([{ kind: 'product', id: TEE.id, qty: 5 }])]))[0].id;
  const stockH0 = await stockOf(TEE.id);
  const auto = await queuedRefund(pid('s6'));
  await processRefundAttempt(auto.attemptId);
  await runRecoveryOnce();
  check('S6 an order refunded BEFORE this feature gets no task and its stock is not touched; an automatic stock-failure refund creates no task either', (await taskOf(histId)) === undefined && (await stockOf(TEE.id)) === stockH0 && (await count('select count(*)::int n from stock_restoration_tasks t join orders o on o.id = t.order_id where o.razorpay_payment_id = $1', [auto.intent.razorpay_payment_id ?? 'none'])) === 0 && (await one('select stock_restored_at from orders where id = $1', [histId])).stock_restored_at === null);

  // S7: persistent failure is bounded and visible
  const f = await paidOrder('s7');
  const fOrder = await orderOf(f.payId);
  const stockF0 = await stockOf(TEE.id);
  (pool as any).query = (...args: any[]) => (typeof args[0] === 'string' && args[0].includes("UPDATE stock_restoration_tasks SET status = 'restoring'") ? Promise.reject(new Error('crash')) : (realQuery as any)(...args));
  await refund(f.payId, {});
  (pool as any).query = realQuery;
  await q(`CREATE OR REPLACE FUNCTION s7_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected stock failure'; END $$`);
  await q(`CREATE TRIGGER s7_boom_trg BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION s7_boom()`);
  const ftid = (await taskOf(fOrder.id)).id;
  const results: string[] = [];
  for (let i = 0; i < 11; i++) { await dueNow(fOrder.id); results.push(await processStockTask(ftid)); }
  await q('DROP TRIGGER s7_boom_trg ON products'); await q('DROP FUNCTION s7_boom()');
  const tf = await taskOf(fOrder.id);
  const rv = await api('GET', '/api/payment/review?limit=200', undefined, ADMIN);
  check('S7 a task whose restoration keeps failing rolls back completely each time (stock untouched), stops after 10 attempts as needs_review, and is listed for the admin', tf.status === 'needs_review' && tf.attempts === 10 && (await stockOf(TEE.id)) === stockF0 && (await orderOf(f.payId)).stock_restored_at === null && rv.json.stock_restoration_tasks.some((t: any) => t.id === ftid), results.join(','));

  // S8: database guards
  const reopen = await q(`UPDATE stock_restoration_tasks SET status = 'queued', completed_at = NULL WHERE order_id = $1`, [ord.id]).then(() => 'accepted', (x) => (x as Error).message);
  const dupTask = await q(`INSERT INTO stock_restoration_tasks (order_id) VALUES ($1)`, [ord.id]).then(() => 'accepted', (x) => (x as Error).message);
  check('S8 a completed task cannot be reopened, and an order can have only one task', /cannot be reopened/.test(reopen) && /unique|duplicate/i.test(dupTask), `${reopen.slice(0, 60)} | ${dupTask.slice(0, 60)}`);
  void dueStockTaskIds;
}

// =====================================================================================================================
section('Q. Resolving a needs_review admin refund only with provider evidence');
// =====================================================================================================================
{
  resetAll();
  const resolve = (id: string, body: Record<string, unknown>, auth = true) => api('POST', `/api/payment/review/admin-refund/${id}/resolve`, body, auth ? ADMIN : {});
  /** an order with an admin refund request that a person has to resolve (needs_review) */
  async function reviewCase(tag: string, amountPaise = 100000) {
    const w = await paidOrder(tag);
    const o = await orderOf(w.payId);
    const rows = await q(`INSERT INTO admin_refund_requests (order_id, razorpay_payment_id, request_id, amount_paise, idempotency_key, receipt)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [o.id, w.payId, `q-${tag}`, amountPaise, `adm_q${uniq()}0000000000`.slice(0, 40), `ar_q_${uniq()}`.slice(0, 40)]);
    await q(`UPDATE admin_refund_requests SET status = 'needs_review', review_reason = 'test' WHERE id = $1`, [rows[0].id]);
    return { w, orderId: o.id as string, id: rows[0].id as string };
  }
  const dashboard = (payId: string, amount: number, key: string) => mock.mockRazorpay.payments.refundIdempotent(payId, { amount }, key);

  const base = await stockOf(TEE.id);
  const a = await reviewCase('q1');
  check('Q0 resolving needs an admin token (401), a valid id (400) and a refund id (400)', (await resolve(a.id, { provider_refund_id: 'rfnd_x' }, false)).status === 401 && (await resolve('nope', { provider_refund_id: 'rfnd_x' })).status === 400 && (await resolve(a.id, {})).status === 400);
  const none = await resolve(a.id, { provider_refund_id: 'rfnd_not_there' });
  check('Q1 a refund id Razorpay does not list for this payment cannot resolve it (409); nothing changes', none.status === 409 && (await one('select status from admin_refund_requests where id = $1', [a.id])).status === 'needs_review' && Number((await orderOf(a.w.payId)).refunded_amount) === 0);
  const other = await paidOrder('q1other');
  const foreign = await dashboard(other.payId, 100000, 'dash-q1-foreign-001');
  check('Q2 another payment\'s refund cannot be used (not listed for THIS payment, 409)', (await resolve(a.id, { provider_refund_id: foreign.id })).status === 409);
  const wrongAmt = await dashboard(a.w.payId, 40000, 'dash-q1-wrongamt-01');
  const rWrong = await resolve(a.id, { provider_refund_id: wrongAmt.id });
  check('Q3 a refund of a different amount than the request is refused (409)', rWrong.status === 409 && (await one('select status from admin_refund_requests where id = $1', [a.id])).status === 'needs_review');

  const p = await reviewCase('refundpending_q4');
  const pend = await dashboard(p.w.payId, 100000, 'dash-q4-pending-0001');
  check('Q4 a refund that is still PENDING at Razorpay cannot resolve it (409)', (await resolve(p.id, { provider_refund_id: pend.id })).status === 409);
  mock.advanceRefund(pend.id, 'processed');

  const x = await reviewCase('q5', 60000);
  await dashboard(x.w.payId, 60000, 'dash-q5-ours-000001');
  const extra = await dashboard(x.w.payId, 10000, 'dash-q5-extra-000001');
  const ours = mock.mockState().refunds.find((r) => r.payment_id === x.w.payId && r.amount === 60000)!;
  check('Q5 another refund exists on the payment (totals do not reconcile): refused (409) until a person reconciles it', (await resolve(x.id, { provider_refund_id: ours.id })).status === 409 && !!extra);

  // success: processed + exact amount + totals reconcile (the pending one above has now settled)
  const rOk = await resolve(p.id, { provider_refund_id: pend.id });
  const po = await orderOf(p.w.payId);
  const pRow = await one('select * from admin_refund_requests where id = $1', [p.id]);
  check('Q6 with a processed refund for this payment, the same amount/currency and reconciling totals: the request becomes processed with that refund id; order refunded, ledger updated, stock task created and completed', rOk.status === 200 && pRow.status === 'processed' && pRow.provider_refund_id === pend.id && po.status === 'refunded' && Number(po.refunded_amount) === 1000 && po.refunds.some((r: any) => r.id === pend.id && r.status === 'processed') && (await one('select status from stock_restoration_tasks where order_id = $1', [po.id])).status === 'done', `${rOk.status} ${JSON.stringify(rOk.json).slice(0,200)} req=${pRow.status}/${pRow.provider_refund_id} order=${po.status}/${po.refunded_amount}`);
  check('Q7 resolving it a second time is refused (409): it is no longer under review', (await resolve(p.id, { provider_refund_id: pend.id })).status === 409);

  // failed at the provider: nothing moved, the order is unblocked
  const fcase = await reviewCase('refundfailed_q8');
  const failedRefund = await dashboard(fcase.w.payId, 100000, 'dash-q8-failed-00001');
  const blockedBefore = await refund(fcase.w.payId, { amount: 100 });
  const rFail = await resolve(fcase.id, { provider_refund_id: failedRefund.id });
  const fo = await orderOf(fcase.w.payId);
  const after = await refund(fcase.w.payId, { amount: 100, request_id: 'after-q8' });
  check('Q8 a refund Razorpay reports as FAILED settles the request as failed: order untouched (nothing moved), and a new refund is allowed again (it was blocked before)', blockedBefore.status === 409 && rFail.status === 200 && rFail.json.refund_status === 'failed' && fo.status === 'paid' && Number(fo.refunded_amount) === 0 && after.status !== 409);

  // an unrecorded dashboard refund on the payment blocks the "failed" resolution too
  const g = await reviewCase('refundfailed_q9');
  const failed2 = await dashboard(g.w.payId, 100000, 'dash-q9-failed-00001');
  mock.mockState().payments.find((pp) => pp.id === g.w.payId)!.amount_refunded = 5000;
  check('Q9 if the payment shows money refunded that the order does not record, even a "failed" resolution is refused (409)', (await resolve(g.id, { provider_refund_id: failed2.id })).status === 409);

  const notReview = await reviewCase('q10');
  await q(`UPDATE admin_refund_requests SET status = 'failed', settled_at = now() WHERE id = $1`, [notReview.id]);
  check('Q10 only requests that are under review can be resolved (409)', (await resolve(notReview.id, { provider_refund_id: 'rfnd_whatever' })).status === 409);
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
