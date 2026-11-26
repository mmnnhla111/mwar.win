import { AD_BANNER_MIN_GAP_SECONDS, AD_IDLE_REJECT_MS } from '@mwar/shared';

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

/**
 * Atomically claims the per-user banner slot in D1: succeeds only if the last accepted banner request
 * was at least count × 18 s ago. Returns null on success or the seconds to wait.
 */
export async function claimBannerGate(db: D1Database, userId: string, count: number, nowSec = Math.floor(Date.now() / 1000)): Promise<number | null> {
  const need = Math.max(1, count) * AD_BANNER_MIN_GAP_SECONDS;
  const res = await db
    .prepare('UPDATE users SET last_banner_at = ?2 WHERE id = ?1 AND (last_banner_at IS NULL OR ?2 - last_banner_at >= ?3)')
    .bind(userId, nowSec, need)
    .run();
  if ((res.meta?.changes ?? 0) === 1) return null;
  const row = await db.prepare('SELECT last_banner_at FROM users WHERE id = ?1').bind(userId).first<{ last_banner_at: number | null }>();
  return Math.max(1, need - (nowSec - Number(row?.last_banner_at || 0)));
}
