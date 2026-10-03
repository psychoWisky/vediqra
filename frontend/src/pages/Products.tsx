import React, { useState, useEffect } from 'react';
import { Filter, X, SlidersHorizontal, Search, Share2 } from 'lucide-react';
import ProductCard from '../components/ProductCard';
import { Product, Gender, Category } from '../types';
import { apiFetch } from '../utils/api';
import { getImageUrl } from '../utils/helpers';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { BRAND } from '../config/brand'
import { Modal } from '../components/ui/Modal';
import { Button, ButtonLink } from '../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States';

/* ─── Dynamic OG / Twitter meta helper ─── */
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

const Products: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialCategory = searchParams.get('category');
  const searchQuery = searchParams.get('search') || '';
  const initialProductId = searchParams.get('id');

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [genders, setGenders] = useState<Gender[]>([]);
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [priceRange, setPriceRange] = useState([0, 50000]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    initialCategory ? [initialCategory] : []
  );
  const [selectedGender, setSelectedGender] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sortBy, setSortBy] = useState<'popular' | 'price-low' | 'price-high' | 'newest'>('popular');

  useEffect(() => { fetchData(); }, []);

  useEffect(() => {
    filterAndSortProducts();
  }, [products, priceRange, selectedCategories, selectedGender, sortBy, searchQuery]);

  /* Update meta tags whenever category selection changes */
  useEffect(() => {
    if (selectedCategories.length === 1) {
      const catName = selectedCategories[0];
      const catObj = categories.find(c => c.name === catName);
      const imageUrl = catObj?.image_url
        ? getImageUrl(catObj.image_url)
        : `${window.location.origin}/placeholder.svg`;
      const desc = catObj?.description
        || `Shop our ${catName} collection.`;
      setMetaTags(
        `${catName} — ${BRAND.name}`,
        desc,
        imageUrl,
        window.location.href,
      );
    } else if (selectedCategories.length === 0 && !searchQuery) {
      setMetaTags(
        `Shop — ${BRAND.name}`,
        BRAND.tagline,
        `${window.location.origin}/placeholder.svg`,
        window.location.href,
      );
    }
  }, [selectedCategories, categories]);

  const fetchData = async () => {
    try {
      let productsFailed = false;
      const [productsData, gendersData, categoriesData] = await Promise.all([
        apiFetch('/api/products').catch(() => { productsFailed = true; return []; }),
        apiFetch('/api/genders').catch(() => []),
        apiFetch('/api/categories').catch(() => []),
      ]);
      setFailed(productsFailed);
      setProducts(productsData || []);
      setFilteredProducts(productsData || []);
      setGenders(gendersData || []);
      setCategories(categoriesData || []);
      if (initialProductId) {
        navigate(`/product/${initialProductId}`, { replace: true });
        return;
      }
      const maxPrice = productsData?.length > 0
        ? Math.max(...(productsData as Product[]).map((p) => p.price), 50000)
        : 50000;
      setPriceRange([0, maxPrice]);
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  };

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

  const filterAndSortProducts = () => {
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
      filtered = filtered.filter(product => product.gender === selectedGender);
    }
    switch (sortBy) {
      case 'price-low': filtered.sort((a, b) => a.price - b.price); break;
      case 'price-high': filtered.sort((a, b) => b.price - a.price); break;
      case 'newest':
        filtered.sort((a, b) =>
          new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime()
        );
        break;
      default: break;
    }
    setFilteredProducts(filtered);
  };

  const toggleCategory = (categoryName: string) => {
    setSelectedCategories(prev =>
      prev.includes(categoryName)
        ? prev.filter(c => c !== categoryName)
        : [...prev, categoryName]
    );
  };

  const clearFilters = () => {
    setSelectedCategories([]);
    setSelectedGender('all');
    setPriceRange([0, Math.max(...products.map(p => p.price), 50000)]);
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

  const getCategoryCount = (catName: string) => {
    const names = new Set(withSubcategoryNames(catName));
    return products.filter(p => getProductCategoryNames(p).some(c => names.has(c))).length;
  };

  // Categories that have products (directly or through a subcategory), parents first with their children under them.
  const hasProducts = (cat: Category) => getCategoryCount(cat.name) > 0;
  const topLevel = categories.filter(c => !c.parent_id || !categories.some(p => p.id === c.parent_id));
  const activeCategories = topLevel.flatMap(parent => [
    ...(hasProducts(parent) ? [parent] : []),
    ...categories.filter(c => c.parent_id === parent.id && hasProducts(c)),
  ]);

  const FilterContent = () => (
    <div className="space-y-5">
      <div>
        <h4 className="font-semibold text-sm mb-2">Price Range</h4>
        <input
          type="range" min="0"
          max={Math.max(...products.map(p => p.price), 50000)}
          step="100" value={priceRange[1]}
          onChange={(e) => setPriceRange([priceRange[0], parseInt(e.target.value)])}
          className="w-full accent-brand-accent"
        />
        <div className="flex justify-between text-xs mt-1">
          <span>₹{priceRange[0].toLocaleString()}</span>
          <span>₹{priceRange[1].toLocaleString()}</span>
        </div>
      </div>

      {activeCategories.length > 0 && (
        <div>
          <h4 className="font-semibold text-sm mb-2">Categories</h4>
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

      <div>
        <h4 className="font-semibold text-sm mb-2">For</h4>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedGender('all')}
            className={`px-3 py-1.5 rounded-full text-xs capitalize transition-colors ${
              selectedGender === 'all' ? 'bg-brand-ink text-white' : 'bg-brand-subtle text-brand-ink hover:bg-brand-line'
            }`}
          >All</button>
          {genders.map((gender) => (
            <button
              key={gender.name}
              onClick={() => setSelectedGender(gender.name)}
              className={`px-3 py-1.5 rounded-full text-xs capitalize transition-colors flex items-center gap-1 ${
                selectedGender === gender.name ? 'bg-brand-ink text-white' : 'bg-brand-subtle text-brand-ink hover:bg-brand-line'
              }`}
            >
              {(gender as any).icon && <span>{(gender as any).icon}</span>}
              <span>{gender.display_name}</span>
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={clearFilters}
        className="btn-secondary btn-sm w-full"
      >Clear All Filters</button>
    </div>
  );

  const activeCategory = selectedCategories.length === 1 ? categories.find((c) => c.name === selectedCategories[0]) : undefined;
  const activeParent = activeCategory?.parent_id ? categories.find((c) => c.id === activeCategory.parent_id) : undefined;
  const maxPriceBound = Math.max(...products.map((p) => Number(p.price) || 0), 50000);
  const filterCount = selectedCategories.length + (selectedGender !== 'all' ? 1 : 0) + (priceRange[1] < maxPriceBound ? 1 : 0);
  const hasActiveFilters = selectedCategories.length > 0 || selectedGender !== 'all' || Boolean(searchQuery);

  return (
    <div className="container-page py-8 md:py-12">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-brand-muted">
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
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{selectedCategories.length === 1 ? selectedCategories[0] : searchQuery ? 'Search results' : 'Shop'}</h1>
          {activeCategory?.description && <p className="mt-2 max-w-2xl text-brand-muted">{activeCategory.description}</p>}
          <p className="mt-1 text-sm text-brand-muted" aria-live="polite">
            {loading ? '' : selectedCategories.length === 1 ? `${filteredProducts.length} ${filteredProducts.length === 1 ? 'product' : 'products'}` : searchQuery ? `${filteredProducts.length} ${filteredProducts.length === 1 ? 'result' : 'results'} for “${searchQuery}”` : 'Browse all products'}
          </p>
        </div>
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
        <div className="mb-4 flex flex-wrap gap-2" aria-label="Active filters">
          {searchQuery && (
            <span className="badge-neutral !py-1.5"><Search className="h-3 w-3" aria-hidden="true" />&ldquo;{searchQuery}&rdquo;</span>
          )}
          {selectedCategories.map((cat) => (
            <span key={cat} className="badge-accent !py-1.5 capitalize">
              {cat}
              <button type="button" onClick={() => toggleCategory(cat)} aria-label={`Remove filter ${cat}`} className="rounded-full p-0.5 hover:bg-brand-accent/20"><X className="h-3 w-3" aria-hidden="true" /></button>
            </span>
          ))}
          {selectedGender !== 'all' && (
            <span className="badge-accent !py-1.5 capitalize">
              {selectedGender}
              <button type="button" onClick={() => setSelectedGender('all')} aria-label={`Remove filter ${selectedGender}`} className="rounded-full p-0.5 hover:bg-brand-accent/20"><X className="h-3 w-3" aria-hidden="true" /></button>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-8 md:flex-row">
        {/* filters: sidebar from md up, drawer on phones */}
        <aside className="hidden w-56 shrink-0 md:block lg:w-64" aria-label="Filters">
          <div className="card sticky top-20 p-4">
            <h2 className="mb-4 flex items-center gap-2 text-base font-bold"><SlidersHorizontal className="h-4 w-4" aria-hidden="true" />Filters</h2>
            <FilterContent />
          </div>
        </aside>
        <Modal isOpen={showFilters} onClose={() => setShowFilters(false)} title="Filters" placement="left">
          <div className="p-5 pb-0">
            <FilterContent />
            <div className="sticky bottom-0 -mx-5 mt-6 flex gap-3 border-t border-brand-line bg-white p-4">
              <button type="button" onClick={clearFilters} className="btn-secondary flex-1">Reset</button>
              <button type="button" onClick={() => setShowFilters(false)} className="btn-primary flex-1">Show {filteredProducts.length} {filteredProducts.length === 1 ? 'product' : 'products'}</button>
            </div>
          </div>
        </Modal>

        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-center justify-between gap-4">
            <p className="text-sm text-brand-muted" aria-live="polite">
              {loading ? 'Loading products…' : `Showing ${filteredProducts.length} of ${products.length} products`}
            </p>
            <div className="flex items-center gap-2">
              <label htmlFor="sort" className="sr-only">Sort by</label>
              <select id="sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="input !w-auto !py-2">
                <option value="popular">Default order</option>
                <option value="newest">Newest</option>
                <option value="price-low">Price: Low to High</option>
                <option value="price-high">Price: High to Low</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
              {[...Array(8)].map((_, i) => (
                <div key={i}><Skeleton className="aspect-[4/5] w-full" /><Skeleton className="mt-3 h-4 w-3/4" /><Skeleton className="mt-2 h-4 w-1/3" /></div>
              ))}
            </div>
          ) : failed ? (
            <ErrorState title="We could not load products" description="Please check your connection and try again." action={<button type="button" className="btn-primary" onClick={() => { setLoading(true); setFailed(false); fetchData(); }}>Try again</button>} />
          ) : filteredProducts.length > 0 ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-3 xl:grid-cols-4">
              {filteredProducts.map((product) => <ProductCard key={product.id} product={product} />)}
            </div>
          ) : products.length === 0 ? (
            <EmptyState title="Products are being added" description="There is nothing to show yet. Please check back soon." action={<ButtonLink to="/custom-combo" variant="secondary">Build a custom combo</ButtonLink>} />
          ) : (
            <EmptyState title={searchQuery && selectedCategories.length === 0 ? 'No results found' : 'No products found'} description={searchQuery && selectedCategories.length === 0 ? `Nothing matches “${searchQuery}”. Try a different word, or browse the categories.` : selectedCategories.length > 0 && selectedGender === 'all' ? 'There are no products in this category yet.' : 'No products match your selected filters.'} action={<div className="flex flex-wrap justify-center gap-3"><Button onClick={clearFilters}>Clear filters</Button><ButtonLink to="/products" variant="secondary">See all products</ButtonLink></div>} />
          )}
        </div>
      </div>
    </div>
  );
};

export default Products;
