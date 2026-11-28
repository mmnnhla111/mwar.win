import { Hono } from 'hono';
import {
  SKIN_BY_SLUG,
  SKIN_FRAGMENTS_PER_CRATE,
  SkinEquipSchema,
  SkinListSchema,
  rollSkin,
  splitSkinSale,
  type SkinInventoryResponse,
  type SkinListingItem,
  type UserSkinItem,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { PLATFORM_ACCOUNT_ID } from '../utils/guards';
import { ledgerAfterUpdate } from '../utils/ledger';
import { liveConfig } from '../utils/platform-settings';

/**
 * /api/skins — V1.2 C cosmetic skins (weapon finishes + outfits) and the P2P skin market (spec §7.6):
 *   GET  /inventory                 my skins, Skin Blueprint Fragments (daily quest drops), equipped skins, fee %
 *   POST /crate/open                spend 3 fragments → one Loot Crate roll (62/27/9/2 % common/rare/epic/legendary)
 *   POST /equip                     { skinId | null, kind } — cosmetic data carried in the signed entry token
 *   POST /list                      { skinId, priceMicroUsd ≥ 50 C } — tradeable, owned, not listed
 *   POST /listings/:id/cancel       seller takes a listing down
 *   GET  /market                    active listings
 *   POST /market/:id/buy            ONE atomic D1 batch: listing active → sold (status CHECK guard: no double sale),
 *                                   buyer debited (wallets CHECK >= 0), seller credited price − fee (fee 5–10 %,
 *                                   default 10 %), platform + fee, ownership transferred, ledger SKIN_MARKET_BUY /
 *                                   SKIN_MARKET_SALE; a final guard rolls everything back if any step missed its row
 * Skins never pay or earn anything in the arena — they are only a tint / finish on the model.
 */
type AppEnv = { Bindings: Env; Variables: { user: AuthUserPayload } };
export const skinsRouter = new Hono<AppEnv>();
skinsRouter.use('*', authMiddleware);
const nowSec = () => Math.floor(Date.now() / 1000);
const LISTING_RE = /^skl_[a-f0-9-]{36}$/;

skinsRouter.get('/inventory', async (c) => {
  const me = c.get('user');
  const [rows, u] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT s.*, (SELECT l.id FROM skin_market_listings l WHERE l.skin_id = s.id AND l.status = 'active') AS listing_id
         FROM user_skins s WHERE s.owner_id = ?1 ORDER BY s.created_at DESC LIMIT 300`
    ).bind(me.userId),
    c.env.DB.prepare('SELECT skin_fragments, equipped_weapon_skin_id AS w, equipped_outfit_skin_id AS o FROM users WHERE id = ?1').bind(me.userId),
  ]);
  const user = (u.results?.[0] || {}) as any;
  const items: UserSkinItem[] = (rows.results || []).map((r: any) => ({
    id: r.id,
    slug: r.skin_slug,
    kind: r.kind,
    rarity: r.rarity,
    tint: SKIN_BY_SLUG[r.skin_slug]?.tint ?? '#999999',
    isTradeable: r.is_tradeable === 1,
    isListed: r.is_listed === 1,
    listingId: r.listing_id || null,
    equipped: r.id === user.w || r.id === user.o,
    acquiredFrom: r.acquired_from,
    createdAt: Number(r.created_at) || 0,
  }));
  const owned = new Set(items.map((i) => i.id));
  const body: SkinInventoryResponse = {
    items,
    fragments: Number(user.skin_fragments ?? 0),
    fragmentsPerCrate: SKIN_FRAGMENTS_PER_CRATE,
    equipped: { weapon_finish: owned.has(user.w) ? user.w : null, outfit: owned.has(user.o) ? user.o : null },
    feePct: (await liveConfig(c.env)).skinMarketFeePct,
  };
  return c.json(body);
});

skinsRouter.post('/crate/open', async (c) => {
  const me = c.get('user');
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  const skin = rollSkin(rnd[0] / 2 ** 32, rnd[1] / 2 ** 32);
  const id = `skn_${crypto.randomUUID()}`;
  const t = nowSec();
  const res = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET skin_fragments = skin_fragments - ?2 WHERE id = ?1 AND skin_fragments >= ?2').bind(me.userId, SKIN_FRAGMENTS_PER_CRATE),
    c.env.DB.prepare(
      "INSERT INTO user_skins (id, owner_id, skin_slug, kind, rarity, is_tradeable, is_listed, acquired_from, created_at) SELECT ?1, ?2, ?3, ?4, ?5, 1, 0, 'mission_crate', ?6 WHERE changes() = 1"
    ).bind(id, me.userId, skin.slug, skin.kind, skin.rarity, t),
  ]);
  if ((res[1].meta?.changes ?? 0) !== 1) return c.json({ error: `You need ${SKIN_FRAGMENTS_PER_CRATE} Skin Blueprint Fragments`, code: 'NO_FRAGMENTS' }, 409);
  return c.json({ success: true, skin: { id, slug: skin.slug, kind: skin.kind, rarity: skin.rarity, tint: skin.tint } });
});

skinsRouter.post('/equip', async (c) => {
  const me = c.get('user');
  const parsed = SkinEquipSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid skin', code: 'INVALID' }, 400);
  const col = parsed.data.kind === 'outfit' ? 'equipped_outfit_skin_id' : 'equipped_weapon_skin_id';
  if (parsed.data.skinId) {
    const s = await c.env.DB.prepare('SELECT kind, is_listed FROM user_skins WHERE id = ?1 AND owner_id = ?2').bind(parsed.data.skinId, me.userId).first<{ kind: string; is_listed: number }>();
    if (!s || s.kind !== parsed.data.kind) return c.json({ error: 'Skin not found', code: 'NOT_FOUND' }, 404);
    if (s.is_listed === 1) return c.json({ error: 'Take the skin off the market first', code: 'LISTED' }, 409);
  }
  await c.env.DB.prepare(`UPDATE users SET ${col} = ?2 WHERE id = ?1`).bind(me.userId, parsed.data.skinId).run();
  return c.json({ success: true });
});

skinsRouter.post('/list', async (c) => {
  const me = c.get('user');
  const parsed = SkinListSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Minimum price is 50 C', code: 'INVALID' }, 400);
  const { skinId, priceMicroUsd } = parsed.data;
  const id = `skl_${crypto.randomUUID()}`;
  const t = nowSec();
  let res;
  try {
    res = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE user_skins SET is_listed = 1 WHERE id = ?1 AND owner_id = ?2 AND is_tradeable = 1 AND is_listed = 0').bind(skinId, me.userId),
      c.env.DB.prepare("INSERT INTO skin_market_listings (id, skin_id, seller_id, price_micro_usd, status, created_at) SELECT ?1, ?2, ?3, ?4, 'active', ?5 WHERE changes() = 1").bind(id, skinId, me.userId, priceMicroUsd, t),
      // a listed skin is no longer worn
      c.env.DB.prepare(
        'UPDATE users SET equipped_weapon_skin_id = CASE WHEN equipped_weapon_skin_id = ?2 THEN NULL ELSE equipped_weapon_skin_id END, equipped_outfit_skin_id = CASE WHEN equipped_outfit_skin_id = ?2 THEN NULL ELSE equipped_outfit_skin_id END WHERE id = ?1 AND changes() = 1'
      ).bind(me.userId, skinId),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) return c.json({ error: 'This skin is already listed', code: 'LISTED' }, 409);
    throw e;
  }
  if ((res[1].meta?.changes ?? 0) !== 1) return c.json({ error: 'This skin cannot be listed', code: 'NOT_TRADEABLE' }, 409);
  return c.json({ success: true, listingId: id });
});

skinsRouter.post('/listings/:id/cancel', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  if (!LISTING_RE.test(id)) return c.json({ error: 'Listing not found' }, 404);
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE skin_market_listings SET status = 'cancelled' WHERE id = ?1 AND seller_id = ?2 AND status = 'active'").bind(id, me.userId),
    c.env.DB.prepare('UPDATE user_skins SET is_listed = 0 WHERE id = (SELECT skin_id FROM skin_market_listings WHERE id = ?1) AND owner_id = ?2 AND changes() = 1').bind(id, me.userId),
  ]);
  if ((res[0].meta?.changes ?? 0) !== 1) return c.json({ error: 'Listing not found', code: 'NOT_FOUND' }, 404);
  return c.json({ success: true });
});

skinsRouter.get('/market', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT l.id, l.skin_id, l.seller_id, l.price_micro_usd, l.created_at, s.skin_slug, s.kind, s.rarity, u.username AS seller_username
         FROM skin_market_listings l JOIN user_skins s ON s.id = l.skin_id JOIN users u ON u.id = l.seller_id
        WHERE l.status = 'active' ORDER BY l.created_at DESC LIMIT 100`
    )
    .all<any>();
  const items: SkinListingItem[] = (rows.results || []).map((r: any) => ({
    id: r.id,
    skinId: r.skin_id,
    slug: r.skin_slug,
    kind: r.kind,
    rarity: r.rarity,
    tint: SKIN_BY_SLUG[r.skin_slug]?.tint ?? '#999999',
    sellerId: r.seller_id,
    sellerUsername: r.seller_username,
    priceMicroUsd: Number(r.price_micro_usd) || 0,
    createdAt: Number(r.created_at) || 0,
  }));
  return c.json({ items, feePct: (await liveConfig(c.env)).skinMarketFeePct });
});

skinsRouter.post('/market/:id/buy', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  if (!LISTING_RE.test(id)) return c.json({ error: 'Listing not found' }, 404);
  const l = await c.env.DB.prepare('SELECT * FROM skin_market_listings WHERE id = ?1').bind(id).first<any>();
  if (!l || l.status !== 'active') return c.json({ error: 'This skin was already sold', code: 'SOLD' }, 409);
  if (l.seller_id === me.userId) return c.json({ error: 'You cannot buy your own skin', code: 'OWN_LISTING' }, 400);
  const feePct = (await liveConfig(c.env)).skinMarketFeePct;
  const split = splitSkinSale(Number(l.price_micro_usd), feePct);
  const bal = Number(await walletBalance(c.env.DB, me.userId));
  if (bal < split.priceMicroUsd) return c.json({ error: 'Not enough C in your wallet', code: 'INSUFFICIENT', balanceMicroUsd: bal }, 402);
  const t = nowSec();
  try {
    await c.env.DB.batch([
      // 1. status guard: only an ACTIVE listing becomes sold — anything else writes 'conflict' → CHECK → rollback
      c.env.DB.prepare(
        "UPDATE skin_market_listings SET status = CASE WHEN status = 'active' THEN 'sold' ELSE 'conflict' END, buyer_id = ?2, sold_at = ?3, fee_pct = ?4 WHERE id = ?1"
      ).bind(id, me.userId, t, feePct),
      // 2. buyer debit (wallets CHECK >= 0 → never below 0)
      c.env.DB.prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd - ?1, updated_at = ?2 WHERE user_id = ?3 AND user_id <> ?4').bind(split.priceMicroUsd, t, me.userId, l.seller_id),
      ledgerAfterUpdate(c.env.DB, me.userId, -split.priceMicroUsd, 'SKIN_MARKET_BUY', id, t),
      // 3. seller credit (price − fee)
      c.env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1'
      ).bind(split.sellerMicroUsd, t, l.seller_id),
      ledgerAfterUpdate(c.env.DB, l.seller_id, split.sellerMicroUsd, 'SKIN_MARKET_SALE', id, t),
      // 4. platform fee
      c.env.DB.prepare("UPDATE system_balances SET platform_micro_usd = platform_micro_usd + ?1, updated_at = ?2 WHERE id = 'global' AND changes() = 1").bind(split.feeMicroUsd, t),
      // 5. ownership: the seller must still own the listed skin
      c.env.DB.prepare("UPDATE user_skins SET owner_id = ?2, is_listed = 0, acquired_from = 'p2p_market' WHERE id = ?1 AND owner_id = ?3 AND is_listed = 1 AND changes() = 1").bind(l.skin_id, me.userId, l.seller_id),
      // 6. final guard: every step above changed its row, otherwise the whole purchase rolls back
      c.env.DB.prepare("UPDATE skin_market_listings SET status = CASE WHEN changes() = 1 THEN status ELSE 'conflict' END WHERE id = ?1").bind(id),
      // the seller no longer wears it (it was unequipped at listing time; defensive)
      c.env.DB.prepare(
        'UPDATE users SET equipped_weapon_skin_id = CASE WHEN equipped_weapon_skin_id = ?2 THEN NULL ELSE equipped_weapon_skin_id END, equipped_outfit_skin_id = CASE WHEN equipped_outfit_skin_id = ?2 THEN NULL ELSE equipped_outfit_skin_id END WHERE id = ?1'
      ).bind(l.seller_id, l.skin_id),
    ]);
  } catch (e) {
    if (/CHECK constraint failed/i.test(String((e as Error)?.message ?? e))) {
      const now = await c.env.DB.prepare('SELECT status FROM skin_market_listings WHERE id = ?1').bind(id).first<{ status: string }>();
      if (now?.status !== 'active') return c.json({ error: 'This skin was already sold', code: 'SOLD' }, 409);
      return c.json({ error: 'The purchase could not be completed — nothing was charged', code: 'INSUFFICIENT' }, 402);
    }
    throw e;
  }
  const base = `tx_skin_${id.slice(4, 22)}`;
  await logFinancialTransaction(c.env, {
    transaction_id: `${base}_buy`,
    user_id: me.userId,
    action_type: 'SKIN_MARKET_BUY',
    amount_micro_usd: BigInt(split.priceMicroUsd),
    balance_after_micro_usd: await walletBalance(c.env.DB, me.userId),
    source_game_id: `skin:${l.skin_id}`.slice(0, 64),
    related_user_id: l.seller_id,
  });
  await logFinancialTransaction(c.env, {
    transaction_id: `${base}_sale`,
    user_id: l.seller_id,
    action_type: 'SKIN_MARKET_SALE',
    amount_micro_usd: BigInt(split.sellerMicroUsd),
    balance_after_micro_usd: await walletBalance(c.env.DB, l.seller_id),
    source_game_id: `skin:${l.skin_id}`.slice(0, 64),
    related_user_id: me.userId,
  });
  await logFinancialTransaction(c.env, {
    transaction_id: `${base}_fee`,
    user_id: PLATFORM_ACCOUNT_ID,
    action_type: 'SKIN_MARKET_FEE',
    amount_micro_usd: BigInt(split.feeMicroUsd),
    balance_after_micro_usd: 0n,
    source_game_id: `skin:${l.skin_id}`.slice(0, 64),
    related_user_id: l.seller_id,
  });
  return c.json({ success: true, listingId: id, skinId: l.skin_id, ...split, feePct, balanceMicroUsd: Number(await walletBalance(c.env.DB, me.userId)) });
});
