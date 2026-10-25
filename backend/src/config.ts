const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

/** An ISO date/time from the environment, or null when unset. A value that is set but not a valid date is an error, not "off". */
const isoDate = (name: string): Date | null => {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} must be an ISO date/time such as 2026-01-31T10:00:00Z (got an unparseable value)`);
  return d;
};

/**
 * TRUST_PROXY: which direct peers Express believes when they say "the real client is X" (X-Forwarded-For). Everything the app does
 * with client IPs (every rate limiter) depends on it.
 *   unset / 0       trust nobody: the socket address is the client (right when nothing is in front of the app)
 *   a small number  trust that many proxy HOPS (1 = exactly one reverse proxy)
 *   loopback        trust only a proxy on this machine (127.0.0.1 / ::1) - the recommended value for nginx on the same host
 *   IPs / CIDRs     a comma separated list of trusted proxy addresses or ranges (also the words loopback, linklocal, uniquelocal)
 * Anything else, including `true` (which would trust ANY caller's forwarded header), is refused at start-up.
 */
const TRUST_WORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const IP_OR_CIDR = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;
function parseTrustProxy(raw: string | undefined): { value: number | string; error?: string } {
  const v = (raw ?? '').trim();
  if (v === '') return { value: 0 };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n <= 3 ? { value: n } : { value: 0, error: 'TRUST_PROXY hop counts above 3 are refused; use `loopback` or an explicit address list' };
  }
  const parts = v.split(',').map((x) => x.trim());
  if (parts.length > 0 && parts.every((x) => TRUST_WORDS.has(x) || (IP_OR_CIDR.test(x) && x.includes('.') || IP_OR_CIDR.test(x) && x.includes(':')))) return { value: parts.join(',') };
  return { value: 0, error: 'TRUST_PROXY must be a hop count (0-3), `loopback`, or a comma separated list of proxy IPs/CIDRs (never `true`)' };
}
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

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
  trustProxy: trustProxy.value as number | string,
  trustProxyError: trustProxy.error,
  // Interface the HTTP server listens on. Unset = all interfaces (unchanged). With nginx on the same host set 127.0.0.1 so only nginx
  // can reach the app (otherwise anyone who can reach the port could forge X-Forwarded-For).
  listenHost: (process.env.LISTEN_HOST || '').trim(),

  emailHost: process.env.EMAIL_HOST || 'smtp.hostinger.com',
  emailPort: num(process.env.EMAIL_PORT, 465),
  emailSecure: process.env.EMAIL_SECURE !== undefined ? process.env.EMAIL_SECURE === 'true' : num(process.env.EMAIL_PORT, 465) === 465,
  emailUser: process.env.EMAIL_USER || '',
  emailPassword: process.env.EMAIL_PASSWORD || '',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  // Razorpay API host for the direct-HTTPS calls (payment lookups, idempotent refunds). Only tests change this, to
  // point at a local stub; in production it must be https (checked in assertSecureConfig).
  razorpayApiBase: (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com').trim().replace(/\/+$/, ''),
  // Deadline for each of those calls. Clamped so a typo cannot make a refund wait forever or fail instantly.
  razorpayTimeoutMs: Math.min(Math.max(num(process.env.RAZORPAY_TIMEOUT_MS, 10000), 1000), 60000),
  // Webhook signing secret(s): a separate secret from the API key, set per webhook in the Razorpay dashboard (test
  // and live differ). The previous one is only for verifying retries of events signed before a rotation.
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  razorpayWebhookSecretPrevious: process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS || '',
  // Payment recovery (background job). Off unless explicitly enabled so nothing runs by surprise.
  paymentRecoveryEnabled: process.env.PAYMENT_RECOVERY_ENABLED === 'true',
  paymentRecoveryIntervalMs: Math.min(Math.max(num(process.env.PAYMENT_RECOVERY_INTERVAL_MS, 60000), 15000), 3600000),
  // Most webhook events processed at once in this process; further ones get 503 + Retry-After (Razorpay retries them).
  webhookMaxConcurrent: Math.min(Math.max(Math.trunc(num(process.env.WEBHOOK_MAX_CONCURRENT, 25)), 1), 500),
  // One-time bridge for Razorpay orders created BEFORE payment intents existed. Disabled unless BOTH are set, and the
  // window may not exceed 24 hours after INTENTS_ENABLED_AT (enforced in assertSecureConfig).
  intentsEnabledAt: isoDate('INTENTS_ENABLED_AT'),
  legacyVerifyUntil: isoDate('LEGACY_VERIFY_UNTIL'),

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
};

/**
 * Fail fast on configuration that would make the server insecure.
 * Called once at startup (index.ts) before the app begins listening.
 */
export const LEGACY_VERIFY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export function assertSecureConfig(): void {
  if (config.trustProxyError) throw new Error(config.trustProxyError);
  assertTestModeGuard();
  if (!/^https?:\/\/[^\s/]+$/.test(config.razorpayApiBase)) {
    throw new Error('RAZORPAY_API_BASE must look like https://api.razorpay.com (scheme and host only)');
  }
  if (config.isProduction && !config.razorpayApiBase.startsWith('https://')) {
    throw new Error('RAZORPAY_API_BASE must use https in production');
  }
  if (config.legacyVerifyUntil && !config.intentsEnabledAt) {
    throw new Error('LEGACY_VERIFY_UNTIL requires INTENTS_ENABLED_AT (the deployment time the window is measured from)');
  }
  if (config.legacyVerifyUntil && config.intentsEnabledAt) {
    const windowMs = config.legacyVerifyUntil.getTime() - config.intentsEnabledAt.getTime();
    if (windowMs <= 0 || windowMs > LEGACY_VERIFY_MAX_WINDOW_MS) {
      throw new Error('LEGACY_VERIFY_UNTIL must be after INTENTS_ENABLED_AT and at most 24 hours later');
    }
  }
  if (config.paymentRecoveryEnabled && (!config.razorpayKeyId || !config.razorpayKeySecret)) {
    throw new Error('PAYMENT_RECOVERY_ENABLED=true needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  }
  if (config.razorpayKeyId && config.razorpayKeySecret && config.isProduction) {
    if (!config.razorpayWebhookSecret) {
      console.warn('⚠️  RAZORPAY_WEBHOOK_SECRET is not set: Razorpay webhooks are rejected (503), so a payment whose browser never returns is only recovered by the background job. Set it and enable the webhook in the Razorpay dashboard.');
    }
    if (!config.paymentRecoveryEnabled) {
      console.warn('⚠️  PAYMENT_RECOVERY_ENABLED is not true: stuck payments, refunds and e-mails are NOT retried in the background. Enable it in production (single PM2 instance, or any number: workers coordinate through the database).');
    }
  }
  if (config.razorpayWebhookSecret && config.razorpayWebhookSecret.length < 8) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is too short; use the secret you set on the Razorpay webhook (at least 8 characters)');
  }
  if (config.razorpayWebhookSecretPrevious && !config.razorpayWebhookSecret) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET_PREVIOUS requires RAZORPAY_WEBHOOK_SECRET');
  }
  if (config.jwtSecret.length < 32) {
    throw new Error(
      'JWT_SECRET must be set to a random string of at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
}

export default config;

/**
 * Opt-in TEST-MODE GUARD (PAYMENT_TEST_MODE_GUARD=true). Off by default - ordinary deployments are unaffected. When on, the process
 * refuses to start unless it is demonstrably pointed at Razorpay TEST credentials and a disposable database:
 *   - RAZORPAY_KEY_ID must start with `rzp_test_` (a missing key, `rzp_live_` or anything else is refused),
 *   - DB_NAME must match `vediqra_test_<letters/digits/underscores>` or be listed in TEST_MODE_ALLOWED_DB_NAMES. The exact name
 *     `vediqra` is refused even if it is listed.
 * The value must be exactly `true` or `false`; anything else is ambiguous and refused. Error messages never contain key values or
 * connection details. LIMITS: this only covers this application (and the migrate wrapper, which applies the same rule); it does not
 * stop other tools (psql, pg_dump, a hand-run script) or the storefront's own key setting, and NODE_ENV plays no part in it.
 */
export const TEST_DB_PATTERN = /^vediqra_test_[a-z0-9_]+$/;
export function testModeGuardProblems(env: Record<string, string | undefined>): string[] {
  const flag = (env.PAYMENT_TEST_MODE_GUARD ?? '').trim();
  if (flag === '' || flag === 'false') return [];
  if (flag !== 'true') return ['PAYMENT_TEST_MODE_GUARD must be exactly "true" or "false"'];
  const problems: string[] = [];
  const keyId = (env.RAZORPAY_KEY_ID ?? '').trim();
  if (!keyId) problems.push('test-mode guard: RAZORPAY_KEY_ID is missing (a Razorpay TEST key id starting with rzp_test_ is required)');
  else if (!keyId.startsWith('rzp_test_')) problems.push('test-mode guard: RAZORPAY_KEY_ID is not a Razorpay TEST key (it must start with rzp_test_)');
  const db = (env.DB_NAME ?? '').trim();
  const allowed = (env.TEST_MODE_ALLOWED_DB_NAMES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!db) problems.push('test-mode guard: DB_NAME is missing');
  else if (db === 'vediqra') problems.push('test-mode guard: DB_NAME "vediqra" is the real database and is never allowed');
  else if (!TEST_DB_PATTERN.test(db) && !allowed.includes(db)) problems.push('test-mode guard: DB_NAME must look like vediqra_test_<name> or be listed in TEST_MODE_ALLOWED_DB_NAMES');
  return problems;
}
function assertTestModeGuard(): void {
  const problems = testModeGuardProblems(process.env);
  if (problems.length) throw new Error(problems.join('; '));
}
