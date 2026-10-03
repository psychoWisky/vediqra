import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { publicUploadLimiter } from '../middleware/rateLimit';
import { saveBuffer, publicUrlFor, deleteFile, listFiles, safeSegment } from '../utils/localStorage';

const router = express.Router();

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 50* 1024 * 1024, // 10MB (increased from 5MB)
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'));
    }
  },
});

// Customer-facing uploads (customization images): smaller limit than the admin uploads above.
const customerUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Only JPEG, PNG, WebP and GIF are allowed.'));
  },
});

// Configure specialized multer for hero uploads (images and videos)
const heroUpload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');
    if (isImage || isVideo) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images and videos are allowed.'));
    }
  },
});

// ========== PRODUCT IMAGES UPLOAD ==========
router.post('/product-images', requireAuth, upload.array('images', 5), async (req, res) => {
  console.log('📸 POST /api/upload/product-images - Uploading product images');
  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedImages = files.map((file, index) => {
      const { relPath, fileName } = saveBuffer(file.buffer, file.mimetype, ['products']);
      return {
        url: publicUrlFor(req, relPath),
        filename: fileName,
        is_primary: index === 0,
      };
    });

    res.json({ success: true, images: uploadedImages });

  } catch (error: any) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== CUSTOMIZATION IMAGE UPLOAD (Single) ==========
router.post('/customization', publicUploadLimiter, customerUpload.single('image'), async (req, res) => {
  console.log('🎨 POST /api/upload/customization - Uploading customization image');
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    const productId = safeSegment(req.body.product_id);

    const { relPath } = saveBuffer(file.buffer, file.mimetype, ['customizations', productId]);
    const publicUrl = publicUrlFor(req, relPath);

    console.log('✅ Customization image uploaded:', publicUrl);
    res.json({ success: true, image_url: publicUrl });

  } catch (error: any) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== CUSTOMIZATION IMAGES UPLOAD (Multiple) ==========
router.post('/customizations', publicUploadLimiter, customerUpload.array('images', 20), async (req, res) => {
  console.log('🎨 POST /api/upload/customizations - Uploading multiple customization images');
  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const productId = safeSegment(req.body.product_id);
    const uploadedUrls = files.map((file) => {
      const { relPath } = saveBuffer(file.buffer, file.mimetype, ['customizations', productId]);
      return publicUrlFor(req, relPath);
    });

    console.log(`✅ ${uploadedUrls.length} customization images uploaded`);
    res.json({ success: true, image_urls: uploadedUrls });

  } catch (error: any) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== HERO MEDIA UPLOAD ==========
router.post('/hero', requireAuth, heroUpload.single('media'), async (req, res) => {
  console.log('🎬 POST /api/upload/hero - Uploading hero media');
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

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
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});
// ========== SINGLE IMAGE UPLOAD (for colors and main images) ==========
router.post('/upload-image', requireAuth, upload.single('image'), async (req, res) => {
  console.log('📸 POST /api/upload/upload-image - Uploading single image');
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    const { relPath, fileName } = saveBuffer(file.buffer, file.mimetype, ['products']);
    const publicUrl = publicUrlFor(req, relPath);

    res.json({
      success: true,
      image_url: publicUrl,
      file_name: fileName,
      message: 'Image uploaded successfully'
    });

  } catch (error: any) {
    console.error('❌ Upload error:', error);
    res.status(500).json({
      error: error.message || 'Failed to upload image'
    });
  }
});

// ========== LIST FILES ==========
router.get('/list-files', requireAuth, async (req, res) => {
  try {
    const prefix = (req.query.prefix as string) || '';
    const files = listFiles(req, prefix);
    res.json({ files });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== DELETE FILES ==========
router.delete('/delete-files', requireAuth, async (req, res) => {
  try {
    const { keys } = req.body as { keys: string[] };
    if (!keys || keys.length === 0) {
      return res.status(400).json({ error: 'No keys provided' });
    }
    for (const key of keys) {
      deleteFile(key);
    }
    res.json({ success: true, deleted: keys.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
