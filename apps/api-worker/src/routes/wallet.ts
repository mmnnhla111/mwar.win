import { Hono } from 'hono';
import {
  CashoutCreateSchema,
  CASHOUT_MIN_MICRO_USD,
  PAYOUT_FEE_MICRO_USD,
  formatMicroUsd,
  formatCoins,
  maskPayoutAccount,
  microUsdToCoins,
  normalizePayoutAccount,
  type CashoutItem,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { ledgerAfterUpdate, recordDeviceLink } from '../utils/ledger';
import { runCashoutAudit } from '../services/anticheat';
import { getDailyMlmSummary, getUtcDateKey } from './quests';
import { isLocalDev } from '../utils/guards';

export const walletRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

walletRouter.use('*', authMiddleware);

// 1. Get Wallet Balance
walletRouter.get('/', async (c) => {
  const user = c.get('user');

  const wallet = await c.env.DB
    .prepare('SELECT balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, bounty_micro_usd, updated_at FROM wallets WHERE user_id = ?1')
    .bind(user.userId)
    .first<{ balance_micro_usd: number; total_earned_micro_usd: number; total_withdrawn_micro_usd: number; bounty_micro_usd: number; updated_at: number }>();

  if (!wallet) {
    return c.json({ error: 'Wallet not found' }, 404);
  }

  return c.json({
    balanceMicroUsd: wallet.balance_micro_usd,
    // Head bounty: 5 % of every reward you earn, paid to whoever eliminates you (not withdrawable)
    headBountyMicroUsd: wallet.bounty_micro_usd ?? 0,
    formattedHeadBounty: formatMicroUsd(wallet.bounty_micro_usd ?? 0),
    coins: microUsdToCoins(wallet.balance_micro_usd).toString(),
    formattedBalance: formatMicroUsd(wallet.balance_micro_usd),
    formattedCoins: formatCoins(wallet.balance_micro_usd),
    totalEarnedMicroUsd: wallet.total_earned_micro_usd,
    formattedTotalEarned: formatMicroUsd(wallet.total_earned_micro_usd),
    totalWithdrawnMicroUsd: wallet.total_withdrawn_micro_usd,
    formattedTotalWithdrawn: formatMicroUsd(wallet.total_withdrawn_micro_usd),
  });
});

// 1.1 Get Today's Daily MLM Commission Summary
walletRouter.get('/daily-mlm-summary', async (c) => {
  const user = c.get('user');
  const dateKey = c.req.query('dateKey') || getUtcDateKey();
  const summary = await getDailyMlmSummary(c.env.DB, user.userId, dateKey);
  return c.json(summary);
});

// 2. Request a cashout ($10 minimum). Deducts atomically, then runs the 3-layer anti-cheat audit.
walletRouter.post('/withdraw', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  const parsed = CashoutCreateSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const code = issue?.path?.[0] === 'amount_micro_usd' ? (issue.code === 'too_small' ? 'BELOW_MINIMUM' : 'BAD_AMOUNT') : issue?.path?.[0] === 'payout_account' ? 'BAD_ACCOUNT' : 'VALIDATION';
    return c.json({ error: issue?.message || 'Validation failed', code, minimumMicroUsd: CASHOUT_MIN_MICRO_USD }, 400);
  }
  const { amount_micro_usd: amount, payout_method: method } = parsed.data;
  const account = normalizePayoutAccount(method, parsed.data.payout_account);
  const fee = PAYOUT_FEE_MICRO_USD[method];
  const net = amount - fee;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  // Atomic: debit + ledger row + request in ONE D1 batch. The wallet CHECK (balance_micro_usd >= 0)
  // aborts the whole batch when the balance is short (also against concurrent requests), so a request
  // never exists without its debit.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd - ?1, total_withdrawn_micro_usd = total_withdrawn_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
      ).bind(amount, now, user.userId),
      ledgerAfterUpdate(c.env.DB, user.userId, -amount, 'CASHOUT_REQUEST', id, now),
      c.env.DB.prepare(
        `INSERT INTO withdrawal_requests (id, user_id, amount_micro_usd, fee_micro_usd, net_payout_micro_usd, payout_method, payout_account, status, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ai_verifying', ?8 WHERE changes() = 1`
      ).bind(id, user.userId, amount, fee, net, method, account, now),
    ]);
  } catch {
    const w = await c.env.DB.prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1').bind(user.userId).first<{ balance_micro_usd: number }>();
    return c.json({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE', currentBalance: w?.balance_micro_usd ?? 0, requested: amount }, 400);
  }
  const created = await c.env.DB.prepare('SELECT id FROM withdrawal_requests WHERE id = ?1').bind(id).first();
  if (!created) return c.json({ error: 'Wallet not found', code: 'NO_WALLET' }, 404);

  await recordDeviceLink(c.env.DB, c.env.JWT_SECRET, user.userId, c.req.header('CF-Connecting-IP'));
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_${id.slice(0, 8)}_${now}`,
    user_id: user.userId,
    action_type: 'CASHOUT_REQUEST',
    amount_micro_usd: BigInt(amount),
    balance_after_micro_usd: await walletBalance(c.env.DB, user.userId),
  });

  // 3-layer AI audit → 'pending' (clean, waits for the super_admin payout) or 'flagged_review'
  let status: 'pending' | 'flagged_review' | 'ai_verifying' = 'ai_verifying';
  let score: number | null = null;
  try {
    const report = await runCashoutAudit(c.env, user.userId, id);
    status = report.decision;
    score = report.score;
    await c.env.DB.prepare("UPDATE withdrawal_requests SET status = ?1, ai_audit_score = ?2, audit_report_json = ?3 WHERE id = ?4 AND status = 'ai_verifying'")
      .bind(status, score, JSON.stringify(report), id)
      .run();
  } catch (e) {
    // Stays 'ai_verifying'; staff can re-run the audit from the admin queue
    console.error('cashout audit failed', e);
  }

  return c.json(
    {
      success: true,
      withdrawalId: id,
      status,
      amountMicroUsd: amount,
      feeMicroUsd: fee,
      netPayoutMicroUsd: net,
      formattedAmount: formatMicroUsd(amount),
      formattedNet: formatMicroUsd(net),
      payoutMethod: method,
      payoutAccount: maskPayoutAccount(method, account),
    },
    201
  );
});

// 3. The player's own cashout history (account masked)
walletRouter.get('/withdrawals', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB
    .prepare(
      `SELECT id, amount_micro_usd, fee_micro_usd, net_payout_micro_usd, payout_method, payout_account, status, ai_audit_score, reject_reason, created_at, processed_at
       FROM withdrawal_requests WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`
    )
    .bind(user.userId)
    .all<any>();
  const requests: CashoutItem[] = (rows.results || []).map((w: any) => ({
    id: w.id,
    amountMicroUsd: w.amount_micro_usd,
    feeMicroUsd: w.fee_micro_usd,
    netPayoutMicroUsd: w.net_payout_micro_usd,
    payoutMethod: w.payout_method,
    payoutAccount: maskPayoutAccount(w.payout_method, w.payout_account),
    // The player sees "under review" for both AI states; the score itself stays internal
    status: w.status,
    aiAuditScore: null,
    rejectReason: w.reject_reason || null,
    createdAt: w.created_at,
    processedAt: w.processed_at,
  }));
  return c.json({ requests, minimumMicroUsd: CASHOUT_MIN_MICRO_USD, fees: PAYOUT_FEE_MICRO_USD });
});

// 4. Dev Mock Faucet (Top-up balance for testing)
walletRouter.post('/dev/faucet', async (c) => {
  if (!isLocalDev(c)) {
    return c.json({ error: 'Faucet is only available on local dev' }, 403);
  }

  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  // Default to $20 USD (20,000,000 Micro-USD)
  const amountMicroUsd = body.amountMicroUsd ? Number(body.amountMicroUsd) : 20_000_000;
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB
    .prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3')
    .bind(amountMicroUsd, now, user.userId)
    .run();
  await c.env.DB.batch([
    // changes() of the UPDATE above is not visible across requests, so ledger it explicitly
    c.env.DB.prepare('INSERT INTO wallet_ledger (id, user_id, delta_micro_usd, action_type, ref_id, created_at) SELECT ?1, user_id, ?2, ?3, NULL, ?4 FROM wallets WHERE user_id = ?5')
      .bind(`led_${crypto.randomUUID()}`, amountMicroUsd, 'DEV_MOCK_FAUCET', now, user.userId),
  ]);

  const updatedWallet = await c.env.DB
    .prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1')
    .bind(user.userId)
    .first<{ balance_micro_usd: number }>();

  await logFinancialTransaction(c.env, {
    transaction_id: `tx_faucet_${Date.now()}`,
    user_id: user.userId,
    action_type: 'DEV_MOCK_FAUCET',
    amount_micro_usd: BigInt(amountMicroUsd),
    balance_after_micro_usd: BigInt(updatedWallet?.balance_micro_usd || amountMicroUsd),
  });

  return c.json({
    success: true,
    addedMicroUsd: amountMicroUsd,
    formattedAdded: formatMicroUsd(amountMicroUsd),
    newBalanceMicroUsd: updatedWallet?.balance_micro_usd,
    formattedNewBalance: formatMicroUsd(updatedWallet?.balance_micro_usd || 0),
  });
});
