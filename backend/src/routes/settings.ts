import express from 'express';
import { pool } from '../utils/db';

const router = express.Router();

console.log('✅ settings routes loaded');

router.get('/', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key is required' });

    const result = await pool.query(
      'SELECT value FROM site_settings WHERE key = $1',
      [key]
    );

    res.json(result.rows[0] ?? { value: null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
