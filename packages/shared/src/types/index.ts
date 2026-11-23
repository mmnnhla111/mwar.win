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

export type WithdrawalStatus = 'pending' | 'ai_verifying' | 'approved' | 'rejected';

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
  | 'CHEST_OPEN'
  | 'AD_WATCH'
  | 'MLM_COMMISSION'
  | 'MARKET_BUY'
  | 'CASHOUT_REQUEST'
  | 'CASHOUT_REJECT_REFUND'
  | 'DEV_MOCK_FAUCET'
  | 'PRACTICE_EC_RECHARGE'
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
  | 'PLATFORM_FEE';

/** Action types that ADD to the wallet balance (Layer-1 ledger reconciliation). */
export const LEDGER_INFLOW_ACTIONS: FinancialActionType[] = [
  'GAME_KILL',
  'CHEST_OPEN',
  'AD_WATCH',
  'MLM_COMMISSION',
  'DEV_MOCK_FAUCET',
  'CASHOUT_REJECT_REFUND',
  'QUEST_REWARD',
  'MARKET_SELL',
  'BOUNTY_CLAIM',
];
/** Action types that SUBTRACT from the wallet balance. */
export const LEDGER_OUTFLOW_ACTIONS: FinancialActionType[] = ['CASHOUT_REQUEST', 'MARKET_BUY', 'AFK_FORFEIT'];

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
  actionType: FinancialActionType;
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

