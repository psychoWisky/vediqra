import express, { Request, Response } from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { orderLimiter } from '../middleware/rateLimit';
import { priceCart, PricingError } from '../services/pricing';
import { cleanCustomer, createOrder, applyAdminOrderUpdate } from '../services/orderService';
import { isUuid, ORDER_STATUSES } from '../utils/sql';
import {
  sendOrderConfirmationEmail,
  sendAdminNotification,
  sendOrderStatusUpdateEmail,
} from '../services/gmailService';

const router = express.Router();

function transformOrder(o: any) {
  return {
    ...o,
    total_amount: parseFloat(o.total_amount) || 0,
    subtotal: o.subtotal != null ? parseFloat(o.subtotal) || 0 : o.subtotal,
    grand_total: o.grand_total != null ? parseFloat(o.grand_total) || 0 : o.grand_total,
    coupon_discount: o.coupon_discount != null ? parseFloat(o.coupon_discount) || 0 : o.coupon_discount,
    shipping_charge: o.shipping_charge != null ? parseFloat(o.shipping_charge) || 0 : o.shipping_charge,
    cod_charge: o.cod_charge != null ? parseFloat(o.cod_charge) || 0 : o.cod_charge,
  };
}

// Customer-facing order view (order-confirmation page, order tracking). Deliberately an allow-list, not the raw
// row minus a few fields: a new internal column (payment provider ids, refund/stock-ledger data, admin notes ...)
// is excluded by default instead of leaking until someone remembers to add it to a blocklist.
// `payment_method` says how the order was paid ('cod' | 'online'); no provider id, signature or refund data.
function customerOrderView(o: any) {
  return {
    id: o.id,
    custom_order_id: o.custom_order_id,
    status: o.status,
    items: o.items,
    subtotal: o.subtotal != null ? parseFloat(o.subtotal) || 0 : o.subtotal,
    shipping_charge: o.shipping_charge != null ? parseFloat(o.shipping_charge) || 0 : o.shipping_charge,
    cod_charge: o.cod_charge != null ? parseFloat(o.cod_charge) || 0 : o.cod_charge,
    coupon_code: o.coupon_code,
    coupon_discount: o.coupon_discount != null ? parseFloat(o.coupon_discount) || 0 : o.coupon_discount,
    total_amount: parseFloat(o.total_amount) || 0,
    payment_method: o.payment_method,
    customer_name: o.customer_name,
    customer_email: o.customer_email,
    customer_phone: o.customer_phone,
    special_requests: o.special_requests,
    shipping_address: o.shipping_address,
    shipping_city: o.shipping_city,
    shipping_state: o.shipping_state,
    shipping_pincode: o.shipping_pincode,
    shipping_country: o.shipping_country,
    tracking_number: o.tracking_number,
    created_at: o.created_at,
  };
}

const handlePricingError = (res: Response, error: any, fallbackLog: string) => {
  if (error instanceof PricingError) return res.status(error.status).json({ error: error.message });
  console.error(fallbackLog, error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
};

// PUBLIC: track an order by custom order id + phone number.
router.get('/track', async (req: Request, res: Response) => {
  try {
    const { orderId, phone } = req.query;
    if (!orderId || !phone) {
      return res.status(400).json({ error: 'Order ID and phone number are required' });
    }

    const result = await pool.query(
      'SELECT * FROM orders WHERE custom_order_id = $1 AND customer_phone = $2',
      [orderId, phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(customerOrderView(result.rows[0]));
  } catch (error: any) {
    console.error('Error tracking order:', error);
    res.status(500).json({ error: 'Failed to track order' });
  }
});

// PUBLIC: the order-confirmation page reads the order it just created. The order id is an
// unguessable UUID that only the purchaser receives. Internal/payment fields are not returned.
router.get('/confirmation/:id', async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Order not found' });
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(customerOrderView(result.rows[0]));
  } catch (error: any) {
    console.error('Error fetching order confirmation:', error);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// PUBLIC (rate limited): price a cart on the server so the checkout page shows the amounts that will be charged.
router.post('/quote', orderLimiter, async (req: Request, res: Response) => {
  try {
    const { items, coupon_code, email, payment_method } = req.body || {};
    const quote = await priceCart(pool, items, {
      couponCode: coupon_code,
      email: typeof email === 'string' ? email.trim().toLowerCase() : undefined,
      paymentMethod: payment_method === 'cod' ? 'cod' : 'online',
    });
    res.json({
      subtotal: quote.subtotal,
      shipping_charge: quote.shipping_charge,
      cod_charge: quote.cod_charge,
      coupon: quote.coupon,
      coupon_discount: quote.coupon_discount,
      total_amount: quote.total_amount,
      // Configured checkout rules (not secrets): lets the frontend show the actual shipping/COD rules
      // instead of keeping its own copy, and derive a COD estimate from one 'online' quote instead of two calls.
      shipping_threshold: quote.shipping_threshold,
      shipping_fee: quote.shipping_fee,
      cod_fee: quote.cod_fee,
      // Priced lines (server-computed price, and for a custom combo its base_price/discount_percentage before
      // the tier discount). Nothing here is more sensitive than what the customer put in the cart themselves;
      // this lets the custom-combo builder show real subtotal/discount/total without a separate endpoint or
      // reimplementing the tier formula client-side.
      items: quote.items,
    });
  } catch (error: any) {
    handlePricingError(res, error, 'Error pricing cart:');
  }
});

// ADMIN ONLY: list orders.
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows.map(transformOrder));
  } catch (error: any) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: order statistics (declared before /:id so it is not shadowed).
router.get('/admin/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total_orders,
         SUM(total_amount) AS total_revenue,
         COUNT(*) FILTER (WHERE status = 'paid') AS paid_orders,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_orders,
         COUNT(*) FILTER (WHERE status = 'shipped') AS shipped_orders,
         COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_orders,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders
       FROM orders`
    );
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error fetching order stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: customer order lookup by phone (was public and leaked names/addresses).
router.get('/customer/:phone', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE customer_phone = $1 ORDER BY created_at DESC',
      [req.params.phone]
    );
    res.json(result.rows.map(transformOrder));
  } catch (error: any) {
    console.error('Error fetching customer orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: single order.
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Order not found' });
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(transformOrder(result.rows[0]));
  } catch (error: any) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: update order status. Emails the customer only when the status really changed
// (repeating the same status is a no-op). Cancelling returns the order's stock once.
router.patch('/:id/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!isUuid(id)) return res.status(404).json({ error: 'Order not found' });
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${ORDER_STATUSES.join(', ')}` });
    }

    const { order, statusChanged, stockRestored } = await applyAdminOrderUpdate(id, { status });
    if (statusChanged) {
      sendOrderStatusUpdateEmail({ ...order, old_status: undefined, new_status: order.status } as any).catch((err: any) =>
        console.error('Error sending status update email:', err)
      );
    }

    res.json({ success: true, order, status_changed: statusChanged, stock_restored: stockRestored });
  } catch (error: any) {
    if (error instanceof PricingError) return res.status(error.status).json({ error: error.message });
    console.error('Error updating order status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: (re)send the status email for an order. Called by the admin order screen after a status
// or tracking-number change. Never public: it sends mail to the customer.
router.post('/send-status-email', requireAuth, async (req: Request, res: Response) => {
  try {
    const { orderId, oldStatus, newStatus, trackingNumber } = req.body || {};
    if (!isUuid(orderId)) return res.status(400).json({ success: false, error: 'Valid orderId is required' });

    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = result.rows[0];

    const status = newStatus || order.status;
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });
    // The email must describe the order as it really is: refuse to announce a status the order does not have.
    if (status !== order.status) {
      return res.status(409).json({ success: false, error: `Order is "${order.status}", not "${status}". Update the order first.` });
    }

    const email = await sendOrderStatusUpdateEmail({
      ...order,
      tracking_number: typeof trackingNumber === 'string' && trackingNumber ? trackingNumber : order.tracking_number,
      old_status: typeof oldStatus === 'string' ? oldStatus : order.status,
      new_status: status,
    });
    res.json({ success: email.success, ...(email.success ? {} : { error: 'Email could not be sent' }) });
  } catch (error: any) {
    console.error('Error sending status email:', error);
    res.status(500).json({ success: false, error: 'Failed to send status email' });
  }
});

// PUBLIC (rate limited): place a Cash-on-Delivery order. Amounts are computed by the server.
router.post('/cod', orderLimiter, async (req: Request, res: Response) => {
  try {
    // The storefront sends the fields at the top level; older clients wrapped them in `order_data`.
    const data = req.body?.order_data ?? req.body ?? {};
    const customer = cleanCustomer(data);

    const quote = await priceCart(pool, data.items, {
      couponCode: data.coupon_code,
      email: customer.email,
      paymentMethod: 'cod',
    });

    const order = await createOrder({ quote, customer, paymentMethod: 'cod' });

    Promise.allSettled([
      sendOrderConfirmationEmail(order),
      sendAdminNotification(order),
    ]);

    res.json({
      success: true,
      order: {
        id: order.id,
        custom_order_id: order.custom_order_id,
        tracking_id: order.custom_order_id,
      },
    });
  } catch (error: any) {
    handlePricingError(res, error, 'Error creating COD order:');
  }
});

export default router;
