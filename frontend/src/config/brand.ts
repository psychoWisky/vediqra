// VEDIQRA storefront brand configuration.
// Everything here is a PLACEHOLDER-SAFE default: nothing is invented. Contact details and social links are read from
// environment variables (VITE_*) and simply do not render until the client supplies them.
const env = import.meta.env;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const BRAND = {
  name: 'VEDIQRA',
  // Wordmark shown when no logo has been uploaded in the admin (Marketing > Logo).
  wordmark: 'VEDIQRA',
  // Neutral descriptor built only from what the catalogue is (personalised / custom products).
  tagline: 'Personalised gifts and custom-printed products.',
  supportEmail: clean(env.VITE_SUPPORT_EMAIL),
  // VITE_SUPPORT_PHONE overrides the default below.
  supportPhone: clean(env.VITE_SUPPORT_PHONE) || '9163169689',
  // Business address, one entry per displayed line (exact wording as supplied by the client).
  address: [
    '8, block-e, 252, Solua dashadrone',
    'Opposite lane of SBI Bank',
    'Ground floor',
    'Near vip sweets lane',
    'Kolkata 700136',
  ],
  websiteUrl: clean(env.VITE_WEBSITE_URL),
  // Meta (Facebook) Pixel ID. Empty = analytics disabled entirely (see utils/metaPixel.ts) — there is
  // no default/fallback ID shipped, so a fresh checkout never reports to someone else's ad account.
  metaPixelId: clean(env.VITE_META_PIXEL_ID),
  social: {
    instagram: clean(env.VITE_SOCIAL_INSTAGRAM),
    facebook: clean(env.VITE_SOCIAL_FACEBOOK),
    youtube: clean(env.VITE_SOCIAL_YOUTUBE),
    x: clean(env.VITE_SOCIAL_X),
  },
} as const;
