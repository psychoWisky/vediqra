-- ============================================================================
-- VEDIQRA catalogue seed  (Phase 3A)                                   DRAFT — NOT CLIENT-APPROVED
--
-- Creates the category tree, products and product options from the client's rough catalogue list.
-- Read docs/VEDIQRA_CATALOGUE.md first: it explains every modelling assumption and the open questions.
--
-- Run (after schema.sql / migrations):
--     psql -U postgres -d vediqra -v ON_ERROR_STOP=1 -f database/seeds/vediqra_catalogue.sql
--
-- SAFE TO RE-RUN
--   * Insert-only: nothing is ever updated, deleted or truncated. Orders and admin edits are never touched.
--   * Rows are identified by fixed slugs. A category or product that already exists is skipped entirely,
--     including its category links and options, so anything an admin changed or removed stays that way.
--
-- WHAT IS DELIBERATELY EMPTY
--   * PRICES: the client has not supplied any. Every product is created with price 0 AND is_active = false
--     (hidden from the shop). The server also refuses to sell a price-0 item. These are NOT prices.
--     Option price modifiers are 0 for the same reason.
--   * IMAGES: none supplied; image fields are NULL. No GFTD images are reused.
--   * No reviews, fake orders/customers, social-proof counters or statistics.
--     (social_proof_enabled = false; the "N people are viewing this" widget is off.)
--   * Stock is not tracked (made to order): track_stock = false, option stock = NULL.
--
-- To go live per product (admin panel): set the real price, add images, review the options, then activate it.
-- ============================================================================
SET client_encoding = 'UTF8';
BEGIN;

-- ---- helpers (temporary: they vanish with the session) -------------------------------------------------
CREATE FUNCTION pg_temp.seed_category(p_name text, p_slug text, p_parent_slug text, p_order int) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO categories (name, slug, parent_id, display_order, is_active)
  VALUES (p_name, p_slug, (SELECT id FROM categories WHERE slug = p_parent_slug), p_order, true)
  ON CONFLICT (slug) DO NOTHING
$$;

-- Creates the product hidden and unpriced; returns TRUE only if it was created by this run.
CREATE FUNCTION pg_temp.seed_product(p_slug text, p_name text, p_category_slugs text[]) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE pid uuid; c text;
BEGIN
  INSERT INTO products
    (name, slug, price, image_url, is_active, track_stock, stock_quantity, gender,
     social_proof_enabled, is_customizable, customization_price,
     max_customization_lines, max_customization_characters, max_customization_images)
  VALUES
    (p_name, p_slug, 0, NULL, false, false, 0, NULL,
     false, true, 0,
     3, 50, 5)                       -- customization limits are PLACEHOLDERS (see docs)
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO pid;

  IF pid IS NULL THEN RETURN false; END IF;

  FOREACH c IN ARRAY p_category_slugs LOOP
    INSERT INTO product_categories (product_id, category_id)
    SELECT pid, id FROM categories WHERE slug = c
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN true;
END $$;

-- Attach an option group (created in the library if new) and its values.
--   p_values: jsonb array of {"name": "...", "source": "client's original wording if it differed",
--                             "active": false, "meta": {...}}
CREATE FUNCTION pg_temp.seed_options(p_product_slug text, p_group text, p_required boolean, p_group_active boolean,
                                     p_order int, p_values jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE pid uuid; gid uuid; pog uuid; v jsonb; i int := 0;
BEGIN
  SELECT id INTO pid FROM products WHERE slug = p_product_slug;

  INSERT INTO option_groups (name) VALUES (p_group) ON CONFLICT (lower(name)) DO NOTHING;
  SELECT id INTO gid FROM option_groups WHERE lower(name) = lower(p_group);

  INSERT INTO product_option_groups (product_id, option_group_id, is_required, is_active, display_order)
  VALUES (pid, gid, p_required, p_group_active, p_order)
  ON CONFLICT (product_id, option_group_id) DO NOTHING
  RETURNING id INTO pog;
  IF pog IS NULL THEN RETURN; END IF;

  FOR v IN SELECT * FROM jsonb_array_elements(p_values) LOOP
    INSERT INTO product_option_values
      (product_option_group_id, name, price_modifier, stock_quantity, display_order, is_active, metadata)
    VALUES
      (pog, v->>'name', 0, NULL, i, COALESCE((v->>'active')::boolean, true),
       COALESCE(v->'meta', '{}'::jsonb)
         || CASE WHEN v ? 'source' THEN jsonb_build_object('source_wording', v->>'source') ELSE '{}'::jsonb END)
    ON CONFLICT (product_option_group_id, value_key) DO NOTHING;
    i := i + 1;
  END LOOP;
END $$;

-- ---- categories ----------------------------------------------------------------------------------------
-- Ten top-level categories. "T-Shirts" is a parent with two printing-method subcategories
-- (the client listed "Vinyl printing tshirt" and "Sublimation" separately; see docs).
SELECT pg_temp.seed_category('Mug',            'mug',            NULL,        10);
SELECT pg_temp.seed_category('Sipper',         'sipper',         NULL,        20);
SELECT pg_temp.seed_category('Cushion',        'cushion',        NULL,        30);
SELECT pg_temp.seed_category('School Bags',    'school-bags',    NULL,        40);
SELECT pg_temp.seed_category('Mouse Pads',     'mouse-pads',     NULL,        50);
SELECT pg_temp.seed_category('MDF Frames',     'mdf-frames',     NULL,        60);
SELECT pg_temp.seed_category('Wall Hanging',   'wall-hanging',   NULL,        70);
SELECT pg_temp.seed_category('T-Shirts',       't-shirts',       NULL,        80);
SELECT pg_temp.seed_category('Vinyl Printing', 'vinyl-printing', 't-shirts',   81);
SELECT pg_temp.seed_category('Sublimation',    'sublimation',    't-shirts',   82);
SELECT pg_temp.seed_category('Kids',           'kids',           NULL,        90);
SELECT pg_temp.seed_category('Metal Sheet',    'metal-sheet',    NULL,       100);

-- ---- products + options --------------------------------------------------------------------------------
DO $$
BEGIN
  -- MUG: ONE product; the seven mug styles are choices of a "Mug Type" option (ASSUMPTION).
  IF pg_temp.seed_product('mug', 'Mug', ARRAY['mug']) THEN
    PERFORM pg_temp.seed_options('mug', 'Mug Type', true, true, 0, '[
      {"name":"Plain"},{"name":"Heart Handle Plain","source":"Heart handle plain"},
      {"name":"Inner Colour","source":"Inner colour"},{"name":"Magic Mug","source":"Magic mug"},
      {"name":"Magic Mug Inner Colour","source":"Magic mug inner colour"},
      {"name":"Heart Handle Magic Mug","source":"Heart handle magic mug"},{"name":"Golden Mug","source":"Golden mug"}]');
  END IF;
  -- Pen holder / pot holder are different objects, so they are their own products (ASSUMPTION).
  PERFORM pg_temp.seed_product('pen-holder', 'Pen Holder', ARRAY['mug']);
  PERFORM pg_temp.seed_product('pot-holder', 'Pot Holder', ARRAY['mug']);

  -- SIPPER: two different bottles = two products (ASSUMPTION).
  PERFORM pg_temp.seed_product('sipper-bottle', 'Sipper Bottle', ARRAY['sipper']);
  PERFORM pg_temp.seed_product('sports-bottle', 'Sports Bottle', ARRAY['sipper']);

  -- CUSHION: ONE product with a "Cushion Type" option (ASSUMPTION; separate products are the alternative).
  IF pg_temp.seed_product('cushion', 'Cushion', ARRAY['cushion']) THEN
    PERFORM pg_temp.seed_options('cushion', 'Cushion Type', true, true, 0, '[
      {"name":"Heart Fur","source":"Heart Fur"},{"name":"Square Fur","source":"Square fur"},
      {"name":"LED Heart Fur","source":"LED heart Fur"},{"name":"LED Square Fur","source":"LED square fur"},
      {"name":"Baby Pillow","source":"Baby pillow"},{"name":"Album Pillow","source":"Album pillow"},
      {"name":"Satin Pillow","source":"Satin pillow"},{"name":"Magic Fur","source":"Magic fur"}]');
  END IF;

  -- SCHOOL BAG: ONE product, listed under BOTH "School Bags" and "Kids" (no duplicate row).
  PERFORM pg_temp.seed_product('school-bag', 'School Bag', ARRAY['school-bags', 'kids']);

  -- MOUSE PAD: the client wrote "7.5 m to 9 inch" (probably "7.5 inch to 9 inch"). NOT interpreted:
  -- the Size group is attached but switched OFF, with the two ends as inactive values that record the
  -- original wording. CLIENT CONFIRMATION REQUIRED: what sizes exist.
  IF pg_temp.seed_product('mouse-pad', 'Mouse Pad', ARRAY['mouse-pads']) THEN
    PERFORM pg_temp.seed_options('mouse-pad', 'Size', false, false, 0, '[
      {"name":"7.5 inch","source":"7.5 m to 9 inch","active":false,"meta":{"needs_confirmation":true}},
      {"name":"9 inch","source":"7.5 m to 9 inch","active":false,"meta":{"needs_confirmation":true}}]');
  END IF;

  -- MDF FRAME: ONE product with a "Frame Type" option (ASSUMPTION; a wall CLOCK frame may really be a product).
  IF pg_temp.seed_product('mdf-frame', 'MDF Frame', ARRAY['mdf-frames']) THEN
    PERFORM pg_temp.seed_options('mdf-frame', 'Frame Type', true, true, 0, '[
      {"name":"Wall Frame","source":"Wall frame"},{"name":"Wall Clock Frame","source":"Wall clock frame"},
      {"name":"Table Top Frame","source":"Table top frame"}]');
  END IF;

  -- WALL HANGING: ONE product; the seven themes are a "Design" option (ASSUMPTION).
  IF pg_temp.seed_product('wall-hanging', 'Wall Hanging', ARRAY['wall-hanging']) THEN
    PERFORM pg_temp.seed_options('wall-hanging', 'Design', true, true, 0, '[
      {"name":"General Quote","source":"General quote"},{"name":"Devotional Quote","source":"Devotional quote"},
      {"name":"Krishna"},{"name":"Hanuman Ji","source":"Hanuman ji"},{"name":"Shyam Baba","source":"Shyam baba"},
      {"name":"Tea MDF","source":"Tea MDF"},{"name":"Fast Food","source":"Fast food"}]');
  END IF;

  -- VINYL PRINTING T-SHIRT: ONE product; the nine vinyl types are a required "Finish" option.
  -- No size/colour options: the client has not listed any (do not invent them).
  IF pg_temp.seed_product('vinyl-printing-t-shirt', 'Vinyl Printing T-Shirt', ARRAY['vinyl-printing']) THEN
    PERFORM pg_temp.seed_options('vinyl-printing-t-shirt', 'Finish', true, true, 0, '[
      {"name":"Solid Colour","source":"Solid colour"},{"name":"Glitter","source":"Glitters"},
      {"name":"Holographic","source":"Holographic s"},{"name":"Reflective"},
      {"name":"Rainbow Reflective","source":"Rainbow reflective"},{"name":"Chameleon","source":"Chamelom"},
      {"name":"Blue Chameleon","source":"Blue chameleon"},{"name":"Red Chameleon","source":"Red chameloen"},
      {"name":"HD 0.5 mm","source":"HD .5 mm"}]');
  END IF;

  -- SUBLIMATION T-SHIRT: ONE product; "Finish" is OPTIONAL because the client's list starts with the plain
  -- "T-shirt" (ASSUMPTION: no finish = plain sublimation shirt).
  IF pg_temp.seed_product('sublimation-t-shirt', 'Sublimation T-Shirt', ARRAY['sublimation']) THEN
    PERFORM pg_temp.seed_options('sublimation-t-shirt', 'Finish', false, true, 0, '[
      {"name":"Holographic","source":"Holographic s"},{"name":"Glitter"},
      {"name":"Rainbow Reflective","source":"Rainbow reflector"},{"name":"Glow in Dark","source":"Glow in dark"},
      {"name":"Chameleon","source":"Chamelion"}]');
  END IF;

  -- KIDS: the school bag above is shared; these three are own products.
  PERFORM pg_temp.seed_product('tiffin-box', 'Tiffin Box', ARRAY['kids']);
  PERFORM pg_temp.seed_product('pillow-bag', 'Pillow Bag', ARRAY['kids']);
  PERFORM pg_temp.seed_product('magic-pencil-box', 'Magic Pencil Box', ARRAY['kids']);

  -- METAL SHEET
  PERFORM pg_temp.seed_product('metal-sheet', 'Metal Sheet', ARRAY['metal-sheet']);
END $$;

COMMIT;

-- Summary of what exists now
SELECT (SELECT count(*) FROM categories)                                         AS categories,
       (SELECT count(*) FROM products)                                           AS products,
       (SELECT count(*) FROM products WHERE is_active)                           AS active_products,
       (SELECT count(*) FROM product_option_groups)                              AS option_groups_attached,
       (SELECT count(*) FROM product_option_values)                              AS option_values;
