-- ============================================================================
-- VEDIQRA catalogue — modelling check (NOT a seed; everything is ROLLED BACK)
--
-- Purpose: prove the Phase 2 schema can represent the client's catalogue, and document how each kind of
-- catalogue line can be modelled. Nothing is committed: run it any time against an empty or populated
-- database.
--     psql -U postgres -d vediqra -f database/examples/vediqra_catalogue_model.sql
--
-- Three ways a catalogue line can be represented (the schema does not force one; Phase 3 decides with the client):
--   PRODUCT   its own row: own photos, description, price, slug, SEO      e.g. Pen Holder, Tiffin Box
--   OPTION    a value in an option group of ONE product (price modifier)   e.g. Finish: Holographic
--   DESIGN    also an option value (group "Design"): a theme the customer picks   e.g. Krishna, Hanuman Ji
-- Both styles are shown below on purpose (Mug/Cushion as options, Sipper/Kids as separate products).
-- ============================================================================
SET client_encoding = 'UTF8';
BEGIN;

CREATE FUNCTION pg_temp.cat(n text, parent text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO categories (name, parent_id) VALUES (n, (SELECT id FROM categories WHERE name = parent)) RETURNING id
$$;

-- product(name, price, categories[])
CREATE FUNCTION pg_temp.prod(n text, price numeric, cats text[], customizable boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE pid uuid; c text;
BEGIN
  INSERT INTO products (name, price, image_url, is_customizable, customization_price, max_customization_lines, max_customization_images)
  VALUES (n, price, '', customizable, 0, 3, 3) RETURNING id INTO pid;
  FOREACH c IN ARRAY cats LOOP
    INSERT INTO product_categories (product_id, category_id) SELECT pid, id FROM categories WHERE name = c;
  END LOOP;
  RETURN pid;
END $$;

-- attach an option group to a product with values given as 'Name' or 'Name:+price'
CREATE FUNCTION pg_temp.opts(pid uuid, grp text, required boolean, ord int, vals text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE gid uuid; pog uuid; v text; i int := 0;
BEGIN
  INSERT INTO option_groups (name) VALUES (grp)
    ON CONFLICT (lower(name)) DO UPDATE SET updated_at = now() RETURNING id INTO gid;
  INSERT INTO product_option_groups (product_id, option_group_id, is_required, display_order)
    VALUES (pid, gid, required, ord) RETURNING id INTO pog;
  FOREACH v IN ARRAY vals LOOP
    INSERT INTO product_option_values (product_option_group_id, name, price_modifier, display_order)
    VALUES (pog, split_part(v, ':', 1), COALESCE(NULLIF(split_part(v, ':', 2), '')::numeric, 0), i);
    i := i + 1;
  END LOOP;
END $$;

-- ---- categories (two levels where useful) -------------------------------------------------------------
SELECT pg_temp.cat('Mugs');            SELECT pg_temp.cat('Sippers');       SELECT pg_temp.cat('Cushions');
SELECT pg_temp.cat('School Bags');     SELECT pg_temp.cat('Mouse Pads');    SELECT pg_temp.cat('MDF Frames');
SELECT pg_temp.cat('Wall Hangings');   SELECT pg_temp.cat('Kids');          SELECT pg_temp.cat('Metal Sheets');
SELECT pg_temp.cat('T-Shirts');
SELECT pg_temp.cat('Vinyl Printing', 'T-Shirts');
SELECT pg_temp.cat('Sublimation',    'T-Shirts');

-- ---- MUG: one product, the mug type is an option; shapes that are physically different are own products
SELECT pg_temp.opts(pg_temp.prod('Mug', 249, ARRAY['Mugs']), 'Mug Type', true, 0, ARRAY[
  'Plain', 'Heart handle plain:+30', 'Inner colour:+20', 'Magic mug:+100', 'Magic mug inner colour:+120',
  'Heart handle magic mug:+130', 'Golden mug:+150']);
SELECT pg_temp.prod('Pen Holder Mug', 299, ARRAY['Mugs']);
SELECT pg_temp.prod('Pot Holder Mug', 299, ARRAY['Mugs']);

-- ---- SIPPER: separate products
SELECT pg_temp.prod('Sipper Bottle', 399, ARRAY['Sippers']);
SELECT pg_temp.prod('Sports Bottle', 449, ARRAY['Sippers']);

-- ---- CUSHION: each cushion is its own product (own photos/price) ...
SELECT pg_temp.prod(n, p, ARRAY['Cushions']) FROM (VALUES
  ('Heart Fur Cushion', 349), ('Square Fur Cushion', 349), ('LED Heart Fur Cushion', 499), ('LED Square Fur Cushion', 499),
  ('Baby Pillow', 299), ('Album Pillow', 399), ('Satin Pillow', 329), ('Magic Fur Cushion', 449)) AS t(n, p);

-- ---- SCHOOL BAG: ONE product listed under two categories (no duplicate row)
SELECT pg_temp.prod('School Bag', 899, ARRAY['School Bags', 'Kids']);
-- ---- KIDS: the rest
SELECT pg_temp.prod('Tiffin Box', 349, ARRAY['Kids']);
SELECT pg_temp.prod('Pillow Bag', 379, ARRAY['Kids']);
SELECT pg_temp.prod('Magic Pencil Box', 299, ARRAY['Kids']);

-- ---- MOUSE PAD: size is an option
SELECT pg_temp.opts(pg_temp.prod('Mouse Pad', 199, ARRAY['Mouse Pads']), 'Size', true, 0, ARRAY['7.5 inch', '8 inch:+10', '9 inch:+20']);

-- ---- MDF FRAME: frame type + size
DO $$ DECLARE p uuid := pg_temp.prod('MDF Frame', 449, ARRAY['MDF Frames']); BEGIN
  PERFORM pg_temp.opts(p, 'Frame Type', true, 0, ARRAY['Wall frame', 'Wall clock frame:+150', 'Table top frame:-50']);
  PERFORM pg_temp.opts(p, 'Size', true, 1, ARRAY['8x10', '10x12:+80', '12x18:+180']);
END $$;

-- ---- WALL HANGING: the theme is a DESIGN option (could equally be separate products)
SELECT pg_temp.opts(pg_temp.prod('Wall Hanging', 349, ARRAY['Wall Hangings'], false), 'Design', true, 0, ARRAY[
  'General quote', 'Devotional quote', 'Krishna', 'Hanuman Ji', 'Shyam Baba', 'Tea MDF', 'Fast food']);

-- ---- T-SHIRTS: two printing methods = two products (different price/finishes), sharing the T-Shirts parent
DO $$
DECLARE v uuid := pg_temp.prod('Vinyl Printing T-Shirt', 499, ARRAY['Vinyl Printing']);
        s uuid := pg_temp.prod('Sublimation T-Shirt', 449, ARRAY['Sublimation']);
BEGIN
  PERFORM pg_temp.opts(v, 'Size', true, 0, ARRAY['S', 'M', 'L', 'XL:+50']);
  PERFORM pg_temp.opts(v, 'Finish', true, 1, ARRAY['Solid colour', 'Glitters:+100', 'Holographic:+120', 'Reflective:+100',
    'Rainbow reflective:+130', 'Chameleon:+140', 'Blue chameleon:+140', 'Red chameleon:+140', 'HD 0.5 mm:+90']);
  PERFORM pg_temp.opts(s, 'Size', true, 0, ARRAY['S', 'M', 'L', 'XL:+50']);
  PERFORM pg_temp.opts(s, 'Finish', false, 1, ARRAY['Holographic:+120', 'Glitter:+100', 'Rainbow reflector:+130', 'Glow in dark:+110', 'Chameleon:+140']);
END $$;

-- ---- METAL SHEET
SELECT pg_temp.prod('Metal Sheet', 599, ARRAY['Metal Sheets']);

-- ==== verification =====================================================================================
DO $$
DECLARE n int;
BEGIN
  ASSERT (SELECT count(*) FROM categories WHERE parent_id IS NULL) = 10, 'expected 10 top-level categories';
  ASSERT (SELECT count(*) FROM categories WHERE parent_id = (SELECT id FROM categories WHERE name = 'T-Shirts')) = 2, 'T-Shirts should have 2 subcategories';

  ASSERT (SELECT count(*) FROM products WHERE name = 'School Bag') = 1, 'School Bag must be a single product';
  ASSERT (SELECT count(*) FROM product_categories pc JOIN products p ON p.id = pc.product_id WHERE p.name = 'School Bag') = 2, 'School Bag must be in 2 categories';

  -- browsing the parent T-Shirts (tree) finds products of both subcategories
  SELECT count(DISTINCT p.id) INTO n FROM products p JOIN product_categories pc ON pc.product_id = p.id
   WHERE pc.category_id IN (SELECT id FROM categories WHERE name = 'T-Shirts' OR parent_id = (SELECT id FROM categories WHERE name = 'T-Shirts'));
  ASSERT n = 2, 'T-Shirts tree should contain both t-shirt products, got ' || n;

  -- Finish exists on both t-shirts with independent values/prices, and required only on one
  ASSERT (SELECT count(*) FROM product_option_values v JOIN product_option_groups g ON g.id = v.product_option_group_id
            JOIN option_groups og ON og.id = g.option_group_id JOIN products p ON p.id = g.product_id
           WHERE og.name = 'Finish' AND p.name = 'Vinyl Printing T-Shirt') = 9, 'Vinyl finishes';
  ASSERT (SELECT count(*) FROM product_option_values v JOIN product_option_groups g ON g.id = v.product_option_group_id
            JOIN option_groups og ON og.id = g.option_group_id JOIN products p ON p.id = g.product_id
           WHERE og.name = 'Finish' AND p.name = 'Sublimation T-Shirt') = 5, 'Sublimation finishes';
  ASSERT (SELECT is_required FROM product_option_groups g JOIN option_groups og ON og.id = g.option_group_id
           JOIN products p ON p.id = g.product_id WHERE og.name = 'Finish' AND p.name = 'Sublimation T-Shirt') = false, 'Sublimation finish optional';

  -- "Size" is ONE library group reused by several products, each with its own values
  ASSERT (SELECT count(*) FROM option_groups WHERE name = 'Size') = 1, 'Size library group should be shared';
  ASSERT (SELECT count(DISTINCT product_id) FROM product_option_groups g JOIN option_groups og ON og.id = g.option_group_id WHERE og.name = 'Size') = 4, 'Size on 4 products';

  ASSERT (SELECT count(*) FROM product_option_values v JOIN product_option_groups g ON g.id = v.product_option_group_id
           JOIN products p ON p.id = g.product_id WHERE p.name = 'Wall Hanging') = 7, '7 wall hanging designs';
  ASSERT (SELECT count(*) FROM products) = 23, 'expected 23 products, got ' || (SELECT count(*) FROM products);
  ASSERT (SELECT count(DISTINCT slug) FROM products) = 23, 'every product has its own slug';
  RAISE NOTICE 'catalogue model OK: % categories, % products, % option groups, % option values',
    (SELECT count(*) FROM categories), (SELECT count(*) FROM products), (SELECT count(*) FROM product_option_groups), (SELECT count(*) FROM product_option_values);
END $$;

-- category tree, as the storefront would read it
SELECT coalesce(parent.name || ' > ', '') || c.name AS category,
       (SELECT count(*) FROM product_categories pc WHERE pc.category_id = c.id) AS products
  FROM categories c LEFT JOIN categories parent ON parent.id = c.parent_id
 ORDER BY coalesce(parent.name, c.name), parent.name NULLS FIRST, c.name;

ROLLBACK;  -- nothing above is kept
