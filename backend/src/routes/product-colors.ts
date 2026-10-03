import express, { Request, Response } from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { isUuid } from '../utils/sql';
import { sendDbError } from '../utils/http';
import { createLegacy, deleteAllLegacy, deleteLegacy, listLegacy, updateLegacy } from '../services/options';

const router = express.Router();

// ADMIN ONLY. Colour variants are now the "Colour" option group of the generic option system
// (see services/options.ts). These endpoints keep the old request/response shapes so the existing
// admin screens work; the ids they return are option value ids.

const fail = (res: Response, error: any, log: string) => {
  if (error?.status === 404) return res.status(404).json({ error: error.message });
  if (sendDbError(res, error, 'colour')) return;
  console.error(log, error);
  res.status(500).json({ error: error.message });
};

// Get all colors for a product (admin)
router.get('/products/:productId/colors', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.productId)) return res.json([]);
    res.json(await listLegacy(pool, req.params.productId, 'colour', false));
  } catch (error: any) {
    fail(res, error, 'Error fetching product colors:');
  }
});

// Create a new color variant
router.post('/products/:productId/colors', requireAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    if (!isUuid(productId)) return res.status(404).json({ error: 'Product not found' });
    if (!req.body?.color_name) return res.status(400).json({ error: 'Color name is required' });
    if (!req.body?.image_url) return res.status(400).json({ error: 'Color image is required' });

    const color = await createLegacy(pool, productId, 'colour', req.body);
    res.json({ success: true, color });
  } catch (error: any) {
    fail(res, error, 'Error creating product color:');
  }
});

// Update a color variant
router.put('/products/colors/:colorId', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.colorId)) return res.status(404).json({ error: 'Color not found' });
    const color = await updateLegacy(pool, 'colour', req.params.colorId, req.body);
    if (!color) return res.status(404).json({ error: 'Color not found' });
    res.json({ success: true, color });
  } catch (error: any) {
    fail(res, error, 'Error updating product color:');
  }
});

// Delete a color variant
router.delete('/products/colors/:colorId', requireAuth, async (req: Request, res: Response) => {
  try {
    if (isUuid(req.params.colorId)) await deleteLegacy(pool, 'colour', req.params.colorId);
    res.json({ success: true, message: 'Color variant deleted successfully' });
  } catch (error: any) {
    fail(res, error, 'Error deleting product color:');
  }
});

// Delete all colors for a product
router.delete('/products/:productId/colors', requireAuth, async (req: Request, res: Response) => {
  try {
    if (isUuid(req.params.productId)) await deleteAllLegacy(pool, req.params.productId, 'colour');
    res.json({ success: true, message: 'All colors deleted successfully' });
  } catch (error: any) {
    fail(res, error, 'Error deleting product colors:');
  }
});

// Bulk update colors (for reordering)
router.put('/products/:productId/colors/bulk', requireAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { colors } = req.body || {};
    if (!isUuid(productId)) return res.status(404).json({ error: 'Product not found' });
    if (!colors || !Array.isArray(colors)) {
      return res.status(400).json({ error: 'Colors array is required' });
    }

    const results = [];
    for (let i = 0; i < colors.length; i++) {
      if (!isUuid(colors[i]?.id)) continue;
      const updated = await updateLegacy(pool, 'colour', colors[i].id, { display_order: i });
      if (updated && updated.product_id === productId) results.push(updated);
    }
    res.json({ success: true, colors: results });
  } catch (error: any) {
    fail(res, error, 'Error bulk updating colors:');
  }
});

export default router;
