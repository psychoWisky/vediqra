import { formatCurrency } from './helpers';

/**
 * Budget shortcuts. A band is nothing more than a price filter on the product listing: `/products?min=..&max=..` (the same
 * `min` / `max` URL parameters the listing's own price slider writes), applied to the product's listed price (prices have two decimals, so `.99` upper bounds leave no gap between bands). No product data
 * or promotion is implied. Whether a band has products depends entirely on the catalogue; an empty band shows the listing's
 * normal "no products match" state.
 */
export interface BudgetBand { key: string; label: string; min?: number; max?: number }

export const BUDGET_BANDS: BudgetBand[] = [
  { key: 'u499', label: `Under ${formatCurrency(500)}`, max: 499.99 },
  { key: '500', label: `${formatCurrency(500)} – ${formatCurrency(999)}`, min: 500, max: 999.99 },
  { key: '1000', label: `${formatCurrency(1000)} – ${formatCurrency(1999)}`, min: 1000, max: 1999.99 },
  { key: '2000', label: `${formatCurrency(2000)} & above`, min: 2000 },
];

export const budgetLink = (band: Pick<BudgetBand, 'min' | 'max'>): string => {
  const p = new URLSearchParams();
  if (band.min) p.set('min', String(band.min));
  if (band.max !== undefined) p.set('max', String(band.max));
  return `/products?${p.toString()}`;
};

/** A readable label for an arbitrary min/max (used for the "active filter" chip). */
export const priceFilterLabel = (min: number, max: number | null): string => {
  const band = BUDGET_BANDS.find((b) => (b.min ?? 0) === min && (b.max ?? null) === max);
  if (band) return band.label;
  if (max === null) return `${formatCurrency(min)} & above`;
  return min > 0 ? `${formatCurrency(min)} – ${formatCurrency(max)}` : `Up to ${formatCurrency(max)}`;
};
