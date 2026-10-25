// Notification outbox: e-mails are queued in the SAME transaction as the event that causes them (so nothing is sent for a
// state that was rolled back, and nothing is lost if the process dies right after commit), then sent after commit.
// Delivery is at-least-once: a crash between "SMTP accepted" and "marked sent" can send one message twice; the dedupe key
// prevents a second row for the same event, and a lease prevents two workers sending the same row at the same time.
import config from '../../config';
import { pool } from '../../utils/db';
import {
  sendOrderConfirmationEmail, sendAdminNotification, sendPaymentRefundNoticeEmail, sendAdminAlertEmail,
} from '../gmailService';
import { backoffMs, plog, safeError } from './common';

type Db = { query: (t: string, v?: any[]) => Promise<any> };

export type OutboxKind = 'order_confirmation' | 'admin_new_order' | 'payment_refund_notice' | 'admin_alert';

export interface OutboxRow {
  id: string; kind: OutboxKind; dedupe_key: string; recipient_kind: 'customer' | 'admin';
  order_id: string | null; intent_id: string | null; payload: Record<string, any>; attempts: number;
}

export const OUTBOX_MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 120;

/** Queue a notification inside the caller's transaction. Idempotent: the same dedupe key is never queued twice. */
export async function enqueueNotification(client: Db, n: {
  kind: OutboxKind; dedupeKey: string; recipient: 'customer' | 'admin'; orderId?: string | null; intentId?: string | null; payload?: Record<string, unknown>;
}): Promise<boolean> {
  const r = await client.query(
    `INSERT INTO notification_outbox (kind, dedupe_key, recipient_kind, order_id, intent_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [n.kind, n.dedupeKey, n.recipient, n.orderId ?? null, n.intentId ?? null, JSON.stringify(n.payload ?? {})]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Claim up to `limit` due rows (queued and due, or sending with an expired lease), optionally only for one order/intent. */
async function claim(limit: number, scope?: { orderId?: string; intentId?: string }): Promise<OutboxRow[]> {
  const where: string[] = [`((status = 'queued' AND next_attempt_at <= now()) OR (status = 'sending' AND lease_until < now()))`];
  const params: unknown[] = [];
  if (scope?.orderId) { params.push(scope.orderId); where.push(`order_id = $${params.length}`); }
  if (scope?.intentId) { params.push(scope.intentId); where.push(`intent_id = $${params.length}`); }
  params.push(limit);
  const r = await pool.query(
    `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, last_attempt_at = now(),
            lease_until = now() + interval '${LEASE_SECONDS} seconds'
      WHERE id IN (SELECT id FROM notification_outbox WHERE ${where.join(' AND ')} ORDER BY created_at LIMIT $${params.length} FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, dedupe_key, recipient_kind, order_id, intent_id, payload, attempts`,
    params
  );
  return r.rows;
}

type SendOutcome = { ok: true } | { ok: false; error: string; permanent?: boolean } | { skip: string };

async function deliver(row: OutboxRow): Promise<SendOutcome> {
  if (!config.emailUser) return { skip: 'e-mail is not configured' };
  switch (row.kind) {
    case 'order_confirmation':
    case 'admin_new_order': {
      const o = (await pool.query('SELECT * FROM orders WHERE id = $1', [row.order_id])).rows[0];
      if (!o) return { skip: 'order no longer exists' };
      const res = row.kind === 'order_confirmation' ? await sendOrderConfirmationEmail(o) : await sendAdminNotification(o);
      return res.success ? { ok: true } : { ok: false, error: res.error || 'send failed' };
    }
    case 'payment_refund_notice': {
      const i = (await pool.query('SELECT razorpay_order_id, amount_paise, customer, scrubbed_at FROM payment_intents WHERE id = $1', [row.intent_id])).rows[0];
      const email = i?.customer?.email;
      if (!i || i.scrubbed_at || typeof email !== 'string' || !email) return { skip: 'customer details no longer available' };
      const res = await sendPaymentRefundNoticeEmail({
        to: email, customer_name: String(i.customer.name || 'Customer'), amount: Number(i.amount_paise) / 100,
        reference: i.razorpay_order_id || '', reason: String(row.payload.reasonText || 'an item in your order became unavailable.'),
      });
      return res.success ? { ok: true } : { ok: false, error: res.error || 'send failed' };
    }
    case 'admin_alert': {
      const p = row.payload;
      const lines = [`What: ${p.reason ?? 'attention needed'}`];
      if (p.detail) lines.push(`Detail: ${p.detail}`);
      if (row.intent_id) {
        const i = (await pool.query('SELECT razorpay_order_id, razorpay_payment_id, amount_paise, status FROM payment_intents WHERE id = $1', [row.intent_id])).rows[0];
        if (i) lines.push(`Razorpay order: ${i.razorpay_order_id ?? '-'}`, `Razorpay payment: ${i.razorpay_payment_id ?? '-'}`, `Amount: INR ${(Number(i.amount_paise) / 100).toFixed(2)}`, `State: ${i.status}`);
      }
      if (row.order_id) lines.push(`Order id: ${row.order_id}`);
      const res = await sendAdminAlertEmail({ subject: String(p.subject || 'Payment needs attention'), lines });
      return res.success ? { ok: true } : { ok: false, error: res.error || 'send failed' };
    }
    default:
      return { skip: 'unknown notification kind' };
  }
}

async function settle(row: OutboxRow, outcome: SendOutcome): Promise<void> {
  if ('skip' in outcome) {
    await pool.query(`UPDATE notification_outbox SET status = 'skipped', lease_until = NULL, last_error = $2 WHERE id = $1`, [row.id, outcome.skip.slice(0, 200)]);
    plog('info', 'outbox_skipped', { kind: row.kind, reason: outcome.skip });
  } else if (outcome.ok) {
    await pool.query(`UPDATE notification_outbox SET status = 'sent', sent_at = now(), lease_until = NULL, last_error = NULL WHERE id = $1`, [row.id]);
  } else if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
    await pool.query(`UPDATE notification_outbox SET status = 'failed', lease_until = NULL, last_error = $2 WHERE id = $1`, [row.id, safeError(outcome.error, 400)]);
    plog('error', 'outbox_failed', { kind: row.kind, attempts: row.attempts, error: safeError(outcome.error, 120) });
  } else {
    const wait = backoffMs(row.attempts - 1, 60_000, 6 * 3600_000);
    await pool.query(
      `UPDATE notification_outbox SET status = 'queued', lease_until = NULL, last_error = $2, next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1`,
      [row.id, safeError(outcome.error, 400), String(wait)]
    );
  }
}

/** Send due notifications (all, or only those for one order / intent). Never throws: a failure is recorded on the row. */
export async function flushOutbox(scope?: { orderId?: string; intentId?: string }, limit = 20): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let rows: OutboxRow[] = [];
  try {
    rows = await claim(limit, scope);
  } catch (e) {
    plog('error', 'outbox_claim_failed', { error: safeError(e, 150) });
    return { sent, failed };
  }
  for (const row of rows) {
    let outcome: SendOutcome;
    try {
      outcome = await deliver(row);
    } catch (e) {
      outcome = { ok: false, error: safeError(e) };
    }
    try {
      await settle(row, outcome);
    } catch (e) {
      plog('error', 'outbox_settle_failed', { kind: row.kind, error: safeError(e, 150) });   // the lease will expire and the row is retried
    }
    if ('ok' in outcome && outcome.ok) sent++; else if (!('skip' in outcome)) failed++;
  }
  return { sent, failed };
}
