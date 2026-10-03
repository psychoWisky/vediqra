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
export const paymentLimiter = make(15, 30, 'Too many payment requests. Please try again shortly.');

/** Refunds (admin only, but keep a hard ceiling anyway). */
// RATE_LIMIT_REFUNDS raises the ceiling for automated test runs; the default is the production value.
export const refundLimiter = make(60, Number(process.env.RATE_LIMIT_REFUNDS) || 10, 'Too many refund requests.');

/** Public order creation (COD) and price quotes. */
// RATE_LIMIT_ORDERS raises the ceiling for automated test runs; the default is the production value.
export const orderLimiter = make(15, Number(process.env.RATE_LIMIT_ORDERS) || 60, 'Too many order requests. Please try again shortly.');

/** Public file uploads (customer customization images). */
export const publicUploadLimiter = make(15, 60, 'Too many uploads. Please try again later.');

/** Public write endpoints: reviews, custom combos. */
export const publicWriteLimiter = make(60, 20, 'Too many submissions. Please try again later.');

/** Coupon code checks (stops code guessing). */
export const couponLimiter = make(15, 60, 'Too many coupon attempts. Please try again shortly.');
