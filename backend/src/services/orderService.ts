import config from '../config';
import { pool } from '../utils/db';
import { CartQuote, PricingError, StockError } from './pricing';

export interface CustomerInput {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  address?: unknown;
  city?: unknown;
  state?: unknown;
  pincode?: unknown;
  special_requests?: unknown;
}

export interface CleanCustomer {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  special_requests: string;
}

const clean = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate and normalise customer details. Throws PricingError (400) when invalid. */
export function cleanCustomer(input: CustomerInput | undefined): CleanCustomer {
  const c = input || {};
  const name = clean(c.name, 200);
  const email = clean(c.email, 254).toLowerCase();
  const phone = clean(c.phone, 30).replace(/\D/g, '');

  if (!name || !email || !phone) throw new PricingError('Missing customer information');
  // Exactly ONE plain address: no commas/semicolons/quotes/angle brackets (nodemailer would treat them as extra recipients).
  if (!/^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/.test(email)) throw new PricingError('Invalid email format');
  if (!/^\d{10}$/.test(phone)) throw new PricingError('Invalid phone number. Please enter 10 digits');

  return {
    name,
    email,
    phone,
    address: clean(c.address),
    city: clean(c.city, 100),
    state: clean(c.state, 100),
    pincode: clean(c.pincode, 10),
    special_requests: clean(c.special_requests, 2000),
  };
}

export interface RazorpayPayment {
  order_id: string;
  payment_id: string;
  signature: string;
}

/**
 * Take the order's units out of stock, inside the order transaction.
 *
 * Each UPDATE only succeeds while enough stock remains (stock_quantity >= qty), and row locks make
 * simultaneous orders queue up on the same row, so two orders can never oversell one unit. Rows are locked
 * in a fixed order (products, then option values, each by id) to avoid deadlocks. If anything fails the
 * caller's ROLLBACK undoes every decrement.
 * Untracked stock (option value stock NULL, product track_stock FALSE) is left alone.
 */
export interface StockMovement {
  kind: 'product' | 'option';
  id: string;
  qty: number;
}

type Db = { query: (t: string, v?: any[]) => Promise<any> };

async function decrementStock(client: Db, stock: CartQuote['stock']): Promise<StockMovement[]> {
  const left = (n: number) => (n <= 0 ? 'is sold out' : `only ${n} left`);
  const movements: StockMovement[] = []; // only what was ACTUALLY decremented (untracked stock is not recorded)

  for (const p of [...stock.products].sort((a, b) => a.id.localeCompare(b.id))) {
    const done = await client.query(
      `UPDATE products SET stock_quantity = stock_quantity - $2, updated_at = now()
        WHERE id = $1 AND track_stock AND stock_quantity >= $2 RETURNING id`,
      [p.id, p.qty]
    );
    if (done.rowCount === 0) {
      const now = await client.query('SELECT track_stock, stock_quantity FROM products WHERE id = $1', [p.id]);
      if (!now.rows[0] || now.rows[0].track_stock) {
        throw new StockError(`"${p.name}" ${left(Number(now.rows[0]?.stock_quantity) || 0)}.`);
      }
    } else {
      movements.push({ kind: 'product', id: p.id, qty: p.qty });
    }
  }

  for (const v of [...stock.values].sort((a, b) => a.id.localeCompare(b.id))) {
    const done = await client.query(
      `UPDATE product_option_values SET stock_quantity = stock_quantity - $2, updated_at = now()
        WHERE id = $1 AND stock_quantity IS NOT NULL AND stock_quantity >= $2 RETURNING id`,
      [v.id, v.qty]
    );
    if (done.rowCount === 0) {
      const now = await client.query('SELECT stock_quantity FROM product_option_values WHERE id = $1', [v.id]);
      const row = now.rows[0];
      if (!row || row.stock_quantity !== null) throw new StockError(`${v.label} ${left(Number(row?.stock_quantity) || 0)}.`);
    } else {
      movements.push({ kind: 'option', id: v.id, qty: v.qty });
    }
  }
  return movements;
}

/**
 * Insert an order (and its coupon usage) atomically.
 *
 * - Stock is taken in the same transaction (see decrementStock), for COD and for paid Razorpay orders alike.
 * - The order number comes from a PostgreSQL sequence, so concurrent checkouts can never share a number.
 * - When a coupon is used its row is locked, the limits are re-checked, and used_count is incremented
 *   in the same transaction as the order, so a usage limit cannot be overshot by simultaneous orders.
 * - For online payments a repeat of the same Razorpay payment id returns the existing order.
 */
export async function createOrder(params: {
  quote: CartQuote;
  customer: CleanCustomer;
  paymentMethod: 'cod' | 'online';
  payment?: RazorpayPayment;
}): Promise<any> {
  const { quote, customer, paymentMethod, payment } = params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (quote.coupon) {
      const locked = await client.query(
        'SELECT usage_limit, used_count, per_user_limit FROM coupons WHERE id = $1 FOR UPDATE',
        [quote.coupon.id]
      );
      const c = locked.rows[0];
      if (!c) throw new PricingError('Coupon is no longer available');
      if (c.usage_limit && c.used_count >= c.usage_limit) throw new PricingError('Coupon usage limit exceeded');
      if (c.per_user_limit) {
        const used = await client.query(
          'SELECT COUNT(*) FROM coupon_usage WHERE coupon_id = $1 AND customer_email = $2',
          [quote.coupon.id, customer.email]
        );
        if (parseInt(used.rows[0].count) >= c.per_user_limit) {
          throw new PricingError('You have already used this coupon the maximum number of times');
        }
      }
    }

    const movements = await decrementStock(client, quote.stock);

    const seq = await client.query("SELECT nextval('order_number_seq') AS n");
    const customOrderId = `${config.orderIdPrefix}#${seq.rows[0].n}`;

    const inserted = await client.query(
      `INSERT INTO orders
         (custom_order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature,
          items, subtotal, shipping_charge, cod_charge, coupon_code, coupon_discount, total_amount,
          customer_name, customer_email, customer_phone, special_requests,
          shipping_address, shipping_city, shipping_state, shipping_pincode, shipping_country,
          payment_method, status, paid_at, stock_movements)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'India',$20,$21,$22,$23)
       RETURNING *`,
      [
        customOrderId,
        payment?.order_id ?? null,
        payment?.payment_id ?? null,
        payment?.signature ?? null,
        JSON.stringify(quote.items),
        quote.subtotal,
        quote.shipping_charge,
        quote.cod_charge,
        quote.coupon?.code ?? null,
        quote.coupon_discount,
        quote.total_amount,
        customer.name,
        customer.email,
        customer.phone,
        customer.special_requests,
        customer.address,
        customer.city,
        customer.state,
        customer.pincode,
        paymentMethod,
        paymentMethod === 'online' ? 'paid' : 'pending',
        paymentMethod === 'online' ? new Date().toISOString() : null,
        JSON.stringify(movements),
      ]
    );
    const order = inserted.rows[0];

    if (quote.coupon) {
      await client.query(
        `INSERT INTO coupon_usage (coupon_id, order_id, customer_email, discount_amount, used_at)
         VALUES ($1,$2,$3,$4, now())`,
        [quote.coupon.id, order.id, customer.email, quote.coupon_discount]
      );
      await client.query(
        'UPDATE coupons SET used_count = used_count + 1, updated_at = now() WHERE id = $1',
        [quote.coupon.id]
      );
    }

    await client.query('COMMIT');
    return order;
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    // Same Razorpay payment verified twice (e.g. client retry): return the order that already exists.
    if (error?.code === '23505' && payment) {
      const existing = await pool.query('SELECT * FROM orders WHERE razorpay_payment_id = $1', [payment.payment_id]);
      if (existing.rows[0]) return existing.rows[0];
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Reasons a product must not be deleted. Empty array = safe to delete. */
export async function productDeletionBlockers(productId: string): Promise<string[]> {
  const [orders, orderItems, combos, customCombos] = await Promise.all([
    // Orders store their line items as JSONB; a product id can appear as an item id, product_id
    // or inside a combo's product list, so search the serialised items for the id.
    pool.query('SELECT 1 FROM orders WHERE items::text LIKE $1 LIMIT 1', [`%${productId}%`]),
    pool.query('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', [productId]),
    pool.query('SELECT 1 FROM combo_products WHERE product_id = $1 LIMIT 1', [productId]),
    pool.query('SELECT 1 FROM custom_combo_products WHERE product_id = $1 LIMIT 1', [productId]),
  ]);

  const blockers: string[] = [];
  if (orders.rows.length || orderItems.rows.length) {
    blockers.push('Cannot delete product that has existing orders. Consider deactivating it instead.');
  }
  if (combos.rows.length) {
    blockers.push('Cannot delete product that is part of a combo. Remove it from combos first.');
  }
  if (customCombos.rows.length) {
    blockers.push('Cannot delete product that is part of a customer-built combo. Consider deactivating it instead.');
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Stock restoration and admin order updates
// ---------------------------------------------------------------------------

export class OrderRuleError extends PricingError {}

/**
 * Give an order's stock back, exactly once.
 *
 * The source of truth is orders.stock_movements: the rows that were ACTUALLY decremented when the order was
 * placed (untracked stock was never recorded, so it is never "restored"). The order row is locked, so two
 * simultaneous cancel/refund requests cannot both restore; stock_restored_at makes every later call a no-op.
 * If a product or option has since been deleted or switched to "not tracked", it is skipped.
 * Runs inside the caller's transaction. The order's item snapshot is never touched.
 */
export async function restoreStockInTx(client: Db, orderId: string): Promise<{ restored: boolean; reason?: string }> {
  const locked = await client.query('SELECT stock_movements, stock_restored_at FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const order = locked.rows[0];
  if (!order) return { restored: false, reason: 'order not found' };
  if (order.stock_restored_at) return { restored: false, reason: 'already restored' };

  const movements: StockMovement[] = Array.isArray(order.stock_movements) ? order.stock_movements : [];
  if (movements.length === 0) return { restored: false, reason: 'nothing was decremented for this order' };

  for (const m of [...movements].sort((a, b) => a.id.localeCompare(b.id))) {
    if (m.kind === 'product') {
      await client.query(
        'UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = now() WHERE id = $1 AND track_stock',
        [m.id, m.qty]
      );
    } else {
      await client.query(
        'UPDATE product_option_values SET stock_quantity = stock_quantity + $2, updated_at = now() WHERE id = $1 AND stock_quantity IS NOT NULL',
        [m.id, m.qty]
      );
    }
  }
  await client.query('UPDATE orders SET stock_restored_at = now() WHERE id = $1', [orderId]);
  return { restored: true };
}

/** Restore an order's stock in its own transaction (used after a refund has been recorded). */
export async function restoreOrderStock(orderId: string): Promise<{ restored: boolean; reason?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await restoreStockInTx(client, orderId);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface AdminOrderUpdate {
  status?: string;
  tracking_number?: string | null;
  admin_notes?: string | null;
}

/**
 * The single place an admin changes an order's status / tracking number / notes.
 *
 * Rules:
 *  - 'refunded' and 'partially_refunded' cannot be set by hand: only a provider-confirmed refund sets them.
 *  - A fully refunded order is final.
 *  - Cancelling (from pending / processing / paid / shipped) gives the order's stock back, once, in the same
 *    transaction as the status change. A delivered order cannot be cancelled (the goods are gone).
 *  - A cancelled order whose stock was restored cannot be re-opened (it would sell stock twice); place a new order.
 * Returns statusChanged so callers only email real changes.
 */
export async function applyAdminOrderUpdate(orderId: string, fields: AdminOrderUpdate): Promise<{ order: any; statusChanged: boolean; stockRestored: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const current = locked.rows[0];
    if (!current) throw new OrderRuleError('Order not found', 404);

    const target = fields.status;
    const statusChanged = target !== undefined && target !== current.status;
    let stockRestored = false;

    if (target !== undefined && target !== current.status) {
      if (target === 'refunded' || target === 'partially_refunded') {
        throw new OrderRuleError('Refund statuses are set only by a confirmed refund. Use the refund action.', 400);
      }
      if (current.status === 'refunded') throw new OrderRuleError('A fully refunded order cannot be changed.', 409);
      if (current.status === 'cancelled' && current.stock_restored_at) {
        throw new OrderRuleError('This order was cancelled and its stock returned; it cannot be re-opened. Place a new order instead.', 409);
      }
      if (target === 'cancelled' && current.status === 'delivered') {
        throw new OrderRuleError('A delivered order cannot be cancelled.', 409);
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (col: string, v: unknown) => { values.push(v); sets.push(`${col} = $${values.length}`); };
    if (statusChanged) add('status', target);
    if (fields.tracking_number !== undefined) add('tracking_number', fields.tracking_number);
    if (fields.admin_notes !== undefined) add('admin_notes', fields.admin_notes);

    let order = current;
    if (sets.length > 0) {
      values.push(orderId);
      const updated = await client.query(
        `UPDATE orders SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
        values
      );
      order = updated.rows[0];
    }

    // Cancelling (also re-sending "cancelled" on an already-cancelled order) returns stock once.
    if (target === 'cancelled') {
      stockRestored = (await restoreStockInTx(client, orderId)).restored;
      if (stockRestored) order = (await client.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    }

    await client.query('COMMIT');
    return { order, statusChanged, stockRestored };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
