import { Hono } from 'hono';
import {
  MAX_ENERGY_TICKETS,
  PROMO_MAX_REDEMPTIONS,
  PromoRedeemSchema,
  promoRedemptionDecision,
  type PromoRefusal,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction } from '../utils/audit-logger';
import { reconcileTicketRowsStmt } from '../utils/energy-tickets';
import { recordDeviceLink } from '../utils/ledger';

/**
 * /api/promo — V1.2 C launch promo codes (e.g. MWAR500), created by staff in /admin → Game & Rooms.
 *   POST /redeem { code, deviceFp } — 1 redemption per user AND per device fingerprint, at most 500 per code. Each
 *   mints ONE Energy Ticket backed by the code's µUSD (default 100 C), drawn from system_balances.marketing_pool
 *   in the SAME D1 batch, only if the pool still holds it (fails cleanly with POOL_EMPTY otherwise).
 */
type AppEnv = { Bindings: Env; Variables: { user: AuthUserPayload } };
export const promoRouter = new Hono<AppEnv>();
const nowSec = () => Math.floor(Date.now() / 1000);

const MESSAGES: Record<PromoRefusal, [number, string]> = {
  inactive: [404, 'This code is not valid'],
  expired: [410, 'This code has expired'],
  cap: [410, 'This code has been fully redeemed'],
  user: [409, 'You already used this code'],
  device: [409, 'This code was already used on this device'],
  pool_empty: [409, 'The promotion budget is used up — try again later'],
  ec_full: [409, 'Your Energy Tickets are full'],
};
const refuse = (reason: PromoRefusal) => ({ status: MESSAGES[reason][0], body: { error: MESSAGES[reason][1], code: `PROMO_${reason.toUpperCase()}`, reason } });

promoRouter.post('/redeem', authMiddleware, async (c) => {
  const me = c.get('user');
  const parsed = PromoRedeemSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Enter a valid code', code: 'INVALID' }, 400);
  const { code, deviceFp } = parsed.data;
  const t = nowSec();
  const row = await c.env.DB.prepare('SELECT * FROM promo_codes WHERE code = ?1').bind(code).first<any>();
  if (!row) {
    const r = refuse('inactive');
    return c.json(r.body, r.status as 404);
  }
  await reconcileTicketRowsStmt(c.env.DB, me.userId, t).run();
  const [u, d, pool, tk] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT 1 AS ok FROM promo_redemptions WHERE code = ?1 AND user_id = ?2').bind(code, me.userId),
    c.env.DB.prepare('SELECT 1 AS ok FROM promo_redemptions WHERE code = ?1 AND device_fp = ?2').bind(code, deviceFp),
    c.env.DB.prepare("SELECT marketing_pool_micro_usd AS m FROM system_balances WHERE id = 'global'"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available'").bind(me.userId),
  ]);
  const backed = Math.max(0, Number(row.backed_micro_usd_per_ticket) || 0);
  const decision = promoRedemptionDecision({
    isActive: row.is_active === 1,
    expiresAt: row.expires_at ?? null,
    nowSec: t,
    redeemedCount: Number(row.redeemed_count) || 0,
    maxRedemptions: Number(row.max_redemptions) || PROMO_MAX_REDEMPTIONS,
    userAlreadyRedeemed: !!u.results?.length,
    deviceAlreadyRedeemed: !!d.results?.length,
    marketingPoolMicroUsd: Number((pool.results?.[0] as any)?.m ?? 0),
    backedMicroUsd: backed,
    ticketsFull: Number((tk.results?.[0] as any)?.n ?? 0) >= MAX_ENERGY_TICKETS,
  });
  if (!decision.ok) {
    const r = refuse(decision.reason);
    return c.json(r.body, r.status as 409);
  }

  const ticketId = `tkt_${crypto.randomUUID()}`;
  try {
    await c.env.DB.batch([
      // 1 per user (PRIMARY KEY) and 1 per device (UNIQUE) — a duplicate throws and rolls everything back
      c.env.DB.prepare("INSERT INTO promo_redemptions (code, user_id, device_fp, ticket_id, backed_micro_usd, status, redeemed_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)").bind(code, me.userId, deviceFp, ticketId, backed, t),
      // the cap (≤ 500, ≤ max_redemptions), active + not expired
      c.env.DB.prepare(
        'UPDATE promo_codes SET redeemed_count = redeemed_count + 1 WHERE code = ?1 AND is_active = 1 AND (expires_at IS NULL OR expires_at > ?2) AND redeemed_count < MIN(max_redemptions, ?3)'
      ).bind(code, t, PROMO_MAX_REDEMPTIONS),
      // the backing leaves the marketing pool only if it still holds it
      c.env.DB.prepare("UPDATE system_balances SET marketing_pool_micro_usd = marketing_pool_micro_usd - ?1, updated_at = ?2 WHERE id = 'global' AND marketing_pool_micro_usd >= ?1 AND changes() = 1").bind(backed, t),
      c.env.DB.prepare(
        "INSERT INTO user_energy_tickets (id, user_id, source_type, country_code, backed_micro_usd, status, created_at) SELECT ?1, ?2, 'signup_promo', 'GLOBAL', ?3, 'available', ?4 WHERE changes() = 1"
      ).bind(ticketId, me.userId, backed, t),
      c.env.DB.prepare("UPDATE users SET energy_tickets = (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available') WHERE id = ?1 AND changes() = 1").bind(me.userId),
      // guard: any step that changed no row → 'conflict' → CHECK → the whole batch rolls back
      c.env.DB.prepare("UPDATE promo_redemptions SET status = CASE WHEN changes() = 1 THEN 'done' ELSE 'conflict' END WHERE code = ?1 AND user_id = ?2").bind(code, me.userId),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed: promo_redemptions\.code, promo_redemptions\.device_fp|idx_promo_redemptions_device/i.test(msg)) {
      const r = refuse('device');
      return c.json(r.body, r.status as 409);
    }
    if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
      const r = refuse('user');
      return c.json(r.body, r.status as 409);
    }
    if (/CHECK constraint failed/i.test(msg)) {
      // the cap, the pool or the code changed under us: re-read for the precise reason
      const now = await c.env.DB.prepare('SELECT redeemed_count, max_redemptions, is_active FROM promo_codes WHERE code = ?1').bind(code).first<any>();
      const p = await c.env.DB.prepare("SELECT marketing_pool_micro_usd AS m FROM system_balances WHERE id = 'global'").first<any>();
      const reason: PromoRefusal = !now || now.is_active !== 1 ? 'inactive' : Number(now.redeemed_count) >= Math.min(Number(now.max_redemptions), PROMO_MAX_REDEMPTIONS) ? 'cap' : Number(p?.m ?? 0) < backed ? 'pool_empty' : 'cap';
      const r = refuse(reason);
      return c.json(r.body, r.status as 409);
    }
    throw e;
  }
  c.executionCtx.waitUntil(recordDeviceLink(c.env.DB, c.env.JWT_SECRET, me.userId, c.req.header('CF-Connecting-IP'), deviceFp));
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_promo_${ticketId.slice(4, 22)}`,
    user_id: me.userId,
    action_type: 'PROMO_REDEEM',
    amount_micro_usd: BigInt(backed),
    balance_after_micro_usd: 0n,
    source_game_id: `promo:${code}`.slice(0, 64),
  });
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_mint_${ticketId.slice(4, 22)}`,
    user_id: me.userId,
    action_type: 'TICKET_MINT',
    amount_micro_usd: BigInt(backed),
    balance_after_micro_usd: 0n,
    source_game_id: ticketId.slice(0, 64),
  });
  const left = await c.env.DB.prepare('SELECT energy_tickets FROM users WHERE id = ?1').bind(me.userId).first<{ energy_tickets: number }>();
  return c.json({ success: true, code, ticketId, ticketMicroUsd: backed, energyTickets: Number(left?.energy_tickets ?? 0) });
});
