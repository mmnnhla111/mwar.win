import type { Context } from 'hono';
import { INITIAL_ENERGY_TICKETS, MAX_ENERGY_TICKETS, PROFILE_COVER_IDS, UI_LANG_CODES, EARNINGS_VISIBILITY, earningsDisplay, formatMicroUsd, normalizeStaffRole, normalizeStaffRoles, primaryStaffRole, getRankStatus, microUsdToCents, DAILY_QUESTS_REQUIRED_TO_UNLOCK } from '@mwar/shared';
import type { BootstrapResponse, ProfileCoverColor } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { getUtcDateKey, ACTIVE_COMPLETED_SQL } from './quests';
import { isEnvSuperAdmin } from '../middleware/staff';

/**
 * GET /api/bootstrap — the whole app shell in ONE request:
 * { user, walletSummary, remainingDailyQuestsCount, unreadNotifCount, unreadChatCount }.
 * core_db is read in a single D1 batch (one round trip, all lookups on primary keys / indexes) and the
 * chat DB in parallel. The web client keeps the result for 60 s, so page switches cost 0 requests.
 */
export async function bootstrapHandler(c: Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>) {
  const me = c.get('user');
  const dateKey = getUtcDateKey();
  const [core, chat] = await Promise.all([
    c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT id, username, display_name, CASE WHEN avatar_url LIKE 'data:%' THEN NULL ELSE avatar_url END AS avatar_url,
                cover_color, role, status, rank_badge, energy_tickets, max_energy_tickets,
                energy_progress_pct, created_at, show_nsfw, preferred_lang, earnings_visibility, staff_role, cover_url,
                COALESCE(exp, 0) AS exp, COALESCE(coins, 0) AS coins
         FROM users WHERE id = ?1`
      ).bind(me.userId),
      c.env.DB.prepare('SELECT balance_micro_usd, bounty_micro_usd, total_earned_micro_usd FROM wallets WHERE user_id = ?1').bind(me.userId),
      c.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM daily_quest_definitions WHERE is_active = 1)
              - (SELECT COUNT(*) FROM user_daily_quests uq JOIN daily_quest_definitions d ON d.quest_id = uq.quest_id AND d.is_active = 1
                  WHERE uq.user_id = ?1 AND uq.date_key = ?2 AND uq.is_claimed = 1) AS remaining,
                (SELECT COUNT(*) FROM daily_quest_definitions WHERE is_active = 1) AS total_missions,
                (${ACTIVE_COMPLETED_SQL}) AS completed`
      ).bind(me.userId, dateKey),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND is_read = 0').bind(me.userId),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN depth = 1 THEN 1 ELSE 0 END), 0) AS direct, COUNT(*) AS total
         FROM network_trees WHERE ancestor_id = ?1 AND depth >= 1`
      ).bind(me.userId),
      c.env.DB.prepare('SELECT role_key FROM user_staff_roles WHERE user_id = ?1').bind(me.userId),
    ]),
    c.env.CHAT_DB.prepare('SELECT COUNT(*) AS n FROM direct_messages WHERE receiver_id = ?1 AND is_read = 0')
      .bind(me.userId)
      .first<{ n: number }>()
      .catch(() => ({ n: 0 })),
  ]);

  const u = core[0].results?.[0] as any;
  if (!u || u.status === 'banned') return c.json({ error: 'Unauthorized: account unavailable' }, 401);
  if (u.status === 'suspended') return c.json({ error: 'This account is suspended. Please contact support.', code: 'SUSPENDED' }, 403);
  const w = (core[1].results?.[0] || {}) as any;
  const remaining = Math.max(0, Number((core[2].results?.[0] as any)?.remaining ?? 0));
  const unreadNotif = Number((core[3].results?.[0] as any)?.n ?? 0);
  const q = (core[2].results?.[0] || {}) as any;
  const net = (core[4].results?.[0] || {}) as any;
  // Rank = total downlines over the 5 levels (network_trees depth 1..5), not EXP
  const rank = getRankStatus(Number(net.total || 0));

  // Every staff role (union): user_staff_roles rows + legacy users.staff_role. Owner lock-out protection:
  // SUPER_ADMIN_USERNAMES are always super_admin (written once, then a no-op). Suspended accounts never get here.
  const roleKeys: string[] = ((core[5].results || []) as any[]).map((r) => String(r.role_key));
  if (u.staff_role) roleKeys.push(u.staff_role);
  if (isEnvSuperAdmin(c.env, u.username)) {
    roleKeys.push('super_admin');
    if (u.staff_role !== 'super_admin') await c.env.DB.prepare("UPDATE users SET staff_role = 'super_admin' WHERE id = ?1").bind(me.userId).run();
  }
  const staffRoles = normalizeStaffRoles(roleKeys);
  const staffRole = primaryStaffRole(staffRoles);

  const now = Math.floor(Date.now() / 1000);
  // EC as stored: no passive / hourly regeneration (spec §7.1). Read-only — bootstrap never writes EC.
  const tickets = u.energy_tickets ?? INITIAL_ENERGY_TICKETS;
  const maxTickets = MAX_ENERGY_TICKETS;
  const balanceMicroUsd = Number(w.balance_micro_usd || 0);
  const balanceCoins = Number((balanceMicroUsd / 100).toFixed(2));
  const formattedCoins = balanceCoins.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const body: BootstrapResponse = {
    user: {
      id: u.id,
      username: u.username,
      displayName: u.display_name || null,
      avatarUrl: u.avatar_url || null,
      coverColor: ((PROFILE_COVER_IDS as string[]).includes(u.cover_color) ? u.cover_color : 'lemon') as ProfileCoverColor,
      role: u.role,
      staffRole,
      staffRoles,
      coverUrl: u.cover_url || null,
      rankBadge: u.rank_badge || null,
      energyTickets: tickets,
      maxEnergyTickets: maxTickets,
      energyProgressPct: u.energy_progress_pct ?? 0,
      createdAt: u.created_at,
      showNsfw: u.show_nsfw === 1,
      preferredLang: (UI_LANG_CODES as readonly string[]).includes(u.preferred_lang) ? u.preferred_lang : 'en',
      earningsVisibility: (EARNINGS_VISIBILITY as readonly string[]).includes(u.earnings_visibility) ? u.earnings_visibility : 'public',
      exp: Number(u.exp || 0),
      rank,
      coins: balanceCoins,
    },
    walletSummary: {
      balanceMicroUsd,
      formattedBalance: formatMicroUsd(balanceMicroUsd),
      balanceCoins,
      formattedCoins,
      bountyMicroUsd: Number(w.bounty_micro_usd || 0),
      totalEarnedMicroUsd: Number(w.total_earned_micro_usd || 0),
      // The sidebar shows the same privacy-applied value the profile shows to everyone
      totalEarnings: earningsDisplay(Number(w.total_earned_micro_usd || 0), u.earnings_visibility),
      balanceCents: microUsdToCents(balanceMicroUsd),
    },
    network: {
      directReferrals: Number(net.direct || 0),
      totalReferrals: Number(net.total || 0),
      unlocked: Number(q.completed || 0) >= DAILY_QUESTS_REQUIRED_TO_UNLOCK,
      completedMissions: Number(q.completed || 0),
      requiredMissions: DAILY_QUESTS_REQUIRED_TO_UNLOCK,
      totalMissions: Number(q.total_missions || 0),
    },
    remainingDailyQuestsCount: remaining,
    unreadNotifCount: unreadNotif,
    unreadChatCount: Number(chat?.n ?? 0),
    dateKey,
    serverTime: now,
  };
  return c.json(body, 200, { 'Cache-Control': 'private, no-store' });
}
