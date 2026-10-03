import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, PenLine, Share2, ShoppingBag } from 'lucide-react';
import toast from 'react-hot-toast';
import { Combo, ComboProduct, CustomizationData, Product } from '../types';
import { getAllGroups, selectionsFromChoices, missingRequiredAll, imageForChoices, optionsTotal } from '../utils/options';
import { getImageUrl } from '../utils/helpers';
import { formatCurrency, fromPaise, toPaise } from '../utils/money';
import { useCart } from '../context/CartContext';
import { apiFetch } from '../utils/api';
import { friendlyError } from '../utils/errors';
import ProductCustomizationModal from '../components/ProductCustomizationModal';
import ProductGallery from '../components/product/ProductGallery';
import OptionGroupPicker, { PickerValue } from '../components/product/OptionGroupPicker';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { ErrorState, Skeleton } from '../components/ui/States';

const toPricingItems = (line: any) => [line];

const ComboPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { addItem } = useCart();

  const [combo, setCombo] = useState<Combo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  // Choices per member product: product id -> (option group id -> option value id). Same generic model as ProductPage.
  const [choices, setChoices] = useState<Map<string, Record<string, string>>>(new Map());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [customizationStep, setCustomizationStep] = useState<number | null>(null);
  const [collected, setCollected] = useState<Record<number, CustomizationData>>({});
  const [checking, setChecking] = useState(false);

  const load = (comboId: string) => {
    setStatus('loading');
    apiFetch<Combo>(`/api/combos/${comboId}`)
      .then((data) => { setCombo(data); setChoices(new Map()); setErrors({}); setFormError(''); setStatus('ready'); })
      .catch((e) => setStatus(e?.status === 404 ? 'unavailable' : 'error'));
  };
  useEffect(() => { if (id) load(id); /* eslint-disable-next-line */ }, [id]);

  const comboProducts: ComboProduct[] = combo?.combo_products || combo?.products || [];
  const choicesFor = (productId: string) => choices.get(productId) || {};

  const choose = (productId: string, groupId: string, valueId: string | null) => {
    setChoices((prev) => {
      const next = new Map(prev);
      const current = { ...(next.get(productId) || {}) };
      if (valueId) current[groupId] = valueId; else delete current[groupId];
      next.set(productId, current);
      return next;
    });
    setErrors((e) => { const k = `${productId}:${groupId}`; if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; });
    setFormError('');
  };

  // Display arithmetic in paise (utils/money): the combo's own price plus every member's option surcharge.
  const originalPricePaise = comboProducts.reduce((sum, item) => sum + toPaise(item.product?.price) * (item.quantity || 1), 0);
  const originalPrice = fromPaise(originalPricePaise);
  const basePricePaise = combo?.discount_price != null ? toPaise(combo.discount_price) : originalPricePaise;
  const savingsPaise = combo?.discount_price != null && basePricePaise < originalPricePaise ? originalPricePaise - basePricePaise : 0;
  const savingsPct = savingsPaise > 0 ? Math.round((savingsPaise / originalPricePaise) * 100) : 0;

  const optionSurchargePaise = comboProducts.reduce((sum, item) => {
    const p = item.product; if (!p) return sum;
    const selected = selectionsFromChoices(p, choicesFor(p.id));
    return sum + toPaise(optionsTotal(selected)) * (item.quantity || 1);
  }, 0);
  const hasPricedOptions = comboProducts.some((item) => getAllGroups(item.product).some((g) => g.values.some((v) => v.is_active && Number(v.price_modifier) !== 0)));
  const missingByProduct = comboProducts.map((item) => (item.product ? { product: item.product, missing: missingRequiredAll(item.product, choicesFor(item.product.id)) } : null)).filter(Boolean) as { product: Product; missing: ReturnType<typeof missingRequiredAll> }[];
  const needsSelection = missingByProduct.some((m) => m.missing.length > 0);
  const total = fromPaise(basePricePaise + optionSurchargePaise);

  const customizableItems = comboProducts.filter((item) => item.product?.is_customizable);

  // Stock: for each member, the smallest tracked limit (product stock, chosen option stock) divided by how many
  // of it one combo needs. The combo's own quantity (always 1 here) cannot exceed the tightest member.
  const stockLimit = useMemo((): number | null => {
    let limit: number | null = null;
    for (const item of comboProducts) {
      const p = item.product; if (!p) continue;
      const perUnit = item.quantity || 1;
      const parts: number[] = [];
      if (p.track_stock) parts.push(Number(p.stock_quantity) || 0);
      for (const g of getAllGroups(p)) {
        const v = g.values.find((x) => x.id === choicesFor(p.id)[g.id]);
        if (v && v.stock_quantity !== null && v.stock_quantity !== undefined) parts.push(Number(v.stock_quantity) || 0);
      }
      if (parts.length === 0) continue;
      const memberLimit = Math.floor(Math.min(...parts) / perUnit);
      limit = limit === null ? memberLimit : Math.min(limit, memberLimit);
    }
    return limit;
  }, [comboProducts, choices]);
  const outOfStock = stockLimit !== null && stockLimit <= 0;

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    let firstId = '';
    for (const { product, missing } of missingByProduct) {
      for (const g of missing) {
        const key = `${product.id}:${g.id}`;
        next[key] = `Please choose a ${g.name.toLowerCase()} for ${product.name}.`;
        if (!firstId) firstId = `combo-opt-${product.id}-${g.id}`;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError('Please choose every required option before adding this combo to your cart.');
      const el = firstId ? document.getElementById(firstId) : null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus({ preventScroll: true });
      return false;
    }
    setFormError('');
    return true;
  };

  const memberLine = (item: ComboProduct, customization?: CustomizationData) => {
    const p = item.product!;
    const selected = selectionsFromChoices(p, choicesFor(p.id));
    const image = imageForChoices(p, choicesFor(p.id)) || p.image_url;
    return {
      id: p.id, name: p.name, quantity: item.quantity, price: Number(p.price) || 0,
      image_url: image, customization,
      selected_options: selected.map((o) => ({ value_id: o.value_id })),
      option_labels: selected.map((o) => o.name),
    };
  };

  const commit = async (customizations: Record<number, CustomizationData>) => {
    if (!combo) return;
    // One last server check: confirms every member is still in stock and prices as expected before it lands in
    // the cart, so a sold-out surprise shows up now rather than as a confusing mismatch at checkout.
    setChecking(true);
    try {
      const preview = {
        id: `combo-${combo.id}-preview`, type: 'combo', combo_id: combo.id, quantity: 1,
        combo_products: comboProducts.map((item) => ({ id: item.product?.id, quantity: item.quantity, selected_options: selectionsFromChoices(item.product, choicesFor(item.product!.id)).map((o) => o.value_id) })),
      };
      await apiFetch('/api/orders/quote', { method: 'POST', body: JSON.stringify({ items: toPricingItems(preview), payment_method: 'cod' }) });
    } catch (e) {
      setFormError(friendlyError(e, 'This combo could not be added right now. Please check your selections and try again.'));
      setChecking(false);
      return;
    }
    setChecking(false);
    const payload = comboProducts.map((item, i) => memberLine(item, customizations[customizableItems.findIndex((ci) => ci.product?.id === item.product?.id)]));
    addItem({ id: `combo-${combo.id}-${Date.now()}`, name: combo.name, price: total, quantity: 1, image_url: combo.image_url || '', type: 'combo', combo_products: payload } as any);
    toast.success('Combo added to cart');
    navigate('/');
  };

  const handleAdd = () => {
    if (outOfStock) { setFormError('This combo is currently out of stock.'); return; }
    if (!validate()) return;
    if (customizableItems.length > 0) setCustomizationStep(0);
    else commit({});
  };

  const handleCustomizationComplete = (data: CustomizationData) => {
    const idx = customizationStep!;
    const updated = { ...collected, [idx]: data };
    setCollected(updated);
    const next = idx + 1;
    if (next < customizableItems.length) setCustomizationStep(next);
    else { setCustomizationStep(null); commit(updated); }
  };

  const currentProduct = customizationStep !== null ? customizableItems[customizationStep]?.product : undefined;
  const currentImage = currentProduct ? imageForChoices(currentProduct, choicesFor(currentProduct.id)) || currentProduct.image_url : undefined;

  if (status === 'loading') {
    return (
      <div className="container-page py-8" aria-busy="true" role="status" aria-label="Loading combo">
        <Skeleton className="mb-6 h-4 w-64" />
        <div className="grid gap-8 lg:grid-cols-2">
          <Skeleton className="aspect-square w-full" />
          <div className="space-y-4"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-6 w-1/4" /><Skeleton className="h-24 w-full" /><Skeleton className="h-12 w-full" /></div>
        </div>
      </div>
    );
  }
  if (status !== 'ready' || !combo) {
    return (
      <div className="container-page section">
        <ErrorState
          title={status === 'unavailable' ? 'This combo is not available' : 'We could not load this combo'}
          description={status === 'unavailable' ? 'It may have been removed or is not for sale right now.' : 'Please check your connection and try again.'}
          action={<div className="flex flex-wrap justify-center gap-3">{status === 'error' && id && <button type="button" className="btn-primary" onClick={() => load(id)}>Try again</button>}<ButtonLink to="/combos" variant="secondary">Browse combos</ButtonLink></div>}
        />
      </div>
    );
  }

  const images = [combo.image_url, ...(combo.additional_images || [])].filter(Boolean) as string[];
  const addLabel = customizableItems.length > 0 ? 'Personalise & add to cart' : 'Add combo to cart';

  return (
    <div>
      <div className="container-page py-6 lg:py-8">
        <nav aria-label="Breadcrumb" className="mb-5 text-sm text-brand-muted">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <li><Link to="/" className="hover:text-brand-ink">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link to="/combos" className="hover:text-brand-ink">Combos</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-medium text-brand-ink">{combo.name}</li>
          </ol>
        </nav>

        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <ProductGallery images={images} alt={combo.name} badges={<>{savingsPct > 0 && <Badge tone="danger">Save {savingsPct}%</Badge>}{outOfStock && <Badge tone="dark">Out of stock</Badge>}</>} />
          </div>

          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="mb-2"><Badge tone="accent">Combo</Badge></div>
                <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{combo.name}</h1>
              </div>
              <button
                type="button"
                onClick={() => { const url = window.location.href; if (navigator.share) navigator.share({ title: combo.name, url }).catch(() => {}); else navigator.clipboard.writeText(url).then(() => toast.success('Link copied')).catch(() => {}); }}
                aria-label="Share this combo" className="btn-ghost btn-sm !px-2"
              ><Share2 className="h-5 w-5" aria-hidden="true" /></button>
            </div>

            {combo.description && <p className="mt-3 text-sm text-brand-muted">{combo.description}</p>}

            <p className="mt-4 flex flex-wrap items-baseline gap-3">
              <span className="text-3xl font-extrabold">{formatCurrency(fromPaise(basePricePaise))}</span>
              {savingsPaise > 0 && <><span className="text-lg text-brand-muted line-through">{formatCurrency(originalPrice)}</span><Badge tone="danger">Save {formatCurrency(fromPaise(savingsPaise))}</Badge></>}
            </p>

            <section className="mt-6" aria-labelledby="combo-members-h">
              <h2 id="combo-members-h" className="mb-3 text-base font-bold">Included products ({comboProducts.length})</h2>
              <ul className="space-y-4">
                {comboProducts.map((item, idx) => {
                  const p = item.product; if (!p) return null;
                  const groups = getAllGroups(p);
                  const image = imageForChoices(p, choicesFor(p.id)) || p.image_url;
                  const memberMissing = missingRequiredAll(p, choicesFor(p.id));
                  const ready = memberMissing.length === 0;
                  return (
                    <li key={idx} className={`rounded-xl border-2 p-4 ${ready ? 'border-brand-line' : 'border-brand-accent/60 bg-brand-accent-soft/40'}`}>
                      <div className="flex items-start gap-3">
                        <div className="relative shrink-0">
                          <img src={getImageUrl(image)} alt="" className="h-16 w-16 rounded-lg object-cover" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
                          {ready && <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand-success text-white" aria-hidden="true"><Check className="h-3 w-3" /></span>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold">{p.name}</p>
                            <p className="shrink-0 text-sm text-brand-muted">Qty {item.quantity}</p>
                          </div>
                          {p.is_customizable && <div className="mt-1"><Badge tone="accent">Personalisable</Badge></div>}
                          {groups.length > 0 && (
                            <div className="mt-3 space-y-3">
                              {groups.map((g) => {
                                const values: PickerValue[] = g.values.filter((v) => v.is_active).map((v) => ({ id: v.id, label: v.name, price_modifier: v.price_modifier, stock: v.stock_quantity, image_url: v.image_url, swatch: (v.metadata?.color_code as string) || null }));
                                return (
                                  <OptionGroupPicker
                                    key={g.id}
                                    fieldId={`combo-opt-${p.id}-${g.id}`}
                                    name={g.name}
                                    required={g.is_required}
                                    values={values}
                                    selectedId={choicesFor(p.id)[g.id]}
                                    onSelect={(vid) => choose(p.id, g.id, vid)}
                                    error={errors[`${p.id}:${g.id}`]}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {customizableItems.length > 0 && (
              <div className="mt-6 flex items-start gap-3 rounded-xl border border-brand-accent/50 bg-brand-accent-soft p-4">
                <PenLine className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent-ink" aria-hidden="true" />
                <p className="text-sm"><span className="font-bold">Personalisation required.</span> You'll personalise {customizableItems.length} {customizableItems.length === 1 ? 'item' : 'items'} after choosing your options above.</p>
              </div>
            )}

            <dl className="mt-6 space-y-1.5 rounded-xl border border-brand-line p-4 text-sm" data-testid="price-breakdown">
              <div className="flex justify-between"><dt className="text-brand-muted">Combo price</dt><dd>{formatCurrency(fromPaise(basePricePaise))}</dd></div>
              {optionSurchargePaise !== 0 && <div className="flex justify-between" data-testid="combo-option-surcharge"><dt className="text-brand-muted">Selected options</dt><dd>{optionSurchargePaise > 0 ? '+' : '-'}{formatCurrency(Math.abs(fromPaise(optionSurchargePaise)))}</dd></div>}
              <div className="flex justify-between border-t border-brand-line pt-2 font-semibold">
                <dt>Total</dt>
                <dd data-testid="combo-total">{needsSelection ? <span className="text-sm font-medium text-brand-accent-ink">Select all options to see your total</span> : formatCurrency(total)}</dd>
              </div>
              {hasPricedOptions && !needsSelection && <p className="text-xs text-brand-muted">The final total is confirmed at checkout.</p>}
            </dl>

            {stockLimit !== null && (
              <p className={`mt-3 text-sm font-medium ${outOfStock ? 'text-brand-danger' : 'text-brand-success'}`} role="status">{outOfStock ? 'Out of stock' : `Only ${stockLimit} available`}</p>
            )}

            {formError && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-brand-danger">{formError}</p>}

            <button type="button" onClick={handleAdd} disabled={outOfStock || checking} className="btn-primary mt-4 w-full !min-h-[52px] text-base">
              <ShoppingBag className="h-5 w-5" aria-hidden="true" />
              {checking ? 'Checking…' : outOfStock ? 'Out of stock' : needsSelection ? addLabel : `${addLabel} · ${formatCurrency(total)}`}
            </button>
          </div>
        </div>
      </div>

      {customizationStep !== null && currentProduct && (
        <ProductCustomizationModal
          product={currentProduct}
          selectedImageUrl={currentImage}
          onClose={() => { setCustomizationStep(null); setCollected({}); }}
          onCustomizeComplete={handleCustomizationComplete}
        />
      )}
    </div>
  );
};

export default ComboPage;
