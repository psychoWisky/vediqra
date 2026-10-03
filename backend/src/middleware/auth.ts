import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { pool } from '../utils/db';

export interface AdminTokenPayload {
  sub: string;      // admin_users.id
  username: string;
  role: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminTokenPayload;
  }
}

export const signAdminToken = (user: { id: string; username: string; role: string }): string =>
  jwt.sign(
    { sub: user.id, username: user.username, role: user.role } satisfies AdminTokenPayload,
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] }
  );

type AuthResult =
  | { ok: true; admin: AdminTokenPayload }
  | { ok: false; status: number; error: string };

/** Verify the Bearer token and confirm the admin account still exists and is active. */
async function authenticate(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { ok: false, status: 401, error: 'Unauthorized' };

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };

  let payload: AdminTokenPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AdminTokenPayload;
  } catch {
    return { ok: false, status: 401, error: 'Invalid or expired token' };
  }

  const result = await pool.query(
    'SELECT id, username, role FROM admin_users WHERE id = $1 AND is_active = TRUE',
    [payload.sub]
  );
  if (result.rows.length === 0) return { ok: false, status: 401, error: 'Account not found or disabled' };
  return { ok: true, admin: { sub: result.rows[0].id, username: result.rows[0].username, role: result.rows[0].role } };
}

/**
 * ADMIN ONLY guard. Verifies the signed JWT and confirms the admin account
 * still exists and is active, so deactivating an admin takes effect immediately.
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authenticate(req);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    req.admin = result.admin;
    next();
  } catch (error) {
    console.error('Auth check failed:', error);
    res.status(500).json({ error: 'Authentication check failed' });
  }
};

/**
 * For PUBLIC routes that show a little more to a signed-in admin (e.g. inactive products).
 * Never rejects: no/invalid credentials simply mean "not an admin".
 */
export const isAdminRequest = async (req: Request): Promise<boolean> => {
  if (!req.headers.authorization) return false;
  try {
    return (await authenticate(req)).ok;
  } catch {
    return false;
  }
};
