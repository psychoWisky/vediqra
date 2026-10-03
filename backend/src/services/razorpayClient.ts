import Razorpay from 'razorpay';
import config from '../config';
import { PricingError } from './pricing';

/** The small part of the Razorpay SDK this app uses; tests substitute a deterministic fake. */
export interface RazorpayLike {
  orders: {
    create: (params: any) => Promise<any>;
    fetch: (id: string) => Promise<any>;
  };
  payments: {
    refund: (paymentId: string, params: any) => Promise<any>;
  };
}

let client: RazorpayLike | null = null;

/** Created on first use so the API starts (and every non-payment route works) without Razorpay keys. */
export function getRazorpay(): RazorpayLike {
  if (client) return client;
  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    throw new PricingError('Online payments are not configured', 503);
  }
  client = new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpayKeySecret }) as unknown as RazorpayLike;
  return client;
}

/** Test seam: install a fake client (or pass null to go back to the real SDK). */
export function setRazorpayClient(fake: RazorpayLike | null): void {
  client = fake;
}
