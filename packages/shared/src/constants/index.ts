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

// MLM 5-Level Distribution Specification
// Platform Fee = 5%, Net Pool = 95%
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
export const MAX_ENERGY_TICKETS = 6;
export const ENERGY_RECHARGE_SECONDS = 3600; // 1 hour per ticket
export const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024; // 512 KB
