/**
 * Financial audit queue contract (api-worker → Cloudflare Queue → Mini PC log receiver → PostgreSQL).
 * Shared by both sides so the event shape and the HMAC string to sign can never drift.
 */
import type { FinancialActionType } from './types';

export const AUDIT_EVENT_VERSION = 1;

/** Immutable audit event. Micro-USD amounts are decimal strings (exact, JSON-safe). */
export interface FinancialAuditEvent {
  v: typeof AUDIT_EVENT_VERSION;
  transaction_id: string;
  user_id: string;
  action_type: FinancialActionType;
  amount_micro_usd: string;
  balance_after_micro_usd: string;
  source_game_id: string | null;
  related_user_id: string | null;
  mlm_level: number | null;
  /** ISO-8601 UTC; decides the logs_YYYY_MM table. */
  created_at: string;
}

export interface AuditBatchBody {
  events: FinancialAuditEvent[];
}

export interface AuditBatchResult {
  success: boolean;
  received: number;
  stored: number;
  duplicates: number;
}

/** Signed request headers. Signature = hex HMAC-SHA256(LOG_RECEIVER_SECRET, auditStringToSign(...)). */
export const AUDIT_SIG_HEADER = 'x-mwar-signature';
export const AUDIT_TS_HEADER = 'x-mwar-timestamp';
/** Requests older / newer than this are refused (replay window). */
export const AUDIT_SIG_MAX_SKEW_SECONDS = 300;
/** Max events per signed delivery (also the queue consumer's max_batch_size). */
export const AUDIT_BATCH_MAX = 100;

/** `${unixSeconds}\n${METHOD}\n${pathWithQuery}\n${sha256hex(body)}` — body '' for GET. */
export function auditStringToSign(timestamp: number | string, method: string, pathWithQuery: string, bodySha256Hex: string): string {
  return `${timestamp}\n${method.toUpperCase()}\n${pathWithQuery}\n${bodySha256Hex}`;
}

/** Balance-changing action types (the same set the D1 wallet_ledger records). */
export function isWalletMovingAction(a: string): boolean {
  return WALLET_MOVING_ACTIONS.has(a);
}
const WALLET_MOVING_ACTIONS = new Set<string>([
  'GAME_KILL',
  'FAST_MINI_KILL',
  'CHEER_REWARD',
  'BOSS_BOUNTY_CLAIM',
  'CHEST_OPEN',
  'AD_WATCH',
  'MLM_COMMISSION',
  'DEV_MOCK_FAUCET',
  'CASHOUT_REJECT_REFUND',
  'QUEST_REWARD',
  'MARKET_SELL',
  'BOUNTY_CLAIM',
  'CASHOUT_REQUEST',
  'MARKET_BUY',
  'AFK_FORFEIT',
  // V1.2 Round C
  'GIFT_SEND',
  'GIFT_RECEIVE',
  'SKIN_MARKET_BUY',
  'SKIN_MARKET_SALE',
  'BOT_BOUNTY_CLAIM',
  'HAPPY_HOUR_BONUS',
  'STREAMER_AD_SHARE',
]);
