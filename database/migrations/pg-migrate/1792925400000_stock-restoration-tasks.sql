-- Durable stock-restoration tasks.
--
-- A FULL admin refund gives the order's stock back (existing business rule; partial refunds and automatic stock-failure refunds
-- never do: the latter never took any stock). That used to happen in a separate step after the refund settled, so a crash
-- between the two left the order refunded and the stock missing, with nothing to retry it. Now the task is inserted in the SAME
-- transaction that settles the refund and updates the order, and a worker finishes it. The restoration itself stays idempotent
-- through orders.stock_restored_at (set under the order row lock, in the same transaction that returns the stock).
--
-- Nothing in `orders` or any existing table is altered. Orders refunded before this migration get no task (history untouched).

-- Up Migration

CREATE TABLE stock_restoration_tasks (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id                 UUID NOT NULL UNIQUE REFERENCES orders (id) ON DELETE RESTRICT,   -- at most one task per order
    admin_refund_request_id  UUID REFERENCES admin_refund_requests (id) ON DELETE RESTRICT,
    status                   TEXT NOT NULL DEFAULT 'queued',
    attempts                 INTEGER NOT NULL DEFAULT 0,
    lease_until              TIMESTAMPTZ,
    next_attempt_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error               TEXT,
    result                   TEXT,                                  -- 'restored' | 'already restored' | 'nothing was decremented' ...
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at             TIMESTAMPTZ,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT srt_status_valid CHECK (status IN ('queued','restoring','done','needs_review')),
    CONSTRAINT srt_done_complete CHECK ((status = 'done') = (completed_at IS NOT NULL)),
    CONSTRAINT srt_restoring_has_lease CHECK (status <> 'restoring' OR lease_until IS NOT NULL),
    CONSTRAINT srt_attempts_valid CHECK (attempts >= 0),
    CONSTRAINT srt_text_lengths CHECK (char_length(coalesce(last_error, '')) <= 500 AND char_length(coalesce(result, '')) <= 200)
);

CREATE INDEX idx_srt_due ON stock_restoration_tasks (next_attempt_at) WHERE status IN ('queued','restoring');

COMMENT ON TABLE stock_restoration_tasks IS 'Stock to give back after a full refund. Inserted in the transaction that settles the refund; completed in the transaction that returns the stock.';

CREATE FUNCTION stock_restoration_tasks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.created_at <> OLD.created_at
     OR NEW.admin_refund_request_id IS DISTINCT FROM OLD.admin_refund_request_id THEN
    RAISE EXCEPTION 'stock_restoration_tasks: id, order and source refund are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'done' AND NEW.status <> 'done' THEN
    RAISE EXCEPTION 'stock_restoration_tasks: a completed task cannot be reopened' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'stock_restoration_tasks: attempts can only increase' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_stock_restoration_tasks_guard BEFORE UPDATE ON stock_restoration_tasks
  FOR EACH ROW EXECUTE FUNCTION stock_restoration_tasks_guard();

-- Down Migration
-- Destructive: drops the task ledger (pending restorations would be forgotten). Only for disposable databases or before use.

DROP TABLE IF EXISTS stock_restoration_tasks;
DROP FUNCTION IF EXISTS stock_restoration_tasks_guard();
