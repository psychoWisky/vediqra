import { CONFIG } from '../config';

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
  }).format(amount);
};

const FALLBACK_IMAGE = '/placeholder.svg';

// Broken external placeholder services to silently replace with our fallback
const BROKEN_PLACEHOLDER_HOSTS = [
  'via.placeholder.com',
  'placehold.co',
  'placeholder.com',
  'dummyimage.com',
  'unsplash.com',
];

export const getImageUrl = (path: string | undefined | null): string => {
  if (!path) return FALLBACK_IMAGE;
  if (path.startsWith('data:')) return path;
  if (path.startsWith('http') || path.startsWith('https')) {
    try {
      const hostname = new URL(path).hostname;
      if (BROKEN_PLACEHOLDER_HOSTS.some(h => hostname.includes(h))) {
        return FALLBACK_IMAGE;
      }
    } catch {
      // invalid URL — fall through
    }
    return path;
  }
  // Uploads made via the admin panel already return a full https:// URL (see getImageUrl's early
  // return above), so a bare filename or relative path here is leftover data from before local
  // storage replaced Cloudflare R2 (that bucket is no longer used) — there's nothing to resolve it
  // against, so fall back to the placeholder rather than pointing at a decommissioned bucket.
  return FALLBACK_IMAGE;
};


/**
 * Get the best display image for a product.
 * If the product has color variants, returns the first active color's image.
 * Falls back to product.image_url.
 * Pass selectedColorImageUrl to override (e.g. when user picked a specific color).
 */
export const getProductImage = (
  product: { image_url?: string | null; has_colors?: boolean; colors?: Array<{ is_active?: boolean; image_url?: string }> | null },
  selectedColorImageUrl?: string | null
): string => {
  if (selectedColorImageUrl) return selectedColorImageUrl;
  if (product?.has_colors && product.colors && product.colors.length > 0) {
    const firstActive = product.colors.find(c => c.is_active !== false);
    if (firstActive?.image_url) return firstActive.image_url;
  }
  return product?.image_url || '';
};

export const debounce = <T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};