import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { buildInsert, buildUpdate } from '../utils/sql';

const router = express.Router();

console.log('✅ admin hero routes loaded');

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hero_content ORDER BY display_order ASC');
    res.json(result.rows);
  } catch (err: any) {
    console.error('Admin hero fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const query = buildInsert('hero_content', req.body);
    const result = await pool.query(query.text, query.values);
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const query = buildUpdate('hero_content', req.body, id);
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });
    const result = await pool.query(query.text, query.values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM hero_content WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
