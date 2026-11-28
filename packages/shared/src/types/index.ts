/**
 * Shared Domain Types for MWAR Platform
 */

export type UserRole = 'player' | 'admin' | 'auditor';
export type UserStatus = 'active' | 'suspended' | 'banned';
export type RankBadge = 'Bronze' | 'Silver' | 'Gold' | 'Diamond' | 'Legendary';

export interface User {
  id: string;
  username: string;
  email: string;
  password_hash?: string;
  referrer_id: string | null;
  role: UserRole;
  status: UserStatus;
  avatar_url?: string;
  rank_badge?: RankBadge;
  rename_count?: number;
  energy_tickets?: number;
  max_energy_tickets?: number;
  last_energy_recharge?: number;
  created_at: number; // unix epoch in seconds
}

export interface Wallet {
  user_id: string;
  balance_micro_usd: number | bigint;
  total_earned_micro_usd: number | bigint;
  total_withdrawn_micro_usd: number | bigint;
  updated_at: number;
}

export interface NetworkTreeNode {
  ancestor_id: string;
  descendant_id: string;
  depth: number; // 1 to 5
}

export interface DownlineMember {
  user_id: string;
  username: string;
  depth: number;
  total_earned_micro_usd: number;
  joined_at: number;
}

export type MarketplaceStatus = 'active' | 'sold' | 'cancelled';

export interface MarketplaceListing {
  id: string;
  seller_id: string;
  target_user_id: string;
  price_micro_usd: number | bigint;
  status: MarketplaceStatus;
  created_at: number;
}

export type WithdrawalStatus = 'pending' | 'ai_verifying' | 'approved' | 'flagged_review' | 'rejected';

export interface WithdrawalRequest {
  id: string;
  user_id: string;
  amount_micro_usd: number | bigint;
  fee_micro_usd: number | bigint;
  status: WithdrawalStatus;
  ai_audit_score: number | null;
  created_at: number;
  processed_at: number | null;
}

export interface DirectMessage {
  id: number;
  sender_id: string;
  receiver_id: string;
  message_text: string | null;
  media_r2_url: string | null;
  is_read: number; // 0 or 1
  created_at: number;
}

export type FinancialActionType =
  | 'GAME_KILL'
  /** Fast & Mini kill: 90 % of the victim's banner pot credited to the shooter (inflow; 10 % platform). */
  | 'FAST_MINI_KILL'
  | 'CHEST_OPEN'
  | 'AD_WATCH'
  | 'MLM_COMMISSION'
  | 'MARKET_BUY'
  | 'CASHOUT_REQUEST'
  | 'CASHOUT_REJECT_REFUND'
  | 'DEV_MOCK_FAUCET'
  | 'PRACTICE_EC_RECHARGE'
  /** EC recharge progress earned from a banner impression / rewarded video (no money moves; informational). */
  | 'AD_EC_RECHARGE'
  /** Daily quest coin reward credited to the wallet (inflow). */
  | 'QUEST_REWARD'
  /** MLM commission accrued into the daily grey/green ledger — NOT yet in the wallet (informational). */
  | 'MLM_COMMISSION_PENDING'
  /** Grey MLM commission burned at midnight because the sponsor missed the 4-quest rule (informational). */
  | 'MLM_FORFEIT'
  /** Round earnings clawed back after a 30-minute AFK kick (outflow). */
  | 'AFK_FORFEIT'
  /** Marketplace sale proceeds released to the seller after the 30-day escrow (inflow). */
  | 'MARKET_SELL'
  /** One Energy Ticket (EC) spent to enter a paid arena (no money moves). */
  | 'EC_CONSUME'
  /** 5 % of a reward added to the earner's own head bounty (wallets.bounty_micro_usd, not spendable; informational). */
  | 'BOUNTY_ACCRUE'
  /** A victim's accumulated head bounty credited to whoever eliminated them / opened their chest (inflow). */
  | 'BOUNTY_CLAIM'
  /** A victim's head bounty paid out to their killer (informational, the bounty is not wallet balance). */
  | 'BOUNTY_PAYOUT'
  /** Platform / system share of a reward split: 5 % fee + unclaimed upline levels + rounding (informational). */
  | 'PLATFORM_FEE'
  /** 20 % of a reward split credited to the Energy Recharge Reserve Pool (system ledger, informational). */
  | 'ENERGY_POOL_CREDIT'
  /** Ad value drawn from the Energy Recharge Reserve Pool to back an EC recharge (system ledger, informational). */
  | 'ENERGY_POOL_DRAW'
  /** A cashout paid out by super_admin (informational: the wallet was debited at request time). */
  | 'CASHOUT_APPROVED'
  /** V1.1: 55 % of a cheer ad's safe value credited to the cheered creator's wallet (inflow). */
  | 'CHEER_REWARD'
  /** V1.1: an Energy Ticket minted with its real backed µUSD value (informational, no wallet change). */
  | 'TICKET_MINT'
  /** V1.1: an in_match ticket that ended without a payout — its backing goes to the platform (informational). */
  | 'TICKET_FORFEIT'
  /** V1.1 R2: an unused "Play again" ticket returned to available (informational, no wallet change). */
  | 'TICKET_RETURN'
  /** V1.1 R2: part of a Fast & Mini banner's safe value credited to the viewer's pot (informational). */
  | 'FAST_MINI_POT_CREDIT'
  /** V1.1 R2: a closed Fast & Mini pot's unpaid remainder kept by the platform (informational). */
  | 'FAST_MINI_POT_FORFEIT'
  /** V1.2: 55 % of a Golden Boss reservation credited to whoever eliminated the boss (inflow). */
  | 'BOSS_BOUNTY_CLAIM'
  /** V1.2: µUSD credited to the Boss Bounty Pool (5 % of verified gross ad value or a redirected 5 % fee; informational). */
  | 'BOSS_POOL_CREDIT'
  /** V1.2: a Golden Boss draw reserved from the Boss Bounty Pool (informational). */
  | 'BOSS_BOUNTY_RESERVE'
  /** V1.2: an unclaimed Golden Boss reservation returned to the pool (informational). */
  | 'BOSS_BOUNTY_RELEASE'
  /** V1.2: 3 % of verified gross ad value kept in the Platform Safety Reserve (informational). */
  | 'AD_SAFETY_RESERVE'
  /** V1.2 C: a paid spectator gift debited from the sender's wallet (outflow). */
  | 'GIFT_SEND'
  /** V1.2 C: 70 % of a paid spectator gift credited to the watched player (inflow). */
  | 'GIFT_RECEIVE'
  /** V1.2 C: 30 % of a paid spectator gift kept by the platform (informational). */
  | 'GIFT_PLATFORM_FEE'
  /** V1.2 C: P2P skin purchase debited from the buyer (outflow). */
  | 'SKIN_MARKET_BUY'
  /** V1.2 C: P2P skin sale proceeds (price − fee) credited to the seller (inflow). */
  | 'SKIN_MARKET_SALE'
  /** V1.2 C: the 5–10 % P2P skin market fee kept by the platform (informational). */
  | 'SKIN_MARKET_FEE'
  /** V1.2 C: a cold-start bot bounty reserved from the Boss Bounty Pool (informational). */
  | 'BOT_BOUNTY_RESERVE'
  /** V1.2 C: an unclaimed bot bounty returned to the Boss Bounty Pool (informational). */
  | 'BOT_BOUNTY_RELEASE'
  /** V1.2 C: 55 % of a bot bounty credited to the paid player who eliminated the bot (inflow). */
  | 'BOT_BOUNTY_CLAIM'
  /** V1.2 C: Happy Hour 2x extra credited from the Boss Bounty Pool (inflow). */
  | 'HAPPY_HOUR_BONUS'
  /** V1.2 C: the streamer's 30–50 % of verified spectator ad value in their room (inflow). */
  | 'STREAMER_AD_SHARE'
  /** V1.2 C: a launch promo code minted a ticket backed from the marketing pool (informational). */
  | 'PROMO_REDEEM'
  /** V1.2 C: company money deposited into the marketing pool by super_admin (informational). */
  | 'MARKETING_POOL_DEPOSIT';

/** Action types that ADD to the wallet balance (Layer-1 ledger reconciliation). */
export const LEDGER_INFLOW_ACTIONS: FinancialActionType[] = [
  'GAME_KILL',
  'FAST_MINI_KILL',
  'CHEST_OPEN',
  'AD_WATCH',
  'MLM_COMMISSION',
  'DEV_MOCK_FAUCET',
  'CASHOUT_REJECT_REFUND',
  'QUEST_REWARD',
  'MARKET_SELL',
  'BOUNTY_CLAIM',
  'CHEER_REWARD',
  'BOSS_BOUNTY_CLAIM',
  'GIFT_RECEIVE',
  'SKIN_MARKET_SALE',
  'BOT_BOUNTY_CLAIM',
  'HAPPY_HOUR_BONUS',
  'STREAMER_AD_SHARE',
];
/** Action types that SUBTRACT from the wallet balance. */
export const LEDGER_OUTFLOW_ACTIONS: FinancialActionType[] = ['CASHOUT_REQUEST', 'MARKET_BUY', 'AFK_FORFEIT', 'GIFT_SEND', 'SKIN_MARKET_BUY'];

export interface FinancialLog {
  id?: number;
  transaction_id: string;
  user_id: string;
  action_type: FinancialActionType;
  amount_micro_usd: bigint | number;
  balance_after_micro_usd: bigint | number;
  source_game_id?: string | null;
  related_user_id?: string | null;
  mlm_level?: number | null;
  created_at?: string | Date;
}

// Real-Time Game Room & Player Types
export type RoomType = 'mini_30' | 'standard_100' | 'warzone_large';

export interface PlayerTransform {
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  chestsCollected: number;
  sessionEarningsMicroUsd: bigint | number;
}

export interface PlayerEntityState extends PlayerTransform {
  id: string;
  sessionId: string;
  username: string;
  health: number;
  maxHealth: number;
  isProp: boolean; // Prop-hide disguise on disconnect/crouch
  propType?: 'wooden_crate' | 'barrel' | 'bush';
  isGhost: boolean; // Spectator mode upon death
  lastActiveTime: number; // Timestamp for anti-AFK detection
  stats: PlayerStats;
}

export interface ChestEntity {
  id: string;
  x: number;
  y: number;
  z: number;
  health: number;
  maxHealth: number;
  rewardMicroUsd: number;
  spawnedAt: number;
  isDestroyed: boolean;
}

export interface BatchPayoutItem {
  userId: string;
  amountMicroUsd: number;
  /** Financial action, or a V1.1 R2 game-server-only settlement item (no amount is trusted for these). */
  actionType: FinancialActionType | 'FAST_MINI_KILL' | 'FAST_MINI_CLOSE';
  gameId: string;
  metadata?: Record<string, unknown>;
}

export interface BatchPayoutPayload {
  gameId: string;
  timestamp: number;
  payouts: BatchPayoutItem[];
}

// Dev Mock Types
export interface DevMockTelegramAuth {
  id: string;
  first_name: string;
  username: string;
  phone_number: string;
  auth_date: number;
  hash: string;
}

export interface DevMockAdPostback {
  provider: 'adswedmedia' | 'onclicka';
  clickId: string;
  userId: string;
  country: 'US' | 'TH' | 'EU' | 'OTHER';
  rewardMicroUsd?: number;
}

export interface DevMockWithdrawalReview {
  withdrawalId: string;
  targetState: 'approved' | 'rejected' | 'ai_verifying';
  aiScore?: number;
  reason?: string;
}

// Daily Quest & Proof-of-Activity MLM Types
export interface DailyQuestDefinition {
  quest_id: string;
  title: string;
  description: string;
  target_count: number;
  action_type: string;
  reward_coins: number;
  created_at: number;
}

export interface UserDailyQuestItem {
  questId: string;
  title: string;
  description: string;
  target: number;
  current: number;
  rewardCoins: number;
  actionType: string;
  isCompleted: boolean;
  isClaimed: boolean;
}

export interface TodayQuestsResponse {
  dateKey: string;
  totalQuests: number;
  completedQuests: number;
  requiredToUnlock: number;
  isMlmUnlocked: boolean;
  quests: UserDailyQuestItem[];
}

export type DailyMlmStatus = 'pending_grey' | 'unlocked_green' | 'forfeited_burned' | 'settled_paid';

export interface DailyMlmPendingLedgerItem {
  id: string;
  user_id: string;
  date_key: string;
  downline_user_id: string;
  depth_level: number;
  amount_micro_usd: number | bigint;
  status: DailyMlmStatus;
  source_type: string;
  created_at: number;
}

export interface DailyMlmSummary {
  dateKey: string;
  isUnlocked: boolean;
  pendingGreyMicroUsd: number;
  unlockedGreenMicroUsd: number;
  forfeitedMicroUsd: number;
  settledPaidMicroUsd: number;
  completedQuestsCount: number;
  requiredQuestsCount: number;
  formattedPendingGrey: string;
  formattedUnlockedGreen: string;
  message: string;
}

/**
 * V1.1 Round 3: an alive character the user still has in a live PvP room (GET /api/game/active-session).
 * The body stays in the arena (killable, prop disguise kept) while the player is away; Rejoin re-attaches
 * to it without a new EC ticket.
 */
export interface ActiveGameSession {
  roomId: string;
  roomCode: string | null;
  /** Engine mode: mini_30 (Skirmish 30P) | standard_100 (Warzone 100P) | fast_mini. */
  mode: string;
  /** Map of the room: 'small' (240 m) | 'large' (960 m). */
  mapName: string;
  /** WebSocket origin of the game server hosting the room ('' = the client's default). */
  serverUrl: string;
  hp: number;
  isPropHidden: boolean;
  propType: string | null;
  isDisconnected: boolean;
  /** Unix seconds the life started. */
  enteredAt: number;
  entryId: string;
}

export interface ActiveGameSessionResponse {
  session: ActiveGameSession | null;
  /** Only with ?rejoin=1: signed token for the game server (bound to this user + entry + room, 120 s). */
  rejoinToken?: string;
}

