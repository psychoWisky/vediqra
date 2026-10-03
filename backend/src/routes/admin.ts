import express, { Request, Response } from 'express';
import multer from 'multer';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { buildInsert, buildUpdate, isUuid, normaliseSlug, ORDER_STATUSES } from '../utils/sql';
import { sendDbError } from '../utils/http';
import { syncRequiredFlags } from '../services/options';
import { productDeletionBlockers, applyAdminOrderUpdate } from '../services/orderService';
import { PricingError } from '../services/pricing';
import { saveBuffer, publicUrlFor } from '../utils/localStorage';

const router = express.Router();

/**
 * A non-negative integer field with a default for "not supplied". Distinguishes an explicit 0 (e.g.
 * max_customization_images: 0 for a text-only customisation) from an omitted field, which the old
 * `value ? parseInt(value) : fallback` check treated the same way, silently turning a requested 0 into the
 * default. Returns null for a negative or otherwise invalid value so the caller can reject the request.
 */
function nonNegativeIntOrDefault(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

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

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type'));
  },
});

// ========== IMAGE UPLOAD ==========

router.post('/upload-image', requireAuth, upload.single('image'), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file = req.file;
    const { relPath, fileName } = saveBuffer(file.buffer, file.mimetype, ['products']);
    const publicUrl = publicUrlFor(req, relPath);
    res.json({ success: true, image_url: publicUrl, file_name: fileName, message: 'Image uploaded successfully' });
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload image' });
  }
});

// ========== PRODUCTS ==========

router.get('/products', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim();
    const params: any[] = [limit, offset];
    const searchClause = search ? `AND (p.name ILIKE $3 OR p.sku ILIKE $3)` : '';
    if (search) params.push(`%${search}%`);

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT p.*,
                COALESCE(
                  jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                  FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
                ) AS product_categories
         FROM products p
         LEFT JOIN product_categories pcat ON pcat.product_id = p.id
         LEFT JOIN categories cat ON cat.id = pcat.category_id
         WHERE 1=1 ${searchClause}
         GROUP BY p.id
         ORDER BY p.created_at DESC
         LIMIT $1 OFFSET $2`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) FROM products p WHERE 1=1 ${searchClause}`,
        search ? [`%${search}%`] : []
      ),
    ]);

    const transformedData = dataResult.rows.map((product: any) => ({
      ...product,
      price: parseFloat(product.price) || 0,
      categories: (product.product_categories || []).map((pc: any) => pc.category),
      colors: [],
      sizes: [],
    }));

    res.json({ data: transformedData, total: parseInt(countResult.rows[0].count) });
  } catch (error: any) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/products', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      name, description, price, original_price,
      discount_percentage, image_url, stock_quantity,
      gender, sku, is_customizable, customization_price,
      max_customization_characters, max_customization_images,
      max_customization_lines, additional_images,
      social_proof_enabled, social_proof_text,
      social_proof_initial_count, social_proof_end_count,
      is_active, has_colors, has_sizes, track_stock,
    } = req.body;

    console.log('Creating product:', { name, price, has_colors, has_sizes });

    const slugBody: Record<string, any> = { slug: req.body.slug };
    const slugError = normaliseSlug(slugBody);
    if (slugError) return res.status(400).json({ error: slugError });

    const maxChars = nonNegativeIntOrDefault(max_customization_characters, 50);
    const maxImages = nonNegativeIntOrDefault(max_customization_images, 10);
    const maxLines = nonNegativeIntOrDefault(max_customization_lines, 0);
    if (maxChars === null || maxImages === null || maxLines === null) {
      return res.status(400).json({ error: 'max_customization_characters, max_customization_images and max_customization_lines must be 0 or a positive whole number' });
    }

    const now = new Date().toISOString();
    const result = await pool.query(
      `INSERT INTO products
         (name, slug, description, price, original_price, discount_percentage, image_url,
          stock_quantity, gender, sku, is_customizable, customization_price,
          max_customization_characters, max_customization_images, max_customization_lines,
          additional_images, social_proof_enabled, social_proof_text,
          social_proof_initial_count, social_proof_end_count,
          is_active, has_colors, has_sizes, created_at, updated_at, track_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING *`,
      [
        name, slugBody.slug ?? null, description,
        parseFloat(price),
        original_price ? parseFloat(original_price) : null,
        discount_percentage ? parseInt(discount_percentage) : null,
        image_url,
        parseInt(stock_quantity) || 0,
        gender || 'unisex',
        sku,
        is_customizable || false,
        customization_price ? parseFloat(customization_price) : 0,
        maxChars,
        maxImages,
        maxLines,
        additional_images || [],
        social_proof_enabled !== false,
        social_proof_text || '🔺{count} People are Purchasing Right Now',
        social_proof_initial_count ? parseInt(social_proof_initial_count) : 5,
        social_proof_end_count ? parseInt(social_proof_end_count) : 15,
        is_active !== undefined ? is_active : true,
        has_colors || false,
        has_sizes || false,
        now, now,
        track_stock === true,
      ]
    );

    const product = result.rows[0];
    console.log('Product created:', product.id);
    res.json({ success: true, product });
  } catch (error: any) {
    if (sendDbError(res, error, 'product')) return;
    console.error('Create product error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/products/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = { ...req.body };
    if (body.max_customization_lines) {
      body.max_customization_lines = parseInt(body.max_customization_lines);
    }

    const slugError = normaliseSlug(body);
    if (slugError) return res.status(400).json({ error: slugError });

    const query = buildUpdate('products', body, id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });

    const result = await pool.query(query.text, query.values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    // has_colors / has_sizes used to mean "the shopper must choose"; keep the option groups' is_required in step.
    await syncRequiredFlags(pool, id, body);
    res.json({ success: true, product: result.rows[0] });
  } catch (error: any) {
    if (sendDbError(res, error, 'product')) return;
    console.error('Update product error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/products/:id', requireAuth, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: 'Product not found' });

    // Historical orders keep their items as JSONB, so a product that was ever ordered must not be removed.
    const blockers = await productDeletionBlockers(id);
    if (blockers.length > 0) {
      return res.status(400).json({ error: blockers[0] });
    }

    // Delete all child records inside a transaction, then remove the product
    await client.query('BEGIN');
    await client.query('DELETE FROM reviews WHERE product_id = $1', [id]);
    await client.query('DELETE FROM social_proof_stats WHERE product_id = $1', [id]);
    await client.query('DELETE FROM product_categories WHERE product_id = $1', [id]);
    await client.query('DELETE FROM product_colors WHERE product_id = $1', [id]);   // legacy tables (kept until dropped)
    await client.query('DELETE FROM product_sizes WHERE product_id = $1', [id]);
    // product_option_groups / values are removed by ON DELETE CASCADE
    await client.query('DELETE FROM products WHERE id = $1', [id]);
    await client.query('COMMIT');

    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete product error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Colour and size variants (/products/:id/colors, /products/:id/sizes) live in product-colors.ts and
// product-sizes.ts, backed by the generic option tables. Generic options: routes/options.ts.

// ========== PRODUCT CATEGORIES ==========

router.delete('/products/:id/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM product_categories WHERE product_id = $1', [req.params.id]);
    res.json({ success: true, message: 'All categories removed from product' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/products/:id/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'No categories provided' });
    }

    const results = [];
    for (const c of categories) {
      const result = await pool.query(
        `INSERT INTO product_categories (product_id, category_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING
         RETURNING *, (SELECT to_jsonb(cat.*) FROM categories cat WHERE cat.id = $2) AS category`,
        [id, c.category_id]
      );
      if (result.rows.length > 0) results.push(result.rows[0]);
    }
    res.json({ success: true, categories: results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/products/:id/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT cat.* FROM product_categories pc
       JOIN categories cat ON cat.id = pc.category_id
       WHERE pc.product_id = $1`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== CATEGORIES ==========

router.get('/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, parent_id, banner_url, description, icon, icon_type, image_url, color, hover_effect,
              display_order, is_active, created_at, updated_at
         FROM categories ORDER BY display_order ASC, name ASC`
    );
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = { ...req.body };
    if (typeof body.name !== 'string' || !body.name.trim()) return res.status(400).json({ error: 'name is required' });
    const slugError = normaliseSlug(body);
    if (slugError) return res.status(400).json({ error: slugError });
    if (body.parent_id === '') body.parent_id = null;

    const { icon_type, image_url, icon } = body;
    const now = new Date().toISOString();
    const query = buildInsert('categories', {
      ...body,
      icon: icon_type === 'image' ? 'image' : (icon || 'Gift'),
      icon_type: icon_type || 'lucide',
      image_url: icon_type === 'image' ? (image_url || icon) : (image_url || null),
      color: body.color || 'from-pink-100 to-pink-50',
      hover_effect: body.hover_effect || 'scale',
      display_order: body.display_order || 0,
      is_active: body.is_active !== undefined ? body.is_active : true,
    }, { created_at: now, updated_at: now });
    const result = await pool.query(query.text, query.values);
    res.json(result.rows[0]);
  } catch (error: any) {
    if (sendDbError(res, error, 'category')) return;
    res.status(500).json({ error: error.message });
  }
});

router.put('/categories/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const updates = { ...req.body };
    if (updates.icon_type === 'image') {
      updates.image_url = updates.image_url || updates.icon;
      updates.icon = 'image';
    }
    const slugError = normaliseSlug(updates);
    if (slugError) return res.status(400).json({ error: slugError });
    if (updates.parent_id === '') updates.parent_id = null;
    if (updates.parent_id === req.params.id) return res.status(400).json({ error: 'A category cannot be its own parent' });

    const query = buildUpdate('categories', updates, req.params.id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });

    const result = await pool.query(query.text, query.values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (error: any) {
    if (sendDbError(res, error, 'category')) return;
    res.status(500).json({ error: error.message });
  }
});

router.delete('/categories/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const children = await pool.query('SELECT COUNT(*)::int AS n FROM categories WHERE parent_id = $1', [req.params.id]);
    if (children.rows[0].n > 0) {
      return res.status(400).json({ error: `Cannot delete a category that has ${children.rows[0].n} subcategor${children.rows[0].n === 1 ? 'y' : 'ies'}. Move or delete them first.` });
    }
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ORDERS ==========

router.get('/orders', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim();
    const status = (req.query.status as string || '').trim();
    
    const conditions: string[] = [];
    const params: any[] = [limit, offset];
    let paramIdx = 3;

    if (search) {
      conditions.push(`(customer_name ILIKE $${paramIdx} OR customer_email ILIKE $${paramIdx} OR customer_phone ILIKE $${paramIdx} OR custom_order_id ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (status && status !== 'all') {
      conditions.push(`status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const filterParams = params.slice(2);

    const [dataResult, countResult] = await Promise.all([
      pool.query(`SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, params),
      pool.query(`SELECT COUNT(*) FROM orders ${whereClause}`, filterParams),
    ]);

    res.json({ data: dataResult.rows.map(transformOrder), total: parseInt(countResult.rows[0].count) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(transformOrder(result.rows[0]));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/orders/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: 'Order not found' });
    const { status, tracking_number, admin_notes } = req.body || {};
    if (status !== undefined && !ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${ORDER_STATUSES.join(', ')}` });
    }
    if (status === undefined && tracking_number === undefined && admin_notes === undefined) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Admins may only change fulfilment fields (status, tracking number, notes) - never prices or customer data.
    // Status changes go through applyAdminOrderUpdate: it enforces the transition rules and, on cancellation,
    // returns the order's stock once, in the same transaction.
    const result = await applyAdminOrderUpdate(id, { status, tracking_number, admin_notes });
    res.json({ success: true, order: result.order, status_changed: result.statusChanged, stock_restored: result.stockRestored });
  } catch (error: any) {
    if (error instanceof PricingError) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ========== COMBOS ==========

router.get('/combos', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.description, c.discount_percentage, c.discount_price,
                c.image_url, c.is_active, c.created_at, c.updated_at,
                COALESCE(
                  jsonb_agg(DISTINCT jsonb_build_object('quantity', cp.quantity,
                    'product', jsonb_build_object('id', p.id, 'name', p.name, 'price', p.price,
                      'image_url', p.image_url, 'is_customizable', p.is_customizable,
                      'has_colors', p.has_colors, 'has_sizes', p.has_sizes)))
                  FILTER (WHERE cp.product_id IS NOT NULL), '[]'::jsonb
                ) AS combo_products
         FROM combos c
         LEFT JOIN combo_products cp ON cp.combo_id = c.id
         LEFT JOIN products p ON p.id = cp.product_id
         GROUP BY c.id
         ORDER BY c.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM combos`),
    ]);

    const data = dataResult.rows.map((combo: any) => ({
      ...combo,
      categories: [],
    }));
    res.json({ data, total: parseInt(countResult.rows[0].count) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/combos', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, description, discount_percentage, discount_price, image_url, is_active } = req.body;
    const now = new Date().toISOString();

    const result = await pool.query(
      `INSERT INTO combos
         (name, description, discount_percentage, discount_price, image_url, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, description,
       discount_percentage ? parseInt(discount_percentage) : null,
       discount_price ? parseFloat(discount_price) : null,
       image_url, is_active !== undefined ? is_active : true, now, now]
    );
    res.json({ success: true, combo: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/combos/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, discount_percentage, discount_price, image_url, is_active } = req.body;

    const result = await pool.query(
      `UPDATE combos
       SET name=$1, description=$2, discount_percentage=$3, discount_price=$4,
           image_url=$5, is_active=$6, updated_at=$7
       WHERE id=$8 RETURNING *`,
      [name, description,
       discount_percentage ? parseInt(discount_percentage) : null,
       discount_price ? parseFloat(discount_price) : null,
       image_url, is_active, new Date().toISOString(), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Combo not found' });
    res.json({ success: true, combo: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/combos/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM combo_products WHERE combo_id = $1', [id]);
    await pool.query('DELETE FROM combo_categories WHERE combo_id = $1', [id]);
    await pool.query('DELETE FROM combos WHERE id = $1', [id]);
    res.json({ success: true, message: 'Combo deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== COMBO PRODUCTS ==========

router.get('/combos/:comboId/products', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT cp.product_id, cp.quantity, to_jsonb(p.*) AS product
       FROM combo_products cp
       JOIN products p ON p.id = cp.product_id
       WHERE cp.combo_id = $1`,
      [req.params.comboId]
    );
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/combos/:comboId/products', requireAuth, async (req: Request, res: Response) => {
  try {
    const { comboId } = req.params;
    const { products } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'No products provided' });
    }

    const results = [];
    for (const p of products) {
      const r = await pool.query(
        'INSERT INTO combo_products (combo_id, product_id, quantity) VALUES ($1,$2,$3) RETURNING *',
        [comboId, p.product_id, p.quantity || 1]
      );
      results.push(r.rows[0]);
    }
    res.json({ success: true, data: results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/combos/:comboId/products', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM combo_products WHERE combo_id = $1', [req.params.comboId]);
    res.json({ success: true, message: 'All products removed from combo' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== COMBO CATEGORIES ==========

router.delete('/combos/:id/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM combo_categories WHERE combo_id = $1', [req.params.id]);
    res.json({ success: true, message: 'All categories removed from combo' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/combos/:id/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'No categories provided' });
    }

    const results = [];
    for (const c of categories) {
      const r = await pool.query(
        `INSERT INTO combo_categories (combo_id, category_id) VALUES ($1,$2)
         RETURNING *, (SELECT to_jsonb(cat.*) FROM categories cat WHERE cat.id = $2) AS category`,
        [id, c.category_id]
      );
      results.push(r.rows[0]);
    }
    res.json({ success: true, categories: results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/combos/:id/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT cat.* FROM combo_categories cc
       JOIN categories cat ON cat.id = cc.category_id
       WHERE cc.combo_id = $1`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== EXTRA COMBO ENDPOINTS ==========

router.put('/combos/:id/products/:productId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id, productId } = req.params;
    const { quantity } = req.body;
    if (!quantity || quantity < 1) return res.status(400).json({ error: 'Valid quantity is required' });

    const result = await pool.query(
      `UPDATE combo_products SET quantity=$1
       WHERE combo_id=$2 AND product_id=$3 RETURNING *`,
      [quantity, id, productId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found in combo' });
    res.json({ success: true, product: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/combos/:id/products/:productId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id, productId } = req.params;
    await pool.query(
      'DELETE FROM combo_products WHERE combo_id=$1 AND product_id=$2',
      [id, productId]
    );
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/available-products', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('category', to_jsonb(cat.*)))
                FILTER (WHERE cat.id IS NOT NULL), '[]'::jsonb
              ) AS product_categories
       FROM products p
       LEFT JOIN product_categories pcat ON pcat.product_id = p.id
       LEFT JOIN categories cat ON cat.id = pcat.category_id
       WHERE p.is_active = true
       GROUP BY p.id ORDER BY p.name`
    );
    const data = result.rows.map((p: any) => ({
      ...p,
      categories: (p.product_categories || []).map((pc: any) => pc.category),
    }));
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/combos/:id/duplicate', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const originalResult = await pool.query('SELECT * FROM combos WHERE id = $1', [id]);
    if (originalResult.rows.length === 0) return res.status(404).json({ error: 'Combo not found' });
    const original = originalResult.rows[0];

    const now = new Date().toISOString();
    const newComboResult = await pool.query(
      `INSERT INTO combos
         (name, description, discount_percentage, discount_price, image_url, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [`${original.name} (Copy)`, original.description,
       original.discount_percentage, original.discount_price,
       original.image_url, false, now, now]
    );
    const newCombo = newComboResult.rows[0];

    const products = await pool.query('SELECT product_id, quantity FROM combo_products WHERE combo_id=$1', [id]);
    for (const p of products.rows) {
      await pool.query(
        'INSERT INTO combo_products (combo_id, product_id, quantity) VALUES ($1,$2,$3)',
        [newCombo.id, p.product_id, p.quantity]
      );
    }

    const cats = await pool.query('SELECT category_id FROM combo_categories WHERE combo_id=$1', [id]);
    for (const c of cats.rows) {
      await pool.query(
        'INSERT INTO combo_categories (combo_id, category_id) VALUES ($1,$2)',
        [newCombo.id, c.category_id]
      );
    }

    res.json({ success: true, combo: newCombo });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
router.get('/test', (_req: Request, res: Response) => {
  res.json({ message: 'Admin API is working!' });
});

export default router;
