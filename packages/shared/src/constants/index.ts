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
// 100 % Revenue / Reward Split (owner formula, 2026-11-25) — basis points of V (10,000 = 100 %)
//   55 % earner · 15 % uplines (L1 5 · L2 4 · L3 3 · L4 2 · L5 1) · 5 % earner's head bounty · 5 % platform
//   · 20 % Energy Recharge Reserve Pool (backs EC recharges from ads and cheers)
//   Missing upline levels and integer rounding remainders roll over to the platform.
// ============================================================================
export const REWARD_SPLIT_TOTAL_BPS = 10_000n;
export const REWARD_EARNER_BPS = 5_500n; // 55 % credited to the shooter / earner
export const REWARD_UPLINE_BPS = {
  1: 500n, // Level 1 (Direct upline): 5 %
  2: 400n, // Level 2: 4 %
  3: 300n, // Level 3: 3 %
  4: 200n, // Level 4: 2 %
  5: 100n, // Level 5: 1 %
} as const; // 15 % total
export const REWARD_BOUNTY_BPS = 500n; // 5 % added to the earner's own head bounty
export const REWARD_PLATFORM_BPS = 500n; // 5 % platform / system fee
export const REWARD_ENERGY_POOL_BPS = 2_000n; // 20 % Energy Recharge Reserve Pool (system_balances.energy_pool_micro_usd)

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
// V1.1 (zero-deficit): there is NO fixed kill / chest reward any more. A kill (or the opening of a
// suicide / environmental-death chest) pays exactly the victim's Energy Ticket value
// (user_energy_tickets.backed_micro_usd — real ad revenue after the safety haircut), split 55/15/5/5/20.
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
export const MAX_ENERGY_TICKETS = 300;
/**
 * EC granted to a brand-new account. After sign-up EC comes ONLY from verified ads (rewarded video,
 * banner impressions, Cheer) or an admin adjustment — there is no passive / hourly regeneration.
 */
export const INITIAL_ENERGY_TICKETS = 1;
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
/** Direct messages are purged once older than this (365 days). */
export const CHAT_RETENTION_SECONDS = 31_536_000;
/** Expired oauth_states / ad_click_tokens rows are pruned after 7 days. */
export const SHORT_LIVED_ROW_RETENTION_SECONDS = 7 * 86_400;

// Ad eCPM and Statistical Country Rewards (docs/AD_ECPM_BY_COUNTRY.md)
export * from './adEcpm';

// ---- EC recharge from ads (bot kills give 0 EC / 0 Micro-USD) --------------------------------
/** EC progress is stored in basis points: 10 000 bp = 100 % = +1 Energy Ticket. */
export const EC_PROGRESS_BP_PER_TICKET = 10_000;
/**
 * Passive banner (V1.1): one verified impression per randomized 30–45 s cycle while the tab is visible
 * (`nextBannerIntervalSeconds()`, re-randomized after every completed cycle).
 */
export const AD_BANNER_INTERVAL_MIN_SECONDS = 30;
export const AD_BANNER_INTERVAL_MAX_SECONDS = 45;
/** Server-side minimum gap between two banner impressions of one user (network slack under the 30 s floor). */
export const AD_BANNER_MIN_GAP_SECONDS = 28;
/** A random banner cycle length in whole seconds: Math.floor(30 + rand × 16) → 30..45. */
export function nextBannerIntervalSeconds(rand: () => number = Math.random): number {
  const r = Math.min(0.999999, Math.max(0, Number(rand()) || 0));
  return Math.floor(AD_BANNER_INTERVAL_MIN_SECONDS + r * (AD_BANNER_INTERVAL_MAX_SECONDS - AD_BANNER_INTERVAL_MIN_SECONDS + 1));
}
/** Anti-AFK: charging screens pause after this long without mouse / touch / key input (or a hidden tab). */
export const AD_IDLE_PAUSE_MS = 35_000;
/** Anti-AFK: the API rejects a banner ping whose last verified input is older than this (400 idle_paused). */
export const AD_IDLE_REJECT_MS = 40_000;
/** Rewarded video EC credit: 15 s = +50 % (2 views = 1 EC), 30 s = +100 % (1 view = 1 EC). */
export const AD_VIDEO_EC_BP: Record<'video_15s' | 'video_30s', number> = { video_15s: 5_000, video_30s: 10_000 };
export const AD_VIDEO_SECONDS: Record<'video_5s' | 'video_15s' | 'video_30s', number> = { video_5s: 5, video_15s: 15, video_30s: 30 };
/** Anti-abuse cap on EC-recharge rewarded videos per user per UTC day. */
export const AD_VIDEO_EC_DAILY_CAP = 30;

// ---- "ให้กำลังใจ" Cheer (support a post / creator by watching an ad) ---------------------------
/** Cheer ad formats: 30 s video = +1 EC, 15 s video = +50 % EC, sponsored banner boost = banner parity. */
export const CHEER_AD_FORMATS = ['video_30s', 'video_15s', 'banner'] as const;
export type CheerAdFormat = (typeof CHEER_AD_FORMATS)[number];
/** Seconds a sponsored banner boost must stay on screen before it can be claimed. */
export const CHEER_BANNER_SECONDS = 10;
/** Minimum seconds between two completed cheers of one user. */
export const CHEER_COOLDOWN_SECONDS = 45;
/** Completed cheers per user per UTC day. */
export const CHEER_DAILY_CAP = 15;
/** Cheers from one user to the same creator (any of their posts or profile) per UTC day. */
export const CHEER_PER_TARGET_DAILY_CAP = 3;
export const CHEER_TARGET_TYPES = ['post', 'profile', 'energy'] as const;
export type CheerTargetType = (typeof CHEER_TARGET_TYPES)[number];

// ---- V1.1 zero-deficit ticket-backed economy ------------------------------------------------------
/** Energy Ticket sources (user_energy_tickets.source_type). */
export const ENERGY_TICKET_SOURCES = ['ad_charge', 'cheer_pool', 'signup_promo', 'admin_grant'] as const;
export type EnergyTicketSource = (typeof ENERGY_TICKET_SOURCES)[number];
export const ENERGY_TICKET_STATUSES = ['available', 'in_match', 'settled'] as const;
export type EnergyTicketStatus = (typeof ENERGY_TICKET_STATUSES)[number];
/** An in_match ticket nobody settled (game server crash) is forfeited to the platform after this long. */
export const STALE_MATCH_TICKET_SECONDS = 6 * 3600;
/**
 * Conservative ad safety haircut, in basis points of gross ad revenue: default 92 % (−8 %), always
 * clamped to 90 %–95 % (−10 % … −5 %) so a ticket can never be worth more than the ad that backs it.
 */
export const AD_SAFETY_MULTIPLIER_DEFAULT_BP = 9_200;
export const AD_SAFETY_MULTIPLIER_MIN_BP = 9_000;
export const AD_SAFETY_MULTIPLIER_MAX_BP = 9_500;
/** Rounding rule for C (1 C = 100 µUSD, 0.01 C = 1 µUSD): a fraction ≥ 0.7 µUSD (0.007 C) rounds up. */
export const COIN_ROUND_UP_FRACTION = 0.7;


// ---- V1.1 Round 2: Paid-EC death prompt · Fast & Mini 90/10 · offline room hiding --------------
/**
 * Fast & Mini (free, 0 EC): a kill pays the VICTIM's own banner pot — the safe (after-haircut) value of
 * the banner impressions that victim's account had verified during this life — split 90 % shooter /
 * 10 % platform (no uplines, no head bounty, no Energy Pool).
 */
export const FAST_MINI_SHOOTER_BPS = 9_000n;
export const FAST_MINI_PLATFORM_BPS = 1_000n;
/**
 * The same µUSD is never used twice: a Fast & Mini banner impression's safe value S is split ONCE into
 *   pot  = floor(S × 50 %)  → the player's Fast & Mini pot (a killer wins 90 % of it, the platform 10 %)
 *   EC   = S − pot          → normal EC backing (pending_ec_micro_usd); the EC % credited is scaled the same way
 * so pot + EC backing === S exactly (see splitFastMiniBanner).
 */
export const FAST_MINI_BANNER_POT_BP = 5_000;
/** A Fast & Mini pot nobody closed (game-server crash) is closed by the daily cron after this long. */
export const FAST_MINI_POT_STALE_SECONDS = 6 * 3600;
/** A game node counts as online when its heartbeat (role all / game) is at most this old. */
export const GAME_NODE_FRESH_SECONDS = 90;
/** Paid-EC rooms: the "Play again (-1 EC)" token for the same life can be re-issued for this long. */
export const RESTAKE_REISSUE_SECONDS = 120;
