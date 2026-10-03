/**
 * Column allowlists for routes that build INSERT/UPDATE statements from a request body.
 *
 * Values are always passed as bound parameters. Column NAMES cannot be parameterised in SQL,
 * so they must never come from the request. `pickColumns` keeps only allowlisted keys;
 * anything else in the body is ignored.
 */

export const COLUMNS = {
  products: [
    'name', 'slug', 'description', 'price', 'original_price', 'discount_percentage', 'image_url',
    'additional_images', 'stock_quantity', 'track_stock', 'sku', 'gender', 'category', 'is_customizable',
    'customization_price', 'max_customization_characters', 'max_customization_images',
    'max_customization_lines', 'is_active', 'has_colors', 'has_sizes', 'social_proof_enabled',
    'social_proof_text', 'social_proof_initial_count', 'social_proof_end_count',
  ],
  categories: [
    'name', 'slug', 'parent_id', 'banner_url', 'description', 'icon', 'icon_type', 'image_url',
    'color', 'hover_effect', 'display_order', 'gender', 'is_active',
  ],
  coupons: [
    'code', 'description', 'discount_type', 'discount_value', 'min_order_amount',
    'max_discount_amount', 'usage_limit', 'per_user_limit', 'start_date', 'end_date',
    'applicable_categories', 'is_active',
  ],
  genders: ['name', 'display_name', 'icon', 'display_order', 'is_active'],
  logo_config: ['logo_url', 'favicon_url', 'start_date', 'end_date', 'is_active', 'notes'],
  popup_config: [
    'title', 'description', 'image_url', 'discount_text', 'discount_value', 'timer_enabled',
    'timer_hours', 'timer_minutes', 'timer_seconds', 'offer_text', 'cta_text', 'cta_link',
    'cash_on_delivery_text', 'prepaid_discount_text', 'is_active', 'display_frequency',
    'start_date', 'end_date',
  ],
  hero_content: [
    'title', 'subtitle', 'media_type', 'media_url', 'video_poster_url', 'autoplay', 'loop',
    'muted', 'cta_text', 'cta_link', 'content_alignment', 'is_active', 'display_order',
  ],
  orders: ['status', 'tracking_number', 'admin_notes'],
  option_groups: ['name', 'slug', 'is_active'],
  product_option_groups: ['is_required', 'display_order', 'is_active'],
  product_option_values: [
    'name', 'value_key', 'price_modifier', 'stock_quantity', 'display_order', 'is_active',
    'image_url', 'metadata',
  ],
  product_colors: [
    'color_name', 'color_code', 'image_url', 'additional_images', 'stock_quantity',
    'price_modifier', 'is_active', 'display_order',
  ],
  product_sizes: [
    'size_name', 'size_code', 'stock_quantity', 'price_modifier', 'is_active', 'display_order',
  ],
} as const;

export type AllowedTable = keyof typeof COLUMNS;

/** Keep only allowlisted keys (in allowlist order) whose value is not `undefined`. */
export function pickColumns(
  table: AllowedTable,
  body: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!body || typeof body !== 'object') return picked;
  for (const column of COLUMNS[table]) {
    if (Object.prototype.hasOwnProperty.call(body, column) && body[column] !== undefined) {
      picked[column] = body[column];
    }
  }
  return picked;
}

/**
 * Build `INSERT INTO <table> (cols) VALUES ($1..) RETURNING *`.
 * `extra` are server-controlled columns (e.g. timestamps) and are added after the allowlist filter.
 */
export function buildInsert(
  table: AllowedTable,
  body: Record<string, unknown> | undefined | null,
  extra: Record<string, unknown> = {}
): { text: string; values: unknown[] } {
  const data = { ...pickColumns(table, body), ...extra };
  const keys = Object.keys(data);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  return {
    text: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values: keys.map((k) => data[k]),
  };
}

/**
 * Build `UPDATE <table> SET ... WHERE id = $n RETURNING *`.
 * Returns null when the body contains no allowlisted column (nothing to update).
 */
export function buildUpdate(
  table: AllowedTable,
  body: Record<string, unknown> | undefined | null,
  id: string,
  extra: Record<string, unknown> = {}
): { text: string; values: unknown[] } | null {
  const picked = pickColumns(table, body);
  if (Object.keys(picked).length === 0) return null;
  const data = { ...picked, ...extra };
  const keys = Object.keys(data);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  return {
    text: `UPDATE ${table} SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
    values: [...keys.map((k) => data[k]), id],
  };
}

export const ORDER_STATUSES = [
  'pending', 'processing', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded', 'partially_refunded',
] as const;

// Statuses an admin may set by hand. 'refunded' / 'partially_refunded' are only ever set by a provider-confirmed refund.
export const MANUAL_ORDER_STATUSES = ORDER_STATUSES.filter((s) => s !== 'refunded' && s !== 'partially_refunded');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value);

/** "Magic Mug" -> "magic-mug" (mirrors the slugify() SQL function). */
export const slugify = (input: string): string =>
  input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

/**
 * Normalise a caller-supplied slug in place. A blank slug is removed so the database trigger derives one
 * from the name. Returns an error message when a non-blank slug cannot be used.
 */
export function normaliseSlug(body: Record<string, any>): string | null {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'slug')) return null;
  if (body.slug === undefined || body.slug === null || (typeof body.slug === 'string' && body.slug.trim() === '')) {
    delete body.slug;
    return null;
  }
  if (typeof body.slug !== 'string') return 'slug must be text';
  const slug = slugify(body.slug.trim());
  if (slug === 'item' && !/item/i.test(body.slug)) return 'slug must contain letters or numbers';
  body.slug = slug;
  return null;
}
