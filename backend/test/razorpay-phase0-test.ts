// TEST ONLY - Payment-recovery Phase 0: the Razorpay client additions, the configuration rules, and the test fake.
// Nothing here touches the real Razorpay API, a real database or the app's HTTP server.
//   npx tsx test/razorpay-phase0-test.ts
//
//  Part A  the fake: does it reproduce Razorpay's documented idempotency/refund behaviour (and catch duplicates)?
//  Part B  the real client (direct HTTPS) against a local stub server: headers, identical bodies, no auto-retry,
//          timeouts, error classification, PII stripping, no secrets in errors or logs
//  Part C  configuration validation (spawned processes, because config is read once at import)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const results: { name: string; ok: boolean }[] = [];
const out = (s: string) => process.stdout.write(s + '\n');
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok }); out(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail.slice(0, 200) : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEY_ID = 'rzp_test_STUBKEYID12345';
const KEY_SECRET = 'stub_secret_value_ABCDEF987654';

// ------------------------------------------------------------------------------------------ local stub "Razorpay"
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const seen: Seen[] = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    seen.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const url = req.url || '';
    if (url.startsWith('/redirect')) { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); return res.end(); }
    if (req.method === 'GET' && /^\/v1\/payments\/pay_pii$/.test(url)) {
      return send(200, { id: 'pay_pii', entity: 'payment', order_id: 'order_pii', amount: 12345, currency: 'INR', status: 'captured', captured: true,
        method: 'card', amount_refunded: 0, refund_status: null, email: 'secret.person@example.com', contact: '+919999999999',
        card: { last4: '4242', name: 'Secret Person' }, vpa: 'secret@upi', notes: { a: 'b' }, error_code: null, error_description: null, created_at: 1700000000 });
    }
    if (req.method === 'GET' && /^\/v1\/orders\/order_pii\/payments$/.test(url)) {
      return send(200, { entity: 'collection', count: 2, items: [
        { id: 'pay_f', order_id: 'order_pii', amount: 100, currency: 'INR', status: 'failed', captured: false, method: 'upi', email: 'x@example.com', contact: '+910000000000', vpa: 'x@upi', error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment failed' },
        { id: 'pay_ok', order_id: 'order_pii', amount: 100, currency: 'INR', status: 'captured', captured: true, method: 'upi', email: 'x@example.com' }] });
    }
    if (req.method === 'GET' && /^\/v1\/payments\/pay_ok\/refunds$/.test(url)) {
      return send(200, { entity: 'collection', count: 2, items: [
        { id: 'rfnd_1', payment_id: 'pay_ok', amount: 500, currency: 'INR', status: 'processed', receipt: 'att-1', notes: { attempt_id: 'att-1' }, created_at: 1700000001 },
        { id: 'rfnd_2', payment_id: 'pay_ok', amount: 100, currency: 'INR', status: 'pending', receipt: null, notes: [], created_at: 1700000002 }] });
    }
    if (req.method === 'GET' && /^\/v1\/payments\/pay_missing$/.test(url)) return send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist', field: 'id' } });
    if (req.method === 'POST' && /\/refund$/.test(url)) {
      if (url.includes('pay_5xx')) return send(500, { error: { code: 'SERVER_ERROR', description: 'Something went wrong' } });
      if (url.includes('pay_slow')) { await sleep(2500); return send(200, { id: 'rfnd_late', amount: 1, status: 'processed' }); }
      if (url.includes('pay_conflict')) return send(409, { error: { code: 'BAD_REQUEST_ERROR', description: 'Different request with the same idempotency key has already been processed.' } });
      if (url.includes('pay_inprog')) return send(409, { error: { code: 'BAD_REQUEST_ERROR', description: 'Another request with this idempotency key is in progress.' } });
      if (url.includes('pay_400')) return send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The refund amount provided is greater than the amount captured' } });
      if (url.includes('pay_garbage')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>nope</html>'); }
      const parsed = JSON.parse(body || '{}');
      return send(200, { id: 'rfnd_new', entity: 'refund', payment_id: url.split('/')[3], amount: parsed.amount, currency: 'INR', status: 'pending', receipt: parsed.receipt ?? null, notes: parsed.notes ?? [], created_at: 1700000003 });
    }
    send(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
  });
});

async function main() {
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as any).port;
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${port}`;
  process.env.RAZORPAY_TIMEOUT_MS = '1000';
  process.env.NODE_ENV = 'development';

  const mockMod = await import('./mockRazorpay');
  const clientMod = await import('../src/services/razorpayClient');
  const { RazorpayApiError, canonicalRefundBody } = clientMod;
  const m = mockMod.mockRazorpay;

  const tryCall = async <T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: any }> => {
    try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
  };

  // ============================================================================================ PART A: the fake
  out('--- Part A: test fake');
  const reset = () => mockMod.resetMockState();
  const KEY = 'vq-rf-aaaaaaaa-0000-0000-0000-000000000001-1';
  const req = { amount: 50000, receipt: 'attempt-1', notes: { attempt_id: 'attempt-1', intent_id: 'intent-1' } };

  reset(); mockMod.seedPayment({ id: 'pay_a1', order_id: 'order_a', amount: 50000 });
  let r1 = await m.payments.refundIdempotent('pay_a1', req, KEY);
  let list = await m.payments.fetchRefunds('pay_a1');
  let pay = await m.payments.fetch('pay_a1');
  check('A1 refund created: processed, counted against the payment, listed with our receipt and notes',
    r1.status === 'processed' && r1.amount === 50000 && pay.amount_refunded === 50000 && pay.refund_status === 'full' && list.count === 1 && list.items[0].receipt === 'attempt-1' && list.items[0].notes.attempt_id === 'attempt-1');

  const r1b = await m.payments.refundIdempotent('pay_a1', req, KEY);
  list = await m.payments.fetchRefunds('pay_a1');
  check('A2 same key + identical body replays: the SAME refund id comes back and no second refund exists', r1b.id === r1.id && list.count === 1 && mockMod.mockState().refundCount === 1);

  const diff = await tryCall(() => m.payments.refundIdempotent('pay_a1', { ...req, amount: 40000 }, KEY));
  check('A3 same key + different body is refused with a 409 idempotency conflict, nothing created',
    !diff.ok && diff.e.status === 409 && diff.e.idempotencyConflict === true && diff.e.retryable === false && mockMod.mockState().refundCount === 1);

  const dup = await tryCall(() => m.payments.refundIdempotent('pay_a1', req, 'vq-rf-another-key-000001'));
  check('A4 a NEW key for an already fully refunded payment is refused (the duplicate-refund attempt is caught)',
    !dup.ok && dup.e.status === 400 && /greater than/.test(dup.e.description) && mockMod.mockState().refundCount === 1);

  // lost response: the provider did it, we never heard
  reset(); mockMod.seedPayment({ id: 'pay_lostresp', order_id: 'order_b', amount: 20000 });
  const KEY2 = 'vq-rf-bbbbbbbb-0000-0000-0000-000000000002-1';
  const body2 = { amount: 20000, receipt: 'attempt-2', notes: { attempt_id: 'attempt-2' } };
  const lost = await tryCall(() => m.payments.refundIdempotent('pay_lostresp', body2, KEY2));
  check('A5 lost response: the call fails as an UNKNOWN outcome (timeout, outcomeUnknown, retryable)', !lost.ok && lost.e.kind === 'timeout' && lost.e.outcomeUnknown === true && lost.e.retryable === true);
  list = await m.payments.fetchRefunds('pay_lostresp');
  const found = list.items.find((x) => x.notes.attempt_id === 'attempt-2');
  check('A6 reconciliation: listing the payment\'s refunds finds the refund by our attempt id although we never got the answer', list.count === 1 && !!found && found.status === 'processed');
  const recovered = await m.payments.refundIdempotent('pay_lostresp', body2, KEY2);
  check('A7 retrying with the SAME key returns that very refund; still exactly one refund exists', recovered.id === found!.id && mockMod.mockState().refundCount === 1);
  const forbidden = await tryCall(() => m.payments.refundIdempotent('pay_lostresp', body2, 'vq-rf-NEW-KEY-after-loss-1'));
  check('A8 the forbidden move (start over with a NEW key after a lost response) is caught: refused, no second refund', !forbidden.ok && forbidden.e.status === 400 && mockMod.mockState().refundCount === 1);

  // request lost before reaching the provider
  reset(); mockMod.seedPayment({ id: 'pay_lostbefore', order_id: 'order_c', amount: 9000 });
  const KEY3 = 'vq-rf-cccccccc-0000-0000-0000-000000000003-1';
  const body3 = { amount: 9000, receipt: 'attempt-3', notes: { attempt_id: 'attempt-3' } };
  const lost3 = await tryCall(() => m.payments.refundIdempotent('pay_lostbefore', body3, KEY3));
  list = await m.payments.fetchRefunds('pay_lostbefore');
  check('A9 request never arrived: unknown-outcome error, and the refund list is empty (so a retry is needed)', !lost3.ok && lost3.e.outcomeUnknown === true && list.count === 0);
  const retry3 = await m.payments.refundIdempotent('pay_lostbefore', body3, KEY3);
  check('A10 same-key retry creates exactly one refund', retry3.status === 'processed' && mockMod.mockState().refundCount === 1);

  // pending / processed / failed
  reset(); mockMod.seedPayment({ id: 'pay_refundpending', order_id: 'order_d', amount: 7000 });
  const KEY4 = 'vq-rf-dddddddd-0000-0000-0000-000000000004-1';
  const p4 = await m.payments.refundIdempotent('pay_refundpending', { amount: 7000, receipt: 'att-4' }, KEY4);
  let pay4 = await m.payments.fetch('pay_refundpending');
  check('A11 pending refund: reported pending, already counted in amount_refunded', p4.status === 'pending' && pay4.amount_refunded === 7000);
  const adv = mockMod.advanceRefund(p4.id, 'processed');
  const replayed = await m.payments.refundIdempotent('pay_refundpending', { amount: 7000, receipt: 'att-4' }, KEY4);
  check('A12 settled to processed: the list and a replay both show processed (same refund id)', adv.status === 'processed' && replayed.status === 'processed' && replayed.id === p4.id);

  reset(); mockMod.seedPayment({ id: 'pay_refundpending_b', order_id: 'order_e', amount: 7000 });
  const p5 = await m.payments.refundIdempotent('pay_refundpending_b', { amount: 7000, receipt: 'att-5' }, 'vq-rf-eeeeeeee-0000-0000-0000-000000000005-1');
  mockMod.advanceRefund(p5.id, 'failed');
  const pay5 = await m.payments.fetch('pay_refundpending_b');
  check('A13 a refund that settles as failed stops counting: amount_refunded returns to 0', pay5.amount_refunded === 0 && pay5.refund_status === null);

  reset(); mockMod.seedPayment({ id: 'pay_refundfailed', order_id: 'order_f', amount: 1500 });
  const p6 = await m.payments.refundIdempotent('pay_refundfailed', { amount: 1500 }, 'vq-rf-ffffffff-0000-0000-0000-000000000006-1');
  check('A14 a refund created already failed is reported failed and does not count', p6.status === 'failed' && (await m.payments.fetch('pay_refundfailed')).amount_refunded === 0);

  // validation
  reset(); mockMod.seedPayment({ id: 'pay_v', order_id: 'order_v', amount: 1000 }); mockMod.seedPayment({ id: 'pay_unc', order_id: 'order_v', amount: 1000, status: 'failed' });
  const badKey = await tryCall(() => m.payments.refundIdempotent('pay_v', { amount: 100 }, 'short'));
  const badChars = await tryCall(() => m.payments.refundIdempotent('pay_v', { amount: 100 }, 'has spaces in it!!'));
  const missing = await tryCall(() => m.payments.refundIdempotent('pay_nope', { amount: 100 }, 'vq-rf-valid-key-00000001'));
  const notCaptured = await tryCall(() => m.payments.refundIdempotent('pay_unc', { amount: 100 }, 'vq-rf-valid-key-00000002'));
  const tooMuch = await tryCall(() => m.payments.refundIdempotent('pay_v', { amount: 1001 }, 'vq-rf-valid-key-00000003'));
  check('A15 provider-side validation: short key, bad characters, unknown payment, uncaptured payment and over-refund are all 400 and create nothing',
    [badKey, badChars, missing, notCaptured, tooMuch].every((x) => !x.ok && x.e.status === 400) && mockMod.mockState().refundCount === 0);

  // concurrency: same key while the first request is still running
  reset(); mockMod.seedPayment({ id: 'pay_slow', order_id: 'order_s', amount: 3000 });
  const KEY7 = 'vq-rf-slowslow-0000-0000-0000-000000000007-1';
  const slowBody = { amount: 3000, receipt: 'att-7' };
  const [s1, s2] = await Promise.all([tryCall(() => m.payments.refundIdempotent('pay_slow', slowBody, KEY7)), (async () => { await sleep(50); return tryCall(() => m.payments.refundIdempotent('pay_slow', slowBody, KEY7)); })()]);
  const okOne = [s1, s2].filter((x) => x.ok).length, inprog = [s1, s2].filter((x) => !x.ok && x.e.inProgress === true && x.e.status === 409).length;
  const afterSlow = await m.payments.refundIdempotent('pay_slow', slowBody, KEY7);
  check('A16 two simultaneous requests with one key: one succeeds, the other is a 409 in-progress; afterwards a replay returns the same refund; one refund total',
    okOne === 1 && inprog === 1 && mockMod.mockState().refundCount === 1 && afterSlow.id === mockMod.mockState().refunds[0].id);

  // lookups
  reset(); mockMod.seedPayment({ id: 'pay_x1', order_id: 'order_multi', amount: 500, status: 'failed', method: 'upi' }); mockMod.seedPayment({ id: 'pay_x2', order_id: 'order_multi', amount: 500 });
  const op = await m.orders.fetchPayments('order_multi');
  check('A17 order-payment lookup returns every attempt (failed and captured) for the order', op.count === 2 && op.items.some((p) => p.status === 'failed') && op.items.some((p) => p.captured));
  const down = await tryCall(() => m.orders.fetchPayments('order_apidown'));
  const down2 = await tryCall(() => m.payments.fetch('pay_apidown'));
  const down3 = await tryCall(() => m.payments.refundIdempotent('pay_apidown', { amount: 100 }, 'vq-rf-valid-key-00000009'));
  check('A18 API outage: reads fail as network errors (outcome known: nothing happened); a refund write fails with outcomeUnknown',
    !down.ok && down.e.kind === 'network' && down.e.outcomeUnknown === false && !down2.ok && down2.e.kind === 'network' && !down3.ok && down3.e.outcomeUnknown === true);

  // legacy behaviour untouched
  const legacyOk = await m.payments.refund('pay_legacy_ok', { amount: 100 });
  const legacyPending = await m.payments.refund('pay_legacy_pending', { amount: 100 });
  const legacyFail = await tryCall(() => m.payments.refund('pay_fail_x', { amount: 100 }));
  check('A19 the legacy refund call behaves exactly as before (processed / pending / provider failure)', legacyOk.status === 'processed' && legacyPending.status === 'pending' && !legacyFail.ok && /unreachable/.test(String(legacyFail.e.message)));
  reset();

  // ============================================================================================ PART B: real client
  out('--- Part B: real client against a local stub');
  const real = clientMod.getRazorpay();
  const logs: string[] = [];
  const origs = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) (console as any)[k] = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const errors: any[] = [];
  const guard = async <T>(fn: () => Promise<T>) => { const r = await tryCall(fn); if (!r.ok) errors.push(r.e); return r; };

  seen.length = 0;
  const piiPay = await real.payments.fetch('pay_pii');
  const auth = seen[0]?.headers.authorization || '';
  check('B1 GET sends HTTP Basic auth built from the configured key id and secret', auth === 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64') && seen[0].method === 'GET' && seen[0].url === '/v1/payments/pay_pii' && !seen[0].headers['x-refund-idempotency']);
  const dumped = JSON.stringify(piiPay);
  check('B2 customer PII is stripped at the boundary (email, phone, card, UPI id never leave the client)',
    piiPay.id === 'pay_pii' && piiPay.amount === 12345 && piiPay.captured === true && piiPay.method === 'card' && !/secret\.person|9999999999|4242|Secret Person|secret@upi/.test(dumped));
  const op2 = await real.orders.fetchPayments('order_pii');
  check('B3 order payments: collection mapped, failed attempt keeps its error code, PII stripped',
    op2.count === 2 && op2.items[0].status === 'failed' && op2.items[0].error_code === 'BAD_REQUEST_ERROR' && !/@|\+91/.test(JSON.stringify(op2)));
  const refs = await real.payments.fetchRefunds('pay_ok');
  check('B4 refund list: ids, amounts, status, receipt and notes mapped; empty notes array becomes {}', refs.count === 2 && refs.items[0].notes.attempt_id === 'att-1' && refs.items[0].receipt === 'att-1' && JSON.stringify(refs.items[1].notes) === '{}');
  const miss = await guard(() => real.payments.fetch('pay_missing'));
  check('B5 a 400 from the provider keeps its code and description, and is "not performed, do not retry"', !miss.ok && miss.e.status === 400 && miss.e.code === 'BAD_REQUEST_ERROR' && /does not exist/.test(miss.e.description) && miss.e.retryable === false && miss.e.outcomeUnknown === false);

  // refund request shape + identical retries
  seen.length = 0;
  const KEYB = 'vq-rf-real-0000-0000-0000-000000000010-1';
  const a = await real.payments.refundIdempotent('pay_new', { amount: 4200, receipt: 'att-10', notes: { b_second: 2, a_first: 'x' } }, KEYB);
  const b = await real.payments.refundIdempotent('pay_new', { notes: { a_first: 'x', b_second: 2 }, receipt: 'att-10', amount: 4200 }, KEYB);
  check('B6 refund POST: right path, JSON content type, and the X-Refund-Idempotency header carries our key',
    seen.length === 2 && seen[0].method === 'POST' && seen[0].url === '/v1/payments/pay_new/refund' && seen[0].headers['x-refund-idempotency'] === KEYB && /application\/json/.test(String(seen[0].headers['content-type'])) && a.id === 'rfnd_new');
  check('B7 retries send BYTE-IDENTICAL bodies even when the caller builds the object in a different property order',
    seen[0].body === seen[1].body && seen[0].body === '{"amount":4200,"receipt":"att-10","notes":{"a_first":"x","b_second":2}}' && b.amount === 4200, seen[0].body);
  check('B8 canonicalRefundBody is deterministic and only emits the fields given', canonicalRefundBody({ amount: 100 }) === '{"amount":100}' && canonicalRefundBody({ amount: 100, speed: 'normal' }) === '{"amount":100,"speed":"normal"}');

  // no automatic retries, classification
  seen.length = 0;
  const e500 = await guard(() => real.payments.refundIdempotent('pay_5xx', { amount: 100 }, 'vq-rf-real-0000-0000-0000-000000000011-1'));
  check('B9 a 5xx is classified retryable with an UNKNOWN outcome, and exactly ONE request was made (no automatic retry)', !e500.ok && e500.e.status === 500 && e500.e.retryable && e500.e.outcomeUnknown && e500.e.kind === 'http' && seen.length === 1);
  seen.length = 0;
  const t0 = Date.now();
  const eSlow = await guard(() => real.payments.refundIdempotent('pay_slow', { amount: 100 }, 'vq-rf-real-0000-0000-0000-000000000012-1'));
  check('B10 a provider that answers too late times out at the configured deadline (~1 s): kind timeout, outcome unknown, one request only',
    !eSlow.ok && eSlow.e.kind === 'timeout' && eSlow.e.outcomeUnknown && eSlow.e.retryable && Date.now() - t0 < 2000 && seen.length === 1, `${Date.now() - t0} ms`);
  const eConf = await guard(() => real.payments.refundIdempotent('pay_conflict', { amount: 100 }, 'vq-rf-real-0000-0000-0000-000000000013-1'));
  const eProg = await guard(() => real.payments.refundIdempotent('pay_inprog', { amount: 100 }, 'vq-rf-real-0000-0000-0000-000000000014-1'));
  check('B11 409 "different request" = idempotency conflict (never retry); other 409 = in progress (retry later, same key, outcome unknown)',
    !eConf.ok && eConf.e.idempotencyConflict && !eConf.e.retryable && !eConf.e.inProgress && !eProg.ok && eProg.e.inProgress && eProg.e.retryable && eProg.e.outcomeUnknown && !eProg.e.idempotencyConflict);
  const e400 = await guard(() => real.payments.refundIdempotent('pay_400', { amount: 100 }, 'vq-rf-real-0000-0000-0000-000000000015-1'));
  check('B12 a refund rejected with 400 is a KNOWN failure: nothing happened, not retryable', !e400.ok && e400.e.status === 400 && !e400.e.outcomeUnknown && !e400.e.retryable);
  const eGarb = await guard(() => real.payments.refundIdempotent('pay_garbage', { amount: 100 }, 'vq-rf-real-0000-0000-0000-000000000016-1'));
  check('B13 a 200 that is not JSON is invalid_response with an unknown outcome (reconcile, do not assume)', !eGarb.ok && eGarb.e.kind === 'invalid_response' && eGarb.e.outcomeUnknown);

  // local refusals send nothing
  seen.length = 0;
  const bad = [
    await guard(() => real.payments.refundIdempotent('pay_ok', { amount: 100 }, 'short')),
    await guard(() => real.payments.refundIdempotent('pay_ok', { amount: 100 }, 'has space and !! chars')),
    await guard(() => real.payments.refundIdempotent('pay_ok', { amount: 0 }, 'vq-rf-real-0000-0000-0000-000000000017-1')),
    await guard(() => real.payments.refundIdempotent('pay_ok', { amount: 1.5 }, 'vq-rf-real-0000-0000-0000-000000000018-1')),
    await guard(() => real.payments.refundIdempotent('../../etc/passwd', { amount: 100 }, 'vq-rf-real-0000-0000-0000-000000000019-1')),
    await guard(() => real.payments.fetch('pay?x=1&y=2')),
    await guard(() => real.orders.fetchPayments('')),
    await guard(() => real.payments.refundIdempotent('pay_ok', { amount: 100, speed: 'fast' as any }, 'vq-rf-real-0000-0000-0000-000000000020-1')),
    await guard(() => real.payments.refundIdempotent('pay_ok', { amount: 100, notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) }, 'vq-rf-real-0000-0000-0000-000000000021-1')),
  ];
  check('B14 a bad key, amount, speed, note count or id is refused locally (invalid_request) and NOTHING is sent', bad.every((x) => !x.ok && x.e.kind === 'invalid_request') && seen.length === 0, String(bad.filter((x) => x.ok).length));

  const red = await guard(() => (async () => { const cfg = (await import('../src/config')).default; const base = cfg.razorpayApiBase; (cfg as any).razorpayApiBase = base + '/redirect-me'; try { return await real.payments.fetch('pay_pii'); } finally { (cfg as any).razorpayApiBase = base; } })());
  check('B15 redirects are never followed (credentials cannot be forwarded to another host)', !red.ok && red.e.kind === 'network');

  for (const k of ['log', 'warn', 'error', 'info'] as const) (console as any)[k] = origs[k];
  const everything = JSON.stringify(errors.map((e) => ({ m: e.message, k: e.kind, c: e.code, d: e.description, s: e.status, stack: String(e.stack) }))) + logs.join('\n');
  const authB64 = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  check('B16 no secret appears in any error (message, fields, stack) or in anything logged: key id, key secret, Basic header',
    errors.length >= 8 && !everything.includes(KEY_SECRET) && !everything.includes(KEY_ID) && !everything.includes(authB64) && !/Basic /.test(everything), `${errors.length} errors checked`);

  // ============================================================================================ PART C: configuration
  out('--- Part C: configuration');
  const probe = (env: Record<string, string>) => {
    const code = `try { const c = require('./src/config'); c.assertSecureConfig(); console.log(JSON.stringify({ ok: true, t: c.default.razorpayTimeoutMs, iv: c.default.paymentRecoveryIntervalMs, rec: c.default.paymentRecoveryEnabled, base: c.default.razorpayApiBase, ws: !!c.default.razorpayWebhookSecret, wsp: !!c.default.razorpayWebhookSecretPrevious, legacy: !!c.default.legacyVerifyUntil })); } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`;
    const cleanEnv: Record<string, string> = { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'development', DB_HOST: 'localhost', DB_USER: 'u', DB_NAME: 'n' };
    const txt = execFileSync(process.execPath, ['--require', 'tsx/cjs', '-e', code], { cwd: path.resolve(__dirname, '..'), env: { ...cleanEnv, ...env } }).toString().trim().split('\n').pop() as string;
    return JSON.parse(txt);
  };
  const T0 = '2026-03-01T10:00:00Z';
  const d = probe({});
  check('C1 defaults: valid, API base https://api.razorpay.com, timeout 10 s, recovery OFF, no webhook secrets, legacy bridge OFF',
    d.ok && d.base === 'https://api.razorpay.com' && d.t === 10000 && d.rec === false && d.ws === false && d.wsp === false && d.legacy === false, JSON.stringify(d));
  check('C2 legacy window of exactly 24 h is accepted', probe({ INTENTS_ENABLED_AT: T0, LEGACY_VERIFY_UNTIL: '2026-03-02T10:00:00Z' }).ok === true);
  check('C3 a window longer than 24 h is refused at startup', probe({ INTENTS_ENABLED_AT: T0, LEGACY_VERIFY_UNTIL: '2026-03-02T10:00:01Z' }).ok === false);
  check('C4 LEGACY_VERIFY_UNTIL without INTENTS_ENABLED_AT is refused', probe({ LEGACY_VERIFY_UNTIL: '2026-03-02T10:00:00Z' }).ok === false);
  check('C5 a window that ends before it starts is refused', probe({ INTENTS_ENABLED_AT: T0, LEGACY_VERIFY_UNTIL: '2026-03-01T09:00:00Z' }).ok === false);
  check('C6 an unparseable date is an error, not "disabled"', probe({ INTENTS_ENABLED_AT: 'tomorrow-ish' }).ok === false);
  check('C7 INTENTS_ENABLED_AT alone does not enable the bridge', probe({ INTENTS_ENABLED_AT: T0 }).legacy === false);
  check('C8 production refuses a non-https Razorpay API base; development allows the local stub', probe({ NODE_ENV: 'production', RAZORPAY_API_BASE: 'http://127.0.0.1:9' }).ok === false && probe({ RAZORPAY_API_BASE: 'http://127.0.0.1:9' }).ok === true);
  check('C9 a malformed API base is refused', probe({ RAZORPAY_API_BASE: 'api.razorpay.com/v1' }).ok === false && probe({ RAZORPAY_API_BASE: 'https://api.razorpay.com/' }).base === 'https://api.razorpay.com');
  check('C10 timeout and recovery interval are clamped (5 -> 1000 ms, 999999 -> 60000 ms, 1 -> 15 s)', probe({ RAZORPAY_TIMEOUT_MS: '5' }).t === 1000 && probe({ RAZORPAY_TIMEOUT_MS: '999999' }).t === 60000 && probe({ PAYMENT_RECOVERY_INTERVAL_MS: '1' }).iv === 15000);
  check('C11 recovery is on only for the exact value "true"; webhook secrets are read', probe({ PAYMENT_RECOVERY_ENABLED: 'yes' }).rec === false && probe({ PAYMENT_RECOVERY_ENABLED: 'true', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's' }).rec === true && probe({ RAZORPAY_WEBHOOK_SECRET: 'current-secret', RAZORPAY_WEBHOOK_SECRET_PREVIOUS: 'previous-secret' }).wsp === true);   // (Phase 2 start-up rules: recovery needs the API keys; webhook secrets need 8+ characters)

  stub.close();
  const failed = results.filter((x) => !x.ok);
  out(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { process.stdout.write('TEST CRASHED: ' + (e?.stack || e) + '\n'); process.exit(2); });
