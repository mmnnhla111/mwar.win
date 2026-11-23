import { Hono } from 'hono';
import { WithdrawalReviewSchema, formatMicroUsd } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';
import { logFinancialTransaction, logReceiverHeaders, walletBalance } from '../utils/audit-logger';
import type { Context, Next } from 'hono';
import { isLocalDev } from '../utils/guards';

export const auditRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

/** Admin / auditor only (local `wrangler dev` keeps the Dev Mock Panel working without a role). */
async function requireAuditor(c: Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>, next: Next) {
  if (isLocalDev(c)) return next();
  return authMiddleware(c, async () => {
    await requireRole(['admin', 'auditor'])(c, next);
  });
}

/**
 * Layer 1 (deterministic): the D1 wallet balance must equal the PostgreSQL 90-day ledger sum
 * (inflows − withdrawals − purchases) to the exact Micro-USD before any payout is approved.
 */
async function layer1Check(env: Env, userId: string) {
  const base = (env.LOG_RECEIVER_URL || 'http://localhost:3000/api/logs').replace(/\/api\/logs\/?$/, '');
  const d1 = await walletBalance(env.DB, userId);
  try {
    const res = await fetch(`${base}/api/logs/summary/${encodeURIComponent(userId)}`, { headers: logReceiverHeaders(env) });
    if (!res.ok) return { ok: false as const, reason: `log receiver HTTP ${res.status}`, d1 };
    const j = (await res.json()) as { calculatedBalanceMicroUsd?: string; source?: string };
    const calc = BigInt(j.calculatedBalanceMicroUsd ?? '0');
    return calc === d1
      ? { ok: true as const, d1, calc }
      : { ok: false as const, reason: `D1 balance ${d1} != ledger ${calc} (diff ${d1 - calc})`, d1, calc };
  } catch (err: any) {
    return { ok: false as const, reason: `log receiver unreachable: ${err?.message ?? err}`, d1 };
  }
}

// 1. Get Pending Withdrawals (For Admin / Auditor / Dev UI)
auditRouter.get('/pending', requireAuditor, async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT w.id, w.user_id, w.amount_micro_usd, w.fee_micro_usd, w.crypto_currency,
              w.payout_address, w.status, w.ai_audit_score, w.created_at,
              u.username, u.email
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       WHERE w.status IN ('pending', 'ai_verifying')
       ORDER BY w.created_at DESC`
    )
    .all<any>();

  const withdrawals = (rows.results || []).map((w: any) => ({
    ...w,
    formattedAmount: formatMicroUsd(w.amount_micro_usd),
    formattedFee: formatMicroUsd(w.fee_micro_usd),
    netAmountMicroUsd: w.amount_micro_usd - w.fee_micro_usd,
    formattedNetAmount: formatMicroUsd(w.amount_micro_usd - w.fee_micro_usd),
  }));

  return c.json({ withdrawals });
});

// 2. Review and Process Withdrawal (Approve or Reject with Refund)
auditRouter.post('/review', requireAuditor, async (c) => {
  const body = await c.req.json().catch(() => null);

  const parseResult = WithdrawalReviewSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { withdrawal_id, action, reason } = parseResult.data;

  const withdrawal = await c.env.DB
    .prepare("SELECT * FROM withdrawal_requests WHERE id = ?1 AND status IN ('pending', 'ai_verifying')")
    .bind(withdrawal_id)
    .first<any>();

  if (!withdrawal) {
    return c.json({ error: 'Withdrawal request not found or already processed' }, 404);
  }

  const now = Math.floor(Date.now() / 1000);

  if (action === 'approve') {
    // Layer 1 must pass before money leaves (the requested amount was already debited from D1, and
    // the CASHOUT_REQUEST row debits the ledger the same way, so both sides must still match).
    const l1 = await layer1Check(c.env, withdrawal.user_id);
    if (!l1.ok && !(isLocalDev(c) && body?.force === true)) {
      await c.env.DB
        .prepare('UPDATE withdrawal_requests SET audit_reasons = ?1 WHERE id = ?2')
        .bind(JSON.stringify({ layer1: 'FAILED', reason: l1.reason, at: now }), withdrawal.id)
        .run();
      console.warn(`[ADMIN ALERT] Layer-1 audit failed for withdrawal ${withdrawal.id}: ${l1.reason}`);
      return c.json({ error: 'Layer 1 audit failed — withdrawal held for manual review', reason: l1.reason }, 409);
    }
    // Approve withdrawal
    await c.env.DB
      .prepare("UPDATE withdrawal_requests SET status = 'approved', processed_at = ?1, audit_reasons = ?2 WHERE id = ?3")
      .bind(now, JSON.stringify({ approvedBy: 'AI_AUDIT_PIPELINE', reason: reason || 'Clean audit trail' }), withdrawal.id)
      .run();

    return c.json({
      success: true,
      withdrawalId: withdrawal.id,
      status: 'approved',
      processedAt: now,
    });
  } else {
    // Reject withdrawal -> Refund funds back to user wallet!
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE withdrawal_requests SET status = 'rejected', processed_at = ?1, audit_reasons = ?2 WHERE id = ?3"
      ).bind(now, JSON.stringify({ rejectedBy: 'AI_AUDIT_PIPELINE', reason: reason || 'Audit policy violation' }), withdrawal.id),
      c.env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_withdrawn_micro_usd = total_withdrawn_micro_usd - ?1, updated_at = ?2 WHERE user_id = ?3'
      ).bind(withdrawal.amount_micro_usd, now, withdrawal.user_id),
    ]);

    await logFinancialTransaction(c.env, {
      transaction_id: `tx_refund_${withdrawal.id.slice(0, 8)}_${now}`,
      user_id: withdrawal.user_id,
      action_type: 'CASHOUT_REJECT_REFUND',
      amount_micro_usd: BigInt(withdrawal.amount_micro_usd),
      balance_after_micro_usd: await walletBalance(c.env.DB, withdrawal.user_id),
    });

    return c.json({
      success: true,
      withdrawalId: withdrawal.id,
      status: 'rejected',
      refundedAmountMicroUsd: withdrawal.amount_micro_usd,
      formattedRefunded: formatMicroUsd(withdrawal.amount_micro_usd),
    });
  }
});

// 3. Dev Mock Simulation for AI Audit Pipeline
auditRouter.post('/dev/simulate-ai-review', async (c) => {
  if (!isLocalDev(c)) {
    return c.json({ error: 'Available only on local dev' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const { withdrawalId, targetState = 'approved', aiScore = 0.99, reason = 'Automated Dev Simulation' } = body;

  if (!withdrawalId) {
    return c.json({ error: 'Missing withdrawalId' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  if (targetState === 'approved') {
    await c.env.DB
      .prepare("UPDATE withdrawal_requests SET status = 'approved', ai_audit_score = ?1, processed_at = ?2, audit_reasons = ?3 WHERE id = ?4")
      .bind(aiScore, now, JSON.stringify({ tier1Match: true, tier2AimAnomaly: false, note: reason }), withdrawalId)
      .run();
  } else if (targetState === 'rejected') {
    const w = await c.env.DB
      .prepare("SELECT amount_micro_usd, user_id FROM withdrawal_requests WHERE id = ?1 AND status IN ('pending', 'ai_verifying')")
      .bind(withdrawalId)
      .first<any>();
    if (w) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE withdrawal_requests SET status = 'rejected', ai_audit_score = ?1, processed_at = ?2, audit_reasons = ?3 WHERE id = ?4")
          .bind(aiScore, now, JSON.stringify({ tier1Match: false, reason }), withdrawalId),
        c.env.DB.prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_withdrawn_micro_usd = total_withdrawn_micro_usd - ?1, updated_at = ?2 WHERE user_id = ?3')
          .bind(w.amount_micro_usd, now, w.user_id),
      ]);
      await logFinancialTransaction(c.env, {
        transaction_id: `tx_refund_${String(withdrawalId).slice(0, 8)}_${now}`,
        user_id: w.user_id,
        action_type: 'CASHOUT_REJECT_REFUND',
        amount_micro_usd: BigInt(w.amount_micro_usd),
        balance_after_micro_usd: await walletBalance(c.env.DB, w.user_id),
      });
    }
  } else {
    await c.env.DB
      .prepare("UPDATE withdrawal_requests SET status = 'ai_verifying', ai_audit_score = ?1 WHERE id = ?2")
      .bind(aiScore, withdrawalId)
      .run();
  }

  return c.json({
    simulation: true,
    withdrawalId,
    targetState,
    aiScore,
  });
});
