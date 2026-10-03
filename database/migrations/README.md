# database/migrations/

This directory holds two distinct things. Don't mix them up.

## `*.sql` files directly in this directory (001–005)

**Historical, pre-tooling record. Not tracked by any migration tool. Do not add new files here.**

These are hand-run deltas from before Phase 4E introduced real migration tooling. Every one of them
is already folded into `database/schema.sql` — a fresh database built from `schema.sql` already has
everything these files describe. They're kept only as a record of how the schema got here (and
`005_seed_admin_user.sql` is also how the default admin account was seeded). Nothing in the
application or the new migration tool reads this directory's loose `.sql` files.

## `pg-migrate/` subdirectory

**The real, tool-tracked migration history, starting from Phase 4E onward. New schema changes go here.**

Managed by [node-pg-migrate](https://github.com/salsita/node-pg-migrate) via `backend/scripts/migrate.cjs`
(run with `npm run migrate -- <command>` from `backend/`). See `docs/DATABASE_MIGRATIONS.md` at the
project root for the full workflow — creating, reviewing, applying, rolling back, and adopting an
existing database.

The first file in `pg-migrate/`, `..._baseline-schema.cjs`, represents the schema that already
existed when this tooling was introduced (the same one `schema.sql` describes). It is never actually
*executed* against the real VEDIQRA database — it was marked as already-applied (`--fake`) because
the database already had this schema before the tool existed. It only really runs end-to-end against
a fresh/disposable database (verified in Phase 4E). Every migration after it is a normal, real
migration that both fresh and existing databases apply the same way.
