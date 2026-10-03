import { BRAND } from '../config/brand';

// Meta Pixel, loaded only when a VEDIQRA pixel ID is actually configured (VITE_META_PIXEL_ID). There is no
// hardcoded fallback ID — the old GFTD pixel (957937870042397) sent VEDIQRA's traffic to GFTD's ad account,
// which is why it was removed rather than "fixed in place". With no ID configured this module does nothing:
// no script is injected, no request is made, and every tracking call below is a silent no-op.
declare global {
  interface Window { fbq?: ((...args: unknown[]) => void) & { callMethod?: unknown; queue?: unknown[]; loaded?: boolean; version?: string }; _fbq?: unknown }
}

let initialized = false;

/** Injects the Meta pixel script once, if (and only if) BRAND.metaPixelId is set. Safe to call repeatedly. */
export function initMetaPixel(): void {
  if (initialized || !BRAND.metaPixelId || typeof window === 'undefined') return;
  initialized = true;

  if (!window.fbq) {
    const fbq: any = function (...args: unknown[]) {
      fbq.callMethod ? fbq.callMethod.apply(fbq, args) : fbq.queue!.push(args);
    };
    window.fbq = fbq;
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }
  window.fbq!('init', BRAND.metaPixelId);
  window.fbq!('track', 'PageView');
}

/** Call on each client-side route change (the initial load is covered by initMetaPixel itself). */
export function trackPageView(): void {
  if (!BRAND.metaPixelId) return;
  window.fbq?.('track', 'PageView');
}
