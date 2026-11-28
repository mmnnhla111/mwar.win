import { AD_BANNER_MIN_GAP_SECONDS, AD_IDLE_REJECT_MS, MAX_DAILY_BANNER_IMPRESSIONS } from '@mwar/shared';

/** Clock-skew slack for a client timestamp that is slightly in the future. */
const FUTURE_SLACK_MS = 5_000;

/**
 * Anti-AFK check for a banner impression ping. The client sends `lastActiveAt` (ms, its clock) of the
 * most recent real mouse / touch / key input and `clientNow` (ms, same clock), so the idle time is
 * measured on one clock. Without `clientNow` the server clock is used.
 * Returns null when the player was active within 40 s, otherwise the idle time in ms (or -1 if missing).
 */
export function bannerIdleMs(body: { lastActiveAt?: unknown; clientNow?: unknown }, serverNowMs = Date.now()): number | null {
  const last = Number(body?.lastActiveAt);
  if (!Number.isFinite(last) || last <= 0) return -1;
  const cn = Number(body?.clientNow);
  const ref = Number.isFinite(cn) && cn > 0 && Math.abs(cn - serverNowMs) < 24 * 3600_000 ? cn : serverNowMs;
  const idle = ref - last;
  if (idle < -FUTURE_SLACK_MS) return -1;
  return idle > AD_IDLE_REJECT_MS ? idle : null;
}

export const idlePausedBody = (idleMs: number) => ({
  error: 'idle_paused',
  code: 'idle_paused',
  message: idleMs < 0 ? 'lastActiveAt is required' : `No user input for ${Math.round(idleMs / 1000)} s — charging is paused`,
});

export type BannerGateRefusal = { code: 'too_soon'; retryInSeconds: number } | { code: 'daily_cap'; used: number; cap: number };

const utcDay = (nowSec: number) => new Date(nowSec * 1000).toISOString().slice(0, 10);

/**
 * Atomically claims the per-user banner slot in D1: succeeds only if the last accepted banner request
 * was at least count × 28 s ago (V1.1: banner cycles are 30–45 s) AND the user's banner impressions of this
 * UTC day stay within MAX_DAILY_BANNER_IMPRESSIONS (60, V1.2) after this request — one UPDATE, so parallel
 * or scripted pings can never pass either limit. Returns null on success or the refusal.
 */
export async function claimBannerGate(db: D1Database, userId: string, count: number, nowSec = Math.floor(Date.now() / 1000)): Promise<BannerGateRefusal | null> {
  const n = Math.max(1, Math.floor(count));
  const need = n * AD_BANNER_MIN_GAP_SECONDS;
  const day = utcDay(nowSec);
  const res = await db
    .prepare(
      `UPDATE users SET last_banner_at = ?2,
              banner_day_count = CASE WHEN banner_day = ?4 THEN banner_day_count + ?5 ELSE ?5 END,
              banner_day = ?4
       WHERE id = ?1 AND (last_banner_at IS NULL OR ?2 - last_banner_at >= ?3)
         AND (CASE WHEN banner_day = ?4 THEN banner_day_count ELSE 0 END) + ?5 <= ?6`
    )
    .bind(userId, nowSec, need, day, n, MAX_DAILY_BANNER_IMPRESSIONS)
    .run();
  if ((res.meta?.changes ?? 0) === 1) return null;
  const row = await db.prepare('SELECT last_banner_at, banner_day, banner_day_count FROM users WHERE id = ?1').bind(userId).first<{ last_banner_at: number | null; banner_day: string | null; banner_day_count: number | null }>();
  const used = row?.banner_day === day ? Number(row?.banner_day_count || 0) : 0;
  if (used + n > MAX_DAILY_BANNER_IMPRESSIONS) return { code: 'daily_cap', used, cap: MAX_DAILY_BANNER_IMPRESSIONS };
  return { code: 'too_soon', retryInSeconds: Math.max(1, need - (nowSec - Number(row?.last_banner_at || 0))) };
}

/** 429 body of a refused banner request. */
export function bannerGateBody(r: BannerGateRefusal) {
  return r.code === 'daily_cap'
    ? { error: `Daily banner limit reached (${r.cap} per day)`, code: 'banner_daily_cap', used: r.used, cap: r.cap }
    : { error: 'Banner impressions too soon', code: 'too_soon', retryInSeconds: r.retryInSeconds };
}
