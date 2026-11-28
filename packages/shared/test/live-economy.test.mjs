// V1.2 Round C — spectator gifts 70/30, launch promo codes (cap / 1 per user / 1 per device), P2P skin trade 90/10,
// Happy Hour 2x (extra from the Boss Bounty Pool, capped), bot bounties, streamer share, skin crates
// run with: cd packages/shared && node --test test/*.test.mjs (after pnpm --filter @mwar/shared build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitGift,
  SPECTATOR_GIFTS,
  GIFT_RECEIVER_PCT,
  GiftSendSchema,
  promoRedemptionDecision,
  PROMO_MAX_REDEMPTIONS,
  PROMO_DEFAULT_BACKED_MICRO_USD,
  PromoCodeCreateSchema,
  splitSkinSale,
  clampSkinFeePct,
  SKIN_MIN_PRICE_MICRO_USD,
  SKIN_MARKET_FEE_PCT_DEFAULT,
  SkinListSchema,
  happyHourExtraMicroUsd,
  happyHourWindow,
  HAPPY_HOUR_DEFAULT_SCHEDULE,
  parseHappyHourSchedule,
  serializeHappyHourSchedule,
  drawBotBountyMicroUsd,
  BOT_BOUNTY_MIN_POOL_MICRO_USD,
  BOT_BOUNTY_MAX_MICRO_USD,
  splitStreamerShare,
  rollSkin,
  rollSkinRarity,
  SKIN_RARITY_WEIGHTS,
  BatchPayoutItemSchema,
  LEDGER_INFLOW_ACTIONS,
  LEDGER_OUTFLOW_ACTIONS,
  isWalletMovingAction,
  STAFF_PERMISSIONS,
} from '../dist/index.mjs';

test('gifts: catalog prices (100 C / 500 C), the free Ammo Box costs 0', () => {
  assert.equal(SPECTATOR_GIFTS.golden_grenade_100.priceMicroUsd, 10_000);
  assert.equal(SPECTATOR_GIFTS.champion_crown_500.priceMicroUsd, 50_000);
  assert.equal(SPECTATOR_GIFTS.ammo_box_ad.priceMicroUsd, 0);
  assert.equal(GIFT_RECEIVER_PCT, 70);
});

test('gifts: 70 / 30 split is exactly 100 % for every amount (receiver floor, platform takes the rounding)', () => {
  assert.deepEqual(splitGift(10_000), { grossMicroUsd: 10_000, receiverMicroUsd: 7_000, platformMicroUsd: 3_000 });
  assert.deepEqual(splitGift(50_000), { grossMicroUsd: 50_000, receiverMicroUsd: 35_000, platformMicroUsd: 15_000 });
  for (const g of [0, 1, 3, 7, 99, 101, 12_345, 999_999, 1e9 + 7]) {
    const s = splitGift(g);
    assert.equal(s.receiverMicroUsd + s.platformMicroUsd, s.grossMicroUsd, `g=${g}`);
    assert.ok(s.receiverMicroUsd <= Math.floor(g * 0.7) && s.platformMicroUsd >= 0);
  }
  assert.deepEqual(splitGift(-5), { grossMicroUsd: 0, receiverMicroUsd: 0, platformMicroUsd: 0 });
  // only the two paid gifts can be sent for C, and an idempotency key is required
  const base = { roomId: 'abc', receiverUserId: '00000000-0000-4000-8000-000000000001', clientRequestId: 'req_12345678' };
  assert.ok(GiftSendSchema.safeParse({ ...base, giftCode: 'champion_crown_500' }).success);
  assert.ok(!GiftSendSchema.safeParse({ ...base, giftCode: 'ammo_box_ad' }).success);
  assert.ok(!GiftSendSchema.safeParse({ ...base, giftCode: 'golden_grenade_100', clientRequestId: 'x' }).success);
});

const promo = (o = {}) => ({
  isActive: true,
  expiresAt: null,
  nowSec: 1_000,
  redeemedCount: 0,
  maxRedemptions: 500,
  userAlreadyRedeemed: false,
  deviceAlreadyRedeemed: false,
  marketingPoolMicroUsd: 1_000_000,
  backedMicroUsd: PROMO_DEFAULT_BACKED_MICRO_USD,
  ...o,
});

test('promo: cap of 500 per code, 1 per user, 1 per device fingerprint, backed by the marketing pool', () => {
  assert.equal(PROMO_MAX_REDEMPTIONS, 500);
  assert.equal(PROMO_DEFAULT_BACKED_MICRO_USD, 10_000);
  assert.deepEqual(promoRedemptionDecision(promo()), { ok: true });
  assert.deepEqual(promoRedemptionDecision(promo({ redeemedCount: 499 })), { ok: true });
  assert.deepEqual(promoRedemptionDecision(promo({ redeemedCount: 500 })), { ok: false, reason: 'cap' });
  // a code created with a larger max is still capped at 500
  assert.deepEqual(promoRedemptionDecision(promo({ redeemedCount: 500, maxRedemptions: 10_000 })), { ok: false, reason: 'cap' });
  assert.deepEqual(promoRedemptionDecision(promo({ userAlreadyRedeemed: true })), { ok: false, reason: 'user' });
  assert.deepEqual(promoRedemptionDecision(promo({ deviceAlreadyRedeemed: true })), { ok: false, reason: 'device' });
  assert.deepEqual(promoRedemptionDecision(promo({ marketingPoolMicroUsd: 9_999 })), { ok: false, reason: 'pool_empty' });
  assert.deepEqual(promoRedemptionDecision(promo({ isActive: false })), { ok: false, reason: 'inactive' });
  assert.deepEqual(promoRedemptionDecision(promo({ expiresAt: 1_000 })), { ok: false, reason: 'expired' });
  // simulate 600 users on 550 devices racing for one code: exactly min(500, devices) redeem
  let count = 0;
  let pool = 600 * 10_000;
  const users = new Set();
  const devices = new Set();
  for (let i = 0; i < 600; i++) {
    const u = `u${i}`;
    const d = `d${i % 550}`;
    const r = promoRedemptionDecision(promo({ redeemedCount: count, userAlreadyRedeemed: users.has(u), deviceAlreadyRedeemed: devices.has(d), marketingPoolMicroUsd: pool }));
    if (r.ok) {
      count++;
      pool -= 10_000;
      users.add(u);
      devices.add(d);
    }
  }
  assert.equal(count, 500);
  assert.equal(pool, 100 * 10_000);
  assert.ok(!PromoCodeCreateSchema.safeParse({ code: 'MWAR500', maxRedemptions: 501 }).success);
  assert.equal(PromoCodeCreateSchema.parse({ code: 'mwar500' }).code, 'MWAR500');
});

test('skins: 90 / 10 trade math (fee 5–10 %, default 10 %), exactly 100 %, min price 50 C', () => {
  assert.equal(SKIN_MARKET_FEE_PCT_DEFAULT, 10);
  assert.equal(SKIN_MIN_PRICE_MICRO_USD, 5_000);
  assert.deepEqual(splitSkinSale(5_000), { priceMicroUsd: 5_000, sellerMicroUsd: 4_500, feeMicroUsd: 500 });
  assert.deepEqual(splitSkinSale(12_345, 10), { priceMicroUsd: 12_345, sellerMicroUsd: 11_111, feeMicroUsd: 1_234 });
  assert.deepEqual(splitSkinSale(10_000, 5), { priceMicroUsd: 10_000, sellerMicroUsd: 9_500, feeMicroUsd: 500 });
  // admin values outside 5–10 % are clamped
  assert.equal(clampSkinFeePct(2), 5);
  assert.equal(clampSkinFeePct(25), 10);
  assert.equal(clampSkinFeePct('x'), 10);
  for (const p of [5_000, 5_001, 7_777, 99_999, 1_000_000]) {
    for (const f of [5, 7, 10]) {
      const s = splitSkinSale(p, f);
      assert.equal(s.sellerMicroUsd + s.feeMicroUsd, p);
      assert.ok(s.sellerMicroUsd >= Math.ceil(p * (1 - f / 100)) - 1);
    }
  }
  assert.ok(!SkinListSchema.safeParse({ skinId: 'skn_00000000-0000-4000-8000-000000000001', priceMicroUsd: 4_999 }).success);
  assert.ok(SkinListSchema.safeParse({ skinId: 'skn_00000000-0000-4000-8000-000000000001', priceMicroUsd: 5_000 }).success);
});

test('skins: crate odds sum to 100 % and every roll is a catalog skin of that rarity', () => {
  assert.equal(Object.values(SKIN_RARITY_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  assert.equal(rollSkinRarity(0), 'common');
  assert.equal(rollSkinRarity(0.999), 'legendary');
  for (let i = 0; i < 200; i++) {
    const s = rollSkin(i / 200, (i * 7) % 200 / 200);
    assert.equal(s.rarity, rollSkinRarity(i / 200));
  }
});

test('happy hour: the extra (55 % share once more) is paid only when the Boss Bounty Pool covers ALL of it', () => {
  assert.equal(happyHourExtraMicroUsd(5_500, 1_000_000, true), 5_500);
  assert.equal(happyHourExtraMicroUsd(5_500, 5_500, true), 5_500);
  assert.equal(happyHourExtraMicroUsd(5_500, 5_499, true), 0); // falls back to 1x
  assert.equal(happyHourExtraMicroUsd(5_500, 1_000_000, false), 0);
  assert.equal(happyHourExtraMicroUsd(0, 1_000_000, true), 0);
  // a pool of P pays at most P in total, whatever the number of kills
  let pool = 20_000;
  let paid = 0;
  for (let i = 0; i < 50; i++) {
    const x = happyHourExtraMicroUsd(1_234 + i, pool, true);
    pool -= x;
    paid += x;
  }
  assert.ok(pool >= 0 && paid <= 20_000);
});

test('happy hour: default 20:00–21:00 Asia/Bangkok daily (13:00–14:00 UTC), wrap past midnight', () => {
  const day = Date.UTC(2026, 10, 28);
  const at = (h, m = 0) => day + (h * 60 + m) * 60_000;
  assert.equal(happyHourWindow(at(12, 59), HAPPY_HOUR_DEFAULT_SCHEDULE).active, false);
  const w = happyHourWindow(at(13, 0), HAPPY_HOUR_DEFAULT_SCHEDULE);
  assert.equal(w.active, true);
  assert.equal(w.endsAtMs, at(14, 0));
  assert.equal(happyHourWindow(at(13, 59), HAPPY_HOUR_DEFAULT_SCHEDULE).active, true);
  assert.equal(happyHourWindow(at(14, 0), HAPPY_HOUR_DEFAULT_SCHEDULE).active, false);
  assert.equal(happyHourWindow(at(14, 0), HAPPY_HOUR_DEFAULT_SCHEDULE).nextStartMs, at(13, 0) + 86_400_000);
  const wrap = parseHappyHourSchedule(JSON.stringify({ start: '23:30', end: '00:30', tzOffsetMinutes: 0 }));
  assert.equal(happyHourWindow(at(23, 45), wrap).active, true);
  assert.equal(happyHourWindow(at(23, 45), wrap).endsAtMs, at(24, 30));
  assert.equal(happyHourWindow(at(0, 15), wrap).active, true);
  assert.equal(happyHourWindow(at(1, 0), wrap).active, false);
  assert.deepEqual(parseHappyHourSchedule('garbage'), HAPPY_HOUR_DEFAULT_SCHEDULE);
  assert.deepEqual(parseHappyHourSchedule(serializeHappyHourSchedule(HAPPY_HOUR_DEFAULT_SCHEDULE)), HAPPY_HOUR_DEFAULT_SCHEDULE);
});

test('bot bounty: 10–50 C drawn only from a pool of ≥ 1,000 C and never above the pool', () => {
  assert.equal(drawBotBountyMicroUsd(BOT_BOUNTY_MIN_POOL_MICRO_USD - 1, () => 0.5), 0);
  for (let i = 0; i < 100; i++) {
    const v = drawBotBountyMicroUsd(BOT_BOUNTY_MIN_POOL_MICRO_USD, () => i / 100);
    assert.ok(v >= 1_000 && v <= BOT_BOUNTY_MAX_MICRO_USD && v % 100 === 0);
  }
});

test('streamer share: 30–50 % (default 40 %) of a VERIFIED net value, rest stays with the viewer — exactly 100 %', () => {
  assert.deepEqual(splitStreamerShare(10_000, 40), { streamerMicroUsd: 4_000, restMicroUsd: 6_000 });
  assert.deepEqual(splitStreamerShare(10_000, 90), { streamerMicroUsd: 5_000, restMicroUsd: 5_000 });
  assert.deepEqual(splitStreamerShare(10_000, 1), { streamerMicroUsd: 3_000, restMicroUsd: 7_000 });
  for (const v of [0, 1, 3, 1_999, 8_280]) {
    const s = splitStreamerShare(v, 40);
    assert.equal(s.streamerMicroUsd + s.restMicroUsd, v);
  }
});

test('ledger / batch wiring: new wallet-moving actions and bot bounty batch items', () => {
  for (const a of ['GIFT_RECEIVE', 'SKIN_MARKET_SALE', 'BOT_BOUNTY_CLAIM', 'HAPPY_HOUR_BONUS', 'STREAMER_AD_SHARE']) {
    assert.ok(LEDGER_INFLOW_ACTIONS.includes(a), a);
    assert.ok(isWalletMovingAction(a), a);
  }
  for (const a of ['GIFT_SEND', 'SKIN_MARKET_BUY']) {
    assert.ok(LEDGER_OUTFLOW_ACTIONS.includes(a), a);
    assert.ok(isWalletMovingAction(a), a);
  }
  for (const a of ['BOT_BOUNTY_CLAIM', 'BOT_BOUNTY_RELEASE']) {
    assert.ok(BatchPayoutItemSchema.safeParse({ userId: '00000000-0000-4000-8000-000000000001', amountMicroUsd: 0, actionType: a, gameId: 'g', metadata: {} }).success, a);
  }
  assert.deepEqual([...STAFF_PERMISSIONS.coldStart], ['super_admin', 'ops_manager']);
});
