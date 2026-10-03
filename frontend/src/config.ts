export const CONFIG = {
  API_URL: (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, ''),
  // Razorpay's public key id normally comes from the server (POST /api/payment/create-order returns it).
  // This is only a fallback; set VITE_RAZORPAY_KEY_ID if you need one. No default is shipped.
  RAZORPAY_KEY_ID: import.meta.env.VITE_RAZORPAY_KEY_ID || '',
} as const;

// Re-export unified API functions so all existing imports from 'config' still work
export { apiFetch, publicFetch, uploadFetch, buildUrl } from './utils/api';
