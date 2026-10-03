// Phase 3B API tests. Requires: the app started with `npx tsx test/serve-with-mock.ts` (Razorpay fake),
// the SMTP sink (`node test/smtp-sink.mjs`), a local `vediqra` database, and an admin user "testadmin".
//   TEST_PW=... RAZORPAY_KEY_SECRET=... node test/phase3b-test.mjs
// All fixtures are prefixed "ZZ3B" and removed by the runner afterwards; the seeded catalogue is never touched.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const B = process.env.BASE || 'http://localhost:5000';
const SECRET = process.env.RAZORPAY_KEY_SECRET;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -> ' + String(detail).slice(0, 190) : ''}`); };
let token;
async function call(method, path, body, tok = token) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const pub = (m, p, b) => call(m, p, b, null);
const A = (m, p, b) => call(m, '/api/admin' + p, b);
const psql = (sql) => execSync(`psql -U postgres -h localhost -w -d vediqra -At -c "${sql.replace(/"/g, '\\"')}"`, { env: { ...process.env, PATH: process.env.PATH + ';C:\\Program Files\\PostgreSQL\\17\\bin' } }).toString().trim();
const sink = async (p, m = 'GET') => (await fetch(`http://127.0.0.1:2526${p}`, { method: m })).text();
const sinkMessages = async () => JSON.parse(await sink('/messages'));
const mockCalls = async () => (await fetch(B + '/__mock/calls')).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

token = (await pub('POST', '/api/admin/auth/login', { username: 'testadmin', password: process.env.TEST_PW })).json?.token;
check('admin login', !!token);
check('DB is exactly "vediqra"', psql('select current_database()') === 'vediqra');

// ------------------------------------------------------------------------------------------ fixtures
const mkProduct = async (name, price, extra = {}) =>
  (await A('POST', '/products', { name, price, image_url: 'https://x/p.jpg', stock_quantity: 0, description: '', is_active: true, ...extra })).json.product;
const mkGroup = async (pid, name, required, values) => {
  const g = (await A('POST', `/products/${pid}/option-groups`, { name, is_required: required })).json;
  const out = {};
  for (const [n, mod, stock] of values) out[n] = (await A('POST', `/product-option-groups/${g.id}/values`, { name: n, price_modifier: mod, stock_quantity: stock === undefined ? null : stock })).json;
  return { group: g, values: out };
};
const cod = (items, extra = {}) => pub('POST', '/api/orders/cod', { items, name: 'Buyer', email: `zz${Math.random().toString(36).slice(2, 8)}@example.com`, phone: '9876543210', address: 'a', city: 'c', state: 's', pincode: '700001', ...extra });
const quote = (items, extra = {}) => pub('POST', '/api/orders/quote', { items, payment_method: 'cod', ...extra });
const ln = (pid, extra = {}) => ({ id: `${pid}-x`, type: 'product', quantity: 1, ...extra });
const stockOf = (sql) => psql(sql);
const optStock = (id) => psql(`select coalesce(stock_quantity::text,'NULL') from product_option_values where id='${id}'`);
const prodStock = (id) => psql(`select stock_quantity from products where id='${id}'`);
const order = (id) => JSON.parse(psql(`select row_to_json(o) from (select id,status,total_amount,stock_movements,stock_restored_at,refunded_amount,refunds,items from orders where id='${id}') o`));

const T = await mkProduct('ZZ3B Tee', 500, { track_stock: true, stock_quantity: 10 });
const tee = await mkGroup(T.id, 'ZZ3B Finish', true, [['Holo', 120, 4], ['Plain', 0], ['Gold', 60, 1]]);
const wrap = await mkGroup(T.id, 'ZZ3B Wrap', false, [['Wrap', 30]]);
const M = await mkProduct('ZZ3B Mug', 200);                          // made to order (not tracked)
const mug = await mkGroup(M.id, 'ZZ3B Style', true, [['Magic', 40], ['Std', 0]]);
const N = await mkProduct('ZZ3B Notrack', 300, { track_stock: false, stock_quantity: 0 });

// ========================================================================================================
// 1. CUSTOM COMBO with generic options (server side; the browser tests cover the builder UI)
// ========================================================================================================
const cc = (members, extra = {}) => ({ id: 'combo-1-abc', type: 'combo', quantity: 1, name: 'My Combo', combo_products: members, ...extra });
let r = await quote([cc([{ id: T.id, quantity: 3, selected_options: [{ value_id: tee.values.Holo.id }] }])]);
check('custom combo: 3 x (500 + Holo 120) = 1860, 10% tier -> 1674', r.status === 200 && r.json.subtotal === 1674, JSON.stringify(r.json));
r = await quote([cc([{ id: T.id, quantity: 3, selected_options: [{ value_id: tee.values.Holo.id }, { value_id: wrap.values.Wrap.id }] }])]);
check('custom combo with an optional group too: 3 x 650 = 1950 -> 1755', r.status === 200 && r.json.subtotal === 1755, JSON.stringify(r.json));
r = await quote([cc([{ id: T.id, quantity: 3 }])]);
check('custom combo: required option (Finish) missing -> 400', r.status === 400 && /ZZ3B Finish/.test(r.json.error), r.json?.error);
r = await quote([cc([{ id: T.id, quantity: 3, selected_options: [{ value_id: mug.values.Magic.id }] }])]);
check("custom combo: another product's option value -> 400", r.status === 400 && /does not belong/.test(r.json.error), r.json?.error);
r = await quote([cc([{ id: T.id, quantity: 3, selected_options: [{ value_id: tee.values.Holo.id }, { value_id: tee.values.Plain.id }] }])]);
check('custom combo: two values of the same group -> 400', r.status === 400, r.json?.error);
r = await quote([cc([{ id: T.id, quantity: 3, selected_options: [tee.values.Holo.id, tee.values.Holo.id] }])]);
check('custom combo: same value twice -> 400', r.status === 400, r.json?.error);
r = await quote([cc([{ id: T.id, quantity: 3, price: 1, selected_options: [{ value_id: tee.values.Holo.id, price_modifier: -999 }] }])]);
check('custom combo: client price / modifier ignored', r.status === 200 && r.json.subtotal === 1674);
await A('PUT', `/product-option-values/${tee.values.Plain.id}`, { is_active: false });
r = await quote([cc([{ id: T.id, quantity: 3, selected_options: [{ value_id: tee.values.Plain.id }] }])]);
check('custom combo: inactive option value -> 400', r.status === 400, r.json?.error);
await A('PUT', `/product-option-values/${tee.values.Plain.id}`, { is_active: true });
// stock: Holo has 4; combo with 5 of them -> 409 ; with 4 -> ok and decrements
r = await quote([cc([{ id: T.id, quantity: 5, selected_options: [{ value_id: tee.values.Holo.id }] }])]);
check('custom combo: option stock 4 < 5 -> 409', r.status === 409, r.json?.error);
r = await quote([cc([{ id: T.id, quantity: 2, selected_options: [{ value_id: tee.values.Holo.id }] }]), cc([{ id: T.id, quantity: 3, selected_options: [{ value_id: tee.values.Holo.id }] }])].map((x, i) => ({ ...x, id: `combo-${i}-abc` })));
check('two custom combos add up their demand for the same option (2+3 > 4) -> 409', r.status === 409, r.json?.error);
// product-level stock (track_stock, 10) through combo members
r = await quote([cc([{ id: T.id, quantity: 11, selected_options: [{ value_id: tee.values.Plain.id }] }])]);
check('custom combo counts product stock too (11 > 10) -> 409', r.status === 409, r.json?.error);

// order snapshot + stock via a real (COD) custom-combo order
const holoBefore = optStock(tee.values.Holo.id), teeBefore = prodStock(T.id);
r = await cod([cc([{ id: T.id, quantity: 3, selected_options: [{ value_id: tee.values.Holo.id }] }])]);
const comboOrder = r.json?.order?.id;
check('custom combo order created', r.status === 200 && !!comboOrder, r.json?.error);
let o = order(comboOrder);
const snapMember = o.items[0].combo_products[0];
check('order snapshot: member has product id + selected option (group, value, price) + qty 3', snapMember.product_id === T.id && snapMember.selected_options[0].name === 'Holo' && snapMember.selected_options[0].price_modifier === 120 && snapMember.quantity === 3, JSON.stringify(snapMember.selected_options[0]));
check('stock: option 4 -> 1, product 10 -> 7 (member qty x combo qty)', optStock(tee.values.Holo.id) === '1' && prodStock(T.id) === '7', `${optStock(tee.values.Holo.id)} / ${prodStock(T.id)}`);
check('ledger: two movements recorded (product 3, option 3)', o.stock_movements.length === 2 && o.stock_movements.some((m) => m.kind === 'product' && m.qty === 3) && o.stock_movements.some((m) => m.kind === 'option' && m.qty === 3), JSON.stringify(o.stock_movements));

// ========================================================================================================
// 2. FIXED COMBO pricing consistency (server total = combo price + option surcharges)
// ========================================================================================================
const combo = (await A('POST', '/combos', { name: 'ZZ3B Combo', discount_price: 600, image_url: 'x' })).json.combo;
await A('POST', `/combos/${combo.id}/products`, { products: [{ product_id: T.id, quantity: 1 }, { product_id: M.id, quantity: 1 }] });
const fc = (sel, extra = {}) => ({ id: `combo-${combo.id}-1`, type: 'combo', quantity: 1, combo_products: sel, ...extra });
r = await quote([fc([{ id: T.id, selected_options: [{ value_id: tee.values.Gold.id }] }, { id: M.id, selected_options: [{ value_id: mug.values.Magic.id }] }])]);
check('fixed combo: 600 + Gold 60 + Magic 40 = 700 (what the page shows: combo price + "selected options")', r.status === 200 && r.json.subtotal === 700, JSON.stringify(r.json));
r = await quote([fc([{ id: T.id, selected_options: [{ value_id: tee.values.Plain.id }] }, { id: M.id, selected_options: [{ value_id: mug.values.Std.id }] }])]);
check('fixed combo with 0-price options: exactly the combo price (600)', r.status === 200 && r.json.subtotal === 600);
r = await quote([fc([{ id: T.id, selected_options: [{ value_id: tee.values.Plain.id }] }, { id: M.id }])]);
check('fixed combo: required option missing on a member -> 400 (total cannot be known yet)', r.status === 400, r.json?.error);

// ========================================================================================================
// 3. STOCK RESTORATION
// ========================================================================================================
const Rt = await mkProduct('ZZ3B Restock', 500, { track_stock: true, stock_quantity: 10 });
const rg = await mkGroup(Rt.id, 'ZZ3B Rfinish', true, [['A', 10, 5], ['B', 0]]);
const rline = (opt, q = 1) => ln(Rt.id, { quantity: q, selected_options: [opt.id] });

r = await cod([rline(rg.values.A, 2)]);
const o1 = r.json.order.id;
check('setup: order of 2 takes product 10->8 and option A 5->3', prodStock(Rt.id) === '8' && optStock(rg.values.A.id) === '3');
const snapBefore = JSON.stringify(order(o1).items);
r = await A('PUT', `/orders/${o1}`, { status: 'cancelled' });
check('cancel (admin PUT): stock restored (10 / 5), flag reported', r.status === 200 && r.json.status_changed === true && r.json.stock_restored === true && prodStock(Rt.id) === '10' && optStock(rg.values.A.id) === '5', `${prodStock(Rt.id)} / ${optStock(rg.values.A.id)}`);
check('  ...restored_at set; item snapshot untouched', order(o1).stock_restored_at !== null && JSON.stringify(order(o1).items) === snapBefore);
r = await A('PUT', `/orders/${o1}`, { status: 'cancelled' });
check('cancelling again does NOT restore twice (stock stays 10 / 5)', r.status === 200 && r.json.status_changed === false && r.json.stock_restored === false && prodStock(Rt.id) === '10' && optStock(rg.values.A.id) === '5');
r = await call('PATCH', `/api/orders/${o1}/status`, { status: 'cancelled' });
check('  ...nor via PATCH /:id/status', r.status === 200 && r.json.stock_restored === false && prodStock(Rt.id) === '10');
r = await A('PUT', `/orders/${o1}`, { status: 'processing' });
check('a cancelled order whose stock was returned cannot be re-opened (409)', r.status === 409, r.json?.error);

// concurrent cancellations restore exactly once
r = await cod([rline(rg.values.A, 3)]); const o2 = r.json.order.id;
const before2 = [prodStock(Rt.id), optStock(rg.values.A.id)];
const cancels = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? call('PATCH', `/api/orders/${o2}/status`, { status: 'cancelled' }) : A('PUT', `/orders/${o2}`, { status: 'cancelled' }))));
check('6 simultaneous cancellations: all answer 200, exactly one restores', cancels.every((x) => x.status === 200) && cancels.filter((x) => x.json.stock_restored).length === 1, cancels.map((x) => x.json.stock_restored).join());
check('  ...stock back to the pre-order numbers (10 / 5) - not 3 x restored', prodStock(Rt.id) === '10' && optStock(rg.values.A.id) === '5' && before2[0] === '7', `${prodStock(Rt.id)} / ${optStock(rg.values.A.id)} (was ${before2})`);

// untracked stock is never "restored"
r = await cod([rline(rg.values.B, 2)]); const o3 = r.json.order.id;
check('untracked option (stock NULL): ledger has only the product movement', order(o3).stock_movements.length === 1 && order(o3).stock_movements[0].kind === 'product' && optStock(rg.values.B.id) === 'NULL');
await A('PUT', `/orders/${o3}`, { status: 'cancelled' });
check('  ...cancel: product back to 10, option B still NULL (never invented)', prodStock(Rt.id) === '10' && optStock(rg.values.B.id) === 'NULL');
r = await cod([ln(N.id, { quantity: 5 })]);
check('product with track_stock=false: no movements recorded, stock number untouched', r.status === 200 && order(r.json.order.id).stock_movements.length === 0 && prodStock(N.id) === '0');
await A('PUT', `/orders/${r.json.order.id}`, { status: 'cancelled' });
check('  ...cancelling it leaves the stock number alone (0)', prodStock(N.id) === '0');

// tracking switched off AFTER the order, option deleted AFTER the order
r = await cod([rline(rg.values.A, 1)]); const o4 = r.json.order.id;
await A('PUT', `/products/${Rt.id}`, { track_stock: false });
await A('DELETE', `/product-option-values/${rg.values.A.id}`);
r = await A('PUT', `/orders/${o4}`, { status: 'cancelled' });
check('product no longer tracked + option deleted since the order: cancel still succeeds', r.status === 200 && r.json.status_changed === true, r.json?.error);
check('  ...product (untracked now) not incremented; nothing crashes', prodStock(Rt.id) === '9');
await A('PUT', `/products/${Rt.id}`, { track_stock: true, stock_quantity: 10 });

// legacy order without a ledger
r = await cod([ln(N.id)]); const o5 = r.json.order.id;
psql(`update orders set stock_movements='[]' where id='${o5}'`);
r = await A('PUT', `/orders/${o5}`, { status: 'cancelled' });
check('order with an empty ledger (placed before the ledger existed) cancels without restoring anything', r.status === 200 && r.json.stock_restored === false);

// rules
r = await cod([ln(N.id)]); const o6 = r.json.order.id;
await A('PUT', `/orders/${o6}`, { status: 'delivered' });
r = await A('PUT', `/orders/${o6}`, { status: 'cancelled' });
check('a delivered order cannot be cancelled (409)', r.status === 409, r.json?.error);
r = await A('PUT', `/orders/${o6}`, { status: 'refunded' });
check("'refunded' cannot be set by hand (400)", r.status === 400, r.json?.error);
r = await A('PUT', `/orders/${o6}`, { status: 'partially_refunded' });
check("'partially_refunded' cannot be set by hand (400)", r.status === 400);
r = await A('PUT', `/orders/${o6}`, { status: 'nonsense' });
check('unknown status rejected (400)', r.status === 400);
r = await A('PUT', `/orders/00000000-0000-0000-0000-000000000000`, { status: 'shipped' });
check('unknown order -> 404', r.status === 404);
r = await A('PUT', `/orders/${o6}`, { tracking_number: 'TRK-7', admin_notes: 'note' });
check('tracking number / notes still editable without a status change', r.status === 200 && r.json.order.tracking_number === 'TRK-7' && r.json.status_changed === false);

// failed order leaves nothing behind
const stockNow = prodStock(T.id), holoNow = optStock(tee.values.Holo.id), ordersNow = psql('select count(*) from orders');
r = await cod([ln(T.id, { quantity: 2, selected_options: [tee.values.Holo.id] })]);
check('order refused for stock (Holo has 1): 409, no order, no stock change', r.status === 409 && prodStock(T.id) === stockNow && optStock(tee.values.Holo.id) === holoNow && psql('select count(*) from orders') === ordersNow, r.json?.error);

// combo order: member stock restored
r = await cod([fc([{ id: T.id, selected_options: [{ value_id: tee.values.Gold.id }] }, { id: M.id, selected_options: [{ value_id: mug.values.Std.id }] }], { quantity: 1 })]);
const oc = r.json.order.id; const goldBefore = optStock(tee.values.Gold.id), teeStock = prodStock(T.id);
check('fixed combo order: Gold 1 -> 0, tee product -1', goldBefore === '0' && order(oc).stock_movements.length >= 2, `${goldBefore}`);
await A('PUT', `/orders/${oc}`, { status: 'cancelled' });
check('  ...cancel restores the combo MEMBER stock (Gold 0 -> 1, tee product back)', optStock(tee.values.Gold.id) === '1' && Number(prodStock(T.id)) === Number(teeStock) + 1, `${optStock(tee.values.Gold.id)} / ${prodStock(T.id)} (was ${teeStock})`);
// the custom-combo order from section 1
r = await A('PUT', `/orders/${comboOrder}`, { status: 'cancelled' });
check('custom-combo order cancelled: Holo back to 4, product back', optStock(tee.values.Holo.id) === '4' && r.json.stock_restored === true, optStock(tee.values.Holo.id));

// ========================================================================================================
// 4. REFUNDS (deterministic Razorpay fake; nothing here touches the real API)
// ========================================================================================================
const PAY = 'ZZ3B-' + Date.now();
async function paidOrder(items, suffix) {
  const payId = `pay_${PAY}_${suffix}`;
  const co = await pub('POST', '/api/payment/create-order', { items, email: 'pay@example.com' });
  const sig = crypto.createHmac('sha256', SECRET).update(`${co.json.id}|${payId}`).digest('hex');
  const v = await pub('POST', '/api/payment/verify-payment', { razorpay_order_id: co.json.id, razorpay_payment_id: payId, razorpay_signature: sig,
    order_data: { items, name: 'Payer', email: 'pay@example.com', phone: '9876543210', address: 'a', city: 'c', state: 's', pincode: '700001' } });
  return { payId, co, v, orderId: v.json?.order?.id };
}
await fetch(B + '/__mock/reset', { method: 'POST' });
const RP = await mkProduct('ZZ3B Refundable', 1000, { track_stock: true, stock_quantity: 20 });
const rp = (q = 1) => ln(RP.id, { quantity: q });
let p1 = await paidOrder([rp(2)], 'ok');
check('online order via create-order + verify-payment (mock Razorpay) is saved as paid: 2000', p1.v.status === 200 && Number(order(p1.orderId).total_amount) === 2000 && order(p1.orderId).status === 'paid', `${p1.co.status} ${p1.v.status}`);
check('  ...stock taken at payment time: 20 -> 18', prodStock(RP.id) === '18');
const refund = (payId, body) => call('POST', `/api/payment/refund/${payId}`, body);

r = await pub('POST', `/api/payment/refund/${p1.payId}`, {});
check('refund without admin token -> 401', r.status === 401);
for (const bad of [0, -5, 'abc']) { r = await refund(p1.payId, { amount: bad }); check(`refund amount ${JSON.stringify(bad)} -> 400`, r.status === 400); }
r = await refund(p1.payId, { amount: 2500 });
check('refund larger than the order -> 400, provider NOT called', r.status === 400 && (await mockCalls()).filter((c) => c.fn === 'payments.refund').length === 0, r.json?.error);
r = await refund(p1.payId, { amount: 600, request_id: 'req-A' });
check('PARTIAL refund 600 of 2000: success, order -> partially_refunded, refunded_amount 600', r.status === 200 && r.json.success && r.json.order_status === 'partially_refunded' && r.json.refunded_amount === 600 && r.json.refund.status === 'processed', JSON.stringify(r.json).slice(0, 150));
let calls = (await mockCalls()).filter((c) => c.fn === 'payments.refund');
check('  ...provider was asked for exactly 60000 paise', calls.length === 1 && calls[0].args[1].amount === 60000, JSON.stringify(calls[0]?.args[1]?.amount));
check('  ...stock NOT restored by a partial refund', prodStock(RP.id) === '18' && order(p1.orderId).stock_restored_at === null);
r = await refund(p1.payId, { amount: 600, request_id: 'req-A' });
check('same request_id again: recorded refund returned, NO second provider call, amount not counted twice', r.status === 200 && r.json.duplicate === true && r.json.refunded_amount === 600 && (await mockCalls()).filter((c) => c.fn === 'payments.refund').length === 1);
r = await refund(p1.payId, { amount: 1500 });
check('refund above the remaining balance (1400 left) -> 400', r.status === 400 && /1400/.test(r.json.error), r.json?.error);
r = await refund(p1.payId, { amount: 400 });
check('second partial 400: refunded_amount 1000, still partially_refunded', r.status === 200 && r.json.order_status === 'partially_refunded' && r.json.refunded_amount === 1000);
r = await refund(p1.payId, {});
check('refund with no amount = the remaining 1000 -> fully refunded, stock restored once', r.status === 200 && r.json.order_status === 'refunded' && r.json.refunded_amount === 2000 && r.json.stock_restored === true && prodStock(RP.id) === '20', JSON.stringify(r.json).slice(0, 160));
check('  ...ledger of refunds has 3 entries summing to the total', order(p1.orderId).refunds.length === 3 && order(p1.orderId).refunds.reduce((s, x) => s + x.amount, 0) === 2000);
const callsBefore = (await mockCalls()).filter((c) => c.fn === 'payments.refund').length;
r = await refund(p1.payId, {});
check('refunding a fully refunded order -> 409, provider NOT called', r.status === 409 && (await mockCalls()).filter((c) => c.fn === 'payments.refund').length === callsBefore, r.json?.error);
r = await A('PUT', `/orders/${p1.orderId}`, { status: 'cancelled' });
check('a fully refunded order is final (cannot be cancelled/changed) -> 409', r.status === 409, r.json?.error);

// provider failures record nothing
for (const [suffix, label] of [['fail', 'provider outage (throws)'], ['rejected', 'provider answers status "failed"'], ['noid', 'provider answers without a refund id']]) {
  const p = await paidOrder([rp(1)], suffix);
  const st0 = prodStock(RP.id);
  r = await refund(p.payId, { amount: 100 });
  check(`${label}: 502, nothing recorded, no success claimed`, r.status === 502 && r.json.success === false && Number(order(p.orderId).refunded_amount) === 0 && order(p.orderId).status === 'paid' && order(p.orderId).refunds.length === 0, r.json?.error);
  r = await refund(p.payId, {});
  check(`  ...and a retry is still allowed (not blocked by the failed attempt): still 502 with the same fake`, r.status === 502);
  if (suffix === 'fail') check('  ...stock untouched by failed refunds', prodStock(RP.id) === st0);
}
{ // provider accepts but it is still settling
  const p = await paidOrder([rp(1)], 'pending');
  r = await refund(p.payId, { amount: 300 });
  check('provider status "pending" is recorded as pending and counted', r.status === 200 && r.json.refund.status === 'pending' && r.json.refunded_amount === 300 && r.json.order_status === 'partially_refunded');
}
{ // two simultaneous FULL refunds: one provider call, one success
  const p = await paidOrder([rp(1)], 'slow');
  await fetch(B + '/__mock/reset', { method: 'POST' });
  const both = await Promise.all([refund(p.payId, {}), refund(p.payId, {})]);
  const ok = both.filter((x) => x.status === 200).length, conflict = both.filter((x) => x.status === 409).length;
  const nCalls = (await mockCalls()).filter((c) => c.fn === 'payments.refund').length;
  check('two simultaneous full refunds: exactly one succeeds (200), the other is refused (409), ONE provider call', ok === 1 && conflict === 1 && nCalls === 1, `${ok} ok / ${conflict} conflict / ${nCalls} provider calls`);
  check('  ...order fully refunded once; refunded_amount = total (not double)', order(p.orderId).status === 'refunded' && Number(order(p.orderId).refunded_amount) === 1000 && order(p.orderId).refunds.length === 1);
}
r = await refund('pay_does_not_exist', {});
check('unknown payment id -> 404', r.status === 404);
{ // COD orders have no payment to refund
  r = await cod([rp(1)]);
  check('COD order has no payment id, so it cannot be refunded through the provider', r.status === 200 && psql(`select razorpay_payment_id is null from orders where id='${r.json.order.id}'`) === 't');
}
check('DB refuses refunded_amount above the order total (CHECK)', (() => { try { psql(`update orders set refunded_amount = total_amount + 1 where id='${p1.orderId}'`); return false; } catch { return true; } })());

// ========================================================================================================
// 5. STATUS EMAIL (real nodemailer 10 -> local SMTP sink; no SMTP account needed)
// ========================================================================================================
await sink('/reset', 'POST'); await sink('/mode?fail=0', 'POST');
const eo = (await cod([ln(N.id)], { email: 'status.customer@example.com' })).json.order;
await sleep(700);
const afterPlace = await sinkMessages();
check('order confirmation email reached the SMTP sink (customer + admin notification)', afterPlace.some((m) => m.to.includes('status.customer@example.com')), afterPlace.map((m) => m.to.join('+')).join(' | '));
await sink('/reset', 'POST');
r = await pub('POST', '/api/orders/send-status-email', { orderId: eo.id, newStatus: 'shipped' });
check('send-status-email without a token -> 401', r.status === 401);
r = await call('POST', '/api/orders/send-status-email', { orderId: 'nope', newStatus: 'shipped' });
check('send-status-email: malformed order id -> 400', r.status === 400);
r = await call('POST', '/api/orders/send-status-email', { orderId: '00000000-0000-0000-0000-000000000000', newStatus: 'shipped' });
check('send-status-email: unknown order -> 404', r.status === 404);
r = await call('POST', '/api/orders/send-status-email', { orderId: eo.id, newStatus: 'hacked' });
check('send-status-email: invalid status -> 400', r.status === 400);
r = await call('POST', '/api/orders/send-status-email', { orderId: eo.id, newStatus: 'delivered' });
check('send-status-email: announcing a status the order does not have -> 409, nothing sent', r.status === 409 && (await sinkMessages()).length === 0, r.json?.error);
await A('PUT', `/orders/${eo.id}`, { status: 'shipped', tracking_number: 'TRK-1' });
r = await call('POST', '/api/orders/send-status-email', { orderId: eo.id, oldStatus: 'pending', newStatus: 'shipped', trackingNumber: 'TRK-1' });
await sleep(300);
let msgs = await sinkMessages();
check('valid admin send: success=true only because the SMTP server accepted it; mail is addressed to the customer', r.status === 200 && r.json.success === true && msgs.length === 1 && msgs[0].to.includes('status.customer@example.com'), JSON.stringify(r.json));
check('  ...the email mentions the tracking number', msgs[0]?.data.includes('TRK-1'));
await sink('/mode?fail=1', 'POST'); await sink('/reset', 'POST');
r = await call('POST', '/api/orders/send-status-email', { orderId: eo.id, newStatus: 'shipped' });
check('SMTP refuses the recipient: route reports success=false (no false success)', r.status === 200 && r.json.success === false, JSON.stringify(r.json));
await sink('/mode?fail=0', 'POST'); await sink('/reset', 'POST');
// PATCH status: mails only on a real change
const eo2 = (await cod([ln(N.id)], { email: 'patch.customer@example.com' })).json.order;
await sleep(500); await sink('/reset', 'POST');
await call('PATCH', `/api/orders/${eo2.id}/status`, { status: 'processing' });
await call('PATCH', `/api/orders/${eo2.id}/status`, { status: 'processing' });
await call('PATCH', `/api/orders/${eo2.id}/status`, { status: 'processing' });
await sleep(700);
let n = (await sinkMessages()).filter((m) => m.to.includes('patch.customer@example.com')).length;
check('PATCH status repeated 3x with the same status: ONE email (only the real change)', n === 1, `${n} emails`);
await call('PATCH', `/api/orders/${eo2.id}/status`, { status: 'shipped' });
await sleep(600);
n = (await sinkMessages()).filter((m) => m.to.includes('patch.customer@example.com')).length;
check('  ...a new status sends one more (2 total)', n === 2, `${n} emails`);
r = await A('PUT', `/orders/${eo2.id}`, { status: 'shipped' });
check('admin PUT with an unchanged status reports status_changed=false (the admin screen then sends no email)', r.status === 200 && r.json.status_changed === false);

// ========================================================================================================
// 6. Misc functional fixes
// ========================================================================================================
r = await cod([ln(N.id)], { email: 'a@b.com,c@d.com' });
check('customer email with a second recipient ("a@b.com,c@d.com") is rejected', r.status === 400, r.json?.error);
r = await cod([ln(N.id)], { email: 'x@y.com>' });
check('customer email with angle bracket rejected', r.status === 400);
// review stats ride along with the product list (product cards no longer make a request each)
await A('PUT', `/products/${N.id}`, { is_active: true });
const rv = (await pub('POST', '/api/reviews', { product_id: N.id, user_name: 'T', rating: 4, comment: 'ok' })).json.review;
await call('PUT', `/api/reviews/admin/${rv.id}/approve`, { is_approved: true });
r = await pub('GET', '/api/products');
const got = r.json.find((p) => p.id === N.id);
check('product list carries review_count / average_rating (product cards need no per-card request)', got?.review_count === 1 && got?.average_rating === 4, `${got?.review_count} ${got?.average_rating}`);
r = await pub('GET', `/api/products/${N.id}`);
check('single product endpoint carries them too', r.json.review_count === 1);

// ---------------------------------------------------------------------------------------------- cleanup
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
