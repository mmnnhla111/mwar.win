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
}

export interface AuthUserPayload {
  userId: string;
  username: string;
  role: 'player' | 'admin' | 'auditor';
}
