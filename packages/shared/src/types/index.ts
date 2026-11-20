/**
 * Shared Domain Types for MWAR Platform
 */

export type UserRole = 'player' | 'admin' | 'auditor';
export type UserStatus = 'active' | 'suspended' | 'banned';

export interface User {
  id: string;
  username: string;
  email: string;
  password_hash?: string;
  referrer_id: string | null;
  role: UserRole;
  status: UserStatus;
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
  | 'DEV_MOCK_FAUCET';

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
