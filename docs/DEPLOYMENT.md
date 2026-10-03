# VEDIQRA Deployment Guide

This covers what's needed to run the VEDIQRA backend and frontend in production, with particular
attention to the local filesystem image storage introduced in Phase 4D (replacing Cloudflare R2).

## 1. Prerequisites

- Node.js 18.x, PostgreSQL (tested against 17), nginx (or equivalent reverse proxy).
- A domain/TLS certificate for the public-facing site.
- SMTP credentials (order emails) and Razorpay live keys (payments) — see sections 5–6.

## 2. Database

As of Phase 4E, schema changes are applied through a real migration tool (`node-pg-migrate`), not by
hand-running `.sql` files. Full details, rationale, and the adoption workflow are in
`docs/DATABASE_MIGRATIONS.md` — this section is the short version for a deploy.

### First deploy (brand new, empty database)

```bash
cd backend
npm install
npm run migrate -- up        # creates the full schema (reads database/schema.sql once, via the
                              # baseline migration) and records it in the pgmigrations table
```

Then seed the catalogue once (not part of `migrate up` — see "Seed/schema separation" in
`docs/DATABASE_MIGRATIONS.md`):

```bash
psql "$DATABASE_URL" -f database/seeds/vediqra_catalogue.sql
```

Create the first admin account with `npm run create-admin -- <username> <password>` (do **not** rely
on the historical `database/migrations/005_seed_admin_user.sql`, which hardcodes a known dev
password — it was for local development only and must not be run against a production database).

### Subsequent deploys (database already exists)

```bash
cd backend
npm install
# BACKUP FIRST — see section 10 / docs/DATABASE_MIGRATIONS.md "Safety rules"
npm run migrate -- up --dry-run   # review the SQL that will run
npm run migrate -- up             # apply only the migrations not yet recorded in pgmigrations
```

Running `migrate up` is idempotent and safe to include in every deploy — if there's nothing new, it
does nothing. **Run it after the backend code is deployed but before restarting the backend process**
(section 9) if the new code depends on the new schema; run it before deploying backend code if the
migration is purely additive and the old code doesn't care about the new column/table yet. Either
way, never run it against an unknown/unbacked-up database.

### Where this stands relative to the rest of a deploy

```text
1. Take a database backup (pg_dump)
2. Deploy backend code (npm install, npm run build)
3. Run migrations (npm run migrate -- up)
4. Restart the backend process (PM2 / systemd)
5. Deploy frontend (npm run build, copy dist/ to nginx)
```

Migrations run against the database directly — they are not part of the frontend build and have no
effect on the frontend deploy order.

## 3. Backend environment (`backend/.env`)

Copy `backend/.env.example` to `.env` and fill in real values. Key points:

- `JWT_SECRET` must be a random 32+ byte string (the server refuses to start otherwise — see
  `assertSecureConfig()` in `src/config.ts`).
- `PUBLIC_BASE_URL` — set this to the backend's externally reachable base URL (e.g.
  `https://api.example.com`) if the backend is on a different host/port than what `req.protocol`/
  `req.get('host')` would resolve to behind your proxy. If unset, uploaded-file URLs are built from
  the incoming request automatically, which is correct for same-host nginx proxying.
- `CORS_ORIGINS` must list the real storefront origin(s) in production — an empty value reflects any
  origin, which is fine for local dev only.
- `TRUST_PROXY=1` if there is exactly one reverse proxy (nginx) in front of the app.

```bash
cd backend
npm install
npm run build
npm run start   # or your process manager (pm2, systemd, etc.)
```

## 4. Local image/video storage (`backend/uploads/`)

Phase 4D replaced Cloudflare R2 with local filesystem storage (`backend/src/utils/localStorage.ts`).
This has real operational implications that R2 didn't:

### 4.1 Where files live

All uploads (product images, hero media, logos, customer customisation images) are written under
`backend/uploads/`, organised by type (`products/`, `hero/`, `logos/<type>/`, `customizations/<id>/`).
Filenames are server-generated (timestamp + random hex) — never the client's original filename — and
served back read-only via `express.static` at `/uploads/...` with directory listing and dotfiles
disabled.

### 4.2 Persistence across deploys

**This directory must survive deploys and restarts.** If your deployment process replaces the
backend's working directory (e.g. a fresh `git pull` + rebuild into a new folder, or a containerised
deploy that discards the filesystem), uploaded images will be lost even though the database rows
referencing their URLs remain. Before deploying:

- Mount or symlink `backend/uploads/` to a path outside the deploy/build directory (a persistent disk
  volume, or a dedicated path like `/var/lib/vediqra/uploads` that the app points at).
- Never run `rm -rf` or a clean checkout over the backend directory without first moving `uploads/`
  aside.
- If containerising, mount `backend/uploads` as a volume rather than baking it into the image.

### 4.3 Permissions

The Node process needs read+write on `backend/uploads/` and everything under it. On Linux, run the
backend as a dedicated non-root user and `chown` that user on the uploads directory:

```bash
sudo mkdir -p /var/lib/vediqra/uploads
sudo chown -R vediqra:vediqra /var/lib/vediqra/uploads
```

Do not make the directory world-writable; only the backend process should be able to write to it.

### 4.4 Backup and restore

Uploads are **not** captured by a database backup — they're plain files. Back them up separately and
in sync with your database backups (a product row and its image file need to restore together):

```bash
# Backup (run alongside your normal pg_dump schedule)
tar -czf uploads-backup-$(date +%F).tar.gz -C backend uploads

# Restore
tar -xzf uploads-backup-<date>.tar.gz -C backend
```

For a more robust setup, sync `backend/uploads/` to off-box storage (rsync to another host, or a
scheduled copy to cloud object storage used purely as a backup target — not as the serving path).

### 4.5 Disk space monitoring

Unlike R2 (effectively unbounded, billed storage), local uploads consume the server's own disk. Set
up monitoring/alerting on disk usage for the partition `backend/uploads/` lives on, and decide a
retention/cleanup policy for orphaned customisation images (uploaded but never used in a completed
order) if volume becomes a concern — there is currently no automatic cleanup job for these.

### 4.6 Multi-server limitation

**Local storage does not work across multiple backend instances/servers without a shared filesystem.**
If you scale the backend horizontally (multiple Node processes behind a load balancer, each on its
own disk), a file uploaded via one instance will 404 on requests routed to another. Options if you
need multi-server:

- Use a shared network filesystem (NFS/EFS-equivalent) mounted at the same path on every instance, or
- Pin uploads and their serving routes to a single instance (sticky routing), or
- Reintroduce a shared object store — out of scope for this phase per explicit instruction, but worth
  knowing as the standard fix if horizontal scaling becomes a requirement.

A single-server deployment (one backend process, vertically scaled if needed) has none of these
issues and is what this implementation assumes.

## 5. SMTP (order emails)

Set `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASSWORD`. The transporter
verifies the connection once at startup and logs success/failure but does not crash the server if
SMTP is unreachable — orders still save even if the confirmation email fails to send (failures are
caught and logged, not thrown). Test with the admin-only `GET /smtp-test` endpoint (requires a valid
admin JWT) after deploying.

As of this phase, TLS certificate verification is enforced (previously disabled via
`rejectUnauthorized: false`, which allowed a man-in-the-middle to intercept the SMTP connection) and
protocol debug logging is automatically disabled when `NODE_ENV=production`.

## 6. Razorpay (payments)

Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to **live** keys for production. The server only
constructs the Razorpay client lazily on first use (`getRazorpay()` in `src/services/razorpayClient.ts`)
and returns a clean `503 Online payments are not configured` instead of crashing if the keys are
missing — so the rest of the API (browsing, COD orders) works even without Razorpay configured. Test
a real payment end-to-end with live keys before announcing launch; this was not (and could not safely
be) tested in this phase without real credentials.

## 7. Brand/contact/analytics configuration

All of the following are optional and render nothing (or stay disabled) until set — see
`frontend/.env.example` and `backend/.env.example`:

- `BRAND_NAME`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `WEBSITE_URL` (backend — used in emails/invoices)
- `VITE_SUPPORT_EMAIL`, `VITE_SUPPORT_PHONE`, `VITE_WEBSITE_URL`, `VITE_SOCIAL_*` (frontend — footer/contact)
- `VITE_META_PIXEL_ID` — leave unset to keep analytics fully disabled

## 8. Frontend build

```bash
cd frontend
npm install
npm run build        # runs tsc then vite build
# Copy dist/ to nginx's html root
sudo cp -r dist/* /usr/share/nginx/html/
```

`VITE_API_URL` must stay empty (see `FIXES_README.md` for the historical reason) — nginx proxies
`/api/*` to the backend, and the backend now also serves `/uploads/*` the same way.

### nginx example

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:5000;
}
location /uploads/ {
    proxy_pass http://127.0.0.1:5000;
}
```

## 9. Health checks and smoke tests

- `GET /health` — basic liveness (no auth).
- `GET /api/test` — confirms the API is reachable.
- After deploy, manually verify: homepage loads, an admin login succeeds, an admin image upload
  round-trips (upload → appears via its returned URL), and (once SMTP/Razorpay are live) a test COD
  order and a test paid order both complete and email correctly.

## 10. Rollback

Because uploads live on local disk rather than a cloud bucket, a rollback to a previous backend
release must either keep the same `backend/uploads/` directory (if the upload format/paths are
unchanged) or restore it from the matching backup (section 4.4). Database rollbacks should restore
the matching `pg_dump` snapshot taken at the same time as the uploads backup, so DB rows and files
stay in sync.

For a schema change specifically (not a full rollback), `npm run migrate -- down` reverts the single
most recent migration if it has a correct Down and the application code has already been rolled back
first (so nothing is still relying on the newer schema). For anything beyond the single most recent
migration, restore from the pre-migration `pg_dump` backup instead of chaining multiple `down`s —
see `docs/DATABASE_MIGRATIONS.md` ("Rollback strategy").
