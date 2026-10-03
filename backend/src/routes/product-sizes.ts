import express, { Request, Response } from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { isUuid } from '../utils/sql';
import { sendDbError } from '../utils/http';
import { createLegacy, deleteAllLegacy, deleteLegacy, listLegacy, updateLegacy } from '../services/options';

const router = express.Router();

// Size variants are now the "Size" option group of the generic option system (services/options.ts).
// These endpoints keep the old request/response shapes; the ids are option value ids.

const fail = (res: Response, error: any, log: string) => {
  if (error?.status === 404) return res.status(404).json({ error: error.message });
  if (sendDbError(res, error, 'size')) return;
  console.error(log, error);
  res.status(500).json({ error: error.message });
};

// ========== PUBLIC SIZE ROUTES ==========

// Get all active sizes for a product (public)
router.get('/products/:productId/sizes', async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.productId)) return res.json([]);
    res.json(await listLegacy(pool, req.params.productId, 'size', true));
  } catch (error: any) {
    fail(res, error, 'Error fetching product sizes:');
  }
});

// ========== ADMIN SIZE ROUTES ==========

// Get all sizes for a product (admin - includes inactive)
router.get('/products/:productId/sizes/all', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.productId)) return res.json([]);
    res.json(await listLegacy(pool, req.params.productId, 'size', false));
  } catch (error: any) {
    fail(res, error, 'Error fetching product sizes:');
  }
});

// Create a new size variant
router.post('/products/:productId/sizes', requireAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    if (!isUuid(productId)) return res.status(404).json({ error: 'Product not found' });
    if (!req.body?.size_name) return res.status(400).json({ error: 'Size name is required' });

    const size = await createLegacy(pool, productId, 'size', req.body);
    res.json({ success: true, size });
  } catch (error: any) {
    fail(res, error, 'Error creating product size:');
  }
});

// Update a size variant
router.put('/sizes/:sizeId', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.sizeId)) return res.status(404).json({ error: 'Size not found' });
    const size = await updateLegacy(pool, 'size', req.params.sizeId, req.body);
    if (!size) return res.status(404).json({ error: 'Size not found' });
    res.json({ success: true, size });
  } catch (error: any) {
    fail(res, error, 'Error updating product size:');
  }
});

// Delete a size variant
router.delete('/sizes/:sizeId', requireAuth, async (req: Request, res: Response) => {
  try {
    if (isUuid(req.params.sizeId)) await deleteLegacy(pool, 'size', req.params.sizeId);
    res.json({ success: true, message: 'Size variant deleted successfully' });
  } catch (error: any) {
    fail(res, error, 'Error deleting product size:');
  }
});

// Delete all sizes for a product
router.delete('/products/:productId/sizes', requireAuth, async (req: Request, res: Response) => {
  try {
    if (isUuid(req.params.productId)) await deleteAllLegacy(pool, req.params.productId, 'size');
    res.json({ success: true, message: 'All sizes deleted successfully' });
  } catch (error: any) {
    fail(res, error, 'Error deleting product sizes:');
  }
});

export default router;
