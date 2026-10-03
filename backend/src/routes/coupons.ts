import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { couponLimiter } from '../middleware/rateLimit';
import { evaluateCoupon } from '../services/pricing';
import { buildInsert, buildUpdate, isUuid } from '../utils/sql';

const router = express.Router();

const normaliseCode = (body: Record<string, any>) => {
  if (typeof body.code === 'string') body.code = body.code.trim().toUpperCase();
};

// ADMIN ONLY: all coupons.
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching coupons:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUBLIC: active coupons for checkout.
router.get('/active', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const result = await pool.query(
      `SELECT code, description, discount_type, discount_value,
              min_order_amount, max_discount_amount
       FROM coupons
       WHERE is_active = true
         AND (start_date IS NULL OR start_date <= $1)
         AND (end_date   IS NULL OR end_date   >= $1)
       ORDER BY created_at DESC`,
      [now]
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching active coupons:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUBLIC (rate limited): preview a coupon. The final discount is always recomputed by the server when the order is placed.
router.post('/validate', couponLimiter, async (req, res) => {
  try {
    const { code, subtotal, email, categories, hasOnlyComboItems } = req.body || {};

    if (!code) return res.status(400).json({ valid: false, message: 'Coupon code is required' });
    if (hasOnlyComboItems) {
      return res.status(400).json({ valid: false, message: 'Coupons cannot be applied to combo orders' });
    }

    const check = await evaluateCoupon(pool, {
      code: String(code),
      subtotal: Number(subtotal) || 0,
      email: typeof email === 'string' ? email : undefined,
      categories: Array.isArray(categories) ? categories.filter((c: unknown) => typeof c === 'string') : [],
    });

    if (!check.ok) return res.status(check.status).json({ valid: false, message: check.message });
    res.json({ valid: true, coupon: check.coupon });
  } catch (error: any) {
    console.error('Error validating coupon:', error);
    res.status(500).json({ valid: false, message: 'Error validating coupon' });
  }
});

// ADMIN ONLY: usage history of one coupon.
router.get('/:id/usage', requireAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Coupon not found' });
    const result = await pool.query(
      `SELECT id, coupon_id, order_id, customer_email, discount_amount, used_at
       FROM coupon_usage WHERE coupon_id = $1 ORDER BY used_at DESC`,
      [req.params.id]
    );
    res.json(result.rows.map((r) => ({ ...r, discount_amount: parseFloat(r.discount_amount) || 0 })));
  } catch (error: any) {
    console.error('Error fetching coupon usage:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: create coupon.
router.post('/', requireAuth, async (req, res) => {
  try {
    const body = { ...req.body };
    normaliseCode(body);
    if (!body.code || !body.discount_type || body.discount_value === undefined) {
      return res.status(400).json({ error: 'code, discount_type and discount_value are required' });
    }
    // used_count is server-managed: a new coupon always starts at 0.
    const query = buildInsert('coupons', body, { used_count: 0 });
    const result = await pool.query(query.text, query.values);
    res.json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'A coupon with this code already exists' });
    console.error('Error creating coupon:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: update coupon.
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const body = { ...req.body };
    normaliseCode(body);
    const query = buildUpdate('coupons', body, id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });

    const result = await pool.query(query.text, query.values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Coupon not found' });
    res.json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'A coupon with this code already exists' });
    console.error('Error updating coupon:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: delete coupon and its usage log.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM coupon_usage WHERE coupon_id = $1', [id]);
    await pool.query('DELETE FROM coupons WHERE id = $1', [id]);
    res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting coupon:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: manual usage entry. Orders record coupon usage themselves inside the order transaction,
// so this endpoint was removed from public access (anyone could burn a coupon's usage limit).
router.post('/track-usage', requireAuth, async (req, res) => {
  try {
    const { coupon_id, order_id, customer_email, discount_amount } = req.body || {};
    if (!isUuid(coupon_id)) return res.status(400).json({ error: 'Valid coupon_id is required' });

    await pool.query(
      `INSERT INTO coupon_usage (coupon_id, order_id, customer_email, discount_amount, used_at)
       VALUES ($1,$2,$3,$4, now())`,
      [coupon_id, isUuid(order_id) ? order_id : null, customer_email, Number(discount_amount) || 0]
    );
    await pool.query('UPDATE coupons SET used_count = used_count + 1, updated_at = now() WHERE id = $1', [coupon_id]);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error tracking coupon usage:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
