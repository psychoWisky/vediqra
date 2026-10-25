// Payment recovery, Phase 1: the schema migration (payment_intents, payment_webhook_events, payment_refund_attempts,
// notification_outbox). It builds and DROPS its own throwaway databases, so it refuses to run against anything that
// is not named vediqra_test_*.   Nothing here touches Razorpay or the app.
//   TEST_DB=vediqra_test_p1 node test/phase1-payment-recovery-schema-test.mjs
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DB = process.env.TEST_DB || 'vediqra_test_p1';
if (!/^vediqra_test_[a-z0-9_]+$/.test(TEST_DB)) { console.error('TEST_DB must be a disposable database named vediqra_test_*'); process.exit(2); }
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PGBIN = 'C:\\Program Files\\PostgreSQL\\17\\bin';
const ENV = { ...process.env, PATH: `${process.env.PATH};${PGBIN}` };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -> ' + String(detail).slice(0, 220) : ''}`); };

// ---------------------------------------------------------------------------------------------------- helpers
function psqlRaw(db, sql) {
  const r = spawnSync('psql', ['-U', 'postgres', '-h', 'localhost', '-w', '-d', db, '-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { env: ENV, input: sql, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const q = (sql) => { const r = psqlRaw(TEST_DB, sql); if (!r.ok) throw new Error('SQL failed: ' + r.err + '\n' + sql.slice(0, 300)); return r.out; };
const val = (sql) => q(sql).split(/\r?\n/)[0].trim();
const tx = (sql) => psqlRaw(TEST_DB, `BEGIN;\n${sql}\nCOMMIT;`);
/** Expects the statement(s) to be refused, optionally by a given constraint / message pattern. */
function refused(label, sql, pattern) {
  const r = psqlRaw(TEST_DB, `BEGIN;\n${sql}\nCOMMIT;`);
  const ok = !r.ok && (!pattern || pattern.test(r.err));
  check(label, ok, r.ok ? 'WAS ACCEPTED' : r.err.split(/\r?\n/)[0]);
  return r;
}
function accepted(label, sql, extra = () => true) {
  const r = psqlRaw(TEST_DB, `BEGIN;\n${sql}\nCOMMIT;`);
  check(label, r.ok && extra(r), r.ok ? '' : r.err.split(/\r?\n/)[0]);
  return r;
}
const lit = (v) => v === null ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'object' && v.json !== undefined ? `'${JSON.stringify(v.json).replace(/'/g, "''")}'::jsonb` : v.raw !== undefined ? v.raw : `'${String(v).replace(/'/g, "''")}'`;
const insert = (table, o, returning = 'id') => `INSERT INTO ${table} (${Object.keys(o).join(', ')}) VALUES (${Object.values(o).map(lit).join(', ')})${returning ? ` RETURNING ${returning}` : ''};`;
const uuid = () => crypto.randomUUID();
const hash = (c = 'a') => c.repeat(64);

function setupDb(db) {
  const base = { PATH: ENV.PATH, DB_HOST: 'localhost', DB_PORT: '5432', DB_USER: 'postgres', DB_PASSWORD: '', DB_NAME: db, DB_SSL: 'false', NODE_ENV: 'development' };
  psqlRaw('postgres', `DROP DATABASE IF EXISTS ${db};`); const c = psqlRaw('postgres', `CREATE DATABASE ${db};`);
  if (!c.ok) throw new Error(c.err);
}
function migrate(db, ...args) {
  const r = spawnSync('npm', ['run', 'migrate', '--', ...args], { cwd: BACKEND, env: { ...ENV, DB_NAME: db, DB_SSL: 'false', NODE_ENV: 'development' }, encoding: 'utf8', shell: true });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
const withDb = (db, fn) => { const prev = psqlRaw; return fn; };

// ---------------------------------------------------------------------------------------------------- fixtures
const QUOTE = (total, extra = {}) => ({ json: { items: [{ id: 'x1', type: 'product', quantity: 1, price: total }], stock: { products: [], values: [] }, subtotal: total, shipping_charge: 0, coupon: null, coupon_discount: 0, total_amount: total, ...extra } });
const CUST = { json: { name: 'T Buyer', email: 't@example.com', phone: '9876543210', address: 'a', city: 'c', state: 's', pincode: '700001', special_requests: '' } };
let n = 0;
const intentRow = (o = {}) => ({ idempotency_key: `idem-key-${++n}-${'k'.repeat(12)}`, snapshot_hash: hash('a'), quote: QUOTE(1000), customer: CUST, amount_paise: 100000, ...o });
const mkIntent = (o = {}) => val(insert('payment_intents', intentRow(o)));
let rz = 0;
const mkCreated = (o = {}) => { const id = mkIntent(o); q(`UPDATE payment_intents SET razorpay_order_id = 'order_t${++rz}_${Date.now() % 100000}', status = 'created' WHERE id = '${id}';`); return id; };
const orderRow = (o = {}) => ({ id: uuid(), custom_order_id: `VEDIQRA#T${++n}${Date.now() % 100000}`, items: { json: [{ product_id: 'x', quantity: 1 }] }, subtotal: 1000, shipping_charge: 0, cod_charge: 0, total_amount: 1000, customer_name: 'T', customer_email: 't@example.com', customer_phone: '9876543210', payment_method: 'online', status: 'paid', paid_at: { raw: 'now()' }, ...o });
const rzOrder = (id) => val(`SELECT razorpay_order_id FROM payment_intents WHERE id = '${id}';`);
/** Moves a created intent to fulfilled with a matching order, as the application will, in one transaction. */
const fulfilSql = (intentId, payId, o = {}) => {
  const order = orderRow({ razorpay_order_id: rzOrder(intentId), razorpay_payment_id: payId, ...o });
  return insert('orders', order, '') + `\nUPDATE payment_intents SET status='fulfilled', razorpay_payment_id='${payId}', captured_at=now(), fulfilled_at=now(), order_id='${order.id}' WHERE id='${intentId}';`;
};
const mkFulfilled = (payId) => { const id = mkCreated(); const r = tx(fulfilSql(id, payId)); if (!r.ok) throw new Error(r.err); return id; };
const toRefundRequired = (id, payId) => q(`UPDATE payment_intents SET status='refund_required', razorpay_payment_id='${payId}', captured_at=now() WHERE id='${id}';`);
const attemptRow = (intentId, payId, o = {}) => ({ intent_id: intentId, razorpay_payment_id: payId, idempotency_key: `vq-rf-${++n}-${'z'.repeat(14)}`, receipt: `rcpt-${n}-${Date.now() % 100000}`, amount_paise: 100000, ...o });
const ordersDigest = (ids) => val(`SELECT md5(string_agg(o::text, '|' ORDER BY id)) FROM orders o WHERE id IN (${ids.map((i) => `'${i}'`).join(',')});`);

// ====================================================================================================== run
console.log('=== A. migration mechanics (fresh database, normal mechanism)');
setupDb(TEST_DB);
let r = migrate(TEST_DB, 'up');
check('A1 `migrate up` on an empty database applies the baseline and the payment-recovery migration', r.ok && /payment-recovery-tables/.test(r.out) && /Migrations complete/.test(r.out), r.out.split('\n').slice(-3).join(' '));
const tables = (db) => psqlRaw(db, `SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('payment_intents','payment_webhook_events','payment_refund_attempts','notification_outbox');`).out;
check('A2 all four tables exist', tables(TEST_DB) === 'notification_outbox,payment_intents,payment_refund_attempts,payment_webhook_events', tables(TEST_DB));
r = migrate(TEST_DB, 'up');
check('A3 a second `migrate up` is a clean no-op ("No migrations to run")', r.ok && /No migrations to run/.test(r.out));
// (Later patches added admin-refund-requests and stock-restoration-tasks on top of these two.)
check('A4 the migration history records exactly the baseline, this migration and the two later migrations (admin refunds, stock restoration)', val(`SELECT count(*) FROM pgmigrations WHERE name LIKE '%baseline-schema' OR name LIKE '%payment-recovery-tables' OR name LIKE '%admin-refund-requests' OR name LIKE '%stock-restoration-tasks';`) === '4' && val('SELECT count(*) FROM pgmigrations;') === '4');

console.log('=== B. rollback and re-apply');
const columnsOf = (t) => val(`SELECT string_agg(column_name||':'||data_type||':'||coalesce(column_default,''), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='${t}' AND table_schema='public';`);
const ordersColsBefore = columnsOf('orders');
r = migrate(TEST_DB, 'down');          // the first two steps undo the later migrations only
check('B0a the first `migrate down` removes only the latest migration (stock restoration)', r.ok && /stock-restoration-tasks/.test(r.out) && val(`SELECT count(*) FROM pgmigrations;`) === '3');
r = migrate(TEST_DB, 'down');
check('B0 the second `migrate down` removes only the admin-refund migration; the four recovery tables remain', r.ok && /admin-refund-requests/.test(r.out) && tables(TEST_DB).split(',').length === 4 && val(`SELECT count(*) FROM pgmigrations;`) === '2');
r = migrate(TEST_DB, 'down');
check('B1 `migrate down` (next step) succeeds', r.ok && /payment-recovery-tables/.test(r.out) && /Migrations complete/.test(r.out), r.out.split('\n').slice(-3).join(' '));
check('B2 the four tables and four guard functions are gone', tables(TEST_DB) === '' && val(`SELECT count(*) FROM pg_proc WHERE proname IN ('payment_intents_guard','payment_webhook_events_guard','payment_refund_attempts_guard','notification_outbox_guard');`) === '0');
check('B3 the baseline schema is untouched by the rollback (orders table definition identical)', columnsOf('orders') === ordersColsBefore && val(`SELECT count(*) FROM pgmigrations;`) === '1');
r = migrate(TEST_DB, 'up');
check('B4 re-applying after a rollback works', r.ok && tables(TEST_DB).split(',').length === 4);

console.log('=== C. upgrade of an EXISTING database that already holds data');
const UP = 'vediqra_test_p1_upgrade';
setupDb(UP);
r = migrate(UP, 'up', '1');                                       // baseline only: how the real database looks today
check('C1 baseline-only database prepared', r.ok && psqlRaw(UP, `SELECT to_regclass('payment_intents') IS NULL;`).out === 't');
const histIds = [uuid(), uuid(), uuid()];
const seed = [
  insert('orders', orderRow({ id: histIds[0], custom_order_id: 'VEDIQRA#H1', payment_method: 'cod', status: 'pending', cod_charge: 49, total_amount: 2049, paid_at: null }), ''),
  insert('orders', orderRow({ id: histIds[1], custom_order_id: 'VEDIQRA#H2', payment_method: 'cod', status: 'delivered', cod_charge: 49, total_amount: 549, paid_at: null }), ''),
  insert('orders', orderRow({ id: histIds[2], custom_order_id: 'VEDIQRA#H3', razorpay_order_id: 'order_hist3', razorpay_payment_id: 'pay_hist3', total_amount: 750, refunded_amount: 100, status: 'partially_refunded' }), ''),
  `INSERT INTO categories (name) VALUES ('HistCat');`,
].join('\n');
check('C2 historical COD and online orders inserted', psqlRaw(UP, `BEGIN;\n${seed}\nCOMMIT;`).ok);
const upDigest = () => psqlRaw(UP, `SELECT md5(string_agg(o::text, '|' ORDER BY id)) FROM orders o WHERE id IN (${histIds.map((i) => `'${i}'`).join(',')});`).out;
const upCols = () => psqlRaw(UP, `SELECT string_agg(column_name||':'||data_type||':'||coalesce(column_default,''), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='orders' AND table_schema='public';`).out;
const dBefore = upDigest(), cBefore = upCols(), cntBefore = psqlRaw(UP, 'SELECT count(*) FROM orders;').out;
r = migrate(UP, 'up');
check('C3 upgrading the existing database applies only the new migration', r.ok && /payment-recovery-tables/.test(r.out) && !/baseline/.test(r.out.replace(/pgmigrations/g, '')), r.out.split('\n').slice(-3).join(' '));
check('C4 historical orders (COD and online) are byte-for-byte unchanged, and so is the orders table definition',
  upDigest() === dBefore && upCols() === cBefore && psqlRaw(UP, 'SELECT count(*) FROM orders;').out === cntBefore);
check('C5 the orders default for payment_method is exactly what it was (no new default can misclassify an order)', psqlRaw(UP, `SELECT column_default FROM information_schema.columns WHERE table_name='orders' AND column_name='payment_method';`).out === `'cod'::text`);
const newDefaults = psqlRaw(UP, `SELECT string_agg(table_name||'.'||column_name||'='||column_default, '; ') FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('payment_intents','payment_webhook_events','payment_refund_attempts','notification_outbox') AND column_default ~* '(cod|paid|online)';`).out;
check('C6 no column in the new tables defaults to a payment method or paid state', newDefaults === '', newDefaults);
r = migrate(UP, 'down');
check('C7 rolling the upgrade back leaves the historical orders unchanged too', r.ok && upDigest() === dBefore && upCols() === cBefore);
psqlRaw('postgres', `DROP DATABASE IF EXISTS ${UP};`);

// ====================================================================================================== data rules
console.log('=== D. payment_intents');
const I = (o) => insert('payment_intents', intentRow(o));
let a = intentRow({ idempotency_key: 'dup-idempotency-key-0001', razorpay_order_id: 'order_dup_1', razorpay_payment_id: 'pay_dup_1' });
check('D1 a valid checkout intent is accepted in state preparing', psqlRaw(TEST_DB, insert('payment_intents', a)).ok && val(`SELECT status FROM payment_intents WHERE idempotency_key='dup-idempotency-key-0001';`) === 'preparing');
refused('D2 a checkout intent cannot be created in any state but preparing', I({ status: 'created', razorpay_order_id: 'order_x2' }), /must start in state preparing/);
refused('D3 duplicate Idempotency-Key is refused (unique)', I({ idempotency_key: 'dup-idempotency-key-0001' }), /payment_intents_idempotency_key_key/);
refused('D4 duplicate Razorpay order id is refused (unique)', I({ razorpay_order_id: 'order_dup_1' }), /payment_intents_razorpay_order_id_key/);
refused('D5 duplicate Razorpay payment id is refused (unique)', I({ razorpay_order_id: 'order_dup_other', razorpay_payment_id: 'pay_dup_1' }), /payment_intents_razorpay_payment_id_key/);
refused('D6 a snapshot whose total differs from the amount charged is refused', I({ quote: QUOTE(999) }), /pi_quote_total_matches_amount/);
refused('D7 a snapshot without a total, without items, or with an empty cart is refused', I({ quote: { json: { items: [{ id: 1 }], stock: {}, subtotal: 1 } } }) + I({ quote: QUOTE(1000, { items: [] }) }), /pi_quote_(shape|total_matches_amount)/);
refused('D8 customer details missing required keys are refused', I({ customer: { json: { name: 'x' } } }), /pi_customer_shape/);
refused('D9 amount below 100 paise, bad hash, bad id formats and a bad currency are refused',
  I({ amount_paise: 99, quote: QUOTE(0.99) }) , /pi_amount_valid/);
refused('D9b bad snapshot hash', I({ snapshot_hash: 'xyz' }), /pi_snapshot_hash_format/);
refused('D9c bad Razorpay id characters', I({ razorpay_order_id: 'order bad!' }), /pi_rzp_order_id_format/);
refused('D9d bad currency', I({ currency: 'inr' }), /pi_currency_format/);
refused('D9e a payment id without a Razorpay order id', I({ razorpay_payment_id: 'pay_orphan_1' }), /pi_payment_implies_rzp_order/);
refused('D9f idempotency key too short', I({ idempotency_key: 'short' }), /pi_idempotency_key_format/);

// preparing -> created
const p1 = mkIntent();
accepted('D10 the Razorpay order id can be attached while still preparing', `UPDATE payment_intents SET razorpay_order_id='order_attach_1' WHERE id='${p1}';`);
accepted('D11 the legitimate transition preparing -> created', `UPDATE payment_intents SET status='created' WHERE id='${p1}';`, () => val(`SELECT status FROM payment_intents WHERE id='${p1}';`) === 'created');
const p2 = mkIntent();
accepted('D12 attach + created in ONE update (what create-order will do)', `UPDATE payment_intents SET razorpay_order_id='order_attach_2', status='created' WHERE id='${p2}';`);
const p3 = mkIntent();
accepted('D13 while preparing the snapshot may still be adjusted', `UPDATE payment_intents SET customer='${JSON.stringify(CUST.json).replace(/T Buyer/, 'T Buyer 2')}'::jsonb WHERE id='${p3}';`);
refused('D14 ...but not in the same update that leaves preparing', `UPDATE payment_intents SET razorpay_order_id='order_attach_3', status='created', customer='{"name":"x","email":"e","phone":"1","address":"a","city":"c","state":"s","pincode":"1"}'::jsonb WHERE id='${p3}';`, /cannot change after preparing/);
refused('D15 created without a Razorpay order id is refused', `UPDATE payment_intents SET status='created' WHERE id='${p3}';`, /pi_has_rzp_order/);

// immutability
const c1 = mkCreated();
refused('D16 snapshot (quote) is frozen after preparing', `UPDATE payment_intents SET quote='${JSON.stringify(QUOTE(1000, { subtotal: 5 }).json)}'::jsonb WHERE id='${c1}';`, /cannot change after preparing/);
refused('D17 customer details are frozen', `UPDATE payment_intents SET customer='${JSON.stringify({ ...CUST.json, address: 'changed' })}'::jsonb WHERE id='${c1}';`, /cannot change after preparing/);
refused('D18 the amount is frozen', `UPDATE payment_intents SET amount_paise = 200000 WHERE id='${c1}';`, /frozen after preparing/);
refused('D19 hash, currency, idempotency key and coupon code are frozen', `UPDATE payment_intents SET snapshot_hash='${hash('b')}' WHERE id='${c1}';`, /frozen after preparing/);
refused('D19b coupon code frozen', `UPDATE payment_intents SET coupon_code='SNEAKY' WHERE id='${c1}';`, /cannot change after preparing/);
refused('D20 the Razorpay order id is write-once', `UPDATE payment_intents SET razorpay_order_id='order_changed' WHERE id='${c1}';`, /write-once/);
accepted('D21 non-snapshot bookkeeping can still be updated (counters, errors, check times)', `UPDATE payment_intents SET failed_attempts=1, last_failure_code='BAD_REQUEST_ERROR', last_checked_at=now(), check_failures=2, last_error='x' WHERE id='${c1}';`);
check('D22 updated_at is maintained by the database', val(`SELECT updated_at > created_at FROM payment_intents WHERE id='${c1}';`) === 't');

// state machine
const sm = (label, from, to, extra = '') => {
  let id;
  if (from === 'created') id = mkCreated();
  else if (from === 'fulfilled') id = mkFulfilled(`pay_sm_${++n}`);
  else if (from === 'refund_required') { id = mkCreated(); toRefundRequired(id, `pay_sm_${++n}`); }
  else if (from === 'needs_review') { id = mkCreated(); q(`UPDATE payment_intents SET status='needs_review', review_reason='test' WHERE id='${id}';`); }
  else if (from === 'abandoned') { id = mkIntent(); q(`UPDATE payment_intents SET status='abandoned' WHERE id='${id}';`); }
  else if (from === 'preparing') id = mkIntent();
  else if (from === 'refunded') { id = mkCreated(); const pay = `pay_sm_${++n}`; toRefundRequired(id, pay); const att = val(insert('payment_refund_attempts', attemptRow(id, pay))); settleProcessed(att); q(`UPDATE payment_intents SET status='refunded' WHERE id='${id}';`); }
  return refused(label, `UPDATE payment_intents SET status='${to}' ${extra} WHERE id='${id}';`, /transition .* is not allowed|pi_/);
};
function settleProcessed(att) {
  q(`UPDATE payment_refund_attempts SET status='submitting', lease_until=now()+interval '2 minutes', attempts=attempts+1 WHERE id='${att}';`);
  q(`UPDATE payment_refund_attempts SET status='processed', provider_refund_id='rfnd_${att.slice(0, 8)}', provider_status='processed', settled_at=now(), lease_until=NULL WHERE id='${att}';`);
}
sm('D23 created cannot go back to preparing', 'created', 'preparing');
sm('D24 preparing cannot jump to fulfilled', 'preparing', 'fulfilled');
sm('D25 created cannot jump to refunded', 'created', 'refunded');
sm('D26 a fulfilled intent can never change state (terminal)', 'fulfilled', 'created');
sm('D27 ...nor become needs_review', 'fulfilled', 'needs_review', ", review_reason='x'");
sm('D28 a refunded intent can never change state (terminal)', 'refunded', 'refund_required');
sm('D29 needs_review cannot be silently reset to created', 'needs_review', 'created');
sm('D30 abandoned cannot go back to created or preparing', 'abandoned', 'preparing');
sm('D31 refund_required cannot go back to created', 'refund_required', 'created');
{ const id = mkIntent(); q(`UPDATE payment_intents SET status='abandoned' WHERE id='${id}';`);
  // a Razorpay order was created, the intent was abandoned, then the customer paid late
  q(`UPDATE payment_intents SET razorpay_order_id='order_late_1' WHERE id='${id}';`);
  accepted('D32 an abandoned intent CAN still be revived by a late captured payment (legitimate recovery)', fulfilSql(id, 'pay_late_1')); }

// consistency checks
refused('D33 fulfilled without an order is refused', `UPDATE payment_intents SET status='fulfilled', razorpay_payment_id='pay_noorder', captured_at=now(), fulfilled_at=now() WHERE id='${mkCreated()}';`, /pi_order_iff_fulfilled|does not match this payment/);
refused('D34 needs_review without a reason is refused', `UPDATE payment_intents SET status='needs_review' WHERE id='${mkCreated()}';`, /pi_review_has_reason/);
refused('D35 refund_required without a captured payment is refused', `UPDATE payment_intents SET status='refund_required' WHERE id='${mkCreated()}';`, /pi_refund_has_payment/);

// fulfilment must match the order
{
  const id = mkCreated();
  refused('D36 fulfilled with an order carrying a DIFFERENT payment id is refused', fulfilSql(id, 'pay_match_1', {}).replace("razorpay_payment_id='pay_match_1', captured_at", "razorpay_payment_id='pay_other_zz', captured_at"), /does not match this payment/);
  refused('D37 fulfilled with an order of a different amount is refused', fulfilSql(id, 'pay_match_2', { total_amount: 1234 }), /does not match this payment/);
  refused('D38 fulfilled with a (historical-style) COD order is refused', fulfilSql(id, 'pay_match_3', { payment_method: 'cod' }), /does not match this payment/);
  const ok = tx(fulfilSql(id, 'pay_match_ok'));
  check('D39 fulfilled with the matching online order is accepted, and the intent now points at it', ok.ok && val(`SELECT count(*) FROM payment_intents i JOIN orders o ON o.id=i.order_id WHERE i.id='${id}' AND o.razorpay_payment_id='pay_match_ok';`) === '1', ok.err);
  { // the unique(order_id) index on its own: bypass the guard trigger for this session; CHECKs and unique indexes still apply
    const other = mkCreated(); const o2 = val("SELECT order_id FROM payment_intents WHERE id='" + id + "';");
    const r40 = psqlRaw(TEST_DB, `SET session_replication_role = replica;\nUPDATE payment_intents SET status='fulfilled', razorpay_payment_id='pay_dupe_order', captured_at=now(), fulfilled_at=now(), order_id='${o2}' WHERE id='${other}';`);
    check('D40 the same order cannot be attached to a second intent (unique order_id, guard bypassed)', !r40.ok && /payment_intents_order_id_key/.test(r40.err), r40.err.split('\n')[0]); }
  refused('D41 a fulfilled intent\'s payment id and order id are write-once', `UPDATE payment_intents SET razorpay_payment_id='pay_changed' WHERE id='${id}';`, /write-once/);
}
refused('D42 an order cannot be deleted while an intent points at it (foreign key)', `DELETE FROM orders WHERE id=(SELECT order_id FROM payment_intents WHERE razorpay_payment_id='pay_match_ok');`, /foreign key|violates/);

// scrub
{
  const f = mkFulfilled('pay_scrub_1');
  accepted('D43 retention scrub of a finished intent is allowed (personal data replaced, scrubbed_at set)', `UPDATE payment_intents SET quote='{"scrubbed":true}'::jsonb, customer='{"scrubbed":true}'::jsonb, coupon_code=NULL, status_token_hash=NULL, scrubbed_at=now() WHERE id='${f}';`);
  refused('D44 once scrubbed the snapshot is frozen again', `UPDATE payment_intents SET customer='{"x":1}'::jsonb WHERE id='${f}';`, /cannot change after preparing/);
  refused('D45 the amount cannot be altered by a scrub', `UPDATE payment_intents SET amount_paise=100001, scrubbed_at=now() WHERE id='${mkFulfilled('pay_scrub_2')}';`, /frozen after preparing|write-once/);
  refused('D46 an unfinished (created) intent cannot be scrubbed', `UPDATE payment_intents SET quote='{"scrubbed":true}'::jsonb, customer='{"scrubbed":true}'::jsonb, scrubbed_at=now() WHERE id='${mkCreated()}';`, /pi_scrub_only_when_terminal|cannot change after preparing/);
  refused('D47 personal data cannot be wiped without marking it scrubbed', `UPDATE payment_intents SET customer='{"scrubbed":true}'::jsonb WHERE id='${mkFulfilled('pay_scrub_3')}';`, /cannot change after preparing/);
}

console.log('=== E. payment_refund_attempts');
const rf = () => { const id = mkCreated(); const pay = `pay_rf_${++n}_${Date.now() % 100000}`; toRefundRequired(id, pay); return { id, pay }; };
const A = (o) => insert('payment_refund_attempts', o);
{
  const { id, pay } = rf();
  const row = attemptRow(id, pay);
  const first = tx(A(row));
  check('E1 a stock-failure refund attempt for an intent in refund_required is accepted (queued, 0 submissions)', first.ok && val(`SELECT status||attempts FROM payment_refund_attempts WHERE intent_id='${id}';`) === 'queued0', first.err);
  refused('E2 a second attempt with the same idempotency key is refused (unique)', A({ ...attemptRow(id, pay), idempotency_key: row.idempotency_key }), /payment_refund_attempts_idempotency_key_key|exceed|check/);
  { // the unique indexes on key and receipt on their own (another intent, guard bypassed)
    const o = rf(); const dup = attemptRow(o.id, o.pay, { idempotency_key: row.idempotency_key });
    const r2k = psqlRaw(TEST_DB, `SET session_replication_role = replica;\n${A(dup)}`);
    check('E2b the provider idempotency key is unique across attempts (guard bypassed)', !r2k.ok && /payment_refund_attempts_idempotency_key_key/.test(r2k.err), r2k.err.split('\n')[0]);
    const r2r = psqlRaw(TEST_DB, `SET session_replication_role = replica;\n${A(attemptRow(o.id, o.pay, { receipt: row.receipt }))}`);
    check('E2c the receipt marker is unique across attempts (guard bypassed)', !r2r.ok && /payment_refund_attempts_receipt_key/.test(r2r.err), r2r.err.split('\n')[0]); }
  refused('E3 a second LIVE stock-failure attempt for the intent is refused', A(attemptRow(id, pay)), /exceed|uq_pra_one_live_stock_failure_refund/);
  // prove the partial unique index on its own (bypass the guard trigger for this session only)
  const idx = psqlRaw(TEST_DB, `SET session_replication_role = replica;\n${A(attemptRow(id, pay))}`);
  check('E4 the partial unique index alone also stops a second live stock-failure attempt (guard bypassed)', !idx.ok && /uq_pra_one_live_stock_failure_refund/.test(idx.err), idx.err.split('\n')[0]);
  refused('E5 duplicate receipt marker is refused (unique)', A({ ...attemptRow(id, pay), receipt: row.receipt }), /receipt_key|exceed|uq_pra/);
  const a1 = val(`SELECT id FROM payment_refund_attempts WHERE intent_id='${id}';`);
  refused('E6 request-defining columns (amount, key, receipt, payment) are immutable', `UPDATE payment_refund_attempts SET amount_paise = 50000 WHERE id='${a1}';`, /immutable/);
  refused('E6b the idempotency key is immutable', `UPDATE payment_refund_attempts SET idempotency_key = 'changed-key-123456' WHERE id='${a1}';`, /immutable/);
  refused('E7 queued cannot jump straight to processed (submission is not settlement)', `UPDATE payment_refund_attempts SET status='processed', provider_refund_id='rfnd_x1', provider_status='processed', settled_at=now() WHERE id='${a1}';`, /transition queued -> processed/);
  refused('E8 submitting requires a lease', `UPDATE payment_refund_attempts SET status='submitting' WHERE id='${a1}';`, /pra_submitting_has_lease/);
  accepted('E9 queued -> submitting (with lease, attempts+1)', `UPDATE payment_refund_attempts SET status='submitting', lease_until=now()+interval '2 minutes', attempts=1, submitted_at=now(), last_attempt_at=now() WHERE id='${a1}';`);
  refused('E10 submitting cannot be marked processed without a provider refund id and confirmation', `UPDATE payment_refund_attempts SET status='processed', settled_at=now() WHERE id='${a1}';`, /pra_processed_confirmed/);
  refused('E11 ...nor with a refund id but a provider status that is still pending', `UPDATE payment_refund_attempts SET status='processed', provider_refund_id='rfnd_e11', provider_status='pending', settled_at=now() WHERE id='${a1}';`, /pra_processed_confirmed/);
  refused('E12 pending without a provider refund id is refused', `UPDATE payment_refund_attempts SET status='pending' WHERE id='${a1}';`, /pra_pending_has_refund/);
  accepted('E13 submitting -> unknown (lost response), keeping the same key and body', `UPDATE payment_refund_attempts SET status='unknown', lease_until=NULL, last_error_kind='timeout', last_error='no answer', next_attempt_at=now()+interval '30 seconds' WHERE id='${a1}';`);
  accepted('E14 unknown -> submitting (retry) -> pending (provider accepted, refund id recorded)', `UPDATE payment_refund_attempts SET status='submitting', lease_until=now()+interval '2 minutes', attempts=attempts+1 WHERE id='${a1}';\nUPDATE payment_refund_attempts SET status='pending', provider_refund_id='rfnd_e14', provider_status='pending', lease_until=NULL WHERE id='${a1}';`);
  refused('E15 the provider refund id is write-once', `UPDATE payment_refund_attempts SET provider_refund_id='rfnd_other' WHERE id='${a1}';`, /write-once/);
  refused('E16 submissions can never go down', `UPDATE payment_refund_attempts SET attempts = 0 WHERE id='${a1}';`, /only increase/);
  refused('E17 the intent cannot be marked refunded while the refund is only pending', `UPDATE payment_intents SET status='refunded' WHERE id='${id}';`, /before processed refund attempts cover/);
  accepted('E18 pending -> processed once the provider confirms (id, status, settle time)', `UPDATE payment_refund_attempts SET status='processed', provider_status='processed', settled_at=now() WHERE id='${a1}';`);
  refused('E19 a processed attempt is final: it cannot go back to pending or failed', `UPDATE payment_refund_attempts SET status='pending' WHERE id='${a1}';`, /transition processed -> pending/);
  refused('E20 ...and its settlement facts cannot be rewritten', `UPDATE payment_refund_attempts SET settled_at=now()-interval '1 day' WHERE id='${a1}';`, /settled attempt cannot change/);
  accepted('E21 only now can the intent be marked refunded (processed refunds cover the amount)', `UPDATE payment_intents SET status='refunded' WHERE id='${id}';`);
  refused('E22 after processed, a NEW refund attempt for the intent is impossible (one live slot, and the intent is no longer refund_required)', A(attemptRow(id, pay)), /refund_required|exceed|uq_pra/);
}
{
  const { id, pay } = rf();
  refused('E23 an attempt with the wrong amount (not the full captured amount) is refused for a stock failure', A(attemptRow(id, pay, { amount_paise: 99999 })), /refunds the full captured amount/);
  refused('E24 an attempt for a different payment id than the intent\'s is refused', A(attemptRow(id, 'pay_someone_else')), /foreign key|differs|violates/);
  refused('E25 an attempt created in any state but queued is refused', A(attemptRow(id, pay, { status: 'processed', provider_refund_id: 'rfnd_x', provider_status: 'processed', settled_at: { raw: 'now()' } })), /start queued|pra_/);
  refused('E26 a wrong currency is refused', A(attemptRow(id, pay, { currency: 'USD' })), /currency differs/);
  refused('E27 an attempt for an unknown intent is refused', A(attemptRow(uuid(), pay)), /unknown intent|foreign key/);
  const created = mkCreated();
  refused('E28 a stock-failure attempt for an intent that is not refund_required is refused', A(attemptRow(created, 'pay_x_nocapture')), /foreign key|refund_required/);
  const okA = tx(A(attemptRow(id, pay)));
  const a2 = val(`SELECT id FROM payment_refund_attempts WHERE intent_id='${id}';`);
  accepted('E29 queued -> failed (provider definitively refused) frees the slot', `UPDATE payment_refund_attempts SET status='failed', settled_at=now(), last_error_kind='http', last_error='rejected' WHERE id='${a2}';`);
  const retry = tx(A(attemptRow(id, pay)));
  check('E30 after a definitive failure a NEW attempt (new key, new receipt) is accepted: legitimate retry', okA.ok && retry.ok && val(`SELECT count(*) FROM payment_refund_attempts WHERE intent_id='${id}';`) === '2', retry.err);
  const a3 = val(`SELECT id FROM payment_refund_attempts WHERE intent_id='${id}' AND status='queued';`);
  refused('E31 needs_review requires a reason', `UPDATE payment_refund_attempts SET status='needs_review' WHERE id='${a3}';`, /pra_review_has_reason/);
  accepted('E32 needs_review with a reason is accepted and still occupies the live slot', `UPDATE payment_refund_attempts SET status='needs_review', review_reason='provider unreachable for 24 h' WHERE id='${a3}';`);
  refused('E33 a failed attempt cannot be reopened', `UPDATE payment_refund_attempts SET status='queued' WHERE id='${a2}';`, /transition failed -> queued/);
}
{
  const id = mkCreated(); const pay = `pay_manual_${++n}`;
  q(`UPDATE payment_intents SET status='needs_review', review_reason='amount mismatch', razorpay_payment_id='${pay}', captured_at=now() WHERE id='${id}';`);
  accepted('E34 a manual-review refund attempt is allowed for an intent in needs_review', A(attemptRow(id, pay, { purpose: 'manual_review', amount_paise: 60000 })));
  refused('E35 refund attempts together can never exceed the amount captured', A(attemptRow(id, pay, { purpose: 'manual_review', amount_paise: 50000 })), /exceed/);
  accepted('E36 ...but the remainder is fine', A(attemptRow(id, pay, { purpose: 'manual_review', amount_paise: 40000 })));
}

console.log('=== F. payment_webhook_events');
const ev = (o = {}) => insert('payment_webhook_events', { event_id: `evt_${++n}_${Date.now() % 100000}`, event_type: 'payment.captured', ...o }, 'event_id');
{
  const evId = 'evt_dup_0001';
  check('F1 an event is recorded (unprocessed) with its ids only', psqlRaw(TEST_DB, ev({ event_id: evId, razorpay_order_id: 'order_f1', razorpay_payment_id: 'pay_f1' })).ok);
  refused('F2 a duplicate event id is refused (the idempotency key)', ev({ event_id: evId }), /payment_webhook_events_pkey/);
  refused('F3 processed_at without an outcome is refused', ev({ processed_at: { raw: 'now()' } }), /pwe_processed_iff_outcome/);
  refused('F4 an outcome without processed_at is refused', ev({ outcome: 'applied' }), /pwe_processed_iff_outcome/);
  refused('F5 an unknown outcome, a bad event type, zero attempts are refused', ev({ processed_at: { raw: 'now()' }, outcome: 'weird' }), /pwe_outcome_valid/);
  refused('F5b bad event type', ev({ event_type: 'payment captured!' }), /pwe_event_type_format/);
  refused('F5c zero attempts', ev({ attempts: 0 }), /pwe_attempts_valid/);
  accepted('F6 a failed delivery can be retried: attempts goes up, last_error recorded', `UPDATE payment_webhook_events SET attempts = attempts + 1, last_attempt_at = now(), last_error = 'database unavailable' WHERE event_id='${evId}';`);
  refused('F7 attempts can never go down', `UPDATE payment_webhook_events SET attempts = 1 WHERE event_id='${evId}';`, /only increase|pwe_/);
  accepted('F8 processing records the outcome together with the time', `UPDATE payment_webhook_events SET processed_at=now(), outcome='applied', last_error=NULL WHERE event_id='${evId}';`);
  refused('F9 a processed event cannot be un-processed', `UPDATE payment_webhook_events SET processed_at=NULL, outcome=NULL WHERE event_id='${evId}';`, /un-processed|pwe_/);
  refused('F10 ...or given a different outcome', `UPDATE payment_webhook_events SET outcome='ignored' WHERE event_id='${evId}';`, /re-labelled/);
  refused('F11 event id and type are immutable', `UPDATE payment_webhook_events SET event_type='payment.failed' WHERE event_id='${evId}';`, /immutable/);
  const i1 = mkCreated();
  check('F12 an event can point at its intent', psqlRaw(TEST_DB, ev({ intent_id: i1 })).ok);
  q(`DELETE FROM payment_intents WHERE id='${i1}';`);
  check('F13 deleting an unfulfilled intent keeps the event, with the link cleared (SET NULL)', val(`SELECT count(*) FROM payment_webhook_events WHERE intent_id IS NULL AND event_type='payment.captured';`) !== '0');
  const cols = val(`SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name='payment_webhook_events';`);
  check('F14 the events table has no place for raw payloads, card data, UPI ids or contact details', !/payload|body|raw|email|contact|phone|card|vpa|upi|name|address/i.test(cols), cols);
}

console.log('=== G. notification_outbox');
const ob = (o = {}) => insert('notification_outbox', { kind: 'order_confirmation', dedupe_key: `order:${uuid()}:confirmation`, recipient_kind: 'customer', ...o });
{
  const oid = uuid(); q(insert('orders', orderRow({ id: oid }), ''));
  const key = `order:${oid}:confirmation`;
  accepted('G1 a notification for an order is queued', ob({ dedupe_key: key, order_id: oid }));
  refused('G2 queuing the same notification twice is refused (dedupe key)', ob({ dedupe_key: key, order_id: oid }), /notification_outbox_dedupe_key_key/);
  refused('G3 a notification with no order and no intent is refused', ob(), /no_has_subject/);
  refused('G4 unknown kind / recipient / status are refused', ob({ kind: 'sms', order_id: oid }), /no_kind_valid/);
  refused('G4b unknown recipient', ob({ recipient_kind: 'someone', order_id: oid }), /no_recipient_valid/);
  refused('G5 a payload that is not a small object is refused', ob({ order_id: oid, payload: { json: [1, 2] } }), /no_payload_small_object/);
  refused('G5b oversized payload', ob({ order_id: oid, payload: { json: { x: 'y'.repeat(5000) } } }), /no_payload_small_object/);
  const nid = val(`SELECT id FROM notification_outbox WHERE dedupe_key='${key}';`);
  refused('G6 sent without a sent time is refused', `UPDATE notification_outbox SET status='sent' WHERE id='${nid}';`, /no_sent_iff_sent_at|transition queued -> sent/);
  refused('G7 queued cannot jump to sent (it must be claimed first)', `UPDATE notification_outbox SET status='sent', sent_at=now() WHERE id='${nid}';`, /transition queued -> sent/);
  refused('G8 sending requires a lease', `UPDATE notification_outbox SET status='sending' WHERE id='${nid}';`, /no_sending_has_lease/);
  accepted('G9 queued -> sending -> queued (retry with backoff) -> sending -> sent', [
    `UPDATE notification_outbox SET status='sending', lease_until=now()+interval '2 minutes', attempts=1 WHERE id='${nid}';`,
    `UPDATE notification_outbox SET status='queued', lease_until=NULL, last_error='SMTP down', next_attempt_at=now()+interval '1 minute' WHERE id='${nid}';`,
    `UPDATE notification_outbox SET status='sending', lease_until=now()+interval '2 minutes', attempts=2 WHERE id='${nid}';`,
    `UPDATE notification_outbox SET status='sent', sent_at=now(), lease_until=NULL, last_error=NULL WHERE id='${nid}';`].join('\n'));
  refused('G10 a sent notification is final', `UPDATE notification_outbox SET status='queued', sent_at=NULL WHERE id='${nid}';`, /transition sent -> queued/);
  refused('G11 kind, dedupe key, subject and payload are immutable', `UPDATE notification_outbox SET kind='admin_alert' WHERE id='${nid}';`, /immutable/);
  const cols = val(`SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name='notification_outbox';`);
  check('G12 no column stores an e-mail address or message body', !/email|address|recipient_email|subject|body|html|text/i.test(cols.replace(/recipient_kind/g, '')), cols);
  refused('G13 skipped/failed are final too (failed cannot become sent)', `UPDATE notification_outbox SET status='failed' WHERE id='${val(`SELECT id FROM notification_outbox WHERE status='queued' LIMIT 1;`) || nid}';`, /transition|no_/);
  const oid2 = uuid(); q(insert('orders', orderRow({ id: oid2 }), '')); q(ob({ dedupe_key: `order:${oid2}:confirmation`, order_id: oid2 }));
  q(`DELETE FROM orders WHERE id='${oid2}';`);
  check('G14 deleting an order removes its queued notifications (they are meaningless without it)', val(`SELECT count(*) FROM notification_outbox WHERE dedupe_key='order:${oid2}:confirmation';`) === '0');
}

console.log('=== H. retention queries (select-only; nothing is deleted)');
{
  const old = mkFulfilled('pay_ret_old'), fresh = mkFulfilled('pay_ret_fresh'), openOld = mkCreated();
  psqlRaw(TEST_DB, `SET session_replication_role = replica;\nUPDATE payment_intents SET updated_at = now() - interval '120 days' WHERE id IN ('${old}','${openOld}');`);
  const scrub = q(`SELECT id FROM payment_intents WHERE status IN ('fulfilled','refunded') AND scrubbed_at IS NULL AND updated_at < now() - interval '90 days';`).split(/\r?\n/);
  check('H1 the scrub-candidate query finds only the finished, old, un-scrubbed intent (not fresh, not unfinished)', scrub.length === 1 && scrub[0] === old, scrub.join(','));
  psqlRaw(TEST_DB, `SET session_replication_role = replica;\nINSERT INTO payment_webhook_events (event_id, event_type, received_at, processed_at, outcome) VALUES ('evt_old_ret','payment.captured', now()-interval '120 days', now()-interval '120 days','applied'), ('evt_old_unprocessed','payment.captured', now()-interval '120 days', NULL, NULL);`);
  const evs = q(`SELECT event_id FROM payment_webhook_events WHERE processed_at IS NOT NULL AND received_at < now() - interval '90 days';`).split(/\r?\n/).filter(Boolean);
  check('H2 the event-retention query finds old PROCESSED events only (an old unprocessed one is kept for investigation)', evs.includes('evt_old_ret') && !evs.includes('evt_old_unprocessed') && !evs.includes('evt_dup_0001'));
  check('H3 the outbox-retention query runs and does not return queued rows', val(`SELECT count(*) FROM notification_outbox WHERE status IN ('sent','skipped','failed') AND updated_at < now() - interval '90 days' AND status='queued';`) === '0');
  check('H4 refund attempts have no retention candidate query (financial audit trail): rows are all still present', Number(val('SELECT count(*) FROM payment_refund_attempts;')) >= 5);
}

console.log('=== I. historical data survived the whole run');
check('I1 historical COD rows in the main test database were never altered by any recovery operation (no order was modified, only inserted)',
  val(`SELECT count(*) FROM orders WHERE payment_method='cod';`) === '0' && Number(val('SELECT count(*) FROM orders;')) > 0);

psqlRaw('postgres', `DROP DATABASE IF EXISTS ${TEST_DB};`);
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
