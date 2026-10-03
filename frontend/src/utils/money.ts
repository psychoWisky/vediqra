import { formatCurrency } from './helpers';

// Prices come from the API as numbers or numeric strings. All display arithmetic goes through paise (integers) so
// sums such as 600 + 0.1 + 0.2 never show artefacts like 600.30000000000001, and "600" + 90 is never string-concatenated.
export const toPaise = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const fromPaise = (p: number): number => p / 100;

/** Sum of amounts (rupees) computed in paise. */
export const sumMoney = (...values: unknown[]): number => fromPaise(values.reduce<number>((s, v) => s + toPaise(v), 0));

/** Line total: unit price x quantity, in paise arithmetic. */
export const lineTotal = (unit: unknown, qty: number): number => fromPaise(toPaise(unit) * Math.max(0, Math.floor(qty)));

/** "+₹120" / "-₹20" for price modifiers (nothing for 0). */
export const formatModifier = (v: unknown): string => {
  const p = toPaise(v);
  if (p === 0) return '';
  return `${p > 0 ? '+' : '-'}${formatCurrency(Math.abs(fromPaise(p)))}`;
};

export { formatCurrency };
