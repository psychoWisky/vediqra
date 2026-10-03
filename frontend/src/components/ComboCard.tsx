import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Combo, ComboProduct } from '../types';
import { formatCurrency, getImageUrl } from '../utils/helpers';
import { Badge } from './ui/Badge';

interface ComboCardProps {
  combo: Combo;
  /** Kept for API compatibility with older callers; the whole card is a link to the combo page. */
  onShowMore?: (combo: Combo) => void;
}

/** Combo tile: image, name, item count and the price the customer pays (the admin-set combo price). */
const ComboCard: React.FC<ComboCardProps> = ({ combo }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const items: ComboProduct[] = combo.combo_products || [];
  const originalPrice = items.reduce((sum, item) => sum + (Number(item.product?.price) || 0) * (item.quantity || 1), 0);
  const finalPrice = combo.discount_price != null ? Number(combo.discount_price) : originalPrice;
  const savings = combo.discount_price != null && finalPrice < originalPrice ? originalPrice - finalPrice : 0;
  const savingsPct = Number(combo.discount_percentage) || (savings > 0 ? Math.round((savings / originalPrice) * 100) : 0);
  const itemCount = items.reduce((n, i) => n + (i.quantity || 1), 0);
  const href = `/combo/${combo.id}`;

  return (
    <article className="group flex flex-col">
      <Link to={href} tabIndex={-1} aria-hidden="true" className="relative block overflow-hidden rounded-xl bg-brand-subtle">
        <div className="aspect-[4/5]">
          {!imageLoaded && combo.image_url && <div className="absolute inset-0 animate-pulse bg-brand-line/50" aria-hidden="true" />}
          <img
            src={getImageUrl(combo.image_url)}
            alt=""
            loading="lazy"
            onLoad={() => setImageLoaded(true)}
            onError={(e) => { setImageLoaded(true); if (!e.currentTarget.src.endsWith('/placeholder.svg')) e.currentTarget.src = '/placeholder.svg'; }}
            className="h-full w-full object-cover transition duration-500 md:group-hover:scale-105"
          />
        </div>
        <div className="absolute left-2 top-2 flex flex-col items-start gap-1.5">
          <Badge tone="dark">Combo</Badge>
          {savingsPct > 0 && <Badge tone="danger">Save {savingsPct}%</Badge>}
        </div>
      </Link>
      <div className="flex flex-1 flex-col pt-3">
        <h3 className="text-sm font-semibold leading-snug">
          <Link to={href} className="line-clamp-2 hover:text-brand-accent-ink">{combo.name}</Link>
        </h3>
        {itemCount > 0 && <p className="mt-1 text-xs text-brand-muted">{itemCount} {itemCount === 1 ? 'item' : 'items'}</p>}
        {finalPrice > 0 && (
          <p className="mt-auto flex items-baseline gap-2 pt-2">
            <span className="text-base font-bold">{formatCurrency(finalPrice)}</span>
            {savings > 0 && <span className="text-xs text-brand-muted line-through">{formatCurrency(originalPrice)}</span>}
          </p>
        )}
      </div>
    </article>
  );
};

export default ComboCard;
