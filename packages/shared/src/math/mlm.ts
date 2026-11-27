import {
  REWARD_SPLIT_TOTAL_BPS,
  REWARD_EARNER_BPS,
  REWARD_UPLINE_BPS,
  REWARD_BOUNTY_BPS,
  REWARD_PLATFORM_BPS,
  REWARD_ENERGY_POOL_BPS,
  PLATFORM_FEE_PERCENT,
  NET_POOL_PERCENT,
  MLM_LEVEL_RATES,
} from '../constants';
import { toMicroUsdBigInt } from './currency';
import { roundCoinShare } from './coin';

export interface MlmUpline {
  userId: string;
  depth: 1 | 2 | 3 | 4 | 5;
}

export interface MlmDistributionResult {
  grossAmountMicroUsd: bigint;
  platformFeeMicroUsd: bigint;
  netPoolMicroUsd: bigint;
  payouts: Array<{
    depth: 1 | 2 | 3 | 4 | 5;
    userId: string;
    percentageOfNet: bigint;
    amountMicroUsd: bigint;
  }>;
  unclaimedLevels: Array<{
    depth: 1 | 2 | 3 | 4 | 5;
    amountMicroUsd: bigint;
  }>;
  platformReserveMicroUsd: bigint; // Total sum of unclaimed levels + integer rounding remainders
  totalDistributedMicroUsd: bigint; // Must strictly equal grossAmountMicroUsd
}

/**
 * @deprecated Superseded by {@link calculateRewardSplit} (55/15/5/5/20). Kept for old tooling only.
 * Calculates 5-Level MLM Payout Distribution in Micro-USD.
 * Guarantees zero floating-point error and exact integer conservation:
 * platformFee + sum(payouts) + platformReserve == grossAmountMicroUsd
 *
 * @param grossAmount Total transaction value in Micro-USD
 * @param uplines Array of ancestors with depth (1 to 5)
 */
export function calculateMlmDistribution(
  grossAmount: bigint | number | string,
  uplines: MlmUpline[] = []
): MlmDistributionResult {
  const gross = toMicroUsdBigInt(grossAmount);
  if (gross <= 0n) {
    return {
      grossAmountMicroUsd: 0n,
      platformFeeMicroUsd: 0n,
      netPoolMicroUsd: 0n,
      payouts: [],
      unclaimedLevels: [],
      platformReserveMicroUsd: 0n,
      totalDistributedMicroUsd: 0n,
    };
  }

  // 1. Platform Fee (5%) & Net Pool (95%)
  const platformFee = (gross * PLATFORM_FEE_PERCENT) / 100n;
  const netPool = gross - platformFee;

  // Map uplines by depth for O(1) lookup
  const uplineByDepth = new Map<number, string>();
  for (const up of uplines) {
    if (up.depth >= 1 && up.depth <= 5) {
      uplineByDepth.set(up.depth, up.userId);
    }
  }

  const payouts: MlmDistributionResult['payouts'] = [];
  const unclaimedLevels: MlmDistributionResult['unclaimedLevels'] = [];
  let allocatedNetMicroUsd = 0n;

  // Levels 1 to 5
  for (let depth = 1; depth <= 5; depth++) {
    const d = depth as 1 | 2 | 3 | 4 | 5;
    const rate = MLM_LEVEL_RATES[d];
    const levelAmount = (netPool * rate) / 100n;
    allocatedNetMicroUsd += levelAmount;

    const targetUserId = uplineByDepth.get(depth);
    if (targetUserId) {
      payouts.push({
        depth: d,
        userId: targetUserId,
        percentageOfNet: rate,
        amountMicroUsd: levelAmount,
      });
    } else {
      unclaimedLevels.push({
        depth: d,
        amountMicroUsd: levelAmount,
      });
    }
  }

  // Any leftover from integer division in netPool (e.g. 1-4 micro-usd remainder)
  const netPoolRemainder = netPool - allocatedNetMicroUsd;

  // Unclaimed levels go to Platform Reserve, along with the net pool remainder
  const unclaimedSum = unclaimedLevels.reduce((acc, curr) => acc + curr.amountMicroUsd, 0n);
  const platformReserve = unclaimedSum + netPoolRemainder;

  const totalDistributed = platformFee + payouts.reduce((acc, p) => acc + p.amountMicroUsd, 0n) + platformReserve;

  // Invariant verification check:
  if (totalDistributed !== gross) {
    throw new Error(`Mathematical integrity invariant failed: distributed ${totalDistributed} != gross ${gross}`);
  }

  return {
    grossAmountMicroUsd: gross,
    platformFeeMicroUsd: platformFee,
    netPoolMicroUsd: netPool,
    payouts,
    unclaimedLevels,
    platformReserveMicroUsd: platformReserve,
    totalDistributedMicroUsd: totalDistributed,
  };
}

export interface RewardSplitResult {
  grossMicroUsd: bigint;
  /** 55 % — credited to the shooter / earner's wallet. */
  earnerMicroUsd: bigint;
  /** 5 % — added to the earner's own accumulated head bounty. */
  bountyMicroUsd: bigint;
  /** 5 % platform / system fee. */
  platformFeeMicroUsd: bigint;
  /** 20 % — Energy Recharge Reserve Pool (backs EC recharges from ads and cheers). */
  energyPoolMicroUsd: bigint;
  /** 1–5 % per existing upline level (15 % in total when all 5 levels exist). */
  uplinePayouts: Array<{ depth: 1 | 2 | 3 | 4 | 5; userId: string; bps: bigint; amountMicroUsd: bigint }>;
  /** Upline levels with nobody in them (their share rolls over to the platform). */
  unclaimedLevels: Array<{ depth: 1 | 2 | 3 | 4 | 5; amountMicroUsd: bigint }>;
  /** Unclaimed upline shares + rounding remainder (to the platform). */
  platformRolloverMicroUsd: bigint;
  /** platformFee + platformRollover — everything the platform/system ledger receives. */
  platformTotalMicroUsd: bigint;
  /** Must equal grossMicroUsd exactly. */
  totalMicroUsd: bigint;
}

/**
 * 100 % Revenue / Reward Split of a verified reward value V (a victim's Energy Ticket value, a cheer ad):
 *   earner 55 % · uplines L1 5 % / L2 4 % / L3 3 % / L4 2 % / L5 1 % · head bounty 5 % · platform 5 %
 *   · Energy Recharge Reserve Pool 20 %.
 * V1.1 rounding: every non-platform share is `roundCoinShare(V, rate)` (fraction >= 0.7 µUSD = 0.007 C
 * rounds up, otherwise down). The platform receives everything else (its 5 % + missing upline levels +
 * rounding), and is never below floor(V × 5 %): if rounded-up shares would push it under that floor,
 * 1 µUSD is trimmed from the largest non-platform share until it is not. So
 *   earner + uplines + bounty + energyPool + platformTotal === V   (exactly; throws otherwise)
 * and nobody is ever paid even 1 µUSD more than V in total.
 */
export function calculateRewardSplit(grossAmount: bigint | number | string, uplines: MlmUpline[] = []): RewardSplitResult {
  const gross = toMicroUsdBigInt(grossAmount);
  const zero: RewardSplitResult = {
    grossMicroUsd: 0n,
    earnerMicroUsd: 0n,
    bountyMicroUsd: 0n,
    platformFeeMicroUsd: 0n,
    energyPoolMicroUsd: 0n,
    uplinePayouts: [],
    unclaimedLevels: [],
    platformRolloverMicroUsd: 0n,
    platformTotalMicroUsd: 0n,
    totalMicroUsd: 0n,
  };
  if (gross <= 0n) return zero;

  const share = (bps: bigint) => roundCoinShare(gross, bps);
  const platformFloor = (gross * REWARD_PLATFORM_BPS) / REWARD_SPLIT_TOTAL_BPS;

  const byDepth = new Map<number, string>();
  for (const u of uplines) if (u.depth >= 1 && u.depth <= 5) byDepth.set(u.depth, u.userId);

  // Allocated (non-platform) shares, in trim-priority order for ties: earner, energy pool, bounty, L1..L5
  const slots: Array<{ key: string; amount: bigint }> = [
    { key: 'earner', amount: share(REWARD_EARNER_BPS) },
    { key: 'energy', amount: share(REWARD_ENERGY_POOL_BPS) },
    { key: 'bounty', amount: share(REWARD_BOUNTY_BPS) },
  ];
  const unclaimedLevels: RewardSplitResult['unclaimedLevels'] = [];
  for (let depth = 1; depth <= 5; depth++) {
    const d = depth as 1 | 2 | 3 | 4 | 5;
    const amount = share(REWARD_UPLINE_BPS[d]);
    if (byDepth.has(depth)) slots.push({ key: `L${depth}`, amount });
    else unclaimedLevels.push({ depth: d, amountMicroUsd: amount });
  }
  const allocated = () => slots.reduce((a, s) => a + s.amount, 0n);
  // Never let the rounding push the platform under its 5 % floor (or the total over V)
  let guard = 0;
  while (gross - allocated() < platformFloor) {
    let big = slots[0];
    for (const s of slots) if (s.amount > big.amount) big = s;
    if (big.amount <= 0n || ++guard > 64) break;
    big.amount -= 1n;
  }
  const get = (k: string) => slots.find((s) => s.key === k)?.amount ?? 0n;
  const earner = get('earner');
  const bounty = get('bounty');
  const energyPool = get('energy');
  const uplinePayouts: RewardSplitResult['uplinePayouts'] = [];
  let uplineAllocated = 0n;
  for (let depth = 1; depth <= 5; depth++) {
    const userId = byDepth.get(depth);
    if (!userId) continue;
    const d = depth as 1 | 2 | 3 | 4 | 5;
    const amount = get(`L${depth}`);
    uplinePayouts.push({ depth: d, userId, bps: REWARD_UPLINE_BPS[d], amountMicroUsd: amount });
    uplineAllocated += amount;
  }

  const platformTotal = gross - earner - bounty - energyPool - uplineAllocated;
  const platformFee = platformFloor;
  const rollover = platformTotal - platformFee;
  const total = earner + bounty + energyPool + uplineAllocated + platformTotal;
  if (total !== gross || rollover < 0n || platformTotal < platformFloor) {
    throw new Error(`Reward split invariant failed: distributed ${total} != gross ${gross}`);
  }
  return {
    grossMicroUsd: gross,
    earnerMicroUsd: earner,
    bountyMicroUsd: bounty,
    platformFeeMicroUsd: platformFee,
    energyPoolMicroUsd: energyPool,
    uplinePayouts,
    unclaimedLevels,
    platformRolloverMicroUsd: rollover,
    platformTotalMicroUsd: platformTotal,
    totalMicroUsd: total,
  };
}

/** Earner (55 %) and head-bounty (5 %) shares as plain numbers (used by the game server HUD). */
export function earnerAndBountyShares(grossMicroUsd: number): { earner: number; bounty: number } {
  const r = calculateRewardSplit(Math.max(0, Math.floor(grossMicroUsd)));
  return { earner: Number(r.earnerMicroUsd), bounty: Number(r.bountyMicroUsd) };
}

/**
 * "ให้กำลังใจ" Cheer split (V1.1) of the safe ad value V a viewer generated for a creator:
 * the creator is the earner (55 % wallet · 5 % head bounty), the creator's uplines get 15 %, the
 * platform 5 % (+ missing tiers / rounding) and the 20 % Energy Pool slice is credited to the pool AND
 * immediately drawn as the viewer's EC backing (pending_ec_micro_usd). Total allocated === V (never 120 %).
 */
export function calculateCheerSplit(valueMicroUsd: bigint | number | string, creatorUplines: MlmUpline[] = []) {
  const split = calculateRewardSplit(valueMicroUsd, creatorUplines);
  return { ...split, viewerEcBackingMicroUsd: split.energyPoolMicroUsd };
}
