-- Admin refunds join the durable refund workflow.
--
-- Until now the admin refund endpoint called Razorpay inside a request and recorded whatever came back, so a refund that
-- Razorpay reported as `pending` was already counted as refunded, and a lost answer left no trace. Each admin refund is now a
-- row here, committed BEFORE the provider is called, with a stable idempotency key and an immutable request, and settled
-- by the same kind of state machine as the stock-failure refunds (see payment_refund_attempts).
--
-- Nothing in `orders` or any existing table is altered.

-- Up Migration

CREATE TABLE admin_refund_requests (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id             UUID NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
    razorpay_payment_id  TEXT NOT NULL,
    request_id           TEXT,                               -- the admin's own retry token (unique per order)
    requested_by         TEXT,
    reason               TEXT,
    amount_paise         BIGINT NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'INR',

    idempotency_key      TEXT NOT NULL UNIQUE,               -- sent as X-Refund-Idempotency on EVERY try
    receipt              TEXT NOT NULL UNIQUE,               -- our marker at the provider, for reconciliation

    status               TEXT NOT NULL DEFAULT 'queued',
    provider_refund_id   TEXT UNIQUE,
    provider_status      TEXT,
    attempts             INTEGER NOT NULL DEFAULT 0,
    lease_until          TIMESTAMPTZ,
    next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at      TIMESTAMPTZ,
    settled_at           TIMESTAMPTZ,
    last_error_kind      TEXT,
    last_error           TEXT,
    review_reason        TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT arr_status_valid CHECK (status IN ('queued','submitting','unknown','pending','processed','failed','needs_review')),
    CONSTRAINT arr_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{10,100}$'),
    CONSTRAINT arr_receipt_format CHECK (char_length(receipt) BETWEEN 1 AND 40),
    CONSTRAINT arr_payment_id_format CHECK (razorpay_payment_id ~ '^[A-Za-z0-9_-]{3,64}$'),
    CONSTRAINT arr_provider_refund_id_format CHECK (provider_refund_id IS NULL OR provider_refund_id ~ '^[A-Za-z0-9_-]{3,64}$'),
    CONSTRAINT arr_amount_valid CHECK (amount_paise BETWEEN 1 AND 10000000000),
    CONSTRAINT arr_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT arr_attempts_valid CHECK (attempts >= 0),
    CONSTRAINT arr_provider_status_valid CHECK (provider_status IS NULL OR provider_status IN ('pending','processed','failed')),
    CONSTRAINT arr_text_lengths CHECK (char_length(coalesce(last_error, '')) <= 500 AND char_length(coalesce(review_reason, '')) <= 300
        AND char_length(coalesce(reason, '')) <= 500 AND char_length(coalesce(request_id, '')) <= 100),
    -- "processed" is only ever a fact the provider confirmed
    CONSTRAINT arr_processed_confirmed CHECK (status <> 'processed' OR (provider_refund_id IS NOT NULL AND provider_status = 'processed' AND settled_at IS NOT NULL)),
    CONSTRAINT arr_pending_has_refund CHECK (status <> 'pending' OR (provider_refund_id IS NOT NULL AND provider_status = 'pending')),
    CONSTRAINT arr_failed_settled CHECK (status <> 'failed' OR settled_at IS NOT NULL),
    CONSTRAINT arr_submitting_has_lease CHECK (status <> 'submitting' OR lease_until IS NOT NULL),
    CONSTRAINT arr_review_has_reason CHECK (status <> 'needs_review' OR review_reason IS NOT NULL)
);

CREATE UNIQUE INDEX uq_arr_order_request_id ON admin_refund_requests (order_id, request_id) WHERE request_id IS NOT NULL;
-- At most ONE unresolved admin refund per order: a new refund cannot start while an earlier one is still uncertain.
CREATE UNIQUE INDEX uq_arr_one_unresolved_per_order ON admin_refund_requests (order_id)
  WHERE status IN ('queued','submitting','unknown','pending','needs_review');
CREATE INDEX idx_arr_due ON admin_refund_requests (next_attempt_at) WHERE status IN ('queued','submitting','unknown','pending');
CREATE INDEX idx_arr_payment ON admin_refund_requests (razorpay_payment_id);

COMMENT ON TABLE admin_refund_requests IS 'Durable admin refunds. The row is committed BEFORE any provider call; idempotency_key and the request never change across retries.';

CREATE FUNCTION admin_refund_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o_total BIGINT;
  committed_paise BIGINT;
  already_paise BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'admin_refund_requests: a refund request must start queued with zero submissions' USING ERRCODE = 'check_violation';
    END IF;
    -- serialise with every other refund on this order, then cap: legacy-recorded + live/processed requests <= order total
    SELECT round(total_amount * 100), round(refunded_amount * 100) INTO o_total, already_paise FROM orders WHERE id = NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'admin_refund_requests: unknown order' USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- processed requests are already inside orders.refunded_amount; count only the not-yet-processed ones separately
    SELECT COALESCE(SUM(amount_paise), 0) INTO committed_paise FROM admin_refund_requests
      WHERE order_id = NEW.order_id AND status IN ('queued','submitting','unknown','pending','needs_review');
    IF already_paise + committed_paise + NEW.amount_paise > o_total THEN
      RAISE EXCEPTION 'admin_refund_requests: refunds for this order would exceed its total' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.razorpay_payment_id <> OLD.razorpay_payment_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.receipt <> OLD.receipt
     OR NEW.amount_paise <> OLD.amount_paise OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
     OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'admin_refund_requests: order, payment, key, receipt, amount and request id are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'admin_refund_requests: the provider refund id is write-once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'admin_refund_requests: submissions can only increase' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued'       AND NEW.status IN ('submitting','failed','needs_review'))
    OR (OLD.status = 'submitting'   AND NEW.status IN ('unknown','pending','processed','failed','needs_review'))
    OR (OLD.status = 'unknown'      AND NEW.status IN ('submitting','pending','processed','failed','needs_review'))
    OR (OLD.status = 'pending'      AND NEW.status IN ('submitting','processed','failed','needs_review'))
    OR (OLD.status = 'needs_review' AND NEW.status IN ('submitting','processed','failed'))
  ) THEN
    RAISE EXCEPTION 'admin_refund_requests: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('processed','failed') AND (NEW.provider_status IS DISTINCT FROM OLD.provider_status OR NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION 'admin_refund_requests: a settled request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_admin_refund_requests_guard BEFORE INSERT OR UPDATE ON admin_refund_requests
  FOR EACH ROW EXECUTE FUNCTION admin_refund_requests_guard();

-- Down Migration
-- Destructive: drops the admin refund ledger. Only for disposable databases or before any admin refund used it.

DROP TABLE IF EXISTS admin_refund_requests;
DROP FUNCTION IF EXISTS admin_refund_requests_guard();
