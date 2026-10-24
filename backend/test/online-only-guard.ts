// TEST ONLY: createOrder and priceCart refuse anything but a verified online payment BEFORE touching the database,
// so even a future caller (or a crafted value reaching them) cannot create an unpaid order stored as paid.
//   DB_NAME=does_not_matter npx tsx test/online-only-guard.ts
import 'dotenv/config';
import { pool } from '../src/utils/db';
import { priceCart } from '../src/services/pricing';
import { createOrder, cleanCustomer } from '../src/services/orderService';

async function expectRefused(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try { await fn(); console.log(`FAIL  ${label}: it did not throw`); process.exitCode = 1; }
  catch (e: any) {
    const ok = pattern.test(String(e?.message)) && (e?.status === 400 || e?.status === undefined);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${e?.message}`); if (!ok) process.exitCode = 1;
  }
}

async function main() {
  const customer = cleanCustomer({ name: 'G', email: 'g@example.com', phone: '9876543210', address: 'a', city: 'c', state: 's', pincode: '700001' } as any);
  const quote: any = { stock: { products: [], values: [] }, items: [], subtotal: 1, coupon: null, coupon_discount: 0, shipping_charge: 0, total_amount: 1 };
  await expectRefused('createOrder with paymentMethod "cod" is refused', () => createOrder({ quote, customer, paymentMethod: 'cod' as any, payment: { order_id: 'o', payment_id: 'p', signature: 's' } }), /only online/i);
  await expectRefused('createOrder with no payment details is refused (an order can never be stored as paid without one)', () => createOrder({ quote, customer, paymentMethod: 'online' } as any), /verified online payment/i);
  await expectRefused('createOrder with a payment missing its payment id is refused', () => createOrder({ quote, customer, paymentMethod: 'online', payment: { order_id: 'o' } as any }), /verified online payment/i);
  await expectRefused('priceCart with paymentMethod "cod" is refused', () => priceCart(pool as any, [{ id: 'x' }], { paymentMethod: 'cod' as any }), /only online/i);
  await pool.end();
}
main();
