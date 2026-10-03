// TEST ONLY: records a paid (online) order for a product exactly as a completed Razorpay payment would, so the
// test can then replay verify-payment for the same payment id and check idempotency.
//   Env: PAYID, RZP (razorpay order id), POT (product id; made to order, no customisation)
import 'dotenv/config';
import { pool } from '../src/utils/db';
import { priceCart } from '../src/services/pricing';
import { createOrder, cleanCustomer } from '../src/services/orderService';

async function main() {
  const items = [{ id: `${process.env.POT}-x`, type: 'product', quantity: 1, customization: { text_lines: ['x'], image_urls: ['https://x/a.png'] } }];
  const quote = await priceCart(pool, items, { paymentMethod: 'online' });
  const customer = cleanCustomer({ name: 'B', email: 'b@example.com', phone: '9876543210', address: 'a', city: 'c', state: 's', pincode: '700001' } as any);
  await createOrder({ quote, customer, paymentMethod: 'online', payment: { order_id: process.env.RZP!, payment_id: process.env.PAYID!, signature: 'sig' } });
  console.log('PAID_ORDER_CREATED');
  await pool.end();
}
main();
