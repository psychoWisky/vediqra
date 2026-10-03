'use strict';

// Phase 4E baseline migration.
//
// This is the FIRST migration tracked by node-pg-migrate. It represents the schema that already
// existed in the VEDIQRA database before this migration tool was introduced (the same schema
// database/schema.sql describes, which in turn already incorporates migrations/001-005 — see
// database/migrations/README.md).
//
// Up: executes database/schema.sql verbatim. On a FRESH, empty database this builds the entire
// schema from nothing. On the real VEDIQRA database, this migration is never actually executed —
// it is marked as already-applied via `--fake` (see docs/DATABASE_MIGRATIONS.md, "Existing database
// adoption"), so this code path only ever runs against fresh/disposable databases in practice.
//
// Down: drops everything this migration would have created. Intentionally destructive — safe only
// on a disposable database, never on one with real data. There is no "down" path for the real
// VEDIQRA database because this migration is never "up" there in the first place (it was faked).

const fs = require('fs');
const path = require('path');

const SCHEMA_SQL_PATH = path.join(__dirname, '..', '..', 'schema.sql');

exports.up = (pgm) => {
  const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');
  pgm.sql(schemaSql);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS
      admin_users, site_settings, popup_display_stats, popup_config, logo_config, hero_content,
      social_proof_stats, reviews, coupon_usage, coupons, order_items, orders,
      custom_combo_products, custom_combos, combo_categories, combo_products, combos,
      product_option_values, product_option_groups, option_groups,
      product_sizes, product_colors, product_categories, products, categories, genders
    CASCADE;
    DROP FUNCTION IF EXISTS assign_option_value_key() CASCADE;
    DROP FUNCTION IF EXISTS categories_check_hierarchy() CASCADE;
    DROP FUNCTION IF EXISTS assign_slug_from_name() CASCADE;
    DROP FUNCTION IF EXISTS unique_slug(text, text) CASCADE;
    DROP FUNCTION IF EXISTS slugify(text) CASCADE;
    DROP SEQUENCE IF EXISTS order_number_seq;
  `);
};
