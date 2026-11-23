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
  /** Shared secret appended to ad-network S2S postback URLs (?secret=...). Required in production. */
  ADS_POSTBACK_SECRET?: string;
  /** Shared secret sent to the Mini PC log receiver (X-Log-Secret header). */
  LOG_INGEST_SECRET?: string;
}

export interface AuthUserPayload {
  userId: string;
  username: string;
  role: 'player' | 'admin' | 'auditor';
}
