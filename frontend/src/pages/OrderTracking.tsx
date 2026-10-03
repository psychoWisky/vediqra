import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, MapPin, Search } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { Order } from '../types';
import { formatCurrency } from '../utils/money';
import { friendlyError } from '../utils/errors';
import OrderItems from '../components/OrderItems';
import SupportContact from '../components/SupportContact';
import { BRAND } from '../config/brand';

// Progress shown to the customer. These are presentations of the EXISTING order statuses, not new statuses:
//   pending / paid -> received, processing -> processing, shipped -> shipped, delivered -> delivered.
const STEPS = [
  { key: 'received', label: 'Order received', statuses: ['pending', 'paid'] },
  { key: 'processing', label: 'Processing', statuses: ['processing'] },
  { key: 'shipped', label: 'Shipped', statuses: ['shipped'] },
  { key: 'delivered', label: 'Delivered', statuses: ['delivered'] },
];
const EXCEPTIONS: Record<string, { title: string; text: string }> = {
  cancelled: { title: 'This order was cancelled', text: 'If you did not expect this, please contact us and quote your order number.' },
  refunded: { title: 'This order has been refunded', text: 'The refund goes back to your original payment method.' },
  partially_refunded: { title: 'Part of this order has been refunded', text: 'The refund goes back to your original payment method.' },
};

const fullAddress = (o: any) => {
  const street = o.shipping_address || '';
  if (o.shipping_pincode && street.includes(o.shipping_pincode)) return street;
  return [street, o.shipping_city, o.shipping_state, o.shipping_pincode].filter(Boolean).join(', ');
};

const OrderTracking: React.FC = () => {
  const [params] = useSearchParams();
  const [orderId, setOrderId] = useState(params.get('order') || '');
  const [phone, setPhone] = useState('');
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => { document.title = `Track your order — ${BRAND.name}`; }, []);

  const track = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderId.trim() || !phone.trim()) { setError('Please enter both your order number and the mobile number used at checkout.'); return; }
    setLoading(true);
    setError('');
    setOrder(null);
    try {
      const data = await apiFetch(`/api/orders/track?orderId=${encodeURIComponent(orderId.trim())}&phone=${encodeURIComponent(phone.trim())}`);
      setOrder(data);
    } catch (err: any) {
      setError(/not found/i.test(String(err?.message))
        ? 'We could not find an order with those details. Please check the order number and mobile number and try again.'
        : friendlyError(err, 'We could not look up your order right now. Please try again in a moment.'));
    } finally {
      setLoading(false);
    }
  };

  const status = (order?.status || 'pending').toLowerCase();
  const stepIndex = STEPS.findIndex((s) => s.statuses.includes(status));
  const exception = EXCEPTIONS[status];
  const number = order ? (order.custom_order_id || order.id) : '';

  return (
    <div className="container-page py-8 md:py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold sm:text-3xl">Track your order</h1>
        <p className="mt-2 text-brand-muted">Enter the order number from your confirmation and the mobile number you used at checkout.</p>

        <form onSubmit={track} className="card mt-6 space-y-4 p-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="tr-order" className="mb-1.5 block text-sm font-medium">Order number</label>
              <input id="tr-order" className="input" value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="Your order number" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="tr-phone" className="mb-1.5 block text-sm font-medium">Mobile number</label>
              <input id="tr-phone" type="tel" inputMode="numeric" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile number" autoComplete="tel-national" maxLength={10} />
            </div>
          </div>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-brand-danger" data-testid="track-error">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? (<><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" /> Looking up…</>) : (<><Search className="h-4 w-4" aria-hidden="true" /> Track order</>)}
          </button>
        </form>

        {order && (
          <section className="mt-8 space-y-6" aria-labelledby="tr-result" data-testid="track-result">
            <div className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 id="tr-result" className="text-sm text-brand-muted">Order number</h2>
                  <p className="flex items-center gap-2 text-xl font-extrabold">
                    <span data-testid="track-number">{number}</span>
                    <button type="button" onClick={() => { navigator.clipboard?.writeText(number); setCopied(true); setTimeout(() => setCopied(false), 2000); }} aria-label="Copy order number" className="btn-ghost btn-sm !px-2"><Copy className="h-4 w-4" aria-hidden="true" /></button>
                  </p>
                  <p className="text-xs text-brand-muted" aria-live="polite">{copied ? 'Copied' : `Placed on ${new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`}</p>
                </div>
                <p className="badge-neutral !px-3 !py-1.5 capitalize" data-testid="track-status">{status.replace('_', ' ')}</p>
              </div>

              {exception ? (
                <div role="status" className="mt-5 rounded-lg bg-brand-subtle p-4">
                  <p className="font-semibold">{exception.title}</p>
                  <p className="mt-1 text-sm text-brand-muted">{exception.text}</p>
                </div>
              ) : (
                <ol className="mt-6 grid grid-cols-4 gap-2" aria-label="Order progress">
                  {STEPS.map((s, i) => {
                    const done = i < stepIndex, current = i === stepIndex;
                    return (
                      <li key={s.key} aria-current={current ? 'step' : undefined} className="text-center">
                        <span className={`mx-auto flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-bold ${done ? 'border-brand-ink bg-brand-ink text-white' : current ? 'border-brand-ink bg-white text-brand-ink' : 'border-brand-line text-brand-muted'}`}>
                          {done ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
                        </span>
                        <span className={`mt-2 block text-xs ${current ? 'font-bold' : 'text-brand-muted'}`}>{s.label}<span className="sr-only">{done ? ' (completed)' : current ? ' (current step)' : ' (not yet)'}</span></span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {order.tracking_number && <p className="mt-5 text-sm"><span className="text-brand-muted">Tracking reference:</span> <span className="font-semibold">{order.tracking_number}</span></p>}
            </div>

            <div className="card p-5">
              <h2 className="text-lg font-bold">Items</h2>
              <OrderItems items={order.items as any[]} />
              <p className="flex justify-between border-t border-brand-line pt-4 text-lg font-bold"><span>Total</span><span>{formatCurrency(order.total_amount)}</span></p>
            </div>

            <div className="card p-5 text-sm">
              <h2 className="mb-2 text-lg font-bold">Delivering to</h2>
              <p className="flex gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-muted" aria-hidden="true" /><span><span className="block font-semibold">{order.customer_name}</span>{fullAddress(order)}</span></p>
            </div>

            <div className="text-center"><p className="mb-2 text-sm font-semibold">Questions about this order?</p><div className="mx-auto inline-block text-left"><SupportContact /></div></div>
          </section>
        )}
      </div>
    </div>
  );
};

export default OrderTracking;
