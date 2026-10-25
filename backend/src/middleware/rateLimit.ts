import rateLimit from 'express-rate-limit';

const make = (windowMinutes: number, max: number, message: string) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message },
  });

/** Admin login: brute-force protection. */
export const loginLimiter = make(15, 10, 'Too many login attempts. Try again in 15 minutes.');

/** Razorpay order creation / payment verification. */
// RATE_LIMIT_PAYMENTS raises the ceiling for automated test runs (every test order is now 2 payment requests);
// the default is the production value.
export const paymentLimiter = make(15, Number(process.env.RATE_LIMIT_PAYMENTS) || 30, 'Too many payment requests. Please try again shortly.');

/** Refunds (admin only, but keep a hard ceiling anyway). */
// RATE_LIMIT_REFUNDS raises the ceiling for automated test runs; the default is the production value.
export const refundLimiter = make(60, Number(process.env.RATE_LIMIT_REFUNDS) || 10, 'Too many refund requests.');

/** Public price quotes. */
// RATE_LIMIT_ORDERS raises the ceiling for automated test runs; the default is the production value.
export const orderLimiter = make(15, Number(process.env.RATE_LIMIT_ORDERS) || 60, 'Too many order requests. Please try again shortly.');

/** Public file uploads (customer customization images). */
export const publicUploadLimiter = make(15, 60, 'Too many uploads. Please try again later.');

/** Public write endpoints: reviews, custom combos. */
export const publicWriteLimiter = make(60, 20, 'Too many submissions. Please try again later.');

/** Coupon code checks (stops code guessing). */
export const couponLimiter = make(15, 60, 'Too many coupon attempts. Please try again shortly.');

/** Customer payment-status lookups (a token is required, but keep a ceiling against guessing). */
// RATE_LIMIT_STATUS raises the ceiling for automated test runs; the default is the production value.
export const statusLimiter = make(15, Number(process.env.RATE_LIMIT_STATUS) || 60, 'Too many status checks. Please try again shortly.');

/**
 * Razorpay webhook endpoint (no customer login, so this is the abuse protection). Runs BEFORE the body is read or any
 * database/provider work. The limit is generous for real traffic (Razorpay sends a handful of events per payment, and retries
 * only after non-2xx answers) and returns 429 with Retry-After: a legitimate event that is turned away is simply redelivered
 * later by Razorpay (and found by the recovery job in the meantime). Counters live in THIS process's memory, so with N
 * application instances the effective ceiling is N times the setting (see docs/PAYMENT_RECOVERY.md). Nothing about the
 * request (IP, headers, body, signature) is logged.
 */
// RATE_LIMIT_WEBHOOK: requests per minute per client IP (default 300, clamped 10-100000).
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Math.min(Math.max(Number(process.env.RATE_LIMIT_WEBHOOK) || 300, 10), 100000),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader('Retry-After', '30');
    res.status(429).json({ error: 'rate limited, please retry later' });
  },
});
