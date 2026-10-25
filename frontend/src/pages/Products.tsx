import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Filter, X, SlidersHorizontal, Search, Share2 } from 'lucide-react';
import ProductCard from '../components/ProductCard';
import { Product, Gender, Category } from '../types';
import { useCatalogue } from '../hooks/useCatalogue';
import { getImageUrl } from '../utils/helpers';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { BRAND } from '../config/brand'
import { Modal } from '../components/ui/Modal';
import { Button, ButtonLink } from '../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States';
import { BUDGET_BANDS, budgetLink, priceFilterLabel } from '../utils/shopLinks';

/* ─── Dynamic OG / Twitter meta helper ─── */
// `title` is the plain page title; the brand name is appended here (once) for the document title.
const setMetaTags = (title: string, description: string, imageUrl: string, url: string) => {
  const upsert = (selector: string, attrName: string, attrVal: string, contentVal: string) => {
    let el = document.querySelector(selector) as HTMLMetaElement | null;
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attrName, attrVal);
      document.head.appendChild(el);
    }
    el.setAttribute('content', contentVal);
  };
  document.title = `${title} — ${BRAND.name}`;
  upsert('meta[name="description"]', 'name', 'description', description);
  upsert('meta[property="og:title"]', 'property', 'og:title', title);
  upsert('meta[property="og:description"]', 'property', 'og:description', description);
  upsert('meta[property="og:image"]', 'property', 'og:image', imageUrl);
  upsert('meta[property="og:url"]', 'property', 'og:url', url);
  upsert('meta[property="og:type"]', 'property', 'og:type', 'website');
  upsert('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary_large_image');
  upsert('meta[name="twitter:title"]', 'name', 'twitter:title', title);
  upsert('meta[name="twitter:description"]', 'name', 'twitter:description', description);
  upsert('meta[name="twitter:image"]', 'name', 'twitter:image', imageUrl);
};

const EMPTY_PRODUCTS: Product[] = [];
const EMPTY_CATEGORIES: Category[] = [];
const EMPTY_GENDERS: Gender[] = [];

const SORTS = ['newest', 'price-low', 'price-high'] as const;   // 'newest' is the default (no ?sort= in the URL)
type SortKey = typeof SORTS[number];
const PRICE_CEILING = 50000;

/** A non-negative number from a URL parameter, or null when absent / not a number. */
const numParam = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const Products: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const searchQuery = (searchParams.get('search') || '').trim();      // blank / whitespace-only is the same as no search
  const initialProductId = searchParams.get('id');

  // Shared, short-lived cache (see utils/catalogueCache.ts): returning to the listing needs no request and no skeleton.
  const productsRes = useCatalogue<Product[]>('/api/products', []);
  const gendersRes = useCatalogue<Gender[]>('/api/genders', []);
  const categoriesRes = useCatalogue<Category[]>('/api/categories', []);
  const products = Array.isArray(productsRes.data) ? productsRes.data : EMPTY_PRODUCTS;
  const categories = Array.isArray(categoriesRes.data) ? categoriesRes.data : EMPTY_CATEGORIES;
  const genders = Array.isArray(gendersRes.data) ? gendersRes.data : EMPTY_GENDERS;
  const loading = productsRes.status === 'loading';
  const failed = productsRes.status === 'error';
  const [showFilters, setShowFilters] = useState(false);

  // ---- Filters live in the URL, so a reload, the back button, a shared link and the header menu all agree:
  //   ?category=<name> (repeatable)  ?min=<n>  ?max=<n>  ?gender=<name>  ?sort=newest|price-low|price-high  ?search=<text>
  // Blank and repeated ?category= values are ignored (they would show an empty chip / match nothing). Names are otherwise used as given.
  const categoryKey = Array.from(new Set(searchParams.getAll('category').map((c) => c.trim()).filter(Boolean))).join('\u0001');
  const selectedCategories = useMemo(() => (categoryKey ? categoryKey.split('\u0001') : []), [categoryKey]);
  const selectedGender = searchParams.get('gender') || 'all';
  const sortParam = searchParams.get('sort');
  const sortBy: SortKey = (SORTS as readonly string[]).includes(sortParam || '') ? (sortParam as SortKey) : 'newest';
  // min/max: only non-negative numbers count. If min is above max the pair contradicts itself, so neither is applied (no chip, no filter).
  const rawMin = numParam(searchParams.get('min'));
  const rawMax = numParam(searchParams.get('max'));
  const rangeInvalid = rawMin !== null && rawMax !== null && rawMin > rawMax;
  const minPrice = rangeInvalid ? 0 : rawMin ?? 0;
  const maxParam = rangeInvalid ? null : rawMax;
  const priceBound = useMemo(() => products.reduce((m, p) => Math.max(m, Number(p.price) || 0), PRICE_CEILING), [products]);
  const priceRange: [number, number] = [minPrice, Math.min(maxParam ?? priceBound, priceBound)];

  /** Change the URL's filters. Discrete choices add a history entry (back works); slider drags replace it. */
  const updateParams = (mutate: (p: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    if (next.toString() === searchParams.toString()) return;   // nothing changed: no extra history entry
    setSearchParams(next, { replace });
  };
  // After a chip is removed its button disappears; move focus to the next remaining chip (or the sort box) instead of losing it.
  const chipsRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLSelectElement>(null);
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    ((chipsRef.current?.querySelector('button') as HTMLElement | null) ?? sortRef.current)?.focus();
  }, [searchParams]);
  const removeChip = (fn: () => void) => { pendingFocus.current = true; fn(); };

  const setSortBy = (v: SortKey) => updateParams((p) => { if (v === 'newest') p.delete('sort'); else p.set('sort', v); });
  const setSelectedGender = (v: string) => updateParams((p) => { if (v === 'all') p.delete('gender'); else p.set('gender', v); });
  const setPriceMax = (v: number) => updateParams((p) => { if (v >= priceBound) p.delete('max'); else p.set('max', String(v)); }, true);
  const clearPrice = () => updateParams((p) => { p.delete('min'); p.delete('max'); });

  // Old shared links: /products?id=<id> open the product once the list has settled (as before).
  useEffect(() => {
    if (initialProductId && productsRes.status !== 'loading') navigate(`/product/${initialProductId}`, { replace: true });
  }, [initialProductId, productsRes.status, navigate]);

  // Put the page title back when leaving the listing (declared first so it captures the title this page replaces).
  useEffect(() => { const previous = document.title; return () => { document.title = previous; }; }, []);

  const getProductCategoryNames = (product: Product): string[] => {
    if (product.categories && product.categories.length > 0) {
      return product.categories.map((c: any) => c.name);
    }
    return product.category ? [product.category] : [];
  };

  // A category's own name plus the names of its direct subcategories (two-level hierarchy).
  const withSubcategoryNames = (name: string): string[] => {
    const cat = categories.find(c => c.name === name);
    if (!cat) return [name];
    return [name, ...categories.filter(c => c.parent_id === cat.id).map(c => c.name)];
  };

  const filteredProducts = useMemo(() => {
    let filtered = [...products];
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(product =>
        product.name.toLowerCase().includes(q) ||
        getProductCategoryNames(product).some(c => c.toLowerCase().includes(q)) ||
        (product.description || '').toLowerCase().includes(q) ||
        (product.gender || '').toLowerCase().includes(q)
      );
    }
    filtered = filtered.filter(
      product => product.price >= priceRange[0] && product.price <= priceRange[1]
    );
    if (selectedCategories.length > 0) {
      // Choosing a parent category also shows the products of its subcategories.
      const wanted = new Set(selectedCategories.flatMap(withSubcategoryNames));
      filtered = filtered.filter(product =>
        getProductCategoryNames(product).some(c => wanted.has(c))
      );
    }
    if (selectedGender !== 'all') {
      filtered = filtered.filter(product => (product.gender || '').toLowerCase() === selectedGender.toLowerCase());
    }
    switch (sortBy) {
      case 'price-low': filtered.sort((a, b) => a.price - b.price); break;
      case 'price-high': filtered.sort((a, b) => b.price - a.price); break;
      default:   // newest first (explicit, so the label stays true whatever order the API happens to return)
        filtered.sort((a, b) =>
          new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime()
        );
        break;
    }
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, categories, searchQuery, minPrice, maxParam, priceBound, categoryKey, selectedGender, sortBy]);

  const toggleCategory = (categoryName: string) => {
    updateParams((p) => {
      const current = p.getAll('category');
      p.delete('category');
      (current.includes(categoryName) ? current.filter((c) => c !== categoryName) : [...current, categoryName]).forEach((c) => p.append('category', c));
    });
  };

  // Clears the filters; a text search stays (it has its own box in the header).
  const clearFilters = () => {
    updateParams((p) => { p.delete('category'); p.delete('gender'); p.delete('min'); p.delete('max'); });
  };

  // Clears the filters AND the text search (used by the empty state, where the search may be what matches nothing).
  const clearAll = () => {
    updateParams((p) => { p.delete('category'); p.delete('gender'); p.delete('min'); p.delete('max'); p.delete('search'); });
  };

  const handleShareCategory = async () => {
    const url = window.location.href;
    const title = selectedCategories.length === 1
      ? `${selectedCategories[0]} — ${BRAND.name}`
      : `Shop — ${BRAND.name}`;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast.success('Link copied!');
      }
    } catch { /* user cancelled */ }
  };

  // Counts and the category lists are derived once per products/categories change (not on every render).
  const countByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const cat of categories) {
      const names = new Set(withSubcategoryNames(cat.name));
      m.set(cat.name, products.filter((p) => getProductCategoryNames(p).some((c) => names.has(c))).length);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, categories]);
  const getCategoryCount = (catName: string) => countByName.get(catName) ?? 0;
  const hasProducts = (cat: Category) => getCategoryCount(cat.name) > 0;
  const topLevel = useMemo(() => categories.filter(c => !c.parent_id || !categories.some(p => p.id === c.parent_id)), [categories]);
  const activeCategories = useMemo(() => topLevel.flatMap(parent => [
    ...(hasProducts(parent) ? [parent] : []),
    ...categories.filter(c => c.parent_id === parent.id && hasProducts(c)),
  ]), [topLevel, categories, countByName]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A plain render function, NOT a component: a component declared here would be a new type on every render, so React would
  // rebuild the whole panel (losing slider drag and keyboard focus) each time the URL changes. `idp` keeps ids unique when the
  // sidebar and the drawer are both mounted.
  const atCeiling = priceRange[1] >= priceBound;
  const priceValueText = minPrice === 0 && atCeiling ? 'Any price' : priceFilterLabel(minPrice, atCeiling ? null : priceRange[1]);
  const renderFilters = (idp: string) => (
    <div className="space-y-8">
      <div>
        <label htmlFor={`${idp}-price`} className="mb-3 block text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-muted">Price range</label>
        <input
          id={`${idp}-price`}
          type="range" min="0"
          max={priceBound}
          step="100" value={priceRange[1]}
          aria-valuetext={priceValueText}
          onChange={(e) => setPriceMax(parseInt(e.target.value))}
          className="w-full accent-brand-accent"
        />
        <div className="mt-2 flex justify-between text-[13px] text-brand-muted">
          <span>₹{priceRange[0].toLocaleString()}</span>
          <span>₹{priceRange[1].toLocaleString()}</span>
        </div>
      </div>

      {activeCategories.length > 0 && (
        <div>
          <h4 className="mb-3 block text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-muted">Categories</h4>
          <div className="space-y-1.5">
            {activeCategories.map(cat => (
              <label key={cat.id} className={`flex items-center justify-between cursor-pointer text-sm ${cat.parent_id ? 'pl-5' : ''}`}>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={selectedCategories.includes(cat.name)}
                    onChange={() => toggleCategory(cat.name)}
                    className="rounded border-brand-line accent-brand-ink h-4 w-4"
                  />
                  <span className="flex items-center gap-1.5">
                    {cat.icon_type === 'image' && cat.image_url
                      ? <img src={cat.image_url} className="w-4 h-4 object-contain rounded" alt="" />
                      : cat.icon_type === 'emoji' && cat.icon
                        ? <span className="text-sm leading-none">{cat.icon}</span>
                        : null
                    }
                    {cat.name}
                  </span>
                </div>
                <span className="text-xs text-brand-muted">{getCategoryCount(cat.name)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {genders.length > 0 && (
      <div>
        <h4 className="mb-3 block text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-muted">For</h4>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedGender('all')}
            className={`min-h-[36px] rounded-sm border px-3.5 py-1.5 text-[12px] capitalize transition-colors ${
              selectedGender === 'all' ? 'border-brand-accent bg-brand-accent/15 text-brand-accent-ink' : 'border-brand-line text-brand-ink hover:border-brand-accent/60'
            }`}
          >All</button>
          {genders.map((gender) => (
            <button
              key={gender.name}
              onClick={() => setSelectedGender(gender.name)}
              className={`flex min-h-[36px] items-center gap-1 rounded-sm border px-3.5 py-1.5 text-[12px] capitalize transition-colors ${
                selectedGender === gender.name ? 'border-brand-accent bg-brand-accent/15 text-brand-accent-ink' : 'border-brand-line text-brand-ink hover:border-brand-accent/60'
              }`}
            >
              {(gender as any).icon && <span>{(gender as any).icon}</span>}
              <span>{gender.display_name}</span>
            </button>
          ))}
        </div>
      </div>
      )}

      <button
        onClick={clearFilters}
        className="btn-secondary btn-sm w-full"
      >Clear All Filters</button>
    </div>
  );

  const activeCategory = selectedCategories.length === 1 ? categories.find((c) => c.name === selectedCategories[0]) : undefined;
  const activeParent = activeCategory?.parent_id ? categories.find((c) => c.id === activeCategory.parent_id) : undefined;
  // Page title / meta follow the URL (search, selected categories), so Back/Forward and removed chips stay in step.
  const categoryPart = selectedCategories.length > 0 && selectedCategories.length <= 2 ? selectedCategories.join(' & ') : '';
  const listingTitle = searchQuery
    ? (categoryPart ? `Search \u201c${searchQuery}\u201d in ${categoryPart}` : `Search results for \u201c${searchQuery}\u201d`)
    : (categoryPart || 'Shop');
  const listingDescription = searchQuery
    ? `Search results for \u201c${searchQuery}\u201d at ${BRAND.name}.`
    : (activeCategory?.description || (categoryPart ? `Shop our ${categoryPart} collection.` : BRAND.tagline));
  const listingImage = activeCategory?.image_url ? getImageUrl(activeCategory.image_url) : `${window.location.origin}/placeholder.svg`;
  useEffect(() => {
    setMetaTags(listingTitle, listingDescription, listingImage, window.location.href);
  }, [listingTitle, listingDescription, listingImage]);

  const priceActive = minPrice > 0 || (maxParam !== null && maxParam < priceBound);
  const filterCount = selectedCategories.length + (selectedGender !== 'all' ? 1 : 0) + (priceActive ? 1 : 0);
  // The label from the genders API when it lists this value; otherwise the URL value as given (nothing is invented).
  const genderLabel = genders.find((g) => g.name.toLowerCase() === selectedGender.toLowerCase())?.display_name || selectedGender;
  // Recovery shortcuts come from the loaded catalogue only: budget bands that really contain products, and categories that have some.
  const bandsWithProducts = useMemo(() => BUDGET_BANDS.filter((b) => products.some((pr) => pr.price >= (b.min ?? 0) && (b.max === undefined || pr.price <= b.max))), [products]);
  const browseCategories = useMemo(() => topLevel.filter(hasProducts).slice(0, 8), [topLevel, countByName]);   // eslint-disable-line react-hooks/exhaustive-deps
  const hasOtherFilters = selectedCategories.length > 0 || selectedGender !== 'all' || priceActive;
  const hasActiveFilters = selectedCategories.length > 0 || selectedGender !== 'all' || priceActive || Boolean(searchQuery);

  return (
    <div className="container-page py-10 md:py-16">
      <nav aria-label="Breadcrumb" className="mb-8 text-[12px] uppercase tracking-[0.14em] text-brand-muted">
        <ol className="flex flex-wrap items-center gap-x-2">
          <li><Link to="/" className="hover:text-brand-ink">Home</Link></li>
          <li aria-hidden="true">/</li>
          {activeCategory ? (
            <>
              <li><Link to="/products" className="hover:text-brand-ink">Shop</Link></li>
              {activeParent && (<><li aria-hidden="true">/</li><li><Link to={`/products?category=${encodeURIComponent(activeParent.name)}`} className="hover:text-brand-ink">{activeParent.name}</Link></li></>)}
              <li aria-hidden="true">/</li>
              <li aria-current="page" className="font-medium text-brand-ink">{activeCategory.name}</li>
            </>
          ) : (
            <li aria-current="page" className="font-medium text-brand-ink">Shop</li>
          )}
        </ol>
      </nav>
      <div className="mb-10 flex items-end justify-between gap-4 border-b border-brand-line pb-8">
        <div>
          <h1 className="text-4xl font-semibold leading-[1.05] sm:text-5xl">{selectedCategories.length === 1 ? selectedCategories[0] : searchQuery ? 'Search results' : 'Shop'}</h1>
          {activeCategory?.description && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-brand-muted">{activeCategory.description}</p>}
          <p className="mt-3 text-[13px] uppercase tracking-[0.14em] text-brand-muted">
            {loading ? '' : selectedCategories.length === 1 ? `${filteredProducts.length} ${filteredProducts.length === 1 ? 'product' : 'products'}` : searchQuery ? `${filteredProducts.length} ${filteredProducts.length === 1 ? 'result' : 'results'} for “${searchQuery}”` : 'Browse all products'}
          </p>
        </div>
        <p className="sr-only" role="status" aria-atomic="true">
          {loading || failed ? '' : `${filteredProducts.length} ${searchQuery ? (filteredProducts.length === 1 ? 'result' : 'results') : (filteredProducts.length === 1 ? 'product' : 'products')}${searchQuery ? ` for \u201c${searchQuery}\u201d` : ''}`}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleShareCategory} aria-label="Share this collection" className="btn-ghost btn-sm !px-2">
            <Share2 className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setShowFilters(true)} aria-haspopup="dialog" className="btn-secondary btn-sm md:hidden">
            <Filter className="h-4 w-4" aria-hidden="true" /> Filters{filterCount > 0 ? ` (${filterCount})` : ''}
          </button>
        </div>
      </div>

      {hasActiveFilters && (
        <div ref={chipsRef} role="group" aria-label="Active filters" className="mb-4 flex flex-wrap gap-2">
          {searchQuery && (
            <span className="badge-neutral !py-1.5">
              <Search className="h-3 w-3" aria-hidden="true" />&ldquo;{searchQuery}&rdquo;
              <button type="button" onClick={() => removeChip(() => updateParams((p) => { p.delete('search'); }))} aria-label={`Remove search “${searchQuery}”`} className="rounded-full p-0.5 hover:bg-brand-ink/10"><X className="h-3 w-3" aria-hidden="true" /></button>
            </span>
          )}
          {selectedCategories.map((cat) => (
            <span key={cat} className="badge-accent !py-1.5 capitalize">
              {cat}
              <button type="button" onClick={() => removeChip(() => toggleCategory(cat))} aria-label={`Remove filter ${cat}`} className="rounded-full p-0.5 hover:bg-brand-accent/20"><X className="h-3 w-3" aria-hidden="true" /></button>
            </span>
          ))}
          {priceActive && (
            <span className="badge-accent !py-1.5">
              {priceFilterLabel(minPrice, maxParam !== null && maxParam < priceBound ? maxParam : null)}
              <button type="button" onClick={() => removeChip(clearPrice)} aria-label="Remove price filter" className="rounded-full p-0.5 hover:bg-brand-accent/20"><X className="h-3 w-3" aria-hidden="true" /></button>
            </span>
          )}
          {selectedGender !== 'all' && (
            <span className="badge-accent !py-1.5 capitalize">
              {genderLabel}
              <button type="button" onClick={() => removeChip(() => setSelectedGender('all'))} aria-label={`Remove filter ${genderLabel}`} className="rounded-full p-0.5 hover:bg-brand-accent/20"><X className="h-3 w-3" aria-hidden="true" /></button>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-8 md:flex-row">
        {/* filters: sidebar from md up, drawer on phones */}
        <aside className="hidden w-56 shrink-0 md:block lg:w-64" aria-label="Filters">
          <div className="sticky top-28 border-t border-brand-accent/40 pt-6">
            <h2 className="mb-6 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.2em]"><SlidersHorizontal className="h-4 w-4 text-brand-accent" strokeWidth={1.5} aria-hidden="true" />Filters</h2>
            {renderFilters('side')}
          </div>
        </aside>
        <Modal isOpen={showFilters} onClose={() => setShowFilters(false)} title="Filters" placement="left">
          <div className="p-5 pb-0">
            {showFilters && renderFilters('drawer')}
            <div className="sticky bottom-0 -mx-5 mt-6 flex gap-3 border-t border-brand-line bg-brand-elevated p-4">
              <button type="button" onClick={clearFilters} className="btn-secondary flex-1">Reset</button>
              <button type="button" onClick={() => setShowFilters(false)} className="btn-primary flex-1">Show {filteredProducts.length} {filteredProducts.length === 1 ? 'product' : 'products'}</button>
            </div>
          </div>
        </Modal>

        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-center justify-between gap-4">
            <p className="text-sm text-brand-muted">
              {loading ? 'Loading products…' : `Showing ${filteredProducts.length} of ${products.length} products`}
            </p>
            <div className="flex items-center gap-2">
              <label htmlFor="sort" className="sr-only">Sort by</label>
              <select id="sort" ref={sortRef} value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="input !w-auto !py-2">
                <option value="newest">Newest first</option>
                <option value="price-low">Price: Low to High</option>
                <option value="price-high">Price: High to Low</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-12 md:gap-x-7 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
              {[...Array(8)].map((_, i) => (
                <div key={i}><Skeleton className="aspect-[4/5] w-full" /><Skeleton className="mt-3 h-4 w-3/4" /><Skeleton className="mt-2 h-4 w-1/3" /></div>
              ))}
            </div>
          ) : failed ? (
            <ErrorState title="We could not load products" description="Please check your connection and try again." action={<button type="button" className="btn-primary" onClick={() => { productsRes.retry(); if (gendersRes.status === 'error') gendersRes.retry(); if (categoriesRes.status === 'error') categoriesRes.retry(); }}>Try again</button>} />
          ) : filteredProducts.length > 0 ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-12 md:gap-x-7 lg:grid-cols-3 xl:grid-cols-4">
              {filteredProducts.map((product) => <ProductCard key={product.id} product={product} />)}
            </div>
          ) : products.length === 0 ? (
            <EmptyState title="Products are being added" description="There is nothing to show yet. Please check back soon." action={<ButtonLink to="/custom-combo" variant="secondary">Build a custom combo</ButtonLink>} />
          ) : (
            <EmptyState title={searchQuery && selectedCategories.length === 0 ? 'No results found' : 'No products found'} description={searchQuery && selectedCategories.length === 0 ? `Nothing matches “${searchQuery}”. Try a different word, or browse the categories.` : selectedCategories.length > 0 && selectedGender === 'all' ? 'There are no products in this category yet.' : 'No products match your selected filters.'} action={<><div className="flex flex-wrap justify-center gap-3"><Button onClick={searchQuery ? clearAll : clearFilters}>{searchQuery ? (hasOtherFilters ? 'Clear search and filters' : 'Clear search') : 'Clear filters'}</Button><ButtonLink to="/products" variant="secondary">See all products</ButtonLink></div>
              {(bandsWithProducts.length > 0 || browseCategories.length > 0) && (
                <div className="mt-6 space-y-4 border-t border-brand-line pt-5 text-left">
                  {bandsWithProducts.length > 0 && (
                    <nav aria-label="Browse by budget">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-muted">Browse by budget</p>
                      <ul className="flex flex-wrap gap-2">{bandsWithProducts.map((b) => <li key={b.key}><Link to={budgetLink(b)} className="btn-secondary btn-sm">{b.label}</Link></li>)}</ul>
                    </nav>
                  )}
                  {browseCategories.length > 0 && (
                    <nav aria-label="Browse by category">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-muted">Browse by category</p>
                      <ul className="flex flex-wrap gap-2">{browseCategories.map((c) => <li key={c.id}><Link to={`/products?category=${encodeURIComponent(c.name)}`} className="btn-secondary btn-sm">{c.name}</Link></li>)}</ul>
                    </nav>
                  )}
                </div>
              )}
            </>} />
          )}
        </div>
      </div>
    </div>
  );
};

export default Products;
