/**
 * Generic product options.
 *
 *   Product --(product_option_groups)--> Option group --> Option values (per product)
 *
 * ADMIN ONLY (mounted at /api/admin):
 *   GET    /option-groups                         reusable option group library (with usage counts)
 *   POST   /option-groups                         { name, slug? }
 *   PUT    /option-groups/:id                     { name?, slug?, is_active? }
 *   DELETE /option-groups/:id                     refused while any product uses the group
 *   GET    /products/:productId/options           the product's groups + values, including inactive
 *   POST   /products/:productId/option-groups     attach: { option_group_id | name, is_required?, display_order?, is_active? }
 *   PUT    /product-option-groups/:id             { is_required?, display_order?, is_active? }
 *   DELETE /product-option-groups/:id             detach (its values go with it; past orders keep their snapshot)
 *   POST   /product-option-groups/:id/values      { name, price_modifier?, stock_quantity?, display_order?, is_active?, image_url?, metadata? }
 *   PUT    /product-option-values/:id
 *   DELETE /product-option-values/:id
 *
 * PUBLIC (mounted at /api):
 *   GET    /products/:idOrSlug/options            active groups + values
 */
import express, { Request, Response } from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { buildInsert, buildUpdate, isUuid, normaliseSlug, slugify } from '../utils/sql';
import { sendDbError } from '../utils/http';
import { loadProductOptions } from '../services/options';

export const adminOptionRoutes = express.Router();
export const publicOptionRoutes = express.Router();

const fail = (res: Response, error: any, what: string) => {
  if (sendDbError(res, error, what)) return;
  console.error(`Option error (${what}):`, error);
  res.status(500).json({ error: error.message || 'Server error' });
};

/** Validate and coerce the numeric/JSON fields shared by create and update. Returns an error message or null. */
function coerceValueFields(body: Record<string, any>): string | null {
  if (body.price_modifier !== undefined) {
    const n = Number(body.price_modifier);
    if (!Number.isFinite(n) || Math.abs(n) > 1e7) return 'price_modifier must be a number';
    body.price_modifier = n;
  }
  if (body.stock_quantity !== undefined) {
    if (body.stock_quantity === null || body.stock_quantity === '') {
      body.stock_quantity = null; // not tracked
    } else {
      const n = Number(body.stock_quantity);
      if (!Number.isInteger(n) || n < 0) return 'stock_quantity must be a whole number, or empty for "not tracked"';
      body.stock_quantity = n;
    }
  }
  if (body.display_order !== undefined) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n)) return 'display_order must be a whole number';
    body.display_order = n;
  }
  if (body.metadata !== undefined) {
    if (body.metadata === null || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      return 'metadata must be an object';
    }
    body.metadata = JSON.stringify(body.metadata);
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return 'name is required';
  if (typeof body.name === 'string') body.name = body.name.trim();
  if (body.value_key !== undefined) {
    if (body.value_key === null || body.value_key === '') delete body.value_key; // let the database derive it
    else body.value_key = slugify(String(body.value_key));
  }
  return null;
}

// ========== OPTION GROUP LIBRARY ==========

adminOptionRoutes.get('/option-groups', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT og.*, COUNT(pog.id)::int AS product_count
         FROM option_groups og
         LEFT JOIN product_option_groups pog ON pog.option_group_id = og.id
        GROUP BY og.id ORDER BY og.name`
    );
    res.json(result.rows);
  } catch (error) {
    fail(res, error, 'option group');
  }
});

adminOptionRoutes.post('/option-groups', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = { ...req.body };
    if (typeof body.name !== 'string' || !body.name.trim()) return res.status(400).json({ error: 'name is required' });
    body.name = body.name.trim();
    const slugError = normaliseSlug(body);
    if (slugError) return res.status(400).json({ error: slugError });

    const query = buildInsert('option_groups', body);
    const result = await pool.query(query.text, query.values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    fail(res, error, 'option group');
  }
});

adminOptionRoutes.put('/option-groups/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Option group not found' });
    const body = { ...req.body };
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }
    if (typeof body.name === 'string') body.name = body.name.trim();
    const slugError = normaliseSlug(body);
    if (slugError) return res.status(400).json({ error: slugError });

    const query = buildUpdate('option_groups', body, req.params.id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });
    const result = await pool.query(query.text, query.values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Option group not found' });
    res.json(result.rows[0]);
  } catch (error) {
    fail(res, error, 'option group');
  }
});

adminOptionRoutes.delete('/option-groups/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Option group not found' });
    const used = await pool.query('SELECT COUNT(*)::int AS n FROM product_option_groups WHERE option_group_id = $1', [req.params.id]);
    if (used.rows[0].n > 0) {
      return res.status(400).json({ error: `Cannot delete an option group used by ${used.rows[0].n} product(s). Detach it first, or disable it.` });
    }
    await pool.query('DELETE FROM option_groups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    fail(res, error, 'option group');
  }
});

// ========== A PRODUCT'S OPTIONS ==========

adminOptionRoutes.get('/products/:productId/options', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.productId)) return res.status(404).json({ error: 'Product not found' });
    const groups = await loadProductOptions(pool, [req.params.productId], { includeInactive: true });
    res.json(groups.get(req.params.productId) || []);
  } catch (error) {
    fail(res, error, 'options');
  }
});

// Attach an option group to a product (an existing library group by id, or one created/found by name).
adminOptionRoutes.post('/products/:productId/option-groups', requireAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    if (!isUuid(productId)) return res.status(404).json({ error: 'Product not found' });
    const product = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (product.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    let groupId: string | undefined = req.body?.option_group_id;
    if (groupId !== undefined && !isUuid(groupId)) return res.status(400).json({ error: 'Invalid option_group_id' });
    if (!groupId) {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'option_group_id or name is required' });
      const found = await pool.query(
        `INSERT INTO option_groups (name, slug) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET updated_at = now() RETURNING id`,
        [name, slugify(name)]
      );
      groupId = found.rows[0].id;
    }

    const query = buildInsert('product_option_groups', req.body, { product_id: productId, option_group_id: groupId });
    const result = await pool.query(query.text, query.values);
    const groups = await loadProductOptions(pool, [productId], { includeInactive: true });
    res.status(201).json(groups.get(productId)?.find((g) => g.id === result.rows[0].id));
  } catch (error) {
    fail(res, error, 'option group attachment');
  }
});

adminOptionRoutes.put('/product-option-groups/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Option group not found' });
    const body = { ...req.body };
    if (body.display_order !== undefined && !Number.isInteger(Number(body.display_order))) {
      return res.status(400).json({ error: 'display_order must be a whole number' });
    }
    const query = buildUpdate('product_option_groups', body, req.params.id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });
    const result = await pool.query(query.text, query.values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Option group not found' });
    res.json(result.rows[0]);
  } catch (error) {
    fail(res, error, 'option group');
  }
});

adminOptionRoutes.delete('/product-option-groups/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Option group not found' });
    await pool.query('DELETE FROM product_option_groups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    fail(res, error, 'option group');
  }
});

// ========== VALUES ==========

adminOptionRoutes.post('/product-option-groups/:id/values', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Option group not found' });
    const body = { ...req.body };
    if (typeof body.name !== 'string' || !body.name.trim()) return res.status(400).json({ error: 'name is required' });
    const problem = coerceValueFields(body);
    if (problem) return res.status(400).json({ error: problem });

    const exists = await pool.query('SELECT id FROM product_option_groups WHERE id = $1', [req.params.id]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'Option group not found' });

    const query = buildInsert('product_option_values', body, { product_option_group_id: req.params.id });
    const result = await pool.query(query.text, query.values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    fail(res, error, 'option value');
  }
});

adminOptionRoutes.put('/product-option-values/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Option value not found' });
    const body = { ...req.body };
    const problem = coerceValueFields(body);
    if (problem) return res.status(400).json({ error: problem });

    // metadata is merged, not replaced, so keys such as legacy_color_id are not lost by an edit.
    const metadata = body.metadata;
    delete body.metadata;
    const query = buildUpdate('product_option_values', body, req.params.id, { updated_at: new Date().toISOString() });
    if (!query && metadata === undefined) return res.status(400).json({ error: 'No valid fields to update' });

    let row;
    if (query) {
      row = (await pool.query(query.text, query.values)).rows[0];
    }
    if (metadata !== undefined) {
      row = (await pool.query(
        `UPDATE product_option_values SET metadata = metadata || $1::jsonb, updated_at = now() WHERE id = $2 RETURNING *`,
        [metadata, req.params.id]
      )).rows[0];
    }
    if (!row) return res.status(404).json({ error: 'Option value not found' });
    res.json(row);
  } catch (error) {
    fail(res, error, 'option value');
  }
});

adminOptionRoutes.delete('/product-option-values/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Option value not found' });
    await pool.query('DELETE FROM product_option_values WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    fail(res, error, 'option value');
  }
});

// ========== PUBLIC ==========

publicOptionRoutes.get('/products/:idOrSlug/options', async (req: Request, res: Response) => {
  try {
    const { idOrSlug } = req.params;
    const product = isUuid(idOrSlug)
      ? await pool.query('SELECT id FROM products WHERE id = $1 AND is_active = true', [idOrSlug])
      : await pool.query('SELECT id FROM products WHERE slug = $1 AND is_active = true', [idOrSlug]);
    if (product.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const groups = await loadProductOptions(pool, [product.rows[0].id]);
    res.json(groups.get(product.rows[0].id) || []);
  } catch (error) {
    fail(res, error, 'options');
  }
});
