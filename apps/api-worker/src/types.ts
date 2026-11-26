import type { D1Database, R2Bucket, Queue } from '@cloudflare/workers-types';

export interface Env {
  // Cloudflare D1 Bindings
  DB: D1Database;
  CHAT_DB: D1Database;

  // Cloudflare R2 Buckets
  ASSETS_BUCKET: R2Bucket;
  /** Social post media (social/YYYY/MM/<uuid>.webp|.mp4|.webm). Rejected / taken-down files are deleted at once. */
  MEDIA_BUCKET: R2Bucket;

  /** Optional monthly chat databases (CHAT_DB_2026_12 …): purged and pre-provisioned by the daily cron. */
  [chatBinding: `CHAT_DB_${number}_${string}`]: D1Database | undefined;

  // Cloudflare Queues (optional: without a binding, audit events go to the D1 audit_outbox)
  FINANCIAL_AUDIT_QUEUE?: Queue<unknown>;
  /** Legacy binding name, still honoured. */
  LOG_QUEUE?: Queue<unknown>;

  // Environment Variables & Secrets
  /** Comma-separated usernames that are always super_admin (owner lock-out protection). */
  SUPER_ADMIN_USERNAMES?: string;
  DEV_MOCK_MODE?: string;
  JWT_SECRET: string;
  INTERNAL_API_SECRET: string;
  NODE_PROVISION_KEY?: string;
  LOG_RECEIVER_URL?: string;
  /** HMAC-SHA256 key for signed deliveries to logs.mwar.win (same value as the receiver's LOG_RECEIVER_SECRET). */
  LOG_RECEIVER_SECRET?: string;
  /** Secret the ad networks append to S2S postbacks (?secret=...). Required when DEV_MOCK_MODE is off. */
  AD_POSTBACK_SECRET?: string;
  /** Comma list of Cheer ad formats to switch off (e.g. 'banner' when no sponsor is booked). */
  CHEER_DISABLED_FORMATS?: string;
  /** Alias accepted for AD_POSTBACK_SECRET. */
  ADS_POSTBACK_SECRET?: string;
  /** Alias accepted for LOG_RECEIVER_SECRET. */
  LOG_INGEST_SECRET?: string;
  /** Telegram bot token used to verify Login Widget signatures (production). */
  TELEGRAM_BOT_TOKEN?: string;
  /** Public bot username (without @) for Telegram Login. Telegram login is on when this + the token are set. */
  TELEGRAM_BOT_USERNAME?: string;
  /** Secret Telegram sends as X-Telegram-Bot-Api-Secret-Token on webhook calls (setWebhook secret_token). */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Local tests only (.dev.vars): mock LINE API origin, accepted only for http://127.0.0.1|localhost:<port>. */
  LINE_API_BASE?: string;
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
