/**
 * Authoritative pricing for carts and orders.
 *
 * The storefront sends WHAT the customer wants (product ids, chosen colour/size ids, quantities,
 * customization content, coupon code). Every price, discount, shipping and COD amount is derived
 * here from database rows. Nothing monetary from the request body is trusted.
 *
 * Pricing rules:
 *   product line  = product.price + SUM(selected option price_modifiers)
 *                   + product.customization_price (when the product is customizable)
 *   fixed combo   = combo.discount_price (or the sum of its products' base prices x quantity)
 *                   + the selected options' modifiers on its member products
 *   custom combo  = sum((price + customization_price + options) x qty) less a tier discount by total item count
 *   coupon        = applies to non-combo lines only
 *   shipping/COD  = server configuration (config.ts)
 *
 * Options: the request lists selected option VALUE ids. Each must belong to the product, be active, and no
 * group may be chosen twice; every required, active group must be chosen. Old carts that still carry
 * color_id / size_id (pre-options ids) are translated to the migrated option values.
 */
import config from '../config';
import { isUuid } from '../utils/sql';
import { loadProductOptions, ProductOptionGroup, OptionValue } from './options';

export class PricingError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** 409: not enough stock. Thrown by the soft check while pricing and by the atomic decrement when the order is saved. */
export class StockError extends PricingError {
  constructor(message: string) {
    super(message, 409);
  }
}

export interface Queryable {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
}

export type PaymentMethod = 'cod' | 'online';

export interface AppliedCoupon {
  id: string;
  code: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  discount_amount: number;
}

// What an order takes from stock (aggregated over all lines, combo members included).
export interface StockDemand {
  products: { id: string; name: string; qty: number }[];   // only products with track_stock = true
  values: { id: string; label: string; qty: number }[];    // option values (untracked ones, stock NULL, are ignored on decrement)
}

export interface CartQuote {
  stock: StockDemand;
  items: any[];                 // canonical items to store on the order (server prices)
  subtotal: number;
  coupon: AppliedCoupon | null;
  coupon_discount: number;
  shipping_charge: number;
  cod_charge: number;           // applied to THIS quote's total: config.codFee if paymentMethod is 'cod', else 0
  total_amount: number;
  // Configured checkout rules, echoed back so the frontend never keeps its own copy of business values.
  // Unlike cod_charge these are constants, independent of which paymentMethod this quote was made for.
  shipping_threshold: number;
  shipping_fee: number;
  cod_fee: number;
}

// Custom combo discount tiers by total item count. Keep in sync with frontend/src/pages/CustomCombo.tsx.
const CUSTOM_COMBO_TIERS = [
  { minItems: 0, maxItems: 2, discount: 0 },
  { minItems: 3, maxItems: 4, discount: 10 },
  { minItems: 5, maxItems: 5, discount: 15 },
  { minItems: 6, maxItems: 9, discount: 25 },
  { minItems: 10, maxItems: 10, discount: 30 },
];

const MAX_CART_LINES = 50;
const MAX_QUANTITY = 999;
const UUID_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const COMBO_ID = /^combo-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function quantityOf(value: unknown, what: string): number {
  const q = Number(value);
  if (!Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
    throw new PricingError(`Invalid quantity for ${what}`);
  }
  return q;
}

const shortString = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;

const safeImage = (candidate: unknown, fallback: string): string => {
  const s = shortString(candidate, 2048);
  return s && /^https?:\/\//i.test(s) ? s : fallback;
};

/** Keep customization CONTENT only (text + uploaded image URLs); drop previews/unknown keys. */
function sanitizeCustomization(raw: any) {
  if (!raw || typeof raw !== 'object') return undefined;
  const strings = (arr: unknown, max: number, len: number): string[] | undefined => {
    if (!Array.isArray(arr)) return undefined;
    const out = arr.filter((v) => typeof v === 'string' && v.trim()).slice(0, max).map((v: string) => v.slice(0, len));
    return out.length ? out : undefined;
  };
  const text_lines = strings(raw.text_lines, 20, 500);
  const image_urls = strings(raw.image_urls, 20, 2048);
  const image_paths = strings(raw.image_paths, 20, 2048);
  if (!text_lines && !image_urls && !image_paths) return undefined;
  return { text_lines, image_urls, image_paths };
}

/**
 * Customization content for a customizable product, checked against the product's limits.
 * Non-customizable products ignore any customization sent.
 */
function checkCustomization(product: any, raw: any, required: boolean) {
  if (!product.is_customizable) return undefined;
  const content = sanitizeCustomization(raw);
  const maxLines = Number(product.max_customization_lines) || 0;
  const maxChars = Number(product.max_customization_characters) || 0;
  const maxImages = Number(product.max_customization_images) || 0;

  if (content?.text_lines) {
    if (maxLines === 0) throw new PricingError(`Custom text is not available for "${product.name}".`);
    if (content.text_lines.length > maxLines) throw new PricingError(`"${product.name}" allows at most ${maxLines} line(s) of custom text.`);
    if (maxChars > 0 && content.text_lines.some((l) => l.length > maxChars)) {
      throw new PricingError(`Custom text for "${product.name}" is limited to ${maxChars} characters per line.`);
    }
  }
  if (content?.image_urls) {
    if (maxImages === 0) throw new PricingError(`Custom images are not available for "${product.name}".`);
    if (content.image_urls.length > maxImages) throw new PricingError(`"${product.name}" allows at most ${maxImages} custom image(s).`);
  }
  if (required && !content && (maxLines > 0 || maxImages > 0)) {
    throw new PricingError(`Please add your customization for "${product.name}".`);
  }
  return content;
}

interface Catalog {
  products: Map<string, any>;
  groups: Map<string, ProductOptionGroup[]>;   // productId -> option groups (active and inactive, with values)
  categories: Map<string, string[]>;
  combos: Map<string, any>;
  comboProducts: Map<string, { product_id: string; quantity: number }[]>;
}

async function loadCatalog(db: Queryable, productIds: string[], comboIds: string[]): Promise<Catalog> {
  const catalog: Catalog = {
    products: new Map(), groups: new Map(),
    categories: new Map(), combos: new Map(), comboProducts: new Map(),
  };

  if (comboIds.length) {
    const combos = await db.query(
      `SELECT id, name, image_url, discount_price, is_active FROM combos WHERE id = ANY($1::uuid[])`,
      [comboIds]
    );
    combos.rows.forEach((c) => catalog.combos.set(c.id, c));
    const cps = await db.query(
      `SELECT combo_id, product_id, quantity FROM combo_products WHERE combo_id = ANY($1::uuid[])`,
      [comboIds]
    );
    cps.rows.forEach((r) => {
      const list = catalog.comboProducts.get(r.combo_id) || [];
      list.push({ product_id: r.product_id, quantity: r.quantity });
      catalog.comboProducts.set(r.combo_id, list);
      productIds.push(r.product_id);
    });
  }

  const ids = Array.from(new Set(productIds));
  if (!ids.length) return catalog;

  const [products, cats, groups] = await Promise.all([
    db.query(
      `SELECT id, name, price, image_url, category, is_active, is_customizable, customization_price,
              track_stock, stock_quantity, max_customization_lines, max_customization_characters, max_customization_images
         FROM products WHERE id = ANY($1::uuid[])`, [ids]),
    db.query(
      `SELECT pc.product_id, c.name FROM product_categories pc
         JOIN categories c ON c.id = pc.category_id WHERE pc.product_id = ANY($1::uuid[])`, [ids]),
    loadProductOptions(db, ids, { includeInactive: true }),
  ]);
  products.rows.forEach((p) => catalog.products.set(p.id, p));
  cats.rows.forEach((r) => catalog.categories.set(r.product_id, [...(catalog.categories.get(r.product_id) || []), r.name]));
  catalog.groups = groups;
  return catalog;
}

function activeProduct(catalog: Catalog, id: string) {
  const product = catalog.products.get(id);
  if (!product || !product.is_active) {
    throw new PricingError('One of the items in your cart is no longer available. Please remove it and try again.');
  }
  return product;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SelectedOption {
  group_id: string;                 // option_groups.id
  product_option_group_id: string;
  group_name: string;
  group_slug: string;
  value_id: string;
  value_key: string;
  name: string;
  price_modifier: number;
}

interface ResolvedOptions {
  selected: SelectedOption[];
  optionsTotal: number;
  legacy: Record<string, unknown>;  // color_*/size_* fields kept on order lines for the emails/admin views built before options
}

/** Ids the request selected: `selected_options` (ids or {value_id}) plus the legacy color_id / size_id. */
function requestedOptionIds(raw: any): { explicit: string[]; legacy: string[] } {
  const explicit: string[] = [];
  const list = raw?.selected_options;
  if (list !== undefined && list !== null) {
    if (!Array.isArray(list) || list.length > 30) throw new PricingError('Invalid option selection');
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : entry && (entry.value_id ?? entry.option_value_id ?? entry.id);
      if (!isUuid(id)) throw new PricingError('Invalid option selection');
      explicit.push(id);
    }
    if (new Set(explicit).size !== explicit.length) throw new PricingError('Duplicate option selection');
  }
  const legacy: string[] = [];
  for (const id of [raw?.color_id, raw?.size_id]) {
    if (id === undefined || id === null || id === '') continue;
    if (!isUuid(id)) throw new PricingError('Invalid option selection');
    legacy.push(id);
  }
  return { explicit, legacy };
}

/**
 * Validate the selected options for a product and total their price modifiers.
 * Rejects: values that do not belong to the product, inactive values/groups, two values from one group,
 * and any required (active) group left unselected.
 */
function resolveOptions(catalog: Catalog, product: any, raw: any): ResolvedOptions {
  const groups = catalog.groups.get(product.id) || [];
  const valueIndex = new Map<string, { group: ProductOptionGroup; value: OptionValue }>();
  const legacyIndex = new Map<string, string>(); // pre-options colour/size id -> option value id
  for (const g of groups) {
    for (const v of g.values) {
      valueIndex.set(v.id, { group: g, value: v });
      const legacyId = v.metadata?.legacy_color_id ?? v.metadata?.legacy_size_id;
      if (legacyId) legacyIndex.set(legacyId, v.id);
    }
  }

  const { explicit, legacy } = requestedOptionIds(raw);
  const ids = [...explicit];
  for (const id of legacy) {
    const resolved = valueIndex.has(id) ? id : legacyIndex.get(id);
    if (!resolved) throw new PricingError(`An option selected for "${product.name}" is no longer available.`);
    if (!ids.includes(resolved)) ids.push(resolved); // same choice sent both ways is one selection, not a duplicate
  }

  const chosenGroups = new Set<string>();
  const selected: (SelectedOption & { display_order: number; meta: Record<string, any> })[] = [];
  for (const id of ids) {
    const entry = valueIndex.get(id);
    if (!entry) throw new PricingError(`An option selected for "${product.name}" does not belong to this product.`);
    const { group, value } = entry;
    if (!group.is_active || !value.is_active) {
      throw new PricingError(`"${value.name}" (${group.name}) is no longer available for "${product.name}".`);
    }
    if (chosenGroups.has(group.id)) throw new PricingError(`Only one ${group.name} can be selected for "${product.name}".`);
    chosenGroups.add(group.id);
    selected.push({
      group_id: group.option_group_id,
      product_option_group_id: group.id,
      group_name: group.name,
      group_slug: group.slug,
      value_id: value.id,
      value_key: value.value_key,
      name: value.name,
      price_modifier: value.price_modifier,
      display_order: group.display_order,
      meta: value.metadata || {},
    });
  }

  for (const g of groups) {
    if (g.is_required && g.is_active && g.values.some((v) => v.is_active) && !chosenGroups.has(g.id)) {
      throw new PricingError(`Please select ${g.name} for "${product.name}".`);
    }
  }

  selected.sort((a, b) => a.display_order - b.display_order);
  const colour = selected.find((s) => s.group_slug === 'colour');
  const size = selected.find((s) => s.group_slug === 'size');

  return {
    selected: selected.map(({ display_order, meta, ...rest }) => rest),
    optionsTotal: round2(selected.reduce((sum, s) => sum + s.price_modifier, 0)),
    legacy: {
      color_id: colour?.value_id, color_name: colour?.name, color_code: colour?.meta.color_code,
      size_id: size?.value_id, size_name: size?.name, size_code: size?.meta.size_code,
    },
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A product that has not been priced yet (price 0) must never be sellable. */
function requirePrice(name: string, unit: number) {
  if (!(unit > 0)) throw new PricingError(`"${name}" is not available for purchase yet.`);
}

/** Build the canonical line for a normal product cart item. */
function priceProductLine(raw: any, catalog: Catalog) {
  const match = typeof raw.id === 'string' ? raw.id.match(UUID_PREFIX) : null;
  const productId = isUuid(raw.product_id) ? raw.product_id : match?.[1];
  if (!productId) throw new PricingError('Invalid cart item');

  const product = activeProduct(catalog, productId);
  const options = resolveOptions(catalog, product, raw);
  const quantity = quantityOf(raw.quantity, product.name);
  const customization = checkCustomization(product, raw.customization, true);

  const basePrice = round2(num(product.price));
  const customizationFee = product.is_customizable ? round2(num(product.customization_price)) : 0;
  const unit = round2(basePrice + options.optionsTotal + customizationFee);
  requirePrice(product.name, unit);
  const optionNames = options.selected.map((s) => s.name);

  // The line is an immutable snapshot: it keeps what the customer bought even if the product,
  // its options or their prices are edited or deleted later.
  return {
    couponEligible: true,
    categories: [...(catalog.categories.get(productId) || []), ...(product.category ? [product.category] : [])],
    line: {
      id: shortString(raw.id, 200) || productId,
      type: 'product',
      product_id: productId,
      product_name: product.name,
      name: optionNames.length ? `${product.name} (${optionNames.join(', ')})` : product.name,
      base_price: basePrice,
      selected_options: options.selected,
      options_total: options.optionsTotal,
      customization_fee: customizationFee,
      price: unit,
      quantity,
      line_total: round2(unit * quantity),
      image_url: safeImage(raw.image_url, product.image_url || ''),
      category: product.category || undefined,
      ...options.legacy,
      customization,
    },
  };
}

/** Per-product selections the customer made inside a combo (matched by product id). */
function comboSelections(raw: any): Map<string, any> {
  const map = new Map<string, any>();
  if (Array.isArray(raw.combo_products)) {
    raw.combo_products.forEach((cp: any) => { if (cp && isUuid(cp.id)) map.set(cp.id, cp); });
  }
  return map;
}

function comboProductLine(product: any, quantity: number, unit: number, selection: any, catalog: Catalog) {
  const options = resolveOptions(catalog, product, selection);
  return {
    optionsTotal: options.optionsTotal,
    line: {
      id: product.id,
      product_id: product.id,
      name: product.name,
      quantity,
      price: unit,                       // base price used for this member
      selected_options: options.selected,
      options_total: options.optionsTotal,
      image_url: safeImage(selection?.image_url, product.image_url || ''),
      ...options.legacy,
      customization: checkCustomization(product, selection?.customization, false),
    },
  };
}

/** Fixed (admin-defined) combo. */
function priceFixedCombo(raw: any, comboId: string, catalog: Catalog) {
  const combo = catalog.combos.get(comboId);
  if (!combo || !combo.is_active) {
    throw new PricingError('A combo in your cart is no longer available. Please remove it and try again.');
  }
  const members = catalog.comboProducts.get(comboId) || [];
  if (!members.length) throw new PricingError(`Combo "${combo.name}" has no products.`);
  const selections = comboSelections(raw);

  let listTotal = 0;
  let surcharge = 0;
  const combo_products = members.map((m) => {
    const product = activeProduct(catalog, m.product_id);
    const priced = comboProductLine(product, m.quantity, num(product.price), selections.get(m.product_id), catalog);
    listTotal += num(product.price) * m.quantity;
    surcharge += priced.optionsTotal * m.quantity;
    return priced.line;
  });

  const base = round2(combo.discount_price != null ? num(combo.discount_price) : listTotal);
  const unit = round2(base + surcharge);
  requirePrice(combo.name, unit);
  const quantity = quantityOf(raw.quantity, combo.name);
  return {
    couponEligible: false,
    categories: [] as string[],
    line: {
      id: shortString(raw.id, 200) || `combo-${comboId}`,
      type: 'combo',
      combo_id: comboId,
      name: combo.name,
      base_price: base,
      options_total: round2(surcharge),
      price: unit,
      quantity,
      line_total: round2(unit * quantity),
      image_url: safeImage(raw.image_url, combo.image_url || ''),
      combo_products,
    },
  };
}

/** Customer-built ("custom") combo: priced from its member products, with a tier discount. */
function priceCustomCombo(raw: any, catalog: Catalog) {
  if (!Array.isArray(raw.combo_products) || raw.combo_products.length === 0) {
    throw new PricingError('Invalid combo in cart');
  }
  let subtotal = 0;
  let totalItems = 0;
  const combo_products = raw.combo_products.map((cp: any) => {
    if (!isUuid(cp?.id)) throw new PricingError('Invalid product in combo');
    const product = activeProduct(catalog, cp.id);
    const qty = quantityOf(cp.quantity, product.name);
    const unit = round2(num(product.price) + num(product.customization_price));
    const priced = comboProductLine(product, qty, unit, cp, catalog);
    subtotal += (unit + priced.optionsTotal) * qty;
    totalItems += qty;
    return priced.line;
  });

  const tier = CUSTOM_COMBO_TIERS.find((t) => totalItems >= t.minItems && totalItems <= t.maxItems) || CUSTOM_COMBO_TIERS[0];
  const unit = round2(subtotal - (subtotal * tier.discount) / 100);
  requirePrice('Custom Combo', unit);
  const quantity = quantityOf(raw.quantity, 'combo');

  return {
    couponEligible: false,
    categories: [] as string[],
    line: {
      id: shortString(raw.id, 200) || `combo-${Date.now()}`,
      type: 'combo',
      name: shortString(raw.name, 200) || 'Custom Combo',
      base_price: round2(subtotal),
      discount_percentage: tier.discount,
      price: unit,
      quantity,
      line_total: round2(unit * quantity),
      image_url: safeImage(raw.image_url, ''),
      combo_products,
    },
  };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/**
 * Work out what the cart takes from stock and check it against the current numbers.
 * This is a friendly early check (quote, create-order, COD); the authoritative, race-free check is the
 * conditional UPDATE in orderService.createOrder, which runs in the order transaction.
 * Stock rules: option value stock_quantity NULL = not tracked; products only count when track_stock = true.
 */
function collectStock(items: any[], catalog: Catalog): StockDemand {
  const products = new Map<string, { name: string; qty: number }>();
  const values = new Map<string, { label: string; qty: number }>();

  const add = (productId: string, qty: number, selected: SelectedOption[]) => {
    const product = catalog.products.get(productId);
    if (product?.track_stock) {
      const cur = products.get(productId) || { name: product.name, qty: 0 };
      cur.qty += qty;
      products.set(productId, cur);
    }
    for (const o of selected) {
      const cur = values.get(o.value_id) || { label: `${o.name} (${o.group_name}) for "${product?.name}"`, qty: 0 };
      cur.qty += qty;
      values.set(o.value_id, cur);
    }
  };

  for (const line of items) {
    if (line.type === 'combo') {
      for (const cp of line.combo_products || []) add(cp.product_id, cp.quantity * line.quantity, cp.selected_options || []);
    } else {
      add(line.product_id, line.quantity, line.selected_options || []);
    }
  }

  const stockOf = new Map<string, number | null>();
  for (const groups of catalog.groups.values()) for (const g of groups) for (const v of g.values) stockOf.set(v.id, v.stock_quantity);

  const left = (n: number) => (n <= 0 ? 'is sold out' : `only ${n} left`);
  for (const [id, d] of products) {
    const stock = Number(catalog.products.get(id)?.stock_quantity) || 0;
    if (stock < d.qty) throw new StockError(`"${d.name}" ${left(stock)}.`);
  }
  for (const [id, d] of values) {
    const stock = stockOf.get(id);
    if (stock !== null && stock !== undefined && stock < d.qty) throw new StockError(`${d.label} ${left(stock)}.`);
  }

  return {
    products: [...products].map(([id, d]) => ({ id, name: d.name, qty: d.qty })),
    values: [...values].map(([id, d]) => ({ id, label: d.label, qty: d.qty })),
  };
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

export type CouponCheck =
  | { ok: true; coupon: AppliedCoupon }
  | { ok: false; status: number; message: string };

/**
 * Validate a coupon and compute its discount for a given non-combo subtotal.
 * Shared by POST /api/coupons/validate (preview) and order pricing (authoritative).
 */
export async function evaluateCoupon(
  db: Queryable,
  input: { code: string; subtotal: number; email?: string; categories?: string[] }
): Promise<CouponCheck> {
  const result = await db.query(
    'SELECT * FROM coupons WHERE code = $1 AND is_active = true',
    [String(input.code).trim().toUpperCase()]
  );
  const coupon = result.rows[0];
  if (!coupon) return { ok: false, status: 404, message: 'Invalid coupon code' };

  const now = new Date();
  if (coupon.end_date && new Date(coupon.end_date) < now) return { ok: false, status: 400, message: 'Coupon has expired' };
  if (coupon.start_date && new Date(coupon.start_date) > now) return { ok: false, status: 400, message: 'Coupon is not active yet' };
  if (coupon.min_order_amount && input.subtotal < num(coupon.min_order_amount)) {
    return { ok: false, status: 400, message: `Minimum order amount should be ₹${coupon.min_order_amount}` };
  }
  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
    return { ok: false, status: 400, message: 'Coupon usage limit exceeded' };
  }

  if (input.email && coupon.per_user_limit) {
    const usage = await db.query(
      'SELECT COUNT(*) FROM coupon_usage WHERE coupon_id = $1 AND customer_email = $2',
      [coupon.id, input.email.trim().toLowerCase()]
    );
    const count = parseInt(usage.rows[0].count);
    if (count >= coupon.per_user_limit) {
      return { ok: false, status: 400, message: `You have already used this coupon ${count} times` };
    }
  }

  const applicable: string[] = coupon.applicable_categories || [];
  const cartCategories = input.categories || [];
  if (applicable.length > 0 && cartCategories.length > 0 && !cartCategories.some((c) => applicable.includes(c))) {
    return { ok: false, status: 400, message: 'Coupon not applicable for items in your cart' };
  }

  let discount = 0;
  if (coupon.discount_type === 'percentage') {
    discount = (input.subtotal * num(coupon.discount_value)) / 100;
    if (coupon.max_discount_amount) discount = Math.min(discount, num(coupon.max_discount_amount));
  } else {
    discount = num(coupon.discount_value);
  }
  discount = round2(Math.min(Math.max(discount, 0), input.subtotal)); // never more than the eligible subtotal

  return {
    ok: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: num(coupon.discount_value),
      discount_amount: discount,
    },
  };
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export async function priceCart(
  db: Queryable,
  rawItems: unknown,
  opts: { couponCode?: string | null; email?: string; paymentMethod: PaymentMethod }
): Promise<CartQuote> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new PricingError('Your cart is empty');
  if (rawItems.length > MAX_CART_LINES) throw new PricingError('Too many items in cart');

  // First pass: work out which products/combos to load.
  const productIds: string[] = [];
  const comboIds: string[] = [];
  const kinds = rawItems.map((raw: any) => {
    if (!raw || typeof raw !== 'object') throw new PricingError('Invalid cart item');
    if (raw.type === 'combo') {
      const comboId = isUuid(raw.combo_id) ? raw.combo_id : (typeof raw.id === 'string' ? raw.id.match(COMBO_ID)?.[1] : undefined);
      if (comboId) {
        comboIds.push(comboId);
        return { kind: 'fixed' as const, comboId };
      }
      (Array.isArray(raw.combo_products) ? raw.combo_products : []).forEach((cp: any) => isUuid(cp?.id) && productIds.push(cp.id));
      return { kind: 'custom' as const };
    }
    const match = typeof raw.id === 'string' ? raw.id.match(UUID_PREFIX) : null;
    const productId = isUuid(raw.product_id) ? raw.product_id : match?.[1];
    if (productId) productIds.push(productId);
    return { kind: 'product' as const };
  });

  const catalog = await loadCatalog(db, productIds, comboIds);

  let subtotal = 0;
  let couponSubtotal = 0;
  const couponCategories = new Set<string>();
  const items = rawItems.map((raw: any, i) => {
    const k = kinds[i];
    const priced =
      k.kind === 'fixed' ? priceFixedCombo(raw, k.comboId, catalog)
      : k.kind === 'custom' ? priceCustomCombo(raw, catalog)
      : priceProductLine(raw, catalog);
    const lineTotal = priced.line.price * priced.line.quantity;
    subtotal += lineTotal;
    if (priced.couponEligible) {
      couponSubtotal += lineTotal;
      priced.categories.forEach((c) => couponCategories.add(c));
    }
    return priced.line;
  });
  subtotal = round2(subtotal);
  couponSubtotal = round2(couponSubtotal);

  let coupon: AppliedCoupon | null = null;
  if (opts.couponCode && opts.couponCode.trim()) {
    if (couponSubtotal <= 0) throw new PricingError('Coupons cannot be applied to combo orders');
    const check = await evaluateCoupon(db, {
      code: opts.couponCode,
      subtotal: couponSubtotal,
      email: opts.email,
      categories: Array.from(couponCategories),
    });
    if (!check.ok) throw new PricingError(check.message, check.status);
    coupon = check.coupon;
  }

  const coupon_discount = coupon ? coupon.discount_amount : 0;
  const shipping_charge = subtotal >= config.freeShippingThreshold ? 0 : config.shippingFee;
  const cod_charge = opts.paymentMethod === 'cod' ? config.codFee : 0;
  const total_amount = Math.max(round2(subtotal + shipping_charge + cod_charge - coupon_discount), 0);

  const stock = collectStock(items, catalog);

  return {
    items, stock, subtotal, coupon, coupon_discount, shipping_charge, cod_charge, total_amount,
    shipping_threshold: config.freeShippingThreshold, shipping_fee: config.shippingFee, cod_fee: config.codFee,
  };
}
