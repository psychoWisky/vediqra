-- This file is UTF-8 (it contains an emoji default). Make psql read it as UTF-8 whatever the console code page is.
SET client_encoding = 'UTF8';

-- ============================================================================
-- 002_vediqra_product_options.sql — Phase 2
--
-- Applies to a database that already has schema.sql + 001_phase1_security.sql.
-- A fresh install of the current schema.sql already contains everything below
-- (the data-migration step simply finds nothing to migrate).
-- Idempotent: safe to run more than once.
--
-- What it adds
--   1. Slug helpers (slugify, unique_slug) and BEFORE INSERT triggers that fill a missing slug.
--   2. categories: slug, parent_id (two-level hierarchy), banner_url.
--   3. products:   slug (unique).
--   4. Generic options:
--        option_groups          reusable definitions ("Size", "Finish", "Frame Type" ...)
--        product_option_groups  a product explicitly attaching a group (required / optional, order)
--        product_option_values  the values a product offers inside that group
--                               (price modifier, optional stock, order, active, image, metadata)
--   5. Data migration: product_colors -> group "Colour", product_sizes -> group "Size".
--
-- Colours/sizes: the legacy tables are KEPT (rollback safety, provenance via metadata.legacy_*_id) but
-- are no longer read by pricing or by product responses. The legacy colour/size admin endpoints are now
-- adapters over the option tables, so there is a single source of truth. Drop product_colors /
-- product_sizes once the old admin UI is retired (Phase 3).
--
-- Rollback (Phase 2 objects only):  see the ROLLBACK block at the bottom of this file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Slug helpers
-- ---------------------------------------------------------------------------
-- "Magic Mug" -> "magic-mug". Non-latin names fall back to "item" (made unique by unique_slug).
CREATE OR REPLACE FUNCTION slugify(input text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    NULLIF(trim(both '-' from regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g')), ''),
    'item')
$$;

-- First free slug in <tbl>.slug for a base: base, base-2, base-3 ...
CREATE OR REPLACE FUNCTION unique_slug(tbl text, base text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  candidate text := base;
  n integer := 1;
  taken boolean;
BEGIN
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE slug = $1)', tbl) INTO taken USING candidate;
    EXIT WHEN NOT taken;
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END $$;

-- BEFORE INSERT: derive slug from name when the caller did not supply one.
CREATE OR REPLACE FUNCTION assign_slug_from_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := unique_slug(TG_TABLE_NAME, slugify(NEW.name));
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Categories: slug + optional parent (two levels) + banner
-- ---------------------------------------------------------------------------
ALTER TABLE categories ADD COLUMN IF NOT EXISTS slug       TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id  UUID;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS banner_url TEXT;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, name FROM categories WHERE slug IS NULL OR slug = '' ORDER BY created_at, id LOOP
    UPDATE categories SET slug = unique_slug('categories', slugify(r.name)) WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE categories ALTER COLUMN slug SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_slug_key') THEN
    ALTER TABLE categories ADD CONSTRAINT categories_slug_key UNIQUE (slug);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_slug_format') THEN
    ALTER TABLE categories ADD CONSTRAINT categories_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_parent_fk') THEN
    -- RESTRICT: a parent with subcategories cannot be deleted by accident.
    ALTER TABLE categories ADD CONSTRAINT categories_parent_fk
      FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_not_own_parent') THEN
    ALTER TABLE categories ADD CONSTRAINT categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories (parent_id);

-- Two levels only: a parent must itself be top-level, and a category that has children cannot become a child.
-- (Remove this trigger if deeper nesting is ever wanted; nothing else depends on it.)
CREATE OR REPLACE FUNCTION categories_check_hierarchy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM categories WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Categories support two levels: the parent must be a top-level category';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM categories WHERE parent_id = NEW.id) THEN
      RAISE EXCEPTION 'A category that has subcategories cannot become a subcategory';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_categories_hierarchy ON categories;
CREATE TRIGGER trg_categories_hierarchy
  BEFORE INSERT OR UPDATE OF parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION categories_check_hierarchy();

DROP TRIGGER IF EXISTS trg_categories_slug ON categories;
CREATE TRIGGER trg_categories_slug
  BEFORE INSERT ON categories
  FOR EACH ROW EXECUTE FUNCTION assign_slug_from_name();

-- ---------------------------------------------------------------------------
-- 3. Products: unique slug
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, name FROM products WHERE slug IS NULL OR slug = '' ORDER BY created_at, id LOOP
    UPDATE products SET slug = unique_slug('products', slugify(r.name)) WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE products ALTER COLUMN slug SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_slug_key') THEN
    ALTER TABLE products ADD CONSTRAINT products_slug_key UNIQUE (slug);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_slug_format') THEN
    ALTER TABLE products ADD CONSTRAINT products_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_products_slug ON products;
CREATE TRIGGER trg_products_slug
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION assign_slug_from_name();

-- ---------------------------------------------------------------------------
-- 4. Generic product options
--
--   Product --(product_option_groups)--> Option group --> Values (per product)
--
-- Nothing is global: a value exists only under one product's attachment of a group, so "Size: M" on a
-- T-shirt and "Size: M" on a mug are independent rows with their own price and stock.
-- The database has no idea what "Finish" or "Size" mean; the storefront decides how to render a group.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS option_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One library group per name ("Finish" cannot exist twice, whatever its slug).
CREATE UNIQUE INDEX IF NOT EXISTS uq_option_groups_name ON option_groups (lower(name));

DROP TRIGGER IF EXISTS trg_option_groups_slug ON option_groups;
CREATE TRIGGER trg_option_groups_slug
  BEFORE INSERT ON option_groups
  FOR EACH ROW EXECUTE FUNCTION assign_slug_from_name();

CREATE TABLE IF NOT EXISTS product_option_groups (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    option_group_id  UUID NOT NULL REFERENCES option_groups(id) ON DELETE RESTRICT,
    is_required      BOOLEAN NOT NULL DEFAULT FALSE,
    display_order    INTEGER NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, option_group_id)
);
CREATE INDEX IF NOT EXISTS idx_pog_product ON product_option_groups (product_id);
CREATE INDEX IF NOT EXISTS idx_pog_group ON product_option_groups (option_group_id);

-- Unique-within-group key for a value ("Holographic" -> "holographic"; a repeat becomes "holographic-2").
CREATE OR REPLACE FUNCTION assign_option_value_key() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  base text;
  candidate text;
  n integer := 1;
BEGIN
  IF NEW.value_key IS NULL OR NEW.value_key = '' THEN
    base := slugify(NEW.name);
    candidate := base;
    WHILE EXISTS (SELECT 1 FROM product_option_values
                   WHERE product_option_group_id = NEW.product_option_group_id AND value_key = candidate) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    NEW.value_key := candidate;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS product_option_values (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_option_group_id  UUID NOT NULL REFERENCES product_option_groups(id) ON DELETE CASCADE,
    name                     TEXT NOT NULL,
    value_key                TEXT NOT NULL CHECK (value_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    price_modifier           NUMERIC(12,2) NOT NULL DEFAULT 0,   -- added to the product price (may be negative)
    stock_quantity           INTEGER CHECK (stock_quantity IS NULL OR stock_quantity >= 0), -- NULL = not tracked
    display_order            INTEGER NOT NULL DEFAULT 0,
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    image_url                TEXT,
    metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb, -- storefront hints, e.g. {"color_code":"#f00","size_code":"XL"}
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_option_group_id, value_key)
);
CREATE INDEX IF NOT EXISTS idx_pov_group ON product_option_values (product_option_group_id);
-- Lets cart items created before this migration (they carry old colour/size ids) be mapped to option values.
CREATE INDEX IF NOT EXISTS idx_pov_legacy_color ON product_option_values ((metadata->>'legacy_color_id')) WHERE metadata ? 'legacy_color_id';
CREATE INDEX IF NOT EXISTS idx_pov_legacy_size  ON product_option_values ((metadata->>'legacy_size_id'))  WHERE metadata ? 'legacy_size_id';

DROP TRIGGER IF EXISTS trg_pov_value_key ON product_option_values;
CREATE TRIGGER trg_pov_value_key
  BEFORE INSERT ON product_option_values
  FOR EACH ROW EXECUTE FUNCTION assign_option_value_key();

-- ---------------------------------------------------------------------------
-- 5. Data migration: colours and sizes become option groups
-- ---------------------------------------------------------------------------
INSERT INTO option_groups (name, slug) VALUES ('Colour', 'colour'), ('Size', 'size')
ON CONFLICT (slug) DO NOTHING;

-- Attach: a group is "required" when the product's legacy has_colors / has_sizes flag was on
-- (that is when the old storefront forced a choice).
INSERT INTO product_option_groups (product_id, option_group_id, is_required, display_order)
SELECT DISTINCT c.product_id, g.id, COALESCE(p.has_colors, FALSE), 0
  FROM product_colors c
  JOIN products p ON p.id = c.product_id
  CROSS JOIN (SELECT id FROM option_groups WHERE slug = 'colour') g
ON CONFLICT (product_id, option_group_id) DO NOTHING;

INSERT INTO product_option_groups (product_id, option_group_id, is_required, display_order)
SELECT DISTINCT s.product_id, g.id, COALESCE(p.has_sizes, FALSE), 1
  FROM product_sizes s
  JOIN products p ON p.id = s.product_id
  CROSS JOIN (SELECT id FROM option_groups WHERE slug = 'size') g
ON CONFLICT (product_id, option_group_id) DO NOTHING;

INSERT INTO product_option_values
       (product_option_group_id, name, price_modifier, stock_quantity, display_order, is_active, image_url, metadata, created_at, updated_at)
SELECT pog.id, c.color_name, c.price_modifier, c.stock_quantity, c.display_order, c.is_active, c.image_url,
       jsonb_strip_nulls(jsonb_build_object(
         'legacy_color_id', c.id::text,
         'color_code', c.color_code,
         'additional_images', to_jsonb(COALESCE(c.additional_images, '{}'::text[])))),
       c.created_at, c.updated_at
  FROM product_colors c
  JOIN product_option_groups pog
    ON pog.product_id = c.product_id
   AND pog.option_group_id = (SELECT id FROM option_groups WHERE slug = 'colour')
 WHERE NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.metadata->>'legacy_color_id' = c.id::text)
 ORDER BY c.display_order, c.created_at;

INSERT INTO product_option_values
       (product_option_group_id, name, price_modifier, stock_quantity, display_order, is_active, metadata, created_at, updated_at)
SELECT pog.id, s.size_name, s.price_modifier, s.stock_quantity, s.display_order, s.is_active,
       jsonb_strip_nulls(jsonb_build_object('legacy_size_id', s.id::text, 'size_code', s.size_code)),
       s.created_at, s.updated_at
  FROM product_sizes s
  JOIN product_option_groups pog
    ON pog.product_id = s.product_id
   AND pog.option_group_id = (SELECT id FROM option_groups WHERE slug = 'size')
 WHERE NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.metadata->>'legacy_size_id' = s.id::text)
 ORDER BY s.display_order, s.created_at;

COMMENT ON TABLE product_colors IS 'DEPRECATED (Phase 2): migrated to product_option_values under group "colour". Not read by the API any more; drop after the old admin UI is retired.';
COMMENT ON TABLE product_sizes  IS 'DEPRECATED (Phase 2): migrated to product_option_values under group "size". Not read by the API any more; drop after the old admin UI is retired.';
COMMENT ON TABLE order_items    IS 'UNUSED: order lines are stored as an immutable JSONB snapshot in orders.items (product, base price, selected options with their prices, customization, quantity, line price).';

-- ---------------------------------------------------------------------------
-- ROLLBACK (Phase 2 objects only; the legacy colour/size tables are untouched, so nothing is lost):
--   DROP TABLE product_option_values, product_option_groups, option_groups;
--   DROP TRIGGER trg_products_slug ON products;    ALTER TABLE products   DROP COLUMN slug;
--   DROP TRIGGER trg_categories_slug ON categories; DROP TRIGGER trg_categories_hierarchy ON categories;
--   ALTER TABLE categories DROP COLUMN slug, DROP COLUMN parent_id, DROP COLUMN banner_url;
--   DROP FUNCTION assign_option_value_key, categories_check_hierarchy, assign_slug_from_name, unique_slug, slugify;
-- (Roll back the application code first, then run this.)
-- ---------------------------------------------------------------------------
