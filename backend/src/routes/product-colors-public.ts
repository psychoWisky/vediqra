import express, { Request, Response } from 'express';
import { pool } from '../utils/db';
import { isUuid } from '../utils/sql';
import { getLegacy, listLegacy } from '../services/options';

const router = express.Router();

// PUBLIC. Served from the "Colour" option group (see services/options.ts).

// Get all active colors for a product (public)
router.get('/products/:productId/colors', async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.productId)) return res.json([]);
    res.json(await listLegacy(pool, req.params.productId, 'colour', true));
  } catch (error: any) {
    console.error('Error fetching product colors:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single active color by ID (public)
router.get('/colors/:colorId', async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.colorId)) return res.status(404).json({ error: 'Color not found' });
    const color = await getLegacy(pool, 'colour', req.params.colorId, true);
    if (!color) return res.status(404).json({ error: 'Color not found' });
    res.json(color);
  } catch (error: any) {
    console.error('Error fetching color:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
