/**
 * Telegram / LINE sign-in helpers (static export: the callbacks are plain pages under /auth/callback/*).
 * What we were doing (sign in or link, referral code, LINE CSRF state) is kept in sessionStorage
 * across the redirect to Telegram / LINE and back.
 */
import type { AuthProvidersResponse, OAuthProvider } from '@mwar/shared';
import { setAuthToken } from './api';

const PENDING_KEY = 'mwar_oauth_pending';
const REF_KEY = 'mwar_ref_code';
/** A pending sign-in older than this is ignored (the user wandered off). */
const PENDING_MAX_AGE_MS = 20 * 60 * 1000;

export interface PendingOAuth {
  provider: OAuthProvider;
  state: string;
  ref: string | null;
  link: boolean;
  at: number;
}

const randomState = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function callbackUrl(provider: OAuthProvider) {
  return `${window.location.origin}/auth/callback/${provider}`;
}

function savePending(p: PendingOAuth) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* private mode: the callback falls back to a plain sign-in */
  }
}

/** Reads and clears the pending sign-in (single use). */
export function takePending(provider: OAuthProvider): PendingOAuth | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingOAuth;
    if (p.provider !== provider || Date.now() - p.at > PENDING_MAX_AGE_MS) return null;
    return p;
  } catch {
    return null;
  }
}

/** Remembered invite code (from ?ref= links), so it survives a reload of /login. */
export function rememberRef(code: string | null) {
  try {
    if (code) sessionStorage.setItem(REF_KEY, code);
    else sessionStorage.removeItem(REF_KEY);
  } catch {
    /* ignore */
  }
}
export function recalledRef(): string {
  try {
    return sessionStorage.getItem(REF_KEY) || '';
  } catch {
    return '';
  }
}

/** Telegram Login (oauth.telegram.org) returns to /auth/callback/telegram#tgAuthResult=… */
export function startTelegram(cfg: AuthProvidersResponse, opts: { ref?: string | null; link?: boolean } = {}) {
  if (!cfg.telegramEnabled || !cfg.telegramBotId) return false;
  savePending({ provider: 'telegram', state: randomState(), ref: opts.ref || null, link: !!opts.link, at: Date.now() });
  const u = new URL('https://oauth.telegram.org/auth');
  u.searchParams.set('bot_id', cfg.telegramBotId);
  u.searchParams.set('origin', window.location.origin);
  u.searchParams.set('request_access', 'write');
  u.searchParams.set('return_to', callbackUrl('telegram'));
  window.location.assign(u.toString());
  return true;
}

/** LINE Login (OAuth 2.0 authorization code) returns to /auth/callback/line?code=…&state=… */
export function startLine(cfg: AuthProvidersResponse, opts: { ref?: string | null; link?: boolean } = {}) {
  if (!cfg.lineEnabled || !cfg.lineChannelId) return false;
  const state = randomState();
  savePending({ provider: 'line', state, ref: opts.ref || null, link: !!opts.link, at: Date.now() });
  const u = new URL('https://access.line.me/oauth2/v2.1/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.lineChannelId);
  u.searchParams.set('redirect_uri', callbackUrl('line'));
  u.searchParams.set('state', state);
  u.searchParams.set('scope', 'profile openid');
  window.location.assign(u.toString());
  return true;
}

/** Telegram's result: `#tgAuthResult=<base64 JSON>` (oauth.telegram.org) or plain query fields (widget data-auth-url). */
export function readTelegramResult(): Record<string, unknown> | null {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const b64 = hash.get('tgAuthResult');
  if (b64) {
    try {
      const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
      const json = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
      const data = JSON.parse(json);
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }
  const q = new URLSearchParams(window.location.search);
  if (!q.get('id') || !q.get('hash')) return null;
  const out: Record<string, unknown> = {};
  for (const k of ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']) {
    const v = q.get(k);
    if (v !== null) out[k] = k === 'id' || k === 'auth_date' ? Number(v) : v;
  }
  return out;
}

/** Store a refreshed token in the same place (local vs session) the current one lives. */
export function replaceAuthToken(token: string) {
  let remember = true;
  try {
    remember = !!localStorage.getItem('mwar_auth_token') || !sessionStorage.getItem('mwar_auth_token');
  } catch {
    /* default: remember */
  }
  setAuthToken(token, remember);
}

/** Error codes from the auth API → i18n keys (server messages are English only). */
export function authErrorKey(err: any): string | null {
  switch (err?.code) {
    case 'PROVIDER_NOT_CONFIGURED':
      return 'oauth.err.notConfigured';
    case 'BAD_SIGNATURE':
    case 'LINE_CODE_REJECTED':
      return 'oauth.err.expired';
    case 'REFERRAL_NOT_FOUND':
      return 'oauth.err.referral';
    case 'ALREADY_LINKED':
      return 'oauth.err.alreadyLinked';
    case 'LAST_LINKED_ACCOUNT':
      return 'oauth.err.lastLinked';
    case 'USERNAME_LOCKED':
      return 'security.usernameLockedErr';
    case 'USERNAME_TAKEN':
      return 'security.usernameTaken';
    case 'PASSWORD_COOLDOWN':
      return 'security.pwCooldownErr';
    default:
      return null;
  }
}
