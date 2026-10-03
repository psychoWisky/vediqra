SET client_encoding = 'UTF8';
-- ============================================================================
-- 005_seed_admin_user.sql
--
-- Seeds one admin login, requested directly by the client:
--   username: admin   (stored lower-case; POST /api/admin/auth/login lower-cases the typed username
--                       before comparing, so "Admin" also works at the login screen)
--   password: Admin@123
--
-- The password is stored only as its bcrypt hash (cost 12, matching backend/scripts/create-admin.ts and
-- backend/src/routes/adminAuth.ts) — never in plain text, in this file or anywhere else.
--
-- SECURITY NOTE FOR THE CLIENT: "Admin@123" is a short, guessable, widely-known-pattern password (9
-- characters). backend/scripts/create-admin.ts refuses anything under 10 characters for this reason; this
-- migration bypasses that guard because it was explicitly requested. Please change it after first login
-- (Admin Dashboard has no self-service password change yet — use `npm run create-admin -- admin <new password>`
-- from backend/, or ask for one to be added) — especially before this ever runs anywhere but a local/dev
-- database. Do not reuse this password on a production deployment.
--
-- Idempotent: re-running resets the password to the one above if the account already exists (same
-- ON CONFLICT pattern as create-admin.ts), rather than failing or creating a duplicate.
-- ============================================================================

INSERT INTO admin_users (username, password_hash, role, is_active)
VALUES ('admin', '$2b$12$PD6lpRw0x6nNe67/3/E6kev3qZ0cPfGJ3iozjz07wz.JmXBJlGIzS', 'admin', TRUE)
ON CONFLICT (username) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      is_active = TRUE,
      updated_at = now();
