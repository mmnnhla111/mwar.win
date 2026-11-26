/**
 * Telegram / LINE sign-in helpers (static export: the callbacks are plain pages under /auth/callback/*).
 *
 * LINE and the Telegram bot deep link keep their state on the SERVER (D1 oauth_states), so the
 * callback works even when the phone comes back from the LINE / Telegram app in a new tab, a PWA
 * or an in-app browser with empty sessionStorage. Only the legacy Telegram web widget (desktop
 * fallback, phone number login) still uses the sessionStorage pending record.
 */
import type { AuthProvidersResponse, OAuthProvider, OAuthPurpose } from '@mwar/shared';
import { oauthLineInit, setAuthToken, telegramBotInit } from './api';
import { getDeviceFp } from './referral';

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

/**
 * Legacy Telegram Login web widget (oauth.telegram.org, asks for a phone number): small fallback for
 * desktops without the Telegram app. Returns to /auth/callback/telegram#tgAuthResult=…
 */
export function startTelegramWidget(cfg: AuthProvidersResponse, opts: { ref?: string | null; link?: boolean } = {}) {
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

/** Where to go after a link / switch finishes (localStorage: survives a new tab; never required). */
const REDIRECT_KEY = 'mwar_oauth_redirect_after';
export function rememberRedirectAfter(path: string | null) {
  try {
    if (path) localStorage.setItem(REDIRECT_KEY, JSON.stringify({ path, at: Date.now() }));
    else localStorage.removeItem(REDIRECT_KEY);
  } catch {
    /* ignore */
  }
}
export function takeRedirectAfter(): string | null {
  try {
    const raw = localStorage.getItem(REDIRECT_KEY);
    localStorage.removeItem(REDIRECT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { path: string; at: number };
    return Date.now() - v.at < PENDING_MAX_AGE_MS && typeof v.path === 'string' && v.path.startsWith('/') && !v.path.startsWith('//') ? v.path : null;
  } catch {
    return null;
  }
}

/**
 * LINE Login: the server creates the state (10 min, single use) and the exact authorize URL; the
 * callback /auth/callback/line?code=…&state=… only needs those two values.
 */
export async function startLine(opts: { ref?: string | null; purpose?: OAuthPurpose } = {}) {
  const purpose = opts.purpose || 'login';
  const deviceFp = purpose === 'login' ? await getDeviceFp().catch(() => null) : null;
  const r = await oauthLineInit({ purpose, referral_code: purpose === 'login' ? opts.ref || null : null, device_fp: deviceFp, redirect_uri: callbackUrl('line') });
  rememberRedirectAfter(purpose === 'login' ? null : '/settings?linked=line');
  window.location.assign(r.authorizeUrl);
}

/** Telegram bot deep link (no phone number): t.me/<bot>?start=auth_<state>. */
export async function initTelegramBot(opts: { ref?: string | null; purpose?: OAuthPurpose } = {}) {
  const purpose = opts.purpose || 'login';
  const deviceFp = purpose === 'login' ? await getDeviceFp().catch(() => null) : null;
  const r = await telegramBotInit({ purpose, referral_code: purpose === 'login' ? opts.ref || null : null, device_fp: deviceFp });
  rememberRedirectAfter(purpose === 'login' ? null : '/settings?linked=telegram');
  markTelegramWait(r.state);
  return r;
}

// ---- iPhone: which browser is waiting for the bot? ------------------------------------------------
const TG_WAIT_KEY = 'mwar_tg_wait';
const TG_WAIT_TTL_MS = 10 * 60 * 1000;

/** Remember (in this browser's storage) that this tab is waiting for a Telegram bot approval. */
export function markTelegramWait(state: string) {
  try {
    localStorage.setItem(TG_WAIT_KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    /* storage blocked */
  }
}
export function clearTelegramWait() {
  try {
    localStorage.removeItem(TG_WAIT_KEY);
  } catch {
    /* ignore */
  }
}
/**
 * True when THIS browser storage started a bot sign-in in the last 10 min. When the bot's button opens
 * /auth/callback/telegram?token= somewhere without the mark (Telegram's in-app browser, Safari View
 * Controller, another browser), that page is not where the player is waiting.
 */
export function hasTelegramWait(): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(TG_WAIT_KEY) || 'null');
    return !!v && typeof v.at === 'number' && Date.now() - v.at < TG_WAIT_TTL_MS;
  } catch {
    return false;
  }
}

export function isIos(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS 13+ reports a Mac UA; touch points give it away
  return typeof navigator !== 'undefined' && /Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1;
}

/** iOS in-app browser (Telegram, LINE, Facebook… WKWebView): no "Safari/" token, or an app marker. */
export function isIosInAppBrowser(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  if (!isIos(ua)) return false;
  if (/Telegram|TelegramBot|Line\/|FBAN|FBAV|Instagram/i.test(ua)) return true;
  return !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** `x-safari-https://…` opens the URL in Safari from an in-app browser on iOS 17+. */
export function safariUrl(url: string): string {
  return url.replace(/^https:\/\//, 'x-safari-https://');
}

/**
 * Open the Telegram deep link. Call `prepareTab()` synchronously inside the click (popup blockers),
 * then `openDeepLink(tab, url)` once the URL is known. On phones t.me hands over to the Telegram app.
 */
export function prepareTab(): Window | null {
  try {
    return window.open('about:blank', '_blank');
  } catch {
    return null;
  }
}
export function openDeepLink(tab: Window | null, url: string): boolean {
  if (tab && !tab.closed) {
    try {
      tab.location.href = url;
      return true;
    } catch {
      /* fall through */
    }
  }
  return false;
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
    case 'OAUTH_STATE_INVALID':
      return 'oauth.err.state';
    case 'SIGN_IN_AGAIN':
      return 'oauth.err.signInAgain';
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
