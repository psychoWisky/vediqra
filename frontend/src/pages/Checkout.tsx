import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, CreditCard, Lock, ShoppingBag, Tag, X } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { CartItem } from '../types';
import { CONFIG } from '../config';
import { BRAND } from '../config/brand';
import { apiFetch } from '../utils/api';
import { getImageUrl } from '../utils/helpers';
import { formatCurrency, fromPaise, lineTotal, toPaise } from '../utils/money';
import { openCart } from '../utils/cartUi';
import { friendlyError } from '../utils/errors';
import { serverLine, toPricingItems, useServerQuote } from '../hooks/useServerQuote';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/States';
import { ButtonLink } from '../components/ui/Button';

declare global {
  interface Window { Razorpay: any }
}

type FormData = { name: string; email: string; phone: string; address: string; city: string; state: string; pincode: string; special_requests: string };

const FIELD_ORDER: (keyof FormData)[] = ['name', 'email', 'phone', 'address', 'city', 'state', 'pincode'];

const baseName = (item: CartItem) => (item.selected_options?.length ? item.name.replace(/\s*\([^)]*\)\s*$/, '') : item.name);

/* ---- What survives a reload / another tab while a payment is not settled --------------------------------------------------
 * Stored: Razorpay order id, the status token (both come from create-order), the idempotency key of the checkout, and - only
 * from the moment the payment widget reports a payment - the payment id and its signature, so the server can be asked to verify
 * it again. No name, address, e-mail, phone, card or UPI detail is ever stored here. The signature only proves a payment to
 * our server (which re-checks it); it is removed as soon as the outcome is final. */
const PENDING_KEY = 'vq_pending_payment';       // localStorage: list of checkouts that may have a payment
const ATTEMPT_KEY = 'vq_checkout_attempt';      // localStorage: identity (idempotency key) of the checkout being filled in
const STATUS_INTERVAL_MS = 3000;
const STATUS_ROUNDS = 20;                        // about a minute of quick checks per visit...
const SLOW_INTERVAL_MS = 20_000;                 // ...then a slow check for as long as the page stays open
const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000;    // the server keeps watching an unpaid checkout for ~8 days (24 h + 7 days)
const ATTEMPT_MAX_AGE_MS = 24 * 3600_000;
const MAX_PENDING = 5;

interface Pending {
  o: string; t: string; at: number;
  proof: boolean;          // the widget reported a payment: money may have been taken
  k?: string;              // idempotency key of the checkout this payment belongs to
  pid?: string; sig?: string;
}
const isPending = (v: any): v is Pending => v && typeof v.o === 'string' && typeof v.t === 'string';
const readPendingList = (): Pending[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];            // the first version stored one object
    return arr.filter(isPending)
      .map((v: any): Pending => ({ o: v.o, t: v.t, at: Number(v.at) || 0, proof: v.proof === true || v.proof === undefined, k: typeof v.k === 'string' ? v.k : undefined, pid: typeof v.pid === 'string' ? v.pid : undefined, sig: typeof v.sig === 'string' ? v.sig : undefined }))
      .filter((v) => Date.now() - v.at <= PENDING_MAX_AGE_MS);
  } catch { return []; }
};
const writePendingList = (list: Pending[]) => {
  try {
    const kept = list.slice(-MAX_PENDING);
    if (kept.length) localStorage.setItem(PENDING_KEY, JSON.stringify(kept)); else localStorage.removeItem(PENDING_KEY);
  } catch { /* storage unavailable */ }
};
const upsertPending = (rec: Pending) => { writePendingList([...readPendingList().filter((r) => r.o !== rec.o), rec]); };
const removePending = (razorpayOrderId: string) => { writePendingList(readPendingList().filter((r) => r.o !== razorpayOrderId)); };
/** A payment attempt failed at the provider: the checkout stays (it can still be paid), but nothing is "possibly paid" any more. */
const downgradePending = (razorpayOrderId: string) => {
  writePendingList(readPendingList().map((r) => (r.o === razorpayOrderId ? { o: r.o, t: r.t, at: r.at, proof: false, k: r.k } : r)));
};

/** Short non-reversible digest of the checkout request, so storage never holds the customer's name, address, e-mail or phone. */
const digest = (text: string): string => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); h3 = Math.imul(h3 ^ c, 2246822519);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1, h2, h3].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('') + text.length.toString(16);
};

interface Attempt { fingerprint: string; key: string; at: number }
const readAttempt = (): Attempt | null => {
  try {
    const v = JSON.parse(localStorage.getItem(ATTEMPT_KEY) || 'null');
    return v && typeof v.key === 'string' && typeof v.fingerprint === 'string' && Date.now() - (Number(v.at) || 0) <= ATTEMPT_MAX_AGE_MS ? v : null;
  } catch { return null; }
};
const writeAttempt = (a: Attempt) => { try { localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); } catch { /* ignore */ } };
const clearAttempt = () => { try { localStorage.removeItem(ATTEMPT_KEY); } catch { /* ignore */ } };

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

  const [form, setForm] = useState<FormData>({ name: '', email: '', phone: '', address: '', city: '', state: '', pincode: '', special_requests: '' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormData, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [orderError, setOrderError] = useState('');
  // A payment that may have been taken but is not confirmed. While this is set nothing new can be paid for: the only ways out are
  // the server reporting a final outcome, or the record ageing out (see PENDING_MAX_AGE_MS). There is deliberately no "start over".
  const [unresolved, setUnresolved] = useState<boolean>(false);
  const [checking, setChecking] = useState(false);
  const [unmatched, setUnmatched] = useState(false);       // the server does not recognise this checkout (404): NOT proof of "unpaid"
  const [reference, setReference] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);        // synchronous guard: two quick clicks cannot start two payments
  const pollRun = useRef(0);             // only the newest status poll may act
  const lastStatus = useRef<'awaiting' | 'unmatched' | 'error' | null>(null);
  // One Idempotency-Key per checkout: repeating the same cart/customer/coupon (a retry after a timeout, a double click, a reload,
  // another tab) reuses it so the server returns the SAME payment instead of starting another; changing anything gets a new key.
  // It is kept (localStorage) until the checkout has a final outcome.
  const attemptRef = useRef<Attempt | null>(readAttempt());

  // coupon
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<any>(null);
  const [couponLoading, setCouponLoading] = useState(false);
  const [couponError, setCouponError] = useState('');

  const onlyCombos = items.length > 0 && items.every((i) => i.type === 'combo');
  // Online payment is the only payment method, so the server's online quote is the quote.
  const { online: quote, loading: quoting, error: quoteError, ready: quoteReady, couponRejected, refresh: refreshQuote } =
    useServerQuote(items, { couponCode: coupon?.code, email: form.email });

  // Only a coupon-specific rejection removes the coupon (the hook proves it by pricing the same cart again without the coupon).
  // A cart problem (sold out, option removed ...) keeps the coupon.
  useEffect(() => {
    if (couponRejected && coupon) {
      setCouponError(friendlyError(couponRejected, 'This coupon can no longer be applied.'));
      setCoupon(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [couponRejected]);

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
    inFlight.current = false;
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

  const endAttempt = () => { attemptRef.current = null; clearAttempt(); };
  const keyFor = (request: string): string => {
    const fingerprint = digest(request);     // only the digest is stored
    if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      attemptRef.current = { fingerprint, key: `co_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`, at: Date.now() };
      writeAttempt(attemptRef.current);
    }
    return attemptRef.current.key;
  };

  /** The checkout in `rec` has a confirmed order. Its record (and signature) are removed; the cart is emptied only if it is the cart that was just paid for. */
  const finishConfirmed = (id: string, rec: Pending) => {
    removePending(rec.o);
    const current = attemptRef.current;
    const sameCart = rec.proof || (!!current && current.key === rec.k);     // a blocked (proof) checkout is always the cart on screen
    if (current && current.key === rec.k) endAttempt();
    if (sameCart) clearCart();
    navigate(`/order-confirmation?orderId=${id}`);
  };
  /** The checkout in `rec` ended without an order (refund / review): the customer has been told; nothing more to wait for. */
  const finishClosed = (rec: Pending, message: string) => {
    removePending(rec.o);
    if (attemptRef.current && attemptRef.current.key === rec.k) endAttempt();
    fail(message);
  };

  /**
   * Ask the server what became of the checkout in `rec` (the status endpoint is fed by the webhook and the recovery job), and -
   * when we hold the payment's id and signature - ask it to verify that payment again (the same idempotent call the widget
   * triggers; the server re-checks the signature and the payment itself). Results:
   *   'confirmed'   the order exists; the customer has been taken to it
   *   'final'       refunded / being refunded / under review: the customer has been told
   *   'failed'      the server says THIS payment attempt failed (HTTP 402, the only reply that proves a payment did not happen);
   *                 the checkout itself stays and can still be paid
   *   'unresolved'  anything else - "awaiting payment", 404 (unknown / wrong token), 5xx, 429, network: NOT evidence that nothing was paid
   * Transient failures never end the wait.
   */
  const pollStatus = async (rec: Pending, rounds: number, firstDelayMs: number, intervalMs: number, verifyOn: (i: number) => boolean): Promise<'confirmed' | 'final' | 'failed' | 'unresolved' | 'superseded'> => {
    const run = ++pollRun.current;
    for (let i = 0; i < rounds; i++) {
      const wait = i === 0 ? firstDelayMs : intervalMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else await Promise.resolve();
      if (run !== pollRun.current) return 'superseded';
      if (rec.proof && rec.pid && rec.sig && verifyOn(i)) {
        try {
          const v = await apiFetch('/api/payment/verify-payment', {
            method: 'POST',
            body: JSON.stringify({ razorpay_order_id: rec.o, razorpay_payment_id: rec.pid, razorpay_signature: rec.sig }),
          });
          const id = orderId(v);
          if (v.success && id) { finishConfirmed(id, rec); return 'confirmed'; }
        } catch (e) {
          if ((e as any)?.status === 402) { downgradePending(rec.o); fail(friendlyError(e, 'Your payment did not go through. Please try again.')); return 'failed'; }
          // anything else (refund/review 409, 400, 5xx, network): not conclusive; the status endpoint below has the final word
        }
        if (run !== pollRun.current) return 'superseded';
      }
      try {
        const s = await apiFetch('/api/payment/status', { method: 'POST', body: JSON.stringify({ razorpay_order_id: rec.o, token: rec.t }) });
        if (s.state === 'confirmed' && s.order_id) { finishConfirmed(s.order_id, rec); return 'confirmed'; }
        if (s.state === 'refund_pending' || s.state === 'refunded' || s.state === 'under_review') { finishClosed(rec, s.message); return 'final'; }
        lastStatus.current = 'awaiting'; setUnmatched(false);
      } catch (e) {
        if ((e as any)?.status === 404) { lastStatus.current = 'unmatched'; setUnmatched(true); } else lastStatus.current = 'error';
      }
    }
    return 'unresolved';
  };

  /** A payment may exist but is not settled: wait on the server, keep everything, and make sure nobody pays again. */
  const resolveUncertain = async (rec: Pending, firstDelayMs: number) => {
    setUnresolved(true);
    setChecking(true);
    setReference([rec.o, rec.pid].filter(Boolean).join(' / '));
    setSubmitting(false);
    setProgress('');
    setOrderError('');
    inFlight.current = false;
    let r = await pollStatus(rec, STATUS_ROUNDS, firstDelayMs, STATUS_INTERVAL_MS, (i) => i % 5 === 1);
    if (r === 'unresolved') r = await pollStatus(rec, 100_000, SLOW_INTERVAL_MS, SLOW_INTERVAL_MS, (i) => i % 9 === 4);   // slow, for as long as the page is open
    if (r === 'superseded') return;                 // a newer check (or leaving the page) took over
    setChecking(false);
    if (r === 'confirmed' || r === 'final' || r === 'failed') setUnresolved(false);
  };

  // Coming back to checkout (reload, closed tab, another tab, another day): pick the payment up again. A payment with proof keeps
  // being checked (and blocks ordering); a checkout that was only started gets one look, because the customer may have paid and
  // closed the tab - its record is kept until the server reports a final outcome or it ages out.
  useEffect(() => {
    const list = readPendingList();
    writePendingList(list);                                         // drops expired records
    const proofRec = list.find((r) => r.proof);
    if (proofRec) { void resolveUncertain(proofRec, 0); return; }
    const started = list.filter((r) => !r.proof);
    if (started.length) void (async () => { for (const rec of started) { if ((await pollStatus(rec, 1, 0, 0, () => false)) !== 'unresolved') return; } })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { pollRun.current++; }, []);

  const checkAgain = () => { const rec = readPendingList().find((r) => r.proof); if (rec) void resolveUncertain(rec, 0); };

  const loadRazorpay = () => new Promise<boolean>((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });

  /** create-order said 409: this checkout (idempotency key) has ended. Find out HOW before anything else is allowed. */
  const handleClosedCheckout = async () => {
    const att = attemptRef.current;
    const rec = att ? readPendingList().find((r) => r.k === att.key) : undefined;
    if (!rec) { endAttempt(); return fail('This checkout has already ended. Please review your cart and try again.'); }
    lastStatus.current = null;
    const r = await pollStatus(rec, 1, 0, 0, () => false);
    if (r === 'confirmed' || r === 'final') return;                 // taken to the order / told what happened
    if (lastStatus.current === 'awaiting') {
      // The server closed the checkout and reports no payment seen. The record stays (a late payment is still honoured and will be
      // found on a later visit); only the key is retired.
      endAttempt();
      return fail('Your earlier checkout expired without a payment. Please try again.');
    }
    // Could not find out (404, network ...): keep the key and the record; do not let a different payment start.
    fail('We could not confirm what happened to your earlier checkout. Please try again in a moment. If you were charged, please do not pay again.');
  };

  const placeOnline = async () => {
    setProgress('Preparing secure payment…');
    try {
      if (!(await loadRazorpay())) return fail('The online payment service could not be loaded. Please check your connection and try again.');
      const p = payload();
      const key = keyFor(JSON.stringify(p));
      const created = await apiFetch('/api/payment/create-order', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify(p),
      });
      // Remembered from the moment a payment exists, before the customer can pay, so a closed tab or a lost reply is recoverable.
      if (created.status_token) upsertPending({ o: created.id, t: created.status_token, at: Date.now(), proof: false, k: key });
      const rzp = new window.Razorpay({
        key: created.key_id || CONFIG.RAZORPAY_KEY_ID,
        amount: created.amount, currency: created.currency, order_id: created.id,
        name: BRAND.name, description: 'Order payment',
        handler: async (res: any) => {
          // From here on money may have been taken: record that (with the payment id + signature, so verification can be repeated)
          // BEFORE asking the server, so whatever happens next - network failure, closed tab, reload - the checkout is resumed and
          // no second payment is started.
          const rec: Pending = { o: created.id, t: created.status_token, at: Date.now(), proof: true, k: key, pid: res.razorpay_payment_id, sig: res.razorpay_signature };
          if (created.status_token) upsertPending(rec);
          setProgress('Confirming your payment…');
          try {
            const verified = await apiFetch('/api/payment/verify-payment', {
              method: 'POST',
              body: JSON.stringify({ razorpay_order_id: res.razorpay_order_id, razorpay_payment_id: res.razorpay_payment_id, razorpay_signature: res.razorpay_signature }),
            });
            const id = orderId(verified);
            if (verified.success && id) { finishConfirmed(id, rec); return; }
            // 'pending' (202) or any reply without an order: the payment is not settled yet.
            await resolveUncertain(rec, STATUS_INTERVAL_MS);
          } catch (e) {
            // 402 is the one reply that proves THIS payment attempt failed (nothing was charged); the checkout can still be paid.
            if ((e as any)?.status === 402) { downgradePending(rec.o); fail(friendlyError(e, 'Your payment did not go through. Please try again.')); return; }
            // Every other failure (400, 409, 5xx, 429, network ...) leaves the payment unresolved.
            await resolveUncertain(rec, STATUS_INTERVAL_MS);
          }
        },
        prefill: { name: form.name, email: form.email, contact: form.phone },
        theme: { color: '#111111' },
        modal: { ondismiss: () => { setSubmitting(false); setProgress(''); inFlight.current = false; } },
      });
      rzp.on?.('payment.failed', () => fail('Your payment did not go through. Please try again.'));
      rzp.open();
    } catch (e) {
      if ((e as any)?.status === 409) return handleClosedCheckout();
      fail(friendlyError(e, 'We could not start the payment. Please try again.'));
    }
  };

  const placeOrder = async () => {
    if (inFlight.current || submitting || unresolved) return;
    // Another tab may hold a payment that is not settled: the stored record, not just this page's state, decides.
    const open = readPendingList().find((r) => r.proof);
    if (open) { void resolveUncertain(open, 0); return; }
    // Nothing is paid for until the server has priced exactly what is on screen.
    if (!quoteReady || priceMismatch) return;
    inFlight.current = true;
    setOrderError('');
    if (!validate()) { inFlight.current = false; return; }
    setSubmitting(true);
    await placeOnline();
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

  // Line prices come from the server's quote. A cart line saved days ago can carry an old price; the customer sees the current
  // one (and is told) instead of lines that do not add up to the subtotal.
  const srvLines = items.map((item, i) => serverLine(quote, item, i));
  const pricesChanged = quoteReady && items.some((item, i) => { const l = srvLines[i]; return !!l && toPaise(l.price) !== toPaise(item.price); });
  // If some line cannot be matched to the quote and the saved prices do not add up to the server's subtotal, the screen cannot
  // be trusted: ordering is blocked until the quote is refreshed or the cart is edited.
  const priceMismatch = quoteReady && !!quote && items.some((_, i) => !srvLines[i]) && toPaise(total) !== toPaise(quote.subtotal);
  const blockReason = unresolved ? '' : quoting ? 'Updating your total…' : quoteError ? '' : priceMismatch ? 'Please review your cart: the prices have changed.' : '';
  const inputCls = (name: keyof FormData) => `input ${fieldErrors[name] ? '!border-brand-danger' : ''}`;

  const summary = (
    <div>
      <ul className="max-h-[320px] space-y-4 overflow-y-auto pr-1" aria-label="Items in your order">
        {items.map((item, idx) => (
          <li key={item.id} className="flex gap-3">
            <img src={getImageUrl(item.image_url)} alt="" className="h-16 w-16 shrink-0 rounded-lg bg-brand-subtle object-cover" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold leading-snug">{baseName(item)}</p>
              {item.selected_options && item.selected_options.length > 0 && (
                <p className="mt-0.5 text-xs text-brand-muted">{item.selected_options.map((o) => `${o.group_name}: ${o.name}`).join(' · ')}</p>
              )}
              {(item.customization?.text_lines?.length || item.customization?.image_urls?.length) ? <div className="mt-1"><Badge tone="accent">Personalised</Badge></div> : null}
              <p className="mt-1 text-xs text-brand-muted">Qty {item.quantity} × {formatCurrency(srvLines[idx]?.price ?? item.price)}</p>
            </div>
            <p className="text-sm font-semibold">{formatCurrency(srvLines[idx]?.total ?? lineTotal(item.price, item.quantity))}</p>
          </li>
        ))}
      </ul>

      {pricesChanged && <p role="status" data-testid="prices-changed" className="mt-4 rounded-lg bg-brand-accent-soft p-3 text-xs font-medium text-brand-accent-ink">Some prices have changed since you added these items. The prices shown are the current ones.</p>}

      <dl className="mt-5 space-y-2 border-t border-brand-line pt-4 text-sm" aria-live="polite" aria-busy={quoting} data-testid="order-totals">
        <div className="flex justify-between"><dt className="text-brand-muted">Subtotal</dt><dd>{formatCurrency(quote?.subtotal ?? total)}</dd></div>
        <div className="flex justify-between"><dt className="text-brand-muted">Shipping</dt><dd>{quote ? (quote.shipping_charge > 0 ? formatCurrency(quote.shipping_charge) : 'Free') : quoting ? 'Calculating…' : '—'}</dd></div>
        {quote && quote.shipping_charge > 0 && quote.shipping_threshold > 0 && (
          <p className="text-xs text-brand-muted">Free shipping on orders above {formatCurrency(quote.shipping_threshold)}.</p>
        )}
        {discount > 0 && <div className="flex justify-between text-brand-success"><dt>Discount{coupon?.code ? ` (${coupon.code})` : ''}</dt><dd>-{formatCurrency(discount)}</dd></div>}
        <div className="flex items-baseline justify-between border-t border-brand-line pt-4 font-display text-xl font-semibold"><dt>Total</dt><dd data-testid="grand-total">{quote ? formatCurrency(quote.total_amount) : quoting ? 'Calculating…' : '—'}</dd></div>
      </dl>
      {quoteError && !quoting && (
        <div role="alert" data-testid="quote-error" className="mt-3 rounded-lg border border-brand-danger/40 bg-brand-danger/10 p-3 text-sm font-medium text-brand-danger">
          <p>{friendlyError(quoteError, 'We could not calculate your totals just now. Please try again in a moment.')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={openCart} className="btn-secondary btn-sm">Edit cart</button>
            <button type="button" onClick={refreshQuote} className="btn-ghost btn-sm">Try again</button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="container-page py-10 md:py-16">
      <div className="mb-6">
        <Link to="/products" className="text-sm text-brand-muted hover:text-brand-ink">← Continue shopping</Link>
        <h1 className="mt-4 text-4xl font-semibold sm:text-5xl">Checkout</h1>
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
          <section className="card space-y-5 p-6 md:p-8" aria-labelledby="co-h1">
            <h2 id="co-h1" className="font-display text-xl font-semibold">Contact</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field id="co-name" label="Full name" error={fieldErrors.name}>{(p) => <input {...p} className={inputCls('name')} value={form.name} onChange={(e) => setField('name', e.target.value)} autoComplete="name" />}</Field>
              </div>
              <Field id="co-email" label="Email" error={fieldErrors.email} hint="Your order confirmation is sent here.">{(p) => <input {...p} type="email" className={inputCls('email')} value={form.email} onChange={(e) => setField('email', e.target.value)} autoComplete="email" inputMode="email" />}</Field>
              <Field id="co-phone" label="Mobile number" error={fieldErrors.phone} hint="10 digits. You will need it to track your order.">{(p) => <input {...p} type="tel" className={inputCls('phone')} value={form.phone} onChange={(e) => setField('phone', e.target.value)} autoComplete="tel-national" inputMode="numeric" maxLength={10} />}</Field>
            </div>
          </section>

          <section className="card space-y-5 p-6 md:p-8" aria-labelledby="co-h2">
            <h2 id="co-h2" className="font-display text-xl font-semibold">Delivery address</h2>
            <Field id="co-address" label="Address" error={fieldErrors.address}>{(p) => <textarea {...p} rows={2} className={inputCls('address')} value={form.address} onChange={(e) => setField('address', e.target.value)} autoComplete="street-address" placeholder="House no, street, area" />}</Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="co-city" label="City" error={fieldErrors.city}>{(p) => <input {...p} className={inputCls('city')} value={form.city} onChange={(e) => setField('city', e.target.value)} autoComplete="address-level2" />}</Field>
              <Field id="co-state" label="State" error={fieldErrors.state}>{(p) => <input {...p} className={inputCls('state')} value={form.state} onChange={(e) => setField('state', e.target.value)} autoComplete="address-level1" />}</Field>
              <Field id="co-pincode" label="Pincode" error={fieldErrors.pincode}>{(p) => <input {...p} className={inputCls('pincode')} value={form.pincode} onChange={(e) => setField('pincode', e.target.value)} autoComplete="postal-code" inputMode="numeric" maxLength={6} />}</Field>
            </div>
            <Field id="co-notes" label="Delivery notes" required={false}>{(p) => <textarea {...p} rows={2} className="input" value={form.special_requests} onChange={(e) => setField('special_requests', e.target.value)} placeholder="Anything we should know about your order or delivery" />}</Field>
          </section>

          <section className="card p-6 md:p-8" aria-labelledby="co-h3">
            <h2 id="co-h3" className="mb-3 flex items-center gap-2 font-display text-xl font-semibold"><Tag className="h-4 w-4" aria-hidden="true" /> Coupon</h2>
            {coupon ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-success/40 bg-brand-success/10 p-3" role="status">
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

          <section className="card p-6 md:p-8" aria-labelledby="co-h4">
            <h2 id="co-h4" className="mb-3 font-display text-xl font-semibold">Payment</h2>
            <div className="flex items-start gap-3 rounded-sm border border-brand-accent bg-brand-accent/10 p-4" data-testid="payment-online-only">
              <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-brand-accent-ink" aria-hidden="true" />
              <p><span className="block text-sm font-semibold">Pay online</span><span className="block text-xs text-brand-muted">UPI and debit or credit cards, through a secure payment window.</span></p>
            </div>

            {unresolved && (
              <div role="status" data-testid="payment-unresolved" className="mt-5 rounded-lg border border-brand-accent/60 bg-brand-accent-soft p-4 text-sm text-brand-ink">
                <p className="font-semibold">{unmatched ? 'We could not match your payment to your checkout yet.' : checking ? 'We are confirming your payment…' : 'We are still waiting to confirm your payment.'}</p>
                <p className="mt-1">Your payment may already have gone through. <strong>Please do not pay again.</strong> Your order is confirmed automatically once the payment is verified, and we will email you. You do not need to stay on this page; this page will keep checking while it is open.</p>
                {reference && <p className="mt-1 text-xs text-brand-muted">Payment reference: <span className="font-mono">{reference}</span></p>}
                {(BRAND.supportEmail || BRAND.supportPhone) && <p className="mt-1 text-xs text-brand-muted">If you were charged and this does not clear, contact us{BRAND.supportPhone ? ` on ${BRAND.supportPhone}` : ''}{BRAND.supportEmail ? ` or ${BRAND.supportEmail}` : ''} with the reference above.</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={checkAgain} className="btn-secondary btn-sm" data-testid="check-again">Check again</button>
                </div>
              </div>
            )}

            <div ref={errorRef} aria-live="assertive">
              {orderError && <p role="alert" className="mt-5 rounded-lg border border-brand-danger/40 bg-brand-danger/10 p-3 text-sm font-medium text-brand-danger" data-testid="order-error">{orderError}</p>}
            </div>

            <button type="submit" disabled={submitting || unresolved || !quoteReady || priceMismatch} className="btn-primary mt-5 w-full !min-h-[52px] text-base" data-testid="place-order">
              {submitting ? (<><span className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden="true" /> {progress || 'Processing…'}</>) : (<><Lock className="h-4 w-4" aria-hidden="true" /> Place order{quote ? ` · ${formatCurrency(quote.total_amount)}` : ''}</>)}
            </button>
            {(blockReason || (quoteError && !quoting)) && (
              <p className="mt-2 text-center text-xs font-medium text-brand-danger" data-testid="place-order-blocked">{blockReason || 'Fix the items in your cart (or try again) before you can place your order.'}</p>
            )}
            <p className="mt-2 text-center text-xs text-brand-muted">You will be taken to a secure payment window. Your order is confirmed only after the payment is verified.</p>
          </section>
        </form>

        <aside className="hidden lg:col-span-5 lg:block" aria-label="Order summary">
          <div className="card sticky top-24 p-5">
            <h2 className="mb-5 font-display text-xl font-semibold">Order summary</h2>
            {summary}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default Checkout;
