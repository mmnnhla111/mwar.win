// V1.1 zero-deficit ticket-backed economy — run with: pnpm --filter @mwar/shared test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundCoinMicroUsd,
  roundCoinShare,
  safeAdMicroUsd,
  parseSafetyMultiplierBp,
  clampSafetyMultiplierBp,
  formatCoinsAndUsd,
  formatCoins2,
  formatUsdPrecise,
  allocateEcProgress,
  calculateRewardSplit,
  calculateCheerSplit,
  earnerAndBountyShares,
  getStatisticalAdMicroUsd,
  COUNTRY_AD_ECPM_USD,
  nextBannerIntervalSeconds,
  AD_BANNER_INTERVAL_MIN_SECONDS,
  AD_BANNER_INTERVAL_MAX_SECONDS,
  AD_BANNER_MIN_GAP_SECONDS,
  AD_IDLE_PAUSE_MS,
  AD_SAFETY_MULTIPLIER_DEFAULT_BP,
  BatchPayoutItemSchema,
  MAX_ENERGY_TICKETS,
} from '../dist/index.mjs';
import * as shared from '../dist/index.mjs';

const full = [1, 2, 3, 4, 5].map((d) => ({ userId: `u${d}`, depth: d }));
const UPLINE_SETS = [[], full, full.slice(0, 1), full.slice(0, 2), [full[0], full[2], full[4]]];
const sumOf = (r) => r.earnerMicroUsd + r.bountyMicroUsd + r.energyPoolMicroUsd + r.platformTotalMicroUsd + r.uplinePayouts.reduce((a, p) => a + p.amountMicroUsd, 0n);
const FORMATS = ['banner', 'video_5s', 'video_15s', 'video_30s'];
const ODD = [1, 7, 33, 333, 2850, 29440];

/** Every structural invariant of one split of V. */
function assertSplit(v, ups, label) {
  const V = BigInt(v);
  const r = calculateRewardSplit(v, ups);
  assert.equal(sumOf(r), V, `${label}: sum === V`);
  assert.equal(r.totalMicroUsd, V, `${label}: total === V`);
  assert.ok(r.platformTotalMicroUsd >= (V * 5n) / 100n, `${label}: platform >= floor(V × 5 %)`);
  for (const x of [r.earnerMicroUsd, r.bountyMicroUsd, r.energyPoolMicroUsd, r.platformTotalMicroUsd, ...r.uplinePayouts.map((p) => p.amountMicroUsd)]) {
    assert.ok(x >= 0n, `${label}: no negative share`);
  }
  // A rounded share is never more than its exact value rounded up (no hidden extra money)
  const cap = (pct) => (V * BigInt(pct) + 99n) / 100n;
  assert.ok(r.earnerMicroUsd <= cap(55), `${label}: earner <= ceil(55 %)`);
  assert.ok(r.energyPoolMicroUsd <= cap(20), `${label}: pool <= ceil(20 %)`);
  assert.ok(r.bountyMicroUsd <= cap(5), `${label}: bounty <= ceil(5 %)`);
  return r;
}

// ---- 1. Rounding rule on the 3rd decimal of C ---------------------------------------------------
test('roundCoinMicroUsd: 0.006 C down, 0.0069 C down, 0.007 C up, 0.009 C up', () => {
  // 0.01 C = 1 µUSD, so 0.006 C = 0.6 µUSD, 0.0069 C = 0.69 µUSD, 0.007 C = 0.7 µUSD, 0.009 C = 0.9 µUSD
  assert.equal(roundCoinMicroUsd(0.6), 0);
  assert.equal(roundCoinMicroUsd(0.69), 0);
  assert.equal(roundCoinMicroUsd(0.7), 1);
  assert.equal(roundCoinMicroUsd(0.9), 1);
  // with a whole part: 28.506 C / 28.5069 C / 28.507 C / 28.509 C
  assert.equal(roundCoinMicroUsd(2850.6), 2850);
  assert.equal(roundCoinMicroUsd(2850.69), 2850);
  assert.equal(roundCoinMicroUsd(2850.7), 2851);
  assert.equal(roundCoinMicroUsd(2850.9), 2851);
  // float noise: 0.7 that came out as 0.6999999999 still rounds up; exact integers stay
  assert.equal(roundCoinMicroUsd(0.1 * 7), 1);
  assert.equal(roundCoinMicroUsd(1.0000000001), 1);
  assert.equal(roundCoinMicroUsd(3000), 3000);
  assert.equal(roundCoinMicroUsd(0), 0);
  assert.equal(roundCoinMicroUsd(-5), 0);
  assert.equal(roundCoinMicroUsd(Number.NaN), 0);
});

test('roundCoinShare (exact integer) matches roundCoinMicroUsd on V × rate', () => {
  for (let v = 0; v <= 5000; v += 7) {
    for (const bps of [100, 200, 300, 400, 500, 2000, 5500]) {
      assert.equal(Number(roundCoinShare(BigInt(v), BigInt(bps))), roundCoinMicroUsd((v * bps) / 10000), `V=${v} bps=${bps}`);
    }
  }
});

// ---- 2. Conservative ad haircut (−5 % … −10 %, never above the gross) ---------------------------
test('haircut: $3.00 eCPM banner (3,000 µUSD = 30.00 C) → 27.00 C – 28.50 C, never above 30.00 C', () => {
  const gross = 3000;
  for (let bp = 9000; bp <= 9500; bp += 50) {
    const safe = safeAdMicroUsd(gross, bp);
    assert.ok(safe >= 2700 && safe <= 2850, `bp ${bp} → ${safe}`);
  }
  assert.equal(safeAdMicroUsd(gross), 2760); // default 0.92
  assert.equal(safeAdMicroUsd(gross, 0.92), 2760);
  assert.equal(safeAdMicroUsd(gross, 0.9), 2700);
  assert.equal(safeAdMicroUsd(gross, 0.95), 2850);
  // out-of-range multipliers are clamped into 0.90 – 0.95: never 100 %+ of the revenue
  assert.equal(safeAdMicroUsd(gross, 1.2), 2850);
  assert.equal(safeAdMicroUsd(gross, 1), 2850);
  assert.equal(safeAdMicroUsd(gross, 0.5), 2700);
  assert.equal(safeAdMicroUsd(gross, 15000), 2850);
  assert.equal(formatCoins2(safeAdMicroUsd(gross, 0.95)), '28.50 C');
  assert.equal(formatCoins2(safeAdMicroUsd(gross, 0.9)), '27.00 C');
  assert.equal(parseSafetyMultiplierBp('0.92'), 9200);
  assert.equal(parseSafetyMultiplierBp('92'), 9200);
  assert.equal(parseSafetyMultiplierBp(''), AD_SAFETY_MULTIPLIER_DEFAULT_BP);
  assert.equal(parseSafetyMultiplierBp('abc'), AD_SAFETY_MULTIPLIER_DEFAULT_BP);
  assert.equal(clampSafetyMultiplierBp(10_000), 9500);
  assert.equal(clampSafetyMultiplierBp(1), 9000);
  assert.equal(safeAdMicroUsd(0), 0);
  assert.equal(safeAdMicroUsd(-10), 0);
  assert.equal(safeAdMicroUsd(1), 0); // floor(0.92) — tiny values round DOWN in the house's favour
});

// ---- 3. Zero-deficit conservation across all 26 countries + GLOBAL ------------------------------
test('eCPM table has the 26 countries + GLOBAL', () => {
  const codes = Object.keys(COUNTRY_AD_ECPM_USD);
  assert.equal(codes.length, 27);
  assert.ok(codes.includes('GLOBAL'));
  assert.equal(codes.filter((c) => c !== 'GLOBAL').length, 26);
});

test('every country + GLOBAL, every format, every haircut: split === V <= gross, -5 % … -10 %', () => {
  let checked = 0;
  for (const code of Object.keys(COUNTRY_AD_ECPM_USD)) {
    for (const format of FORMATS) {
      const gross = getStatisticalAdMicroUsd(code, format);
      assert.ok(Number.isInteger(gross) && gross > 0, `${code}/${format}`);
      for (const bp of [9000, 9200, 9500, 8000, 9999]) {
        const V = safeAdMicroUsd(gross, bp);
        assert.ok(V <= gross, `${code}/${format}/${bp}: safe <= gross`);
        assert.ok(V <= Math.floor(gross * 0.95), `${code}/${format}/${bp}: at least -5 %`);
        assert.ok(V >= Math.floor(gross * 0.9), `${code}/${format}/${bp}: at most -10 %`);
        for (const ups of UPLINE_SETS) {
          const r = assertSplit(V, ups, `${code}/${format}/${bp}/${ups.length}`);
          assert.ok(r.totalMicroUsd <= BigInt(gross));
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 27 * 4 * 5 * UPLINE_SETS.length);
});

test('small / odd µUSD values 1, 7, 33, 333, 2850, 29440: exact conservation', () => {
  for (const v of ODD) for (const ups of UPLINE_SETS) assertSplit(v, ups, `V=${v}/${ups.length}`);
  // spot values (all 5 uplines)
  const r2850 = calculateRewardSplit(2850, full);
  assert.equal(r2850.earnerMicroUsd, 1567n); // 1567.5 → down (0.5 < 0.7)
  assert.equal(r2850.energyPoolMicroUsd, 570n);
  assert.equal(r2850.bountyMicroUsd, 142n); // 142.5 → down
  assert.deepEqual(r2850.uplinePayouts.map((p) => p.amountMicroUsd), [142n, 114n, 85n, 57n, 28n]); // 85.5 → 85, 28.5 → 28
});

test('V = 7 rounds up 0.85 → trims so the platform keeps floor(5 %) and the total never exceeds V', () => {
  const r = calculateRewardSplit(7, full);
  assert.equal(sumOf(r), 7n);
  assert.equal(r.earnerMicroUsd, 4n); // 3.85 → 4
  assert.ok(r.platformTotalMicroUsd >= 0n);
  const r1 = calculateRewardSplit(1, full);
  assert.equal(r1.earnerMicroUsd, 0n); // 0.55 → 0
  assert.equal(r1.platformTotalMicroUsd, 1n);
});

test('trimming: shares that would all round up never push the total over V', () => {
  // brute force: every V up to 20 000 with all five uplines (the worst case for round-ups)
  for (let v = 1; v <= 20_000; v++) {
    const r = calculateRewardSplit(v, full);
    if (sumOf(r) !== BigInt(v) || r.platformTotalMicroUsd < (BigInt(v) * 5n) / 100n) assert.fail(`V=${v}`);
  }
});

// ---- 4. Cheer: exact 100 % split --------------------------------------------------------------
test('cheer split: creator 55 + uplines 15 + bounty 5 + platform 5 + viewer EC backing 20 === 100 % of V', () => {
  for (const code of Object.keys(COUNTRY_AD_ECPM_USD)) {
    for (const format of ['banner', 'video_15s', 'video_30s']) {
      const V = safeAdMicroUsd(getStatisticalAdMicroUsd(code, format));
      for (const ups of UPLINE_SETS) {
        const c = calculateCheerSplit(V, ups);
        const total = c.earnerMicroUsd + c.uplinePayouts.reduce((a, p) => a + p.amountMicroUsd, 0n) + c.bountyMicroUsd + c.platformTotalMicroUsd + c.viewerEcBackingMicroUsd;
        assert.equal(total, BigInt(V), `${code}/${format}`);
        // the 20 % slice is the viewer's backing — not an extra 20 % on top (never 120 %)
        assert.equal(c.viewerEcBackingMicroUsd, c.energyPoolMicroUsd);
      }
    }
  }
  for (const v of ODD) {
    const c = calculateCheerSplit(v, full);
    assert.equal(c.totalMicroUsd, BigInt(v));
  }
});

// ---- 5. Ticket minting from EC progress (pending backing) ---------------------------------------
test('allocateEcProgress: backing is conserved, tickets carry exactly what was charged', () => {
  // 25 % steps of 2 760 µUSD → one ticket of 11 040 µUSD
  let s = { bp: 0, pending: 0, tickets: 0 };
  const minted = [];
  for (let i = 0; i < 4; i++) {
    const r = allocateEcProgress({ prevBp: s.bp, prevPending: s.pending, addBp: 2500, addMicroUsd: 2760, tickets: s.tickets, maxTickets: MAX_ENERGY_TICKETS });
    minted.push(...r.mintedBacking);
    s = { bp: r.newBp, pending: r.newPending, tickets: r.tickets };
  }
  assert.deepEqual(minted, [11_040]);
  assert.equal(s.bp, 0);
  assert.equal(s.pending, 0);
  // overflow: 60 % + 60 % → ticket gets 60 % + 4/6 of the second credit, the rest carries over
  const a = allocateEcProgress({ prevBp: 6000, prevPending: 600, addBp: 6000, addMicroUsd: 600, tickets: 0, maxTickets: 300 });
  assert.deepEqual(a.mintedBacking, [1000]);
  assert.equal(a.newBp, 2000);
  assert.equal(a.newPending, 200);
  // full at 300: no mint, bar capped below 100 %, backing kept
  const f = allocateEcProgress({ prevBp: 9000, prevPending: 900, addBp: 5000, addMicroUsd: 500, tickets: 300, maxTickets: 300 });
  assert.deepEqual(f.mintedBacking, []);
  assert.equal(f.newBp, 9999);
  assert.equal(f.newPending, 1400);
  // property: random credits never create or lose a µUSD
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 5000; i++) {
    const inp = { prevBp: Math.floor(rnd() * 10000), prevPending: Math.floor(rnd() * 50000), addBp: Math.floor(rnd() * 40000), addMicroUsd: Math.floor(rnd() * 100000), tickets: Math.floor(rnd() * 302), maxTickets: 300 };
    const r = allocateEcProgress(inp);
    const out = r.mintedBacking.reduce((x, y) => x + y, 0) + r.newPending;
    assert.equal(out, inp.prevPending + inp.addMicroUsd, JSON.stringify(inp));
    assert.ok(r.tickets <= Math.max(inp.tickets, 300));
    assert.ok(r.newBp >= 0 && (r.tickets >= 300 ? r.newBp < 10000 : r.newBp < 10000));
    assert.ok(r.mintedBacking.every((m) => Number.isInteger(m) && m >= 0));
  }
});

// ---- 6. Display: C (2 decimals) + $ ----------------------------------------------------------------
test('formatCoinsAndUsd shows both C (2 decimals) and $', () => {
  assert.equal(formatCoinsAndUsd(2850), '28.50 C ($0.0029)');
  assert.equal(formatCoinsAndUsd(1), '0.01 C ($0.0000)');
  assert.equal(formatCoinsAndUsd(10_000), '100.00 C ($0.0100)');
  assert.equal(formatCoinsAndUsd(0), '0.00 C ($0.0000)');
  assert.equal(formatCoins2(123_456_789), '1,234,567.89 C');
  assert.equal(formatUsdPrecise(5_500_000), '$5.50');
  assert.equal(formatUsdPrecise(1_234_567_890), '$1,234.57');
  assert.equal(formatCoinsAndUsd(-2850), '-28.50 C (-$0.0029)');
  assert.equal(formatCoinsAndUsd(29440n), '294.40 C ($0.0294)');
});

test('game-server helper still returns the earner / bounty shares of V', () => {
  assert.deepEqual(earnerAndBountyShares(100_000), { earner: 55_000, bounty: 5_000 });
  assert.deepEqual(earnerAndBountyShares(2850), { earner: 1567, bounty: 142 });
});

// ---- 7. Banner interval 30–45 s, server gap >= 28 s -------------------------------------------------
test('banner cycle is randomized 30–45 s; the server gate is >= 28 s; anti-idle stays 35 s', () => {
  assert.equal(nextBannerIntervalSeconds(() => 0), 30);
  assert.equal(nextBannerIntervalSeconds(() => 0.9999999), 45);
  assert.equal(nextBannerIntervalSeconds(() => 0.5), 38);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const s = nextBannerIntervalSeconds();
    assert.ok(Number.isInteger(s) && s >= 30 && s <= 45);
    seen.add(s);
  }
  assert.equal(seen.size, 16);
  assert.equal(AD_BANNER_INTERVAL_MIN_SECONDS, 30);
  assert.equal(AD_BANNER_INTERVAL_MAX_SECONDS, 45);
  assert.ok(AD_BANNER_MIN_GAP_SECONDS >= 28 && AD_BANNER_MIN_GAP_SECONDS < AD_BANNER_INTERVAL_MIN_SECONDS);
  assert.equal(AD_IDLE_PAUSE_MS, 35_000);
  assert.equal('AD_BANNER_INTERVAL_SECONDS' in shared, false);
});

// ---- 8. No hardcoded kill payout ---------------------------------------------------------------------
test('no fixed kill / chest reward constants remain', () => {
  assert.equal('KILL_REWARD_BASE_MICRO_USD' in shared, false);
  assert.equal('CHEST_REWARD_BASE_MICRO_USD' in shared, false);
  const ok = BatchPayoutItemSchema.safeParse({ userId: crypto.randomUUID(), amountMicroUsd: 0, actionType: 'TICKET_FORFEIT', gameId: 'g', metadata: { ticketId: 'tkt_x' } });
  assert.equal(ok.success, true);
  assert.equal(BatchPayoutItemSchema.safeParse({ userId: crypto.randomUUID(), amountMicroUsd: -1, actionType: 'GAME_KILL', gameId: 'g' }).success, false);
});
