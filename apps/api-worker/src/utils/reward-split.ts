import { calculateRewardSplit, type AdGrossSplit, type FinancialLog } from '@mwar/shared';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env } from '../types';
import { getUplines } from './mlm-tree';
import { logFinancialTransaction, walletBalance } from './audit-logger';
import { PLATFORM_ACCOUNT_ID, ENERGY_POOL_ACCOUNT_ID, BOSS_POOL_ACCOUNT_ID } from './guards';
import { redirectPlatformFeeToBoss } from './platform-settings';
import { logAdHaircut } from './energy-tickets';
import { ledgerAfterUpdate } from './ledger';
import { recordPendingMlmCommission, trackQuestAction, getUtcDateKey } from '../routes/quests';

const rid = () => Math.random().toString(36).substring(2, 7);

/**
 * Applies the 100 % Revenue / Reward Split to a verified reward value V (each share = floor(V × rate)):
 *   55 %  → earner's wallet (immediately)
 *   15 %  → uplines L1 5 % · L2 4 % · L3 3 % · L4 2 % · L5 1 % (daily proof-of-activity ledger,
 *           paid at midnight if the sponsor completed 4 quests, otherwise forfeited to the platform)
 *    5 %  → earner's own head bounty (wallets.bounty_micro_usd) — claimed by whoever eliminates them
 *    5 %  → platform / system (+ every missing upline level and rounding remainder)
 *           V1.2: while platform_settings.redirect_platform_fee_to_boss is on (launch default) the 5 % fee
 *           (floor(V × 5 %)) goes to system_balances.boss_bounty_pool_micro_usd instead; the rollover stays platform
 *   20 %  → Energy Recharge Reserve Pool (system_balances.energy_pool_micro_usd), backs ad / cheer EC
 */
export async function applyRewardSplit(
  env: Env,
  opts: {
    earnerId: string;
    grossMicroUsd: number;
    actionType: 'GAME_KILL' | 'CHEST_OPEN' | 'AD_WATCH' | 'CHEER_REWARD' | 'BOSS_BOUNTY_CLAIM';
    sourceId?: string | null;
    dateKey?: string;
    /**
     * V1.1: statements that must commit atomically with the money (e.g. the ticket settlement guard,
     * which aborts the whole batch when the ticket was already settled). Run FIRST in the same batch.
     */
    guard?: D1PreparedStatement[];
    /** Extra µUSD for the platform in the same batch (part of a ticket the game server did not claim). */
    extraPlatformMicroUsd?: number;
    /**
     * Cheer: the 20 % Energy Pool slice is credited to the pool AND drawn at once as the viewer's EC
     * backing (pool − drawn unchanged), so the cheer allocates exactly 100 % of V.
     */
    energyPoolPassThrough?: boolean;
    /**
     * V1.2 verified ad revenue: the 3 % safety + 5 % boss-pool part of the gross whose net value is this V,
     * credited in the SAME batch (so the whole gross enters the system exactly once).
     */
    adHaircut?: Pick<AdGrossSplit, 'safetyReserveMicroUsd' | 'bossPoolMicroUsd'>;
  }
) {
  const dateKey = opts.dateKey ?? getUtcDateKey();
  const now = Math.floor(Date.now() / 1000);
  const uplines = await getUplines(env.DB, opts.earnerId);
  const split = calculateRewardSplit(opts.grossMicroUsd, uplines);
  const earner = Number(split.earnerMicroUsd);
  const bounty = Number(split.bountyMicroUsd);

  // 1. Earner 55 % + head bounty 5 % + Energy Pool 20 % + platform total (one atomic D1 batch)
  const pool = Number(split.energyPoolMicroUsd);
  // V1.2: the 5 % fee → Boss Bounty Pool while the admin switch is on (launch default)
  const toBoss = (await redirectPlatformFeeToBoss(env)) ? Number(split.platformFeeMicroUsd) : 0;
  const platform = Number(split.platformTotalMicroUsd) - toBoss + Math.max(0, Math.floor(opts.extraPlatformMicroUsd ?? 0));
  const hc = opts.adHaircut;
  const safetyIn = Math.max(0, Math.floor(hc?.safetyReserveMicroUsd ?? 0));
  const bossIn = toBoss + Math.max(0, Math.floor(hc?.bossPoolMicroUsd ?? 0));
  await env.DB.batch([
    ...(opts.guard ?? []),
    env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, bounty_micro_usd = bounty_micro_usd + ?2, updated_at = ?3 WHERE user_id = ?4'
    ).bind(earner, bounty, now, opts.earnerId),
    ledgerAfterUpdate(env.DB, opts.earnerId, earner, opts.actionType, opts.sourceId ?? null, now),
    env.DB.prepare(
      `INSERT INTO system_balances (id, energy_pool_micro_usd, energy_pool_drawn_micro_usd, platform_micro_usd, boss_bounty_pool_micro_usd, safety_reserve_micro_usd, updated_at)
       VALUES ('global', ?1, ?4, ?2, ?5, ?6, ?3)
       ON CONFLICT(id) DO UPDATE SET energy_pool_micro_usd = energy_pool_micro_usd + ?1, energy_pool_drawn_micro_usd = energy_pool_drawn_micro_usd + ?4,
                                     platform_micro_usd = platform_micro_usd + ?2, boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd + ?5,
                                     safety_reserve_micro_usd = safety_reserve_micro_usd + ?6, updated_at = ?3`
    ).bind(pool, platform, now, opts.energyPoolPassThrough ? pool : 0, bossIn, safetyIn),
  ]);
  if (hc) await logAdHaircut(env, hc, opts.sourceId ?? opts.actionType, opts.earnerId);

  // 2. Upline 15 % into the daily grey/green ledger
  for (const p of split.uplinePayouts) {
    await recordPendingMlmCommission(env.DB, p.userId, opts.earnerId, p.depth, Number(p.amountMicroUsd), opts.actionType, dateKey);
  }

  // 3. Quests: coins earned count the credited (55 %) amount
  const coins = Math.floor(earner / 100);
  if (coins > 0) await trackQuestAction(env.DB, opts.earnerId, 'earn_coins', coins, dateKey).catch(() => {});

  // 4. Immutable audit trail (only the earner row changes a wallet balance)
  const base = `tx_${opts.actionType.toLowerCase()}_${opts.earnerId.slice(0, 6)}_${now}_${rid()}`;
  const src = opts.sourceId ? opts.sourceId.slice(0, 64) : null;
  const logs: FinancialLog[] = [
    {
      transaction_id: `${base}_earn`,
      user_id: opts.earnerId,
      action_type: opts.actionType,
      amount_micro_usd: split.earnerMicroUsd,
      balance_after_micro_usd: await walletBalance(env.DB, opts.earnerId),
      source_game_id: src,
    },
    {
      transaction_id: `${base}_bounty`,
      user_id: opts.earnerId,
      action_type: 'BOUNTY_ACCRUE',
      amount_micro_usd: split.bountyMicroUsd,
      balance_after_micro_usd: 0n,
      source_game_id: src,
    },
    {
      transaction_id: `${base}_platform`,
      user_id: PLATFORM_ACCOUNT_ID,
      action_type: 'PLATFORM_FEE',
      amount_micro_usd: BigInt(platform),
      balance_after_micro_usd: 0n,
      source_game_id: src,
      related_user_id: opts.earnerId,
    },
    ...(toBoss > 0
      ? [
          {
            transaction_id: `${base}_boss_fee`,
            user_id: BOSS_POOL_ACCOUNT_ID,
            action_type: 'BOSS_POOL_CREDIT' as const,
            amount_micro_usd: BigInt(toBoss),
            balance_after_micro_usd: 0n,
            source_game_id: src,
            related_user_id: opts.earnerId,
          },
        ]
      : []),
    {
      transaction_id: `${base}_energy`,
      user_id: ENERGY_POOL_ACCOUNT_ID,
      action_type: 'ENERGY_POOL_CREDIT',
      amount_micro_usd: split.energyPoolMicroUsd,
      balance_after_micro_usd: 0n,
      source_game_id: src,
      related_user_id: opts.earnerId,
    },
    ...(opts.energyPoolPassThrough && pool > 0
      ? [
          {
            transaction_id: `${base}_energy_draw`,
            user_id: ENERGY_POOL_ACCOUNT_ID,
            action_type: 'ENERGY_POOL_DRAW' as const,
            amount_micro_usd: split.energyPoolMicroUsd,
            balance_after_micro_usd: 0n,
            source_game_id: src,
            related_user_id: opts.earnerId,
          },
        ]
      : []),
    ...split.uplinePayouts.map((p) => ({
      transaction_id: `${base}_L${p.depth}`,
      user_id: p.userId,
      action_type: 'MLM_COMMISSION_PENDING' as const,
      amount_micro_usd: p.amountMicroUsd,
      balance_after_micro_usd: 0n,
      source_game_id: src,
      related_user_id: opts.earnerId,
      mlm_level: p.depth,
    })),
  ];
  for (const l of logs) await logFinancialTransaction(env, l);
  return { ...split, bossFeeMicroUsd: BigInt(toBoss) };
}

/**
 * Transfers a victim's whole accumulated head bounty to the claimer (their killer, or whoever opened
 * the victim's suicide / environmental-death bounty chest). One atomic D1 batch: compare-and-swap the
 * bounty to 0, credit the claimer only if that CAS changed the row, ledger row only if the credit
 * did — so a bounty can only ever be claimed once and is never lost half-way. Returns the amount credited.
 */
export async function claimHeadBounty(env: Env, claimerId: string, victimId: string, sourceId?: string | null): Promise<number> {
  if (!victimId || claimerId === victimId) return 0;
  const row = await env.DB.prepare('SELECT bounty_micro_usd FROM wallets WHERE user_id = ?1').bind(victimId).first<{ bounty_micro_usd: number }>();
  const amount = row?.bounty_micro_usd ?? 0;
  if (amount <= 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.batch([
    env.DB.prepare('UPDATE wallets SET bounty_micro_usd = 0, updated_at = ?3 WHERE user_id = ?1 AND bounty_micro_usd = ?2').bind(victimId, amount, now),
    env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1'
    ).bind(amount, now, claimerId),
    ledgerAfterUpdate(env.DB, claimerId, amount, 'BOUNTY_CLAIM', `${victimId}:${sourceId ?? ''}`, now),
  ]);
  if ((res[0].meta?.changes ?? 0) !== 1) return 0; // claimed concurrently
  if ((res[1].meta?.changes ?? 0) !== 1) return 0; // claimer has no wallet row: the bounty is retired
  const base = `tx_bounty_${victimId.slice(0, 6)}_${claimerId.slice(0, 6)}_${now}_${rid()}`;
  const src = sourceId ? sourceId.slice(0, 64) : null;
  await logFinancialTransaction(env, {
    transaction_id: `${base}_out`,
    user_id: victimId,
    action_type: 'BOUNTY_PAYOUT',
    amount_micro_usd: BigInt(amount),
    balance_after_micro_usd: await walletBalance(env.DB, victimId),
    source_game_id: src,
    related_user_id: claimerId,
  });
  await logFinancialTransaction(env, {
    transaction_id: `${base}_in`,
    user_id: claimerId,
    action_type: 'BOUNTY_CLAIM',
    amount_micro_usd: BigInt(amount),
    balance_after_micro_usd: await walletBalance(env.DB, claimerId),
    source_game_id: src,
    related_user_id: victimId,
  });
  return amount;
}
