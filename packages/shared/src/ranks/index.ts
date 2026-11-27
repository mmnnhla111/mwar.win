/**
 * Player rank = total network downlines across the 5 MLM levels (network_trees depth 1..5), V1.1.
 * `users.exp` (matches x 20 + kills x 5) is still tracked and shown as a stat, but no longer sets the rank.
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
  /** Total downlines (5 levels) needed to hold this tier. */
  minDownlines: number;
}

const ROMAN = ['I', 'II', 'III'] as const;
const FAMILY_NAMES: Record<RankFamily, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

function tier(family: RankFamily, level: 1 | 2 | 3, minDownlines: number): RankTier {
  return { id: `${family}_${level}`, family, level, name: `${FAMILY_NAMES[family]} ${ROMAN[level - 1]}`, minDownlines };
}

/** The 12-tier ladder, ascending by minDownlines. */
export const RANK_TIERS: readonly RankTier[] = [
  tier('bronze', 1, 0),
  tier('bronze', 2, 3),
  tier('bronze', 3, 10),
  tier('silver', 1, 25),
  tier('silver', 2, 50),
  tier('silver', 3, 100),
  tier('gold', 1, 250),
  tier('gold', 2, 500),
  tier('gold', 3, 1000),
  tier('platinum', 1, 2500),
  tier('platinum', 2, 5000),
  tier('platinum', 3, 10000),
];

export interface RankInfo extends RankTier {
  totalDownlines: number;
  /** Downlines where the next tier starts, null at the top tier. */
  nextMinDownlines: number | null;
  /** 0..1 progress inside the current tier (1 at the top tier). */
  progress: number;
  /** "/assets/ranks/bronze_1.png" */
  image: string;
}

/** The shape exposed by /api/bootstrap (`user.rank`) and the profile endpoints. */
export interface PlayerRankStatus {
  /** Current tier id, name and badge image. */
  id: string;
  name: string;
  image: string;
  family: RankFamily;
  level: 1 | 2 | 3;
  totalDownlines: number;
  nextRank: { id: string; name: string; image: string; minDownlines: number } | null;
  /** Downlines still missing for nextRank (0 at the top tier). */
  downlinesNeeded: number;
  /** 0..1 progress towards nextRank. */
  progress: number;
}

export function rankImagePath(id: string): string {
  return `/assets/ranks/${id}.png`;
}

export function expFromStats(totalMatches: number, totalKills: number): number {
  return Math.max(0, Math.floor(totalMatches || 0)) * EXP_PER_MATCH + Math.max(0, Math.floor(totalKills || 0)) * EXP_PER_KILL;
}

export function getRankForDownlines(downlinesRaw: number): RankInfo {
  const totalDownlines = Math.max(0, Math.floor(Number(downlinesRaw) || 0));
  let idx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) if (totalDownlines >= RANK_TIERS[i].minDownlines) idx = i;
  const cur = RANK_TIERS[idx];
  const next = RANK_TIERS[idx + 1];
  const progress = next ? (totalDownlines - cur.minDownlines) / (next.minDownlines - cur.minDownlines) : 1;
  return { ...cur, totalDownlines, nextMinDownlines: next ? next.minDownlines : null, progress, image: rankImagePath(cur.id) };
}

export function getRankStatus(downlinesRaw: number): PlayerRankStatus {
  const r = getRankForDownlines(downlinesRaw);
  const next = RANK_TIERS[RANK_TIERS.findIndex((x) => x.id === r.id) + 1];
  return {
    id: r.id,
    name: r.name,
    image: r.image,
    family: r.family,
    level: r.level,
    totalDownlines: r.totalDownlines,
    nextRank: next ? { id: next.id, name: next.name, image: rankImagePath(next.id), minDownlines: next.minDownlines } : null,
    downlinesNeeded: next ? Math.max(0, next.minDownlines - r.totalDownlines) : 0,
    progress: r.progress,
  };
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
