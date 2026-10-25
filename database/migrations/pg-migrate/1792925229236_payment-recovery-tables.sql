-- Payment recovery, Phase 1: schema only (no application code uses these tables yet).
--
-- Adds four tables that let a captured Razorpay payment be turned into exactly one order (or exactly one refund)
-- even if the customer's browser never comes back:
--   payment_intents          one row per checkout: an immutable server-side snapshot of what was priced and who
--                            is buying, keyed to its Razorpay order
--   payment_webhook_events   one row per Razorpay webhook event id (idempotency + audit; ids and outcomes only)
--   payment_refund_attempts  durable refund attempts with a stable provider idempotency key
--   notification_outbox      retryable e-mails (no addresses stored; resolved from the order/intent at send time)
--
-- Nothing in `orders`, `coupons`, stock or any other existing table is altered, and no existing row is touched.
-- Historical COD orders are therefore unaffected.
--
-- What the database enforces here (everything else is application code):
--   * state vocabularies and the allowed state transitions (terminal states cannot be downgraded)
--   * the checkout snapshot cannot change once an intent leaves `preparing` (sole exception: the retention scrub)
--   * write-once identifiers (Razorpay order id, payment id, order id, idempotency keys, refund amounts)
--   * one Razorpay order / payment / order / event per row (unique), and a snapshot whose total equals the amount charged
--   * `fulfilled` needs an order that really carries the same payment id and amount
--   * `refunded` needs processed refund attempts covering the whole amount; `processed` needs a provider refund id
--   * at most one live stock-failure refund attempt per intent, and refund attempts can never exceed the amount captured
--
-- RETENTION (nothing here deletes anything; these are the queries a later, reviewed cleanup job would use).
-- Default target 90 days for operational records, subject to legal / accounting / dispute / refund / audit needs.
--   Intents whose personal data can be scrubbed (the order row keeps its own copy; refund attempts keep ids and amounts):
--     SELECT id FROM payment_intents
--      WHERE status IN ('fulfilled','refunded') AND scrubbed_at IS NULL AND updated_at < now() - interval '90 days';
--     -- scrub = UPDATE ... SET quote = '{"scrubbed":true}', customer = '{"scrubbed":true}', coupon_code = NULL,
--     --                        status_token_hash = NULL, scrubbed_at = now()   (the trigger allows exactly this)
--   Webhook events (ids and outcomes only, no personal data):
--     SELECT event_id FROM payment_webhook_events WHERE processed_at IS NOT NULL AND received_at < now() - interval '90 days';
--   Outbox rows that are finished:
--     SELECT id FROM notification_outbox WHERE status IN ('sent','skipped','failed') AND updated_at < now() - interval '90 days';
--   Refund attempts and un-scrubbed financial rows are NOT cleanup candidates: they are the audit trail of money moved.

-- Up Migration

-- =====================================================================================================================
-- payment_intents
-- =====================================================================================================================
CREATE TABLE payment_intents (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Browser-supplied Idempotency-Key for create-order (NULL for legacy-origin rows). A repeat with the same key and
    -- the same snapshot_hash returns this intent; the same key with a different hash is a conflict (application check).
    idempotency_key      TEXT UNIQUE,
    snapshot_hash        TEXT NOT NULL,                      -- sha256 (hex) of the canonical cart + customer + coupon

    origin               TEXT NOT NULL DEFAULT 'checkout',   -- 'legacy' = created at fulfilment by the time-boxed fallback
    status               TEXT NOT NULL DEFAULT 'preparing',

    razorpay_order_id    TEXT UNIQUE,                        -- attached during preparation; one intent per Razorpay order
    amount_paise         BIGINT NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'INR',

    -- The server's own price snapshot (CartQuote) and the validated customer details. Never taken from the browser
    -- at recovery time. Immutable once the intent leaves `preparing`.
    quote                JSONB NOT NULL,
    customer             JSONB NOT NULL,
    coupon_code          TEXT,

    status_token_hash    TEXT,                               -- sha256 of the customer's status token (the token itself is never stored)

    razorpay_payment_id  TEXT UNIQUE,                        -- the captured payment; one intent per payment
    payment_method       TEXT,                               -- upi / card / ... (not personal data)
    captured_at          TIMESTAMPTZ,
    order_id             UUID UNIQUE REFERENCES orders (id) ON DELETE RESTRICT,
    fulfilled_at         TIMESTAMPTZ,

    failed_attempts      INTEGER NOT NULL DEFAULT 0,         -- payment.failed events seen (informational)
    last_failure_code    TEXT,

    review_reason        TEXT,                               -- why it needs an administrator
    reviewed_at          TIMESTAMPTZ,
    resolution_note      TEXT,
    last_error           TEXT,                               -- safe, truncated; never provider payloads or secrets

    last_checked_at      TIMESTAMPTZ,                        -- recovery job bookkeeping
    next_check_at        TIMESTAMPTZ,
    check_failures       INTEGER NOT NULL DEFAULT 0,

    scrubbed_at          TIMESTAMPTZ,                        -- personal data removed by the retention job
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pi_status_valid CHECK (status IN ('preparing','created','fulfilled','refund_required','refunded','needs_review','abandoned')),
    CONSTRAINT pi_origin_valid CHECK (origin IN ('checkout','legacy')),
    CONSTRAINT pi_idempotency_key_format CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    CONSTRAINT pi_snapshot_hash_format CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT pi_rzp_order_id_format CHECK (razorpay_order_id IS NULL OR razorpay_order_id ~ '^[A-Za-z0-9_-]{3,64}$'),
    CONSTRAINT pi_rzp_payment_id_format CHECK (razorpay_payment_id IS NULL OR razorpay_payment_id ~ '^[A-Za-z0-9_-]{3,64}$'),
    CONSTRAINT pi_token_hash_format CHECK (status_token_hash IS NULL OR status_token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT pi_amount_valid CHECK (amount_paise BETWEEN 100 AND 10000000000),
    CONSTRAINT pi_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT pi_counters_valid CHECK (failed_attempts >= 0 AND check_failures >= 0),
    CONSTRAINT pi_text_lengths CHECK (
        char_length(coalesce(last_error, '')) <= 500 AND char_length(coalesce(review_reason, '')) <= 300
        AND char_length(coalesce(resolution_note, '')) <= 2000 AND char_length(coalesce(last_failure_code, '')) <= 120
        AND char_length(coalesce(payment_method, '')) <= 32),
    CONSTRAINT pi_quote_is_object CHECK (jsonb_typeof(quote) = 'object'),
    CONSTRAINT pi_customer_is_object CHECK (jsonb_typeof(customer) = 'object'),
    -- The snapshot must describe exactly what was charged, and carry what an order needs (unless scrubbed later).
    CONSTRAINT pi_quote_total_matches_amount CHECK (scrubbed_at IS NOT NULL OR CASE
        WHEN jsonb_typeof(quote -> 'total_amount') = 'number' THEN round((quote ->> 'total_amount')::numeric * 100) = amount_paise
        ELSE false END),
    CONSTRAINT pi_quote_shape CHECK (scrubbed_at IS NOT NULL OR (
        quote ?& ARRAY['items','stock','subtotal','total_amount']
        AND CASE WHEN jsonb_typeof(quote -> 'items') = 'array' THEN jsonb_array_length(quote -> 'items') > 0 ELSE false END)),
    CONSTRAINT pi_customer_shape CHECK (scrubbed_at IS NOT NULL OR customer ?& ARRAY['name','email','phone','address','city','state','pincode']),
    -- State / identifier consistency
    CONSTRAINT pi_has_rzp_order CHECK (status IN ('preparing','abandoned') OR razorpay_order_id IS NOT NULL),
    CONSTRAINT pi_payment_implies_rzp_order CHECK (razorpay_payment_id IS NULL OR razorpay_order_id IS NOT NULL),
    CONSTRAINT pi_order_iff_fulfilled CHECK ((status = 'fulfilled') = (order_id IS NOT NULL)),
    CONSTRAINT pi_fulfilled_complete CHECK (status <> 'fulfilled' OR (razorpay_payment_id IS NOT NULL AND captured_at IS NOT NULL AND fulfilled_at IS NOT NULL)),
    CONSTRAINT pi_refund_has_payment CHECK (status NOT IN ('refund_required','refunded') OR (razorpay_payment_id IS NOT NULL AND captured_at IS NOT NULL)),
    CONSTRAINT pi_review_has_reason CHECK (status <> 'needs_review' OR review_reason IS NOT NULL),
    CONSTRAINT pi_scrub_only_when_terminal CHECK (scrubbed_at IS NULL OR status IN ('fulfilled','refunded')),
    -- lets payment_refund_attempts reference (intent, payment) as a pair
    CONSTRAINT pi_id_payment_unique UNIQUE (id, razorpay_payment_id)
);

CREATE INDEX idx_pi_open_by_status ON payment_intents (status, created_at) WHERE status NOT IN ('fulfilled','refunded');
CREATE INDEX idx_pi_recovery_due ON payment_intents (next_check_at) WHERE status IN ('created','abandoned');
CREATE INDEX idx_pi_created_at ON payment_intents (created_at);
CREATE INDEX idx_pi_retention ON payment_intents (updated_at) WHERE status IN ('fulfilled','refunded') AND scrubbed_at IS NULL;

COMMENT ON TABLE payment_intents IS 'One row per online checkout: the immutable server-side snapshot behind a Razorpay order. Source of truth for recovering a payment whose browser never returned.';
COMMENT ON COLUMN payment_intents.quote IS 'CartQuote JSON computed by the server at create-order time. Never replaced by browser input; immutable after preparing (except the retention scrub).';
COMMENT ON COLUMN payment_intents.status_token_hash IS 'sha256 of the status token given to the buyer''s browser; the token is not stored.';

-- Guard: write-once identifiers, snapshot immutability, the allowed state machine, and the cross-table financial invariants.
CREATE FUNCTION payment_intents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  refunded_paise BIGINT;
  newly_fulfilled BOOLEAN;
  newly_refunded BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin = 'checkout' AND NEW.status <> 'preparing' THEN
      RAISE EXCEPTION 'payment_intents: a checkout intent must start in state preparing' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR NEW.origin <> OLD.origin THEN
      RAISE EXCEPTION 'payment_intents: id, created_at and origin are immutable' USING ERRCODE = 'check_violation';
    END IF;

    -- write-once: once a value is set it can never change (the Razorpay order id may be attached while preparing, once)
    IF (OLD.razorpay_order_id   IS NOT NULL AND NEW.razorpay_order_id   IS DISTINCT FROM OLD.razorpay_order_id)
    OR (OLD.razorpay_payment_id IS NOT NULL AND NEW.razorpay_payment_id IS DISTINCT FROM OLD.razorpay_payment_id)
    OR (OLD.captured_at         IS NOT NULL AND NEW.captured_at         IS DISTINCT FROM OLD.captured_at)
    OR (OLD.order_id            IS NOT NULL AND NEW.order_id            IS DISTINCT FROM OLD.order_id)
    OR (OLD.fulfilled_at        IS NOT NULL AND NEW.fulfilled_at        IS DISTINCT FROM OLD.fulfilled_at)
    OR (OLD.scrubbed_at         IS NOT NULL AND NEW.scrubbed_at         IS DISTINCT FROM OLD.scrubbed_at) THEN
      RAISE EXCEPTION 'payment_intents: razorpay ids, capture/fulfilment times, order id and scrub time are write-once' USING ERRCODE = 'check_violation';
    END IF;

    -- the checkout snapshot is frozen as soon as the intent leaves 'preparing': it cannot change in the same UPDATE
    -- that leaves it either, so what was committed while preparing is exactly what the buyer pays for
    IF OLD.status <> 'preparing' OR NEW.status <> 'preparing' THEN
      IF NEW.amount_paise <> OLD.amount_paise OR NEW.currency <> OLD.currency OR NEW.snapshot_hash <> OLD.snapshot_hash
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
        RAISE EXCEPTION 'payment_intents: amount, currency, snapshot hash and idempotency key are frozen after preparing' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.quote IS DISTINCT FROM OLD.quote OR NEW.customer IS DISTINCT FROM OLD.customer
         OR NEW.coupon_code IS DISTINCT FROM OLD.coupon_code OR NEW.status_token_hash IS DISTINCT FROM OLD.status_token_hash THEN
        -- the one exception: the retention scrub of a finished intent (sets scrubbed_at in the same statement)
        IF NOT (OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL AND OLD.status IN ('fulfilled','refunded') AND NEW.status = OLD.status) THEN
          RAISE EXCEPTION 'payment_intents: the checkout snapshot cannot change after preparing' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;

    -- state machine: terminal states (fulfilled, refunded) never move; 'abandoned' may still be revived by a late payment
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'preparing'       AND NEW.status IN ('created','abandoned'))
      OR (OLD.status = 'created'         AND NEW.status IN ('fulfilled','refund_required','needs_review','abandoned'))
      OR (OLD.status = 'abandoned'       AND NEW.status IN ('fulfilled','refund_required','needs_review'))
      OR (OLD.status = 'needs_review'    AND NEW.status IN ('fulfilled','refund_required','refunded'))
      OR (OLD.status = 'refund_required' AND NEW.status IN ('refunded','needs_review'))
    ) THEN
      RAISE EXCEPTION 'payment_intents: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (computed first: a CASE ... THEN inside an IF condition would end the condition early in PL/pgSQL)
  newly_fulfilled := NEW.status = 'fulfilled' AND CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD.status <> 'fulfilled' END;
  newly_refunded  := NEW.status = 'refunded'  AND CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD.status <> 'refunded'  END;

  -- fulfilled: the order must really carry this payment and this amount
  IF newly_fulfilled THEN
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    IF NOT FOUND OR o.razorpay_payment_id IS DISTINCT FROM NEW.razorpay_payment_id
       OR o.razorpay_order_id IS DISTINCT FROM NEW.razorpay_order_id
       OR o.payment_method <> 'online' OR round(o.total_amount * 100) <> NEW.amount_paise THEN
      RAISE EXCEPTION 'payment_intents: the order does not match this payment (payment id, Razorpay order, method or amount)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- refunded: processed refund attempts must already cover the whole captured amount
  IF newly_refunded THEN
    SELECT COALESCE(SUM(amount_paise), 0) INTO refunded_paise
      FROM payment_refund_attempts WHERE intent_id = NEW.id AND status = 'processed';
    IF refunded_paise < NEW.amount_paise THEN
      RAISE EXCEPTION 'payment_intents: cannot be marked refunded before processed refund attempts cover the amount' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_payment_intents_guard BEFORE INSERT OR UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payment_intents_guard();

-- =====================================================================================================================
-- payment_webhook_events
-- =====================================================================================================================
CREATE TABLE payment_webhook_events (
    event_id             TEXT PRIMARY KEY,                   -- Razorpay x-razorpay-event-id: the idempotency key
    event_type           TEXT NOT NULL,
    razorpay_order_id    TEXT,
    razorpay_payment_id  TEXT,
    intent_id            UUID REFERENCES payment_intents (id) ON DELETE SET NULL,
    event_created_at     TIMESTAMPTZ,                        -- Razorpay's own timestamp for the event
    received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts             INTEGER NOT NULL DEFAULT 1,
    processed_at         TIMESTAMPTZ,
    outcome              TEXT,
    last_error           TEXT,                               -- safe, truncated; no payloads
    CONSTRAINT pwe_event_id_format CHECK (char_length(event_id) BETWEEN 1 AND 128),
    CONSTRAINT pwe_event_type_format CHECK (event_type ~ '^[A-Za-z0-9_.]{1,80}$'),
    CONSTRAINT pwe_rzp_ids_format CHECK (
        (razorpay_order_id IS NULL OR razorpay_order_id ~ '^[A-Za-z0-9_-]{3,64}$')
        AND (razorpay_payment_id IS NULL OR razorpay_payment_id ~ '^[A-Za-z0-9_-]{3,64}$')),
    CONSTRAINT pwe_attempts_valid CHECK (attempts >= 1),
    CONSTRAINT pwe_outcome_valid CHECK (outcome IS NULL OR outcome IN ('applied','noop','ignored','needs_review','unknown_order')),
    -- processed and outcome are one fact: an event cannot be "processed" without recording what happened
    CONSTRAINT pwe_processed_iff_outcome CHECK ((processed_at IS NULL) = (outcome IS NULL)),
    CONSTRAINT pwe_error_length CHECK (char_length(coalesce(last_error, '')) <= 500)
);

CREATE INDEX idx_pwe_order ON payment_webhook_events (razorpay_order_id);
CREATE INDEX idx_pwe_payment ON payment_webhook_events (razorpay_payment_id);
CREATE INDEX idx_pwe_intent ON payment_webhook_events (intent_id);
CREATE INDEX idx_pwe_received ON payment_webhook_events (received_at);
CREATE INDEX idx_pwe_unprocessed ON payment_webhook_events (received_at) WHERE processed_at IS NULL;

COMMENT ON TABLE payment_webhook_events IS 'Webhook delivery log keyed by Razorpay event id. Stores ids and outcomes only: never the raw payload, card data, UPI ids or customer contact details.';

CREATE FUNCTION payment_webhook_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id <> OLD.event_id OR NEW.event_type <> OLD.event_type OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'payment_webhook_events: event id, type and receipt time are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.processed_at IS NOT NULL AND (NEW.processed_at IS DISTINCT FROM OLD.processed_at OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'payment_webhook_events: a processed event cannot be un-processed or re-labelled' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'payment_webhook_events: attempts can only increase' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_payment_webhook_events_guard BEFORE UPDATE ON payment_webhook_events
  FOR EACH ROW EXECUTE FUNCTION payment_webhook_events_guard();

-- =====================================================================================================================
-- payment_refund_attempts
-- =====================================================================================================================
CREATE TABLE payment_refund_attempts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id            UUID NOT NULL,
    razorpay_payment_id  TEXT NOT NULL,
    purpose              TEXT NOT NULL DEFAULT 'stock_failure',

    -- Sent to Razorpay as X-Refund-Idempotency on EVERY try of this attempt, with an identical body (amount, receipt, notes).
    idempotency_key      TEXT NOT NULL UNIQUE,
    receipt              TEXT NOT NULL UNIQUE,               -- our marker on the provider side, for reconciliation by listing refunds
    amount_paise         BIGINT NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'INR',

    status               TEXT NOT NULL DEFAULT 'queued',
    provider_refund_id   TEXT UNIQUE,
    provider_status      TEXT,                               -- what Razorpay last reported: pending / processed / failed
    attempts             INTEGER NOT NULL DEFAULT 0,         -- provider submissions made
    lease_until          TIMESTAMPTZ,                        -- a worker's claim; expires if the worker dies
    next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at      TIMESTAMPTZ,
    submitted_at         TIMESTAMPTZ,
    settled_at           TIMESTAMPTZ,
    last_error_kind      TEXT,
    last_error           TEXT,                               -- safe, truncated
    review_reason        TEXT,
    resolved_at          TIMESTAMPTZ,
    resolution_note      TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pra_intent_payment_fk FOREIGN KEY (intent_id, razorpay_payment_id)
        REFERENCES payment_intents (id, razorpay_payment_id) ON DELETE RESTRICT,
    CONSTRAINT pra_purpose_valid CHECK (purpose IN ('stock_failure','manual_review')),
    CONSTRAINT pra_status_valid CHECK (status IN ('queued','submitting','unknown','pending','processed','failed','needs_review')),
    CONSTRAINT pra_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{10,100}$'),
    CONSTRAINT pra_receipt_format CHECK (char_length(receipt) BETWEEN 1 AND 40),
    CONSTRAINT pra_rzp_payment_id_format CHECK (razorpay_payment_id ~ '^[A-Za-z0-9_-]{3,64}$'),
    CONSTRAINT pra_provider_refund_id_format CHECK (provider_refund_id IS NULL OR provider_refund_id ~ '^[A-Za-z0-9_-]{3,64}$'),
    CONSTRAINT pra_amount_valid CHECK (amount_paise BETWEEN 1 AND 10000000000),
    CONSTRAINT pra_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT pra_attempts_valid CHECK (attempts >= 0),
    CONSTRAINT pra_provider_status_valid CHECK (provider_status IS NULL OR provider_status IN ('pending','processed','failed')),
    CONSTRAINT pra_text_lengths CHECK (char_length(coalesce(last_error, '')) <= 500 AND char_length(coalesce(review_reason, '')) <= 300
        AND char_length(coalesce(resolution_note, '')) <= 2000 AND char_length(coalesce(last_error_kind, '')) <= 40),
    -- "processed" is only ever a fact the provider confirmed: a refund id, provider status processed and a settle time.
    -- Submitting a request is NOT enough.
    CONSTRAINT pra_processed_confirmed CHECK (status <> 'processed' OR (provider_refund_id IS NOT NULL AND provider_status = 'processed' AND settled_at IS NOT NULL)),
    CONSTRAINT pra_pending_has_refund CHECK (status <> 'pending' OR (provider_refund_id IS NOT NULL AND provider_status = 'pending')),
    CONSTRAINT pra_failed_settled CHECK (status <> 'failed' OR settled_at IS NOT NULL),
    CONSTRAINT pra_submitting_has_lease CHECK (status <> 'submitting' OR lease_until IS NOT NULL),
    CONSTRAINT pra_review_has_reason CHECK (status <> 'needs_review' OR review_reason IS NOT NULL)
);

-- At most ONE live stock-failure refund per intent: every state except "failed" (a refund the provider definitively
-- refused) occupies the slot, including "processed" (so a second refund is impossible) and "needs_review".
CREATE UNIQUE INDEX uq_pra_one_live_stock_failure_refund ON payment_refund_attempts (intent_id)
  WHERE purpose = 'stock_failure' AND status <> 'failed';
CREATE INDEX idx_pra_due ON payment_refund_attempts (next_attempt_at) WHERE status IN ('queued','unknown','pending','submitting');
CREATE INDEX idx_pra_review ON payment_refund_attempts (created_at) WHERE status = 'needs_review';
CREATE INDEX idx_pra_intent ON payment_refund_attempts (intent_id);
CREATE INDEX idx_pra_payment ON payment_refund_attempts (razorpay_payment_id);

COMMENT ON TABLE payment_refund_attempts IS 'Durable refund workflow. The row is committed BEFORE any provider call; idempotency_key and the request body never change across retries.';
COMMENT ON COLUMN payment_refund_attempts.status IS 'queued -> submitting -> pending|processed|failed; unknown = the provider call had an uncertain outcome (reconcile before resending); needs_review = a human must decide.';

CREATE FUNCTION payment_refund_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i payment_intents%ROWTYPE;
  committed_paise BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Lock the intent so two simultaneous inserts for it are checked one after the other.
    SELECT * INTO i FROM payment_intents WHERE id = NEW.intent_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment_refund_attempts: unknown intent' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.status <> 'queued' OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'payment_refund_attempts: a refund attempt must start queued with zero submissions' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.currency <> i.currency THEN
      RAISE EXCEPTION 'payment_refund_attempts: currency differs from the captured payment' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.purpose = 'stock_failure' THEN
      IF i.status <> 'refund_required' OR NEW.amount_paise <> i.amount_paise THEN
        RAISE EXCEPTION 'payment_refund_attempts: a stock-failure refund needs an intent in refund_required and refunds the full captured amount' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF i.status NOT IN ('needs_review','refund_required') THEN
      RAISE EXCEPTION 'payment_refund_attempts: a review refund needs an intent in needs_review or refund_required' USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(amount_paise), 0) INTO committed_paise
      FROM payment_refund_attempts WHERE intent_id = NEW.intent_id AND status <> 'failed';
    IF committed_paise + NEW.amount_paise > i.amount_paise THEN
      RAISE EXCEPTION 'payment_refund_attempts: refunds for this intent would exceed the amount captured' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the request that goes to the provider must never change, so retries stay identical
  IF NEW.id <> OLD.id OR NEW.intent_id <> OLD.intent_id OR NEW.razorpay_payment_id <> OLD.razorpay_payment_id
     OR NEW.purpose <> OLD.purpose OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.receipt <> OLD.receipt
     OR NEW.amount_paise <> OLD.amount_paise OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'payment_refund_attempts: payment, key, receipt, amount and currency are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'payment_refund_attempts: the provider refund id is write-once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'payment_refund_attempts: submissions can only increase' USING ERRCODE = 'check_violation';
  END IF;
  -- processed / failed are final: a settled refund is never reopened or re-labelled
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued'       AND NEW.status IN ('submitting','failed','needs_review'))
    OR (OLD.status = 'submitting'   AND NEW.status IN ('unknown','pending','processed','failed','needs_review'))
    OR (OLD.status = 'unknown'      AND NEW.status IN ('submitting','pending','processed','failed','needs_review'))
    OR (OLD.status = 'pending'      AND NEW.status IN ('submitting','processed','failed','needs_review'))
    OR (OLD.status = 'needs_review' AND NEW.status IN ('submitting','processed','failed'))
  ) THEN
    RAISE EXCEPTION 'payment_refund_attempts: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('processed','failed') AND (NEW.provider_status IS DISTINCT FROM OLD.provider_status OR NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION 'payment_refund_attempts: a settled attempt cannot change' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_payment_refund_attempts_guard BEFORE INSERT OR UPDATE ON payment_refund_attempts
  FOR EACH ROW EXECUTE FUNCTION payment_refund_attempts_guard();

-- =====================================================================================================================
-- notification_outbox
-- =====================================================================================================================
CREATE TABLE notification_outbox (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              TEXT NOT NULL,
    dedupe_key        TEXT NOT NULL UNIQUE,                  -- e.g. 'order:<uuid>:confirmation': the same event can never be queued twice
    recipient_kind    TEXT NOT NULL,                         -- who; the address is looked up from the order/intent when sending
    order_id          UUID REFERENCES orders (id) ON DELETE CASCADE,
    intent_id         UUID REFERENCES payment_intents (id) ON DELETE CASCADE,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,    -- small, non-personal parameters only (reason codes, amounts)
    status            TEXT NOT NULL DEFAULT 'queued',
    attempts          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until       TIMESTAMPTZ,
    last_attempt_at   TIMESTAMPTZ,
    sent_at           TIMESTAMPTZ,
    last_error        TEXT,                                  -- safe, truncated
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT no_kind_valid CHECK (kind IN ('order_confirmation','admin_new_order','payment_refund_notice','admin_alert')),
    CONSTRAINT no_recipient_valid CHECK (recipient_kind IN ('customer','admin')),
    CONSTRAINT no_status_valid CHECK (status IN ('queued','sending','sent','failed','skipped')),
    CONSTRAINT no_dedupe_key_format CHECK (char_length(dedupe_key) BETWEEN 5 AND 200),
    CONSTRAINT no_has_subject CHECK (order_id IS NOT NULL OR intent_id IS NOT NULL),
    CONSTRAINT no_payload_small_object CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4000),
    CONSTRAINT no_attempts_valid CHECK (attempts >= 0),
    CONSTRAINT no_sent_iff_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
    CONSTRAINT no_sending_has_lease CHECK (status <> 'sending' OR lease_until IS NOT NULL),
    CONSTRAINT no_error_length CHECK (char_length(coalesce(last_error, '')) <= 500)
);

CREATE INDEX idx_no_due ON notification_outbox (next_attempt_at) WHERE status IN ('queued','sending');
CREATE INDEX idx_no_order ON notification_outbox (order_id);
CREATE INDEX idx_no_intent ON notification_outbox (intent_id);
CREATE INDEX idx_no_retention ON notification_outbox (updated_at) WHERE status IN ('sent','skipped','failed');

COMMENT ON TABLE notification_outbox IS 'Retryable notifications committed in the same transaction as the event that caused them. No e-mail addresses or message bodies are stored; both are produced when sending.';

CREATE FUNCTION notification_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.recipient_kind <> OLD.recipient_kind
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'notification_outbox: kind, dedupe key, recipient, subject and payload are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'notification_outbox: attempts can only increase' USING ERRCODE = 'check_violation';
  END IF;
  -- sent / failed / skipped are final
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued'  AND NEW.status IN ('sending','skipped','failed'))
    OR (OLD.status = 'sending' AND NEW.status IN ('queued','sent','failed','skipped'))
  ) THEN
    RAISE EXCEPTION 'notification_outbox: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('sent','failed','skipped') AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'notification_outbox: a finished notification cannot change' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_notification_outbox_guard BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION notification_outbox_guard();

-- Down Migration
-- Destructive by nature (it drops the recovery records): only for disposable databases, or before anything has used them.
-- It touches no existing table, so orders (including historical COD orders) are unaffected.

DROP TABLE IF EXISTS notification_outbox;
DROP TABLE IF EXISTS payment_refund_attempts;
DROP TABLE IF EXISTS payment_webhook_events;
DROP TABLE IF EXISTS payment_intents;
DROP FUNCTION IF EXISTS notification_outbox_guard();
DROP FUNCTION IF EXISTS payment_refund_attempts_guard();
DROP FUNCTION IF EXISTS payment_webhook_events_guard();
DROP FUNCTION IF EXISTS payment_intents_guard();
