import type { D1Database, R2Bucket, Queue } from '@cloudflare/workers-types';
import type { FinancialLog } from '@mwar/shared';

export interface Env {
  // Cloudflare D1 Bindings
  DB: D1Database;
  CHAT_DB: D1Database;

  // Cloudflare R2 Buckets
  ASSETS_BUCKET: R2Bucket;
  /** Social post media (social/YYYY/MM/<uuid>.webp|.mp4|.webm). Rejected / taken-down files are deleted at once. */
  MEDIA_BUCKET: R2Bucket;

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
  /** Public bot username (without @) for Telegram Login. Telegram login is on when this + the token are set. */
  TELEGRAM_BOT_USERNAME?: string;
  /** LINE Login channel id (public). LINE login is on when this + LINE_CHANNEL_SECRET are set. */
  LINE_CHANNEL_ID?: string;
  /** LINE Login channel secret (secret). */
  LINE_CHANNEL_SECRET?: string;
  /** Public HTTP origin of the Colyseus game server (serves the read-only GET /rooms snapshot). */
  GAME_SERVER_HTTP_URL?: string;
  /** Web app origin used in password-reset links (default https://mwar.win). */
  WEB_APP_URL?: string;
  /** Resend API key for password-reset emails (secret). Without it, reset codes are only logged. */
  RESEND_API_KEY?: string;
  /** Sender for transactional mail, e.g. "MWAR <no-reply@mwar.win>". */
  MAIL_FROM?: string;
}

export interface AuthUserPayload {
  userId: string;
  username: string;
  role: 'player' | 'admin' | 'auditor';
}
