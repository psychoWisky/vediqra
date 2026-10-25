/**
 * Tiny in-memory cache for the public catalogue data (products, categories, genders), kept for the life of the page.
 *
 * Freshness policy (prices and stock must never be shown stale for long):
 *   - younger than FRESH_MS      : used as is, no request.
 *   - up to MAX_STALE_MS old     : shown immediately, and refreshed in the background (the screen updates when it arrives).
 *   - older than MAX_STALE_MS    : discarded; the caller waits for a fresh response.
 *   - any successful write (POST/PUT/PATCH/DELETE) made through the API helpers clears everything (see api.ts), so an admin
 *     edit or a placed order is reflected on the next view.
 * Limitation: changes made elsewhere (another browser, another admin) are only picked up when the window above expires.
 *
 * Requests for the same key share one in-flight call. Failures are never cached.
 */
export const FRESH_MS = 60_000;
export const MAX_STALE_MS = 5 * 60_000;

interface Entry { data: unknown; at: number }
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
let generation = 0;   // bumped on invalidation so a response that was already on its way cannot re-populate the cache with old data

/** What the cache holds for `key`: its data and whether it is still fresh, or null when absent / too old. */
export const peek = <T>(key: string): { data: T; fresh: boolean } | null => {
  const e = store.get(key);
  if (!e) return null;
  const age = Date.now() - e.at;
  if (age > MAX_STALE_MS) { store.delete(key); return null; }
  return { data: e.data as T, fresh: age < FRESH_MS };
};

/** Fetch (or join the request already running for) `key`. A successful result is stored unless the cache was cleared meanwhile. */
export const loadShared = <T>(key: string, fetcher: () => Promise<T>): Promise<T> => {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const g = generation;
  const p = fetcher()
    .then((data) => { if (g === generation) store.set(key, { data, at: Date.now() }); return data; })
    .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
};

/** Forget everything (after a successful write). */
export const invalidateCatalogue = () => {
  generation++;
  store.clear();
  inflight.clear();
};
