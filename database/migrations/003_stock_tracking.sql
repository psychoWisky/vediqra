SET client_encoding = 'UTF8';
-- ============================================================================
-- 003_stock_tracking.sql — Phase 3A
--
-- Stock is now enforced by the server, and the two stock fields have ONE consistent meaning:
--
--   product_option_values.stock_quantity   NULL = not tracked (unlimited); a number = units left
--   products.track_stock                   FALSE (default) = made to order, stock_quantity is only informational
--                                          TRUE            = stock_quantity is enforced and decremented
--
-- Existing products keep today's behaviour: the storefront already blocked products with no stock, so
-- every product that exists when this migration first runs is switched to track_stock = TRUE.
-- Idempotent: the backfill only happens when the column is first created.
-- Rollback:  ALTER TABLE products DROP COLUMN track_stock;
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'track_stock') THEN
    ALTER TABLE products ADD COLUMN track_stock BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE products SET track_stock = TRUE;
  END IF;
END $$;

COMMENT ON COLUMN products.track_stock IS 'TRUE: stock_quantity is enforced and decremented on order. FALSE: made to order, not tracked.';
COMMENT ON COLUMN product_option_values.stock_quantity IS 'NULL = not tracked (unlimited). A number is enforced and decremented on order.';
