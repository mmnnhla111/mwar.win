import { Hono } from 'hono';
import {
  calculateMlmDistribution,
  formatMicroUsd,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { getUplines } from '../utils/mlm-tree';
import { logFinancialTransaction } from '../utils/audit-logger';

export const adsRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

// Country tier rewards
const TIER_REWARDS_MICRO_USD: Record<string, number> = {
  US: 50_000,    // $0.05 USD = 500 Coins
  EU: 30_000,    // $0.03 USD = 300 Coins
  TH: 10_000,    // $0.01 USD = 100 Coins
  OTHER: 5_000,  // $0.005 USD = 50 Coins
};

// S2S Postback Processor Helper
async function processAdReward(
  env: Env,
  userId: string,
  provider: string,
  country: string,
  customAmountMicroUsd?: number
) {
  const grossReward = customAmountMicroUsd || TIER_REWARDS_MICRO_USD[country.toUpperCase()] || TIER_REWARDS_MICRO_USD.OTHER;
  const now = Math.floor(Date.now() / 1000);

  // 1. Fetch user's 5-level uplines
  const uplines = await getUplines(env.DB, userId);

  // 2. Calculate 5-level MLM distribution
  const mlm = calculateMlmDistribution(grossReward, uplines);

  // 3. Prepare atomic batch for D1:
  // - Credit watcher (or watcher gets full reward while MLM is distributed from ad revenue pool)
  const statements: ReturnType<typeof env.DB.prepare>[] = [
    // Credit watcher
    env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
    ).bind(grossReward, now, userId),
  ];

  // Credit each upline with their MLM share
  for (const p of mlm.payouts) {
    statements.push(
      env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
      ).bind(Number(p.amountMicroUsd), now, p.userId)
    );
  }

  await env.DB.batch(statements);

  // 4. Log transactions to financial audit trail
  const txBase = `tx_ad_${provider}_${Date.now()}`;
  await logFinancialTransaction(env, {
    transaction_id: `${txBase}_watcher`,
    user_id: userId,
    action_type: 'AD_WATCH',
    amount_micro_usd: BigInt(grossReward),
    balance_after_micro_usd: 0n, // Updated asynchronously
  });

  for (const p of mlm.payouts) {
    await logFinancialTransaction(env, {
      transaction_id: `${txBase}_mlm_L${p.depth}`,
      user_id: p.userId,
      action_type: 'MLM_COMMISSION',
      amount_micro_usd: p.amountMicroUsd,
      balance_after_micro_usd: 0n,
      related_user_id: userId,
      mlm_level: p.depth,
    });
  }

  return {
    success: true,
    grossRewardMicroUsd: grossReward,
    formattedReward: formatMicroUsd(grossReward),
    mlmDistribution: {
      platformFee: formatMicroUsd(mlm.platformFeeMicroUsd),
      payoutsCount: mlm.payouts.length,
      platformReserve: formatMicroUsd(mlm.platformReserveMicroUsd),
    },
  };
}

// 1. AdswedMedia S2S Postback
adsRouter.all('/postback/adswedmedia', async (c) => {
  const query = c.req.query();
  const userId = query.user_id || query.subid;
  const country = query.country || 'OTHER';

  if (!userId) {
    return c.json({ error: 'Missing user_id in postback' }, 400);
  }

  const result = await processAdReward(c.env, userId, 'adswedmedia', country);
  return c.json(result);
});

// 2. OnClickA S2S Postback
adsRouter.all('/postback/onclicka', async (c) => {
  const query = c.req.query();
  const userId = query.user_id || query.click_id;
  const country = query.country || 'OTHER';

  if (!userId) {
    return c.json({ error: 'Missing user_id in postback' }, 400);
  }

  const result = await processAdReward(c.env, userId, 'onclicka', country);
  return c.json(result);
});

// 3. Dev Mock Simulation Endpoint (for Dev Panel UI)
adsRouter.post('/dev/simulate-watch', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId;
  const country = (body.country || 'US').toUpperCase();
  const provider = body.provider || 'adswedmedia';

  if (!userId) {
    return c.json({ error: 'Missing userId in simulation body' }, 400);
  }

  const result = await processAdReward(c.env, userId, provider, country);
  return c.json({
    simulation: true,
    countryTier: country,
    provider,
    ...result,
  });
});
