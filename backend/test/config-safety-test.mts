// TEST ONLY - start-up configuration safety: the opt-in test-mode guard and trusted-proxy / client-IP handling.
// No database is used and nothing contacts Razorpay: configuration is probed in child processes (config is read once at import),
// and the proxy tests start the real app in a child on an ephemeral port and only send requests that are refused BEFORE any
// database work (bad webhook signature, missing payment details).
//   npx tsx test/config-safety-test.mts
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results: { name: string; ok: boolean }[] = [];
const out = (s: string) => process.stdout.write(s + '\n');
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok }); out(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 200) : ''}`); };
const section = (s: string) => out(`\n=== ${s}`);
const uniq = () => crypto.randomBytes(4).toString('hex');

/** A clean environment: nothing from the developer's shell or .env can leak into a probe. */
const baseEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
  NODE_ENV: 'development', JWT_SECRET: 'j'.repeat(40), DB_HOST: 'localhost', DB_USER: 'nobody', DB_PASSWORD: 'x', DB_SSL: 'false', DB_NAME: 'vediqra_test_cfgprobe',
  ...extra,
});

// ------------------------------------------------------------------------------------------------ config probes
const probeFile = path.join(os.tmpdir(), `cfg-probe-${uniq()}.cjs`);
fs.writeFileSync(probeFile, `try { const c = require(${JSON.stringify(path.join(BACKEND, 'src', 'config'))}); c.assertSecureConfig(); console.log('CONFIG_OK trust=' + JSON.stringify(c.default.trustProxy) + ' host=' + c.default.listenHost); } catch (e) { console.log('CONFIG_ERR ' + e.message); }`);
const probe = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', probeFile], { cwd: BACKEND, env: baseEnv(env), encoding: 'utf8' });
  return ((r.stdout || '') + (r.stderr || '')).trim();
};
const ok = (t: string) => /CONFIG_OK/.test(t);
const err = (t: string) => /CONFIG_ERR/.test(t);

section('1. Test-mode guard (opt-in)');
{
  const LIVE = 'rzp_live_ABCDEFGH12345678';
  const TEST = 'rzp_test_ABCDEFGH12345678';
  check('G1 guard OFF (default): a live-prefixed key and DB_NAME=vediqra are NOT touched - ordinary deployments behave as before',
    ok(probe({ RAZORPAY_KEY_ID: LIVE, RAZORPAY_KEY_SECRET: 's', DB_NAME: 'vediqra' })) && ok(probe({ PAYMENT_TEST_MODE_GUARD: 'false', RAZORPAY_KEY_ID: LIVE, RAZORPAY_KEY_SECRET: 's', DB_NAME: 'vediqra' })));
  const good = { PAYMENT_TEST_MODE_GUARD: 'true', RAZORPAY_KEY_ID: TEST, RAZORPAY_KEY_SECRET: 's', DB_NAME: 'vediqra_test_exercise1' };
  check('G2 guard ON with a rzp_test_ key and a vediqra_test_* database: accepted', ok(probe(good)));
  const live = probe({ ...good, RAZORPAY_KEY_ID: LIVE });
  check('G3 guard ON + live key (rzp_live_) is refused', err(live) && /TEST key/.test(live), live.slice(0, 120));
  check('G3 ...and the refusal does not echo the key', !live.includes(LIVE) && !live.includes('ABCDEFGH12345678'));
  check('G4 guard ON + DB_NAME=vediqra is refused', err(probe({ ...good, DB_NAME: 'vediqra' })));
  check('G4 ...even when "vediqra" is placed in the allowlist', err(probe({ ...good, DB_NAME: 'vediqra', TEST_MODE_ALLOWED_DB_NAMES: 'vediqra' })));
  check('G5 guard ON + missing key id is refused (fail closed)', err(probe({ ...good, RAZORPAY_KEY_ID: '' })));
  check('G5 guard ON + missing DB_NAME is refused', err(probe({ ...good, DB_NAME: '' })));
  check('G6 guard ON + a key that is not a test key at all (no rzp_ prefix, wrong case) is refused', err(probe({ ...good, RAZORPAY_KEY_ID: 'RZP_TEST_ABCDEFGH' })) && err(probe({ ...good, RAZORPAY_KEY_ID: 'key_test_abc' })));
  const badNames = ['vediqra_test_', 'vediqra_testing', 'vediqra-test-x', 'VEDIQRA_TEST_X', 'vediqra_test_a b', 'vediqra_prod', 'other', 'vediqra_test_x;drop'];
  check('G7 guard ON + invalid or look-alike database names are refused', badNames.every((n) => err(probe({ ...good, DB_NAME: n }))), badNames.filter((n) => !err(probe({ ...good, DB_NAME: n }))).join(','));
  check('G8 a database named in TEST_MODE_ALLOWED_DB_NAMES is accepted; one not listed is not', ok(probe({ ...good, DB_NAME: 'vediqra_staging_x', TEST_MODE_ALLOWED_DB_NAMES: 'a_b, vediqra_staging_x' })) && err(probe({ ...good, DB_NAME: 'vediqra_staging_y', TEST_MODE_ALLOWED_DB_NAMES: 'vediqra_staging_x' })));
  check('G9 an ambiguous guard value ("yes", "1", "TRUE") is refused instead of being read as off', ['yes', '1', 'TRUE', 'on'].every((v) => err(probe({ ...good, PAYMENT_TEST_MODE_GUARD: v }))));
  check('G10 NODE_ENV does not decide anything: development with a live key is refused when the guard is on, and production with a test setup is accepted by this guard', err(probe({ ...good, RAZORPAY_KEY_ID: LIVE, NODE_ENV: 'development' })) && !/test-mode guard/.test(probe({ ...good, NODE_ENV: 'production' })));

  // the migration wrapper applies the database rule before any connection is attempted
  const mig = (env: Record<string, string>) => spawnSync(process.execPath, [path.join(BACKEND, 'scripts', 'migrate.cjs'), 'up'], { cwd: BACKEND, env: baseEnv(env), encoding: 'utf8', timeout: 15000 });
  const m1 = mig({ PAYMENT_TEST_MODE_GUARD: 'true', DB_NAME: 'vediqra' });
  const m2 = mig({ PAYMENT_TEST_MODE_GUARD: 'maybe', DB_NAME: 'vediqra_test_x' });
  check('G11 `npm run migrate` refuses DB_NAME=vediqra (and an ambiguous guard value) with the guard on - before connecting; no password in the output',
    m1.status === 1 && /refused by PAYMENT_TEST_MODE_GUARD/.test(m1.stderr) && m2.status === 1 && !(m1.stdout + m1.stderr + m2.stdout + m2.stderr).includes('x@') && !/postgres:\/\//.test(m1.stdout + m1.stderr), (m1.stderr || '').slice(0, 100));
}

section('2. TRUST_PROXY parsing');
{
  const t = (v: string) => probe({ TRUST_PROXY: v });
  check('T1 unset / empty / 0 = trust nobody (the default)', /trust=0\b/.test(probe({})) && /trust=0\b/.test(t('')) && /trust=0\b/.test(t('0')));
  check('T2 hop counts 1-3 and the word loopback are accepted', /trust=1\b/.test(t('1')) && /trust=3\b/.test(t('3')) && /trust="loopback"/.test(t('loopback')));
  check('T3 explicit addresses / ranges are accepted', /trust="10.0.0.0\/8,loopback"/.test(t('10.0.0.0/8, loopback')) && ok(t('192.168.1.5')) && ok(t('fd00::/8')));
  check('T4 `true` (trust everyone), huge hop counts, wildcards and garbage are refused at start-up', ['true', '4', '99', '*', 'yes', 'loopback;rm', '1.2.3.4/'].every((v) => err(t(v))), ['true', '4', '99', '*', 'yes', 'loopback;rm', '1.2.3.4/'].filter((v) => !err(t(v))).join(','));
  check('T5 LISTEN_HOST is read (unset = all interfaces, unchanged)', /host=127.0.0.1/.test(probe({ LISTEN_HOST: '127.0.0.1' })) && /host=$/.test(probe({})));
}

// ------------------------------------------------------------------------------------------------ proxy behaviour
section('3. Client IP behind a proxy: the limiters use the intended address and cannot be evaded');
const childFile = path.join(os.tmpdir(), `proxy-child-${uniq()}.cjs`);
fs.writeFileSync(childFile, `
  const app = require(${JSON.stringify(path.join(BACKEND, 'src', 'app'))}).default;
  const s = app.listen(0, '127.0.0.1', () => console.log('PORT=' + s.address().port));
`);
async function withApp<T>(env: Record<string, string>, fn: (base: string) => Promise<T>): Promise<T> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', childFile], {
    cwd: BACKEND, stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv({ RAZORPAY_KEY_ID: 'rzp_test_proxyprobe', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'whsec_proxy_probe', RATE_LIMIT_WEBHOOK: '10', RATE_LIMIT_PAYMENTS: '10', PAYMENT_TEST_MODE_GUARD: 'true', ...env }),
  });
  let text = '';
  child.stdout!.on('data', (d) => { text += d; }); child.stderr!.on('data', (d) => { text += d; });
  const port: string = await new Promise((resolve, reject) => {
    const t = setInterval(() => { const m = /PORT=(\d+)/.exec(text); if (m) { clearInterval(t); resolve(m[1]); } }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error('child did not start: ' + text.slice(-300))); }, 30000);
  });
  try { return await fn(`http://127.0.0.1:${port}`); } finally { child.kill(); }
}
const hit = (base: string, route: 'webhook' | 'verify', xff?: string) => fetch(base + (route === 'webhook' ? '/api/payment/webhook' : '/api/payment/verify-payment'), {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(route === 'webhook' ? { 'X-Razorpay-Signature': 'ab'.repeat(32) } : {}), ...(xff ? { 'X-Forwarded-For': xff } : {}) }, body: '{}',
}).then((r) => r.status);
/** how many requests pass before the first 429 */
async function untilLimited(base: string, route: 'webhook' | 'verify', xffFor: (i: number) => string | undefined, max = 30) {
  for (let i = 0; i < max; i++) if ((await hit(base, route, xffFor(i))) === 429) return i;
  return -1;
}

// 3a. nginx on the same host, TRUST_PROXY=loopback: the forwarded address is believed (the peer is loopback)
await withApp({ TRUST_PROXY: 'loopback' }, async (base) => {
  const n1 = await untilLimited(base, 'webhook', () => '198.51.100.7');
  const other = await hit(base, 'webhook', '198.51.100.8');
  check('P1 behind a trusted proxy the webhook limiter counts per REAL client: client A is limited after 10 requests, client B is not affected', n1 === 10 && other === 400, `limited at ${n1}, other client got ${other}`);
});
await withApp({ TRUST_PROXY: 'loopback' }, async (base) => {
  const n = await untilLimited(base, 'verify', () => '198.51.100.20');
  const other = await hit(base, 'verify', '198.51.100.21');
  check('P2 the public payment limiter uses the same real client address', n === 10 && other === 400, `limited at ${n}, other ${other}`);
});
// 3b. a forged left-hand entry cannot evade the limit: the proxy-appended (rightmost) address is the one used
await withApp({ TRUST_PROXY: 'loopback' }, async (base) => {
  const n = await untilLimited(base, 'webhook', (i) => `203.0.113.${i + 1}, 198.51.100.30`);
  check('P3 a client that prepends fake addresses to X-Forwarded-For (proxy appends the real one) is still limited as ONE client', n === 10, `limited at ${n}`);
});
// 3c. nothing trusted: forwarded headers are ignored, so rotating them gains nothing
await withApp({ TRUST_PROXY: '0' }, async (base) => {
  const n = await untilLimited(base, 'webhook', (i) => `198.51.100.${i + 1}`);
  check('P4 TRUST_PROXY unset: a rotating X-Forwarded-For does not create new limit buckets', n === 10, `limited at ${n}`);
});
// 3d. the direct peer is NOT a trusted proxy (explicit list that excludes it): an untrusted caller cannot spoof
await withApp({ TRUST_PROXY: '10.0.0.0/8' }, async (base) => {
  const n = await untilLimited(base, 'webhook', (i) => `198.51.100.${i + 1}`);
  const v = await untilLimited(base, 'verify', (i) => `198.51.100.${100 + i}`);
  check('P5 an untrusted caller (peer outside the trusted list) cannot evade the webhook or payment limits by forging X-Forwarded-For', n === 10 && v === 10, `webhook ${n}, payment ${v}`);
});
// 3e. one hop count behaves the same for a single proxy
await withApp({ TRUST_PROXY: '1' }, async (base) => {
  const n1 = await untilLimited(base, 'webhook', () => '198.51.100.40');
  const other = await hit(base, 'webhook', '198.51.100.41');
  check('P6 TRUST_PROXY=1 (one hop) also separates real clients', n1 === 10 && other === 400, `${n1} / ${other}`);
});
// 3f. webhook semantics intact when limited
await withApp({ TRUST_PROXY: 'loopback' }, async (base) => {
  for (let i = 0; i < 10; i++) await hit(base, 'webhook', '198.51.100.50');
  const res = await fetch(base + '/api/payment/webhook', { method: 'POST', headers: { 'X-Razorpay-Signature': 'ab'.repeat(32), 'X-Forwarded-For': '198.51.100.50', 'Content-Type': 'application/json' }, body: '{}' });
  const body = await res.text();
  check('P7 a limited webhook caller gets 429 + Retry-After and an answer that reveals nothing; another client is still served normally', res.status === 429 && res.headers.get('retry-after') === '30' && !/ab{2}|secret|whsec/.test(body) && (await hit(base, 'webhook', '198.51.100.51')) === 400);
});
// 3g. the guard also protects the app start-up itself
{
  const child = spawnSync(process.execPath, ['--import', 'tsx', childFile], { cwd: BACKEND, env: baseEnv({ PAYMENT_TEST_MODE_GUARD: 'true', RAZORPAY_KEY_ID: 'rzp_live_notallowed1', RAZORPAY_KEY_SECRET: 's', DB_NAME: 'vediqra' }), encoding: 'utf8', timeout: 30000 });
  const text = (child.stdout || '') + (child.stderr || '');
  check('P8 the real app refuses to start (exits non-zero, never listens) when the guard is on and the key/database are not test ones, without printing the key', child.status !== 0 && !/PORT=\d+/.test(text) && /test-mode guard/.test(text) && !text.includes('rzp_live_notallowed1'), text.slice(0, 100));
}

fs.rmSync(probeFile, { force: true }); fs.rmSync(childFile, { force: true });
const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { out('FAILED:\n' + failed.map((f) => '  - ' + f.name).join('\n')); process.exit(1); }
process.exit(0);
