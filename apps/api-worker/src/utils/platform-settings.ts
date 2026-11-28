import { REDIRECT_PLATFORM_FEE_TO_BOSS_DEFAULT, REDIRECT_PLATFORM_FEE_TO_BOSS_KEY } from '@mwar/shared';
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
