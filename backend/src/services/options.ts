/**
 * Generic product options (Product -> Option group -> Option values).
 *
 * This module has two jobs:
 *   1. READ: load a product's option groups/values and attach them to API responses.
 *   2. LEGACY ADAPTERS: the old colour/size admin endpoints and storefront shapes are served from the
 *      generic tables ("Colour" and "Size" groups), so there is exactly one source of truth and one
 *      pricing model. The product_colors / product_sizes tables are no longer read.
 */
import { Queryable } from './pricing';

export interface OptionValue {
  id: string;
  name: string;
  value_key: string;
  price_modifier: number;
  stock_quantity: number | null;
  display_order: number;
  is_active: boolean;
  image_url: string | null;
  metadata: Record<string, any>;
}

export interface ProductOptionGroup {
  id: string;               // product_option_groups.id (the attachment)
  option_group_id: string;  // option_groups.id (the reusable definition)
  name: string;
  slug: string;
  is_required: boolean;
  display_order: number;
  is_active: boolean;
  values: OptionValue[];
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Load option groups (with values) for several products in one query. */
export async function loadProductOptions(
  db: Queryable,
  productIds: string[],
  opts: { includeInactive?: boolean } = {}
): Promise<Map<string, ProductOptionGroup[]>> {
  const result = new Map<string, ProductOptionGroup[]>();
  if (productIds.length === 0) return result;

  const rows = await db.query(
    `SELECT pog.id AS pog_id, pog.product_id, pog.option_group_id, pog.is_required, pog.display_order AS group_order,
            (pog.is_active AND og.is_active) AS group_active, og.name AS group_name, og.slug AS group_slug,
            pov.id AS value_id, pov.name AS value_name, pov.value_key, pov.price_modifier, pov.stock_quantity,
            pov.display_order AS value_order, pov.is_active AS value_active, pov.image_url, pov.metadata
       FROM product_option_groups pog
       JOIN option_groups og ON og.id = pog.option_group_id
       LEFT JOIN product_option_values pov ON pov.product_option_group_id = pog.id
      WHERE pog.product_id = ANY($1::uuid[])
      ORDER BY pog.display_order, og.name, pov.display_order, pov.created_at, pov.name`,
    [productIds]
  );

  const groups = new Map<string, ProductOptionGroup>();
  for (const r of rows.rows) {
    let g = groups.get(r.pog_id);
    if (!g) {
      g = {
        id: r.pog_id,
        option_group_id: r.option_group_id,
        name: r.group_name,
        slug: r.group_slug,
        is_required: r.is_required,
        display_order: r.group_order,
        is_active: r.group_active,
        values: [],
      };
      groups.set(r.pog_id, g);
      const list = result.get(r.product_id) || [];
      list.push(g);
      result.set(r.product_id, list);
    }
    if (r.value_id) {
      g.values.push({
        id: r.value_id,
        name: r.value_name,
        value_key: r.value_key,
        price_modifier: num(r.price_modifier),
        stock_quantity: r.stock_quantity,
        display_order: r.value_order,
        is_active: r.value_active,
        image_url: r.image_url,
        metadata: r.metadata || {},
      });
    }
  }

  if (!opts.includeInactive) {
    for (const [productId, list] of result) {
      const visible = list
        .filter((g) => g.is_active)
        .map((g) => ({ ...g, values: g.values.filter((v) => v.is_active) }))
        .filter((g) => g.values.length > 0);
      result.set(productId, visible);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Legacy storefront/admin shapes (colours and sizes)
// ---------------------------------------------------------------------------

export type LegacyKind = 'colour' | 'size';
const UNTRACKED_STOCK = 9999; // the old model had no "not tracked"; legacy readers get a large number instead

export const toLegacyColor = (productId: string, v: OptionValue) => ({
  id: v.id,
  product_id: productId,
  color_name: v.name,
  color_code: v.metadata?.color_code ?? null,
  image_url: v.image_url,
  additional_images: v.metadata?.additional_images ?? [],
  stock_quantity: v.stock_quantity ?? UNTRACKED_STOCK,
  price_modifier: v.price_modifier,
  is_active: v.is_active,
  display_order: v.display_order,
});

export const toLegacySize = (productId: string, v: OptionValue) => ({
  id: v.id,
  product_id: productId,
  size_name: v.name,
  size_code: v.metadata?.size_code ?? null,
  stock_quantity: v.stock_quantity ?? UNTRACKED_STOCK,
  price_modifier: v.price_modifier,
  is_active: v.is_active,
  display_order: v.display_order,
});

/**
 * Attach option data to product objects (mutates and returns them):
 *   option_groups            generic model (what the new storefront/admin use)
 *   colors / sizes           legacy shapes derived from the "colour"/"size" groups, so the current storefront keeps working
 *   has_colors / has_sizes   derived from whether such values exist
 */
export async function attachOptions<T extends { id: string }>(
  db: Queryable,
  products: T[],
  opts: { includeInactive?: boolean } = {}
): Promise<T[]> {
  const byProduct = await loadProductOptions(db, products.map((p) => p.id), opts);
  for (const p of products as any[]) {
    const groups = byProduct.get(p.id) || [];
    const colour = groups.find((g) => g.slug === 'colour');
    const size = groups.find((g) => g.slug === 'size');
    p.option_groups = groups;
    p.colors = (colour?.values || []).map((v) => toLegacyColor(p.id, v));
    p.sizes = (size?.values || []).map((v) => toLegacySize(p.id, v));
    p.has_colors = p.colors.length > 0;
    p.has_sizes = p.sizes.length > 0;
  }
  return products;
}

// ---------------------------------------------------------------------------
// Legacy write adapters
// ---------------------------------------------------------------------------

const GROUP_NAME: Record<LegacyKind, string> = { colour: 'Colour', size: 'Size' };
const GROUP_ORDER: Record<LegacyKind, number> = { colour: 0, size: 1 };

/** Make sure the product has the "colour"/"size" group attached; returns the attachment id. */
export async function ensureLegacyGroup(db: Queryable, productId: string, kind: LegacyKind): Promise<string> {
  const group = await db.query(
    `INSERT INTO option_groups (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
    [GROUP_NAME[kind], kind]
  );
  const flag = await db.query('SELECT has_colors, has_sizes FROM products WHERE id = $1', [productId]);
  if (flag.rows.length === 0) throw Object.assign(new Error('Product not found'), { status: 404 });
  const required = kind === 'colour' ? flag.rows[0].has_colors : flag.rows[0].has_sizes;

  const attach = await db.query(
    `INSERT INTO product_option_groups (product_id, option_group_id, is_required, display_order)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id, option_group_id) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [productId, group.rows[0].id, !!required, GROUP_ORDER[kind]]
  );
  return attach.rows[0].id;
}

/** The old has_colors / has_sizes product flags used to mean "the shopper must choose". Keep that in step. */
export async function syncRequiredFlags(
  db: Queryable,
  productId: string,
  body: { has_colors?: unknown; has_sizes?: unknown }
): Promise<void> {
  for (const [kind, flag] of [['colour', body.has_colors], ['size', body.has_sizes]] as const) {
    if (typeof flag !== 'boolean') continue;
    await db.query(
      `UPDATE product_option_groups pog SET is_required = $3, updated_at = now()
         FROM option_groups og
        WHERE pog.option_group_id = og.id AND og.slug = $2 AND pog.product_id = $1`,
      [productId, kind, flag]
    );
  }
}

const LEGACY_SELECT = `
  SELECT pov.*, pog.product_id
    FROM product_option_values pov
    JOIN product_option_groups pog ON pog.id = pov.product_option_group_id
    JOIN option_groups og ON og.id = pog.option_group_id`;

const shape = (kind: LegacyKind, row: any) => {
  const value: OptionValue = {
    id: row.id, name: row.name, value_key: row.value_key, price_modifier: num(row.price_modifier),
    stock_quantity: row.stock_quantity, display_order: row.display_order, is_active: row.is_active,
    image_url: row.image_url, metadata: row.metadata || {},
  };
  return {
    ...(kind === 'colour' ? toLegacyColor(row.product_id, value) : toLegacySize(row.product_id, value)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

export async function listLegacy(db: Queryable, productId: string, kind: LegacyKind, activeOnly: boolean) {
  const rows = await db.query(
    `${LEGACY_SELECT}
      WHERE pog.product_id = $1 AND og.slug = $2 ${activeOnly ? 'AND pov.is_active AND pog.is_active AND og.is_active' : ''}
      ORDER BY pov.display_order ASC, pov.created_at ASC`,
    [productId, kind]
  );
  return rows.rows.map((r) => shape(kind, r));
}

export async function getLegacy(db: Queryable, kind: LegacyKind, valueId: string, activeOnly: boolean) {
  const rows = await db.query(
    `${LEGACY_SELECT} WHERE pov.id = $1 AND og.slug = $2 ${activeOnly ? 'AND pov.is_active' : ''}`,
    [valueId, kind]
  );
  return rows.rows[0] ? shape(kind, rows.rows[0]) : null;
}

export async function createLegacy(db: Queryable, productId: string, kind: LegacyKind, b: any) {
  const pogId = await ensureLegacyGroup(db, productId, kind);
  const metadata: Record<string, unknown> =
    kind === 'colour'
      ? { color_code: b.color_code ?? undefined, additional_images: Array.isArray(b.additional_images) ? b.additional_images : [] }
      : { size_code: b.size_code ?? undefined };
  Object.keys(metadata).forEach((k) => metadata[k] === undefined && delete metadata[k]);

  const inserted = await db.query(
    `INSERT INTO product_option_values
       (product_option_group_id, name, price_modifier, stock_quantity, display_order, is_active, image_url, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
    [
      pogId,
      kind === 'colour' ? b.color_name : b.size_name,
      num(b.price_modifier),
      Number.isInteger(Number(b.stock_quantity)) && Number(b.stock_quantity) >= 0 ? Number(b.stock_quantity) : 0,
      Number.isInteger(Number(b.display_order)) ? Number(b.display_order) : 0,
      b.is_active !== undefined ? !!b.is_active : true,
      kind === 'colour' ? b.image_url ?? null : null,
      JSON.stringify(metadata),
    ]
  );
  return getLegacy(db, kind, inserted.rows[0].id, false);
}

export async function updateLegacy(db: Queryable, kind: LegacyKind, valueId: string, b: any) {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  const name = kind === 'colour' ? b.color_name : b.size_name;
  if (name !== undefined) add('name', name);
  if (b.price_modifier !== undefined) add('price_modifier', num(b.price_modifier));
  if (b.stock_quantity !== undefined) add('stock_quantity', Math.max(0, Math.trunc(num(b.stock_quantity))));
  if (b.display_order !== undefined) add('display_order', Math.trunc(num(b.display_order)));
  if (b.is_active !== undefined) add('is_active', !!b.is_active);
  if (kind === 'colour' && b.image_url !== undefined) add('image_url', b.image_url);

  const patch: Record<string, unknown> = {};
  if (kind === 'colour') {
    if (b.color_code !== undefined) patch.color_code = b.color_code;
    if (b.additional_images !== undefined) patch.additional_images = Array.isArray(b.additional_images) ? b.additional_images : [];
  } else if (b.size_code !== undefined) {
    patch.size_code = b.size_code;
  }
  if (Object.keys(patch).length) add('metadata', JSON.stringify(patch), '::jsonb');
  if (sets.length === 0) return null;

  // metadata is merged (||) so untouched keys such as legacy_color_id survive.
  const setSql = sets.map((s) => (s.startsWith('metadata =') ? s.replace('metadata = ', 'metadata = metadata || ') : s));
  values.push(valueId, kind);
  const updated = await db.query(
    `UPDATE product_option_values pov SET ${setSql.join(', ')}, updated_at = now()
       FROM product_option_groups pog JOIN option_groups og ON og.id = pog.option_group_id
      WHERE pov.product_option_group_id = pog.id AND pov.id = $${values.length - 1} AND og.slug = $${values.length}
      RETURNING pov.id`,
    values
  );
  return updated.rows[0] ? getLegacy(db, kind, valueId, false) : null;
}

export async function deleteLegacy(db: Queryable, kind: LegacyKind, valueId: string) {
  await db.query(
    `DELETE FROM product_option_values pov USING product_option_groups pog, option_groups og
      WHERE pov.product_option_group_id = pog.id AND pog.option_group_id = og.id
        AND pov.id = $1 AND og.slug = $2`,
    [valueId, kind]
  );
}

export async function deleteAllLegacy(db: Queryable, productId: string, kind: LegacyKind) {
  await db.query(
    `DELETE FROM product_option_values pov USING product_option_groups pog, option_groups og
      WHERE pov.product_option_group_id = pog.id AND pog.option_group_id = og.id
        AND pog.product_id = $1 AND og.slug = $2`,
    [productId, kind]
  );
}
