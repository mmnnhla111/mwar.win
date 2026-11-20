import {
  PLATFORM_FEE_PERCENT,
  NET_POOL_PERCENT,
  MLM_LEVEL_RATES,
} from '../constants';
import { toMicroUsdBigInt } from './currency';

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
