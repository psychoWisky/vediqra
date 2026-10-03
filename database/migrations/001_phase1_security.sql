-- This file is UTF-8 (it contains an emoji default). Make psql read it as UTF-8 whatever the console code page is.
SET client_encoding = 'UTF8';

-- Phase 1 delta for a database that was created from the ORIGINAL schema.sql.
-- (A fresh install from the current schema.sql already includes all of this.)
-- Idempotent: safe to run more than once.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_razorpay_payment_id
    ON orders (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 100 MINVALUE 100;

-- Continue numbering after the highest existing "<prefix>#<n>" order id (no-op on an empty table).
SELECT setval(
    'order_number_seq',
    GREATEST(
        100,
        COALESCE((SELECT MAX(substring(custom_order_id from '#(\d+)$')::bigint) + 1 FROM orders), 100)
    ),
    false
);

CREATE TABLE IF NOT EXISTS admin_users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username       TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'admin',
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
