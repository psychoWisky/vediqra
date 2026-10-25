# Payment recovery (Razorpay)

Goal: a captured Razorpay payment is never silently lost. Every payment ends up **fulfilled** (an order exists),
**refunded**, or in an explicit **review** state that tells the owner what to do. Temporary Razorpay / database / SMTP
failures stay recoverable.

> Status: implemented and tested against a deterministic fake of Razorpay (`backend/test/mockRazorpay.ts`) and a
> disposable database. **It has not been run against a real Razorpay account.** See "Still to verify in Razorpay test
> mode" before going live.

## 1. How a payment flows

```
browser                        server                                   Razorpay
  | POST /api/payment/create-order  (Idempotency-Key, cart, customer)
  |------------------------------> price cart on the server
  |                                INSERT payment_intents (status preparing)   <- committed FIRST
  |                                orders.create(receipt = vq_<intent id>) ---------------> order_xxx
  |                                intent -> created (razorpay_order_id attached)
  | <---- { id, amount, key_id, status_token } -----------------------------
  | Razorpay Checkout ----------------------------------------------------> pay
  | POST /api/payment/verify-payment (order id, payment id, signature)
  |------------------------------> verify HMAC, fetch the payment from Razorpay,
  |                                fulfilCapturedPayment()      <---- the same function is called by
  |                                                                    * the webhook (payment.captured / order.paid)
  |                                                                    * the recovery job (asks Razorpay)
```

`fulfilCapturedPayment` (`backend/src/services/payments/fulfilment.ts`) locks the intent row and, in ONE transaction,
creates the order from the **stored snapshot** (never from browser data), takes stock, consumes the coupon, assigns the
order number, marks the intent `fulfilled` and queues the e-mails. Repeats find `fulfilled` and change nothing. E-mails
are sent only after commit, from the outbox.

### Intent states

| state | meaning |
|---|---|
| `preparing` | stored, Razorpay order not attached yet (a crash/timeout can leave it here; it is resumed by the same Idempotency-Key or by the recovery job) |
| `created` | Razorpay order attached, waiting for payment |
| `fulfilled` | paid, order created (terminal) |
| `refund_required` | paid but the goods were gone (or similar): a full refund is queued/running |
| `refunded` | the provider confirmed the refund as **processed** (terminal) |
| `needs_review` | a person must decide (see section 6) |
| `abandoned` | nobody paid within 24 h; a late payment still revives it |

### What happens in each failure

| situation | result |
|---|---|
| Razorpay times out creating the order | intent stays `preparing`, buyer gets 503; the same request (same key) looks the order up by its **receipt** and reuses it, never creating a second one |
| order created at Razorpay but our DB write fails | same: found again by receipt; the worker also attaches it |
| browser closes after paying | webhook and/or recovery job fulfils it |
| payment captured for a different amount/currency than priced | `needs_review` (no order, no automatic refund) |
| payment already (partly) refunded at Razorpay | `needs_review` |
| stock ran out after payment | one **full** refund via the refund workflow; buyer e-mailed |
| coupon limit reached after payment | order is honoured at the **paid** price; usage recorded; owner alerted |
| second payment captured for the same checkout | alert only; nothing refunded automatically |
| Razorpay down while the browser verifies | buyer sees "being confirmed" (HTTP 202), nothing lost |

## 2. Refund workflow (`services/payments/refunds.ts`)

* the attempt row (stable `idempotency_key`, `receipt`, amount) is committed **before** any Razorpay call;
* every try sends the identical request (same `X-Refund-Idempotency` key, same body);
* a timeout / dropped connection / 5xx is **unknown**, not failed: the next pass lists the payment's refunds and
  adopts one carrying our receipt; only if none exists is the *same* request sent again;
* `pending` is not `processed`; the intent becomes `refunded` only when Razorpay says `processed`;
* never more than the captured amount (database guard plus a provider-side check before the first submission);
* provider refused / refund failed / payment already refunded elsewhere / unresolved after 48 h / 8 submissions
  → attempt and intent go to `needs_review` and the owner is e-mailed. Nothing is retried blindly.

### Admin refund (`POST /api/payment/refund/:paymentId`) - durable since the safety patch

Migration `1792925300000_admin-refund-requests.sql` adds `admin_refund_requests`. Each admin refund is a row committed
**before** Razorpay is called (stable idempotency key `adm_<id>`, receipt `ar_<id>`, immutable amount), settled by the same kind of
state machine as the automatic refunds: `queued -> submitting -> pending | processed | failed`, `unknown` after an uncertain
outcome, `needs_review` when a person must decide. The worker retries/reconciles unresolved rows.

What the admin and the order now see:

| Razorpay says | HTTP | order |
|---|---|---|
| `processed` | 200 | `refunded_amount` increased, status `partially_refunded` / `refunded` (stock restored once on a full refund) |
| `pending` | **202** `{pending:true}` | **unchanged** (still paid); the refund is listed in `orders.refunds` as `pending`; counted only when it becomes `processed` (worker) |
| failed / definite 4xx refusal | 502 | unchanged, nothing recorded |
| timeout, 5xx, dropped connection, no refund id | 502 `refund_status:"unknown"` | unchanged, nothing recorded; the worker reconciles by listing the payment's refunds |

* a lost answer cannot create a second refund: the retry (same `request_id`, or the same amount with no `request_id`) resumes the SAME
  request, first looking for it at Razorpay by receipt/notes and only then resending with the same key;
* at most one unresolved admin refund per order (unique index): a different refund waits (409) until the earlier one is settled, so
  pending/uncertain amounts can never add up beyond the order total (a trigger also enforces the cap);
* simultaneous admin requests: one runs, the others get 409;
* a payment with a durable automatic refund attempt cannot be refunded here (409); a payment without an order is a 404;
* a request that ends in `needs_review` (provider state could not be established within 48 h, key conflict, unexpected status) blocks
  further refunds on that order and is listed under `admin_refund_requests` in `GET /api/payment/review`. It is closed with
  `POST /api/payment/review/admin-refund/:requestId/resolve {"provider_refund_id":"rfnd_..."}` (admin token). The server asks
  Razorpay and only proceeds if ALL of this holds: the refund is listed for this request's payment; amount and currency equal the
  request's; its status is final (`processed` settles the request and updates order, ledger and the stock task in one transaction;
  `failed` settles it as failed and unblocks the order; `pending` is refused); and the payment's total refunded amount at Razorpay
  equals what the order has recorded (plus this refund if processed) - any other refund on the payment is a discrepancy that is
  refused. **There is no way to settle a request without a provider refund id**, and an absent refund in a list is not proof that none was made.
  Escalation when no such refund exists or the totals do not reconcile: (1) open the payment in the Razorpay dashboard and note every
  refund on it (id, amount, status); (2) if money moved that the system does not know about, do not repeat the refund - a developer must
  reconcile the order by reviewing those ids against `orders.refunds`; (3) if the dashboard shows NO refund and `amount_refunded` is 0,
  the request is still unresolved by design: wait a day (the provider list can lag), re-check, and only then involve a developer.
* `GET /api/payment/review` also lists unresolved admin refund requests.
* Historical orders and their stored `refunds` are never rewritten.

### Stock restoration after a full admin refund (durable)

Migration `1792925400000_stock-restoration-tasks.sql`. Only a **full admin refund that settles as `processed`** (order becomes
`refunded`) restores stock; partial refunds do not, automatic stock-failure refunds never do (no order exists, no stock was taken),
and cancellation keeps its own existing restoration. The task row is inserted in the same transaction that settles the refund and
updates the order. It is completed in the same transaction that returns the stock and stamps `orders.stock_restored_at` (under
the order row lock), so a crash leaves a queued/expired-lease task that the worker retries, and repeated or concurrent runs restore
nothing twice. No HTTP happens inside either transaction. Retry limit 10, then `needs_review` (listed under `stock_restoration_tasks`
in `GET /api/payment/review`). Orders refunded before this migration have no task and are untouched.

## 3. Environment variables (`backend/.env`, none have secret defaults)

| variable | default | purpose |
|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | – | API keys (test keys for test mode) |
| `RAZORPAY_WEBHOOK_SECRET` | – | secret you type on the Razorpay webhook (8+ chars). Without it the webhook answers 503 |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` | – | only while rotating: the old secret, still accepted |
| `RAZORPAY_TIMEOUT_MS` | 10000 | per Razorpay call (1000–60000) |
| `PAYMENT_RECOVERY_ENABLED` | false | turns the background worker on (needs the API keys; the server refuses to start otherwise) |
| `PAYMENT_RECOVERY_INTERVAL_MS` | 60000 | pause between passes (15000–3600000) |
| `INTENTS_ENABLED_AT`, `LEGACY_VERIFY_UNTIL` | – | one-time bridge for Razorpay orders created before this release (section 7) |
| `RATE_LIMIT_PAYMENTS` / `RATE_LIMIT_STATUS` | 30 / 60 per 15 min per IP | create-order+verify, and status lookups |
| `TRUST_PROXY` / `LISTEN_HOST` | 0 / all interfaces | which proxy to believe for client IPs (`loopback` with nginx on the same host) / bind address; see DEPLOYMENT.md |
| `PAYMENT_TEST_MODE_GUARD`, `TEST_MODE_ALLOWED_DB_NAMES` | off | opt-in guard for a test-mode exercise (below) |
| `RATE_LIMIT_WEBHOOK` | 300 per minute per IP (10-100000) | webhook abuse limit, answered 429 + `Retry-After: 30` |
| `WEBHOOK_MAX_CONCURRENT` | 25 (1-500) | events processed at once per process; more get 503 + `Retry-After: 5` |

The server logs a warning at start-up in production when keys are set but the webhook secret or the worker is missing.

## 4. Razorpay dashboard setup (do this in TEST mode first, then live)

1. Dashboard → *Settings → Webhooks → Add new webhook*.
2. URL: `https://<your-api-domain>/api/payment/webhook` (it must be reachable from the internet; nginx must pass the
   body through untouched and forward `X-Razorpay-Signature` and `X-Razorpay-Event-Id`).
3. Secret: a long random string; put the same value in `RAZORPAY_WEBHOOK_SECRET`.
4. Active events: **`payment.captured`**, **`order.paid`**, **`payment.failed`**. Others are acknowledged and ignored.
5. Test and live mode have separate webhooks and secrets.
6. Rotating the secret: set `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` = old, `RAZORPAY_WEBHOOK_SECRET` = new, restart, change
   it on the dashboard, wait a day, remove the previous one.

The event name and payload are only a hint: for `payment.captured` / `order.paid` the payment is **fetched from Razorpay**
and its order id, captured status, amount and currency decide the outcome (a signed payload that disagrees is ignored).

**Abuse protection.** The webhook has no login, so two cheap guards run before any database or provider work:
(1) a per-IP request limiter (`RATE_LIMIT_WEBHOOK`) in front of the body parser, and (2) a cap on events being processed at once
(`WEBHOOK_MAX_CONCURRENT`), checked after the signature (so unsigned traffic still gets a plain 400). Both answer with a retryable
status (429 / 503 with `Retry-After`) and store nothing, so a legitimate event that is turned away is redelivered by Razorpay later
and, meanwhile, the recovery job finds the payment itself. Both counters are **per application process, in memory**: with N
instances behind a load balancer the effective ceilings are N times the settings, and they reset on restart. There is no shared
store (no new service was added for this); behind nginx on the same host set `TRUST_PROXY=loopback` and have nginx send `X-Forwarded-For $remote_addr` (DEPLOYMENT.md) so the limit is per real client IP, and consider an nginx
`limit_req` in front as well. Nothing about the request (IP, headers, body, signature) is logged when it is limited.

Responses: `200` accepted (processed, duplicate, or deliberately ignored); a signed body that cannot be read is
acknowledged but **recorded** (`event_type 'unreadable'`, outcome `needs_review`) so it shows on the review list;
`400` bad signature / empty body (not stored); `429` / `503` rate or capacity limit (not stored, retry later);
`503` secret not configured; `500` our failure while processing — the event is already stored and Razorpay's retry (or
the recovery job) finishes it. Only ids, event type, timestamps and the outcome are stored: **no payload, headers,
signature, e-mail, phone, card or UPI data**.

## 5. Workers

One in-process timer (no external queue), started from `src/index.ts` only when `PAYMENT_RECOVERY_ENABLED=true`, stopped
on SIGTERM/SIGINT (waits for the running pass, then closes the pool). Each pass:

1. stale `preparing` intents → find (never create) the Razorpay order by receipt and attach it, or abandon after 30 min;
2. `created`/`abandoned` intents due for a check → ask Razorpay about the order and fulfil/refund/review;
   unpaid `created` intents become `abandoned` after 24 h; abandoned ones are watched for 7 days;
3. refund attempts (submit / reconcile / settle);
4. the notification outbox;
5. stored webhook events that were never processed (the provider is asked, since payloads are not kept).

Safety: one pass at a time per process; one process at a time via a Postgres advisory lock; rows are claimed with
`FOR UPDATE SKIP LOCKED` / leases that expire if a worker dies; exponential backoff with attempt limits (outbox 8,
refund 8 submissions / 48 h, webhook events 8). **Nothing is ever deleted automatically.** With the worker off
(default), payments still work and each flow makes one immediate best-effort attempt (e-mails, first refund call), but
nothing is retried in the background.

Retention (manual, not implemented as a job): see the header of
`database/migrations/pg-migrate/1792925229236_payment-recovery-tables.sql` for the queries (90-day default target;
refund attempts and un-scrubbed financial rows are never cleanup candidates).

## 6. What the owner has to do

`GET /api/payment/review` (admin token) lists intents in `needs_review`/`refund_required` and refund attempts that are
unresolved. The same cases arrive by e-mail as `[BRAND] Payment needs review` / `Refund needs review` /
`Refund failed at Razorpay` / `Coupon limit exceeded by a paid order`.

| review reason | what to do |
|---|---|
| amount / currency mismatch | open the payment in Razorpay; refund it in the dashboard if it is wrong, or create the order by hand |
| payment refunded before fulfilment | usually nothing; cancel any related order |
| refund needs a human (provider refused, failed, still pending after 7 days, unresolved after 48 h, "already refunded outside this system") | check the refund in the Razorpay dashboard and refund manually if money has not moved; then record the outcome |
| duplicate payment for one checkout | refund the extra payment in the dashboard |
| coupon over limit | informational; decide whether to keep the coupon active |

### Resolving cases (admin token required, every action re-checks Razorpay)

There is no admin screen; two small API actions exist, and there is **no action that marks anything fulfilled or
refunded on an operator's word**.

1. `POST /api/payment/review/:caseId/adopt-refund` `{ "provider_refund_id": "rfnd_...", "note": "..." }`
   For a case that has a recorded captured payment (refund needed / refund stuck / refund failed). The refund must be listed by
   Razorpay for **that payment**, have status `processed`, and equal the captured amount and currency. Then, in one
   transaction, the existing refund attempt (or a new `manual_review` attempt) becomes `processed` with that refund id and
   the intent becomes `refunded`; the admin name and note are written to `resolution_note`/`reviewed_at`. A pending, partial
   or differently-sized refund, an unknown id or another payment's refund is refused with 409 and the case stays open.
2. `POST /api/payment/review/:caseId/acknowledge` `{ "payment_id": "pay_...", "note": "..." }`
   For amount/currency/identity mismatches (no order and no refund attempt can represent them). Razorpay must show that
   payment, belonging to this checkout's Razorpay order, **fully refunded**. The case keeps state `needs_review` (the
   database has no terminal state for an amount different from the quote) but `reviewed_at` and the audit note remove it
   from `GET /api/payment/review`.

Runbook for a mismatch: (1) open the payment in the Razorpay dashboard, confirm order id and amount; (2) refund it there (or,
if you decide to honour it, create the order yourself outside this system); (3) call `acknowledge` with the payment id;
(4) confirm the case is gone from `GET /api/payment/review` and the payment shows refunded in Razorpay.
Runbook for a stuck refund: (1) in the dashboard find the refund for the payment; if none exists and the payment is
captured, create one for the full amount; (2) wait until its status is `processed`; (3) call `adopt-refund` with its id;
(4) confirm the intent is `refunded` (the response says so). Duplicate-payment alerts need no action in this system: refund
the extra payment in the dashboard. No raw SQL is part of any runbook.

## 7. Customer status and tokens

`create-order` returns a `status_token` (256-bit HMAC of the intent id under `JWT_SECRET`); only its SHA-256 is stored.
`POST /api/payment/status {razorpay_order_id, token}` (body, never a URL) returns a state and a plain message (no personal
data); a wrong token and an unknown order give the identical 404; hashes are compared in constant time; the endpoint is
rate limited. The token is bound to one checkout (derived from its id). The storefront polls for about 30 s when Razorpay
confirmed the payment but the server is still finishing; if that does not resolve, the order id + token are kept in the
browser's `localStorage` (no personal data, 24 h) and polling resumes on the next visit to checkout, then the entry is
removed. The token is **not e-mailed** (there is no status page to link to) and never appears in logs. A buyer who clears
browser data loses it; the payment is still fulfilled or refunded by the server, and the e-mails (confirmation or refund
notice with the Razorpay order id as reference) are the durable record. Rotating `JWT_SECRET` invalidates tokens.

**Delivery semantics.** E-mail is *at-least-once*: if a worker dies after SMTP accepted a message but before the row is marked
sent, the message is sent again after the lease expires (tested). Dedupe keys prevent a second *row* for one event.

## 8. Rollout sequence

1. Back up the database (`pg_dump`).
2. Deploy the code with `PAYMENT_RECOVERY_ENABLED` unset and **no** webhook yet. Run `npm run migrate -- up`
   (adds four tables; touches nothing existing).
3. In **test mode**: set test keys + `RAZORPAY_WEBHOOK_SECRET`, add the webhook, make test payments (success, failure,
   close the browser mid-payment, out-of-stock after payment, refund), and confirm the items in section 9.
4. Switch to live keys, create the live webhook, set `PAYMENT_RECOVERY_ENABLED=true`, restart.
5. **Orders already open at the moment of deployment** (Razorpay orders created by the old code): set
   `INTENTS_ENABLED_AT=<deployment time, ISO UTC>` and `LEGACY_VERIFY_UNTIL=<at most 24 h later>` for that deployment
   only. Inside that window a browser that finishes an *old* payment is re-priced on the server and must match the
   captured amount. Remove both afterwards. If unset, such a payment is refused with "contact support" and has to be
   fulfilled by hand.

**Rollback.** Never run `npm run migrate -- down` once any checkout has used the new tables: it drops (one migration per `down`; the stock restoration tasks first, then the admin refund ledger) every intent, refund
attempt, admin refund request, webhook event and queued e-mail (the orders table is untouched). Rolling the *code* back to a version without
payment intents is only safe when nothing depends on them:

1. stop taking new checkouts first (maintenance page / disable payments);
2. wait for the worker to drain, then run: `SELECT status, count(*) FROM payment_intents WHERE status IN
   ('preparing','created','refund_required','needs_review') GROUP BY 1;` and the same for
   `payment_refund_attempts`, `admin_refund_requests` and `stock_restoration_tasks` (statuses `queued`,`submitting`,`unknown`,`pending`,`needs_review`) and `notification_outbox`
   (`queued`,`sending`);
3. resolve or consciously hand over every row found (a `created` intent can still receive a payment; old code will not
   fulfil it - keep the webhook endpoint and worker of the NEW version running, or list the open Razorpay orders and fulfil
   by hand);
4. keep the tables. The old code simply ignores them.

If old code must run before this is done, keep a new-version instance serving `/api/payment/webhook` and the worker.
Browsers that loaded the old storefront while the new API runs call `verify-payment` with the old body; that works only
for payments that have an intent (the legacy window in step 5 above covers the deployment moment).

**Several application instances.** Each instance starts the worker if `PAYMENT_RECOVERY_ENABLED=true`; a Postgres advisory
lock lets one pass run at a time across all of them, and row claims use `FOR UPDATE SKIP LOCKED` / leases, so duplicates are
harmless (tested with simultaneous ticks). Webhook and browser requests may hit any instance.

## 9. Still to verify in Razorpay test mode (assumed, not proven)

* `GET /v1/orders?receipt=` returns the order (documented) and a second `orders.create` with the same receipt is
  rejected (documented as "unique"; the code does not depend on it, it just attaches whichever order wins);
* `X-Refund-Idempotency`: replay returns the original refund, how long keys live, behaviour for an in-flight duplicate;
* webhook retry schedule and header names (`X-Razorpay-Event-Id`), that `order.paid` carries the payment entity,
  and that amounts are integers in paise;
* refund `receipt`/`notes` round-trip in `GET /v1/payments/:id/refunds` (reconciliation matches on them);
* test-mode refund timing (`pending` → `processed`);
* that payments with `payment_capture: 1` always reach `captured` (an `authorized`-only payment is treated as
  "pending" and re-checked, never fulfilled).

## 9a. Test-mode safety guard (opt-in)

For the manual exercise set `PAYMENT_TEST_MODE_GUARD=true` (exactly `true`). The API then refuses to start unless
`RAZORPAY_KEY_ID` starts with `rzp_test_` and `DB_NAME` is `vediqra_test_<name>` or listed in `TEST_MODE_ALLOWED_DB_NAMES`; the exact
name `vediqra` is always refused; a missing or odd value is refused; error messages never show key values. `npm run migrate` applies
the same database rule before connecting. It is **not** a general safety net: it does not protect `psql`, `pg_dump` or hand-run
scripts, it cannot see the storefront's `VITE_RAZORPAY_KEY_ID`, and it says nothing about where DB_HOST points. Use a separate staging
database for the exercise, create it, and migrate it with the guard on.

## 9b. Manual Razorpay TEST-MODE checklist (nothing here has been run yet)

Record, for each step, the Razorpay ids (order/payment/refund/event) and our `payment_intents`, `payment_refund_attempts`,
`payment_webhook_events` rows (ids and statuses only). Never record keys, secrets, signatures, card/UPI data or customer details.

1. **Keys.** Put the test `RAZORPAY_KEY_ID`/`SECRET` in `backend/.env` (never in git/chat). Start the API. Evidence: `/health` ok,
   `create-order` returns an `order_...` id and the Razorpay dashboard (test) shows the order with receipt `vq_<32 hex>`.
2. **Webhook.** Add the webhook (section 4) with events `payment.captured`, `order.paid`, `payment.failed` and your chosen secret
   in `RAZORPAY_WEBHOOK_SECRET`. Evidence: dashboard delivery log shows 200; a deliberately wrong secret shows 400.
3. **Success.** Pay with a test card/UPI. Evidence: one order, intent `fulfilled`, one confirmation + one admin e-mail, two or
   three webhook rows (distinct event ids) all `processed` with no second order.
4. **Browser closes after capture.** Start a payment, close the tab right after authorising. Evidence: the order appears
   within one webhook delivery (or one worker interval if the webhook is disabled); intent `fulfilled`.
5. **Duplicate webhook.** Use the dashboard's redeliver on a delivered event. Evidence: 200, `attempts` incremented, no new order.
6. **Order lookup by receipt.** Call `GET /v1/orders?receipt=vq_<id>` with the test keys and confirm exactly that order is
   returned; then create the same receipt twice with a throwaway script to learn whether Razorpay rejects duplicates.
   Evidence: both responses (ids only).
7. **Refund success.** Put a product at stock 1, start two checkouts, pay both. Evidence: the second becomes `refund_required`
   then `refunded`, one refund (`rfnd_...`) of the full amount in the dashboard, one notice e-mail.
8. **Pending refund.** If test mode ever returns `pending`, confirm the attempt is `pending` and later `processed` without
   a second refund. Evidence: attempt status history and `GET /v1/payments/:id/refunds`.
9. **Lost refund response.** Block outbound traffic from the server for the duration of one refund call (firewall), restore it, and
   confirm reconciliation adopts the refund (receipt/notes match) without a second refund. Evidence: one refund in the
   dashboard, attempt `processed`, same idempotency key throughout.
10. **Idempotent replay.** Send the same refund twice with the same `X-Refund-Idempotency` key and body from a test script, then
    with a different body. Evidence: same refund id returned; 409 on the different body; note how long a key is honoured.
11. **Secret rotation.** Set the new secret as current and the old as previous, change it in the dashboard, redeliver an old event.
    Evidence: old and new signatures both 200; after removing the previous one the old signature is 400.
12. **Authorized-only payments.** Confirm `payment_capture: 1` orders always capture; if an `authorized` state is ever seen,
    confirm the intent stays `created` and is fulfilled only after capture.

| unverified provider assumption | evidence that would validate it |
|---|---|
| receipt is unique and `GET /v1/orders?receipt=` filters exactly | step 6 responses |
| refund idempotency replay returns the original refund; key lifetime | step 10 |
| refund `receipt` and `notes.attempt_id` round-trip in the refunds list | step 7/9 list response |
| `order.paid` includes the payment entity; header `X-Razorpay-Event-Id` | delivery log / one redelivery (headers only) |
| webhook retries on non-2xx and the retry schedule | dashboard delivery log after a deliberate 500 |
| the refund list may lag behind a just-created refund | observed `amount_refunded` vs list in step 9 |

## 10. Tests

`backend/test/phase2-payment-recovery-test.mts`, `phase3-audit-test.mts` and `safety-patch-test.mts` (`npx tsx test/<file>`) each build and
drop their own `vediqra_test_p2` / `p3` / `p4` databases and SMTP sink; `config-safety-test.mts` needs no database (guard and proxy-trust checks). Related: `razorpay-phase0-test.ts`, `phase1-payment-recovery-schema-test.mjs`,
and the storefront regressions `phase3b`, `phase4c`, `phase4f-online-only` (run through a disposable database with the
fake server).
