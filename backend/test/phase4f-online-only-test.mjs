// Online-only checkout tests. Requires: the app started with `npx tsx test/serve-with-mock.ts` (Razorpay fake), a
// DISPOSABLE database (TEST_DB; it inserts a historical COD order and fixtures, so never point it at real data),
// and an admin user "testadmin".
//   TEST_PW=... RAZORPAY_KEY_SECRET=... TEST_DB=... node test/phase4f-online-only-test.mjs
// No real payment, refund or email is involved: Razorpay is the deterministic fake.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.env.BASE || 'http://localhost:5000';
const SECRET = process.env.RAZORPAY_KEY_SECRET;
const TEST_DB = process.env.TEST_DB;
if (!TEST_DB || TEST_DB === 'vediqra') { console.error('Set TEST_DB to a disposable database (not "vediqra").'); process.exit(2); }
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -> ' + String(detail).slice(0, 200) : ''}`); };
let token;
async function call(method, p, body, tok = token, extraHeaders = {}) {
  const res = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...extraHeaders },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const pub = (m, p, b) => call(m, p, b, null);
// create-order stores cart + customer server-side and needs an Idempotency-Key; the fake provider must know the payment.
let keyN = 0;
const createOrder = (body) => call('POST', '/api/payment/create-order', body, null, { 'Idempotency-Key': `zz4f_${Date.now()}_${++keyN}_${crypto.randomBytes(6).toString('hex')}` });
const seedPayment = (orderId, paymentId, amount) => fetch(B + '/__mock/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: paymentId, order_id: orderId, amount, status: 'captured' }) });
const A = (m, p, b) => call(m, '/api/admin' + p, b);
const psql = (sql) => execSync(`psql -U postgres -h localhost -w -d ${TEST_DB} -At -c "${sql.replace(/"/g, '\\"')}"`, { env: { ...process.env, PATH: process.env.PATH + ';C:\\Program Files\\PostgreSQL\\17\\bin' } }).toString().trim();
const orderCount = () => Number(psql('select count(*) from orders'));
const sign = (rzpOrder, payId) => crypto.createHmac('sha256', SECRET).update(`${rzpOrder}|${payId}`).digest('hex');
const buyer = { name: 'ZZ4F Buyer', email: 'zz4f@example.com', phone: '9876500004', address: 'a', city: 'c', state: 's', pincode: '700001' };
const line = (id, extra = {}) => ({ id: `${id}-x`, type: 'product', product_id: id, quantity: 1, ...extra });

token = (await pub('POST', '/api/admin/auth/login', { username: 'testadmin', password: process.env.TEST_PW })).json?.token;
check('admin login', !!token);
check(`DB is exactly "${TEST_DB}"`, psql('select current_database()') === TEST_DB);

// ----------------------------------------------------------------------------------------------- fixtures
const mk = async (name, price, extra = {}) => (await A('POST', '/products', { name, price, image_url: 'https://x/p.jpg', stock_quantity: 0, description: '', is_active: true, ...extra })).json.product;
const cheap = await mk('ZZ4F Cheap', 100);                                         // below the free-shipping threshold
const tracked = await mk('ZZ4F Tracked', 1000, { track_stock: true, stock_quantity: 10 });

// A historical COD order, exactly as the old system stored one (inserted directly: the app can no longer create these).
const histItems = JSON.stringify([{ id: `${tracked.id}-x`, type: 'product', product_id: tracked.id, name: 'ZZ4F Tracked', quantity: 2, price: 1000 }]);
const hist = psql(`insert into orders (custom_order_id, items, subtotal, shipping_charge, cod_charge, total_amount, customer_name, customer_email, customer_phone, shipping_address, shipping_city, shipping_state, shipping_pincode, payment_method, status, stock_movements) values ('VEDIQRA#HIST1', '${histItems}'::jsonb, 2000, 0, 49, 2049, 'Old Customer', 'old@example.com', '9876500005', 'Old Street', 'Kolkata', 'WB', '700001', 'cod', 'pending', '[{"kind":"product","id":"${tracked.id}","qty":2}]'::jsonb) returning id`).split(/\r?\n/)[0].trim();
psql(`update products set stock_quantity = 8 where id='${tracked.id}'`);          // as if the old COD order had taken 2
const histBefore = psql(`select subtotal||'|'||shipping_charge||'|'||cod_charge||'|'||total_amount||'|'||payment_method||'|'||status from orders where id='${hist}'`);
check('fixture: historical COD order inserted (total 2049 incl. COD fee 49)', histBefore === '2000.00|0.00|49.00|2049.00|cod|pending', histBefore);

// ============================================================================================ 1. old COD endpoint
let before = orderCount();
const codBody = { items: [line(cheap.id)], payment_method: 'cod', ...buyer };
let r = await pub('POST', '/api/orders/cod', codBody);
check('POST /api/orders/cod is rejected with 410 and a clear message', r.status === 410 && r.json?.success === false && /no longer available/i.test(r.json?.error || ''), JSON.stringify(r));
check('  ...no order was created and no stock moved', orderCount() === before && psql(`select stock_quantity from products where id='${tracked.id}'`) === '8');
r = await pub('POST', '/api/orders/cod', { order_data: codBody });
check('the legacy order_data wrapper is rejected too (410)', r.status === 410);
r = await call('PUT', '/api/orders/cod', codBody, token);
check('any other method on the COD path is rejected as well, even with an admin token (410)', r.status === 410);
r = await pub('POST', '/api/orders/cod', {});
check('an empty body gets the same 410 (the endpoint never reads or prices anything)', r.status === 410 && orderCount() === before);

// ============================================================================================ 2. quotes carry no COD fee
const expectTotal = 100 + 79;                                                       // 100 + shipping fee (cheap cart), no COD fee
r = await pub('POST', '/api/orders/quote', { items: [line(cheap.id)], payment_method: 'online' });
check('quote (online): total = subtotal + shipping only', r.status === 200 && r.json.total_amount === expectTotal && r.json.subtotal === 100 && r.json.shipping_charge === 79, JSON.stringify(r.json?.total_amount));
check('quote: response has no cod_charge / cod_fee fields', !('cod_charge' in r.json) && !('cod_fee' in r.json), Object.keys(r.json).join(','));
r = await pub('POST', '/api/orders/quote', { items: [line(cheap.id)], payment_method: 'cod' });
check('crafted quote with payment_method "cod": priced as online, NO fee added', r.status === 200 && r.json.total_amount === expectTotal && !('cod_charge' in r.json), JSON.stringify(r.json?.total_amount));
r = await pub('POST', '/api/orders/quote', { items: [line(cheap.id)] });
check('quote without payment_method: same total', r.json.total_amount === expectTotal);

// ============================================================================================ 3. online flow
await fetch(B + '/__mock/reset', { method: 'POST' });
const items = [line(tracked.id, { quantity: 1 })];                                  // 1000, free shipping
const co = await createOrder({ items, ...buyer, payment_method: 'cod' });
check('create-order ignores a crafted payment_method and charges the server-priced online total (100000 paise)', co.status === 200 && co.json.amount === 100000, JSON.stringify(co.json));
const payId = 'pay_ZZ4F_ok';
const sig = sign(co.json.id, payId);
await seedPayment(co.json.id, payId, co.json.amount);
before = orderCount();
r = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: co.json.id, razorpay_payment_id: payId, razorpay_signature: sig, order_data: { items, ...buyer, payment_method: 'cod', cod_charge: 49, total_amount: 1 } });   // crafted fields: ignored
const okOrderId = r.json?.order?.id;
check('valid payment verifies (200) and creates exactly one order', r.status === 200 && r.json.success && orderCount() === before + 1, JSON.stringify(r.json));
const row = psql(`select payment_method||'|'||status||'|'||(paid_at is not null)||'|'||cod_charge||'|'||total_amount||'|'||razorpay_payment_id from orders where id='${okOrderId}'`);
check('  ...stored as online, paid, paid_at set, cod_charge 0, server total 1000 (crafted COD/fee/total fields ignored)', row === `online|paid|true|0.00|1000.00|${payId}`, row);
check('  ...stock taken at payment time: 8 -> 7', psql(`select stock_quantity from products where id='${tracked.id}'`) === '7');
r = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: co.json.id, razorpay_payment_id: payId, razorpay_signature: sig, order_data: { items, ...buyer } });
check('replaying the same verified payment returns the same order, no second order, no second stock decrement', r.status === 200 && r.json.order.id === okOrderId && orderCount() === before + 1 && psql(`select stock_quantity from products where id='${tracked.id}'`) === '7');

// ============================================================================================ 4. failed / forged verification
before = orderCount();
const co2 = await createOrder({ items, ...buyer });
r = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: co2.json.id, razorpay_payment_id: 'pay_ZZ4F_forged', razorpay_signature: 'deadbeef'.repeat(8), order_data: { items, ...buyer } });
check('tampered signature -> 400, no order', r.status === 400 && orderCount() === before, JSON.stringify(r.json));
r = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: co2.json.id, razorpay_payment_id: 'pay_ZZ4F_other', razorpay_signature: sign(co2.json.id, 'pay_ZZ4F_ok'), order_data: { items, ...buyer } });
check('a valid signature for a DIFFERENT payment id is rejected -> 400, no order', r.status === 400 && orderCount() === before);
r = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: co2.json.id, razorpay_payment_id: 'pay_ZZ4F_x' });
check('missing signature fields -> 400, no order', r.status === 400 && orderCount() === before);
// The provider says 2000 was captured for a checkout the server priced at 1000: the amount differs from the stored snapshot.
await seedPayment(co2.json.id, 'pay_ZZ4F_amt', 200000);
r = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: co2.json.id, razorpay_payment_id: 'pay_ZZ4F_amt', razorpay_signature: sign(co2.json.id, 'pay_ZZ4F_amt') });
check('paid amount differs from the server-priced checkout -> 409 (held for review), no order', r.status === 409 && orderCount() === before, JSON.stringify(r.json));
check('  ...and stock is unchanged by every failed verification (still 7)', psql(`select stock_quantity from products where id='${tracked.id}'`) === '7');
const unconfigured = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: sign('order_x', 'pay_x') + 'x', order_data: { items, ...buyer } });
check('there is no way to get a paid order without a matching signature (garbage signature -> 400)', unconfigured.status === 400);

// ============================================================================================ 5. historical COD orders still work
const hAfterOnline = psql(`select subtotal||'|'||shipping_charge||'|'||cod_charge||'|'||total_amount||'|'||payment_method||'|'||status from orders where id='${hist}'`);
check('historical COD order is untouched by new orders (stored totals and COD fee unchanged)', hAfterOnline === histBefore, hAfterOnline);
r = await A('GET', `/orders/${hist}`);
check('admin can open the historical COD order: payment_method cod, cod_charge 49, total 2049', r.status === 200 && r.json.payment_method === 'cod' && Number(r.json.cod_charge) === 49 && Number(r.json.total_amount) === 2049, JSON.stringify(r.json && { m: r.json.payment_method, c: r.json.cod_charge, t: r.json.total_amount }));
r = await A('GET', '/orders');
const listed = (r.json?.data || []).find((o) => o.id === hist);
check('admin order list still includes it with its stored totals', r.status === 200 && !!listed && Number(listed.total_amount) === 2049 && Number(listed.cod_charge) === 49);
r = await pub('GET', `/api/orders/confirmation/${hist}`);
check('customer confirmation page API still returns the historical COD order (payment_method cod, cod_charge 49)', r.status === 200 && r.json.payment_method === 'cod' && r.json.cod_charge === 49 && r.json.total_amount === 2049, JSON.stringify(r.json && { m: r.json.payment_method, c: r.json.cod_charge }));
r = await pub('GET', `/api/orders/track?orderId=${encodeURIComponent('VEDIQRA#HIST1')}&phone=9876500005`);
check('order tracking still finds it by order number + phone', r.status === 200 && r.json.payment_method === 'cod');
r = await call('PATCH', `/api/orders/${hist}/status`, { status: 'processing' });
check('admin can still move a historical COD order through statuses (pending -> processing)', r.status === 200 && r.json.order.status === 'processing', JSON.stringify(r.json));
r = await call('PATCH', `/api/orders/${hist}/status`, { status: 'cancelled' });
check('cancelling it restores the stock it took, once: 7 -> 9', r.status === 200 && r.json.stock_restored === true && psql(`select stock_quantity from products where id='${tracked.id}'`) === '9', JSON.stringify(r.json));
r = await call('PATCH', `/api/orders/${hist}/status`, { status: 'cancelled' });
check('  ...and a repeat cancel does not restore again (stays 9)', psql(`select stock_quantity from products where id='${tracked.id}'`) === '9');
check('  ...and its stored totals and COD fee are STILL unchanged after all of that', psql(`select subtotal||'|'||shipping_charge||'|'||cod_charge||'|'||total_amount||'|'||payment_method from orders where id='${hist}'`) === '2000.00|0.00|49.00|2049.00|cod');
r = await call('POST', '/api/payment/refund/pay_none', {});
check('COD orders have no payment id, so a refund request for one is not found (404)', r.status === 404);

// ============================================================================================ 6. no COD availability claims left
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'Admin' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const hits = [];
for (const f of walk(path.join(root, 'frontend', 'src')).filter((x) => /\.(ts|tsx)$/.test(x))) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/cash[ -]on[ -]delivery|\bcod\b|cod_charge|cod_fee/i.test(l)) hits.push(`${path.relative(root, f).replace(/\\/g, '/')}:${i + 1}`); });
}
// Allowed: showing how a HISTORICAL order was paid, the stored field type, the popup data field, and the FAQ saying COD is not available.
const allowed = (h) => /OrderConfirmation\.tsx/.test(h) || /src\/types\.ts/.test(h) || /FAQModal\.tsx/.test(h);
check('storefront code: the only COD mentions are historical-order display, stored field types and the FAQ "not available" line', hits.filter((h) => !allowed(h)).length === 0, hits.filter((h) => !allowed(h)).join(', '));
const faq = fs.readFileSync(path.join(root, 'frontend', 'src', 'components', 'FAQModal.tsx'), 'utf8');
check('FAQ says cash on delivery is not available and does not offer it', /Cash on delivery is not available/.test(faq) && !/choose cash on delivery|or cash on delivery/i.test(faq));
const mailTpl = fs.readFileSync(path.join(root, 'backend', 'src', 'services', 'gmailService.ts'), 'utf8');
check('emails only mention COD for orders whose stored payment_method is cod (never as an option)', !/choose cash|pay on delivery|cash on delivery is available/i.test(mailTpl));
const checkout = fs.readFileSync(path.join(root, 'frontend', 'src', 'pages', 'Checkout.tsx'), 'utf8');
check('Checkout.tsx has no COD option, route call or fee row', !/\/api\/orders\/cod|cod_charge|cod_fee|'cod'|Cash on delivery/i.test(checkout));

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
