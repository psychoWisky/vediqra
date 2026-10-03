import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { Category } from '../types';

// The category tree is needed by the header, the footer and the homepage. Fetch it once per page load and share it.
let cached: Category[] | null = null;
let inflight: Promise<Category[]> | null = null;

const load = (): Promise<Category[]> => {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = apiFetch<Category[]>('/api/categories?tree=1')
      .then((data) => {
        cached = Array.isArray(data) ? data : [];
        return cached;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
};

/** Top-level categories, each with `children` (subcategories), straight from the API. Nothing is hardcoded. */
export function useCategoryTree() {
  const [tree, setTree] = useState<Category[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    load()
      .then((t) => { if (alive) { setTree(t); setError(false); } })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return { tree, loading, error };
}

/** Link to the product listing filtered by a category (the listing includes a parent's subcategories). */
export const categoryLink = (c: Pick<Category, 'name'>) => `/products?category=${encodeURIComponent(c.name)}`;
