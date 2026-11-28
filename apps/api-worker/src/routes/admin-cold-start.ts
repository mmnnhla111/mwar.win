import { Hono } from 'hono';
import {
  COLD_START_BOT_FILL_KEY,
  COLD_START_TARGET_BOTS_KEY,
  ColdStartSettingsSchema,
  HAPPY_HOUR_ENABLED_KEY,
  HAPPY_HOUR_SCHEDULE_KEY,
  MarketingDepositSchema,
  PromoCodeCreateSchema,
  SKIN_MARKET_FEE_PCT_KEY,
  STREAMER_SHARE_PCT_KEY,
  hhmmToMinute,
  serializeHappyHourSchedule,
  staffCanAny,
  type ColdStartAdminStatus,
  type PromoCodeRow,
} from '@mwar/shared';
import { z } from 'zod';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getStaffRoles, requireStaff } from '../middleware/staff';
import { liveConfig, readSettings, settingWriteStmts } from '../utils/platform-settings';
import { logFinancialTransaction } from '../utils/audit-logger';

/**
 * /api/admin/cold-start — V1.2 C cold-start tools in /admin → Game & Rooms (super_admin / ops_manager):
 *   GET   /                     settings (bot fill, Happy Hour, streamer share, skin fee) + pools + promo codes
 *   PUT   /settings             partial update; every changed key is written to platform_settings + staff_audit_log
 *   POST  /marketing-deposit    { amountMicroUsd, note } — company money INTO the marketing pool (super_admin only)
 *   POST  /promo-codes          create a launch code (≤ 500 redemptions); an optional deposit in the same batch
 *   PATCH /promo-codes/:code    { isActive }
 */
type AppEnv = { Bindings: Env; Variables: { user: AuthUserPayload } };
export const adminColdStartRouter = new Hono<AppEnv>();
adminColdStartRouter.use('*', authMiddleware);
adminColdStartRouter.use('*', requireStaff('coldStart'));
const nowSec = () => Math.floor(Date.now() / 1000);

const rowToPromo = (r: any): PromoCodeRow => ({
  code: r.code,
  backedMicroUsdPerTicket: Number(r.backed_micro_usd_per_ticket) || 0,
  maxRedemptions: Number(r.max_redemptions) || 0,
  redeemedCount: Number(r.redeemed_count) || 0,
  expiresAt: r.expires_at ?? null,
  isActive: r.is_active === 1,
  createdBy: r.created_by,
  createdAt: Number(r.created_at) || 0,
});

async function status(env: Env): Promise<ColdStartAdminStatus> {
  const [sys, bots, codes] = await env.DB.batch([
    env.DB.prepare("SELECT boss_bounty_pool_micro_usd AS boss, marketing_pool_micro_usd AS mk FROM system_balances WHERE id = 'global'"),
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_micro_usd), 0) AS v FROM bot_bounty_reservations WHERE status = 'reserved'"),
    env.DB.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 100'),
  ]);
  const s = (sys.results?.[0] || {}) as any;
  const b = (bots.results?.[0] || {}) as any;
  return {
    settings: await liveConfig(env),
    pools: { bossBountyPoolMicroUsd: Number(s.boss || 0), marketingPoolMicroUsd: Number(s.mk || 0), botReservedMicroUsd: Number(b.v || 0), botReservedCount: Number(b.n || 0) },
    promoCodes: (codes.results || []).map(rowToPromo),
  };
}

adminColdStartRouter.get('/', async (c) => c.json(await status(c.env)));

adminColdStartRouter.put('/settings', async (c) => {
  const me = c.get('user');
  const parsed = ColdStartSettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid settings' }, 400);
  const d = parsed.data;
  const cur = await liveConfig(c.env);
  const before = await readSettings(c.env);
  const want = new Map<string, string>();
  if (d.botFillEnabled !== undefined) want.set(COLD_START_BOT_FILL_KEY, d.botFillEnabled ? '1' : '0');
  if (d.targetBots !== undefined) want.set(COLD_START_TARGET_BOTS_KEY, String(d.targetBots));
  if (d.happyHourEnabled !== undefined) want.set(HAPPY_HOUR_ENABLED_KEY, d.happyHourEnabled ? '1' : '0');
  if (d.happyHourStart !== undefined || d.happyHourEnd !== undefined || d.happyHourTzOffsetMinutes !== undefined) {
    const start = hhmmToMinute(d.happyHourStart ?? cur.happyHour.start)!;
    const end = hhmmToMinute(d.happyHourEnd ?? cur.happyHour.end)!;
    if (start === end) return c.json({ error: 'Happy Hour start and end must differ' }, 400);
    want.set(HAPPY_HOUR_SCHEDULE_KEY, serializeHappyHourSchedule({ startMinute: start, endMinute: end, tzOffsetMinutes: d.happyHourTzOffsetMinutes ?? cur.happyHour.tzOffsetMinutes }));
  }
  if (d.streamerSharePct !== undefined) want.set(STREAMER_SHARE_PCT_KEY, String(d.streamerSharePct));
  if (d.skinMarketFeePct !== undefined) want.set(SKIN_MARKET_FEE_PCT_KEY, String(d.skinMarketFeePct));
  const t = nowSec();
  const stmts = [...want.entries()]
    .filter(([k, v]) => before.get(k)?.value !== v)
    .flatMap(([k, v]) => settingWriteStmts(c.env, k, v, before.get(k)?.value ?? null, me.userId, t));
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ success: true, changed: stmts.length / 2, ...(await status(c.env)) });
});

async function canDeposit(c: any): Promise<boolean> {
  return staffCanAny(await getStaffRoles(c), 'marketingDeposit');
}

adminColdStartRouter.post('/marketing-deposit', async (c) => {
  const me = c.get('user');
  if (!(await canDeposit(c))) return c.json({ error: 'Only super_admin can deposit company money', code: 'FORBIDDEN' }, 403);
  const parsed = MarketingDepositSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid amount' }, 400);
  const t = nowSec();
  const x = parsed.data.amountMicroUsd;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE system_balances SET marketing_pool_micro_usd = marketing_pool_micro_usd + ?1, updated_at = ?2 WHERE id = 'global'").bind(x, t),
    c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, NULL, 'marketing_deposit', NULL, ?3, ?4)").bind(
      crypto.randomUUID(),
      me.userId,
      `+${x} µUSD${parsed.data.note ? ` · ${parsed.data.note}` : ''}`.slice(0, 500),
      t
    ),
  ]);
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_mkt_dep_${t}_${crypto.randomUUID().slice(0, 8)}`,
    user_id: me.userId,
    action_type: 'MARKETING_POOL_DEPOSIT',
    amount_micro_usd: BigInt(x),
    balance_after_micro_usd: 0n,
    source_game_id: 'marketing_pool',
  });
  return c.json({ success: true, ...(await status(c.env)) });
});

adminColdStartRouter.post('/promo-codes', async (c) => {
  const me = c.get('user');
  const parsed = PromoCodeCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid promo code' }, 400);
  const d = parsed.data;
  if (d.depositMicroUsd > 0 && !(await canDeposit(c))) return c.json({ error: 'Only super_admin can deposit company money', code: 'FORBIDDEN' }, 403);
  const t = nowSec();
  if (d.expiresAt && d.expiresAt <= t) return c.json({ error: 'The expiry must be in the future' }, 400);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO promo_codes (code, backed_micro_usd_per_ticket, max_redemptions, redeemed_count, expires_at, is_active, created_by, created_at) VALUES (?1, ?2, ?3, 0, ?4, 1, ?5, ?6)'
      ).bind(d.code, d.backedMicroUsdPerTicket, d.maxRedemptions, d.expiresAt ?? null, me.userId, t),
      ...(d.depositMicroUsd > 0
        ? [c.env.DB.prepare("UPDATE system_balances SET marketing_pool_micro_usd = marketing_pool_micro_usd + ?1, updated_at = ?2 WHERE id = 'global'").bind(d.depositMicroUsd, t)]
        : []),
      c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, ?3, 'promo_code_create', NULL, ?4, ?5)").bind(
        crypto.randomUUID(),
        me.userId,
        d.code,
        JSON.stringify({ backed: d.backedMicroUsdPerTicket, max: d.maxRedemptions, expiresAt: d.expiresAt ?? null, deposit: d.depositMicroUsd }),
        t
      ),
    ]);
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY/i.test(String((e as Error)?.message ?? e))) return c.json({ error: 'This code already exists', code: 'DUPLICATE' }, 409);
    throw e;
  }
  if (d.depositMicroUsd > 0) {
    await logFinancialTransaction(c.env, {
      transaction_id: `tx_mkt_dep_${t}_${crypto.randomUUID().slice(0, 8)}`,
      user_id: me.userId,
      action_type: 'MARKETING_POOL_DEPOSIT',
      amount_micro_usd: BigInt(d.depositMicroUsd),
      balance_after_micro_usd: 0n,
      source_game_id: `promo:${d.code}`,
    });
  }
  return c.json({ success: true, ...(await status(c.env)) });
});

adminColdStartRouter.patch('/promo-codes/:code', async (c) => {
  const me = c.get('user');
  const code = c.req.param('code').toUpperCase();
  const parsed = z.object({ isActive: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'isActive (boolean) is required' }, 400);
  const t = nowSec();
  const res = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE promo_codes SET is_active = ?2 WHERE code = ?1').bind(code, parsed.data.isActive ? 1 : 0),
    c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) SELECT ?1, ?2, ?3, 'promo_code_active', NULL, ?4, ?5 WHERE changes() = 1").bind(
      crypto.randomUUID(),
      me.userId,
      code,
      parsed.data.isActive ? '1' : '0',
      t
    ),
  ]);
  if ((res[0].meta?.changes ?? 0) !== 1) return c.json({ error: 'Code not found' }, 404);
  return c.json({ success: true, ...(await status(c.env)) });
});
