import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { CartItem } from '../types';
import { fromPaise, toPaise } from '../utils/money';

/** One priced cart line as the server calculated it (the same order as the cart; `id` echoes the cart line id). */
export interface ServerQuoteLine {
  id: string;
  price: number;        // unit price including chosen options / personalisation fee
  quantity: number;
  line_total?: number;
}

/** Amounts calculated by the server (POST /api/orders/quote). The browser never decides what is charged. */
export interface ServerQuote {
  subtotal: number;
  shipping_charge: number;
  coupon_discount: number;
  total_amount: number;
  // Configured checkout rules, echoed by the server so the frontend never keeps its own copy of them.
  shipping_threshold: number;
  shipping_fee: number;
  items?: ServerQuoteLine[];
}

// Send only what the server needs to price the cart: ids, quantities, chosen options and customization
// content. Prices are deliberately not sent, and large image previews are dropped.
const stripCustomization = (c: any) =>
  c ? { text_lines: c.text_lines, image_urls: c.image_urls, image_paths: c.image_paths } : undefined;

export const toPricingItems = (cartItems: any[]) =>
  cartItems.map((item) => ({
    id: item.id,
    type: item.type,
    product_id: item.product_id,
    // only the option value ids are sent; the server looks up names and price modifiers itself
    selected_options: item.selected_options?.map((o: any) => o.value_id),
    combo_id: item.combo_id,
    name: item.type === 'combo' ? item.name : undefined,
    quantity: item.quantity,
    image_url: typeof item.image_url === 'string' && !item.image_url.startsWith('data:') ? item.image_url : undefined,
    color_id: item.color_id,
    size_id: item.size_id,
    customization: stripCustomization(item.customization),
    combo_products: item.combo_products?.map((cp: any) => ({
      id: cp.id,
      quantity: cp.quantity,
      image_url: typeof cp.image_url === 'string' && !cp.image_url.startsWith('data:') ? cp.image_url : undefined,
      color_id: cp.color_id,
      size_id: cp.size_id,
      selected_options: cp.selected_options?.map((o: any) => (typeof o === 'string' ? o : o.value_id)),
      customization: stripCustomization(cp.customization),
    })),
  }));

/**
 * The server's price for cart line `index`, or null when the quote does not (or no longer) describe that line - for example
 * while a new quote for a changed quantity is still on its way. The line must have the same id and quantity as the cart's.
 */
export const serverLine = (quote: ServerQuote | null, item: CartItem, index: number): { price: number; total: number } | null => {
  const l = quote?.items?.[index];
  if (!l || l.id !== String(item.id).slice(0, 200) || Number(l.quantity) !== Number(item.quantity)) return null;
  const price = Number(l.price);
  if (!Number.isFinite(price)) return null;
  return { price, total: fromPaise(toPaise(price) * Math.max(0, Math.floor(item.quantity))) };
};

interface Internal { online: ServerQuote | null; loading: boolean; error: string | null; couponRejected: string | null; forKey: string | null }

export interface QuoteState {
  online: ServerQuote | null;
  loading: boolean;
  /** Customer-facing reason the server could not price the cart (sold out, invalid option ...). Never a coupon problem. */
  error: string | null;
  /** The server rejected the coupon itself: the same cart priced fine without it (`online` is that coupon-free quote). */
  couponRejected: string | null;
  /** `online` is a good quote for exactly what is on screen now (same cart, coupon and email): safe to show and to pay on. */
  ready: boolean;
  /** Ask the server again (after a failure). */
  refresh: () => void;
}

/**
 * Server quote for the current cart. Online payment is the only payment method, so there is one quote. The order
 * is still priced authoritatively by the server when the payment is created and again when it is verified.
 *
 * When a quote with a coupon is refused with a 4xx, the cart is priced again WITHOUT the coupon: if that works the coupon
 * is what failed (`couponRejected`), otherwise the cart itself cannot be priced (`error`) and the coupon is left alone.
 * No error text is inspected to decide this.
 */
export function useServerQuote(items: CartItem[], opts: { couponCode?: string | null; email?: string; enabled?: boolean } = {}): QuoteState {
  const [state, setState] = useState<Internal>({ online: null, loading: items.length > 0, error: null, couponRejected: null, forKey: null });
  const [nonce, setNonce] = useState(0);
  const itemsKey = JSON.stringify(toPricingItems(items));
  const coupon = opts.couponCode || null;
  const email = opts.email || undefined;
  const enabled = opts.enabled !== false;
  const key = `${itemsKey}|${coupon || ''}|${email || ''}`;

  useEffect(() => {
    if (!enabled || items.length === 0) { setState({ online: null, loading: false, error: null, couponRejected: null, forKey: null }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(async () => {
      const request = (code: string | null) => apiFetch<ServerQuote>('/api/orders/quote', {
        method: 'POST',
        body: JSON.stringify({ items: toPricingItems(items), payment_method: 'online', coupon_code: code, email }),
      });
      try {
        const online = await request(coupon);
        if (!cancelled) setState({ online, loading: false, error: null, couponRejected: null, forKey: key });
      } catch (e: any) {
        let failure = e;
        const status = e?.status;
        if (coupon && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
          try {
            const online = await request(null);
            if (!cancelled) setState({ online, loading: false, error: null, couponRejected: e?.message || 'This coupon cannot be applied.', forKey: key });
            return;
          } catch (e2: any) { failure = e2; }      // the cart itself is the problem; the coupon stays
        }
        if (!cancelled) setState({ online: null, loading: false, error: failure?.message || 'unavailable', couponRejected: null, forKey: key });
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const ready = enabled && !state.loading && !!state.online && !state.error && !state.couponRejected && state.forKey === key;
  return { online: state.online, loading: state.loading, error: state.error, couponRejected: state.couponRejected, ready, refresh };
}
