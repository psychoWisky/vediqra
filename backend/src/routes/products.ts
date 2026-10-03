import express from 'express';
import { pool } from '../utils/db';
import { requireAuth, isAdminRequest } from '../middleware/auth';
import { buildUpdate, isUuid, normaliseSlug } from '../utils/sql';
import { sendDbError } from '../utils/http';
import { productDeletionBlockers } from '../services/orderService';
import { attachOptions, syncRequiredFlags } from '../services/options';

const router = express.Router();

// Products with their categories. Option groups/values are loaded separately (attachOptions) so one
// query no longer multiplies rows across colours x sizes x categories.
const PRODUCT_SELECT = `
  SELECT p.*,
         COALESCE(
           jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
           FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
         ) AS product_categories
    FROM products p
    LEFT JOIN product_categories pcat ON pcat.product_id = p.id
    LEFT JOIN categories cat ON cat.id = pcat.category_id`;

function transformProduct(p: any) {
  return {
    ...p,
    price: parseFloat(p.price) || 0,
    original_price: p.original_price != null ? parseFloat(p.original_price) : undefined,
    discount_percentage: p.discount_percentage != null ? parseFloat(p.discount_percentage) : undefined,
    customization_price: p.customization_price != null ? parseFloat(p.customization_price) : undefined,
    categories: (p.product_categories || []).map((pc: any) => pc.category),
  };
}

// Colours/sizes for the current storefront are derived from the "colour"/"size" option groups (see attachOptions).
async function withOptions(rows: any[], includeInactive = false) {
  const products: any[] = await attachOptions(pool, rows.map(transformProduct), { includeInactive });

  // Approved-review summary for every product in ONE query, so product cards need no request of their own.
  if (products.length > 0) {
    const stats = await pool.query(
      `SELECT product_id, COUNT(*)::int AS review_count, ROUND(AVG(rating)::numeric, 2) AS average_rating
         FROM reviews WHERE is_approved AND product_id = ANY($1::uuid[]) GROUP BY product_id`,
      [products.map((p) => p.id)]
    );
    const byProduct = new Map(stats.rows.map((r: any) => [r.product_id, r]));
    for (const p of products) {
      const r: any = byProduct.get(p.id);
      p.review_count = r ? r.review_count : 0;
      p.average_rating = r ? Number(r.average_rating) : 0;
    }
  }
  return products;
}

// Helper: fetch a full product by id or slug (with categories and options)
// Inactive products are only visible to admins (includeInactive); the public gets "not found".
async function getFullProduct(idOrSlug: string, includeInactive = false) {
  const result = await pool.query(
    `${PRODUCT_SELECT} WHERE ${isUuid(idOrSlug) ? 'p.id = $1' : 'p.slug = $1'}${includeInactive ? '' : ' AND p.is_active = true'} GROUP BY p.id`,
    [idOrSlug]
  );
  if (result.rows.length === 0) return null;
  return (await withOptions(result.rows, includeInactive))[0];
}

// A category matches its own products and those of its subcategories.
const IN_CATEGORY_TREE = `
  (SELECT id FROM categories WHERE id = $1 OR parent_id = $1)`;

// ========== PUBLIC ROUTES ==========

// Get all active products with categories and options
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `${PRODUCT_SELECT} WHERE p.is_active = true GROUP BY p.id ORDER BY p.created_at DESC`
    );
    res.json(await withOptions(result.rows));
  } catch (error: any) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search products — MUST be before /:id
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string' || !q.trim()) return res.json([]);

    const term = q.trim().toLowerCase();

    const result = await pool.query(
      `${PRODUCT_SELECT}
       WHERE p.is_active = true
         AND (
           LOWER(p.name) LIKE $1
           OR LOWER(p.description) LIKE $1
           OR LOWER(p.gender) LIKE $1
           OR EXISTS (
             SELECT 1 FROM product_categories pc2
             JOIN categories c2 ON c2.id = pc2.category_id
             WHERE pc2.product_id = p.id AND LOWER(c2.name) LIKE $1
           )
         )
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [`%${term}%`]
    );

    const products = await withOptions(result.rows);
    res.json(products.map((p: any) => ({
      ...p,
      category: p.categories?.[0]?.name || p.category || '',
    })));
  } catch (error: any) {
    console.error('Error searching products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single product by ID or slug (public)
router.get('/:id', async (req, res) => {
  try {
    const product = await getFullProduct(req.params.id, await isAdminRequest(req));
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (error: any) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== ADMIN ROUTES ==========

// Get all products (admin, includes inactive products and options)
router.get('/admin/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`${PRODUCT_SELECT} GROUP BY p.id ORDER BY p.created_at DESC`);
    res.json(await withOptions(result.rows, true));
  } catch (error: any) {
    console.error('Error fetching all products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get products by category (id or slug); includes the category's subcategories
router.get('/category/:categoryId', async (req, res) => {
  try {
    const { categoryId } = req.params;

    const category = await pool.query(
      isUuid(categoryId) ? 'SELECT id FROM categories WHERE id = $1' : 'SELECT id FROM categories WHERE slug = $1',
      [categoryId]
    );
    if (category.rows.length === 0) return res.json([]);

    const result = await pool.query(
      `${PRODUCT_SELECT}
       WHERE p.is_active = true
         AND EXISTS (SELECT 1 FROM product_categories pcat2
                      WHERE pcat2.product_id = p.id AND pcat2.category_id IN ${IN_CATEGORY_TREE})
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [category.rows[0].id]
    );
    res.json(await withOptions(result.rows));
  } catch (error: any) {
    console.error('Error fetching products by category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create product (admin)
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      name, description, price, original_price, image_url, additional_images,
      gender, is_active, category_ids, social_proof_enabled, social_proof_text,
      social_proof_initial_count, social_proof_end_count,
    } = req.body;

    if (!name || !price) return res.status(400).json({ error: 'Name and price are required' });

    const slugBody: Record<string, any> = { slug: req.body.slug };
    const slugError = normaliseSlug(slugBody);
    if (slugError) return res.status(400).json({ error: slugError });

    const now = new Date().toISOString();
    const result = await pool.query(
      `INSERT INTO products
         (name, slug, description, price, original_price, image_url, additional_images,
          gender, is_active, social_proof_enabled, social_proof_text,
          social_proof_initial_count, social_proof_end_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        name, slugBody.slug ?? null, description, price, original_price || null,
        image_url || '', additional_images || [],
        gender || null, is_active !== undefined ? is_active : true,
        social_proof_enabled || false,
        social_proof_text || '🔺 {count} people are viewing this right now',
        social_proof_initial_count || 5, social_proof_end_count || 15,
        now, now,
      ]
    );

    const product = result.rows[0];

    // Assign categories
    if (category_ids?.length > 0) {
      for (const catId of category_ids) {
        await pool.query(
          'INSERT INTO product_categories (product_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [product.id, catId]
        );
      }
    }

    const fullProduct = await getFullProduct(product.id, true);
    res.json({ success: true, product: fullProduct });
  } catch (error: any) {
    if (sendDbError(res, error, 'product')) return;
    console.error('Error creating product:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update product (admin)
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: 'Product not found' });
    const { category_ids, ...fields } = req.body;
    const slugError = normaliseSlug(fields);
    if (slugError) return res.status(400).json({ error: slugError });

    const query = buildUpdate('products', fields, id, { updated_at: new Date().toISOString() });
    if (query) {
      const updated = await pool.query(query.text, query.values);
      if (updated.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
      await syncRequiredFlags(pool, id, fields);
    } else if (category_ids === undefined) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Re-assign categories if provided
    if (category_ids !== undefined) {
      await pool.query('DELETE FROM product_categories WHERE product_id = $1', [id]);
      for (const catId of category_ids) {
        await pool.query(
          'INSERT INTO product_categories (product_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, catId]
        );
      }
    }

    const fullProduct = await getFullProduct(id, true);
    res.json({ success: true, product: fullProduct });
  } catch (error: any) {
    if (sendDbError(res, error, 'product')) return;
    console.error('Error updating product:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle product active status (admin)
router.patch('/:id/toggle', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    await pool.query(
      'UPDATE products SET is_active = $1, updated_at = $2 WHERE id = $3',
      [is_active, new Date().toISOString(), id]
    );
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product (admin)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: 'Product not found' });
    const blockers = await productDeletionBlockers(id);
    if (blockers.length > 0) return res.status(400).json({ error: blockers[0] });
    await pool.query('DELETE FROM product_categories WHERE product_id = $1', [id]);
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get products by gender (public)
router.get('/gender/:gender', async (req, res) => {
  try {
    const { gender } = req.params;
    const result = await pool.query(
      `${PRODUCT_SELECT} WHERE p.is_active = true AND LOWER(p.gender) = LOWER($1) GROUP BY p.id ORDER BY p.created_at DESC`,
      [gender]
    );
    res.json(await withOptions(result.rows));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update product images (admin)
router.patch('/:id/images', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { image_url, additional_images } = req.body;

    await pool.query(
      `UPDATE products SET image_url = $1, additional_images = $2, updated_at = $3 WHERE id = $4`,
      [image_url, additional_images || [], new Date().toISOString(), id]
    );
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
