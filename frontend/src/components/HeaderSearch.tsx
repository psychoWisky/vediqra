import React, { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { Product } from '../types';
import { publicFetch } from '../utils/api';
import { formatCurrency, getImageUrl } from '../utils/helpers';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;
const MAX_SUGGESTIONS = 6;

// Suggestions come from the existing GET /api/products/search?q= endpoint. Answers are remembered per term for the page's
// lifetime so typing and deleting does not repeat requests.
const cache = new Map<string, Product[]>();

/**
 * Header search box. Submitting (Enter or the search button) always opens the product listing at /products?search=<term>
 * (an empty box opens /products), exactly as before. While typing, up to six matching products are suggested; the list is a
 * standard combobox (arrow keys, Enter, Escape), never blocks submitting, and quietly disappears if the request fails or
 * returns nothing.
 */
const HeaderSearch: React.FC<{ className?: string; onDone?: () => void }> = ({ className = '', onDone }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const uid = useId();
  const listId = `${uid}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Product[]>([]);
  const [active, setActive] = useState(-1);
  const [typed, setTyped] = useState(false);          // suggestions are only fetched for text the user typed, not a restored query

  // Show the current search on the listing page (so it can be read and edited), and nothing elsewhere.
  useEffect(() => {
    const onListing = location.pathname === '/products';
    setQ(onListing ? new URLSearchParams(location.search).get('search') || '' : '');
    setOpen(false); setItems([]); setActive(-1); setTyped(false);
  }, [location.pathname, location.search]);

  // Debounced, cancellable lookup
  useEffect(() => {
    const term = q.trim();
    if (!typed || term.length < MIN_CHARS) { setItems([]); return; }
    const key = term.toLowerCase();
    const hit = cache.get(key);
    if (hit) { setItems(hit.slice(0, MAX_SUGGESTIONS)); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      publicFetch<Product[]>(`/api/products/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((res) => {
          const list = Array.isArray(res) ? res : [];
          cache.set(key, list);
          setItems(list.slice(0, MAX_SUGGESTIONS));
        })
        .catch(() => { if (!ctrl.signal.aborted) setItems([]); });          // suggestions are optional: stay quiet on errors
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, typed]);

  const term = q.trim();
  const canSuggest = open && typed && term.length >= MIN_CHARS;
  const seeAllIndex = items.length;                 // the last option is always "see all results"
  const optionCount = items.length + 1;
  const productHref = (p: Product) => `/product/${p.slug || p.id}`;

  const finish = () => { setOpen(false); setActive(-1); onDone?.(); };
  const submit = () => {
    navigate(term ? `/products?search=${encodeURIComponent(term)}` : '/products');
    finish();
    inputRef.current?.blur();
  };
  const choose = (index: number) => {
    if (index >= 0 && index < items.length) { navigate(productHref(items[index])); finish(); inputRef.current?.blur(); }
    else submit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (!canSuggest) { setOpen(true); return; }
      e.preventDefault(); setActive((a) => (a + 1) % optionCount);
    } else if (e.key === 'ArrowUp') {
      if (!canSuggest) return;
      e.preventDefault(); setActive((a) => (a <= 0 ? optionCount - 1 : a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (canSuggest && active >= 0) choose(active); else submit();
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setActive(-1); }
      else if (q) setQ('');
    }
  };

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      onBlur={(e) => { if (!rootRef.current?.contains(e.relatedTarget as Node | null)) { setOpen(false); setActive(-1); } }}
    >
      <form role="search" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor={`${uid}-input`} className="sr-only">Search products</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-muted" aria-hidden="true" />
          <input
            id={`${uid}-input`}
            ref={inputRef}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            role="combobox"
            aria-expanded={canSuggest}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={canSuggest && active >= 0 ? `${uid}-opt-${active}` : undefined}
            value={q}
            maxLength={100}
            onChange={(e) => { setQ(e.target.value); setTyped(true); setOpen(true); setActive(-1); }}
            onFocus={() => { if (typed) setOpen(true); }}
            onKeyDown={onKeyDown}
            placeholder="Search products"
            className="input !min-h-[44px] !rounded-full !py-2 !pl-9 !pr-16"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => { setQ(''); setTyped(false); setOpen(false); setItems([]); inputRef.current?.focus(); }}
              className="absolute right-9 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-brand-muted hover:text-brand-ink"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="submit"
            aria-label="Search"
            className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-brand-accent text-[#111111] hover:brightness-95"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </form>

      {canSuggest && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-brand-line bg-brand-elevated shadow-pop">
          <ul id={listId} role="listbox" aria-label="Search suggestions" className="py-1">
            {items.map((p, i) => {
              const price = Number(p.price) || 0;
              return (
                <li
                  key={p.id}
                  id={`${uid}-opt-${i}`}
                  role="option"
                  aria-selected={active === i}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${active === i ? 'bg-brand-subtle' : ''}`}
                >
                  <img
                    src={getImageUrl(p.image_url)}
                    alt=""
                    loading="lazy"
                    onError={(e) => { if (!e.currentTarget.src.endsWith('/placeholder.svg')) e.currentTarget.src = '/placeholder.svg'; }}      // same fallback as the product cards
                    className="h-10 w-10 shrink-0 rounded-md bg-brand-subtle object-cover"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                  {price > 0 && <span className="shrink-0 text-sm text-brand-muted">{formatCurrency(price)}</span>}
                </li>
              );
            })}
            <li
              id={`${uid}-opt-${seeAllIndex}`}
              role="option"
              aria-selected={active === seeAllIndex}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(seeAllIndex)}
              onClick={() => choose(seeAllIndex)}
              className={`cursor-pointer border-t border-brand-line px-3 py-2.5 text-sm font-semibold ${active === seeAllIndex ? 'bg-brand-subtle' : ''}`}
            >
              See all results for &ldquo;{term}&rdquo;
            </li>
          </ul>
          <p className="sr-only" role="status" aria-live="polite">{items.length === 0 ? 'No suggestions' : `${items.length} suggestions`}</p>
        </div>
      )}
    </div>
  );
};

export default HeaderSearch;
