import { Hono } from 'hono';
import {
  calculateMlmDistribution,
  formatMicroUsd,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { getUplines } from '../utils/mlm-tree';
import { logFinancialTransaction } from '../utils/audit-logger';
import { recordPendingMlmCommission, trackQuestAction, getUtcDateKey } from './quests';
import { isLocalDev, safeEqual, walletBalance, PLATFORM_ACCOUNT_ID } from '../utils/guards';
import type { Context } from 'hono';

/** S2S postbacks must carry ?secret=ADS_POSTBACK_SECRET (anyone could otherwise mint ad rewards). */
function postbackAuthorized(c: Context<any>): boolean {
  if (isLocalDev(c)) return true;
  const secret = c.req.query('secret') || c.req.query('token') || c.req.header('X-Postback-Secret');
  return safeEqual(secret, c.env.ADS_POSTBACK_SECRET);
}

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
  customAmountMicroUsd?: number,
  dateKey = getUtcDateKey()
) {
  const grossReward = customAmountMicroUsd || TIER_REWARDS_MICRO_USD[country.toUpperCase()] || TIER_REWARDS_MICRO_USD.OTHER;
  const now = Math.floor(Date.now() / 1000);

  // 1. Fetch user's 5-level uplines
  const uplines = await getUplines(env.DB, userId);

  // 2. Calculate 5-level MLM distribution
  const mlm = calculateMlmDistribution(grossReward, uplines);

  // 3. Credit watcher immediately
  await env.DB.prepare(
    'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
  ).bind(grossReward, now, userId).run();

  // 4. Record downline commission for each upline in daily_mlm_pending_ledger (Held as pending_grey until proof-of-activity unlock)
  const txBase = `tx_ad_${provider}_${Date.now()}`;
  for (const p of mlm.payouts) {
    await logFinancialTransaction(env, {
      transaction_id: `${txBase}_L${p.depth}`,
      user_id: p.userId,
      action_type: 'MLM_PENDING',
      amount_micro_usd: p.amountMicroUsd,
      balance_after_micro_usd: 0n,
      related_user_id: userId,
      mlm_level: p.depth,
    });
    await recordPendingMlmCommission(
      env.DB,
      p.userId,
      userId,
      p.depth,
      Number(p.amountMicroUsd),
      'AD_WATCH',
      dateKey
    );
  }

  // 5. Track daily quests for watcher
  await trackQuestAction(env.DB, userId, 'watch_rewarded_ad', 1, dateKey);
  const earnedCoins = Math.floor(grossReward / 100);
  if (earnedCoins > 0) {
    await trackQuestAction(env.DB, userId, 'earn_coins', earnedCoins, dateKey);
  }

  // 6. Log transactions to financial audit trail
  await logFinancialTransaction(env, {
    transaction_id: `${txBase}_watcher`,
    user_id: userId,
    action_type: 'AD_WATCH',
    amount_micro_usd: BigInt(grossReward),
    balance_after_micro_usd: await walletBalance(env.DB, userId),
  });
  await logFinancialTransaction(env, {
    transaction_id: `${txBase}_platform`,
    user_id: PLATFORM_ACCOUNT_ID,
    action_type: 'PLATFORM_FEE',
    amount_micro_usd: mlm.platformFeeMicroUsd + mlm.platformReserveMicroUsd,
    balance_after_micro_usd: 0n,
    related_user_id: userId,
  });

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
  if (!postbackAuthorized(c)) return c.json({ error: 'Invalid postback secret' }, 401);
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
  if (!postbackAuthorized(c)) return c.json({ error: 'Invalid postback secret' }, 401);
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
  if (!isLocalDev(c)) {
    return c.json({ error: 'Ad simulation is only available on a local wrangler dev host' }, 403);
  }
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
