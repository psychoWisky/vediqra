// TEST ONLY: proves createOrder's transaction is atomic. The early "soft" stock check in the quote is bypassed on
// purpose: the product decrement succeeds, then an option decrement fails, and BOTH the decrement and the order
// row must be undone.   Env: TIFFIN (tracked product id), PLAIN (option value id with limited stock, i.e. NOT NULL)
import 'dotenv/config';
import { pool } from '../src/utils/db';
import { createOrder, cleanCustomer } from '../src/services/orderService';

async function main() {
  const tiffin = process.env.TIFFIN!, limited = process.env.PLAIN!;
  const stockOf = async () => Number((await pool.query('SELECT stock_quantity FROM products WHERE id = $1', [tiffin])).rows[0].stock_quantity);
  const orders = async () => Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count);
  const before = { stock: await stockOf(), orders: await orders() };
  const quote: any = {
    stock: { products: [{ id: tiffin, name: 'Tiffin', qty: 1 }], values: [{ id: limited, label: 'Plain', qty: 100000 }] },
    items: [], subtotal: 100, coupon: null, coupon_discount: 0, shipping_charge: 0, cod_charge: 0, total_amount: 100,
  };
  const customer = cleanCustomer({ name: 'Rollback', email: 'rollback@example.com', phone: '9876543210', address: 'a', city: 'c', state: 's', pincode: '700001' } as any);
  let failed = false;
  try { await createOrder({ quote, customer, paymentMethod: 'cod' }); } catch { failed = true; }
  const after = { stock: await stockOf(), orders: await orders() };
  console.log(failed && after.stock === before.stock && after.orders === before.orders
    ? 'ROLLED_BACK_OK' : `NOT_ROLLED_BACK ${JSON.stringify({ failed, before, after })}`);
  await pool.end();
}
main();
