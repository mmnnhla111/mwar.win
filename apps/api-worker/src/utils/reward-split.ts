import { calculateRewardSplit, type FinancialLog } from '@mwar/shared';
import type { Env } from '../types';
import { getUplines } from './mlm-tree';
import { logFinancialTransaction, walletBalance } from './audit-logger';
import { PLATFORM_ACCOUNT_ID, ENERGY_POOL_ACCOUNT_ID } from './guards';
import { recordPendingMlmCommission, trackQuestAction, getUtcDateKey } from '../routes/quests';

const rid = () => Math.random().toString(36).substring(2, 7);

/**
 * Applies the 100 % Revenue / Reward Split to a verified reward value V (each share = floor(V × rate)):
 *   55 %  → earner's wallet (immediately)
 *   15 %  → uplines L1 5 % · L2 4 % · L3 3 % · L4 2 % · L5 1 % (daily proof-of-activity ledger,
 *           paid at midnight if the sponsor completed 4 quests, otherwise forfeited to the platform)
 *    5 %  → earner's own head bounty (wallets.bounty_micro_usd) — claimed by whoever eliminates them
 *    5 %  → platform / system (+ every missing upline level and rounding remainder)
 *   20 %  → Energy Recharge Reserve Pool (system_balances.energy_pool_micro_usd), backs ad / cheer EC
 */
export async function applyRewardSplit(
  env: Env,
  opts: {
    earnerId: string;
    grossMicroUsd: number;
    actionType: 'GAME_KILL' | 'CHEST_OPEN' | 'AD_WATCH';
    sourceId?: string | null;
    dateKey?: string;
  }
) {
  const dateKey = opts.dateKey ?? getUtcDateKey();
  const now = Math.floor(Date.now() / 1000);
  const uplines = await getUplines(env.DB, opts.earnerId);
  const split = calculateRewardSplit(opts.grossMicroUsd, uplines);
  const earner = Number(split.earnerMicroUsd);
  const bounty = Number(split.bountyMicroUsd);

  // 1. Earner 55 % + head bounty 5 % + Energy Pool 20 % + platform total (one atomic D1 batch)
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, bounty_micro_usd = bounty_micro_usd + ?2, updated_at = ?3 WHERE user_id = ?4'
    ).bind(earner, bounty, now, opts.earnerId),
    env.DB.prepare(
      `INSERT INTO system_balances (id, energy_pool_micro_usd, platform_micro_usd, updated_at) VALUES ('global', ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET energy_pool_micro_usd = energy_pool_micro_usd + ?1, platform_micro_usd = platform_micro_usd + ?2, updated_at = ?3`
    ).bind(Number(split.energyPoolMicroUsd), Number(split.platformTotalMicroUsd), now),
  ]);

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
      amount_micro_usd: split.platformTotalMicroUsd,
      balance_after_micro_usd: 0n,
      source_game_id: src,
      related_user_id: opts.earnerId,
    },
    {
      transaction_id: `${base}_energy`,
      user_id: ENERGY_POOL_ACCOUNT_ID,
      action_type: 'ENERGY_POOL_CREDIT',
      amount_micro_usd: split.energyPoolMicroUsd,
      balance_after_micro_usd: 0n,
      source_game_id: src,
      related_user_id: opts.earnerId,
    },
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
  return split;
}

/**
 * Transfers a victim's whole accumulated head bounty to the claimer (their killer, or whoever opened
 * the victim's suicide / environmental-death bounty chest). Compare-and-swap on the bounty so a
 * bounty can only ever be claimed once. Returns the amount credited.
 */
export async function claimHeadBounty(env: Env, claimerId: string, victimId: string, sourceId?: string | null): Promise<number> {
  if (!victimId || claimerId === victimId) return 0;
  const row = await env.DB.prepare('SELECT bounty_micro_usd FROM wallets WHERE user_id = ?1').bind(victimId).first<{ bounty_micro_usd: number }>();
  const amount = row?.bounty_micro_usd ?? 0;
  if (amount <= 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const cas = await env.DB.prepare('UPDATE wallets SET bounty_micro_usd = 0, updated_at = ?3 WHERE user_id = ?1 AND bounty_micro_usd = ?2').bind(victimId, amount, now).run();
  if ((cas.meta?.changes ?? 0) !== 1) return 0; // claimed concurrently
  await env.DB.prepare(
    'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
  )
    .bind(amount, now, claimerId)
    .run();
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
