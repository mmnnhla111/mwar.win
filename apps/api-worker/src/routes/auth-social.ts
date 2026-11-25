import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  TelegramOAuthSchema,
  LineOAuthSchema,
  SetUsernameSchema,
  INITIAL_ENERGY_TICKETS,
  MAX_ENERGY_TICKETS,
  BackupPasswordSchema,
  OAUTH_PROVIDERS,
  PASSWORD_CHANGE_COOLDOWN_SECONDS,
  TELEGRAM_AUTH_MAX_AGE_SECONDS,
} from '@mwar/shared';
import type { AuthProvidersResponse, LinkedAccountsResponse, LinkedProviderAccount, OAuthLoginResponse, OAuthProvider } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { hashPassword, signJwt, verifyJwt } from '../utils/crypto';
import { buildNetworkTree } from '../utils/mlm-tree';
import { authMiddleware } from '../middleware/auth';
import { edgeCachedJson } from '../utils/edge-cache';
import { safeEqual } from '../utils/guards';

/**
 * Telegram Login + LINE Login: the only way to open an account.
 *
 * Telegram and LINE each allow one account per phone number, and oauth_accounts has
 * UNIQUE(provider, provider_user_id), so one Telegram/LINE identity = one mwar.win player
 * (anti-sybil) without us ever collecting or storing a phone number.
 */
type AppEnv = { Bindings: Env; Variables: { user: AuthUserPayload } };
type Ctx = Context<AppEnv>;

export const socialAuthRouter = new Hono<AppEnv>();

const now = () => Math.floor(Date.now() / 1000);
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();

const telegramReady = (env: Env) => Boolean(env.TELEGRAM_BOT_USERNAME && env.TELEGRAM_BOT_TOKEN);
const lineReady = (env: Env) => Boolean(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET);

const notConfigured = (c: Ctx, provider: OAuthProvider) =>
  c.json(
    {
      error: `${provider === 'telegram' ? 'Telegram' : 'LINE'} login is not set up yet. Please try again later.`,
      code: 'PROVIDER_NOT_CONFIGURED',
      setup:
        provider === 'telegram'
          ? 'Set TELEGRAM_BOT_USERNAME and the TELEGRAM_BOT_TOKEN secret on the API worker.'
          : 'Set LINE_CHANNEL_ID and the LINE_CHANNEL_SECRET secret on the API worker.',
    },
    503
  );

// ---------------------------------------------------------------------------
// Provider config (public, edge-cached 60 s)
// ---------------------------------------------------------------------------
socialAuthRouter.get('/providers', (c) =>
  edgeCachedJson(c, 'auth-providers-v1', 60, async (): Promise<AuthProvidersResponse> => {
    const tg = telegramReady(c.env);
    const botId = tg ? (c.env.TELEGRAM_BOT_TOKEN || '').split(':')[0] : '';
    return {
      telegramEnabled: tg && /^\d+$/.test(botId),
      telegramBotUsername: c.env.TELEGRAM_BOT_USERNAME || null,
      telegramBotId: tg && /^\d+$/.test(botId) ? botId : null,
      lineEnabled: lineReady(c.env),
      lineChannelId: c.env.LINE_CHANNEL_ID || null,
    };
  })
);

// ---------------------------------------------------------------------------
// Referral code check (so a typo is caught before the Telegram/LINE redirect)
// ---------------------------------------------------------------------------
async function findReferrer(c: Ctx, code: string | null | undefined): Promise<{ id: string; username: string } | null> {
  const v = (code || '').trim();
  if (v.length < 3 || v.length > 64) return null;
  return c.env.DB
    .prepare(
      "SELECT id, username FROM users WHERE id = ?1 AND status != 'banned' UNION ALL SELECT id, username FROM users WHERE username = ?1 AND status != 'banned' LIMIT 1"
    )
    .bind(v)
    .first<{ id: string; username: string }>();
}

socialAuthRouter.get('/referral', async (c) => {
  const r = await findReferrer(c, c.req.query('code'));
  return c.json(r ? { valid: true, username: r.username } : { valid: false, username: null });
});

// ---------------------------------------------------------------------------
// Telegram signature (core.telegram.org/widgets/login#checking-authorization)
// ---------------------------------------------------------------------------
const TELEGRAM_SIGNED_FIELDS = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date'] as const;

export async function verifyTelegramPayload(data: Record<string, unknown>, botToken: string, nowSec = now()): Promise<boolean> {
  const hash = typeof data.hash === 'string' ? data.hash.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || Math.abs(nowSec - authDate) > TELEGRAM_AUTH_MAX_AGE_SECONDS) return false;
  const checkString = TELEGRAM_SIGNED_FIELDS.filter((k) => data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n');
  const secret = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(checkString)));
  return safeEqual(sig, hash);
}

// ---------------------------------------------------------------------------
// Shared: link to the signed-in player, or sign in / open an account
// ---------------------------------------------------------------------------
interface ProviderIdentity {
  provider: OAuthProvider;
  providerUserId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 1024) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
};

/** Optional bearer token (link mode only). */
async function currentUser(c: Ctx): Promise<AuthUserPayload | null> {
  const h = c.req.header('Authorization');
  if (!h?.startsWith('Bearer ')) return null;
  return verifyJwt(h.slice(7).trim(), c.env.JWT_SECRET);
}

/** Clean, unique username from the provider name: "lemon_fan", "lemon_fan_4821", "player_7302". */
async function pickUsername(c: Ctx, idn: ProviderIdentity): Promise<string> {
  const raw = (idn.username || idn.displayName || '').normalize('NFKD').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const base = (raw.length >= 3 ? raw : 'player').slice(0, 14).toLowerCase();
  const candidates = [base];
  for (let i = 0; i < 6; i++) candidates.push(`${base}_${1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000)}`);
  if (base.length < 3 || base === 'player') candidates.shift();
  for (const name of candidates) {
    const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ?1').bind(name).first();
    if (!taken) return name;
  }
  return `player_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

async function issueToken(c: Ctx, u: { id: string; username: string; role: string }) {
  return signJwt({ userId: u.id, username: u.username, role: u.role as AuthUserPayload['role'] }, c.env.JWT_SECRET);
}

async function completeOAuth(c: Ctx, idn: ProviderIdentity, opts: { referralCode?: string | null; link?: boolean }) {
  const t = now();
  const label = idn.provider === 'telegram' ? 'Telegram' : 'LINE';
  const existing = await c.env.DB
    .prepare('SELECT user_id FROM oauth_accounts WHERE provider = ?1 AND provider_user_id = ?2')
    .bind(idn.provider, idn.providerUserId)
    .first<{ user_id: string }>();

  // --- Link (or change) the provider on the signed-in account (/settings) ---
  if (opts.link) {
    const me = await currentUser(c);
    if (!me) return c.json({ error: 'Please sign in again to connect an account.' }, 401);
    if (existing && existing.user_id !== me.userId) {
      return c.json({ error: `This ${label} account is already linked to another player`, code: 'ALREADY_LINKED' }, 409);
    }
    // One row per provider per player: linking a different account replaces the old one
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM oauth_accounts WHERE user_id = ?1 AND provider = ?2 AND provider_user_id != ?3').bind(
        me.userId,
        idn.provider,
        idn.providerUserId
      ),
      c.env.DB.prepare(
        `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_display_name, provider_avatar_url, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(provider, provider_user_id) DO UPDATE SET provider_username = ?5, provider_display_name = ?6, provider_avatar_url = ?7, updated_at = ?8`
      ).bind(crypto.randomUUID(), me.userId, idn.provider, idn.providerUserId, idn.username, idn.displayName, idn.avatarUrl, t),
    ]);
    const body: OAuthLoginResponse = { success: true, isNewUser: false, linked: true, user: { id: me.userId, username: me.username } };
    return c.json(body);
  }

  // --- Sign in ---
  if (existing) {
    const u = await c.env.DB
      .prepare('SELECT id, username, role, status FROM users WHERE id = ?1')
      .bind(existing.user_id)
      .first<{ id: string; username: string; role: string; status: string }>();
    if (!u) return c.json({ error: 'Account not found' }, 404);
    if (u.status === 'banned' || u.status === 'suspended') return c.json({ error: 'This account is suspended', code: 'SUSPENDED' }, 403);
    // Keep the provider profile fresh (cheap single-row write)
    await c.env.DB
      .prepare('UPDATE oauth_accounts SET provider_username = ?1, provider_display_name = ?2, provider_avatar_url = ?3, updated_at = ?4 WHERE provider = ?5 AND provider_user_id = ?6')
      .bind(idn.username, idn.displayName, idn.avatarUrl, t, idn.provider, idn.providerUserId)
      .run();
    const body: OAuthLoginResponse = { success: true, token: await issueToken(c, u), isNewUser: false, user: { id: u.id, username: u.username } };
    return c.json(body);
  }

  // --- First time: open an account ---
  let referrerId: string | null = null;
  if (opts.referralCode && opts.referralCode.trim()) {
    const ref = await findReferrer(c, opts.referralCode);
    if (!ref) return c.json({ error: 'Referral code not found', code: 'REFERRAL_NOT_FOUND' }, 400);
    referrerId = ref.id;
  }

  const userId = crypto.randomUUID();
  // Unusable random password until the player sets a backup password (has_password = 0)
  const passwordHash = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
  const email = `${userId}@oauth.mwar.local`;
  const displayName = (idn.displayName || idn.username || '').slice(0, 40) || null;

  let username = '';
  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    username = await pickUsername(c, idn);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO users (id, username, email, password_hash, referrer_id, role, status, created_at, display_name, avatar_url, username_locked, has_password, last_energy_recharge, energy_tickets, max_energy_tickets)
           VALUES (?1, ?2, ?3, ?4, ?5, 'player', 'active', ?6, ?7, ?8, 0, 0, ?6, ?9, ?10)`
        ).bind(userId, username, email, passwordHash, referrerId, t, displayName, idn.avatarUrl, INITIAL_ENERGY_TICKETS, MAX_ENERGY_TICKETS),
        c.env.DB.prepare(
          'INSERT INTO wallets (user_id, balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, updated_at) VALUES (?1, 0, 0, 0, ?2)'
        ).bind(userId, t),
        c.env.DB.prepare(
          `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_display_name, provider_avatar_url, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
        ).bind(crypto.randomUUID(), userId, idn.provider, idn.providerUserId, idn.username, idn.displayName, idn.avatarUrl, t),
      ]);
      created = true;
    } catch (err: any) {
      const msg = String(err?.message || err);
      // Same Telegram/LINE account signed up twice at once: the other request won, sign in instead
      if (msg.includes('oauth_accounts')) return completeOAuth(c, idn, { link: false });
      if (!msg.includes('users.username')) throw err;
    }
  }
  if (!created) return c.json({ error: 'Could not create the account. Please try again.' }, 500);

  if (referrerId) await buildNetworkTree(c.env.DB, userId, referrerId);

  const body: OAuthLoginResponse = {
    success: true,
    token: await issueToken(c, { id: userId, username, role: 'player' }),
    isNewUser: true,
    user: { id: userId, username },
  };
  return c.json(body, 201);
}

// ---------------------------------------------------------------------------
// POST /api/auth/oauth/telegram
// ---------------------------------------------------------------------------
socialAuthRouter.post('/oauth/telegram', async (c) => {
  if (!telegramReady(c.env)) return notConfigured(c, 'telegram');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = TelegramOAuthSchema.safeParse(body);
  if (!parsed.success || !body) return c.json({ error: 'Invalid Telegram login data' }, 400);
  if (!(await verifyTelegramPayload(body, c.env.TELEGRAM_BOT_TOKEN!))) {
    return c.json({ error: 'Telegram login could not be verified or has expired. Please try again.', code: 'BAD_SIGNATURE' }, 401);
  }
  const d = parsed.data;
  const fullName = [d.first_name, d.last_name].filter(Boolean).join(' ').trim();
  return completeOAuth(
    c,
    {
      provider: 'telegram',
      providerUserId: String(d.id),
      username: d.username || null,
      displayName: fullName || null,
      avatarUrl: httpsUrl(d.photo_url),
    },
    { referralCode: d.referral_code, link: d.link_to_current_user === true }
  );
});

// ---------------------------------------------------------------------------
// POST /api/auth/oauth/line  (authorization code → token → profile)
// ---------------------------------------------------------------------------
function allowedLineRedirect(c: Ctx, uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.pathname !== '/auth/callback/line' || u.search || u.hash) return false;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    const web = new URL(c.env.WEB_APP_URL || 'https://mwar.win');
    return u.protocol === 'https:' && (u.host === web.host || u.host === `www.${web.host}`);
  } catch {
    return false;
  }
}

socialAuthRouter.post('/oauth/line', async (c) => {
  if (!lineReady(c.env)) return notConfigured(c, 'line');
  const parsed = LineOAuthSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid LINE login data' }, 400);
  const d = parsed.data;
  if (!allowedLineRedirect(c, d.redirect_uri)) return c.json({ error: 'Invalid LINE redirect address' }, 400);

  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: d.code,
      redirect_uri: d.redirect_uri,
      client_id: c.env.LINE_CHANNEL_ID!,
      client_secret: c.env.LINE_CHANNEL_SECRET!,
    }),
  }).catch(() => null);
  if (!tokenRes || !tokenRes.ok) {
    return c.json({ error: 'LINE login expired or was already used. Please try again.', code: 'LINE_CODE_REJECTED' }, 401);
  }
  const tok = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
  if (!tok?.access_token) return c.json({ error: 'LINE did not return an access token' }, 502);

  const profRes = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${tok.access_token}` } }).catch(() => null);
  const prof = profRes?.ok ? ((await profRes.json().catch(() => null)) as { userId?: string; displayName?: string; pictureUrl?: string } | null) : null;
  if (!prof?.userId || !/^U[0-9a-f]{32}$/i.test(prof.userId)) return c.json({ error: 'Could not read your LINE profile' }, 502);

  return completeOAuth(
    c,
    {
      provider: 'line',
      providerUserId: prof.userId,
      username: null,
      displayName: (prof.displayName || '').slice(0, 80) || null,
      avatarUrl: httpsUrl(prof.pictureUrl),
    },
    { referralCode: d.referral_code, link: d.link_to_current_user === true }
  );
});

// ---------------------------------------------------------------------------
// Signed-in: connected accounts, unlink, username (once), backup password
// ---------------------------------------------------------------------------
type SecRow = { username: string; username_locked: number; has_password: number; password_changed_at: number; role: string };
const loadSec = (c: Ctx, userId: string) =>
  c.env.DB.prepare('SELECT username, username_locked, has_password, password_changed_at, role FROM users WHERE id = ?1').bind(userId).first<SecRow>();

const nextPasswordChange = (row: SecRow) =>
  row.has_password && row.password_changed_at && now() - row.password_changed_at < PASSWORD_CHANGE_COOLDOWN_SECONDS
    ? row.password_changed_at + PASSWORD_CHANGE_COOLDOWN_SECONDS
    : null;

socialAuthRouter.get('/linked-accounts', authMiddleware, async (c) => {
  const me = c.get('user');
  const [sec, links] = await Promise.all([
    loadSec(c, me.userId),
    c.env.DB
      .prepare('SELECT provider, provider_username, provider_display_name, provider_avatar_url, created_at, updated_at FROM oauth_accounts WHERE user_id = ?1')
      .bind(me.userId)
      .all<{ provider: OAuthProvider; provider_username: string | null; provider_display_name: string | null; provider_avatar_url: string | null; created_at: number; updated_at: number }>(),
  ]);
  if (!sec) return c.json({ error: 'User not found' }, 404);
  const pick = (p: OAuthProvider): LinkedProviderAccount | null => {
    const r = (links.results || []).find((x) => x.provider === p);
    return r ? { username: r.provider_username, displayName: r.provider_display_name, avatarUrl: r.provider_avatar_url, linkedAt: r.updated_at || r.created_at } : null;
  };
  const body: LinkedAccountsResponse = {
    username: sec.username,
    usernameLocked: !!sec.username_locked,
    hasPassword: !!sec.has_password,
    passwordChangeAvailableAt: nextPasswordChange(sec),
    telegram: pick('telegram'),
    line: pick('line'),
  };
  return c.json(body);
});

/**
 * DELETE /api/auth/linked-accounts/:provider — only while the other provider stays linked.
 * Every account opened through Telegram/LINE must keep at least one phone-backed link: otherwise a
 * backup password + unlink would free the same Telegram/LINE id to open account after account.
 * (Changing to a different Telegram/LINE account goes through the normal link flow, which replaces it.)
 */
socialAuthRouter.delete('/linked-accounts/:provider', authMiddleware, async (c) => {
  const me = c.get('user');
  const provider = c.req.param('provider') as OAuthProvider;
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) return c.json({ error: 'Unknown provider' }, 400);
  const other = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ?1 AND provider != ?2')
    .bind(me.userId, provider)
    .first<{ n: number }>();
  if (!(other?.n ?? 0)) {
    return c.json({ error: 'Keep at least one Telegram or LINE account connected. To switch, connect the new account instead.', code: 'LAST_LINKED_ACCOUNT' }, 409);
  }
  await c.env.DB.prepare('DELETE FROM oauth_accounts WHERE user_id = ?1 AND provider = ?2').bind(me.userId, provider).run();
  return c.json({ success: true });
});

/** Shared by /username and /backup-password: claim the username once. Returns an error response or null. */
async function claimUsername(c: Ctx, me: AuthUserPayload, sec: SecRow, username: string) {
  if (username === sec.username) {
    await c.env.DB.prepare('UPDATE users SET username_locked = 1 WHERE id = ?1').bind(me.userId).run();
    return null;
  }
  if (sec.username_locked) return c.json({ error: 'Your username is already set and cannot be changed', code: 'USERNAME_LOCKED' }, 409);
  const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ?1 AND id != ?2').bind(username, me.userId).first();
  if (taken) return c.json({ error: 'This username is already taken', code: 'USERNAME_TAKEN' }, 409);
  const res = await c.env.DB
    .prepare('UPDATE users SET username = ?1, username_locked = 1 WHERE id = ?2 AND username_locked = 0')
    .bind(username, me.userId)
    .run()
    .catch(() => null);
  if (!res) return c.json({ error: 'This username is already taken', code: 'USERNAME_TAKEN' }, 409);
  if ((res.meta?.changes ?? 0) !== 1) return c.json({ error: 'Your username is already set and cannot be changed', code: 'USERNAME_LOCKED' }, 409);
  return null;
}

/** POST /api/auth/username — choose your own username (only while it is still the generated one). */
socialAuthRouter.post('/username', authMiddleware, async (c) => {
  const me = c.get('user');
  const parsed = SetUsernameSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid username' }, 400);
  const sec = await loadSec(c, me.userId);
  if (!sec) return c.json({ error: 'User not found' }, 404);
  const err = await claimUsername(c, me, sec, parsed.data.username);
  if (err) return err;
  // The JWT carries the username: hand back a fresh one
  return c.json({ success: true, username: parsed.data.username, token: await issueToken(c, { id: me.userId, username: parsed.data.username, role: sec.role }) });
});

/** POST /api/auth/backup-password — set (any time) or change (once per 24 h) the backup password. */
socialAuthRouter.post('/backup-password', authMiddleware, async (c) => {
  const me = c.get('user');
  const parsed = BackupPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid password' }, 400);
  const sec = await loadSec(c, me.userId);
  if (!sec) return c.json({ error: 'User not found' }, 404);
  const wait = nextPasswordChange(sec);
  if (wait) {
    return c.json({ error: 'You changed your password recently. Please try again later.', code: 'PASSWORD_COOLDOWN', availableAt: wait }, 429);
  }
  let username = sec.username;
  if (parsed.data.username) {
    const err = await claimUsername(c, me, sec, parsed.data.username);
    if (err) return err;
    username = parsed.data.username;
  }
  const hash = await hashPassword(parsed.data.password);
  const t = now();
  await c.env.DB.prepare('UPDATE users SET password_hash = ?1, has_password = 1, password_changed_at = ?2 WHERE id = ?3').bind(hash, t, me.userId).run();
  return c.json({
    success: true,
    username,
    passwordChangeAvailableAt: t + PASSWORD_CHANGE_COOLDOWN_SECONDS,
    token: username !== me.username ? await issueToken(c, { id: me.userId, username, role: sec.role }) : undefined,
  });
});
