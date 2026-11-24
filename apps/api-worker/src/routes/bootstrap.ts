import type { Context } from 'hono';
import { ENERGY_RECHARGE_SECONDS, PROFILE_COVER_IDS, UI_LANG_CODES, formatMicroUsd } from '@mwar/shared';
import type { BootstrapResponse, ProfileCoverColor } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { getUtcDateKey } from './quests';

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
                cover_color, role, status, rank_badge, energy_tickets, max_energy_tickets, last_energy_recharge,
                energy_progress_pct, created_at, show_nsfw, preferred_lang
         FROM users WHERE id = ?1`
      ).bind(me.userId),
      c.env.DB.prepare('SELECT balance_micro_usd, bounty_micro_usd, total_earned_micro_usd FROM wallets WHERE user_id = ?1').bind(me.userId),
      c.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM daily_quest_definitions)
              - (SELECT COUNT(*) FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2 AND is_claimed = 1) AS remaining`
      ).bind(me.userId, dateKey),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM social_notifications WHERE user_id = ?1 AND is_read = 0').bind(me.userId),
    ]),
    c.env.CHAT_DB.prepare('SELECT COUNT(*) AS n FROM direct_messages WHERE receiver_id = ?1 AND is_read = 0')
      .bind(me.userId)
      .first<{ n: number }>()
      .catch(() => ({ n: 0 })),
  ]);

  const u = core[0].results?.[0] as any;
  if (!u || u.status === 'banned') return c.json({ error: 'Unauthorized: account unavailable' }, 401);
  const w = (core[1].results?.[0] || {}) as any;
  const remaining = Math.max(0, Number((core[2].results?.[0] as any)?.remaining ?? 0));
  const unreadNotif = Number((core[3].results?.[0] as any)?.n ?? 0);

  // Energy Ticket hourly recharge (same rule as /api/auth/me); written only when a ticket was gained
  const now = Math.floor(Date.now() / 1000);
  let tickets = u.energy_tickets ?? 6;
  const maxTickets = u.max_energy_tickets ?? 6;
  let last = u.last_energy_recharge || now;
  if (tickets < maxTickets) {
    const gained = Math.floor(Math.max(0, now - last) / ENERGY_RECHARGE_SECONDS);
    if (gained > 0) {
      tickets = Math.min(maxTickets, tickets + gained);
      last = tickets >= maxTickets ? now : last + gained * ENERGY_RECHARGE_SECONDS;
      await c.env.DB.prepare('UPDATE users SET energy_tickets = ?1, last_energy_recharge = ?2 WHERE id = ?3').bind(tickets, last, me.userId).run();
    }
  }

  const body: BootstrapResponse = {
    user: {
      id: u.id,
      username: u.username,
      displayName: u.display_name || null,
      avatarUrl: u.avatar_url || null,
      coverColor: ((PROFILE_COVER_IDS as string[]).includes(u.cover_color) ? u.cover_color : 'lemon') as ProfileCoverColor,
      role: u.role,
      rankBadge: u.rank_badge || null,
      energyTickets: tickets,
      maxEnergyTickets: maxTickets,
      energyProgressPct: u.energy_progress_pct ?? 0,
      secondsToNextRecharge: tickets < maxTickets ? Math.max(0, ENERGY_RECHARGE_SECONDS - (now - last)) : 0,
      createdAt: u.created_at,
      showNsfw: u.show_nsfw === 1,
      preferredLang: (UI_LANG_CODES as readonly string[]).includes(u.preferred_lang) ? u.preferred_lang : 'en',
    },
    walletSummary: {
      balanceMicroUsd: Number(w.balance_micro_usd || 0),
      formattedBalance: formatMicroUsd(w.balance_micro_usd || 0),
      bountyMicroUsd: Number(w.bounty_micro_usd || 0),
      totalEarnedMicroUsd: Number(w.total_earned_micro_usd || 0),
    },
    remainingDailyQuestsCount: remaining,
    unreadNotifCount: unreadNotif,
    unreadChatCount: Number(chat?.n ?? 0),
    dateKey,
    serverTime: now,
  };
  return c.json(body, 200, { 'Cache-Control': 'private, no-store' });
}
