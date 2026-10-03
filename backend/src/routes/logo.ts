import express from 'express';
import { pool } from '../utils/db';
import { requireAuth } from '../middleware/auth';
import { buildInsert, buildUpdate } from '../utils/sql';
import multer from 'multer';
import { saveBuffer, publicUrlFor } from '../utils/localStorage';

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/webp', 'image/jpg',
      'image/svg+xml', 'image/x-icon', 'image/gif',
    ];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Only images and GIFs are allowed.'));
  },
});

// ========== PUBLIC ROUTES ==========

// Get active logo
router.get('/active', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const result = await pool.query(
      `SELECT * FROM logo_config
       WHERE is_active = true
         AND (start_date IS NULL OR start_date <= $1)
         AND (end_date   IS NULL OR end_date   >= $1)
       ORDER BY created_at DESC
       LIMIT 1`,
      [now]
    );
    res.json(result.rows[0] || null);
  } catch (error: any) {
    console.error('Error fetching active logo:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== ADMIN ROUTES ==========

// Get all logos
router.get('/admin', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM logo_config ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching logos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload logo file to local storage
router.post('/admin/upload-logo', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file = req.file;
    const type = req.body.type || 'logo';
    const { relPath, fileName } = saveBuffer(file.buffer, file.mimetype, ['logos', type]);
    const publicUrl = publicUrlFor(req, relPath);
    res.json({ success: true, url: publicUrl, file_name: fileName, file_type: file.mimetype });
  } catch (error: any) {
    console.error('❌ Logo upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create logo record
router.post('/admin', requireAuth, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const query = buildInsert('logo_config', req.body, { created_at: now, updated_at: now });
    const result = await pool.query(query.text, query.values);
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error creating logo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update logo record
router.put('/admin/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const query = buildUpdate('logo_config', req.body, id, { updated_at: new Date().toISOString() });
    if (!query) return res.status(400).json({ error: 'No valid fields to update' });
    const result = await pool.query(query.text, query.values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error updating logo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete logo record
router.delete('/admin/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM logo_config WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting logo:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
