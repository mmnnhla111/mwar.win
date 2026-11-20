import { Hono } from 'hono';
import { WithdrawalReviewSchema, formatMicroUsd } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';
import { logFinancialTransaction } from '../utils/audit-logger';

export const auditRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

// 1. Get Pending Withdrawals (For Admin / Auditor / Dev UI)
auditRouter.get('/pending', async (c) => {
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
auditRouter.post('/review', async (c) => {
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
      balance_after_micro_usd: 0n,
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
  if (c.env.DEV_MOCK_MODE !== 'true') {
    return c.json({ error: 'Available only in DEV_MOCK_MODE' }, 403);
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
    const w = await c.env.DB.prepare('SELECT amount_micro_usd, user_id FROM withdrawal_requests WHERE id = ?1').bind(withdrawalId).first<any>();
    if (w) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE withdrawal_requests SET status = 'rejected', ai_audit_score = ?1, processed_at = ?2, audit_reasons = ?3 WHERE id = ?4")
          .bind(aiScore, now, JSON.stringify({ tier1Match: false, reason }), withdrawalId),
        c.env.DB.prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_withdrawn_micro_usd = total_withdrawn_micro_usd - ?1, updated_at = ?2 WHERE user_id = ?3')
          .bind(w.amount_micro_usd, now, w.user_id),
      ]);
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
