import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { CartItem } from '../types';

/** Amounts calculated by the server (POST /api/orders/quote). The browser never decides what is charged. */
export interface ServerQuote {
  subtotal: number;
  shipping_charge: number;
  cod_charge: number;
  coupon_discount: number;
  total_amount: number;
  // Configured checkout rules, echoed by the server so the frontend never keeps its own copy of them.
  shipping_threshold: number;
  shipping_fee: number;
  cod_fee: number;
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

export interface QuoteState {
  cod: ServerQuote | null;
  online: ServerQuote | null;
  loading: boolean;
  /** Customer-facing reason the server could not price the cart (sold out, invalid option, invalid coupon ...). */
  error: string | null;
}

/**
 * Server quote for the current cart, for both payment methods.
 *
 * Only ONE request is made (payment_method: 'online'): the subtotal, shipping and any coupon discount do not
 * depend on the payment method, only the COD fee does, and the server already echoes that fee as a constant
 * (`cod_fee`) on every quote. The COD quote is the online one with that constant fee added in — arithmetic on
 * two numbers the server gave us, not a second pricing model. The order is still priced authoritatively by the
 * server, for the payment method actually chosen, at checkout.
 */
export function useServerQuote(items: CartItem[], opts: { couponCode?: string | null; email?: string; enabled?: boolean } = {}): QuoteState {
  const [state, setState] = useState<QuoteState>({ cod: null, online: null, loading: items.length > 0, error: null });
  const key = JSON.stringify(toPricingItems(items));
  const coupon = opts.couponCode || null;
  const email = opts.email || undefined;
  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!enabled || items.length === 0) { setState({ cod: null, online: null, loading: false, error: null }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(async () => {
      try {
        const online = await apiFetch<ServerQuote>('/api/orders/quote', {
          method: 'POST',
          body: JSON.stringify({ items: toPricingItems(items), payment_method: 'online', coupon_code: coupon, email }),
        });
        const cod: ServerQuote = { ...online, cod_charge: online.cod_fee, total_amount: online.total_amount + online.cod_fee };
        if (!cancelled) setState({ cod, online, loading: false, error: null });
      } catch (e: any) {
        if (!cancelled) setState({ cod: null, online: null, loading: false, error: e?.message || 'unavailable' });
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, coupon, email, enabled]);

  return state;
}
