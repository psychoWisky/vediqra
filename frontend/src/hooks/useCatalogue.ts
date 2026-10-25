import { useCallback, useEffect, useRef, useState } from 'react';
import { publicFetch } from '../utils/api';
import { loadShared, peek } from '../utils/catalogueCache';

/** A request that has not answered after this long is abandoned and reported as an error (with a retry). */
const TIMEOUT_MS = Number(import.meta.env.VITE_CATALOGUE_TIMEOUT_MS) || 15_000;

const fetchWithTimeout = async <T,>(path: string): Promise<T> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await publicFetch<T>(path, { signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('The request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

export type CatalogueStatus = 'loading' | 'ready' | 'error';

/**
 * A public list from the shared catalogue cache.
 *  - cached and fresh        -> ready immediately, no request
 *  - cached but past FRESH   -> ready immediately with the old data, refreshed quietly in the background (a failed refresh keeps
 *                               the old data and shows no error)
 *  - nothing cached          -> 'loading', then 'ready' or 'error' (a hung request becomes an error after the timeout)
 * `retry()` forces a new attempt. Results arriving after the component is gone are ignored.
 */
export function useCatalogue<T>(path: string, empty: T): { data: T; status: CatalogueStatus; retry: () => void } {
  const initial = peek<T>(path);
  const [data, setData] = useState<T>(initial ? initial.data : empty);
  const [status, setStatus] = useState<CatalogueStatus>(initial ? 'ready' : 'loading');
  const alive = useRef(true);
  const attempt = useRef(0);

  const run = useCallback((quiet: boolean) => {
    const mine = ++attempt.current;
    if (!quiet) setStatus('loading');
    loadShared<T>(path, () => fetchWithTimeout<T>(path))
      .then((d) => { if (alive.current && mine === attempt.current) { setData(d); setStatus('ready'); } })
      .catch(() => { if (alive.current && mine === attempt.current && !quiet) setStatus('error'); });
  }, [path]);

  useEffect(() => {
    alive.current = true;
    const hit = peek<T>(path);
    if (!hit) run(false);
    else if (!hit.fresh) run(true);
    return () => { alive.current = false; attempt.current++; };
  }, [path, run]);

  return { data, status, retry: useCallback(() => run(false), [run]) };
}
