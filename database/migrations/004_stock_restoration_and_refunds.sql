SET client_encoding = 'UTF8';
-- ============================================================================
-- 004_stock_restoration_and_refunds.sql — Phase 3B
--
-- Why a schema change was needed
--   * Stock restoration: an order's JSON snapshot says what was bought, but NOT what was actually taken out of
--     stock (a product's track_stock or an option's stock can change after the order was placed). To restore
--     "exactly what was decremented, exactly once" the order now records its own stock movements.
--   * Refunds: orders had a single refund_data blob and status 'refunded' for any refund, even a partial one.
--     Refunds are now a list of provider-confirmed entries with a running refunded_amount, so partial and full
--     refunds are distinguishable and duplicate refunds can be refused.
--
-- New columns on orders
--   stock_movements     JSONB   [{"kind":"product"|"option","id":"<uuid>","qty":n}, ...] rows actually decremented
--   stock_restored_at   TIMESTAMPTZ  set once when that stock has been given back (NULL = not restored)
--   refunded_amount     NUMERIC(12,2) sum of provider-confirmed refunds (rupees), 0 <= refunded_amount <= total_amount
--   refunds             JSONB   [{"id","request_id","amount","status","created_at"}, ...]  one entry per refund
-- New order status value: 'partially_refunded' (status is free text, no constraint to change).
--
-- Orders created before this migration have stock_movements = [] : nothing is known to have been decremented
-- for them, so nothing is restored (deliberately conservative).
-- Idempotent: safe to run more than once.
-- Rollback: ALTER TABLE orders DROP CONSTRAINT orders_refund_bounds, DROP COLUMN stock_movements,
--           DROP COLUMN stock_restored_at, DROP COLUMN refunded_amount, DROP COLUMN refunds;
-- ============================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_movements   JSONB          NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_restored_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount   NUMERIC(12,2)  NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunds           JSONB          NOT NULL DEFAULT '[]'::jsonb;

-- Carry forward refunds recorded by the old code (single provider response in refund_data, amount in paise).
UPDATE orders
   SET refunds = jsonb_build_array(jsonb_build_object(
         'id', refund_data->>'id',
         'amount', COALESCE((refund_data->>'amount')::numeric / 100, total_amount),
         'status', COALESCE(refund_data->>'status', 'processed'),
         'created_at', COALESCE(refunded_at, updated_at))),
       refunded_amount = LEAST(total_amount, COALESCE((refund_data->>'amount')::numeric / 100, total_amount))
 WHERE refund_data IS NOT NULL AND refunds = '[]'::jsonb AND refunded_amount = 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_refund_bounds') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_refund_bounds CHECK (refunded_amount >= 0 AND refunded_amount <= total_amount);
  END IF;
END $$;

COMMENT ON COLUMN orders.stock_movements   IS 'Stock actually decremented for this order (products with track_stock, option values with tracked stock). Source of truth for restoration.';
COMMENT ON COLUMN orders.stock_restored_at IS 'Set once when stock_movements were given back (cancellation / full refund). Prevents double restoration.';
COMMENT ON COLUMN orders.refunded_amount   IS 'Total of provider-confirmed refunds, in rupees.';
COMMENT ON COLUMN orders.refunds           IS 'Provider-confirmed refunds: [{id, request_id, amount, status, created_at}].';
