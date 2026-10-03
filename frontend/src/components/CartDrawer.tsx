import React from 'react';
import { Link } from 'react-router-dom';
import { Minus, Plus, ShoppingBag, X } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { getImageUrl } from '../utils/helpers';
import { formatCurrency, lineTotal } from '../utils/money';
import { useServerQuote } from '../hooks/useServerQuote';
import { friendlyError } from '../utils/errors';
import { Modal } from './ui/Modal';
import { Badge } from './ui/Badge';
import { EmptyState } from './ui/States';
import { ButtonLink } from './ui/Button';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const CartDrawer: React.FC<CartDrawerProps> = ({ isOpen, onClose }) => {
  const { items, removeItem, updateQuantity, total, clearCart } = useCart();
  const count = items.reduce((n, i) => n + i.quantity, 0);
  // Shipping / fees / total come from the server's own pricing of this cart (never computed here).
  const { online, cod, loading: quoting, error: quoteError } = useServerQuote(items, { enabled: isOpen });
  const baseName = (item: (typeof items)[number]) => (item.selected_options?.length ? item.name.replace(/\s*\([^)]*\)\s*$/, '') : item.name);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Your cart${count ? ` (${count})` : ''}`} placement="right">
      {items.length === 0 ? (
        <div className="p-6">
          <EmptyState
            icon={<ShoppingBag className="h-10 w-10" aria-hidden="true" />}
            title="Your cart is empty"
            description="Add something you like and it will show up here."
            action={<ButtonLink to="/products" onClick={onClose}>Browse products</ButtonLink>}
          />
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <ul className="flex-1 space-y-4 p-5">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl border border-brand-line p-3">
                <div className="flex gap-3">
                  <img src={getImageUrl(item.image_url)} alt={item.name} className="h-16 w-16 shrink-0 rounded-lg bg-brand-subtle object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm font-semibold">{baseName(item)}</p>
                      <button type="button" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name}`} className="-mr-1 -mt-1 rounded-lg p-1.5 text-brand-muted hover:bg-brand-subtle hover:text-brand-danger">
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>

                    {item.selected_options && item.selected_options.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs text-brand-muted" aria-label="Selected options">
                        {item.selected_options.map((o) => (
                          <li key={o.value_id} className="flex items-center gap-1.5">
                            {item.color_code && o.name === item.color_name && <span className="h-3 w-3 rounded-full border border-brand-line" style={{ backgroundColor: item.color_code }} aria-hidden="true" />}
                            <span>{o.group_name}: <span className="font-medium text-brand-ink">{o.name}</span></span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {item.type === 'combo' && <Badge tone="accent">Combo</Badge>}
                      {(item.customization?.text_lines?.length || item.customization?.image_urls?.length) ? (
                        <Badge tone="accent">Personalised{item.customization?.text_lines?.length ? ` · ${item.customization.text_lines.length} ${item.customization.text_lines.length === 1 ? 'line' : 'lines'}` : ''}{item.customization?.image_urls?.length ? ` · ${item.customization.image_urls.length} ${item.customization.image_urls.length === 1 ? 'image' : 'images'}` : ''}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-brand-muted">{formatCurrency(item.price)} each</p>

                    <div className="mt-2 flex items-center justify-between">
                      <div className="inline-flex items-center rounded-lg border border-brand-line">
                        <button type="button" onClick={() => updateQuantity(item.id, item.quantity - 1)} aria-label={`Decrease quantity of ${item.name}`} className="flex h-9 w-9 items-center justify-center hover:bg-brand-subtle">
                          <Minus className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <span className="w-8 text-center text-sm font-semibold" aria-live="polite">{item.quantity}</span>
                        <button type="button" onClick={() => updateQuantity(item.id, item.quantity + 1)} aria-label={`Increase quantity of ${item.name}`} className="flex h-9 w-9 items-center justify-center hover:bg-brand-subtle">
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                      <p className="text-sm font-bold">{formatCurrency(lineTotal(item.price, item.quantity))}</p>
                    </div>
                  </div>
                </div>

                {item.type === 'combo' && (item as any).combo_products && (
                  <div className="mt-3 border-t border-brand-line pt-3">
                    <p className="mb-2 text-xs font-semibold text-brand-muted">Includes</p>
                    <ul className="space-y-2">
                      {(item as any).combo_products.map((cp: any, idx: number) => (
                        <li key={idx} className="flex items-center gap-2 text-xs">
                          <img src={getImageUrl(cp.image_url)} alt="" className="h-8 w-8 rounded bg-brand-subtle object-cover" />
                          <span className="flex-1 font-medium">{cp.name} <span className="text-brand-muted">× {cp.quantity}</span></span>
                          <span className="text-brand-muted">{formatCurrency(lineTotal(cp.price, cp.quantity))}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="sticky bottom-0 space-y-3 border-t border-brand-line bg-white p-5">
            <dl className="space-y-1.5 text-sm" aria-live="polite" aria-busy={quoting}>
              <div className="flex justify-between"><dt className="text-brand-muted">Subtotal</dt><dd>{formatCurrency(online?.subtotal ?? total)}</dd></div>
              {online && <div className="flex justify-between"><dt className="text-brand-muted">Shipping</dt><dd>{online.shipping_charge > 0 ? formatCurrency(online.shipping_charge) : 'Free'}</dd></div>}
              {online && online.coupon_discount > 0 && <div className="flex justify-between"><dt className="text-brand-muted">Discount</dt><dd>-{formatCurrency(online.coupon_discount)}</dd></div>}
              {online && <div className="flex justify-between border-t border-brand-line pt-2 text-base font-bold"><dt>Total</dt><dd>{formatCurrency(online.total_amount)}</dd></div>}
              {!online && <div className="flex justify-between border-t border-brand-line pt-2 text-base font-bold"><dt>Subtotal</dt><dd>{quoting ? 'Calculating…' : formatCurrency(total)}</dd></div>}
            </dl>
            {cod && cod.cod_charge > 0 && <p className="text-xs text-brand-muted">Cash on delivery adds {formatCurrency(cod.cod_charge)} at checkout.</p>}
            {quoteError && !quoting && <p role="alert" className="rounded-lg bg-brand-accent-soft p-2 text-xs text-brand-accent-ink">{friendlyError(quoteError, 'We could not calculate shipping just now. It will be shown at checkout.')}</p>}
            <p className="text-xs text-brand-muted">Coupons and the final total are confirmed at checkout.</p>
            <div className="flex gap-3">
              <button type="button" onClick={clearCart} className="btn-secondary flex-1">Clear all</button>
              <Link to="/checkout" onClick={onClose} className="btn-primary flex-1">Checkout now</Link>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default CartDrawer;
