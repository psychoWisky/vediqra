import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { buildUpdate, isUuid } from '../utils/sql';

const router = express.Router();

console.log('✅ categories routes loaded');

// ========== PUBLIC ROUTES ==========

// Get all active categories.
//   (default)       flat list, top-level and subcategories together (each row has parent_id)
//   ?tree=1         top-level categories with their active subcategories nested under `children`
//   ?parent=<id|slug|root>   only the subcategories of a category, or only top-level ones for "root"
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, parent_id, banner_url, description, icon, icon_type, image_url, color, hover_effect,
              display_order, is_active, created_at, updated_at
         FROM categories WHERE is_active = true ORDER BY display_order ASC, name ASC`
    );
    let rows = result.rows;

    const parent = typeof req.query.parent === 'string' ? req.query.parent : undefined;
    if (parent === 'root') {
      rows = rows.filter((c: any) => !c.parent_id);
    } else if (parent) {
      const p = rows.find((c: any) => c.id === parent || c.slug === parent);
      rows = p ? rows.filter((c: any) => c.parent_id === p.id) : [];
    }

    if (req.query.tree === '1' || req.query.tree === 'true') {
      const top = rows.filter((c: any) => !c.parent_id);
      return res.json(top.map((c: any) => ({ ...c, children: rows.filter((k: any) => k.parent_id === c.id) })));
    }
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get single category by ID or slug
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      isUuid(id) ? 'SELECT * FROM categories WHERE id = $1' : 'SELECT * FROM categories WHERE slug = $1',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const category = result.rows[0];
    const children = await pool.query(
      'SELECT id, name, slug FROM categories WHERE parent_id = $1 AND is_active = true ORDER BY display_order, name',
      [category.id]
    );
    res.json({ ...category, children: children.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ADMIN ROUTES ==========

// Get all categories for admin (including inactive)
router.get('/admin/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY display_order ASC');
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new category
router.post('/admin/categories', requireAuth, async (req, res) => {
  try {
    const { name, description, icon, icon_type, color, hover_effect, display_order, gender, is_active } = req.body;
    const now = new Date().toISOString();

    const result = await pool.query(
      `INSERT INTO categories (name, description, icon, icon_type, color, hover_effect,
        display_order, gender, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        name,
        description,
        icon || '🎁',
        icon_type || 'emoji',
        color || 'from-premium-gold/20 to-premium-cream',
        hover_effect || 'scale',
        display_order || 0,
        gender || null,
        is_active !== undefined ? is_active : true,
        now,
        now,
      ]
    );

    res.json({ success: true, category: result.rows[0] });
  } catch (err: any) {
    console.error('Error creating category:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update category
router.put('/admin/categories/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const query = buildUpdate('categories', req.body, id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });

    const result = await pool.query(query.text, query.values);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, category: result.rows[0] });
  } catch (err: any) {
    console.error('Error updating category:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete category
router.delete('/admin/categories/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const children = await pool.query('SELECT COUNT(*)::int AS n FROM categories WHERE parent_id = $1', [id]);
    if (children.rows[0].n > 0) {
      return res.status(400).json({ error: 'Cannot delete a category that has subcategories' });
    }
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM product_categories WHERE category_id = $1',
      [id]
    );
    const count = parseInt(countResult.rows[0].count);

    if (count > 0) {
      return res.status(400).json({
        error: 'Cannot delete category that is assigned to products',
        productCount: count,
      });
    }

    await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting category:', err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle category status
router.patch('/admin/categories/:id/toggle', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const result = await pool.query(
      `UPDATE categories SET is_active = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
      [is_active, new Date().toISOString(), id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, category: result.rows[0] });
  } catch (err: any) {
    console.error('Error toggling category status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get category statistics
router.get('/admin/stats', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.is_active,
              COUNT(pc.product_id) AS product_count
       FROM categories c
       LEFT JOIN product_categories pc ON pc.category_id = c.id
       GROUP BY c.id, c.name, c.is_active`
    );

    const categories = result.rows;
    const stats = {
      total_categories: categories.length,
      active_categories: categories.filter((c) => c.is_active).length,
      inactive_categories: categories.filter((c) => !c.is_active).length,
      categories_with_products: categories.filter((c) => parseInt(c.product_count) > 0).length,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        product_count: parseInt(c.product_count),
      })),
    };

    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
