import { z } from 'zod';

// ---------------------------------------------------------------------------
// Telegram / LINE sign-in (the only way to open an account) + backup password
// ---------------------------------------------------------------------------

export const OAUTH_PROVIDERS = ['telegram', 'line'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Usernames: 3–20 letters, digits or underscore. */
export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const BACKUP_PASSWORD_MIN = 8;
export const BACKUP_PASSWORD_MAX = 128;
/** A backup password can be changed again only after this long (the first one can be set any time). */
export const PASSWORD_CHANGE_COOLDOWN_SECONDS = 24 * 60 * 60;
/** Telegram login payloads older than this are refused. */
export const TELEGRAM_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;

const referralCode = z.string().trim().min(3).max(64).optional().nullable();

/** POST /api/auth/oauth/telegram — the Telegram Login payload plus our own flags (not signed). */
export const TelegramOAuthSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/)]),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  photo_url: z.string().max(1024).optional(),
  auth_date: z.union([z.number().int().positive(), z.string().regex(/^\d{1,12}$/)]),
  hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  referral_code: referralCode,
  /** Sticky referral: the device fingerprint, used when no code came with the sign-up. */
  device_fp: z.string().regex(/^[a-f0-9]{32,64}$/).optional().nullable(),
  link_to_current_user: z.boolean().optional(),
});
export type TelegramOAuthInput = z.infer<typeof TelegramOAuthSchema>;

/** POST /api/auth/oauth/line — the authorization code + the server-side state from the LINE redirect. */
export const LineOAuthSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().regex(/^[A-Za-z0-9_-]{32,96}$/),
  /** Sticky referral: the device fingerprint (used when init did not store one). */
  device_fp: z.string().regex(/^[a-f0-9]{32,64}$/).optional().nullable(),
});
export type LineOAuthInput = z.infer<typeof LineOAuthSchema>;

/** POST /api/auth/username — pick your own username (once). */
export const SetUsernameSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, 'Username must be 3–20 letters, numbers or _'),
});

/** POST /api/auth/backup-password — set or change the backup password (optionally the username too, once). */
export const BackupPasswordSchema = z.object({
  password: z
    .string()
    .min(BACKUP_PASSWORD_MIN, `Password must be at least ${BACKUP_PASSWORD_MIN} characters`)
    .max(BACKUP_PASSWORD_MAX),
  username: z.string().trim().regex(USERNAME_RE, 'Username must be 3–20 letters, numbers or _').optional(),
});

/** GET /api/auth/providers (edge-cached 60 s). */
export interface AuthProvidersResponse {
  telegramEnabled: boolean;
  telegramBotUsername: string | null;
  /** Numeric bot id (the public part of the bot token), needed by oauth.telegram.org. */
  telegramBotId: string | null;
  lineEnabled: boolean;
  lineChannelId: string | null;
}

/** Response of both OAuth endpoints. */
export interface OAuthLoginResponse {
  success: true;
  /** Present when signing in (not when linking to the current account). */
  token?: string;
  /** A new account was just opened: the web app offers the optional username/password step. */
  isNewUser: boolean;
  /** true when the provider was linked to the signed-in account. */
  linked?: boolean;
  user: { id: string; username: string };
}

export interface LinkedProviderAccount {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  linkedAt: number;
}

/** GET /api/auth/linked-accounts */
export interface LinkedAccountsResponse {
  username: string;
  /** false = the username was generated and can still be changed once. */
  usernameLocked: boolean;
  hasPassword: boolean;
  /** Unix seconds when the backup password may be changed again (null = now). */
  passwordChangeAvailableAt: number | null;
  telegram: LinkedProviderAccount | null;
  line: LinkedProviderAccount | null;
}

// ---- Server-side OAuth state (LINE + Telegram bot deep link) ----------------------------------
export const OAUTH_PURPOSES = ['login', 'link', 'switch'] as const;
export type OAuthPurpose = (typeof OAUTH_PURPOSES)[number];
/** A started LINE / Telegram sign-in stays valid for 10 minutes. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** POST /api/auth/oauth/line/init and /api/auth/oauth/telegram/bot-init */
export const OAuthInitSchema = z.object({
  purpose: z.enum(OAUTH_PURPOSES).optional().default('login'),
  referral_code: referralCode,
  device_fp: z.string().regex(/^[a-f0-9]{32,64}$/).optional().nullable(),
  /** LINE only: this site's callback URL (checked against the allowed hosts). */
  redirect_uri: z.string().url().max(512).optional(),
});
export type OAuthInitInput = z.input<typeof OAuthInitSchema>;

export interface LineInitResponse {
  state: string;
  authorizeUrl: string;
}
export interface TelegramBotInitResponse {
  state: string;
  deepLinkUrl: string;
  expiresInSec: number;
}

/** POST /api/auth/oauth/telegram/bot-exchange — the token behind the bot's return button. */
export const TelegramBotExchangeSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,96}$/) });

export type TelegramBotPollResponse =
  | { status: 'pending' | 'expired' | 'consumed' }
  | (OAuthLoginResponse & { status: 'approved' });
