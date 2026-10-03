/**
 * Create or reset an admin user. The password is hashed with bcrypt before it touches the database.
 *
 *   npm run create-admin -- <username> [password]
 *
 * If the password is omitted it is read from the ADMIN_PASSWORD environment variable, so it does not
 * end up in shell history. Re-running for an existing username resets that admin's password.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/utils/db';

async function main() {
  const username = (process.argv[2] || process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.argv[3] || process.env.ADMIN_PASSWORD || '';

  if (!username || !password) {
    console.error('Usage: npm run create-admin -- <username> [password]   (or set ADMIN_PASSWORD)');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO admin_users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, is_active = TRUE, updated_at = now()
     RETURNING id, username, role, (xmax = 0) AS created`,
    [username, hash]
  );
  const row = result.rows[0];
  console.log(`${row.created ? 'Created' : 'Updated'} admin "${row.username}" (role: ${row.role}).`);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to create admin:', err.message);
  process.exit(1);
});
