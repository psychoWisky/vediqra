// dotenv must load before config (which reads process.env at import time)
import 'dotenv/config';
import config from './config';
import app from './app';

/* ===================== SERVER ===================== */
const PORT = config.port || 5000;

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`🔎 Health: http://localhost:${PORT}/health`);
  console.log(`📦 Products: http://localhost:${PORT}/api/products`);
  console.log(`🏷️ Categories: http://localhost:${PORT}/api/categories`);
  console.log(`🎬 Hero: http://localhost:${PORT}/api/hero`);
  console.log(`🎯 Logo: http://localhost:${PORT}/api/logo/active`);
  console.log(`🎯 Admin Logo: http://localhost:${PORT}/api/logo/admin`);
  console.log(`📋 Orders: http://localhost:${PORT}/api/orders`);
  console.log(`🎫 Coupons: http://localhost:${PORT}/api/coupons`);
  console.log(`🔐 Admin: http://localhost:${PORT}/api/admin\n`);
});