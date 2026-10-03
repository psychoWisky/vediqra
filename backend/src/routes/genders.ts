import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { buildInsert, buildUpdate } from '../utils/sql';

const router = express.Router();

// Get all genders (public)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, display_name, display_order, icon FROM genders ORDER BY display_order ASC'
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching genders:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Admin routes
router.get('/admin', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM genders ORDER BY display_order ASC');
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/admin', requireAuth, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const query = buildInsert('genders', req.body, { created_at: now, updated_at: now });
    const result = await pool.query(query.text, query.values);
    res.json(result.rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/admin/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const query = buildUpdate('genders', req.body, id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });
    const result = await pool.query(query.text, query.values);
    res.json(result.rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get gender name first
    const genderResult = await pool.query('SELECT name FROM genders WHERE id = $1', [id]);
    if (genderResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const genderName = genderResult.rows[0].name;
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM products WHERE gender = $1',
      [genderName]
    );
    const count = parseInt(countResult.rows[0].count);

    if (count > 0) {
      return res.status(400).json({ error: 'Cannot delete gender that is in use by products' });
    }

    await pool.query('DELETE FROM genders WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
