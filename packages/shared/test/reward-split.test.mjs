// Run with: pnpm --filter @mwar/shared test  (builds first, then node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRewardSplit,
  earnerAndBountyShares,
  MAX_ENERGY_TICKETS,
  INITIAL_ENERGY_TICKETS,
  REWARD_EARNER_BPS,
  REWARD_UPLINE_BPS,
  REWARD_BOUNTY_BPS,
  REWARD_PLATFORM_BPS,
  REWARD_ENERGY_POOL_BPS,
  REWARD_SPLIT_TOTAL_BPS,
} from '../dist/index.mjs';
import * as shared from '../dist/index.mjs';

const full = [1, 2, 3, 4, 5].map((d) => ({ userId: `u${d}`, depth: d }));
const sumOf = (r) => r.earnerMicroUsd + r.bountyMicroUsd + r.energyPoolMicroUsd + r.platformTotalMicroUsd + r.uplinePayouts.reduce((a, p) => a + p.amountMicroUsd, 0n);

test('rates add up to exactly 100 %: 55 / 15 (5-4-3-2-1) / 5 / 5 / 20', () => {
  assert.equal(REWARD_EARNER_BPS, 5500n);
  assert.deepEqual(Object.values(REWARD_UPLINE_BPS), [500n, 400n, 300n, 200n, 100n]);
  assert.equal(REWARD_BOUNTY_BPS, 500n);
  assert.equal(REWARD_PLATFORM_BPS, 500n);
  assert.equal(REWARD_ENERGY_POOL_BPS, 2000n);
  const total = REWARD_EARNER_BPS + Object.values(REWARD_UPLINE_BPS).reduce((a, b) => a + b, 0n) + REWARD_BOUNTY_BPS + REWARD_PLATFORM_BPS + REWARD_ENERGY_POOL_BPS;
  assert.equal(total, REWARD_SPLIT_TOTAL_BPS);
});

test('V = 10 000 000 µUSD with all 5 uplines', () => {
  const r = calculateRewardSplit(10_000_000, full);
  assert.equal(r.earnerMicroUsd, 5_500_000n);
  assert.deepEqual(r.uplinePayouts.map((p) => p.amountMicroUsd), [500_000n, 400_000n, 300_000n, 200_000n, 100_000n]);
  assert.equal(r.bountyMicroUsd, 500_000n);
  assert.equal(r.platformFeeMicroUsd, 500_000n);
  assert.equal(r.energyPoolMicroUsd, 2_000_000n);
  assert.equal(r.platformRolloverMicroUsd, 0n);
  assert.equal(r.platformTotalMicroUsd, 500_000n);
  assert.equal(sumOf(r), 10_000_000n);
});

test('missing upline tiers roll over to the platform', () => {
  const r = calculateRewardSplit(10_000_000, [{ userId: 'a', depth: 1 }, { userId: 'c', depth: 3 }]);
  assert.equal(r.uplinePayouts.length, 2);
  assert.deepEqual(r.unclaimedLevels.map((l) => l.depth), [2, 4, 5]);
  // L2 4 % + L4 2 % + L5 1 % = 7 % → platform 5 % + 7 % = 12 %
  assert.equal(r.platformTotalMicroUsd, 1_200_000n);
  assert.equal(r.earnerMicroUsd, 5_500_000n);
  assert.equal(r.energyPoolMicroUsd, 2_000_000n);
  assert.equal(sumOf(r), 10_000_000n);
});

test('no uplines: platform gets 5 % + 15 %', () => {
  const r = calculateRewardSplit(100_000, []);
  assert.equal(r.earnerMicroUsd, 55_000n);
  assert.equal(r.energyPoolMicroUsd, 20_000n);
  assert.equal(r.platformTotalMicroUsd, 20_000n);
  assert.equal(sumOf(r), 100_000n);
});

test('rounding remainders go to the platform; sum is exactly V for many odd values', () => {
  const round07 = (v, pct) => {
    const n = BigInt(v) * BigInt(pct);
    return n % 100n >= 70n ? n / 100n + 1n : n / 100n;
  };
  for (const v of [1, 7, 99, 101, 333, 12_345, 999_999, 1_000_003, 8_500, 350]) {
    for (const ups of [[], full, full.slice(0, 2)]) {
      const r = calculateRewardSplit(v, ups);
      assert.equal(sumOf(r), BigInt(v), `V=${v} uplines=${ups.length}`);
      // V1.1 0.007 C rule: each share rounds up only from a 0.7 µUSD fraction (at most 1 µUSD trimmed)
      assert.ok(round07(v, 55) - r.earnerMicroUsd <= 1n && r.earnerMicroUsd <= round07(v, 55));
      assert.ok(round07(v, 20) - r.energyPoolMicroUsd <= 1n && r.energyPoolMicroUsd <= round07(v, 20));
      assert.ok(r.platformRolloverMicroUsd >= 0n);
      assert.ok(r.platformTotalMicroUsd >= (BigInt(v) * 5n) / 100n);
    }
  }
  const r = calculateRewardSplit(333, full);
  // 183.15→183 / 16.65→16, 13.32→13, 9.99→10, 6.66→6, 3.33→3 / 16.65→16 / 66.6→66 → 313, platform 20
  assert.equal(r.earnerMicroUsd, 183n);
  assert.deepEqual(r.uplinePayouts.map((p) => p.amountMicroUsd), [16n, 13n, 10n, 6n, 3n]);
  assert.equal(r.platformTotalMicroUsd, 20n);
  assert.equal(r.platformRolloverMicroUsd, 4n);
});

test('zero / negative values split to nothing', () => {
  assert.equal(calculateRewardSplit(0, full).totalMicroUsd, 0n);
});

test('game-server helper uses the 55 % / 5 % shares', () => {
  assert.deepEqual(earnerAndBountyShares(100_000), { earner: 55_000, bounty: 5_000 });
});

test('EC: 1 at sign-up, cap 300, no passive recharge constant', () => {
  assert.equal(INITIAL_ENERGY_TICKETS, 1);
  assert.equal(MAX_ENERGY_TICKETS, 300);
  assert.equal('ENERGY_RECHARGE_SECONDS' in shared, false);
});

test('cheer limits', () => {
  assert.equal(shared.CHEER_DAILY_CAP, 15);
  assert.equal(shared.CHEER_PER_TARGET_DAILY_CAP, 3);
  assert.ok(shared.CHEER_COOLDOWN_SECONDS >= 45 && shared.CHEER_COOLDOWN_SECONDS <= 60);
  assert.equal(shared.CheerStartSchema.safeParse({ format: 'video_30s', targetType: 'post' }).success, false);
  assert.equal(shared.CheerStartSchema.safeParse({ format: 'video_30s', targetType: 'energy' }).success, true);
});
