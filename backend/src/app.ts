import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config, { assertSecureConfig } from './config';
import { UPLOAD_ROOT } from './utils/localStorage';
import { requireAuth } from './middleware/auth';
import adminAuthRoutes from './routes/adminAuth';
import logoRoutes from './routes/logo';
import { transporter } from './services/gmailService';
import productSizeRoutes from './routes/product-sizes';
// ===== PUBLIC ROUTES =====
import publicColorRoutes from './routes/product-colors-public';
import productRoutes from './routes/products';
import categoryRoutes from './routes/categories';
import heroRoutes from './routes/hero';
import settingsRoutes from './routes/settings';
import comboRoutes from './routes/combos';
import orderRoutes from './routes/orders';
import paymentRoutes from './routes/payment';
import couponRoutes from './routes/coupons';
import reviewRoutes from './routes/reviews';
import uploadRoutes from './routes/upload';
import popupRoutes from './routes/popups';
import socialProofRoutes from './routes/social-proof';
import genderRoutes from './routes/genders';
// ===== ADMIN ROUTES =====
import adminRoutes from './routes/admin';
import adminHeroRoutes from './routes/adminHero';
import adminPopupRoutes from './routes/adminPopups';
import productColorRoutes from './routes/product-colors';
import { adminOptionRoutes, publicOptionRoutes } from './routes/options';

assertSecureConfig();

const app = express();

// Behind nginx/a load balancer, trust the proxy so rate limiting sees the real client IP.
if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

// Security headers. The API is called cross-origin by the storefront, so allow cross-origin resource loads.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

/* ===================== CORS ===================== */
if (config.isProduction && config.corsOrigins.length === 0) {
  console.warn('⚠️  CORS_ORIGINS is not set: any website can call this API from a browser. Set it in production.');
}
app.use(cors({
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.options('*', cors());

// JSON bodies are small (files go through multipart upload routes, which have their own limits).
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Locally-stored uploaded images/videos (replaces Cloudflare R2). Served as plain static files: no directory
// listing, no dotfiles (hides .gitkeep etc.), no symlink traversal, and no execution of any kind — this
// directory only ever holds images/video the upload routes wrote via saveBuffer(), never scripts.
app.use('/uploads', express.static(UPLOAD_ROOT, {
  dotfiles: 'deny',
  index: false,
  redirect: false,
  fallthrough: false,
}));

console.log('📝 Registering routes...');

/* ===================== ADMIN AUTH ===================== */
app.use('/api/admin/auth', adminAuthRoutes);

/* ===================== PUBLIC APIs ===================== */
app.use('/api/products', productRoutes);
console.log('✅ /api/products');

app.use('/api/genders', genderRoutes);
// Alias so admin components calling /api/admin/genders also work
app.use('/api/admin/genders', genderRoutes);

app.use('/api/categories', categoryRoutes);
console.log('✅ /api/categories');

app.use('/api/hero', heroRoutes);
console.log('✅ /api/hero');

app.use('/api/logo', logoRoutes);
console.log('✅ /api/logo');

app.use('/api/settings', settingsRoutes);
console.log('✅ /api/settings');

app.use('/api/combos', comboRoutes);
console.log('✅ /api/combos');

app.use('/api/orders', orderRoutes);
console.log('✅ /api/orders');

app.use('/api/payment', paymentRoutes);
console.log('✅ /api/payment');

app.use('/api/coupons', couponRoutes);
console.log('✅ /api/coupons');

app.use('/api/reviews', reviewRoutes);
console.log('✅ /api/reviews');

app.use('/api/upload', uploadRoutes);
console.log('✅ /api/upload');

app.use('/api/popups', popupRoutes);
console.log('✅ /api/popups');

app.use('/api/social-proof', socialProofRoutes);
console.log('✅ /api/social-proof');

app.use('/api/admin/combos', comboRoutes);
console.log('✅ /api/admin/combos');

app.use('/api/admin/hero', adminHeroRoutes);
console.log('✅ /api/admin/hero');

// Public color routes: GET /api/products/:id/colors
app.use('/api', publicColorRoutes);
console.log('✅ /api/products/:id/colors (public)');

// Generic product options: public read + admin management
app.use('/api', publicOptionRoutes);
app.use('/api/admin', adminOptionRoutes);
console.log('✅ /api/admin/option-groups, /api/admin/products/:id/options');

// Public size routes: GET /api/products/:id/sizes
app.use('/api', productSizeRoutes);
console.log('✅ /api/products/:id/sizes (public)');

app.use('/api/admin/popups', adminPopupRoutes);
console.log('✅ /api/admin/popups');

// Admin color routes: /api/admin/products/:id/colors (GET all, POST, DELETE all)
app.use('/api/admin', productColorRoutes);
console.log('✅ /api/admin/products/:id/colors (admin)');

// Admin size routes: /api/admin/products/:id/sizes (POST, DELETE all, GET /all)
app.use('/api/admin', productSizeRoutes);
console.log('✅ /api/admin/products/:id/sizes (admin)');
/* ===================== ADMIN APIs ===================== */
app.use('/api/admin', adminRoutes);
console.log('✅ /api/admin');

app.use('/api/admin/hero', adminHeroRoutes);
console.log('✅ /api/admin/hero');

app.use('/api/admin/popups', adminPopupRoutes);
console.log('✅ /api/admin/popups');
/* ===================== HEALTH ===================== */
app.get('/health', (_req, res) => {
  res.json({ status: 'OK', time: new Date().toISOString() });
});

app.get('/api/test', (_req, res) => {
  res.json({ message: 'Backend is working 🚀' });
});
// ADMIN ONLY: diagnostic — must not be public (it talks to the mail server and used to echo raw errors).
app.get('/smtp-test', requireAuth, async (_req, res) => {
  try {
    await transporter.verify();
    res.json({ status: "SMTP working ✅" });
  } catch (err) {
    console.error("SMTP test failed:", err);
    res.status(500).json({ status: "SMTP failed ❌" });
  }
});

// JSON 404 + error handler (multer/file errors and body-parse errors return JSON instead of an HTML stack trace).
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err?.name === 'MulterError' || /Invalid file type/i.test(err?.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(err?.status || 500).json({ error: 'Internal server error' });
});
export default app;
