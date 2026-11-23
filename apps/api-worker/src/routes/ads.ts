import { Hono } from 'hono';
import { formatMicroUsd, getStatisticalAdMicroUsd } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { applyRewardSplit } from '../utils/reward-split';
import { trackQuestAction, getUtcDateKey } from './quests';
import { isLocalDev, safeEqual } from '../utils/guards';

export const adsRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

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
  // Use explicit reward if provided by ad network, otherwise fall back to statistical country/format lookup (default 30s rewarded video)
  const grossReward = customAmountMicroUsd || getStatisticalAdMicroUsd(country, 'video_30s');
  const now = Math.floor(Date.now() / 1000);

  // 0. Replay protection: each provider transaction id credits exactly once; unknown users are ignored
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first<{ id: string }>();
  if (!user) return { success: false, error: 'Unknown user' };
  const ins = await env.DB
    .prepare('INSERT OR IGNORE INTO ad_postbacks (provider, provider_tx_id, user_id, amount_micro_usd, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(provider, providerTxId, userId, grossReward, now)
    .run();
  if ((ins.meta?.changes ?? 0) === 0) return { success: true, duplicate: true };

  // 1–4. 100 % revenue split of V: 75 % watcher · 15 % uplines (5/4/3/2/1) · 5 % watcher's head
  //      bounty · 5 % platform (missing upline levels roll over to the platform)
  const split = await applyRewardSplit(env, {
    earnerId: userId,
    grossMicroUsd: grossReward,
    actionType: 'AD_WATCH',
    sourceId: `${provider}:${providerTxId}`,
    dateKey,
  });

  // 5. Track daily quests for watcher
  await trackQuestAction(env.DB, userId, 'watch_rewarded_ad', 1, dateKey);
  return {
    success: true,
    grossRewardMicroUsd: grossReward,
    formattedReward: formatMicroUsd(grossReward),
    split: {
      watcher: formatMicroUsd(split.earnerMicroUsd),
      uplines: split.uplinePayouts.length,
      headBounty: formatMicroUsd(split.bountyMicroUsd),
      platform: formatMicroUsd(split.platformTotalMicroUsd),
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
