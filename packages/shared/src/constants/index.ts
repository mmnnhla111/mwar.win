/**
 * Core System Constants & Mathematical Specifications
 */

// Micro-USD Currency Constants (Safe BigInt Integer Arithmetic)
export const MICRO_USD_PER_USD = 1_000_000n;
export const MICRO_USD_PER_CENT = 10_000n;
export const COINS_PER_CENT = 100n;
export const MICRO_USD_PER_COIN = 100n; // 1 Coin = 100 Micro-USD ($0.0001 USD)
export const MIN_WITHDRAWAL_MICRO_USD = 10_000_000n; // $10.00 USD minimum withdrawal
export const WITHDRAWAL_BASE_FEE_MICRO_USD = 500_000n; // $0.50 USD transaction fee

// ============================================================================
// 100 % Revenue / Reward Split (owner formula, 2026-11-23) — basis points of V (10,000 = 100 %)
//   75 % earner · 15 % uplines (L1 5 · L2 4 · L3 3 · L4 2 · L5 1) · 5 % earner's head bounty · 5 % platform
//   Missing upline levels and integer rounding remainders roll over to the platform.
// ============================================================================
export const REWARD_SPLIT_TOTAL_BPS = 10_000n;
export const REWARD_EARNER_BPS = 7_500n; // 75 % credited to the shooter / earner
export const REWARD_UPLINE_BPS = {
  1: 500n, // Level 1 (Direct upline): 5 %
  2: 400n, // Level 2: 4 %
  3: 300n, // Level 3: 3 %
  4: 200n, // Level 4: 2 %
  5: 100n, // Level 5: 1 %
} as const; // 15 % total
export const REWARD_BOUNTY_BPS = 500n; // 5 % added to the earner's own head bounty
export const REWARD_PLATFORM_BPS = 500n; // 5 % platform / system fee

// LEGACY (superseded by the split above; kept only for old tooling): Platform Fee = 5%, Net Pool = 95%
export const PLATFORM_FEE_PERCENT = 5n;
export const NET_POOL_PERCENT = 95n;

// Percentage shares of the 95% Net Pool for Levels 1 through 5
export const MLM_LEVEL_RATES = {
  1: 50n, // Level 1 (Direct Sponsor): 50% of Net Pool
  2: 20n, // Level 2: 20% of Net Pool
  3: 15n, // Level 3: 15% of Net Pool
  4: 10n, // Level 4: 10% of Net Pool
  5: 5n,  // Level 5: 5% of Net Pool
} as const;

// 3D Game World Specs
export const GAME_TICK_RATE_HZ = 20;
export const GAME_TICK_INTERVAL_MS = 50; // 50ms per tick
export const CHEST_EVENT_INTERVAL_SEC = 15;
export const CHEST_EVENT_INTERVAL_MS = 15_000;
export const CHEST_REWARD_BASE_MICRO_USD = 50_000n; // $0.05 per chest
export const KILL_REWARD_BASE_MICRO_USD = 100_000n; // $0.10 per kill
export const GAME_BATCH_SYNC_INTERVAL_SEC = 10;
export const GAME_BATCH_SYNC_INTERVAL_MS = 10_000;

// Anti-AFK Timer Thresholds
export const AFK_WARNING_SECONDS = 300; // 5 minutes -> AFK Warning & Captcha
export const AFK_KICK_SECONDS = 1800; // 30 minutes -> Auto Kick & Forfeit round gains

// Marketplace Specs
export const MARKETPLACE_ESCROW_DAYS = 30; // 30 days warranty escrow

// Map Dimensions Matrix
export const MAP_SPECS = {
  MINI_30: {
    id: 'mini_30',
    name: 'Small Outpost (30 Players)',
    maxPlayers: 30,
    sizeX: 240,
    sizeZ: 240,
    buildingDensity: 0.25,
    forestDensity: 0.30,
    openAreaDensity: 0.45,
    chestPointsCount: 15,
    maxSightlineMeters: 80,
  },
  STANDARD_100: {
    id: 'standard_100',
    name: 'Tactical City (100 Players)',
    maxPlayers: 100,
    sizeX: 600,
    sizeZ: 600,
    buildingDensity: 0.35,
    forestDensity: 0.35,
    openAreaDensity: 0.30,
    chestPointsCount: 50,
    maxSightlineMeters: 120,
  },
  WARZONE_LARGE: {
    id: 'warzone_large',
    name: 'Large Warzone (100+ Players)',
    maxPlayers: 150,
    sizeX: 1000,
    sizeZ: 1000,
    buildingDensity: 0.40,
    forestDensity: 0.40,
    openAreaDensity: 0.20,
    chestPointsCount: 100,
    maxSightlineMeters: 200,
  },
} as const;

// Development Mock Values
export const DEV_MOCK_OTP = '123456';
export const DEV_MOCK_TELEGRAM_ID = '999888777';
export const DEV_MOCK_PHONE = '+66812345678';

// Daily Proof-of-Activity & Energy Specs
export const DAILY_QUESTS_REQUIRED_TO_UNLOCK = 4;
/** Energy Ticket cap (EC); 100 % ad progress = +1 EC, up to this many. */
export const MAX_ENERGY_TICKETS = 30;
/** EC granted to a brand-new account. */
export const INITIAL_ENERGY_TICKETS = 1;
export const ENERGY_RECHARGE_SECONDS = 3600; // 1 hour per ticket
export const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024; // 512 KB

// ---- Anti-cheat / audit rules (see docs/ECONOMY_AND_SPEC_AUDIT.md) ----------------------------
/** Q_SPECTATE: 90 s of ghost spectating, reported as 15 s heartbeats. */
export const SPECTATE_QUEST_SECONDS = 90;
export const SPECTATE_HEARTBEAT_SECONDS = 15;
/** Quests a client may self-report via POST /api/quests/progress (everything else is server-tracked). */
export const SELF_REPORTED_QUESTS = ['Q_SPECTATE', 'Q_DAILY_CHECKIN'] as const;
/** Practice/bot EC recharge: a 10-kill round may be claimed at most once per minute. */
export const PRACTICE_ROUND_KILLS = 10;
export const PRACTICE_MIN_ROUND_SECONDS = 60;
export const PRACTICE_EC_PROGRESS_PER_ROUND = 25;
/** EC spent to enter a paid (cash) arena. */
export const EC_COST_PER_PAID_MATCH = 1;
/** Death-drop bounty chest lifetime. */
export const CHEST_LIFETIME_MS = 15_000;
/** Layer 2: headshot ratio above this (after enough hits) flags the account and zeroes rewards. */
export const HEADSHOT_RATIO_FLAG = 0.85;
export const HEADSHOT_MIN_SAMPLE_HITS = 20;
/** Layer 2: chest-collect rate above mean + 3σ of the room destroys the chest with no reward. */
export const CHEST_RATE_SIGMA_LIMIT = 3;
export const CHEST_RATE_MIN_SAMPLE_PLAYERS = 4;
/** Layer 3: same IP / device kills pay 0; the same killer→victim pair pays at most this often per window. */
export const COLLUSION_REPEAT_KILL_LIMIT = 3;
export const COLLUSION_WINDOW_MS = 10 * 60_000;
/** Server-side minimum ms between shots per weapon (fire-rate rate limit, with 20 % tolerance applied). */
export const WEAPON_MIN_SHOT_INTERVAL_MS: Record<string, number> = {
  sniper: 1100,
  ak47: 100,
  m16: 86,
  uzi: 63,
  pistol: 150,
};
/** Log retention: PostgreSQL 90 days then R2; Cloudflare Queue holds up to 14 days; chat 12 months. */
export const LOG_RETENTION_DAYS = 90;
export const QUEUE_RETENTION_SECONDS = 14 * 86_400;
export const CHAT_RETENTION_MONTHS = 12;

// Ad eCPM and Statistical Country Rewards (docs/AD_ECPM_BY_COUNTRY.md)
export * from './adEcpm';

// ---- EC recharge from ads (bot kills give 0 EC / 0 Micro-USD) --------------------------------
/** EC progress is stored in basis points: 10 000 bp = 100 % = +1 Energy Ticket. */
export const EC_PROGRESS_BP_PER_TICKET = 10_000;
/** Passive banner: one verified impression every 20 s while the tab is visible. */
export const AD_BANNER_INTERVAL_SECONDS = 20;
/** Server-side minimum gap between two banner impressions of one user (network slack). */
export const AD_BANNER_MIN_GAP_SECONDS = 18;
/** Rewarded video EC credit: 15 s = +50 % (2 views = 1 EC), 30 s = +100 % (1 view = 1 EC). */
export const AD_VIDEO_EC_BP: Record<'video_15s' | 'video_30s', number> = { video_15s: 5_000, video_30s: 10_000 };
export const AD_VIDEO_SECONDS: Record<'video_5s' | 'video_15s' | 'video_30s', number> = { video_5s: 5, video_15s: 15, video_30s: 30 };
/** Anti-abuse cap on EC-recharge rewarded videos per user per UTC day. */
export const AD_VIDEO_EC_DAILY_CAP = 30;
