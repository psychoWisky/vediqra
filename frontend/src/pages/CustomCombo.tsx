import React, { useEffect, useMemo, useState } from 'react';
import { Gift, Minus, Package, Plus, Search, ShoppingCart, Sparkles, Type, Users, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Product, Category, Gender, CustomizationData, CartItem, SelectedOption } from '../types';
import { getAllGroups, selectionsFromChoices, missingRequiredAll, imageForChoices } from '../utils/options';
import { getImageUrl } from '../utils/helpers';
import { formatCurrency, fromPaise, toPaise } from '../utils/money';
import { friendlyError } from '../utils/errors';
import { apiFetch } from '../utils/api';
import CategoryCard from '../components/CategoryCard';
import { useCart } from '../context/CartContext';
import ProductCustomizationModal from '../components/ProductCustomizationModal';
import OptionGroupPicker, { PickerValue } from '../components/product/OptionGroupPicker';
import { Badge } from '../components/ui/Badge';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States';

interface ComboCartItem extends CartItem {
  combo_id: string;
  combo_name: string;
  is_combo_item: boolean;
  combo_products: Array<{ id: string; name: string; quantity: number; price: number; image_url: string; customization?: CustomizationData }>;
}

interface SelectedLine {
  product: Product;
  quantity: number;
  customization?: CustomizationData;
  selected: SelectedOption[]; // generic option selections (colour, size, finish ...)
}

const MAX_ITEMS = 10;

/** The smallest tracked stock available for one unit of this product with these options, or null if untracked. */
const stockLimitFor = (product: Product, chosen: Record<string, string>): number | null => {
  const parts: number[] = [];
  if (product.track_stock) parts.push(Number(product.stock_quantity) || 0);
  for (const g of getAllGroups(product)) {
    const v = g.values.find((x) => x.id === chosen[g.id]);
    if (v && v.stock_quantity !== null && v.stock_quantity !== undefined) parts.push(Number(v.stock_quantity) || 0);
  }
  return parts.length ? Math.min(...parts) : null;
};

/** Server pricing/quote for the combo currently being built. Debounced; ignores customization content
 *  (it doesn't affect price) so edits inside the customisation dialog don't cause extra requests. */
function useCustomComboQuote(lines: Map<string, SelectedLine>) {
  const [state, setState] = useState<{ item: any | null; loading: boolean; error: string | null }>({ item: null, loading: false, error: null });
  const key = JSON.stringify(Array.from(lines.entries()).map(([k, l]) => [k, l.product.id, l.quantity, l.selected.map((o) => o.value_id)]));

  useEffect(() => {
    if (lines.size === 0) { setState({ item: null, loading: false, error: null }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(async () => {
      const preview = {
        id: 'custom-combo-preview', type: 'combo', quantity: 1,
        combo_products: Array.from(lines.values()).map((l) => ({ id: l.product.id, quantity: l.quantity, selected_options: l.selected.map((o) => o.value_id) })),
      };
      try {
        const res = await apiFetch<{ items: any[] }>('/api/orders/quote', { method: 'POST', body: JSON.stringify({ items: [preview], payment_method: 'cod' }) });
        if (!cancelled) setState({ item: res.items?.[0] || null, loading: false, error: null });
      } catch (e: any) {
        if (!cancelled) setState({ item: null, loading: false, error: e?.message || 'unavailable' });
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

const CustomCombo: React.FC = () => {
  const { addItem } = useCart();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [genders, setGenders] = useState<Gender[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // key = product id + chosen option value ids, so the same product with different options is a separate line
  const [lines, setLines] = useState<Map<string, SelectedLine>>(new Map());

  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [selectedGender, setSelectedGender] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);

  const [pendingProduct, setPendingProduct] = useState<Product | null>(null);
  const [showCustomizationModal, setShowCustomizationModal] = useState(false);
  const [comboName, setComboName] = useState('');
  const [addError, setAddError] = useState('');
  const [committing, setCommitting] = useState(false);

  // Choices per product: option group id -> option value id. Same generic model used on ProductPage.
  const [optionChoices, setOptionChoices] = useState<Map<string, Record<string, string>>>(new Map());
  const choicesFor = (productId: string) => optionChoices.get(productId) || {};
  const chooseOption = (productId: string, groupId: string, valueId: string | null) =>
    setOptionChoices((prev) => {
      const next = new Map(prev);
      const current = { ...(next.get(productId) || {}) };
      if (valueId) current[groupId] = valueId; else delete current[groupId];
      next.set(productId, current);
      return next;
    });

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [productsData, categoriesData, gendersData] = await Promise.all([
        apiFetch<Product[]>('/api/products'),
        apiFetch<Category[]>('/api/categories'),
        apiFetch<Gender[]>('/api/genders').catch(() => []),
      ]);
      setProducts(productsData || []);
      setCategories(categoriesData || []);
      setGenders(gendersData || []);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  // A category plus its direct subcategories (two-level hierarchy): choosing a parent shows its children's products too.
  const categoryFamilyIds = (category: Category): string[] => [category.id, ...categories.filter((c) => c.parent_id === category.id).map((c) => c.id)];

  const getFilteredProducts = () => {
    let filtered = [...products];
    if (selectedCategory) {
      const familyIds = categoryFamilyIds(selectedCategory);
      filtered = filtered.filter((p) => {
        const matchesOld = p.category?.toLowerCase().trim() === selectedCategory.name.toLowerCase().trim();
        const matchesId = p.categories?.some((cat: any) => familyIds.includes(cat.id));
        const matchesName = p.categories?.some((cat: any) => cat.name?.toLowerCase().trim() === selectedCategory.name.toLowerCase().trim());
        return matchesOld || matchesId || matchesName;
      });
    }
    if (selectedGender !== 'all') filtered = filtered.filter((p) => p.gender?.toLowerCase().trim() === selectedGender.toLowerCase().trim());
    return filtered;
  };

  const handleSearch = async (text?: string) => {
    const query = (text ?? searchTerm).trim();
    if (!query) { setShowSearchResults(false); setSearchResults([]); return; }
    setShowSearchResults(true);
    try {
      const data = await apiFetch<Product[]>(`/api/products/search?q=${encodeURIComponent(query)}`);
      setSearchResults(data || []);
    } catch {
      setSearchResults([]);
    }
  };

  const totalItems = useMemo(() => Array.from(lines.values()).reduce((n, l) => n + l.quantity, 0), [lines]);

  const lineKeyFor = (productId: string, selected: SelectedOption[]) => (selected.length ? `${productId}-${selected.map((o) => o.value_id).join('-')}` : productId);

  const addLine = (product: Product, customization?: CustomizationData) => {
    const selected = selectionsFromChoices(product, choicesFor(product.id));
    if (totalItems >= MAX_ITEMS) { toast.error(`A combo can hold at most ${MAX_ITEMS} items.`); return; }
    const key = lineKeyFor(product.id, selected);
    const limit = stockLimitFor(product, choicesFor(product.id));
    setLines((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      const nextQty = (existing?.quantity || 0) + 1;
      if (limit !== null && nextQty > limit) { toast.error(`Only ${limit} of "${product.name}" ${limit === 1 ? 'is' : 'are'} available.`); return prev; }
      next.set(key, existing ? { ...existing, quantity: nextQty } : { product, quantity: 1, customization, selected });
      return next;
    });
    setAddError('');
    toast.success(`${product.name}${customization ? ' (personalised)' : ''} added to combo`);
  };

  const handleAddToCombo = (product: Product) => {
    const missing = missingRequiredAll(product, choicesFor(product.id));
    if (missing.length > 0) { toast.error(`Please choose ${missing.map((g) => g.name).join(', ')} for ${product.name}.`); return; }
    if (product.is_customizable) { setPendingProduct(product); setShowCustomizationModal(true); }
    else addLine(product);
  };

  const removeLine = (key: string) => setLines((prev) => { const n = new Map(prev); n.delete(key); return n; });

  const updateQuantity = (key: string, quantity: number) => {
    if (quantity < 1) { removeLine(key); return; }
    const current = lines.get(key);
    if (!current) return;
    if (totalItems - current.quantity + quantity > MAX_ITEMS) { toast.error(`A combo can hold at most ${MAX_ITEMS} items.`); return; }
    const limit = stockLimitFor(current.product, Object.fromEntries(current.selected.map((o) => [o.group_id, o.value_id])));
    if (limit !== null && quantity > limit) { toast.error(`Only ${limit} of "${current.product.name}" ${limit === 1 ? 'is' : 'are'} available.`); return; }
    setLines((prev) => { const n = new Map(prev); n.set(key, { ...current, quantity }); return n; });
  };

  const editCustomization = (key: string) => {
    const item = lines.get(key);
    if (!item?.product.is_customizable) return;
    setOptionChoices((prev) => { const n = new Map(prev); n.set(item.product.id, Object.fromEntries(item.selected.map((o) => [o.group_id, o.value_id]))); return n; });
    setPendingProduct(item.product);
    removeLine(key);
    setShowCustomizationModal(true);
  };

  // ---- server pricing (subtotal / tier discount / total): never recomputed in the frontend ----
  const quote = useCustomComboQuote(lines);
  const quoteItem = quote.item;
  const basePaise = quoteItem ? toPaise(quoteItem.base_price) : null;
  const unitPaise = quoteItem ? toPaise(quoteItem.price) : null;
  const discountPaise = basePaise !== null && unitPaise !== null ? basePaise - unitPaise : null;
  const tierPct = quoteItem?.discount_percentage || 0;

  const handleAddToCart = async () => {
    if (lines.size === 0) { toast.error('Please add at least one product to your combo.'); return; }
    if (quote.loading) return;
    if (quote.error || unitPaise === null) { setAddError(friendlyError(quote.error, 'We could not price this combo. Please check your selections and try again.')); return; }
    setCommitting(true);
    const comboId = `combo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const name = comboName.trim() || `Custom Combo (${new Date().toLocaleDateString()})`;
    const values = Array.from(lines.values());
    const comboProducts = values.map((item) => ({
      id: item.product.id, name: item.product.name, quantity: item.quantity,
      price: Number(item.product.price) + Number(item.product.customization_price || 0) + item.selected.reduce((s, o) => s + (Number(o.price_modifier) || 0), 0),
      image_url: imageForChoices(item.product, Object.fromEntries(item.selected.map((o) => [o.group_id, o.value_id]))) || item.product.image_url,
      customization: item.customization,
      selected_options: item.selected.map((o) => ({ value_id: o.value_id })),
      option_labels: item.selected.map((o) => o.name),
    }));
    const comboItem: ComboCartItem = {
      id: comboId, name, price: fromPaise(unitPaise), quantity: 1, image_url: values[0]?.product.image_url || '', type: 'combo',
      combo_id: comboId, combo_name: name, is_combo_item: true, combo_products: comboProducts,
      description: `Custom combo with ${lines.size} product${lines.size > 1 ? 's' : ''}`,
    };
    addItem(comboItem);
    toast.success(`Combo added to cart · ${formatCurrency(fromPaise(unitPaise))}`);
    setLines(new Map());
    setComboName('');
    setOptionChoices(new Map());
    setAddError('');
    setCommitting(false);
  };

  const filteredProducts = getFilteredProducts();
  const displayProducts = showSearchResults ? searchResults : filteredProducts;

  if (loading) {
    return (
      <div className="container-page section" aria-busy="true" role="status" aria-label="Loading">
        <Skeleton className="mx-auto mb-4 h-10 w-80" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="container-page section">
        <ErrorState title="We could not load products" description="Please check your connection and try again." action={<button type="button" className="btn-primary" onClick={fetchData}>Try again</button>} />
      </div>
    );
  }

  return (
    <div className="container-page py-8 md:py-12">
      {showCustomizationModal && pendingProduct && (
        <ProductCustomizationModal
          product={pendingProduct}
          selectedImageUrl={imageForChoices(pendingProduct, choicesFor(pendingProduct.id)) || pendingProduct.image_url}
          onClose={() => { setShowCustomizationModal(false); setPendingProduct(null); }}
          onCustomizeComplete={(c) => { addLine(pendingProduct, c); setShowCustomizationModal(false); setPendingProduct(null); }}
        />
      )}

      <div className="mx-auto mb-10 max-w-2xl text-center">
        <div className="mb-3 flex items-center justify-center gap-2 text-brand-accent-ink" aria-hidden="true"><Package className="h-6 w-6" /><Sparkles className="h-6 w-6" /><Gift className="h-6 w-6" /></div>
        <h1 className="text-3xl font-bold sm:text-4xl">Build a custom combo</h1>
        <p className="mt-2 text-brand-muted">Choose your own products. The more you add, the bigger the discount.</p>
      </div>

      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Combo builder: first on mobile, right column on desktop */}
        <aside className="order-1 lg:order-2 lg:w-[380px] lg:shrink-0 xl:w-[420px]">
          <div className="card sticky top-24 space-y-5 p-5">
            <h2 className="flex items-center gap-2 text-lg font-bold"><Package className="h-5 w-5 text-brand-accent-ink" aria-hidden="true" /> Your combo</h2>

            {totalItems > 0 && (
              <div className="rounded-xl bg-brand-ink p-4 text-white" role="status">
                <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-accent" aria-hidden="true" /> {tierPct > 0 ? `${tierPct}% discount applied` : 'Add more items to unlock a discount'}</p>
                <p className="text-xs text-white/70">{totalItems} / {MAX_ITEMS} items selected</p>
              </div>
            )}

            <div>
              <label htmlFor="combo-name" className="mb-1.5 block text-sm font-medium">Combo name (optional)</label>
              <input id="combo-name" className="input" value={comboName} onChange={(e) => setComboName(e.target.value)} placeholder="My gift combo" />
            </div>

            <div className="max-h-[320px] space-y-3 overflow-y-auto">
              {lines.size === 0 ? (
                <EmptyState icon={<Gift className="h-10 w-10" aria-hidden="true" />} title="No products selected" description="Add products from the list below." />
              ) : (
                <ul className="space-y-3">
                  {Array.from(lines.entries()).map(([key, { product, quantity, customization, selected }]) => {
                    const unit = Number(product.price) + Number(product.customization_price || 0) + selected.reduce((s, o) => s + (Number(o.price_modifier) || 0), 0);
                    const image = imageForChoices(product, Object.fromEntries(selected.map((o) => [o.group_id, o.value_id]))) || product.image_url;
                    const limit = stockLimitFor(product, Object.fromEntries(selected.map((o) => [o.group_id, o.value_id])));
                    return (
                      <li key={key} data-testid="combo-line" className="rounded-lg bg-brand-subtle p-3">
                        <div className="flex items-center gap-3">
                          <img src={getImageUrl(image)} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-1 text-sm font-semibold">{product.name}</p>
                            <p className="text-xs text-brand-muted">{formatCurrency(unit)} each</p>
                            {selected.length > 0 && <p className="mt-0.5 text-xs text-brand-muted">{selected.map((o) => o.name).join(' · ')}</p>}
                            {customization && (customization.text_lines?.length || customization.image_urls?.length) ? (
                              <div className="mt-1"><Badge tone="accent">Personalised{customization.text_lines?.length ? ` · ${customization.text_lines.length} ${customization.text_lines.length === 1 ? 'line' : 'lines'}` : ''}{customization.image_urls?.length ? ` · ${customization.image_urls.length} ${customization.image_urls.length === 1 ? 'image' : 'images'}` : ''}</Badge></div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button type="button" onClick={() => updateQuantity(key, quantity - 1)} aria-label={`Decrease quantity of ${product.name}`} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white"><Minus className="h-3.5 w-3.5" aria-hidden="true" /></button>
                            <span className="w-6 text-center text-sm font-semibold" aria-live="polite">{quantity}</span>
                            <button type="button" onClick={() => updateQuantity(key, quantity + 1)} disabled={totalItems >= MAX_ITEMS || (limit !== null && quantity >= limit)} aria-label={`Increase quantity of ${product.name}`} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white disabled:opacity-40"><Plus className="h-3.5 w-3.5" aria-hidden="true" /></button>
                            {product.is_customizable && <button type="button" onClick={() => editCustomization(key)} aria-label={`Edit personalisation for ${product.name}`} className="flex h-9 w-9 items-center justify-center rounded-lg text-brand-accent-ink hover:bg-white"><Type className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                            <button type="button" onClick={() => removeLine(key)} aria-label={`Remove ${product.name} from combo`} className="flex h-9 w-9 items-center justify-center rounded-lg text-brand-danger hover:bg-white"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {lines.size > 0 && (
              <dl className="space-y-1.5 border-t border-brand-line pt-4 text-sm" aria-live="polite" aria-busy={quote.loading} data-testid="combo-summary">
                {quote.loading || basePaise === null ? (
                  <p className="text-brand-muted">Calculating…</p>
                ) : (
                  <>
                    <div className="flex justify-between"><dt className="text-brand-muted">Subtotal</dt><dd>{formatCurrency(fromPaise(basePaise))}</dd></div>
                    {discountPaise !== null && discountPaise > 0 && <div className="flex justify-between text-brand-success"><dt>Combo discount ({tierPct}%)</dt><dd>-{formatCurrency(fromPaise(discountPaise))}</dd></div>}
                    <div className="flex justify-between border-t border-brand-line pt-2 text-base font-bold"><dt>Total</dt><dd data-testid="custom-combo-total">{formatCurrency(fromPaise(unitPaise!))}</dd></div>
                  </>
                )}
              </dl>
            )}

            {(addError || (quote.error && !quote.loading)) && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-brand-danger">{addError || friendlyError(quote.error, 'We could not price this combo. Please check your selections.')}</p>
            )}

            <button type="button" onClick={handleAddToCart} disabled={lines.size === 0 || quote.loading || committing} className="btn-primary w-full !min-h-[52px]">
              <ShoppingCart className="h-5 w-5" aria-hidden="true" />
              {lines.size === 0 ? 'Select products to continue' : quote.loading ? 'Calculating…' : `Add combo to cart · ${unitPaise !== null ? formatCurrency(fromPaise(unitPaise)) : ''}`}
            </button>
          </div>
        </aside>

        {/* Product picker */}
        <div className="order-2 min-w-0 lg:order-1 lg:flex-1">
          <div className="relative mb-6">
            <label htmlFor="cc-search" className="sr-only">Search products</label>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-brand-muted" aria-hidden="true" />
            <input id="cc-search" className="input !py-3.5 !pl-12" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSearch()} placeholder="Search for products…" />
            {searchTerm && <button type="button" onClick={() => { setSearchTerm(''); setShowSearchResults(false); }} aria-label="Clear search" className="absolute right-4 top-1/2 -translate-y-1/2 text-brand-muted"><X className="h-4 w-4" aria-hidden="true" /></button>}
          </div>

          <div className="card mb-6 flex flex-wrap items-center gap-2 p-4 text-sm">
            <button type="button" onClick={() => { setSelectedCategory(null); setSelectedGender('all'); }} aria-pressed={!selectedCategory} className={`rounded-full px-4 py-2 ${!selectedCategory ? 'bg-brand-ink text-white' : 'bg-brand-subtle hover:bg-brand-line'}`}>All categories</button>
            {selectedCategory && <span className="rounded-full bg-brand-ink px-4 py-2 text-white">{selectedCategory.name}</span>}
            {selectedGender !== 'all' && <span className="rounded-full bg-brand-ink px-4 py-2 capitalize text-white">{selectedGender}</span>}
          </div>

          {!selectedCategory && !showSearchResults && (
            <section className="mb-8" aria-labelledby="cc-cat-h">
              <h2 id="cc-cat-h" className="mb-4 text-xl font-bold">Choose a category</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {categories.map((category) => {
                  const familyIds = categoryFamilyIds(category);
                  const count = products.filter((p) => (p.categories?.length ? p.categories.some((cat: any) => familyIds.includes(cat.id) || cat.name === category.name) : p.category === category.name)).length;
                  return (
                    <CategoryCard key={category.id} name={category.name} icon={category.icon || '🎁'} icon_type={category.icon_type || 'emoji'} image_url={category.image_url} color={category.color || 'from-brand-accent/20 to-brand-subtle'} hover_effect={category.hover_effect} count={count} onClick={() => { setSelectedCategory(category); setSelectedGender('all'); setSearchTerm(''); setShowSearchResults(false); }} />
                  );
                })}
              </div>
            </section>
          )}

          {selectedCategory && !showSearchResults && genders.length > 0 && (
            <section className="mb-8" aria-labelledby="cc-gender-h">
              <h3 id="cc-gender-h" className="mb-3 flex items-center gap-2 text-sm font-bold"><Users className="h-4 w-4 text-brand-accent-ink" aria-hidden="true" /> Filter by</h3>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="cc-gender-h">
                <button type="button" onClick={() => setSelectedGender('all')} aria-pressed={selectedGender === 'all'} className={`rounded-full px-4 py-2 text-sm capitalize ${selectedGender === 'all' ? 'bg-brand-ink text-white' : 'bg-brand-subtle hover:bg-brand-line'}`}>All</button>
                {genders.map((g) => <button key={g.name} type="button" onClick={() => setSelectedGender(g.name)} aria-pressed={selectedGender === g.name} className={`rounded-full px-4 py-2 text-sm capitalize ${selectedGender === g.name ? 'bg-brand-ink text-white' : 'bg-brand-subtle hover:bg-brand-line'}`}>{(g as any).icon} {g.display_name}</button>)}
              </div>
            </section>
          )}

          <section aria-labelledby="cc-products-h">
            <h2 id="cc-products-h" className="mb-4 text-xl font-bold">{showSearchResults ? 'Search results' : 'Select products'}</h2>
            {displayProducts.length === 0 ? (
              <EmptyState
                title={showSearchResults ? 'No results found' : 'No products found'}
                description={showSearchResults ? `Nothing matches "${searchTerm}".` : 'There are no products in this category yet.'}
                action={selectedCategory ? <button type="button" className="btn-secondary" onClick={() => setSelectedCategory(null)}>Browse other categories</button> : undefined}
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {displayProducts.map((product) => {
                  const groups = getAllGroups(product);
                  const chosen = choicesFor(product.id);
                  const missing = missingRequiredAll(product, chosen);
                  const selected = selectionsFromChoices(product, chosen);
                  const isInCombo = Array.from(lines.keys()).some((k) => k === product.id || k.startsWith(`${product.id}-`));
                  const stock = stockLimitFor(product, chosen);
                  const soldOut = stock !== null && stock <= 0 && groups.every((g) => !g.is_required || chosen[g.id]);
                  const price = Number(product.price) + Number(product.customization_price || 0) + selected.reduce((s, o) => s + (Number(o.price_modifier) || 0), 0);
                  return (
                    <article key={product.id} className={`card p-4 ${isInCombo ? 'border-brand-ink' : ''}`}>
                      <div className="flex flex-col gap-4 sm:flex-row">
                        <img src={getImageUrl(imageForChoices(product, chosen) || product.image_url)} alt="" className="h-40 w-full rounded-lg object-cover sm:h-24 sm:w-24" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
                        <div className="min-w-0 flex-1">
                          <h3 className="line-clamp-1 font-semibold">{product.name}</h3>
                          <p className="mt-1 line-clamp-2 text-sm text-brand-muted">{product.description}</p>

                          {groups.length > 0 && (
                            <div className="mt-3 space-y-3">
                              {groups.map((g) => {
                                const values: PickerValue[] = g.values.filter((v) => v.is_active).map((v) => ({ id: v.id, label: v.metadata?.size_code || v.name, price_modifier: v.price_modifier, stock: v.stock_quantity, image_url: v.image_url, swatch: (v.metadata?.color_code as string) || null }));
                                return <OptionGroupPicker key={g.id} fieldId={`cc-opt-${product.id}-${g.id}`} name={g.name} required={g.is_required} values={values} selectedId={chosen[g.id]} onSelect={(vid) => chooseOption(product.id, g.id, vid)} />;
                              })}
                            </div>
                          )}

                          {stock !== null && stock > 0 && stock <= 5 && missing.length === 0 && <p className="mt-2 text-xs font-medium text-brand-accent-ink">Only {stock} left</p>}

                          <div className="mt-3 flex items-center justify-between gap-2">
                            <div>
                              <span className="font-bold">{missing.length > 0 && 'From '}{formatCurrency(price)}</span>
                              {product.is_customizable && <span className="ml-2"><Badge tone="accent">Personalisable</Badge></span>}
                            </div>
                            <button
                              type="button"
                              onClick={() => handleAddToCombo(product)}
                              disabled={(totalItems >= MAX_ITEMS && !isInCombo) || soldOut}
                              className={isInCombo ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
                            >
                              {soldOut ? 'Sold out' : isInCombo ? 'Added' : 'Add'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default CustomCombo;
