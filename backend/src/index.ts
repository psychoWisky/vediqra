// dotenv must load before config (which reads process.env at import time)
import 'dotenv/config';
import config from './config';
import app from './app';
import { pool } from './utils/db';
import { startPaymentRecovery } from './services/payments/recovery';

/* ===================== SERVER ===================== */
const PORT = config.port || 5000;

const onListening = () => {
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
};
const server = config.listenHost ? app.listen(Number(PORT), config.listenHost, onListening) : app.listen(PORT, onListening);

// Background payment recovery (only when PAYMENT_RECOVERY_ENABLED=true).
const recovery = startPaymentRecovery();

// Clean shutdown (PM2 restart / deploy): stop taking new work, let the running recovery pass and in-flight requests finish,
// then close the database pool. A hard deadline stops a stuck request from blocking a restart.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received: shutting down`);
  const deadline = setTimeout(() => { console.error('Shutdown timed out; exiting'); process.exit(1); }, 20_000);
  deadline.unref();
  try {
    await recovery?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  } catch (e) {
    console.error('Error during shutdown:', e);
  }
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
