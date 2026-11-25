import { Hono } from 'hono';
import {
  LoginSchema,
  WhatsAppOtpRequestSchema,
  WhatsAppOtpVerifySchema,
  TelegramLoginSchema,
  UpdateProfileSchema,
  DEV_MOCK_OTP,
  formatMicroUsd,
  MAX_ENERGY_TICKETS,
  INITIAL_ENERGY_TICKETS,
  ENERGY_RECHARGE_SECONDS,
  MAX_AVATAR_UPLOAD_BYTES,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  PASSWORD_RESET_TTL_SECONDS,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { hashPassword, verifyPassword, signJwt } from '../utils/crypto';
import { buildNetworkTree } from '../utils/mlm-tree';
import { authMiddleware } from '../middleware/auth';
import { sendMail } from '../utils/mailer';
import { isLocalDev } from '../utils/guards';

const sha256Hex = async (v: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))].map((b) => b.toString(16).padStart(2, '0')).join('');

const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

/**
 * Telegram Login Widget check (core.telegram.org/widgets/login#checking-authorization):
 * secret = SHA256(bot_token); hash = HMAC_SHA256(data_check_string, secret); auth_date ≤ 24 h old.
 */
async function verifyTelegramAuth(data: Record<string, unknown>, botToken: string): Promise<boolean> {
  const hash = data.hash;
  // Only the widget's own fields are signed (our referrer_id / phone_number extras are not)
  const fields: Record<string, unknown> = {};
  for (const k of ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date']) if (data[k] !== undefined) fields[k] = data[k];
  if (typeof hash !== 'string') return false;
  const authDate = Number(fields.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 86_400) return false;
  const checkString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(checkString));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === hash.toLowerCase();
}

/** Old WhatsApp-OTP / Telegram-widget sign-in: they could open accounts without phone-unique proof. */
const legacyGone = (c: any) =>
  c.json({ error: 'This sign-in method was retired. Please continue with Telegram or LINE.', code: 'LEGACY_LOGIN_RETIRED' }, 410);

export const authRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

// 1. Open (email/password) registration is closed: accounts are opened only through Telegram or LINE
//    (POST /api/auth/oauth/telegram | /oauth/line in auth-social.ts), which allow one account per phone
//    number. This stops sybil farming without us collecting phone numbers.
authRouter.post('/register', (c) =>
  c.json(
    {
      error: 'Sign-up with email is closed. Please sign up with Telegram or LINE on the login page.',
      code: 'REGISTRATION_SOCIAL_ONLY',
    },
    403
  )
);

// 2. Standard Login
authRouter.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parseResult = LoginSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { usernameOrEmail, password } = parseResult.data;

  // Brute-force limiter: max 10 failed passwords per account per 15 minutes
  const loginKey = String(usernameOrEmail).toLowerCase().slice(0, 128);
  const nowSec = Math.floor(Date.now() / 1000);
  const fail = await c.env.DB
    .prepare('SELECT failures, window_start FROM login_failures WHERE login_key = ?1')
    .bind(loginKey)
    .first<{ failures: number; window_start: number }>()
    .catch(() => null);
  if (fail && nowSec - fail.window_start < LOGIN_WINDOW_SECONDS && fail.failures >= LOGIN_MAX_FAILURES) {
    return c.json({ error: 'Too many failed attempts. Try again in 15 minutes.' }, 429);
  }
  const recordFailure = () =>
    c.env.DB.prepare(
      `INSERT INTO login_failures (login_key, failures, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(login_key) DO UPDATE SET
         failures = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE failures + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`
    )
      .bind(loginKey, nowSec, LOGIN_WINDOW_SECONDS)
      .run()
      .catch(() => {});

  const user = await c.env.DB
    .prepare('SELECT id, username, email, password_hash, role, status FROM users WHERE username = ?1 OR email = ?1')
    .bind(usernameOrEmail)
    .first<{ id: string; username: string; email: string; password_hash: string; role: string; status: string }>();

  if (!user || user.status === 'banned' || user.status === 'suspended') {
    await recordFailure();
    return c.json({ error: 'Invalid credentials or account suspended' }, 401);
  }

  const isValid = await verifyPassword(password, user.password_hash);
  if (!isValid) {
    await recordFailure();
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE login_key = ?1').bind(loginKey).run().catch(() => {});

  const token = await signJwt(
    { userId: user.id, username: user.username, role: user.role as 'player' | 'admin' | 'auditor' },
    c.env.JWT_SECRET
  );

  return c.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
  });
});

// 3. Current User Profile (/me)
authRouter.get('/me', authMiddleware, async (c) => {
  const authUser = c.get('user');

  const user = await c.env.DB
    .prepare(
      `SELECT id, username, email, phone_number, telegram_id, referrer_id, role, status,
              avatar_url, rank_badge, rename_count, energy_tickets, max_energy_tickets, last_energy_recharge, energy_progress_pct, created_at
       FROM users WHERE id = ?1`
    )
    .bind(authUser.userId)
    .first<any>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Energy Tickets Auto-Recharge (1 ticket per 3600s up to max_energy_tickets)
  const now = Math.floor(Date.now() / 1000);
  let energyTickets = user.energy_tickets ?? INITIAL_ENERGY_TICKETS;
  const maxTickets = Math.min(user.max_energy_tickets ?? MAX_ENERGY_TICKETS, MAX_ENERGY_TICKETS);
  let lastRecharge = user.last_energy_recharge || now;

  if (energyTickets < maxTickets) {
    const elapsed = Math.max(0, now - lastRecharge);
    const recharged = Math.floor(elapsed / ENERGY_RECHARGE_SECONDS);
    if (recharged > 0) {
      energyTickets = Math.min(maxTickets, energyTickets + recharged);
      lastRecharge = energyTickets >= maxTickets ? now : (lastRecharge + recharged * ENERGY_RECHARGE_SECONDS);
      await c.env.DB
        .prepare('UPDATE users SET energy_tickets = ?1, last_energy_recharge = ?2 WHERE id = ?3')
        .bind(energyTickets, lastRecharge, authUser.userId)
        .run();
      user.energy_tickets = energyTickets;
      user.last_energy_recharge = lastRecharge;
    }
  }

  const secondsToNextRecharge = energyTickets < maxTickets
    ? Math.max(0, ENERGY_RECHARGE_SECONDS - (now - lastRecharge))
    : 0;

  // Downline network count
  const downlineRes = await c.env.DB
    .prepare('SELECT COUNT(*) as count FROM network_trees WHERE ancestor_id = ?1')
    .bind(authUser.userId)
    .first<{ count: number }>();

  const wallet = await c.env.DB
    .prepare('SELECT balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, updated_at FROM wallets WHERE user_id = ?1')
    .bind(authUser.userId)
    .first<{ balance_micro_usd: number; total_earned_micro_usd: number; total_withdrawn_micro_usd: number }>();

  return c.json({
    user: {
      ...user,
      downline_count: downlineRes?.count || 0,
      seconds_to_next_recharge: secondsToNextRecharge,
    },
    wallet: wallet
      ? {
          ...wallet,
          formatted_balance: formatMicroUsd(wallet.balance_micro_usd),
          formatted_total_earned: formatMicroUsd(wallet.total_earned_micro_usd),
        }
      : null,
  });
});

// 3.1 Update User Profile (Avatar & Username with rename counter)
authRouter.post('/profile', authMiddleware, async (c) => {
  const authUser = c.get('user');
  const body = await c.req.json().catch(() => null);

  const parseResult = UpdateProfileSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { username, avatarUrl } = parseResult.data;

  const currentUser = await c.env.DB
    .prepare('SELECT id, username, rename_count, username_locked FROM users WHERE id = ?1')
    .bind(authUser.userId)
    .first<{ id: string; username: string; rename_count: number; username_locked: number }>();

  if (!currentUser) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Validate Avatar Size if base64 data url (<= 512 KB)
  if (avatarUrl && avatarUrl.startsWith('data:')) {
    const base64Data = avatarUrl.split(',')[1] || '';
    const approxBytes = Math.floor((base64Data.length * 3) / 4);
    if (approxBytes > MAX_AVATAR_UPLOAD_BYTES) {
      return c.json({ error: `Avatar image must be 512 KB or less. (Current size: ~${Math.round(approxBytes / 1024)} KB)` }, 400);
    }
  }

  // Validate Username Change
  let newRenameCount = currentUser.rename_count || 0;
  if (username && username !== currentUser.username) {
    // A username can be chosen once (Telegram/LINE accounts start with a generated one), then never changed
    if (currentUser.username_locked) {
      return c.json({ error: 'Your username is already set and cannot be changed' }, 409);
    }
    if (newRenameCount >= 3) {
      return c.json({ error: 'Rename limit reached (Maximum 3 renames allowed)' }, 400);
    }

    const taken = await c.env.DB
      .prepare('SELECT id FROM users WHERE username = ?1 AND id != ?2')
      .bind(username, authUser.userId)
      .first();

    if (taken) {
      return c.json({ error: 'Username is already taken' }, 409);
    }

    newRenameCount += 1;
  }

  const updates: string[] = [];
  const bindings: any[] = [];
  let paramIdx = 1;

  if (username) {
    updates.push(`username = ?${paramIdx++}`);
    bindings.push(username);
    updates.push(`rename_count = ?${paramIdx++}`);
    bindings.push(newRenameCount);
    updates.push('username_locked = 1');
  }

  if (avatarUrl !== undefined) {
    updates.push(`avatar_url = ?${paramIdx++}`);
    bindings.push(avatarUrl);
  }

  if (updates.length > 0) {
    bindings.push(authUser.userId);
    await c.env.DB
      .prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?${paramIdx}`)
      .bind(...bindings)
      .run();
  }

  // Return updated user
  const updated = await c.env.DB
    .prepare('SELECT id, username, email, avatar_url, rank_badge, rename_count, energy_tickets, max_energy_tickets FROM users WHERE id = ?1')
    .bind(authUser.userId)
    .first();

  return c.json({
    success: true,
    user: updated,
    remainingRenames: Math.max(0, 3 - newRenameCount),
  });
});

// 4. WhatsApp OTP Request (DEV_MOCK_MODE prints to console)
authRouter.post('/whatsapp/request-otp', async (c) => {
  if (!isLocalDev(c)) return legacyGone(c);
  const body = await c.req.json().catch(() => null);
  const parseResult = WhatsAppOtpRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Invalid phone number format', details: parseResult.error.format() }, 400);
  }

  const { phoneNumber } = parseResult.data;
  const isDev = c.env.DEV_MOCK_MODE === 'true';
  const otpCode = isDev ? DEV_MOCK_OTP : String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  if (!isDev) {
    // Resend limiter + hashed storage (5-minute expiry, 5 attempts)
    const nowSec = Math.floor(Date.now() / 1000);
    const prev = await c.env.DB.prepare('SELECT created_at FROM otp_codes WHERE phone_number = ?1').bind(phoneNumber).first<{ created_at: number }>();
    if (prev && nowSec - prev.created_at < OTP_RESEND_SECONDS) {
      return c.json({ error: 'Please wait a minute before requesting another code' }, 429);
    }
    await c.env.DB
      .prepare(
        `INSERT INTO otp_codes (phone_number, code_hash, expires_at, attempts, created_at) VALUES (?1, ?2, ?3, 0, ?4)
         ON CONFLICT(phone_number) DO UPDATE SET code_hash = ?2, expires_at = ?3, attempts = 0, created_at = ?4`
      )
      .bind(phoneNumber, await sha256Hex(`${phoneNumber}:${otpCode}`), nowSec + OTP_TTL_SECONDS, nowSec)
      .run();
  }

  // Print OTP directly to server terminal for local development
  console.log(`\n======================================================`);
  console.log(`[WHATSAPP OTP SIMULATOR]`);
  console.log(`Target Phone : ${phoneNumber}`);
  console.log(`6-Digit OTP  : ${otpCode}`);
  console.log(`Mode         : ${c.env.DEV_MOCK_MODE === 'true' ? 'DEV MOCK MODE (Fixed: 123456)' : 'PRODUCTION'}`);
  console.log(`======================================================\n`);

  return c.json({
    success: true,
    message: 'WhatsApp OTP generated and sent',
    phoneNumber,
    devMockOtp: c.env.DEV_MOCK_MODE === 'true' ? otpCode : undefined,
  });
});

// 5. WhatsApp OTP Verify
authRouter.post('/whatsapp/verify-otp', async (c) => {
  if (!isLocalDev(c)) return legacyGone(c);
  const body = await c.req.json().catch(() => null);
  const parseResult = WhatsAppOtpVerifySchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { phoneNumber, code, referrer_id } = parseResult.data;

  // In DEV_MOCK_MODE, accepts '123456'
  const isDevMode = c.env.DEV_MOCK_MODE === 'true';
  if (isDevMode && code !== DEV_MOCK_OTP) {
    return c.json({ error: 'Invalid OTP code. Dev mode requires 123456' }, 400);
  }
  if (!isDevMode) {
    // Production: the code must match the stored hash, be unexpired, and within 5 attempts
    const nowSec = Math.floor(Date.now() / 1000);
    const otp = await c.env.DB
      .prepare('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE phone_number = ?1')
      .bind(phoneNumber)
      .first<{ code_hash: string; expires_at: number; attempts: number }>();
    if (!otp || otp.expires_at < nowSec || otp.attempts >= OTP_MAX_ATTEMPTS) {
      return c.json({ error: 'OTP expired or too many attempts. Request a new code.' }, 400);
    }
    if ((await sha256Hex(`${phoneNumber}:${code}`)) !== otp.code_hash) {
      await c.env.DB.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone_number = ?1').bind(phoneNumber).run();
      return c.json({ error: 'Invalid OTP code' }, 400);
    }
    await c.env.DB.prepare('DELETE FROM otp_codes WHERE phone_number = ?1').bind(phoneNumber).run();
  }

  // Find user by phone number
  let user = await c.env.DB
    .prepare('SELECT id, username, email, phone_number, role FROM users WHERE phone_number = ?1')
    .bind(phoneNumber)
    .first<{ id: string; username: string; email: string; phone_number: string; role: string }>();

  let isNewUser = false;

  if (!user) {
    // Auto-create user on first WhatsApp verification
    isNewUser = true;
    const userId = crypto.randomUUID();
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    const username = `wa_${cleanPhone.slice(-6)}_${Math.floor(Math.random() * 1000)}`;
    const email = `${cleanPhone}@whatsapp.mwar.local`;
    const passwordHash = await hashPassword(crypto.randomUUID());
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, username, email, password_hash, phone_number, referrer_id, role, status, created_at, energy_tickets, max_energy_tickets, last_energy_recharge) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?9)'
      ).bind(userId, username, email, passwordHash, phoneNumber, referrer_id || null, 'player', 'active', now, INITIAL_ENERGY_TICKETS, MAX_ENERGY_TICKETS),
      c.env.DB.prepare(
        'INSERT INTO wallets (user_id, balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, updated_at) VALUES (?1, 0, 0, 0, ?2)'
      ).bind(userId, now),
    ]);

    if (referrer_id) {
      await buildNetworkTree(c.env.DB, userId, referrer_id);
    }

    user = { id: userId, username, email, phone_number: phoneNumber, role: 'player' };
  }

  const token = await signJwt(
    { userId: user.id, username: user.username, role: user.role as 'player' | 'admin' | 'auditor' },
    c.env.JWT_SECRET
  );

  return c.json({
    success: true,
    token,
    user,
    isNewUser,
  });
});

// 6. Telegram Auth (Mock or Real Widget)
authRouter.post('/telegram', async (c) => {
  if (!isLocalDev(c)) return legacyGone(c);
  const body = await c.req.json().catch(() => null);
  const parseResult = TelegramLoginSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { id, username: tgUsername, first_name, phone_number, referrer_id } = parseResult.data;
  const telegramIdStr = id.toString();

  // Production: the Login Widget payload must carry a valid Telegram signature
  if (c.env.DEV_MOCK_MODE !== 'true') {
    if (!c.env.TELEGRAM_BOT_TOKEN || !(await verifyTelegramAuth(body as Record<string, unknown>, c.env.TELEGRAM_BOT_TOKEN))) {
      return c.json({ error: 'Invalid Telegram login signature' }, 401);
    }
  }

  // Find user by Telegram ID
  let user = await c.env.DB
    .prepare('SELECT id, username, email, telegram_id, role FROM users WHERE telegram_id = ?1')
    .bind(telegramIdStr)
    .first<{ id: string; username: string; email: string; telegram_id: string; role: string }>();

  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const userId = crypto.randomUUID();
    const safeUsername = tgUsername || `tg_${telegramIdStr.slice(-6)}`;
    const email = `${telegramIdStr}@telegram.mwar.local`;
    const passwordHash = await hashPassword(crypto.randomUUID());
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, username, email, password_hash, telegram_id, phone_number, referrer_id, role, status, created_at, energy_tickets, max_energy_tickets, last_energy_recharge) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?10)'
      ).bind(userId, safeUsername, email, passwordHash, telegramIdStr, phone_number || null, referrer_id || null, 'player', 'active', now, INITIAL_ENERGY_TICKETS, MAX_ENERGY_TICKETS),
      c.env.DB.prepare(
        'INSERT INTO wallets (user_id, balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, updated_at) VALUES (?1, 0, 0, 0, ?2)'
      ).bind(userId, now),
    ]);

    if (referrer_id) {
      await buildNetworkTree(c.env.DB, userId, referrer_id);
    }

    user = { id: userId, username: safeUsername, email, telegram_id: telegramIdStr, role: 'player' };
  }

  const token = await signJwt(
    { userId: user.id, username: user.username, role: user.role as 'player' | 'admin' | 'auditor' },
    c.env.JWT_SECRET
  );

  return c.json({
    success: true,
    token,
    user,
    isNewUser,
  });
});

// 7. Forgot password: email a single-use reset link (15-minute expiry). Always answers the same way so
//    the endpoint cannot be used to discover which emails are registered.
authRouter.post('/forgot-password', async (c) => {
  const parsed = ForgotPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Please enter a valid email address' }, 400);
  const typed = parsed.data.email;
  const email = typed.toLowerCase();
  const generic = {
    success: true,
    message: 'If an account uses this email, a reset link is on its way. It expires in 15 minutes.',
  } as Record<string, unknown>;

  const user = await c.env.DB
    // Two UNIQUE(email) index lookups (as typed + lower-case) instead of a NOCASE table scan
    .prepare("SELECT id, username, email FROM users WHERE (email = ?1 OR email = ?2) AND status != 'banned' LIMIT 1")
    .bind(typed, email)
    .first<{ id: string; username: string; email: string }>();
  if (!user) return c.json(generic);

  const now = Math.floor(Date.now() / 1000);
  // Resend limiter: one link per account per 60 s (indexed newest-token lookup)
  const recent = await c.env.DB
    .prepare('SELECT created_at FROM password_reset_tokens WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1')
    .bind(user.id)
    .first<{ created_at: number }>();
  if (recent && now - recent.created_at < 60) return c.json(generic);

  const raw = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await c.env.DB.batch([
    // Older unused links stop working as soon as a new one is issued
    c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?1').bind(user.id),
    c.env.DB.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      await sha256Hex(raw),
      user.id,
      now + PASSWORD_RESET_TTL_SECONDS,
      now
    ),
  ]);
  const webOrigin = (c.env.WEB_APP_URL || 'https://mwar.win').replace(/\/+$/, '');
  const link = `${webOrigin}/forgot-password?token=${raw}`;
  const sent = await sendMail(
    c.env,
    user.email,
    'Reset your MWAR password',
    `<p>Hi ${user.username},</p><p>Tap the link below to choose a new password. It expires in 15 minutes and works once.</p>
     <p><a href="${link}">${link}</a></p><p>If you did not ask for this, you can ignore this email.</p>`
  );
  // Local wrangler dev only (never production, even while DEV_MOCK_MODE is on there): hand the link back
  // so the flow can be tested without a mail service. Anywhere else this would allow account takeover.
  if (!sent && isLocalDev(c)) {
    generic.devResetToken = raw;
    generic.devResetLink = link;
  }
  return c.json(generic);
});

// 8. Reset password with the emailed token
authRouter.post('/reset-password', async (c) => {
  const parsed = ResetPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const hash = await sha256Hex(parsed.data.token);
  const row = await c.env.DB
    .prepare('SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?1')
    .bind(hash)
    .first<{ user_id: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < now) {
    return c.json({ error: 'This reset link is invalid or has expired. Please request a new one.' }, 400);
  }
  const passwordHash = await hashPassword(parsed.data.newPassword);
  const res = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL').bind(now, hash),
    c.env.DB.prepare('UPDATE users SET password_hash = ?1, has_password = 1, password_changed_at = ?3 WHERE id = ?2 AND changes() = 1').bind(passwordHash, row.user_id, now),
    c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?1 AND token_hash != ?2').bind(row.user_id, hash),
  ]);
  if ((res[1].meta?.changes ?? 0) !== 1) {
    return c.json({ error: 'This reset link was already used. Please request a new one.' }, 400);
  }
  const user = await c.env.DB.prepare('SELECT username, email FROM users WHERE id = ?1').bind(row.user_id).first<{ username: string; email: string }>();
  // A successful reset also clears the login brute-force counters for this account
  if (user) {
    await c.env.DB
      .prepare('DELETE FROM login_failures WHERE login_key IN (?1, ?2)')
      .bind(user.username.toLowerCase(), user.email.toLowerCase())
      .run()
      .catch(() => {});
  }
  return c.json({ success: true, message: 'Password updated. You can sign in now.' });
});
