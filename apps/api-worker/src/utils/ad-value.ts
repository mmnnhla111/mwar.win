import type { D1Database } from '@cloudflare/workers-types';
import { getStatisticalAdMicroUsd, type AdFormat, EC_PROGRESS_BP_PER_TICKET, MAX_ENERGY_TICKETS } from '@mwar/shared';
import type { Env } from '../types';
import { logFinancialTransaction } from './audit-logger';

export type AdValueSource = 'network' | 'yesterday_avg' | 'country_ecpm';
export const AD_FORMATS: AdFormat[] = ['banner', 'video_5s', 'video_15s', 'video_30s'];

export function parseAdFormat(v: unknown, fallback: AdFormat = 'video_30s'): AdFormat {
  return AD_FORMATS.includes(v as AdFormat) ? (v as AdFormat) : fallback;
}

/** ISO-3166 alpha-2 from Cloudflare (`request.cf.country`), else 'GLOBAL'. */
export function normalizeCountry(v: unknown): string {
  const code = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : 'GLOBAL';
}

export function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Three-tier ad value (micro-USD, integer):
 *  P1 exact network payout (`reward_usd` / `payout`, in USD) → micro-USD
 *  P2 yesterday's average network payout for the same country + format (D1 ad_impressions)
 *  P3 statistical country eCPM table: round(ecpm_usd / 1000 × 1 000 000)
 */
export async function resolveAdValue(
  db: D1Database,
  opts: { payoutUsd?: number | string | null; country: string; format: AdFormat; now?: Date }
): Promise<{ microUsd: number; source: AdValueSource }> {
  const payout = Number(opts.payoutUsd);
  if (Number.isFinite(payout) && payout > 0 && payout < 100) {
    return { microUsd: Math.max(1, Math.round(payout * 1_000_000)), source: 'network' };
  }
  const yesterday = utcDateKey(new Date((opts.now ?? new Date()).getTime() - 86_400_000));
  try {
    const row = await db
      .prepare(
        `SELECT AVG(amount_micro_usd) AS avg_micro, COUNT(*) AS n FROM ad_impressions
         WHERE date_key = ?1 AND country_code = ?2 AND ad_format = ?3 AND value_source = 'network'`
      )
      .bind(yesterday, opts.country, opts.format)
      .first<{ avg_micro: number | null; n: number }>();
    if (row && row.n > 0 && row.avg_micro && row.avg_micro > 0) {
      return { microUsd: Math.max(1, Math.round(row.avg_micro)), source: 'yesterday_avg' };
    }
  } catch {
    /* table missing before migration 0007: fall through to the statistical table */
  }
  return { microUsd: getStatisticalAdMicroUsd(opts.country, opts.format), source: 'country_ecpm' };
}

/**
 * EC progress (basis points, 10 000 = +1 EC) for one ad event. Rewarded videos are fixed
 * (15 s = 5 000 bp, 30 s = 10 000 bp). A banner earns in proportion to its value against a 30 s
 * rewarded video in the same country (a 30 s video's value = 1 full EC).
 */
export function ecProgressBpFor(format: AdFormat, valueMicroUsd: number, country: string, video30sMicroUsd?: number): number {
  if (format === 'video_30s') return 10_000;
  if (format === 'video_15s') return 5_000;
  // Revenue parity: banner value ÷ 30 s video value from the same pricing tier (TH 350/8 500 = 4.12 %)
  const ref = Math.max(1, video30sMicroUsd ?? getStatisticalAdMicroUsd(country, 'video_30s'));
  return Math.max(1, Math.min(10_000, Math.round((valueMicroUsd / ref) * EC_PROGRESS_BP_PER_TICKET)));
}

export async function logAdImpression(
  db: D1Database,
  row: {
    userId: string;
    provider: string;
    country: string;
    format: AdFormat;
    purpose: 'ec_recharge' | 'monetized';
    microUsd: number;
    source: AdValueSource;
    ecBp?: number;
  },
  /** Batched banner impressions: one row per impression, written in a single D1 batch. */
  count = 1
) {
  const now = Math.floor(Date.now() / 1000);
  const dateKey = utcDateKey();
  const stmt = db.prepare(
    `INSERT INTO ad_impressions (id, user_id, provider, country_code, ad_format, purpose, amount_micro_usd, value_source, ec_progress_bp, date_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
  );
  const ids: string[] = [];
  const n = Math.max(1, Math.floor(count));
  for (let i = 0; i < n; i++) ids.push(`adi_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
  const binds = ids.map((id) => stmt.bind(id, row.userId, row.provider, row.country, row.format, row.purpose, row.microUsd, row.source, row.ecBp ?? 0, dateKey, now));
  if (binds.length === 1) await binds[0].run();
  else await db.batch(binds);
  return ids[0];
}

/**
 * Credit EC progress to the user's real D1 balance. Every 10 000 bp converts into +1 Energy
 * Ticket (up to MAX_ENERGY_TICKETS = 300). When tickets are already full the progress bar stays capped below 100 %.
 */
export async function creditEcProgress(env: Env, userId: string, addBp: number, sourceId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const u = await env.DB
      .prepare('SELECT energy_tickets, max_energy_tickets, energy_progress_bp FROM users WHERE id = ?1')
      .bind(userId)
      .first<{ energy_tickets: number | null; max_energy_tickets: number | null; energy_progress_bp: number | null }>();
    if (!u) return null;
    const maxTickets = Math.min(u.max_energy_tickets ?? MAX_ENERGY_TICKETS, MAX_ENERGY_TICKETS);
    const prevBp = u.energy_progress_bp ?? 0;
    let tickets = u.energy_tickets ?? MAX_ENERGY_TICKETS;
    let bp = prevBp + Math.max(0, Math.round(addBp));
    let ticketsAwarded = 0;
    while (bp >= EC_PROGRESS_BP_PER_TICKET && tickets < maxTickets) {
      bp -= EC_PROGRESS_BP_PER_TICKET;
      tickets += 1;
      ticketsAwarded += 1;
    }
    if (tickets >= maxTickets) bp = Math.min(bp, EC_PROGRESS_BP_PER_TICKET - 1);
    const res = await env.DB
      .prepare(
        `UPDATE users SET energy_tickets = ?1, energy_progress_bp = ?2, energy_progress_pct = ?3
         WHERE id = ?4 AND energy_progress_bp = ?5 AND COALESCE(energy_tickets, ?6) = ?7`
      )
      .bind(tickets, bp, Math.floor(bp / 100), userId, prevBp, MAX_ENERGY_TICKETS, u.energy_tickets ?? MAX_ENERGY_TICKETS)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) continue; // concurrent update: re-read and retry
    await logFinancialTransaction(env, {
      id: 0,
      transaction_id: `ec_ad_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      user_id: userId,
      action_type: 'AD_EC_RECHARGE',
      amount_micro_usd: 0n,
      balance_after_micro_usd: 0n,
      source_game_id: `${sourceId}:+${addBp}bp:t${tickets}`,
      created_at: new Date().toISOString(),
    });
    return { energyTickets: tickets, maxEnergyTickets: maxTickets, energyProgressBp: bp, energyProgressPct: bp / 100, ticketsAwarded, full: tickets >= maxTickets };
  }
  throw new Error('EC progress update conflicted, try again');
}
