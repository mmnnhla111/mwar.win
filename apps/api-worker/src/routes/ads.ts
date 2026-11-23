import { Hono } from 'hono';
import {
  calculateMlmDistribution,
  formatMicroUsd,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { getUplines } from '../utils/mlm-tree';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { recordPendingMlmCommission, trackQuestAction, getUtcDateKey } from './quests';
import { isLocalDev, safeEqual } from '../utils/guards';

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
  providerTxId: string,
  customAmountMicroUsd?: number,
  dateKey = getUtcDateKey()
) {
  const grossReward = customAmountMicroUsd || TIER_REWARDS_MICRO_USD[country.toUpperCase()] || TIER_REWARDS_MICRO_USD.OTHER;
  const now = Math.floor(Date.now() / 1000);

  // 0. Replay protection: each provider transaction id credits exactly once; unknown users are ignored
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first<{ id: string }>();
  if (!user) return { success: false, error: 'Unknown user' };
  const ins = await env.DB
    .prepare('INSERT OR IGNORE INTO ad_postbacks (provider, provider_tx_id, user_id, amount_micro_usd, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(provider, providerTxId, userId, grossReward, now)
    .run();
  if ((ins.meta?.changes ?? 0) === 0) return { success: true, duplicate: true };

  // 1. Fetch user's 5-level uplines
  const uplines = await getUplines(env.DB, userId);

  // 2. Calculate 5-level MLM distribution
  const mlm = calculateMlmDistribution(grossReward, uplines);

  // 3. Credit watcher immediately
  await env.DB.prepare(
    'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
  ).bind(grossReward, now, userId).run();

  // 4. Record downline commission for each upline in daily_mlm_pending_ledger (Held as pending_grey until proof-of-activity unlock)
  for (const p of mlm.payouts) {
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
  const txBase = `tx_ad_${provider}_${Date.now()}`;
  await logFinancialTransaction(env, {
    transaction_id: `${txBase}_watcher`,
    user_id: userId,
    action_type: 'AD_WATCH',
    amount_micro_usd: BigInt(grossReward),
    balance_after_micro_usd: await walletBalance(env.DB, userId),
    source_game_id: `${provider}:${providerTxId}`.slice(0, 64),
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

/** S2S postbacks must carry the shared secret configured in the ad network dashboard. */
function postbackAuthorized(env: Env, query: Record<string, string>, localDev: boolean): boolean {
  const secret = env.AD_POSTBACK_SECRET || env.ADS_POSTBACK_SECRET;
  if (secret) return safeEqual(query.secret, secret) || safeEqual(query.token, secret);
  return localDev;
}

// 1. AdswedMedia S2S Postback
adsRouter.all('/postback/adswedmedia', async (c) => {
  const query = c.req.query();
  if (!postbackAuthorized(c.env, query, isLocalDev(c))) return c.json({ error: 'Invalid postback secret' }, 403);
  const userId = query.user_id || query.subid;
  const country = query.country || 'OTHER';
  const txId = query.transaction_id || query.tx_id || query.click_id;

  if (!userId || !txId) {
    return c.json({ error: 'Missing user_id or transaction_id in postback' }, 400);
  }

  const result = await processAdReward(c.env, userId, 'adswedmedia', country, txId);
  return c.json(result);
});

// 2. OnClickA S2S Postback
adsRouter.all('/postback/onclicka', async (c) => {
  const query = c.req.query();
  if (!postbackAuthorized(c.env, query, isLocalDev(c))) return c.json({ error: 'Invalid postback secret' }, 403);
  const userId = query.user_id || query.click_id;
  const country = query.country || 'OTHER';
  const txId = query.transaction_id || query.tx_id || query.click_id;

  if (!userId || !txId) {
    return c.json({ error: 'Missing user_id or transaction_id in postback' }, 400);
  }

  const result = await processAdReward(c.env, userId, 'onclicka', country, txId);
  return c.json(result);
});

// 3. Dev Mock Simulation Endpoint (for Dev Panel UI) — local `wrangler dev` only (mints money)
adsRouter.post('/dev/simulate-watch', async (c) => {
  if (!isLocalDev(c)) return c.json({ error: 'Available only on local dev' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId;
  const country = (body.country || 'US').toUpperCase();
  const provider = body.provider || 'adswedmedia';

  if (!userId) {
    return c.json({ error: 'Missing userId in simulation body' }, 400);
  }

  const result = await processAdReward(c.env, userId, provider, country, `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  return c.json({
    simulation: true,
    countryTier: country,
    provider,
    ...result,
  });
});
