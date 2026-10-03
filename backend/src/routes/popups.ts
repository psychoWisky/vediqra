import express from 'express';
import { pool } from '../utils/db';

const router = express.Router();

console.log('✅ public popups routes loaded');

// Get active popup (public)
router.get('/active', async (_req, res) => {
  try {
    const now = new Date().toISOString();
    const result = await pool.query(
      `SELECT * FROM popup_config
       WHERE is_active = true
         AND (start_date IS NULL OR start_date <= $1)
         AND (end_date   IS NULL OR end_date   >= $1)
       ORDER BY created_at DESC
       LIMIT 1`,
      [now]
    );
    res.json(result.rows[0] || null);
  } catch (err: any) {
    console.error('Error fetching active popup:', err);
    res.status(500).json({ error: err.message });
  }
});

// Track popup view (public)
router.post('/track-view', async (req, res) => {
  try {
    const { popup_id, session_id } = req.body;
    await pool.query(
      `INSERT INTO popup_display_stats (popup_id, session_id, viewed_at)
       VALUES ($1, $2, $3)`,
      [popup_id, session_id, new Date().toISOString()]
    );
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error tracking popup view:', err);
    res.status(500).json({ error: err.message });
  }
});

// Track popup click (public)
router.post('/track-click', async (req, res) => {
  try {
    const { popup_id, session_id } = req.body;
    await pool.query(
      `UPDATE popup_display_stats
       SET clicked_at = $1
       WHERE popup_id = $2 AND session_id = $3 AND clicked_at IS NULL`,
      [new Date().toISOString(), popup_id, session_id]
    );
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error tracking popup click:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
