import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { saveBuffer, publicUrlFor } from '../utils/localStorage';
import { pool } from '../utils/db';

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');
    if (isImage || isVideo) cb(null, true);
    else cb(new Error('Invalid file type.'));
  },
});

router.post('/upload', requireAuth, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file = req.file;
    const isVideo = file.mimetype.startsWith('video/');
    const { relPath, fileName } = saveBuffer(file.buffer, file.mimetype, ['hero']);
    const publicUrl = publicUrlFor(req, relPath);

    res.json({
      success: true,
      media_url: publicUrl,
      media_type: isVideo ? 'video' : 'image',
      file_name: fileName,
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    // PUBLIC: only active slides (the admin list at /api/admin/hero returns everything)
    const result = await pool.query('SELECT * FROM hero_content WHERE is_active = true ORDER BY display_order ASC');
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
