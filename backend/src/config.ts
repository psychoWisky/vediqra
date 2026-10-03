const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,

  // PostgreSQL
  dbHost: process.env.DB_HOST!,
  dbPort: parseInt(process.env.DB_PORT || '5432'),
  dbUser: process.env.DB_USER!,
  dbPassword: process.env.DB_PASSWORD!,
  dbName: process.env.DB_NAME!,
  // Managed hosts (e.g. AWS RDS) need TLS; a local PostgreSQL usually does not.
  // Default: TLS on in production, off otherwise. Override with DB_SSL=true|false.
  dbSsl: process.env.DB_SSL !== undefined ? process.env.DB_SSL === 'true' : isProduction,

  // Admin authentication
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  // Browser origins allowed to call the API (comma separated). Empty = reflect any origin (dev only).
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Number of reverse proxies in front of the app (nginx = 1). Needed for correct client IPs in rate limiting.
  trustProxy: num(process.env.TRUST_PROXY, 0),

  emailHost: process.env.EMAIL_HOST || 'smtp.hostinger.com',
  emailPort: num(process.env.EMAIL_PORT, 465),
  emailSecure: process.env.EMAIL_SECURE !== undefined ? process.env.EMAIL_SECURE === 'true' : num(process.env.EMAIL_PORT, 465) === 465,
  emailUser: process.env.EMAIL_USER || '',
  emailPassword: process.env.EMAIL_PASSWORD || '',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',

  // Brand identity used in emails, invoices and admin notifications (never hardcode GFTD/old-brand values).
  brandName: process.env.BRAND_NAME || 'VEDIQRA',
  // Where customer-facing admin notifications (new order, etc.) are sent. Falls back to the sending mailbox
  // (emailUser) if not set, so notifications still go SOMEWHERE rather than to a hardcoded old address.
  supportEmail: process.env.SUPPORT_EMAIL || '',
  supportPhone: process.env.SUPPORT_PHONE || '',
  websiteUrl: (process.env.WEBSITE_URL || '').trim().replace(/\/+$/, ''),
  // Absolute base URL this server is reachable at, used to build public URLs for uploaded files
  // (e.g. https://api.example.com). Empty = derive from the incoming request (protocol + Host header),
  // which works for local dev and most single-domain deployments without any configuration.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),

  // Order pricing rules (authoritative — the storefront no longer decides these)
  orderIdPrefix: process.env.ORDER_ID_PREFIX || 'VEDIQRA',
  freeShippingThreshold: num(process.env.FREE_SHIPPING_THRESHOLD, 499),
  shippingFee: num(process.env.SHIPPING_FEE, 79),
  codFee: num(process.env.COD_FEE, 49),
};

/**
 * Fail fast on configuration that would make the server insecure.
 * Called once at startup (index.ts) before the app begins listening.
 */
export function assertSecureConfig(): void {
  if (config.jwtSecret.length < 32) {
    throw new Error(
      'JWT_SECRET must be set to a random string of at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
}

export default config;
