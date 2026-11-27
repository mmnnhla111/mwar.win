// V1.1 Round 2 — Fast & Mini 90/10 split + banner pot / EC split — run with: pnpm --filter @mwar/shared test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFastMiniSplit,
  splitFastMiniBanner,
  roundCoinShare,
  safeAdMicroUsd,
  getStatisticalAdMicroUsd,
  COUNTRY_AD_ECPM_USD,
  FAST_MINI_BANNER_POT_BP,
  BatchPayoutItemSchema,
  FPS_ROOMS,
  GAME_NODE_FRESH_SECONDS,
} from '../dist/index.mjs';

/** Every invariant of one Fast & Mini split of V. */
function assertFastMini(v) {
  const V = BigInt(v);
  const r = calculateFastMiniSplit(v);
  assert.equal(r.shooterMicroUsd + r.platformMicroUsd, V, `V=${v}: shooter + platform === V`);
  assert.equal(r.totalMicroUsd, V, `V=${v}: total === V`);
  assert.equal(r.uplinesMicroUsd + r.bountyMicroUsd + r.energyPoolMicroUsd, 0n, `V=${v}: no MLM / bounty / pool`);
  assert.ok(r.platformMicroUsd >= (V * 1000n) / 10000n, `V=${v}: platform >= floor(V × 10 %)`);
  assert.ok(r.shooterMicroUsd >= 0n && r.platformMicroUsd >= 0n, `V=${v}: non-negative`);
  assert.ok(r.shooterMicroUsd <= roundCoinShare(V, 9000n), `V=${v}: shooter never above its rounded 90 %`);
  return r;
}

test('calculateFastMiniSplit: conservation for every V in 0..50 000 (sum === V, platform >= floor 10 %)', () => {
  for (let v = 0; v <= 50_000; v++) assertFastMini(v);
});

test('calculateFastMiniSplit: large / random V (BigInt-exact, never exceeds V by 1 µUSD)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 20_000; i++) assertFastMini(Math.floor(rnd() * 1e9));
  for (const v of [999_999_999, 10_000_000_000, '123456789012']) assertFastMini(v);
});

test('calculateFastMiniSplit: exact values and the 0.007 C rounding rule', () => {
  const cases = [
    // [V, shooter, platform]
    [0, 0n, 0n],
    [1, 1n, 0n], // checked separately below
    [10, 9n, 1n],
    [100, 90n, 10n],
    [333, 300n, 33n], // 299.7 → 300 (0.007 C up), platform 33 = floor(33.3)
    [2850, 2565n, 285n],
    [29_440, 26_496n, 2_944n],
  ];
  for (const [v, s, p] of cases) {
    const r = calculateFastMiniSplit(v);
    if (v === 1) {
      // 1 × 90 % = 0.9 µUSD → rounds UP (≥ 0.7) to 1; platform floor(0.1) = 0 → shooter 1, platform 0
      assert.equal(r.shooterMicroUsd + r.platformMicroUsd, 1n);
      continue;
    }
    assert.equal(r.shooterMicroUsd, s, `V=${v} shooter`);
    assert.equal(r.platformMicroUsd, p, `V=${v} platform`);
  }
  // 0.6 µUSD fraction rounds down: V = 4 → 3.6 → 3, platform 1
  assert.equal(calculateFastMiniSplit(4).shooterMicroUsd, 3n);
  // 0.7 rounds up: V = 3 → 2.7 → 3 (platform floor(0.3) = 0 still respected)
  assert.equal(calculateFastMiniSplit(3).shooterMicroUsd, 3n);
  assert.throws(() => calculateFastMiniSplit('abc'));
});

test('splitFastMiniBanner: pot + EC backing === safe value S (no µUSD used twice), EC % scaled the same way', () => {
  assert.equal(FAST_MINI_BANNER_POT_BP, 5000);
  for (let s = 0; s <= 20_000; s++) {
    const bp = (s * 7) % 10_001;
    const r = splitFastMiniBanner(s, bp);
    assert.equal(r.potMicroUsd + r.ecMicroUsd, s, `S=${s}`);
    assert.ok(r.potMicroUsd >= 0 && r.ecMicroUsd >= 0);
    assert.equal(r.potMicroUsd, Math.floor(s / 2));
    assert.ok(r.ecBp <= bp && r.ecBp === Math.floor(bp / 2));
  }
  // other shares
  for (const share of [0, 2500, 10_000]) {
    const r = splitFastMiniBanner(2760, 400, share);
    assert.equal(r.potMicroUsd + r.ecMicroUsd, 2760);
  }
});

test('end to end per country: banner gross → haircut → pot/EC split → 90/10 kill split, never above gross', () => {
  for (const country of [...Object.keys(COUNTRY_AD_ECPM_USD), 'GLOBAL']) {
    const gross = getStatisticalAdMicroUsd(country, 'banner');
    for (const hair of [9000, 9200, 9500]) {
      const safe = safeAdMicroUsd(gross, hair);
      assert.ok(safe <= gross, `${country}: safe <= gross`);
      // a life with 1..12 banner impressions
      for (let n = 1; n <= 12; n++) {
        let pot = 0;
        let ec = 0;
        for (let i = 0; i < n; i++) {
          const b = splitFastMiniBanner(safe, 300);
          pot += b.potMicroUsd;
          ec += b.ecMicroUsd;
        }
        assert.equal(pot + ec, safe * n, `${country} ×${n}: pot + EC === n × safe`);
        const k = calculateFastMiniSplit(pot);
        assert.equal(Number(k.shooterMicroUsd + k.platformMicroUsd), pot);
        // the whole money flow of the life never exceeds the gross ad revenue that funded it
        assert.ok(Number(k.shooterMicroUsd) + Number(k.platformMicroUsd) + ec <= gross * n, `${country} ×${n}: <= gross`);
      }
    }
  }
});

test('batch payout schema accepts the Round 2 game-server items', () => {
  const base = { userId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', amountMicroUsd: 0, gameId: 'g' };
  for (const actionType of ['FAST_MINI_KILL', 'FAST_MINI_CLOSE', 'TICKET_RETURN']) {
    assert.equal(BatchPayoutItemSchema.safeParse({ ...base, actionType }).success, true, actionType);
  }
  assert.equal(BatchPayoutItemSchema.safeParse({ ...base, actionType: 'FREE_MONEY' }).success, false);
});

test('Fast & Mini room is free (0 EC) in the built-in room list; node freshness window is 90 s', () => {
  const fm = FPS_ROOMS.find((r) => r.mode === 'fast_mini');
  assert.equal(fm?.costEc, 0);
  assert.equal(GAME_NODE_FRESH_SECONDS, 90);
});
