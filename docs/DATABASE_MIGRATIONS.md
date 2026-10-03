# Database Migrations (Phase 4E)

## Why node-pg-migrate, and why not Alembic

The backend is Node.js + Express + TypeScript, talking to PostgreSQL through the raw `pg` driver —
there is no ORM and no Python anywhere in this project. Alembic requires Python + SQLAlchemy; adding
it here would mean maintaining a second language runtime, a second dependency manager (pip/venv), and
a second set of deployment steps purely for migrations, with no corresponding benefit — nothing else
in the stack would ever touch SQLAlchemy. That's complexity for its own sake, so it was rejected.

[`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) was chosen instead:

- Pure Node.js, installed as a normal `devDependency` — no new runtime.
- Talks to Postgres via `pg` (the same driver the app already uses).
- Migrations can be plain `.sql` files (matching this project's existing convention of hand-written
  SQL in `database/migrations/`) or `.cjs`/`.js` files when a migration needs logic beyond raw SQL.
- Maintains its own ordered, timestamped migration history in a `pgmigrations` table — deterministic,
  reviewable, and it refuses to apply migrations out of order.
- Has first-class support for exactly the two things this phase needed most: `--fake` (mark a
  migration as applied without running it — for adopting an existing database) and `down` (rollback).

No existing migration tool was found in the project (see the audit below), so this isn't a
replacement of anything — it's genuinely new infrastructure, introduced deliberately rather than by
default.

## Directory layout

```
database/
  schema.sql                     Full reference schema. Executed by the baseline migration.
  migrations/
    001_phase1_security.sql      Historical, pre-tooling deltas. NOT managed by node-pg-migrate.
    002_vediqra_product_options.sql    Already folded into schema.sql. Kept as a record only.
    003_stock_tracking.sql
    004_stock_restoration_and_refunds.sql
    005_seed_admin_user.sql
    README.md                    Explains the split above in more detail.
    pg-migrate/                  <-- node-pg-migrate's actual migration directory
      1790975131397_baseline-schema.cjs    The baseline (see below)
      <timestamp>_<name>.sql     Every future migration goes here
```

## How the connection is configured

`backend/scripts/migrate.cjs` builds a Postgres connection string **in memory, from the same
`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_SSL` variables the app itself uses** (loaded
from `backend/.env` via `dotenv`), and hands it to the `node-pg-migrate` CLI through the `DATABASE_URL`
environment variable of a child process. It is never printed or logged. There is deliberately no
separate migration-specific credential to keep in sync — one `.env`, one source of truth.

## Commands (run from `backend/`)

```bash
npm run migrate -- up                       # apply all pending migrations
npm run migrate -- up --dry-run             # print the SQL that WOULD run, without running it
npm run migrate -- down                     # roll back the single most recent migration
npm run migrate -- create <name>            # create a new migration (plain .sql by default)
npm run migrate -- create <name> -j cjs     # create a new migration as a .cjs file (for migrations
                                             # that need logic, not just static SQL)
```

### Checking status

There is no built-in `status` subcommand in this version of node-pg-migrate. Check what has been
applied with a direct query:

```bash
psql "$DATABASE_URL" -c "SELECT * FROM pgmigrations ORDER BY id;"
```

Compare that against the files in `database/migrations/pg-migrate/` to see what's pending.

### Handling a failed migration

By default node-pg-migrate wraps all pending migrations in a single transaction
(`--single-transaction`, on by default), so if a migration fails partway through, **everything in
that run is rolled back automatically** — the database is left exactly as it was before you ran `up`.
Fix the migration file, review it again, and re-run `up`.

### Rollback strategy

Every migration file should have both an Up and a Down. `npm run migrate -- down` rolls back the
most recently applied one. There is no "down" path for the baseline migration on any database where
it was adopted via `--fake` (see below) — faking it means it was never really "up" to begin with, so
there's nothing to roll back; the real schema change, if you ever needed to undo it, would be a new
forward migration that reverses the specific change, not a rollback of the baseline.

## Fresh database initialization

Verified in Phase 4E against a disposable database (`vediqra_test_migrate`, since dropped):

```bash
createdb myapp_fresh
DB_NAME=myapp_fresh npm run migrate -- up
```

Result: `node-pg-migrate` creates its own `pgmigrations` table, finds the baseline migration, and
executes it — which runs `database/schema.sql` verbatim. **Confirmed result:** all 26 application
tables created, all foreign keys/indexes/triggers/sequences/functions present, `pgmigrations` records
the baseline as applied. A `pg_dump --schema-only` diff against a database created by applying
`schema.sql` directly showed zero differences beyond `node-pg-migrate`'s own bookkeeping table.

## Adopting an existing database (what was actually done to VEDIQRA)

The real `vediqra` database already had this exact schema before this tooling existed — there was
nothing to migrate, only something to *record*. node-pg-migrate's `--fake` flag marks a migration as
applied in the `pgmigrations` table **without executing its SQL**:

```bash
npm run migrate -- up --fake
```

This was tested first against a disposable clone of the real schema (confirmed: no "relation already
exists" errors, meaning the DDL genuinely wasn't re-run, just recorded), then run for real against
`vediqra`. **Confirmed result:** `pgmigrations` now has one row (the baseline, timestamped at the
time it was faked); all 16 products, 12 categories, 41 option values, the admin account, and the
order sequence (191) were completely untouched — verified by row-for-row comparison before and after.

## Future migrations

Going forward, this is the only thing anyone needs to do for a schema change:

```bash
npm run migrate -- create add_wishlist_table
# edit the generated database/migrations/pg-migrate/<ts>_add-wishlist-table.sql
npm run migrate -- up --dry-run    # review the exact SQL first
npm run migrate -- up              # apply it
```

This was tested end-to-end in a disposable database: created a migration that added a nullable test
column, ran `up` (column appeared, `pgmigrations` recorded it), then ran `down` (column removed,
`pgmigrations` entry removed). No test migration or column was left in the real database.

## Seed/schema separation

**Schema migrations** (this directory) and **catalogue/seed data** (`database/seeds/vediqra_catalogue.sql`)
are, and must stay, separate:

- Migrations only ever change *structure* (tables, columns, constraints, indexes, functions). They
  must never `INSERT`/`UPDATE`/`DELETE` rows in `products`, `orders`, `admin_users`, or any other table
  that holds real application data. The baseline migration is schema-only (it runs `schema.sql`,
  which creates empty tables — it inserts nothing).
- The 16-product catalogue seed is a one-time, explicit, separate step (`psql -f database/seeds/vediqra_catalogue.sql`),
  run once when bootstrapping a new environment — never as part of `npm run migrate -- up`, and never
  re-run against an environment that already has real data.
- A future migration that needs to backfill or transform existing data (not seed fake data) is fine
  and normal — that's a data migration, different from catalogue seeding, and should be written
  defensively (idempotent, reversible where possible, documented).

## `database/schema.sql`'s role, going forward

`schema.sql` is no longer the thing you run by hand against a new database. Its role now is:

1. **The single source of truth for "what does a complete VEDIQRA schema look like"** — read it to
   understand the full structure at a glance, without replaying every migration in your head.
2. **What the baseline migration executes** to build a fresh database in one step. The baseline
   migration reads `schema.sql` at runtime (`fs.readFileSync`) rather than duplicating its content,
   so there is exactly one copy of the full-schema definition — no drift risk between the two.

It is **not** a substitute for running migrations, and after this phase it should not be hand-edited
to reflect new changes — new changes are migrations. (It would only need updating if a future
decision is made to periodically "re-baseline" — squash the migration history into a new reference
snapshot — which is optional housekeeping, not required for this system to work.)

## Production workflow

```text
Developer changes schema
        ↓
npm run migrate -- create <name>              (creates a timestamped .sql file)
        ↓
Edit the Up/Down SQL by hand
        ↓
npm run migrate -- up --dry-run                (review the exact SQL, locally)
        ↓
npm run migrate -- up                          (apply locally, test the app against it)
        ↓
Commit the migration file, open a PR, get it reviewed like any other code change
        ↓
Deploy application code (does NOT include running migrations automatically — see below)
        ↓
Take a database backup (pg_dump)               -- REQUIRED before any production migration
        ↓
npm run migrate -- up --dry-run                (review again, against the real connection this time)
        ↓
npm run migrate -- up                          (apply to production)
        ↓
Verify (spot-check the schema change, check pgmigrations, smoke-test the app)
        ↓
Restart the application (PM2 or equivalent) if the change requires it
```

See `docs/DEPLOYMENT.md` for exactly where this fits relative to backend/frontend deploys, PM2
restarts, and backups.

## Safety rules

- Migrations are ordered by filename timestamp and node-pg-migrate checks that order before running
  (`--check-order`, on by default) — you cannot accidentally apply them out of sequence.
- Every migration is plain, reviewable SQL (or a short `.cjs` file) committed to version control —
  nothing is generated from ORM models or inferred automatically.
- Migrations never seed or touch catalogue/order/customer/admin data (see "Seed/schema separation").
- No migration here performs an automatic destructive operation (`DROP TABLE`, `DROP COLUMN`,
  `TRUNCATE`) "for convenience." A future migration that genuinely needs to do one of these must:
  1. Take a fresh backup first (document the exact `pg_dump` command in the PR).
  2. Be reviewed with the specific rows/columns affected called out explicitly.
  3. State in the migration file's comment what data is lost and why it's safe to lose it.
  4. Prefer an additive, two-step approach when possible (add the new column, backfill, migrate the
     app to use it, and only drop the old column in a later, separate migration) over a single
     destructive step.

## Security

- Migration credentials are the same `backend/.env` values the app already uses — nothing new to
  commit, rotate, or leak. `.env` remains gitignored; `.env.example` has no real values.
- `backend/scripts/migrate.cjs` builds the connection string in memory and passes it to the
  `node-pg-migrate` subprocess via its environment only; it is never written to a file or printed.
  `node-pg-migrate`'s own `--verbose` output logs the SQL being executed (useful for review) and
  migration file names — not connection strings or passwords.
