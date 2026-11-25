import { z } from 'zod';
import { CHEER_AD_FORMATS, CHEER_TARGET_TYPES } from '../constants';
import type { CheerAdFormat, CheerTargetType } from '../constants';

/** POST /api/ads/cheer/start — open a Cheer ad session for a post, a creator profile, or the EC panel. */
export const CheerStartSchema = z
  .object({
    format: z.enum(CHEER_AD_FORMATS),
    targetType: z.enum(CHEER_TARGET_TYPES),
    targetId: z.string().trim().min(1).max(64).optional().nullable(),
  })
  .refine((v) => v.targetType === 'energy' || !!v.targetId, { message: 'targetId is required', path: ['targetId'] });

/** POST /api/ads/cheer — claim a finished Cheer ad session. */
export const CheerCompleteSchema = z.object({ viewId: z.string().regex(/^cheer_[a-f0-9-]{36}$/) });

export type CheerUnavailableReason = 'daily_cap' | 'cooldown' | 'target_cap' | 'own_content' | 'disabled';

export interface CheerOption {
  format: CheerAdFormat;
  /** EC progress in basis points (10 000 = +1 EC). Banner boost depends on country ad value. */
  ecBp: number;
  durationSeconds: number;
  available: boolean;
  reason?: CheerUnavailableReason;
}

export interface CheerStatus {
  targetType: CheerTargetType;
  targetId: string | null;
  dailyUsed: number;
  dailyCap: number;
  dailyRemaining: number;
  targetUsed: number;
  targetCap: number;
  cooldownSeconds: number;
  /** Seconds until the next cheer is allowed (0 = now). */
  cooldownRemaining: number;
  energyTickets: number;
  maxEnergyTickets: number;
  options: CheerOption[];
}

export interface CheerResult {
  success: true;
  format: CheerAdFormat;
  ecProgressAddedPct: number;
  energyTickets: number;
  maxEnergyTickets: number;
  energyProgressPct: number;
  ticketsAwarded: number;
  cheerCount: number | null;
  status: CheerStatus;
}
