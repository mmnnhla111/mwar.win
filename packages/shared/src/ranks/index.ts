/**
 * Player rank tiers by EXP. EXP grows from cumulative paid matches entered and kills:
 * EXP = matches × EXP_PER_MATCH + kills × EXP_PER_KILL (backfilled by migration 0017).
 */
export const EXP_PER_MATCH = 20;
export const EXP_PER_KILL = 5;

export type RankFamily = 'bronze' | 'silver' | 'gold' | 'platinum';

export interface RankTier {
  /** e.g. "bronze_1" — also the image file name under /assets/ranks/ */
  id: string;
  family: RankFamily;
  /** 1..3 */
  level: 1 | 2 | 3;
  /** e.g. "Bronze I" */
  name: string;
  minExp: number;
}

const ROMAN = ['I', 'II', 'III'] as const;
const FAMILY_NAMES: Record<RankFamily, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

function tier(family: RankFamily, level: 1 | 2 | 3, minExp: number): RankTier {
  return { id: `${family}_${level}`, family, level, name: `${FAMILY_NAMES[family]} ${ROMAN[level - 1]}`, minExp };
}

/** Ascending by minExp. */
export const RANK_TIERS: readonly RankTier[] = [
  tier('bronze', 1, 0),
  tier('bronze', 2, 100),
  tier('bronze', 3, 200),
  tier('silver', 1, 300),
  tier('silver', 2, 450),
  tier('silver', 3, 600),
  tier('gold', 1, 900),
  tier('gold', 2, 1200),
  tier('gold', 3, 1600),
  tier('platinum', 1, 2000),
  tier('platinum', 2, 2500),
  tier('platinum', 3, 3000),
];

export interface RankInfo extends RankTier {
  exp: number;
  /** EXP where the next tier starts, null at the top tier. */
  nextMinExp: number | null;
  /** 0..1 progress inside the current tier (1 at the top tier). */
  progress: number;
  /** "/assets/ranks/bronze_1.png" */
  image: string;
}

export function rankImagePath(id: string): string {
  return `/assets/ranks/${id}.png`;
}

export function expFromStats(totalMatches: number, totalKills: number): number {
  return Math.max(0, Math.floor(totalMatches || 0)) * EXP_PER_MATCH + Math.max(0, Math.floor(totalKills || 0)) * EXP_PER_KILL;
}

export function getRankForExp(expRaw: number): RankInfo {
  const exp = Math.max(0, Math.floor(Number(expRaw) || 0));
  let idx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) if (exp >= RANK_TIERS[i].minExp) idx = i;
  const cur = RANK_TIERS[idx];
  const next = RANK_TIERS[idx + 1];
  const progress = next ? (exp - cur.minExp) / (next.minExp - cur.minExp) : 1;
  return { ...cur, exp, nextMinExp: next ? next.minExp : null, progress, image: rankImagePath(cur.id) };
}

// ---- Daily missions (MLM lock) ------------------------------------------------------------------

/** The 5 daily missions, in display order. 4 of 5 unlock the 5-level upline share for the day. */
export const DAILY_MISSION_QUEST_IDS = ['Q_COMMUNITY', 'Q_DAILY_CHECKIN', 'Q_EARN_COINS', 'Q_PLAY_MATCH', 'Q_SPECTATE'] as const;
export type DailyMissionQuestId = (typeof DAILY_MISSION_QUEST_IDS)[number];

export interface DailyMission {
  questId: DailyMissionQuestId | string;
  current: number;
  target: number;
  done: boolean;
  claimed: boolean;
  /** ฿ game coins granted when claimed (never cash). */
  rewardCoins: number;
}

export interface NetworkLockStatus {
  dateKey: string;
  /** ISO time of the next reset (00:00 UTC = 07:00 ICT). */
  resetsAt: string;
  unlocked: boolean;
  completed: number;
  total: number;
  required: number;
  missions: DailyMission[];
  directReferrals: number;
  totalReferrals: number;
}

/** 1 ¢ = 10 000 µUSD. */
export function microUsdToCents(micro: number | bigint | string): number {
  const v = typeof micro === 'bigint' ? micro : BigInt(String(micro || 0).split('.')[0] || '0');
  return Number(v / 10_000n);
}
