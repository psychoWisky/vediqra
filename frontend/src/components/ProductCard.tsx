import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star } from 'lucide-react';
import { Product } from '../types';
import { formatCurrency, getImageUrl } from '../utils/helpers';
import { getExtraGroups } from '../utils/options';
import { Badge } from './ui/Badge';

interface ProductCardProps {
  product: Product;
}

const LOW_STOCK = 5;

/**
 * Product tile used by every listing. Image, name, price and the few signals a shopper needs at a glance
 * (customisable, options, sold out). The whole tile is a real link to /product/<slug or id>.
 * Review numbers arrive with the product list (no per-card request). Only real data is shown: the simulated
 * "people are purchasing" counters are deliberately not displayed.
 */
const ProductCard: React.FC<ProductCardProps> = ({ product }) => {
  const href = `/product/${product.slug || product.id}`;
  const averageRating = Number((product as any).average_rating) || 0;
  const reviewCount = Number((product as any).review_count) || 0;

  const [imageLoaded, setImageLoaded] = useState(false);
  const [selectedColor, setSelectedColor] = useState<string | null>(
    product.has_colors && product.colors?.length ? product.colors.find((c) => c.is_active)?.id || null : null
  );
  const [selectedSize] = useState<string | null>(
    product.has_sizes && product.sizes?.length ? product.sizes.find((s) => s.is_active)?.id || null : null
  );
  const [hovered, setHovered] = useState(false);
  const [imgIdx, setImgIdx] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const color = product.colors?.find((c) => c.id === selectedColor);
  const size = product.sizes?.find((s) => s.id === selectedSize);
  const images = (() => {
    const list: string[] = [];
    if (color?.image_url) { list.push(color.image_url, ...(color.additional_images || [])); }
    else { list.push(product.image_url, ...(product.additional_images || [])); }
    return list.filter(Boolean);
  })();

  // cycle through the extra images while hovering (desktop)
  useEffect(() => {
    if (hovered && images.length > 1) {
      timer.current = setInterval(() => setImgIdx((i) => (i + 1) % images.length), 1600);
    } else if (!hovered) {
      setImgIdx(0);
    }
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [hovered, images.length]);

  const price = (Number(product.price) || 0) + (Number(color?.price_modifier) || 0) + (Number(size?.price_modifier) || 0);
  const original = Number(product.original_price) || 0;
  const activeColors = product.has_colors && product.colors ? product.colors.filter((c) => c.is_active) : [];
  const hasOptions = getExtraGroups(product).length > 0 || (product.has_sizes && (product.sizes?.filter((s) => s.is_active).length || 0) > 0);
  const stock = product.track_stock ? Number(product.stock_quantity) || 0 : null;
  const soldOut = stock !== null && stock <= 0;
  const lowStock = stock !== null && stock > 0 && stock <= LOW_STOCK;
  const currentImage = images[Math.min(imgIdx, Math.max(images.length - 1, 0))];

  return (
    <article className="group flex flex-col" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <Link to={href} tabIndex={-1} aria-hidden="true" className="relative block overflow-hidden rounded-xl bg-brand-subtle">
        <div className="aspect-[4/5]">
          {!imageLoaded && currentImage && <div className="absolute inset-0 animate-pulse bg-brand-line/50" aria-hidden="true" />}
          <img
            src={getImageUrl(currentImage)}
            alt=""
            loading="lazy"
            onLoad={() => setImageLoaded(true)}
            onError={(e) => { setImageLoaded(true); if (!e.currentTarget.src.endsWith('/placeholder.svg')) e.currentTarget.src = '/placeholder.svg'; }}
            className={`h-full w-full object-cover transition duration-500 md:group-hover:scale-105 ${soldOut ? 'opacity-60' : ''}`}
          />
        </div>

        <div className="absolute left-2 top-2 flex flex-col items-start gap-1.5">
          {soldOut && <Badge tone="dark">Sold out</Badge>}
          {!soldOut && product.discount_percentage ? <Badge tone="danger">-{product.discount_percentage}%</Badge> : null}
          {lowStock && <Badge tone="neutral">Only {stock} left</Badge>}
        </div>
        {product.is_customizable && (
          <div className="absolute right-2 top-2"><Badge tone="accent">Personalisable</Badge></div>
        )}
      </Link>

      <div className="flex flex-1 flex-col pt-3">
        {activeColors.length > 1 && (
          <div className="mb-2 flex items-center gap-1.5" role="group" aria-label={`${product.name} colours`}>
            {activeColors.slice(0, 5).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedColor(c.id)}
                aria-label={c.color_name}
                aria-pressed={selectedColor === c.id}
                title={c.color_name}
                className={`h-5 w-5 rounded-full border ${selectedColor === c.id ? 'ring-2 ring-brand-ink ring-offset-1' : 'border-brand-line'}`}
                style={{ backgroundColor: c.color_code || '#ccc' }}
              />
            ))}
            {activeColors.length > 5 && <span className="text-[11px] text-brand-muted">+{activeColors.length - 5}</span>}
          </div>
        )}

        <h3 className="text-sm font-semibold leading-snug">
          <Link to={href} className="line-clamp-2 hover:text-brand-accent-ink">{product.name}{soldOut && <span className="sr-only"> (sold out)</span>}</Link>
        </h3>

        {reviewCount > 0 && (
          <p className="mt-1 flex items-center gap-1 text-xs text-brand-muted">
            <Star className="h-3.5 w-3.5 fill-brand-accent text-brand-accent" aria-hidden="true" />
            <span className="font-medium text-brand-ink">{averageRating.toFixed(1)}</span>
            <span>({reviewCount})</span>
          </p>
        )}

        <div className="mt-auto pt-2">
          {price > 0 && (
            <p className="flex items-baseline gap-2">
              <span className="text-base font-bold">{formatCurrency(price)}</span>
              {original > price && <span className="text-xs text-brand-muted line-through">{formatCurrency(original)}</span>}
            </p>
          )}
          {hasOptions && <p className="mt-0.5 text-xs text-brand-muted">Options available</p>}
        </div>
      </div>
    </article>
  );
};

export default ProductCard;
