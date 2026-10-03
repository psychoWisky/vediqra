import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { attachOptions } from '../services/options';
import { publicWriteLimiter } from '../middleware/rateLimit';

const router = express.Router();

// ========== PUBLIC ROUTES ==========

// Get all active combos for public view
router.get('/', async (req, res) => {
  try {
    const combosResult = await pool.query(
      `SELECT c.*,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object(
                  'quantity', cp.quantity,
                  'product', jsonb_build_object(
                    'id', p.id, 'name', p.name, 'price', p.price,
                    'image_url', p.image_url, 'description', p.description,
                    'is_active', p.is_active
                  )
                )) FILTER (WHERE cp.product_id IS NOT NULL), '[]'::jsonb
              ) AS combo_products,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
              ) AS combo_categories
       FROM combos c
       LEFT JOIN combo_products cp ON cp.combo_id = c.id
       LEFT JOIN products p ON p.id = cp.product_id
       LEFT JOIN combo_categories cc ON cc.combo_id = c.id
       LEFT JOIN categories cat ON cat.id = cc.category_id
       WHERE c.is_active = true
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    );

    const data = combosResult.rows.map((combo: any) => ({
      ...combo,
      categories: (combo.combo_categories || []).map((cc: any) => cc.category),
      combo_products: (combo.combo_products || []).map((cp: any) => ({
        ...cp,
        product: cp.product
          ? {
              ...cp.product,
              colors: [], // colors/sizes fetched separately if needed
              sizes: [],
            }
          : cp.product,
      })),
    }));

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching combos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single combo by ID (public) — includes colors + sizes per product
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Step 1: fetch the combo with its products (basic fields)
    const result = await pool.query(
      `SELECT c.*,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('quantity', cp.quantity, 'product', to_jsonb(p.*)))
                FILTER (WHERE cp.product_id IS NOT NULL), '[]'::jsonb
              ) AS combo_products,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
              ) AS combo_categories
       FROM combos c
       LEFT JOIN combo_products cp ON cp.combo_id = c.id
       LEFT JOIN products p ON p.id = cp.product_id
       LEFT JOIN combo_categories cc ON cc.combo_id = c.id
       LEFT JOIN categories cat ON cat.id = cc.category_id
       WHERE c.id = $1 AND c.is_active = true
       GROUP BY c.id`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Combo not found' });

    const combo = result.rows[0];
    const rawProducts: any[] = combo.combo_products || [];

    // Step 2: attach each product's option groups (plus the colour/size shapes the storefront reads)
    const withOptions = await attachOptions(
      pool,
      rawProducts.filter((cp: any) => cp.product?.id).map((cp: any) => cp.product)
    );
    const enrichedProducts = rawProducts.map((cp: any) =>
      cp.product?.id ? { ...cp, product: withOptions.find((p: any) => p.id === cp.product.id) } : cp
    );

    res.json({
      ...combo,
      categories: (combo.combo_categories || []).map((cc: any) => cc.category),
      combo_products: enrichedProducts,
    });
  } catch (error: any) {
    console.error('Error fetching combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get combos by category (public)
router.get('/category/:categoryId', async (req, res) => {
  try {
    const { categoryId } = req.params;
    const result = await pool.query(
      `SELECT c.*,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
              ) AS combo_categories
       FROM combo_categories cc2
       JOIN combos c ON c.id = cc2.combo_id AND c.is_active = true
       LEFT JOIN combo_categories cc ON cc.combo_id = c.id
       LEFT JOIN categories cat ON cat.id = cc.category_id
       WHERE cc2.category_id = $1
       GROUP BY c.id`,
      [categoryId]
    );

    const combos = result.rows.map((combo: any) => ({
      ...combo,
      categories: (combo.combo_categories || []).map((cc: any) => cc.category),
    }));
    res.json(combos);
  } catch (error: any) {
    console.error('Error fetching combos by category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create custom combo (public)
router.post('/custom', publicWriteLimiter, async (req, res) => {
  try {
    const {
      name, description, products, subtotal,
      discount_percentage, discount_amount, total_price,
      special_requests, item_count,
    } = req.body;

    if (!products || products.length === 0) {
      return res.status(400).json({ error: 'At least one product is required' });
    }

    const now = new Date().toISOString();
    const customComboResult = await pool.query(
      `INSERT INTO custom_combos
         (name, description, subtotal, discount_percentage, discount_amount,
          total_price, item_count, special_requests, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        name || 'Custom Combo', description || '', subtotal,
        discount_percentage, discount_amount, total_price,
        item_count, special_requests, 'pending', now,
      ]
    );

    const customCombo = customComboResult.rows[0];

    const comboProducts = products.map((p: any) => ({
      custom_combo_id: customCombo.id,
      product_id: p.id,
      quantity: p.quantity || 1,
    }));

    for (const cp of comboProducts) {
      await pool.query(
        'INSERT INTO custom_combo_products (custom_combo_id, product_id, quantity) VALUES ($1,$2,$3)',
        [cp.custom_combo_id, cp.product_id, cp.quantity]
      );
    }

    res.json({ success: true, message: 'Custom combo created successfully', combo: customCombo });
  } catch (error: any) {
    console.error('Error creating custom combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== ADMIN ROUTES ==========

// Get all combos (admin)
router.get('/admin/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('quantity', cp.quantity, 'product', to_jsonb(p.*)))
                FILTER (WHERE cp.product_id IS NOT NULL), '[]'::jsonb
              ) AS combo_products,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
              ) AS combo_categories
       FROM combos c
       LEFT JOIN combo_products cp ON cp.combo_id = c.id
       LEFT JOIN products p ON p.id = cp.product_id
       LEFT JOIN combo_categories cc ON cc.combo_id = c.id
       LEFT JOIN categories cat ON cat.id = cc.category_id
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    );

    const data = result.rows.map((combo: any) => ({
      ...combo,
      categories: (combo.combo_categories || []).map((cc: any) => cc.category),
    }));
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching combos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single combo for admin
router.get('/admin/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT c.*,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('quantity', cp.quantity, 'product', to_jsonb(p.*)))
                FILTER (WHERE cp.product_id IS NOT NULL), '[]'::jsonb
              ) AS combo_products,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
              ) AS combo_categories
       FROM combos c
       LEFT JOIN combo_products cp ON cp.combo_id = c.id
       LEFT JOIN products p ON p.id = cp.product_id
       LEFT JOIN combo_categories cc ON cc.combo_id = c.id
       LEFT JOIN categories cat ON cat.id = cc.category_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Combo not found' });
    const combo = result.rows[0];
    res.json({ ...combo, categories: (combo.combo_categories || []).map((cc: any) => cc.category) });
  } catch (error: any) {
    console.error('Error fetching combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create combo (admin)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description, discount_percentage, discount_price, image_url, additional_images, is_active } = req.body;
    if (!name) return res.status(400).json({ error: 'Combo name is required' });

    const now = new Date().toISOString();
    const result = await pool.query(
      `INSERT INTO combos
         (name, description, discount_percentage, discount_price, image_url,
          additional_images, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        name, description || '', discount_percentage || null,
        discount_price || null, image_url || '',
        additional_images !== undefined ? additional_images : null,
        is_active !== undefined ? is_active : true, now, now,
      ]
    );

    console.log('Combo created:', result.rows[0]);
    res.json({ success: true, combo: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update combo (admin)
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, discount_percentage, discount_price, image_url, additional_images, is_active } = req.body;

    const result = await pool.query(
      `UPDATE combos
       SET name=$1, description=$2, discount_percentage=$3, discount_price=$4,
           image_url=$5, additional_images=$6, is_active=$7, updated_at=$8
       WHERE id=$9
       RETURNING *`,
      [
        name, description, discount_percentage || null, discount_price || null,
        image_url,
        additional_images !== undefined ? additional_images : null,
        is_active, new Date().toISOString(), id,
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Combo not found' });
    console.log('Combo updated:', result.rows[0]);
    res.json({ success: true, combo: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete combo (admin)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM combo_products WHERE combo_id = $1', [id]);
    await pool.query('DELETE FROM combo_categories WHERE combo_id = $1', [id]);
    await pool.query('DELETE FROM combos WHERE id = $1', [id]);
    res.json({ success: true, message: 'Combo deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add products to combo (admin)
router.post('/:id/products', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { products } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'At least one product is required' });
    }

    const results = [];
    for (const p of products) {
      const result = await pool.query(
        'INSERT INTO combo_products (combo_id, product_id, quantity) VALUES ($1,$2,$3) RETURNING *',
        [id, p.product_id, p.quantity || 1]
      );
      results.push(result.rows[0]);
    }

    console.log(`Added ${results.length} products to combo ${id}`);
    res.json({ success: true, products: results });
  } catch (error: any) {
    console.error('Error adding products to combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete all products from combo (admin)
router.delete('/:id/products', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM combo_products WHERE combo_id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting products from combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add categories to combo (admin)
router.post('/:id/categories', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'At least one category is required' });
    }

    const results = [];
    for (const c of categories) {
      const result = await pool.query(
        `INSERT INTO combo_categories (combo_id, category_id) VALUES ($1,$2)
         RETURNING *, (SELECT to_jsonb(cat.*) FROM categories cat WHERE cat.id = category_id) AS category`,
        [id, c.category_id]
      );
      results.push(result.rows[0]);
    }

    console.log(`Added ${results.length} categories to combo ${id}`);
    res.json({ success: true, categories: results });
  } catch (error: any) {
    console.error('Error adding categories to combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete all categories from combo (admin)
router.delete('/:id/categories', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM combo_categories WHERE combo_id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting categories from combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update specific product quantity in combo (admin)
router.put('/:id/products/:productId', requireAuth, async (req, res) => {
  try {
    const { id, productId } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity < 1) return res.status(400).json({ error: 'Valid quantity is required' });

    const result = await pool.query(
      `UPDATE combo_products SET quantity = $1
       WHERE combo_id = $2 AND product_id = $3 RETURNING *`,
      [quantity, id, productId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found in combo' });
    res.json({ success: true, product: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating product quantity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove specific product from combo (admin)
router.delete('/:id/products/:productId', requireAuth, async (req, res) => {
  try {
    const { id, productId } = req.params;
    await pool.query(
      'DELETE FROM combo_products WHERE combo_id = $1 AND product_id = $2',
      [id, productId]
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error removing product from combo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get combo statistics (admin)
router.get('/stats/summary', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.is_active, COUNT(cp.product_id) AS product_count
       FROM combos c
       LEFT JOIN combo_products cp ON cp.combo_id = c.id
       GROUP BY c.id`
    );
    const data = result.rows;
    const total = data.length;
    const stats = {
      total_combos: total,
      active_combos: data.filter((c: any) => c.is_active).length,
      inactive_combos: data.filter((c: any) => !c.is_active).length,
      avg_products_per_combo:
        total > 0
          ? data.reduce((acc: number, c: any) => acc + parseInt(c.product_count), 0) / total
          : 0,
    };
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching combo stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk add / upsert products to combo (admin)
router.post('/:id/products/bulk', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { products } = req.body;

    if (!products || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Products array is required' });
    }

    const results = [];
    for (const product of products) {
      const result = await pool.query(
        `INSERT INTO combo_products (combo_id, product_id, quantity)
         VALUES ($1,$2,$3)
         ON CONFLICT (combo_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity
         RETURNING *`,
        [id, product.product_id, product.quantity || 1]
      );
      results.push(result.rows[0]);
    }

    res.json({ success: true, products: results });
  } catch (error: any) {
    console.error('Error bulk adding products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get available products for combo (admin)
router.get('/available-products', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
              ) AS product_categories
       FROM products p
       LEFT JOIN product_categories pc ON pc.product_id = p.id
       LEFT JOIN categories cat ON cat.id = pc.category_id
       WHERE p.is_active = true
       GROUP BY p.id
       ORDER BY p.name`
    );
    const data = result.rows.map((p: any) => ({
      ...p,
      categories: (p.product_categories || []).map((pc: any) => pc.category),
    }));
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching available products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all categories for combo filtering (admin)
router.get('/categories/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM categories WHERE is_active = true ORDER BY display_order'
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// Duplicate combo (admin)
router.post('/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const originalResult = await pool.query('SELECT * FROM combos WHERE id = $1', [id]);
    if (originalResult.rows.length === 0) return res.status(404).json({ error: 'Combo not found' });
    const original = originalResult.rows[0];

    const now = new Date().toISOString();
    const newComboResult = await pool.query(
      `INSERT INTO combos
         (name, description, discount_percentage, discount_price, image_url, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        `${original.name} (Copy)`, original.description,
        original.discount_percentage, original.discount_price,
        original.image_url, false, now, now,
      ]
    );
    const newCombo = newComboResult.rows[0];

    const productsResult = await pool.query(
      'SELECT product_id, quantity FROM combo_products WHERE combo_id = $1',
      [id]
    );
    for (const p of productsResult.rows) {
      await pool.query(
        'INSERT INTO combo_products (combo_id, product_id, quantity) VALUES ($1,$2,$3)',
        [newCombo.id, p.product_id, p.quantity]
      );
    }

    const categoriesResult = await pool.query(
      'SELECT category_id FROM combo_categories WHERE combo_id = $1',
      [id]
    );
    for (const c of categoriesResult.rows) {
      await pool.query(
        'INSERT INTO combo_categories (combo_id, category_id) VALUES ($1,$2)',
        [newCombo.id, c.category_id]
      );
    }

    res.json({ success: true, combo: newCombo });
  } catch (error: any) {
    console.error('Error duplicating combo:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
