#!/usr/bin/env node
'use strict';

// Thin wrapper around node-pg-migrate so migrations read the SAME connection settings as the app
// (backend/.env — DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/DB_SSL) instead of a separate
// DATABASE_URL that would have to be kept in sync by hand. The connection string is built in-memory
// and handed to the node-pg-migrate subprocess via its environment only — never logged or printed.
//
// Usage (from backend/):
//   npm run migrate -- up                  apply all pending migrations
//   npm run migrate -- down                roll back the most recent migration
//   npm run migrate -- up -- --dry-run     print the SQL without running it
//   npm run migrate -- create add_x -j sql create a new migration (sql or cjs)
//
// Migration files live in database/migrations/pg-migrate/ (NOT database/migrations/*.sql, which is
// the historical, pre-tooling record — see database/migrations/README.md).

require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');

const host = process.env.DB_HOST;
const port = process.env.DB_PORT || '5432';
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD || '';
const name = process.env.DB_NAME;
const isProduction = (process.env.NODE_ENV || 'development') === 'production';
const ssl = process.env.DB_SSL !== undefined ? process.env.DB_SSL === 'true' : isProduction;

if (!host || !user || !name) {
  console.error('migrate: DB_HOST, DB_USER and DB_NAME must be set (copy backend/.env.example to .env).');
  process.exit(1);
}

const databaseUrl =
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}` +
  (ssl ? '?sslmode=require' : '');

const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations', 'pg-migrate');

const forwarded = process.argv.slice(2);
const hasLanguageFlag = forwarded.some((a) => a === '-j' || a === '--migration-file-language');
const args = [
  'node-pg-migrate',
  ...forwarded,
  '-m', migrationsDir,
  // Default new migrations to plain SQL, matching this project's existing migration convention
  // (database/migrations/*.sql) — pass -j cjs explicitly for a migration that needs programmatic
  // logic (the baseline migration is .cjs for exactly that reason: it reads schema.sql at runtime).
  ...(hasLanguageFlag ? [] : ['-j', 'sql']),
];

const result = spawnSync('npx', args, {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
  shell: process.platform === 'win32',
});

process.exit(result.status == null ? 1 : result.status);
