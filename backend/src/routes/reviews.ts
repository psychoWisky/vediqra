import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { publicWriteLimiter } from '../middleware/rateLimit';

const router = express.Router();

// ========== PUBLIC ROUTES ==========

// Get approved reviews for a product
router.get('/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query(
      `SELECT * FROM reviews
       WHERE product_id = $1 AND is_approved = true
       ORDER BY created_at DESC`,
      [productId]
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: error.message });
  }
});

// Submit a review
router.post('/', publicWriteLimiter, async (req, res) => {
  try {
    const { product_id, user_name, user_email, rating, comment } = req.body;

    if (!product_id || !user_name || !rating || !comment) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const now = new Date().toISOString();
    const result = await pool.query(
      `INSERT INTO reviews
         (product_id, user_name, user_email, rating, comment, is_approved, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [product_id, user_name, user_email, rating, comment, false, now, now]
    );

    res.json({
      success: true,
      message: 'Review submitted successfully and is pending approval',
      review: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error submitting review:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== ADMIN ROUTES ==========

// Get all reviews (admin)
router.get('/admin', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ONLY: review counts for the moderation screen
router.get('/admin/stats', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_approved)::int AS approved,
              COUNT(*) FILTER (WHERE NOT is_approved)::int AS pending,
              COALESCE(ROUND(AVG(rating)::numeric, 1), 0) AS average
         FROM reviews`
    );
    const r = result.rows[0];
    res.json({
      totalReviews: r.total,
      approvedReviews: r.approved,
      pendingReviews: r.pending,
      averageRating: Number(r.average),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Approve / reject a review. The moderation screen calls PUT .../:id/approve; PATCH .../:id is kept as an alias.
const setApproval = async (req: express.Request, res: express.Response) => {
  try {
    const { id } = req.params;
    const { is_approved } = req.body;

    const result = await pool.query(
      `UPDATE reviews SET is_approved = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
      [is_approved, new Date().toISOString(), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true, review: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
router.put('/admin/:id/approve', requireAuth, setApproval);
router.patch('/admin/:id', requireAuth, setApproval);

// Delete a review
router.delete('/admin/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
