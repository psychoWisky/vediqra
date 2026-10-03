import React from 'react';
import { getImageUrl } from '../utils/helpers';
import { formatCurrency, lineTotal } from '../utils/money';
import { Badge } from './ui/Badge';

/**
 * The lines of an order, from the order's own immutable snapshot (what was bought and at what price).
 * Shows product, chosen options, personalisation indicator, quantity and line total. No internal data.
 */
const OrderItems: React.FC<{ items: any[] }> = ({ items }) => {
  if (!Array.isArray(items) || items.length === 0) return <p className="text-sm text-brand-muted">No items to show.</p>;
  return (
    <ul className="divide-y divide-brand-line">
      {items.map((item, i) => {
        const name = item.product_name || item.combo_name || item.name;
        const options: any[] = item.selected_options || [];
        const lines = item.customization?.text_lines?.length || 0;
        const images = item.customization?.image_urls?.length || 0;
        const unit = item.price;
        return (
          <li key={item.id || i} className="flex gap-3 py-4">
            <img src={getImageUrl(item.image_url)} alt="" className="h-16 w-16 shrink-0 rounded-lg bg-brand-subtle object-cover" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold leading-snug">{name}</p>
              {options.length > 0 && <p className="mt-0.5 text-xs text-brand-muted">{options.map((o) => `${o.group_name}: ${o.name}`).join(' · ')}</p>}
              {(lines > 0 || images > 0) && <div className="mt-1"><Badge tone="accent">Personalised{lines ? ` · ${lines} ${lines === 1 ? 'line' : 'lines'}` : ''}{images ? ` · ${images} ${images === 1 ? 'image' : 'images'}` : ''}</Badge></div>}
              {Array.isArray(item.combo_products) && item.combo_products.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-brand-muted">
                  {item.combo_products.map((cp: any, k: number) => (
                    <li key={k}>{cp.product_name || cp.name} × {cp.quantity}{cp.selected_options?.length ? ` (${cp.selected_options.map((o: any) => o.name).join(', ')})` : ''}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-brand-muted">Qty {item.quantity} × {formatCurrency(unit)}</p>
            </div>
            <p className="text-sm font-semibold">{formatCurrency(item.line_total ?? lineTotal(unit, item.quantity))}</p>
          </li>
        );
      })}
    </ul>
  );
};

export default OrderItems;
