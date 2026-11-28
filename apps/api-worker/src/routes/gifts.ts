import { Hono } from 'hono';
import {
  AMMO_BOX_AD_WINDOW_SECONDS,
  AmmoBoxGiftSchema,
  GIFT_TOKEN_TTL_SECONDS,
  GiftSendSchema,
  SPECTATOR_GIFTS,
  splitGift,
  type GiftCode,
  type GiftSendResult,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { PLATFORM_ACCOUNT_ID } from '../utils/guards';
import { ledgerAfterUpdate } from '../utils/ledger';
import { signGameToken } from '../utils/live-economy';

/**
 * /api/gifts — V1.2 C Spectator Gifting (TikTok-Live style) in Ghost Spectator mode (spec §7.6):
 *   GET  /catalog     the gift list (Ammo Box free via ad, Golden Grenade 100 C, Champion Crown 500 C)
 *   POST /send        { giftCode, roomId, receiverUserId, clientRequestId } — paid gift: ONE D1 batch debits the
 *                     sender (wallets CHECK >= 0 → never below 0), credits the receiver 70 %, the platform 30 %,
 *                     writes GIFT_SEND / GIFT_RECEIVE ledger rows; a guard on gift_transactions.status rolls the
 *                     whole batch back if any step changed no row. Idempotent per (sender, clientRequestId).
 *   POST /ammo-box    { roomId, receiverUserId?, adToken } — free gift paid by a CLAIMED direct-link visit (that
 *                     visit already credited the spectator's EC progress, 0 µUSD backing unless verified); one box
 *                     per visit, 0 money moves.
 * Both return a gift token signed with INTERNAL_API_SECRET; the spectator's client forwards it to the game server
 * (`spectator_gift`), which verifies it and broadcasts the animation — the server never trusts a bare claim.
 */
type AppEnv = { Bindings: Env; Variables: { user: AuthUserPayload } };
export const giftsRouter = new Hono<AppEnv>();

const nowSec = () => Math.floor(Date.now() / 1000);

async function giftToken(env: Env, g: { id: string; code: GiftCode; senderId: string; senderName: string; receiverId: string | null; roomId: string; receiverMicroUsd: number }) {
  return signGameToken(env.INTERNAL_API_SECRET, {
    k: 'gift',
    gid: g.id,
    gc: g.code,
    suid: g.senderId,
    sun: g.senderName,
    tuid: g.receiverId || undefined,
    rid: g.roomId,
    rv: g.receiverMicroUsd,
    exp: nowSec() + GIFT_TOKEN_TTL_SECONDS,
  });
}

async function activeGift(env: Env, code: GiftCode): Promise<boolean> {
  try {
    const r = await env.DB.prepare('SELECT is_active FROM spectator_gifts WHERE code = ?1').bind(code).first<{ is_active: number }>();
    return r ? r.is_active === 1 : true;
  } catch {
    return true;
  }
}

/** The receiver really plays in that room: a live-session report of the room within the last 10 minutes. */
async function receiverInRoom(env: Env, userId: string, roomId: string): Promise<boolean> {
  try {
    const r = await env.DB
      .prepare('SELECT 1 AS ok FROM game_active_sessions WHERE user_id = ?1 AND room_id = ?2 AND heartbeat_at >= ?3 LIMIT 1')
      .bind(userId, roomId, nowSec() - 600)
      .first<{ ok: number }>();
    return !!r;
  } catch {
    return false;
  }
}

giftsRouter.get('/catalog', async (c) => {
  const gifts = Object.values(SPECTATOR_GIFTS).map((g) => ({ ...g, receiverMicroUsd: splitGift(g.priceMicroUsd).receiverMicroUsd }));
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ gifts, receiverPct: 70 });
});

giftsRouter.post('/send', authMiddleware, async (c) => {
  const me = c.get('user');
  const parsed = GiftSendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid gift', code: 'INVALID' }, 400);
  const { giftCode, roomId, receiverUserId, clientRequestId } = parsed.data;
  if (receiverUserId === me.userId) return c.json({ error: 'You cannot send a gift to yourself', code: 'SELF_GIFT' }, 400);

  // Idempotent retry: the same request id returns the same gift (and a fresh token for the same gift id)
  const prior = await c.env.DB
    .prepare("SELECT * FROM gift_transactions WHERE sender_id = ?1 AND client_request_id = ?2 AND status = 'done'")
    .bind(me.userId, clientRequestId)
    .first<any>();
  if (prior) {
    const out: GiftSendResult = {
      success: true,
      duplicate: true,
      giftId: prior.id,
      giftCode: prior.gift_code,
      giftToken: await giftToken(c.env, { id: prior.id, code: prior.gift_code, senderId: me.userId, senderName: me.username, receiverId: prior.receiver_id, roomId: prior.room_id, receiverMicroUsd: prior.receiver_micro_usd }),
      grossMicroUsd: prior.gross_micro_usd,
      receiverMicroUsd: prior.receiver_micro_usd,
      platformMicroUsd: prior.platform_micro_usd,
      balanceMicroUsd: Number(await walletBalance(c.env.DB, me.userId)),
    };
    return c.json(out);
  }
  if (!(await activeGift(c.env, giftCode))) return c.json({ error: 'This gift is not available', code: 'GIFT_OFF' }, 409);
  const receiver = await c.env.DB.prepare("SELECT id, username, status FROM users WHERE id = ?1").bind(receiverUserId).first<{ id: string; username: string; status: string }>();
  if (!receiver || receiver.status === 'banned') return c.json({ error: 'Player not found', code: 'NO_RECEIVER' }, 404);
  if (!(await receiverInRoom(c.env, receiverUserId, roomId))) return c.json({ error: 'That player is not playing in this room', code: 'NOT_IN_ROOM' }, 409);

  const split = splitGift(SPECTATOR_GIFTS[giftCode].priceMicroUsd);
  const bal = Number(await walletBalance(c.env.DB, me.userId));
  if (bal < split.grossMicroUsd) return c.json({ error: 'Not enough C in your wallet', code: 'INSUFFICIENT', balanceMicroUsd: bal }, 402);

  const id = `gft_${crypto.randomUUID()}`;
  const t = nowSec();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO gift_transactions (id, sender_id, receiver_id, room_id, gift_code, gross_micro_usd, receiver_micro_usd, platform_micro_usd, client_request_id, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)`
      ).bind(id, me.userId, receiverUserId, roomId, giftCode, split.grossMicroUsd, split.receiverMicroUsd, split.platformMicroUsd, clientRequestId, t),
      // debit: the wallets CHECK (balance >= 0) aborts the whole batch when the sender cannot cover it
      c.env.DB.prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd - ?1, updated_at = ?2 WHERE user_id = ?3').bind(split.grossMicroUsd, t, me.userId),
      ledgerAfterUpdate(c.env.DB, me.userId, -split.grossMicroUsd, 'GIFT_SEND', id, t),
      c.env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1'
      ).bind(split.receiverMicroUsd, t, receiverUserId),
      ledgerAfterUpdate(c.env.DB, receiverUserId, split.receiverMicroUsd, 'GIFT_RECEIVE', id, t),
      c.env.DB.prepare("UPDATE system_balances SET platform_micro_usd = platform_micro_usd + ?1, updated_at = ?2 WHERE id = 'global' AND changes() = 1").bind(split.platformMicroUsd, t),
      // guard: every step above must have changed exactly one row, otherwise 'conflict' → CHECK → rollback
      c.env.DB.prepare("UPDATE gift_transactions SET status = CASE WHEN changes() = 1 THEN 'done' ELSE 'conflict' END WHERE id = ?1").bind(id),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed/i.test(msg)) return c.json({ error: 'Gift already sent', code: 'DUPLICATE' }, 409);
    if (/CHECK constraint failed/i.test(msg)) return c.json({ error: 'The gift could not be paid (wallet changed) — nothing was charged', code: 'INSUFFICIENT' }, 402);
    throw e;
  }
  const base = `tx_gift_${id.slice(4, 22)}`;
  await logFinancialTransaction(c.env, {
    transaction_id: `${base}_send`,
    user_id: me.userId,
    action_type: 'GIFT_SEND',
    amount_micro_usd: BigInt(split.grossMicroUsd),
    balance_after_micro_usd: await walletBalance(c.env.DB, me.userId),
    source_game_id: `gift:${giftCode}:${roomId}`.slice(0, 64),
    related_user_id: receiverUserId,
  });
  await logFinancialTransaction(c.env, {
    transaction_id: `${base}_recv`,
    user_id: receiverUserId,
    action_type: 'GIFT_RECEIVE',
    amount_micro_usd: BigInt(split.receiverMicroUsd),
    balance_after_micro_usd: await walletBalance(c.env.DB, receiverUserId),
    source_game_id: `gift:${giftCode}:${roomId}`.slice(0, 64),
    related_user_id: me.userId,
  });
  await logFinancialTransaction(c.env, {
    transaction_id: `${base}_fee`,
    user_id: PLATFORM_ACCOUNT_ID,
    action_type: 'GIFT_PLATFORM_FEE',
    amount_micro_usd: BigInt(split.platformMicroUsd),
    balance_after_micro_usd: 0n,
    source_game_id: `gift:${giftCode}:${roomId}`.slice(0, 64),
    related_user_id: me.userId,
  });
  const out: GiftSendResult = {
    success: true,
    giftId: id,
    giftCode,
    giftToken: await giftToken(c.env, { id, code: giftCode, senderId: me.userId, senderName: me.username, receiverId: receiverUserId, roomId, receiverMicroUsd: split.receiverMicroUsd }),
    ...split,
    balanceMicroUsd: Number(await walletBalance(c.env.DB, me.userId)),
  };
  return c.json(out);
});

giftsRouter.post('/ammo-box', authMiddleware, async (c) => {
  const me = c.get('user');
  const parsed = AmmoBoxGiftSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid gift', code: 'INVALID' }, 400);
  const { roomId, adToken } = parsed.data;
  const receiverId = parsed.data.receiverUserId && parsed.data.receiverUserId !== me.userId ? parsed.data.receiverUserId : null;
  const t = nowSec();
  const ad = await c.env.DB
    .prepare("SELECT token, claimed_at FROM ad_click_tokens WHERE token = ?1 AND user_id = ?2 AND status = 'claimed' AND purpose = 'ec_recharge'")
    .bind(adToken, me.userId)
    .first<{ token: string; claimed_at: number | null }>();
  if (!ad || !ad.claimed_at || t - Number(ad.claimed_at) > AMMO_BOX_AD_WINDOW_SECONDS) return c.json({ error: 'Watch an ad first', code: 'NO_AD' }, 402);
  // one Ammo Box per watched ad (UNIQUE ad_token); a retry with the same ad returns the same gift
  const prior = await c.env.DB.prepare('SELECT * FROM gift_transactions WHERE ad_token = ?1').bind(adToken).first<any>();
  let id = prior?.id as string | undefined;
  if (!prior) {
    id = `gft_${crypto.randomUUID()}`;
    try {
      await c.env.DB
        .prepare(
          `INSERT INTO gift_transactions (id, sender_id, receiver_id, room_id, gift_code, gross_micro_usd, receiver_micro_usd, platform_micro_usd, client_request_id, ad_token, status, created_at)
           VALUES (?1, ?2, ?3, ?4, 'ammo_box_ad', 0, 0, 0, ?5, ?5, 'done', ?6)`
        )
        .bind(id, me.userId, receiverId, roomId, adToken, t)
        .run();
    } catch (e) {
      if (!/UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e))) throw e;
      const again = await c.env.DB.prepare('SELECT * FROM gift_transactions WHERE ad_token = ?1').bind(adToken).first<any>();
      if (!again) throw e;
      id = again.id;
    }
  } else if (prior.room_id !== roomId) {
    return c.json({ error: 'This ad already paid for an Ammo Box', code: 'DUPLICATE' }, 409);
  }
  const out: GiftSendResult = {
    success: true,
    duplicate: !!prior,
    giftId: id!,
    giftCode: 'ammo_box_ad',
    giftToken: await giftToken(c.env, { id: id!, code: 'ammo_box_ad', senderId: me.userId, senderName: me.username, receiverId: prior ? prior.receiver_id : receiverId, roomId, receiverMicroUsd: 0 }),
    grossMicroUsd: 0,
    receiverMicroUsd: 0,
    platformMicroUsd: 0,
    balanceMicroUsd: Number(await walletBalance(c.env.DB, me.userId)),
  };
  return c.json(out);
});
