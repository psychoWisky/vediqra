import { Response } from 'express';

/**
 * Turn common PostgreSQL errors into meaningful HTTP responses instead of a generic 500.
 * Returns true when it handled the error.
 */
export function sendDbError(res: Response, error: any, what = 'record'): boolean {
  switch (error?.code) {
    case '23505': { // unique_violation
      const c = String(error.constraint || '');
      const field =
        c.includes('slug') ? 'slug'
        : c.includes('value_key') || c.includes('value_key_key') ? 'value'
        : c.includes('product_id_option_group_id') ? 'option group'
        : c.includes('code') ? 'code'
        : c.includes('name') ? 'name'
        : 'value';
      res.status(409).json({ error: `A ${what} with this ${field} already exists` });
      return true;
    }
    case '23503': // foreign_key_violation
      res.status(400).json({ error: `Referenced ${what} does not exist or is still in use` });
      return true;
    case '23514': // check_violation
      res.status(400).json({ error: `Invalid value for ${what} (${error.constraint || 'check failed'})` });
      return true;
    case '22P02': // invalid_text_representation (e.g. malformed uuid)
      res.status(400).json({ error: 'Invalid identifier or value' });
      return true;
    case 'P0001': // RAISE EXCEPTION from a trigger (e.g. category hierarchy rule)
      res.status(400).json({ error: error.message });
      return true;
    default:
      return false;
  }
}
