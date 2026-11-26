import { Hono } from 'hono';
import { CashoutReviewSchema, formatMicroUsd, maskPayoutAccount, type AdminCashoutItem, type CashoutAuditReport } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { requireStaff, getStaffRole } from '../middleware/staff';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { ledgerAfterUpdate } from '../utils/ledger';
import { isLocalDev } from '../utils/guards';
import { runCashoutAudit } from '../services/anticheat';

export const auditRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

/** Finance: reading the queue = super_admin / finance_auditor; approving / rejecting payouts = super_admin. */
const requireFinanceRead = requireStaff('financeRead');
const requireFinanceWrite = requireStaff('financeWrite');

const OPEN = ['pending', 'ai_verifying', 'flagged_review'] as const;
const STATUSES = ['open', 'pending', 'ai_verifying', 'flagged_review', 'approved', 'rejected', 'all'] as const;

function toAdminItem(w: any, fullAccount: boolean): AdminCashoutItem {
  let report: CashoutAuditReport | null = null;
  try {
    report = w.audit_report_json ? JSON.parse(w.audit_report_json) : null;
    if (report && (report as any).version !== 1) report = null;
  } catch {
    report = null;
  }
  return {
    id: w.id,
    userId: w.user_id,
    username: w.username,
    amountMicroUsd: w.amount_micro_usd,
    feeMicroUsd: w.fee_micro_usd,
    netPayoutMicroUsd: w.net_payout_micro_usd,
    payoutMethod: w.payout_method,
    payoutAccount: fullAccount ? w.payout_account : maskPayoutAccount(w.payout_method, w.payout_account),
    status: w.status,
    aiAuditScore: w.ai_audit_score ?? null,
    rejectReason: w.reject_reason || null,
    reviewedBy: w.reviewer || w.reviewed_by || null,
    forfeitedMicroUsd: w.forfeited_micro_usd || 0,
    createdAt: w.created_at,
    processedAt: w.processed_at,
    report,
  };
}

/** GET /api/audit/withdrawals?status=open|pending|flagged_review|approved|rejected|all — the cashout queue. */
auditRouter.get('/withdrawals', requireFinanceRead, async (c) => {
  const status = (STATUSES as readonly string[]).includes(c.req.query('status') || '') ? (c.req.query('status') as string) : 'open';
  const where = status === 'all' ? '1 = 1' : status === 'open' ? `w.status IN (${OPEN.map((s) => `'${s}'`).join(',')})` : 'w.status = ?1';
  const stmt = c.env.DB.prepare(
    `SELECT w.*, u.username, r.username AS reviewer FROM withdrawal_requests w
     JOIN users u ON u.id = w.user_id LEFT JOIN users r ON r.id = w.reviewed_by
     WHERE ${where} ORDER BY w.created_at DESC LIMIT 100`
  );
  const rows = await (status === 'all' || status === 'open' ? stmt : stmt.bind(status)).all<any>();
  // Full payout accounts only for the super_admin who sends the money; auditors see them masked
  const full = (await getStaffRole(c as any)) === 'super_admin';
  const role = await getStaffRole(c as any);
  return c.json({ withdrawals: (rows.results || []).map((w) => toAdminItem(w, full)), canReview: role === 'super_admin' });
});

/** Legacy path used by older admin builds. */
auditRouter.get('/pending', requireFinanceRead, async (c) => c.redirect('/api/audit/withdrawals?status=open', 307));

/** GET /api/audit/flags?userId= — anti-cheat flags (open first). */
auditRouter.get('/flags', requireFinanceRead, async (c) => {
  const userId = c.req.query('userId');
  const rows = await (userId
    ? c.env.DB.prepare('SELECT * FROM anticheat_flags WHERE user_id = ?1 ORDER BY resolved ASC, created_at DESC LIMIT 100').bind(userId)
    : c.env.DB.prepare('SELECT f.*, u.username FROM anticheat_flags f JOIN users u ON u.id = f.user_id ORDER BY f.resolved ASC, f.created_at DESC LIMIT 100')
  ).all<any>();
  return c.json({ flags: rows.results || [] });
});

/** POST /api/audit/withdrawals/:id/rerun — run the 3-layer audit again (super_admin). */
auditRouter.post('/withdrawals/:id/rerun', requireFinanceWrite, async (c) => {
  const w = await c.env.DB.prepare(`SELECT id, user_id, status FROM withdrawal_requests WHERE id = ?1`).bind(c.req.param('id')).first<any>();
  if (!w) return c.json({ error: 'Withdrawal not found' }, 404);
  if (!(OPEN as readonly string[]).includes(w.status)) return c.json({ error: 'Already processed' }, 409);
  const report = await runCashoutAudit(c.env, w.user_id, w.id);
  await c.env.DB.prepare(`UPDATE withdrawal_requests SET status = ?1, ai_audit_score = ?2, audit_report_json = ?3 WHERE id = ?4 AND status IN ('pending', 'ai_verifying', 'flagged_review')`)
    .bind(report.decision, report.score, JSON.stringify(report), w.id)
    .run();
  return c.json({ success: true, status: report.decision, score: report.score, report });
});

/**
 * POST /api/audit/review { withdrawal_id, action: approve|reject, reason?, forfeit_collusive? } — super_admin only.
 * Approve: marks the payout sent. A flagged request needs a written reason (kept in the audit trail).
 * Reject: refunds the amount to the wallet (atomic, ledgered); with forfeit_collusive the Layer-3
 * collusive earnings stay with the platform instead.
 */
auditRouter.post('/review', requireFinanceWrite, async (c) => {
  const me = c.get('user');
  const parsed = CashoutReviewSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid review payload' }, 400);
  const { withdrawal_id, action, reason, forfeit_collusive } = parsed.data;

  const w = await c.env.DB
    .prepare("SELECT * FROM withdrawal_requests WHERE id = ?1 AND status IN ('pending', 'ai_verifying', 'flagged_review')")
    .bind(withdrawal_id)
    .first<any>();
  if (!w) return c.json({ error: 'Withdrawal not found or already processed' }, 404);
  const now = Math.floor(Date.now() / 1000);
  const audit = (old: unknown, next: unknown) =>
    c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, ?3, 'cashout_review', ?4, ?5, ?6)").bind(
      `sal_${crypto.randomUUID()}`,
      me.userId,
      w.id,
      JSON.stringify(old),
      JSON.stringify(next),
      now
    );

  if (action === 'approve') {
    if (w.status !== 'pending' && !reason) {
      return c.json({ error: 'This request is flagged or unaudited: write a reason to approve it', code: 'REASON_REQUIRED' }, 400);
    }
    const res = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE withdrawal_requests SET status = 'approved', processed_at = ?1, reviewed_by = ?2 WHERE id = ?3 AND status = ?4").bind(now, me.userId, w.id, w.status),
      audit({ status: w.status, score: w.ai_audit_score }, { status: 'approved', reason: reason || null }),
    ]);
    if ((res[0].meta?.changes ?? 0) !== 1) return c.json({ error: 'Already processed' }, 409);
    await logFinancialTransaction(c.env, {
      transaction_id: `tx_payout_${w.id.slice(0, 8)}_${now}`,
      user_id: w.user_id,
      action_type: 'CASHOUT_APPROVED',
      amount_micro_usd: BigInt(w.net_payout_micro_usd),
      balance_after_micro_usd: await walletBalance(c.env.DB, w.user_id),
      related_user_id: me.userId,
    });
    return c.json({ success: true, withdrawalId: w.id, status: 'approved', processedAt: now });
  }

  // Reject → refund (minus collusive earnings when forfeiting)
  if (!reason) return c.json({ error: 'A reject reason is required', code: 'REASON_REQUIRED' }, 400);
  let forfeit = 0;
  if (forfeit_collusive) {
    try {
      const rep = JSON.parse(w.audit_report_json || 'null') as CashoutAuditReport | null;
      forfeit = Math.max(0, Math.min(w.amount_micro_usd, Math.floor(rep?.layer3?.collusiveEarningsMicroUsd || 0)));
    } catch {
      forfeit = 0;
    }
  }
  const refund = w.amount_micro_usd - forfeit;
  const stmts = [
    c.env.DB.prepare(
      "UPDATE withdrawal_requests SET status = 'rejected', processed_at = ?1, reviewed_by = ?2, reject_reason = ?3, forfeited_micro_usd = ?4 WHERE id = ?5 AND status = ?6"
    ).bind(now, me.userId, reason, forfeit, w.id, w.status),
    // Refund only if the status flip above happened (no double refund on a double click)
    c.env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_withdrawn_micro_usd = MAX(0, total_withdrawn_micro_usd - ?2), updated_at = ?3 WHERE user_id = ?4 AND changes() = 1'
    ).bind(refund, w.amount_micro_usd, now, w.user_id),
    ledgerAfterUpdate(c.env.DB, w.user_id, refund, 'CASHOUT_REJECT_REFUND', w.id, now),
  ];
  if (forfeit > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO system_balances (id, energy_pool_micro_usd, platform_micro_usd, updated_at) SELECT 'global', 0, ?1, ?2 WHERE changes() = 1
         ON CONFLICT(id) DO UPDATE SET platform_micro_usd = platform_micro_usd + ?1, updated_at = ?2`
      ).bind(forfeit, now)
    );
  }
  stmts.push(audit({ status: w.status, score: w.ai_audit_score }, { status: 'rejected', reason, refund, forfeit }));
  const res = await c.env.DB.batch(stmts);
  if ((res[0].meta?.changes ?? 0) !== 1) return c.json({ error: 'Already processed' }, 409);
  if (forfeit > 0) {
    await c.env.DB.prepare("UPDATE anticheat_flags SET resolved = 1 WHERE user_id = ?1 AND layer = 3 AND resolved = 0").bind(w.user_id).run();
  }
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_refund_${w.id.slice(0, 8)}_${now}`,
    user_id: w.user_id,
    action_type: 'CASHOUT_REJECT_REFUND',
    amount_micro_usd: BigInt(refund),
    balance_after_micro_usd: await walletBalance(c.env.DB, w.user_id),
    related_user_id: me.userId,
  });
  return c.json({
    success: true,
    withdrawalId: w.id,
    status: 'rejected',
    refundedAmountMicroUsd: refund,
    forfeitedMicroUsd: forfeit,
    formattedRefunded: formatMicroUsd(refund),
  });
});

/** POST /api/audit/flags/:id/resolve — super_admin marks a flag as reviewed. */
auditRouter.post('/flags/:id/resolve', requireFinanceWrite, async (c) => {
  const r = await c.env.DB.prepare('UPDATE anticheat_flags SET resolved = 1 WHERE id = ?1 AND resolved = 0').bind(c.req.param('id')).run();
  return c.json({ success: (r.meta?.changes ?? 0) === 1 });
});

// Local dev only: kept for the Dev Mock Panel (routes through the real review logic is not needed here)
auditRouter.post('/dev/simulate-ai-review', async (c) => {
  if (!isLocalDev(c)) return c.json({ error: 'Dev simulation is only available on local dev' }, 403);
  return c.json({ error: 'Use the admin cashout queue (POST /api/audit/review)' }, 410);
});
