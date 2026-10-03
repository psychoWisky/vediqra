import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';

const router = express.Router();

// ========== PUBLIC ROUTES ==========

// Get social proof for a product
router.get('/:productId', async (req, res) => {
  try {
    const { productId } = req.params;

    const productResult = await pool.query(
      `SELECT social_proof_enabled, social_proof_text,
              social_proof_initial_count, social_proof_end_count
       FROM products WHERE id = $1`,
      [productId]
    );
    const product = productResult.rows[0];

    if (!product?.social_proof_enabled) {
      return res.json({ text_template: '', count: 0, initial_count: 0, end_count: 0, is_enabled: false, stats: { views: 0, purchases: 0 } });
    }

    const statsResult = await pool.query(
      'SELECT * FROM social_proof_stats WHERE product_id = $1',
      [productId]
    );
    const stats = statsResult.rows[0];

    const initialCount = product.social_proof_initial_count || 5;
    const endCount = product.social_proof_end_count || 15;
    let dynamicCount = initialCount;

    if (stats) {
      const viewsContribution = Math.floor((stats.view_count || 0) / 5);
      const purchasesContribution = (stats.purchase_count || 0) * 2;
      dynamicCount = Math.min(initialCount + viewsContribution + purchasesContribution, endCount);
    }
    dynamicCount = Math.max(dynamicCount, initialCount);

    res.json({
      text_template: product.social_proof_text || '🔺 {count} people are viewing this right now',
      count: dynamicCount,
      initial_count: initialCount,
      end_count: endCount,
      is_enabled: true,
      stats: { views: stats?.view_count || 0, purchases: stats?.purchase_count || 0 },
    });
  } catch (error: any) {
    console.error('Error fetching social proof:', error);
    res.status(500).json({ error: error.message });
  }
});

// Track product view
router.post('/track-view', async (req, res) => {
  try {
    const { product_id } = req.body;
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO social_proof_stats (product_id, view_count, purchase_count, last_updated)
       VALUES ($1, 1, 0, $2)
       ON CONFLICT (product_id) DO UPDATE
         SET view_count = social_proof_stats.view_count + 1, last_updated = $2`,
      [product_id, now]
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error tracking view:', error);
    res.status(500).json({ error: error.message });
  }
});

// Track purchase
router.post('/track-purchase', async (req, res) => {
  try {
    const { product_id } = req.body;
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO social_proof_stats (product_id, view_count, purchase_count, last_updated)
       VALUES ($1, 0, 1, $2)
       ON CONFLICT (product_id) DO UPDATE
         SET purchase_count = social_proof_stats.purchase_count + 1, last_updated = $2`,
      [product_id, now]
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error tracking purchase:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== ADMIN ROUTES ==========

// Get all social proof stats
router.get('/admin/stats', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*,
              p.name AS product_name, p.price,
              p.social_proof_initial_count, p.social_proof_end_count,
              p.social_proof_text, p.social_proof_enabled
       FROM social_proof_stats s
       JOIN products p ON p.id = s.product_id
       ORDER BY s.last_updated DESC`
    );

    const formattedData = result.rows.map((stat: any) => ({
      product_id: stat.product_id,
      product_name: stat.product_name || 'Unknown',
      view_count: stat.view_count || 0,
      purchase_count: stat.purchase_count || 0,
      conversion_rate:
        stat.view_count > 0
          ? ((stat.purchase_count / stat.view_count) * 100).toFixed(1)
          : 0,
      social_proof: {
        enabled: stat.social_proof_enabled || false,
        text: stat.social_proof_text || '🔺 {count} people are viewing this right now',
        initial_count: stat.social_proof_initial_count || 5,
        end_count: stat.social_proof_end_count || 15,
      },
    }));

    res.json(formattedData);
  } catch (error: any) {
    console.error('Error fetching social proof stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update social proof settings for a product
router.put('/admin/settings/:productId', requireAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    const { text_template, initial_count, end_count, is_enabled } = req.body;

    const result = await pool.query(
      `UPDATE products
       SET social_proof_text = $1,
           social_proof_initial_count = $2,
           social_proof_end_count = $3,
           social_proof_enabled = $4,
           updated_at = $5
       WHERE id = $6
       RETURNING *`,
      [text_template, parseInt(initial_count), parseInt(end_count), is_enabled, new Date().toISOString(), productId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error updating social proof settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get social proof settings for a product
router.get('/admin/settings/:productId', requireAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query(
      `SELECT social_proof_enabled, social_proof_text,
              social_proof_initial_count, social_proof_end_count
       FROM products WHERE id = $1`,
      [productId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    const data = result.rows[0];
    res.json({
      is_enabled: data.social_proof_enabled !== false,
      text_template: data.social_proof_text || '🔺 {count} people are viewing this right now',
      initial_count: data.social_proof_initial_count || 5,
      end_count: data.social_proof_end_count || 15,
    });
  } catch (error: any) {
    console.error('Error fetching social proof settings:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
