import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Lock, ShoppingBag, Tag, X } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { CartItem } from '../types';
import { CONFIG } from '../config';
import { BRAND } from '../config/brand';
import { apiFetch } from '../utils/api';
import { getImageUrl } from '../utils/helpers';
import { formatCurrency, lineTotal } from '../utils/money';
import { friendlyError } from '../utils/errors';
import { toPricingItems, useServerQuote } from '../hooks/useServerQuote';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/States';
import { ButtonLink } from '../components/ui/Button';

declare global {
  interface Window { Razorpay: any }
}

type Method = 'online' | 'cod';
type FormData = { name: string; email: string; phone: string; address: string; city: string; state: string; pincode: string; special_requests: string };

const FIELD_ORDER: (keyof FormData)[] = ['name', 'email', 'phone', 'address', 'city', 'state', 'pincode'];

const baseName = (item: CartItem) => (item.selected_options?.length ? item.name.replace(/\s*\([^)]*\)\s*$/, '') : item.name);

/** Labelled form field with an inline error linked through aria-describedby. */
const Field: React.FC<{
  id: string; label: string; error?: string; required?: boolean; hint?: string; children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => React.ReactNode;
}> = ({ id, label, error, required = true, hint, children }) => {
  const describedBy = [error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}{required ? <span aria-hidden="true" className="text-brand-danger"> *</span> : <span className="font-normal text-brand-muted"> (optional)</span>}</label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-brand-muted">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="mt-1 text-sm font-medium text-brand-danger">{error}</p>}
    </div>
  );
};

const Checkout: React.FC = () => {
  const { items, total, clearCart } = useCart();
  const navigate = useNavigate();

  const [method, setMethod] = useState<Method>('online');
  const [form, setForm] = useState<FormData>({ name: '', email: '', phone: '', address: '', city: '', state: '', pincode: '', special_requests: '' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormData, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [orderError, setOrderError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  // coupon
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<any>(null);
  const [couponLoading, setCouponLoading] = useState(false);
  const [couponError, setCouponError] = useState('');

  const onlyCombos = items.length > 0 && items.every((i) => i.type === 'combo');
  const { cod, online, loading: quoting, error: quoteError } = useServerQuote(items, { couponCode: coupon?.code, email: form.email });
  const quote = method === 'cod' ? cod : online;

  // A coupon that stops being valid for the cart (limit reached, minimum no longer met ...) is dropped with the server's reason.
  useEffect(() => {
    if (coupon && quoteError && !quoting) {
      setCouponError(friendlyError(quoteError, 'This coupon can no longer be applied.'));
      setCoupon(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteError, quoting]);

  const setField = (name: keyof FormData, value: string) => {
    setForm((f) => ({ ...f, [name]: value }));
    if (fieldErrors[name]) setFieldErrors((e) => ({ ...e, [name]: undefined }));
  };

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormData, string>> = {};
    if (!form.name.trim()) e.name = 'Please enter your full name.';
    if (!form.email.trim()) e.email = 'Please enter your email address.';
    else if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = 'Please enter a valid email address, like name@example.com.';
    if (!form.phone.trim()) e.phone = 'Please enter your phone number.';
    else if (!/^\d{10}$/.test(form.phone.replace(/\D/g, ''))) e.phone = 'Please enter a 10-digit mobile number.';
    if (!form.address.trim()) e.address = 'Please enter your address.';
    if (!form.city.trim()) e.city = 'Please enter your city.';
    if (!form.state.trim()) e.state = 'Please enter your state.';
    if (!form.pincode.trim()) e.pincode = 'Please enter your pincode.';
    else if (!/^\d{6}$/.test(form.pincode.replace(/\D/g, ''))) e.pincode = 'Please enter a 6-digit pincode.';
    setFieldErrors(e);
    const first = FIELD_ORDER.find((k) => e[k]);
    if (first) { const el = document.getElementById(`co-${first}`); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); el?.focus({ preventScroll: true }); }
    return !first;
  };

  /* ---------------------------------------------------------------- coupon (validated by the server) */
  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) { setCouponError('Please enter a coupon code.'); return; }
    if (onlyCombos) { setCouponError('Coupons cannot be applied to combo orders.'); return; }
    setCouponLoading(true);
    setCouponError('');
    try {
      const categories: string[] = [];
      items.forEach((item: any) => {
        if (item.type === 'combo') return;
        (item.categories || []).forEach((c: any) => { if (c.name && !categories.includes(c.name)) categories.push(c.name); });
        if (!item.categories && item.category && !categories.includes(item.category)) categories.push(item.category);
      });
      const nonCombo = items.filter((i) => i.type !== 'combo').reduce((sum, i) => sum + Number(lineTotal(i.price, i.quantity)), 0);
      const data = await apiFetch('/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({ code, subtotal: nonCombo, email: form.email || undefined, categories, hasOnlyComboItems: onlyCombos }),
      });
      if (!data.valid) throw new Error(data.message || 'This coupon is not valid.');
      setCoupon(data.coupon);
      setCouponInput('');
    } catch (e) {
      setCoupon(null);
      setCouponError(friendlyError(e, 'We could not check that coupon. Please try again.'));
    } finally {
      setCouponLoading(false);
    }
  };
  const removeCoupon = () => { setCoupon(null); setCouponError(''); };

  /* ---------------------------------------------------------------- placing the order */
  const fail = (message: string) => {
    setOrderError(message);
    setSubmitting(false);
    setProgress('');
    setTimeout(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };

  const orderId = (r: any): string | null =>
    r?.order?.id || [r?.order_id, r?.orderId, r?.id, r?.data?.order_id, r?.data?.id].find((x) => typeof x === 'string') || null;

  const payload = () => ({
    items: toPricingItems(items),
    coupon_code: coupon?.code || null,
    name: form.name, email: form.email, phone: form.phone,
    address: `${form.address}, ${form.city}, ${form.state} - ${form.pincode}`,
    city: form.city, state: form.state, pincode: form.pincode,
    special_requests: form.special_requests || '',
  });

  const placeCod = async () => {
    setProgress('Placing your order…');
    try {
      const res = await apiFetch('/api/orders/cod', { method: 'POST', body: JSON.stringify({ ...payload(), payment_method: 'cod' }) });
      const id = orderId(res);
      clearCart();
      navigate(id ? `/order-confirmation?orderId=${id}` : '/');
    } catch (e) {
      fail(friendlyError(e, 'We could not place your order. Please try again.'));
    }
  };

  const loadRazorpay = () => new Promise<boolean>((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });

  const placeOnline = async () => {
    setProgress('Preparing secure payment…');
    try {
      if (!(await loadRazorpay())) return fail('The online payment service could not be loaded. Please check your connection, or choose cash on delivery.');
      const p = payload();
      const created = await apiFetch('/api/payment/create-order', { method: 'POST', body: JSON.stringify({ items: p.items, coupon_code: p.coupon_code, email: form.email }) });
      const rzp = new window.Razorpay({
        key: created.key_id || CONFIG.RAZORPAY_KEY_ID,
        amount: created.amount, currency: created.currency, order_id: created.id,
        name: BRAND.name, description: 'Order payment',
        handler: async (res: any) => {
          setProgress('Confirming your payment…');
          try {
            const verified = await apiFetch('/api/payment/verify-payment', {
              method: 'POST',
              body: JSON.stringify({ razorpay_order_id: res.razorpay_order_id, razorpay_payment_id: res.razorpay_payment_id, razorpay_signature: res.razorpay_signature, order_data: { ...p, payment_method: 'online' } }),
            });
            const id = orderId(verified);
            if (verified.success && id) { clearCart(); navigate(`/order-confirmation?orderId=${id}`); }
            else fail('We could not confirm your payment. Please contact us before trying again so you are not charged twice.');
          } catch (e) {
            fail(friendlyError(e, 'We could not confirm your payment. Please contact us before trying again so you are not charged twice.'));
          }
        },
        prefill: { name: form.name, email: form.email, contact: form.phone },
        theme: { color: '#111111' },
        modal: { ondismiss: () => { setSubmitting(false); setProgress(''); } },
      });
      rzp.on?.('payment.failed', () => fail('Your payment did not go through. Please try again, or choose cash on delivery.'));
      rzp.open();
    } catch (e) {
      fail(friendlyError(e, 'We could not start the payment. Please try again.'));
    }
  };

  const placeOrder = async () => {
    if (submitting) return;
    setOrderError('');
    if (!validate()) return;
    setSubmitting(true);
    await (method === 'online' ? placeOnline() : placeCod());
  };

  /* ---------------------------------------------------------------- render */
  if (items.length === 0) {
    return (
      <div className="container-page section">
        <EmptyState icon={<ShoppingBag className="h-10 w-10" aria-hidden="true" />} title="Your cart is empty" description="Add something you like, then come back to check out."
          action={<div className="flex flex-wrap justify-center gap-3"><ButtonLink to="/products">Browse products</ButtonLink><ButtonLink to="/custom-combo" variant="secondary">Build a custom combo</ButtonLink></div>} />
      </div>
    );
  }

  const discount = quote?.coupon_discount ?? 0;
  const inputCls = (name: keyof FormData) => `input ${fieldErrors[name] ? '!border-brand-danger' : ''}`;

  const summary = (
    <div>
      <ul className="max-h-[320px] space-y-4 overflow-y-auto pr-1" aria-label="Items in your order">
        {items.map((item) => (
          <li key={item.id} className="flex gap-3">
            <img src={getImageUrl(item.image_url)} alt="" className="h-16 w-16 shrink-0 rounded-lg bg-brand-subtle object-cover" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold leading-snug">{baseName(item)}</p>
              {item.selected_options && item.selected_options.length > 0 && (
                <p className="mt-0.5 text-xs text-brand-muted">{item.selected_options.map((o) => `${o.group_name}: ${o.name}`).join(' · ')}</p>
              )}
              {(item.customization?.text_lines?.length || item.customization?.image_urls?.length) ? <div className="mt-1"><Badge tone="accent">Personalised</Badge></div> : null}
              <p className="mt-1 text-xs text-brand-muted">Qty {item.quantity} × {formatCurrency(item.price)}</p>
            </div>
            <p className="text-sm font-semibold">{formatCurrency(lineTotal(item.price, item.quantity))}</p>
          </li>
        ))}
      </ul>

      <dl className="mt-5 space-y-2 border-t border-brand-line pt-4 text-sm" aria-live="polite" aria-busy={quoting} data-testid="order-totals">
        <div className="flex justify-between"><dt className="text-brand-muted">Subtotal</dt><dd>{formatCurrency(quote?.subtotal ?? total)}</dd></div>
        <div className="flex justify-between"><dt className="text-brand-muted">Shipping</dt><dd>{quote ? (quote.shipping_charge > 0 ? formatCurrency(quote.shipping_charge) : 'Free') : quoting ? 'Calculating…' : '—'}</dd></div>
        {quote && quote.shipping_charge > 0 && quote.shipping_threshold > 0 && (
          <p className="text-xs text-brand-muted">Free shipping on orders above {formatCurrency(quote.shipping_threshold)}.</p>
        )}
        {method === 'cod' && quote && quote.cod_charge > 0 && <div className="flex justify-between"><dt className="text-brand-muted">Cash on delivery fee</dt><dd>{formatCurrency(quote.cod_charge)}</dd></div>}
        {discount > 0 && <div className="flex justify-between text-brand-success"><dt>Discount{coupon?.code ? ` (${coupon.code})` : ''}</dt><dd>-{formatCurrency(discount)}</dd></div>}
        <div className="flex justify-between border-t border-brand-line pt-3 text-lg font-bold"><dt>Total</dt><dd data-testid="grand-total">{quote ? formatCurrency(quote.total_amount) : quoting ? 'Calculating…' : '—'}</dd></div>
      </dl>
      {quoteError && !quoting && !coupon && (
        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-brand-danger">{friendlyError(quoteError, 'We could not calculate your totals just now. Please try again in a moment.')}</p>
      )}
    </div>
  );

  return (
    <div className="container-page py-8 md:py-12">
      <div className="mb-6">
        <Link to="/products" className="text-sm text-brand-muted hover:text-brand-ink">← Continue shopping</Link>
        <h1 className="mt-2 text-2xl font-bold sm:text-3xl">Checkout</h1>
      </div>

      {/* phones / tablets: the summary is available first, collapsed to the total */}
      <details className="card mb-6 lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between p-4 font-semibold [&::-webkit-details-marker]:hidden">
          <span>Order summary ({items.reduce((n, i) => n + i.quantity, 0)})</span>
          <span>{quote ? formatCurrency(quote.total_amount) : quoting ? 'Calculating…' : ''}</span>
        </summary>
        <div className="border-t border-brand-line p-4">{summary}</div>
      </details>

      <div className="grid gap-8 lg:grid-cols-12">
        <form onSubmit={(e) => { e.preventDefault(); placeOrder(); }} noValidate className="space-y-8 lg:col-span-7">
          <section className="card space-y-4 p-5" aria-labelledby="co-h1">
            <h2 id="co-h1" className="text-lg font-bold">Contact</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field id="co-name" label="Full name" error={fieldErrors.name}>{(p) => <input {...p} className={inputCls('name')} value={form.name} onChange={(e) => setField('name', e.target.value)} autoComplete="name" />}</Field>
              </div>
              <Field id="co-email" label="Email" error={fieldErrors.email} hint="Your order confirmation is sent here.">{(p) => <input {...p} type="email" className={inputCls('email')} value={form.email} onChange={(e) => setField('email', e.target.value)} autoComplete="email" inputMode="email" />}</Field>
              <Field id="co-phone" label="Mobile number" error={fieldErrors.phone} hint="10 digits. You will need it to track your order.">{(p) => <input {...p} type="tel" className={inputCls('phone')} value={form.phone} onChange={(e) => setField('phone', e.target.value)} autoComplete="tel-national" inputMode="numeric" maxLength={10} />}</Field>
            </div>
          </section>

          <section className="card space-y-4 p-5" aria-labelledby="co-h2">
            <h2 id="co-h2" className="text-lg font-bold">Delivery address</h2>
            <Field id="co-address" label="Address" error={fieldErrors.address}>{(p) => <textarea {...p} rows={2} className={inputCls('address')} value={form.address} onChange={(e) => setField('address', e.target.value)} autoComplete="street-address" placeholder="House no, street, area" />}</Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="co-city" label="City" error={fieldErrors.city}>{(p) => <input {...p} className={inputCls('city')} value={form.city} onChange={(e) => setField('city', e.target.value)} autoComplete="address-level2" />}</Field>
              <Field id="co-state" label="State" error={fieldErrors.state}>{(p) => <input {...p} className={inputCls('state')} value={form.state} onChange={(e) => setField('state', e.target.value)} autoComplete="address-level1" />}</Field>
              <Field id="co-pincode" label="Pincode" error={fieldErrors.pincode}>{(p) => <input {...p} className={inputCls('pincode')} value={form.pincode} onChange={(e) => setField('pincode', e.target.value)} autoComplete="postal-code" inputMode="numeric" maxLength={6} />}</Field>
            </div>
            <Field id="co-notes" label="Delivery notes" required={false}>{(p) => <textarea {...p} rows={2} className="input" value={form.special_requests} onChange={(e) => setField('special_requests', e.target.value)} placeholder="Anything we should know about your order or delivery" />}</Field>
          </section>

          <section className="card p-5" aria-labelledby="co-h3">
            <h2 id="co-h3" className="mb-3 flex items-center gap-2 text-lg font-bold"><Tag className="h-4 w-4" aria-hidden="true" /> Coupon</h2>
            {coupon ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-success/40 bg-green-50 p-3" role="status">
                <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-brand-success" aria-hidden="true" /><span><strong>{coupon.code}</strong> applied{discount > 0 ? ` – you save ${formatCurrency(discount)}` : ''}</span></p>
                <button type="button" onClick={removeCoupon} className="btn-ghost btn-sm" aria-label={`Remove coupon ${coupon.code}`}><X className="h-4 w-4" aria-hidden="true" /> Remove</button>
              </div>
            ) : onlyCombos ? (
              <p className="rounded-lg bg-brand-subtle p-3 text-sm text-brand-muted">Coupons cannot be applied to combo orders.</p>
            ) : (
              <div>
                <label htmlFor="co-coupon" className="mb-1.5 block text-sm font-medium">Coupon code</label>
                <div className="flex gap-2">
                  <input id="co-coupon" className="input uppercase" value={couponInput} onChange={(e) => { setCouponInput(e.target.value.toUpperCase()); setCouponError(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } }} placeholder="Enter code" autoComplete="off" aria-describedby={couponError ? 'co-coupon-error' : undefined} aria-invalid={couponError ? true : undefined} />
                  <button type="button" onClick={applyCoupon} disabled={couponLoading} className="btn-secondary shrink-0">{couponLoading ? 'Checking…' : 'Apply'}</button>
                </div>
                {couponError && <p id="co-coupon-error" role="alert" className="mt-2 text-sm font-medium text-brand-danger">{couponError}</p>}
              </div>
            )}
          </section>

          <section className="card p-5" aria-labelledby="co-h4">
            <h2 id="co-h4" className="mb-3 text-lg font-bold">Payment</h2>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-labelledby="co-h4">
              {([
                { value: 'online' as Method, title: 'Pay online', text: 'Cards, UPI and netbanking' },
                { value: 'cod' as Method, title: 'Cash on delivery', text: cod && cod.cod_charge > 0 ? `Pay on delivery. Fee: ${formatCurrency(cod.cod_charge)}` : 'Pay when your order arrives' },
              ]).map((o) => (
                <div key={o.value} className="relative">
                  <input id={`pay-${o.value}`} type="radio" name="payment" value={o.value} checked={method === o.value} onChange={() => setMethod(o.value)} className="peer sr-only" />
                  <label htmlFor={`pay-${o.value}`} className={`flex min-h-[64px] cursor-pointer items-start gap-3 rounded-xl border-2 p-4 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-accent-ink ${method === o.value ? 'border-brand-ink bg-brand-subtle' : 'border-brand-line hover:border-brand-ink/60'}`}>
                    <span aria-hidden="true" className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${method === o.value ? 'border-brand-ink' : 'border-brand-line'}`}>{method === o.value && <span className="h-2.5 w-2.5 rounded-full bg-brand-ink" />}</span>
                    <span><span className="block text-sm font-semibold">{o.title}</span><span className="block text-xs text-brand-muted">{o.text}</span></span>
                  </label>
                </div>
              ))}
            </div>

            <div ref={errorRef} aria-live="assertive">
              {orderError && <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-brand-danger" data-testid="order-error">{orderError}</p>}
            </div>

            <button type="submit" disabled={submitting} className="btn-primary mt-5 w-full !min-h-[52px] text-base" data-testid="place-order">
              {submitting ? (<><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" /> {progress || 'Processing…'}</>) : (<><Lock className="h-4 w-4" aria-hidden="true" /> Place order{quote ? ` · ${formatCurrency(quote.total_amount)}` : ''}</>)}
            </button>
            {method === 'online' && <p className="mt-2 text-center text-xs text-brand-muted">You will be taken to a secure payment window.</p>}
          </section>
        </form>

        <aside className="hidden lg:col-span-5 lg:block" aria-label="Order summary">
          <div className="card sticky top-24 p-5">
            <h2 className="mb-4 text-lg font-bold">Order summary</h2>
            {summary}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default Checkout;
