import { Hono } from 'hono';
import {
  WithdrawalCreateSchema,
  formatMicroUsd,
  formatCoins,
  microUsdToCoins,
  WITHDRAWAL_BASE_FEE_MICRO_USD,
  MIN_WITHDRAWAL_MICRO_USD,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction } from '../utils/audit-logger';

export const walletRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

walletRouter.use('*', authMiddleware);

// 1. Get Wallet Balance
walletRouter.get('/', async (c) => {
  const user = c.get('user');

  const wallet = await c.env.DB
    .prepare('SELECT balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, updated_at FROM wallets WHERE user_id = ?1')
    .bind(user.userId)
    .first<{ balance_micro_usd: number; total_earned_micro_usd: number; total_withdrawn_micro_usd: number; updated_at: number }>();

  if (!wallet) {
    return c.json({ error: 'Wallet not found' }, 404);
  }

  return c.json({
    balanceMicroUsd: wallet.balance_micro_usd,
    coins: microUsdToCoins(wallet.balance_micro_usd).toString(),
    formattedBalance: formatMicroUsd(wallet.balance_micro_usd),
    formattedCoins: formatCoins(wallet.balance_micro_usd),
    totalEarnedMicroUsd: wallet.total_earned_micro_usd,
    formattedTotalEarned: formatMicroUsd(wallet.total_earned_micro_usd),
    totalWithdrawnMicroUsd: wallet.total_withdrawn_micro_usd,
    formattedTotalWithdrawn: formatMicroUsd(wallet.total_withdrawn_micro_usd),
  });
});

// 2. Request Withdrawal (Min $10 = 10,000,000 Micro-USD)
walletRouter.post('/withdraw', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);

  const parseResult = WithdrawalCreateSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { amount_micro_usd, crypto_currency, payout_address } = parseResult.data;

  // Fetch current wallet
  const wallet = await c.env.DB
    .prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1')
    .bind(user.userId)
    .first<{ balance_micro_usd: number }>();

  if (!wallet || wallet.balance_micro_usd < amount_micro_usd) {
    return c.json({
      error: 'Insufficient balance',
      currentBalance: wallet?.balance_micro_usd || 0,
      requested: amount_micro_usd,
    }, 400);
  }

  const withdrawalId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const fee = Number(WITHDRAWAL_BASE_FEE_MICRO_USD);
  const newBalance = wallet.balance_micro_usd - amount_micro_usd;

  // Atomic deduction from wallet and insertion of withdrawal request
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd - ?1, total_withdrawn_micro_usd = total_withdrawn_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND balance_micro_usd >= ?1'
    ).bind(amount_micro_usd, now, user.userId),
    c.env.DB.prepare(
      'INSERT INTO withdrawal_requests (id, user_id, amount_micro_usd, fee_micro_usd, crypto_currency, payout_address, status, ai_audit_score, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
    ).bind(withdrawalId, user.userId, amount_micro_usd, fee, crypto_currency, payout_address, 'ai_verifying', 0.98, now),
  ]);

  // Log to financial audit pipeline
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_${withdrawalId.slice(0, 8)}_${now}`,
    user_id: user.userId,
    action_type: 'CASHOUT_REQUEST',
    amount_micro_usd: BigInt(amount_micro_usd),
    balance_after_micro_usd: BigInt(newBalance),
  });

  return c.json({
    success: true,
    withdrawalId,
    status: 'ai_verifying',
    amountMicroUsd: amount_micro_usd,
    feeMicroUsd: fee,
    netPayoutMicroUsd: amount_micro_usd - fee,
    formattedAmount: formatMicroUsd(amount_micro_usd),
    cryptoCurrency: crypto_currency,
    payoutAddress: payout_address,
  }, 201);
});

// 3. List User Withdrawals
walletRouter.get('/withdrawals', async (c) => {
  const user = c.get('user');

  const rows = await c.env.DB
    .prepare('SELECT * FROM withdrawal_requests WHERE user_id = ?1 ORDER BY created_at DESC')
    .bind(user.userId)
    .all();

  const requests = (rows.results || []).map((w: any) => ({
    ...w,
    formattedAmount: formatMicroUsd(w.amount_micro_usd),
    formattedFee: formatMicroUsd(w.fee_micro_usd),
  }));

  return c.json({ requests });
});

// 4. Dev Mock Faucet (Top-up balance for testing)
walletRouter.post('/dev/faucet', async (c) => {
  if (c.env.DEV_MOCK_MODE !== 'true') {
    return c.json({ error: 'Faucet is only available in DEV_MOCK_MODE' }, 403);
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
