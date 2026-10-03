// Phase 4C API tests: order confirmation/tracking privacy, the max_customization_images:0 create bug, and the
// quote endpoint's new configuration/items fields. Requires a local `vediqra` database and an admin user
// "testadmin".   TEST_PW=... node test/phase4c-test.mjs
// All fixtures are prefixed "ZZ4C" and removed by the runner afterwards; the seeded catalogue is never touched.
import { execSync } from 'node:child_process';

const B = process.env.BASE || 'http://localhost:5000';
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

token = (await pub('POST', '/api/admin/auth/login', { username: 'testadmin', password: process.env.TEST_PW })).json?.token;
check('admin login', !!token);
check('DB is exactly "vediqra"', psql('select current_database()') === 'vediqra');

// =========================================================================================================
// PART C: max_customization_images: 0 must stick (explicit 0 != "not supplied")
// =========================================================================================================
let r = await A('POST', '/products', { name: 'ZZ4C Text Only', price: 300, image_url: 'x', description: '', stock_quantity: 0, is_active: true, is_customizable: true, max_customization_lines: 2, max_customization_images: 0 });
check('create: explicit max_customization_images:0 is stored as 0, not the default 10', r.status === 200 && r.json.product.max_customization_images === 0, JSON.stringify(r.json.product?.max_customization_images));
const textOnly = r.json.product;

r = await A('POST', '/products', { name: 'ZZ4C Default', price: 300, image_url: 'x', description: '', stock_quantity: 0, is_active: true, is_customizable: true });
check('create: omitted max_customization_images still defaults to 10', r.status === 200 && r.json.product.max_customization_images === 10, r.json.product?.max_customization_images);

r = await A('POST', '/products', { name: 'ZZ4C Explicit Chars', price: 300, image_url: 'x', description: '', stock_quantity: 0, is_active: true, is_customizable: true, max_customization_characters: 0, max_customization_lines: 3 });
check('create: explicit max_customization_characters:0 is stored as 0', r.status === 200 && r.json.product.max_customization_characters === 0, r.json.product?.max_customization_characters);

r = await A('POST', '/products', { name: 'ZZ4C Negative', price: 300, image_url: 'x', description: '', stock_quantity: 0, is_active: true, is_customizable: true, max_customization_images: -1 });
check('create: a negative max_customization_images is rejected (400), not silently clamped', r.status === 400, JSON.stringify(r.json));
check('  ...and nothing was created for the rejected request', psql("select count(*) from products where name='ZZ4C Negative'") === '0');

// =========================================================================================================
// PART D: quote response carries the checkout configuration once (no separate endpoint, no duplicate calls)
// =========================================================================================================
const cheap = await A('POST', '/products', { name: 'ZZ4C Cheap', price: 50, image_url: 'x', description: '', stock_quantity: 0, is_active: true });
const line = (id, extra = {}) => ({ id: `${id}-x`, type: 'product', product_id: id, quantity: 1, ...extra });
r = await pub('POST', '/api/orders/quote', { items: [line(cheap.json.product.id)], payment_method: 'online' });
check('quote: shipping_threshold / shipping_fee / cod_fee are echoed as configuration (not secrets)', r.status === 200 && typeof r.json.shipping_threshold === 'number' && typeof r.json.shipping_fee === 'number' && typeof r.json.cod_fee === 'number', JSON.stringify(r.json));
check('quote: shipping is actually charged below the threshold (cheap cart)', r.json.shipping_charge === r.json.shipping_fee && r.json.shipping_charge > 0);
r = await pub('POST', '/api/orders/quote', { items: [line(cheap.json.product.id, { quantity: 1 })], payment_method: 'cod' });
check('quote: cod_charge (this quote) equals cod_fee (the constant) when payment_method is cod', r.json.cod_charge === r.json.cod_fee && r.json.cod_charge > 0);

// =========================================================================================================
// PART A/B: order-confirmation / tracking never leak payment/refund/stock internals
// =========================================================================================================
const buyer = { name: 'ZZ4C Buyer', email: 'zz4c@example.com', phone: '9876500001', address: 'a', city: 'c', state: 's', pincode: '700001' };
r = await pub('POST', '/api/orders/cod', { items: [line(cheap.json.product.id)], payment_method: 'cod', ...buyer });
check('order placed', r.status === 200, JSON.stringify(r.json));
const orderId = r.json.order.id;
const customOrderId = r.json.order.custom_order_id;

const FORBIDDEN = ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature', 'refund_data', 'refunds', 'refunded_at', 'refunded_amount', 'stock_movements', 'stock_restored_at', 'admin_notes', 'grand_total', 'paid_at'];
const REQUIRED = ['id', 'custom_order_id', 'status', 'items', 'subtotal', 'shipping_charge', 'cod_charge', 'total_amount', 'payment_method', 'customer_name', 'shipping_address', 'created_at'];

r = await pub('GET', `/api/orders/confirmation/${orderId}`);
check('confirmation: succeeds and returns the order', r.status === 200);
check('confirmation: none of the internal/payment/refund/stock fields are present', FORBIDDEN.every((f) => !(f in (r.json || {}))), Object.keys(r.json || {}).join(','));
check('confirmation: every field the confirmation page needs is present', REQUIRED.every((f) => f in r.json), Object.keys(r.json || {}).join(','));
check('confirmation: items include the product name and price the order was placed with', Array.isArray(r.json.items) && r.json.items[0]?.product_name === 'ZZ4C Cheap' && r.json.items[0]?.price === 50);

r = await pub('GET', `/api/orders/track?orderId=${encodeURIComponent(customOrderId)}&phone=${buyer.phone}`);
check('tracking: succeeds with the right order number + phone', r.status === 200);
check('tracking: none of the internal/payment/refund/stock fields are present', FORBIDDEN.every((f) => !(f in (r.json || {}))), Object.keys(r.json || {}).join(','));
check('tracking: every field the tracking page needs is present', REQUIRED.every((f) => f in r.json));

r = await pub('GET', `/api/orders/track?orderId=${encodeURIComponent(customOrderId)}&phone=0000000000`);
check('tracking: wrong phone for a real order number is refused (privacy preserved)', r.status === 404);

// Fixtures (ZZ4C*, including the order just placed) are removed by the runner afterwards, same as other phases.
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
