/**
 * Unified API utility — works correctly in both local dev and production.
 *
 * LOCAL:  VITE_API_URL is NOT set (or '').
 *         Vite proxies /api/* → http://localhost:5000/api/*
 *         So we just call /api/... directly (no base prefix needed).
 *
 * PRODUCTION: nginx on the storefront's own domain proxies /api/ → http://127.0.0.1:5000/
 *             VITE_API_URL should be '' (empty string) in the .env.production
 *             So we still call /api/... directly. Nginx handles it.
 *
 * NEVER set VITE_API_URL to something like "https://example.com/api" — that
 * creates double /api/api prefixes. Leave it empty.
 */

const getBaseUrl = (): string => {
  const raw = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
  // Safety: if someone accidentally set it to end with /api, strip it to avoid doubling
  return raw.endsWith('/api') ? raw.slice(0, -4) : raw;
};

/** Error carrying the HTTP status so callers can tell "your input was rejected" (4xx) from "our server failed" (5xx). */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** The server's own message from a JSON error body when there is one, otherwise a generic one. */
const errorFrom = async (res: Response, prefix = 'API error'): Promise<HttpError> => {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    const m = j.message || j.error;
    if (m) return new HttpError(String(m), res.status);
  } catch { /* not JSON */ }
  return new HttpError(`${prefix} ${res.status}: ${text.substring(0, 100)}`, res.status);
};

/**
 * Build the full URL for an API path.
 * Always pass paths starting with /api/  e.g. '/api/admin/products'
 */
export const buildUrl = (path: string): string => {
  const base = getBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
};

/** Admin fetch — attaches Authorization header automatically */
export const apiFetch = async <T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> => {
  const url = buildUrl(path);
  const token = localStorage.getItem('admin_token');
  const isFormData = options.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string> || {}),
  };

  const res = await fetch(url, { ...options, headers });

  // Expired/invalid admin session: drop the token and return to the login screen.
  if (res.status === 401 && token && !path.includes('/admin/auth/login')) {
    localStorage.removeItem('admin_token');
    if (window.location.pathname.startsWith('/admin')) window.location.reload();
  }

  if (!res.ok) throw await errorFrom(res);

  return res.json();
};

/** Public fetch — no auth header */
export const publicFetch = async <T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> => {
  const url = buildUrl(path);
  const isFormData = options.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string> || {}),
  };

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) throw await errorFrom(res);

  return res.json();
};

/** Upload helper — sends FormData with auth */
export const uploadFetch = async <T = any>(
  path: string,
  formData: FormData
): Promise<T> => {
  const url = buildUrl(path);
  const token = localStorage.getItem('admin_token');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(`Upload error ${res.status}: ${text.substring(0, 100)}`, res.status);
  }

  return res.json();
};
