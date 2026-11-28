// V1.2 Round B — 3 % safety haircut + 5 % Boss Bounty Pool, Golden Boss draw, banner cap, launch multipliers
// run with: cd packages/shared && node --test test/*.test.mjs (after pnpm --filter @mwar/shared build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAdGross,
  netAdMicroUsd,
  drawBossBountyMicroUsd,
  calculateRewardSplit,
  AD_SAFETY_HAIRCUT_PCT,
  BOSS_POOL_GROSS_PCT,
  AD_NET_VALUE_MAX_PCT,
  MAX_DAILY_BANNER_IMPRESSIONS,
  BOSS_BOUNTY_MIN_POOL_MICRO_USD,
  BOSS_BOUNTY_MIN_MICRO_USD,
  BOSS_BOUNTY_MAX_MICRO_USD,
  BOSS_BOUNTY_EVENT_INTERVAL_MS,
  REDIRECT_PLATFORM_FEE_TO_BOSS_DEFAULT,
  DEFAULT_AD_MULTIPLIERS,
  BatchPayoutItemSchema,
  LEDGER_INFLOW_ACTIONS,
  isWalletMovingAction,
} from '../dist/index.mjs';

test('constants: 3 % safety + 5 % boss pool, net never above 95 %, 60 banners / day', () => {
  assert.equal(AD_SAFETY_HAIRCUT_PCT, 3);
  assert.equal(BOSS_POOL_GROSS_PCT, 5);
  assert.equal(AD_NET_VALUE_MAX_PCT, 95);
  assert.equal(MAX_DAILY_BANNER_IMPRESSIONS, 60);
  assert.equal(REDIRECT_PLATFORM_FEE_TO_BOSS_DEFAULT, true);
});

test('splitAdGross: S = floor(3 %), B = floor(5 %), V = G − S − B (92 %), exact and ≤ 95 % for every G', () => {
  const ex = splitAdGross(10_000);
  assert.deepEqual(ex, { grossMicroUsd: 10_000, safetyReserveMicroUsd: 300, bossPoolMicroUsd: 500, netMicroUsd: 9_200 });
  assert.equal(netAdMicroUsd(29_434), 29_434 - Math.floor(29_434 * 0.03) - Math.floor(29_434 * 0.05));
  for (let g = 0; g <= 50_000; g++) {
    const r = splitAdGross(g);
    assert.equal(r.safetyReserveMicroUsd + r.bossPoolMicroUsd + r.netMicroUsd, g, `sum G=${g}`);
    assert.equal(r.bossPoolMicroUsd, Math.floor((g * 5) / 100), `boss G=${g}`);
    assert.ok(r.safetyReserveMicroUsd >= Math.floor((g * 3) / 100), `safety G=${g}`);
    assert.ok(r.netMicroUsd <= Math.floor((g * 95) / 100), `cap G=${g}`);
    assert.ok(r.netMicroUsd >= 0 && r.safetyReserveMicroUsd >= 0);
    if (g >= 100) assert.equal(r.netMicroUsd, g - Math.floor((g * 3) / 100) - Math.floor((g * 5) / 100), `92 % G=${g}`);
  }
  assert.deepEqual(splitAdGross(-5), { grossMicroUsd: 0, safetyReserveMicroUsd: 0, bossPoolMicroUsd: 0, netMicroUsd: 0 });
  assert.deepEqual(splitAdGross(NaN), { grossMicroUsd: 0, safetyReserveMicroUsd: 0, bossPoolMicroUsd: 0, netMicroUsd: 0 });
});

test('full chain G → 3 % + 5 % + V split 55/15/5/5/20: Σ === G and the boss pool gets 5 % gross + the 5 % fee', () => {
  const ups = [1, 2, 3, 4, 5].map((d) => ({ userId: `u${d}`, depth: d }));
  for (const g of [1, 99, 1_000, 10_000, 123_457, 1_000_000]) {
    const h = splitAdGross(g);
    const r = calculateRewardSplit(h.netMicroUsd, ups);
    const parts = Number(r.earnerMicroUsd) + Number(r.bountyMicroUsd) + Number(r.energyPoolMicroUsd) + Number(r.platformTotalMicroUsd) + r.uplinePayouts.reduce((a, p) => a + Number(p.amountMicroUsd), 0);
    assert.equal(parts + h.safetyReserveMicroUsd + h.bossPoolMicroUsd, g);
    // redirected fee = floor(V × 5 %) and stays inside the platform's total
    assert.equal(r.platformFeeMicroUsd, BigInt(Math.floor((h.netMicroUsd * 5) / 100)));
    assert.ok(r.platformTotalMicroUsd >= r.platformFeeMicroUsd);
  }
  // $1 gross: 30k safety · 50k boss · V 920k → fee 46k → boss pool total 96k (≈ 10 %)
  const h = splitAdGross(1_000_000);
  const r = calculateRewardSplit(h.netMicroUsd, ups);
  assert.equal(h.safetyReserveMicroUsd, 30_000);
  assert.equal(h.bossPoolMicroUsd + Number(r.platformFeeMicroUsd), 96_000);
  assert.equal(Number(r.earnerMicroUsd), 506_000);
});

test('Golden Boss draw: 500 C – 2,000 C in whole C, never more than the pool, nothing below 500 C pool', () => {
  assert.equal(BOSS_BOUNTY_MIN_POOL_MICRO_USD, 50_000);
  assert.equal(BOSS_BOUNTY_MIN_MICRO_USD, 50_000);
  assert.equal(BOSS_BOUNTY_MAX_MICRO_USD, 200_000);
  assert.equal(BOSS_BOUNTY_EVENT_INTERVAL_MS, 600_000);
  assert.equal(drawBossBountyMicroUsd(49_999, () => 0.5), 0);
  assert.equal(drawBossBountyMicroUsd(0), 0);
  assert.equal(drawBossBountyMicroUsd(1_000_000, () => 0), 50_000);
  assert.equal(drawBossBountyMicroUsd(1_000_000, () => 0.9999999), 200_000);
  assert.equal(drawBossBountyMicroUsd(80_000, () => 0.9999999), 80_000); // capped by the pool
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 5000; i++) {
    const pool = 50_000 + Math.floor(rnd() * 400_000);
    const v = drawBossBountyMicroUsd(pool, rnd);
    assert.ok(v >= 50_000 && v <= 200_000 && v <= pool, `${v} of ${pool}`);
    if (v < pool) assert.equal(v % 100, 0);
  }
});

test('conservative launch multipliers: direct links 35 %, banners 60 %', () => {
  assert.equal(DEFAULT_AD_MULTIPLIERS.monetag_direct, 35);
  assert.equal(DEFAULT_AD_MULTIPLIERS.adsterra_smartlink, 35);
  assert.equal(DEFAULT_AD_MULTIPLIERS.adsterra_300x250, 60);
  assert.equal(DEFAULT_AD_MULTIPLIERS.adsterra_320x50, 60);
});

test('BOSS_BOUNTY_CLAIM / BOSS_BOUNTY_RELEASE are game-server items; the claim is a wallet inflow', () => {
  const uid = '11111111-1111-4111-8111-111111111111';
  for (const actionType of ['BOSS_BOUNTY_CLAIM', 'BOSS_BOUNTY_RELEASE']) {
    assert.ok(BatchPayoutItemSchema.safeParse({ userId: uid, amountMicroUsd: 0, actionType, gameId: 'g', metadata: { reservationId: 'bbr_x' } }).success);
  }
  assert.ok(LEDGER_INFLOW_ACTIONS.includes('BOSS_BOUNTY_CLAIM'));
  assert.ok(isWalletMovingAction('BOSS_BOUNTY_CLAIM'));
  assert.ok(!isWalletMovingAction('BOSS_BOUNTY_RELEASE'));
});
