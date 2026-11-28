import { REDIRECT_PLATFORM_FEE_TO_BOSS_DEFAULT, REDIRECT_PLATFORM_FEE_TO_BOSS_KEY } from '@mwar/shared';
import {
  COLD_START_BOT_FILL_KEY,
  COLD_START_TARGET_BOTS_KEY,
  COLD_START_TARGET_BOTS_DEFAULT,
  COLD_START_TARGET_BOTS_MIN,
  COLD_START_TARGET_BOTS_MAX,
  HAPPY_HOUR_ENABLED_KEY,
  HAPPY_HOUR_SCHEDULE_KEY,
  HAPPY_HOUR_MULTIPLIER,
  STREAMER_SHARE_PCT_KEY,
  STREAMER_SHARE_PCT_DEFAULT,
  STREAMER_SHARE_PCT_MIN,
  STREAMER_SHARE_PCT_MAX,
  SKIN_MARKET_FEE_PCT_KEY,
  clampSkinFeePct,
  parseHappyHourSchedule,
  happyHourWindow,
  minuteToHhmm,
  type LiveConfigResponse,
} from '@mwar/shared';
import type { Env } from '../types';

/**
 * V1.2 economy switches persisted in D1 (`platform_settings`, migration 0026). Changes are made by
 * super_admin in /admin → Ad Networks (PUT /api/admin/ads/economy) and written to staff_audit_log.
 */
export interface SettingRow {
  value: string;
  updated_at: number | null;
  updated_by: string | null;
}

export async function readSetting(env: Env, key: string): Promise<SettingRow | null> {
  try {
    return await env.DB.prepare('SELECT value, updated_at, updated_by FROM platform_settings WHERE key = ?1').bind(key).first<SettingRow>();
  } catch {
    return null; // table missing before migration 0026
  }
}

/** The 5 % platform fee of every 55/15/5/5/20 split goes to the Boss Bounty Pool (launch default: true). */
export async function redirectPlatformFeeToBoss(env: Env): Promise<boolean> {
  const r = await readSetting(env, REDIRECT_PLATFORM_FEE_TO_BOSS_KEY);
  if (!r) return REDIRECT_PLATFORM_FEE_TO_BOSS_DEFAULT;
  return r.value === '1' || r.value === 'true';
}

// ---- V1.2 Round C: cold-start / live-economy settings (migration 0027 defaults) ------------------------------

const LIVE_KEYS = [COLD_START_BOT_FILL_KEY, COLD_START_TARGET_BOTS_KEY, HAPPY_HOUR_ENABLED_KEY, HAPPY_HOUR_SCHEDULE_KEY, STREAMER_SHARE_PCT_KEY, SKIN_MARKET_FEE_PCT_KEY];

export async function readSettings(env: Env, keys: string[] = LIVE_KEYS): Promise<Map<string, SettingRow>> {
  const out = new Map<string, SettingRow>();
  try {
    const { results } = await env.DB
      .prepare(`SELECT key, value, updated_at, updated_by FROM platform_settings WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(',')})`)
      .bind(...keys)
      .all<SettingRow & { key: string }>();
    for (const r of results || []) out.set(r.key, r);
  } catch {
    /* table missing before migration 0026 */
  }
  return out;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === '1' || v === 'true');
const intIn = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** Current cold-start / Happy Hour / streamer / skin-fee configuration, with the Happy Hour window evaluated at `nowMs`. */
export async function liveConfig(env: Env, nowMs = Date.now()): Promise<LiveConfigResponse> {
  const s = await readSettings(env);
  const sched = parseHappyHourSchedule(s.get(HAPPY_HOUR_SCHEDULE_KEY)?.value);
  const enabled = bool(s.get(HAPPY_HOUR_ENABLED_KEY)?.value, false);
  const w = happyHourWindow(nowMs, sched);
  return {
    botFill: {
      enabled: bool(s.get(COLD_START_BOT_FILL_KEY)?.value, false),
      targetBots: intIn(s.get(COLD_START_TARGET_BOTS_KEY)?.value, COLD_START_TARGET_BOTS_DEFAULT, COLD_START_TARGET_BOTS_MIN, COLD_START_TARGET_BOTS_MAX),
    },
    happyHour: {
      enabled,
      active: enabled && w.active,
      start: minuteToHhmm(sched.startMinute),
      end: minuteToHhmm(sched.endMinute),
      tzOffsetMinutes: sched.tzOffsetMinutes,
      endsAt: enabled && w.active ? w.endsAtMs : null,
      nextStartAt: w.nextStartMs,
      multiplier: HAPPY_HOUR_MULTIPLIER,
    },
    streamerSharePct: intIn(s.get(STREAMER_SHARE_PCT_KEY)?.value, STREAMER_SHARE_PCT_DEFAULT, STREAMER_SHARE_PCT_MIN, STREAMER_SHARE_PCT_MAX),
    skinMarketFeePct: clampSkinFeePct(s.get(SKIN_MARKET_FEE_PCT_KEY)?.value ?? 10),
    updatedAt: nowMs,
  };
}

/** Write one setting + its staff_audit_log row (same batch). */
export function settingWriteStmts(env: Env, key: string, value: string, before: string | null, actorId: string, t = Math.floor(Date.now() / 1000)) {
  return [
    env.DB.prepare(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`
    ).bind(key, value, t, actorId),
    env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, NULL, 'economy_setting', ?3, ?4, ?5)").bind(
      crypto.randomUUID(),
      actorId,
      `${key}=${before ?? ''}`.slice(0, 500),
      `${key}=${value}`.slice(0, 500),
      t
    ),
  ];
}
