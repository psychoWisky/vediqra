import express, { Request, Response } from 'express';
import { webhookLimiter } from '../middleware/rateLimit';
import { handleWebhook } from '../services/payments/webhook';

const router = express.Router();

// Razorpay -> server. The body is read as raw bytes (the signature is computed over them), never as parsed JSON.
router.post('/', webhookLimiter, express.raw({ type: () => true, limit: '1mb' }), async (req: Request, res: Response) => {
  const reply = await handleWebhook(req.body, req.headers);
  for (const [k, v] of Object.entries(reply.headers || {})) res.setHeader(k, v);
  res.status(reply.status).json(reply.body);
});

export default router;
