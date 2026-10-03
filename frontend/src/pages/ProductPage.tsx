import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Minus, PenLine, Plus, Share2, ShoppingBag } from 'lucide-react';
import toast from 'react-hot-toast';
import { Product, ProductColor, ProductSize, Review, SelectedOption } from '../types';
import { getExtraGroups, toSelectedOption, variantSelections, missingRequiredGroups } from '../utils/options';
import { formatCurrency, formatModifier, fromPaise, lineTotal, toPaise } from '../utils/money';
import { getImageUrl } from '../utils/helpers';
import { useCart } from '../context/CartContext';
import { apiFetch } from '../utils/api';
import { friendlyError } from '../utils/errors';
import { openCart } from '../utils/cartUi';
import { categoryLink, useCategoryTree } from '../hooks/useCategoryTree';
import ProductCustomizationModal from '../components/ProductCustomizationModal';
import ProductGallery from '../components/product/ProductGallery';
import OptionGroupPicker, { PickerValue } from '../components/product/OptionGroupPicker';
import ProductReviews from '../components/product/ProductReviews';
import ProductCard from '../components/ProductCard';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { ErrorState, Skeleton } from '../components/ui/States';
import { BRAND } from '../config/brand';

const MAX_QTY = 99;        // UI cap for products without tracked stock (the server enforces the real limits)
const LOW_STOCK = 10;
// The legacy colour/size adapters report 'not tracked' as a very large number
const UNTRACKED = 9999;
const firstAvailable = <T extends { is_active: boolean; stock_quantity: number }>(list: T[] | undefined): T | null =>
  (list || []).find((x) => x.is_active && Number(x.stock_quantity) > 0) || (list || []).find((x) => x.is_active) || null;

const setMetaTags = (title: string, description: string, imageUrl: string) => {
  const upsert = (selector: string, attr: string, val: string, content: string) => {
    let el = document.querySelector(selector) as HTMLMetaElement | null;
    if (!el) { el = document.createElement('meta'); el.setAttribute(attr, val); document.head.appendChild(el); }
    el.setAttribute('content', content);
  };
  document.title = `${title} — ${BRAND.name}`;
  upsert('meta[name="description"]', 'name', 'description', description);
  upsert('meta[property="og:title"]', 'property', 'og:title', title);
  upsert('meta[property="og:description"]', 'property', 'og:description', description);
  upsert('meta[property="og:image"]', 'property', 'og:image', imageUrl);
  upsert('meta[property="og:url"]', 'property', 'og:url', window.location.href);
  upsert('meta[property="og:type"]', 'property', 'og:type', 'product');
};

const ProductPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { addItem } = useCart();
  const { tree } = useCategoryTree();

  const [product, setProduct] = useState<Product | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [related, setRelated] = useState<Product[]>([]);
  const [tab, setTab] = useState<'details' | 'reviews'>('details');

  const [quantity, setQuantity] = useState(1);
  const [selectedColor, setSelectedColor] = useState<ProductColor | null>(null);
  const [selectedSize, setSelectedSize] = useState<ProductSize | null>(null);
  // Choices in option groups other than colour/size: option group id -> option value id
  const [extraChoice, setExtraChoice] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [showCustomization, setShowCustomization] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [buyBoxVisible, setBuyBoxVisible] = useState(true);
  const buyBoxRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- loading */
  const load = (key: string) => {
    setStatus('loading');
    apiFetch<Product>(`/api/products/${key}`)
      .then((data) => {
        setProduct(data);
        setQuantity(1); setExtraChoice({}); setErrors({}); setFormError(''); setAdded(null);
        setSelectedColor(firstAvailable(data.colors));
        setSelectedSize(firstAvailable(data.sizes));
        setStatus('ready');
        setMetaTags(data.name, data.description || data.name, getImageUrl(data.image_url || ''));
        setLoadingReviews(true);
        // the URL may carry a slug; reviews are keyed by id
        apiFetch<Review[]>(`/api/reviews/product/${data.id}`)
          .then((r) => setReviews((r || []).filter((x) => x.is_approved)))
          .catch(() => setReviews([]))
          .finally(() => setLoadingReviews(false));
        const cat = data.categories?.[0]?.name || data.category;
        if (cat) {
          apiFetch<Product[]>('/api/products')
            .then((all) => setRelated((all || []).filter((p) => p.id !== data.id && (p.categories?.some((c: any) => c.name === cat) || p.category === cat)).slice(0, 4)))
            .catch(() => setRelated([]));
        } else setRelated([]);
      })
      .catch((e) => setStatus(/not found|unavailable|404/i.test(String(e?.message)) ? 'unavailable' : 'error'));
  };
  useEffect(() => { if (id) load(id); /* eslint-disable-next-line */ }, [id]);

  // sticky mobile buy bar appears when the main buy box scrolls out of view
  useEffect(() => {
    const el = buyBoxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setBuyBoxVisible(entry.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [status]);

  /* ---------------------------------------------------------------- derived data */
  const activeColors = useMemo(() => (product?.colors || []).filter((c) => c.is_active), [product]);
  const activeSizes = useMemo(() => (product?.sizes || []).filter((s) => s.is_active), [product]);
  const extraGroups = useMemo(() => getExtraGroups(product), [product]);
  const colourGroup = product?.option_groups?.find((g) => g.slug === 'colour');
  const sizeGroup = product?.option_groups?.find((g) => g.slug === 'size');

  const selectedExtras: SelectedOption[] = extraGroups.flatMap((g) => {
    const v = g.values.find((x) => x.id === extraChoice[g.id]);
    return v ? [toSelectedOption(g, v)] : [];
  });
  const allSelected: SelectedOption[] = product ? [...variantSelections(product, selectedColor?.id, selectedSize?.id), ...selectedExtras] : [];

  // Stock: the smallest tracked limit among the product and the chosen options. null = nothing tracked.
  const stockLimit = useMemo((): number | null => {
    if (!product) return null;
    const parts: number[] = [];
    if (product.track_stock) parts.push(Number(product.stock_quantity) || 0);
    if (selectedColor && Number(selectedColor.stock_quantity) < UNTRACKED) parts.push(Number(selectedColor.stock_quantity) || 0);
    if (selectedSize && Number(selectedSize.stock_quantity) < UNTRACKED) parts.push(Number(selectedSize.stock_quantity) || 0);
    for (const g of extraGroups) {
      const v = g.values.find((x) => x.id === extraChoice[g.id]);
      if (v && v.stock_quantity !== null && v.stock_quantity !== undefined) parts.push(Number(v.stock_quantity) || 0);
    }
    return parts.length ? Math.min(...parts) : null;
  }, [product, selectedColor, selectedSize, extraChoice, extraGroups]);
  const maxQty = stockLimit === null ? MAX_QTY : Math.min(stockLimit, MAX_QTY);
  const outOfStock = stockLimit !== null && stockLimit <= 0;

  // keep the quantity within what is available whenever the choices change
  useEffect(() => { setQuantity((q) => Math.max(1, Math.min(q, Math.max(maxQty, 1)))); }, [maxQty]);

  // Display arithmetic in paise (see utils/money). The server recomputes everything when the order is priced.
  const basePaise = toPaise(product?.price);
  const optionLines = allSelected.filter((o) => toPaise(o.price_modifier) !== 0);
  const feePaise = product?.is_customizable ? toPaise(product.customization_price) : 0;
  const unitPaise = basePaise + allSelected.reduce((s, o) => s + toPaise(o.price_modifier), 0) + feePaise;
  const unit = fromPaise(unitPaise);
  const total = lineTotal(unit, quantity);
  const original = Number(product?.original_price) || 0;
  const baseWithOptions = fromPaise(unitPaise - feePaise);
  const saving = original > baseWithOptions ? original - baseWithOptions : 0;

  const images = useMemo(() => {
    if (!product) return [];
    const src = selectedColor?.image_url ? selectedColor : null;
    if (src) return [src.image_url, ...(src.additional_images || [])];
    return [product.image_url, ...(product.additional_images || [])];
  }, [product, selectedColor]);

  const categoryTrail = useMemo(() => {
    const c = product?.categories?.[0];
    if (!c) return product?.category ? [{ name: product.category, link: `/products?category=${encodeURIComponent(product.category)}` }] : [];
    const parent = tree.find((p) => p.id === c.parent_id || p.children?.some((k) => k.id === c.id));
    const trail = parent && parent.id !== c.id ? [parent, c] : [c];
    return trail.map((t) => ({ name: t.name, link: categoryLink(t) }));
  }, [product, tree]);

  /* ---------------------------------------------------------------- actions */
  const validate = (): boolean => {
    if (!product) return false;
    const missing = missingRequiredGroups(product, extraChoice);
    if (missing.length === 0) { setErrors({}); setFormError(''); return true; }
    const next: Record<string, string> = {};
    missing.forEach((g) => { next[g.id] = `Please choose a ${g.name.toLowerCase()} to continue.`; });
    setErrors(next);
    setFormError(`Please choose: ${missing.map((g) => g.name).join(', ')}.`);
    const first = document.getElementById(`opt-${missing[0].id}`);
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first?.focus({ preventScroll: true });
    return false;
  };

  const choose = (groupId: string, valueId: string | null) => {
    setExtraChoice((prev) => { const n = { ...prev }; if (valueId) n[groupId] = valueId; else delete n[groupId]; return n; });
    setErrors((e) => { if (!e[groupId]) return e; const n = { ...e }; delete n[groupId]; return n; });
    setFormError('');
    setAdded(null);
  };

  const handleAdd = () => {
    if (!product || adding) return;
    if (outOfStock) { setFormError('This product is currently out of stock.'); return; }
    if (!validate()) return;
    if (product.is_customizable) { setShowCustomization(true); return; }
    setAdding(true);
    addItem({
      id: `${product.id}-${allSelected.map((o) => o.value_id).join('-')}-${Date.now()}`,
      product_id: product.id,
      selected_options: allSelected,
      name: allSelected.length ? `${product.name} (${allSelected.map((o) => o.name).join(', ')})` : product.name,
      price: unit, quantity, image_url: images[0] || product.image_url, type: 'product', category: product.category,
      color_id: selectedColor?.id, color_name: selectedColor?.color_name, color_code: selectedColor?.color_code,
      size_id: selectedSize?.id, size_name: selectedSize?.size_name, size_code: selectedSize?.size_code,
    });
    setAdded(`${quantity} × ${product.name} added to your cart.`);
    toast.success('Added to cart');
    setTimeout(() => setAdding(false), 700);
  };

  const handleShare = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: product?.name, url });
      else { await navigator.clipboard.writeText(url); toast.success('Link copied'); }
    } catch { /* cancelled */ }
  };

  /* ---------------------------------------------------------------- states */
  if (status === 'loading') {
    return (
      <div className="container-page py-8" aria-busy="true" role="status" aria-label="Loading product">
        <Skeleton className="mb-6 h-4 w-64" />
        <div className="grid gap-8 lg:grid-cols-2">
          <Skeleton className="aspect-square w-full" />
          <div className="space-y-4"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-6 w-1/4" /><Skeleton className="h-24 w-full" /><Skeleton className="h-12 w-full" /></div>
        </div>
      </div>
    );
  }
  if (status !== 'ready' || !product) {
    return (
      <div className="container-page section">
        <ErrorState
          title={status === 'unavailable' ? 'This product is not available' : 'We could not load this product'}
          description={status === 'unavailable' ? 'It may have been removed or is not for sale right now.' : 'Please check your connection and try again.'}
          action={<div className="flex flex-wrap justify-center gap-3">{status === 'error' && id && <button type="button" className="btn-primary" onClick={() => load(id)}>Try again</button>}<ButtonLink to="/products" variant="secondary">Browse products</ButtonLink></div>}
        />
      </div>
    );
  }

  const stockNote = stockLimit === null ? null : stockLimit <= 0 ? 'Out of stock' : stockLimit <= LOW_STOCK ? `Only ${stockLimit} left` : 'In stock';
  const rating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const addLabel = product.is_customizable ? 'Personalise & add to cart' : 'Add to cart';

  const colourValues: PickerValue[] = activeColors.map((c) => ({ id: c.id, label: c.color_name, price_modifier: c.price_modifier, stock: c.stock_quantity, image_url: c.image_url || null, swatch: c.color_code || null }));
  const sizeValues: PickerValue[] = activeSizes.map((s) => ({ id: s.id, label: s.size_code ? `${s.size_name} (${s.size_code})` : s.size_name, price_modifier: s.price_modifier, stock: s.stock_quantity }));

  return (
    <div className="pb-24 lg:pb-0">
      <div className="container-page py-6 lg:py-8">
        <nav aria-label="Breadcrumb" className="mb-5 text-sm text-brand-muted">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <li><Link to="/" className="hover:text-brand-ink">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link to="/products" className="hover:text-brand-ink">Shop</Link></li>
            {categoryTrail.map((c) => (<React.Fragment key={c.name}><li aria-hidden="true">/</li><li><Link to={c.link} className="hover:text-brand-ink">{c.name}</Link></li></React.Fragment>))}
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-medium text-brand-ink">{product.name}</li>
          </ol>
        </nav>

        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <ProductGallery
              images={images}
              alt={product.name}
              resetKey={selectedColor?.id}
              badges={<>{product.discount_percentage ? <Badge tone="danger">-{product.discount_percentage}%</Badge> : null}{outOfStock && <Badge tone="dark">Out of stock</Badge>}</>}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                {product.is_customizable && <div className="mb-2"><Badge tone="accent">Personalisable</Badge></div>}
                <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{product.name}</h1>
              </div>
              <button type="button" onClick={handleShare} aria-label="Share this product" className="btn-ghost btn-sm !px-2"><Share2 className="h-5 w-5" aria-hidden="true" /></button>
            </div>

            {reviews.length > 0 && (
              <button type="button" onClick={() => { setTab('reviews'); document.getElementById('product-tabs')?.scrollIntoView({ behavior: 'smooth' }); }} className="mt-2 flex items-center gap-1.5 text-sm text-brand-muted hover:text-brand-ink">
                <span className="font-semibold text-brand-ink">{rating.toFixed(1)}</span> ★ <span>({reviews.length} {reviews.length === 1 ? 'review' : 'reviews'})</span>
              </button>
            )}

            {Number(product.price) > 0 && (
              <p className="mt-4 flex flex-wrap items-baseline gap-3" aria-live="polite">
                <span className="text-3xl font-extrabold" data-testid="unit-price">{formatCurrency(unit)}</span>
                {saving > 0 && <><span className="text-lg text-brand-muted line-through">{formatCurrency(original)}</span><Badge tone="danger">Save {formatCurrency(saving)}</Badge></>}
              </p>
            )}

            {/* ---- options: generic groups rendered from the API ---- */}
            {(activeColors.length > 0 || activeSizes.length > 0 || extraGroups.length > 0) && (
              <div className="mt-6 space-y-6" data-testid="options">
                {activeColors.length > 0 && (
                  <OptionGroupPicker fieldId="opt-colour" name={colourGroup?.name || 'Colour'} required={colourGroup?.is_required ?? true} values={colourValues} selectedId={selectedColor?.id}
                    onSelect={(vid) => { setSelectedColor(activeColors.find((c) => c.id === vid) || null); setAdded(null); }} />
                )}
                {activeSizes.length > 0 && (
                  <OptionGroupPicker fieldId="opt-size" name={sizeGroup?.name || 'Size'} required={sizeGroup?.is_required ?? true} values={sizeValues} selectedId={selectedSize?.id}
                    onSelect={(vid) => { setSelectedSize(activeSizes.find((s) => s.id === vid) || null); setAdded(null); }} />
                )}
                {extraGroups.map((g) => (
                  <OptionGroupPicker
                    key={g.id}
                    fieldId={`opt-${g.id}`}
                    name={g.name}
                    required={g.is_required}
                    error={errors[g.id]}
                    selectedId={extraChoice[g.id]}
                    onSelect={(vid) => choose(g.id, vid)}
                    values={g.values.filter((v) => v.is_active).map((v) => ({ id: v.id, label: v.name, price_modifier: v.price_modifier, stock: v.stock_quantity, image_url: v.image_url, swatch: (v.metadata?.color_code as string) || null }))}
                  />
                ))}
              </div>
            )}

            {/* ---- personalisation ---- */}
            {product.is_customizable && (
              <section aria-labelledby="pz-title" className="mt-6 rounded-xl border border-brand-accent/50 bg-brand-accent-soft p-4">
                <div className="flex items-center gap-2"><PenLine className="h-4 w-4 text-brand-accent-ink" aria-hidden="true" /><h2 id="pz-title" className="text-sm font-bold">Personalisation required</h2></div>
                <p className="mt-1 text-sm text-brand-muted">
                  You will add
                  {Number(product.max_customization_lines) > 0 && ` up to ${product.max_customization_lines} ${Number(product.max_customization_lines) === 1 ? 'line' : 'lines'} of text${Number(product.max_customization_characters) > 0 ? ` (up to ${product.max_customization_characters} characters each)` : ''}`}
                  {Number(product.max_customization_lines) > 0 && Number(product.max_customization_images) > 0 && ' and'}
                  {Number(product.max_customization_images) > 0 && ` up to ${product.max_customization_images} ${Number(product.max_customization_images) === 1 ? 'image' : 'images'}`}
                  {Number(product.max_customization_lines) > 0 || Number(product.max_customization_images) > 0 ? ' in the next step.' : ' your personalisation in the next step.'}
                </p>
                {feePaise > 0 && <p className="mt-1 text-sm font-medium">Personalisation fee: {formatModifier(fromPaise(feePaise))} per item</p>}
              </section>
            )}

            {/* ---- price breakdown ---- */}
            {Number(product.price) > 0 && (optionLines.length > 0 || feePaise > 0) && (
              <dl className="mt-6 space-y-1.5 rounded-xl border border-brand-line p-4 text-sm" data-testid="price-breakdown" aria-label="Price breakdown">
                <div className="flex justify-between"><dt className="text-brand-muted">Base price</dt><dd>{formatCurrency(fromPaise(basePaise))}</dd></div>
                {optionLines.map((o) => (<div key={o.value_id} className="flex justify-between"><dt className="text-brand-muted">{o.group_name}: {o.name}</dt><dd>{formatModifier(o.price_modifier)}</dd></div>))}
                {feePaise > 0 && <div className="flex justify-between"><dt className="text-brand-muted">Personalisation</dt><dd>{formatModifier(fromPaise(feePaise))}</dd></div>}
                <div className="flex justify-between border-t border-brand-line pt-2 font-semibold"><dt>Price per item</dt><dd>{formatCurrency(unit)}</dd></div>
              </dl>
            )}

            {/* ---- quantity + add to cart ---- */}
            <div ref={buyBoxRef} className="mt-6">
              {stockNote && (
                <p className={`mb-3 inline-flex items-center gap-2 text-sm font-medium ${outOfStock ? 'text-brand-danger' : stockLimit !== null && stockLimit <= LOW_STOCK ? 'text-brand-accent-ink' : 'text-brand-success'}`} role="status">
                  <span aria-hidden="true">{outOfStock ? '✕' : '●'}</span> {stockNote}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span id="qty-label" className="text-sm font-medium">Quantity</span>
                  <div className="inline-flex items-center rounded-lg border border-brand-line" role="group" aria-labelledby="qty-label">
                    <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={quantity <= 1} aria-label="Decrease quantity" className="flex h-11 w-11 items-center justify-center hover:bg-brand-subtle disabled:opacity-40"><Minus className="h-4 w-4" aria-hidden="true" /></button>
                    <output aria-live="polite" className="w-10 text-center font-semibold" data-testid="qty">{quantity}</output>
                    <button type="button" onClick={() => setQuantity((q) => Math.min(maxQty, q + 1))} disabled={quantity >= maxQty || outOfStock} aria-label="Increase quantity" className="flex h-11 w-11 items-center justify-center hover:bg-brand-subtle disabled:opacity-40"><Plus className="h-4 w-4" aria-hidden="true" /></button>
                  </div>
                  {stockLimit !== null && quantity >= maxQty && !outOfStock && <span className="text-xs text-brand-muted">Maximum available</span>}
                </div>
              </div>

              {formError && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-brand-danger" data-testid="form-error">{formError}</p>}

              <button type="button" onClick={handleAdd} disabled={outOfStock || adding} aria-disabled={outOfStock || adding} className="btn-primary mt-4 w-full !min-h-[52px] text-base">
                <ShoppingBag className="h-5 w-5" aria-hidden="true" />
                {outOfStock ? 'Out of stock' : `${addLabel}${Number(product.price) > 0 ? ` · ${formatCurrency(total)}` : ''}`}
              </button>

              <div aria-live="polite" className="min-h-[1.5rem]">
                {added && (
                  <p className="mt-3 flex flex-wrap items-center gap-3 text-sm font-medium text-brand-success" data-testid="added-status">
                    <span className="inline-flex items-center gap-1"><Check className="h-4 w-4" aria-hidden="true" /> {added}</span>
                    <button type="button" onClick={openCart} className="underline underline-offset-2 hover:text-brand-ink">View cart</button>
                  </p>
                )}
              </div>
            </div>

            {/* ---- details / reviews ---- */}
            <section id="product-tabs" className="mt-8 border-t border-brand-line pt-6" aria-label="Product information">
              <div role="tablist" aria-label="Product information" className="mb-4 flex gap-1 border-b border-brand-line">
                {(['details', 'reviews'] as const).map((t) => (
                  <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={`panel-${t}`} onClick={() => setTab(t)}
                    className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold capitalize ${tab === t ? 'border-brand-ink text-brand-ink' : 'border-transparent text-brand-muted hover:text-brand-ink'}`}>
                    {t}{t === 'reviews' && reviews.length > 0 ? ` (${reviews.length})` : ''}
                  </button>
                ))}
              </div>
              {tab === 'details' ? (
                <div role="tabpanel" id="panel-details" aria-labelledby="tab-details" className="text-sm text-brand-muted">
                  {product.description ? <p className="whitespace-pre-line leading-relaxed">{product.description}</p> : <p>No description has been added yet.</p>}
                  {product.gender && product.gender !== 'unisex' && <p className="mt-3"><span className="font-medium text-brand-ink">Suitable for:</span> <span className="capitalize">{product.gender}</span></p>}
                </div>
              ) : (
                <div role="tabpanel" id="panel-reviews" aria-labelledby="tab-reviews"><ProductReviews productId={product.id} reviews={reviews} loading={loadingReviews} /></div>
              )}
            </section>
          </div>
        </div>

        {related.length > 0 && (
          <section className="mt-14" aria-labelledby="related-title">
            <h2 id="related-title" className="mb-6 text-xl font-bold sm:text-2xl">You may also like</h2>
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4">{related.map((p) => <ProductCard key={p.id} product={p} />)}</div>
          </section>
        )}
      </div>

      {/* sticky purchase bar on small screens, only while the main buy box is out of view */}
      {!buyBoxVisible && !showCustomization && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-brand-line bg-white/95 p-3 backdrop-blur lg:hidden" data-testid="sticky-buy">
          <div className="container-page flex items-center gap-3 !px-1">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{product.name}</p>
              {Number(product.price) > 0 && <p className="text-sm text-brand-muted">{formatCurrency(total)}</p>}
            </div>
            <button type="button" onClick={handleAdd} disabled={outOfStock || adding} className="btn-primary shrink-0">{outOfStock ? 'Out of stock' : addLabel}</button>
          </div>
        </div>
      )}

      {showCustomization && (
        <ProductCustomizationModal
          product={product}
          selectedImageUrl={images[0]}
          selectedOptions={allSelected}
          variantFields={{ color_id: selectedColor?.id, color_name: selectedColor?.color_name, color_code: selectedColor?.color_code, size_id: selectedSize?.id, size_name: selectedSize?.size_name, size_code: selectedSize?.size_code }}
          initialQuantity={quantity}
          maxQuantity={maxQty}
          onClose={() => setShowCustomization(false)}
          onAdded={(msg) => setAdded(msg)}
        />
      )}
    </div>
  );
};

export default ProductPage;
