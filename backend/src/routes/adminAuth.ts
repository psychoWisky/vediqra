import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../utils/db';
import { requireAuth, signAdminToken } from '../middleware/auth';
import { loginLimiter } from '../middleware/rateLimit';

const router = express.Router();

// Compared against when the username does not exist, so a missing account and a wrong
// password take about the same time (avoids username enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

// PUBLIC (rate limited): exchange username + password for a signed admin token.
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password || password.length > 200) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT id, username, role, password_hash, is_active FROM admin_users WHERE username = $1',
      [username]
    );
    const user = result.rows[0];

    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !user.is_active || !passwordOk) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    await pool.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);

    res.json({
      success: true,
      token: signAdminToken(user),
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ADMIN ONLY: validate the current token (used by the admin UI on page load).
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ user: { id: req.admin!.sub, username: req.admin!.username, role: req.admin!.role } });
});

export default router;
