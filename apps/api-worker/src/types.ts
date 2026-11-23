import type { D1Database, R2Bucket, Queue } from '@cloudflare/workers-types';
import type { FinancialLog } from '@mwar/shared';

export interface Env {
  // Cloudflare D1 Bindings
  DB: D1Database;
  CHAT_DB: D1Database;

  // Cloudflare R2 Bucket
  ASSETS_BUCKET: R2Bucket;

  // Cloudflare Queues
  LOG_QUEUE: Queue<FinancialLog>;

  // Environment Variables & Secrets
  DEV_MOCK_MODE?: string;
  JWT_SECRET: string;
  INTERNAL_API_SECRET: string;
  NODE_PROVISION_KEY?: string;
  LOG_RECEIVER_URL?: string;
  /** Shared secret sent as X-Log-Secret to logs.mwar.win (must match the receiver's LOG_RECEIVER_SECRET). */
  LOG_RECEIVER_SECRET?: string;
  /** Secret the ad networks append to S2S postbacks (?secret=...). Required when DEV_MOCK_MODE is off. */
  AD_POSTBACK_SECRET?: string;
  /** Alias accepted for AD_POSTBACK_SECRET. */
  ADS_POSTBACK_SECRET?: string;
  /** Alias accepted for LOG_RECEIVER_SECRET. */
  LOG_INGEST_SECRET?: string;
  /** Telegram bot token used to verify Login Widget signatures (production). */
  TELEGRAM_BOT_TOKEN?: string;
}

export interface AuthUserPayload {
  userId: string;
  username: string;
  role: 'player' | 'admin' | 'auditor';
}
