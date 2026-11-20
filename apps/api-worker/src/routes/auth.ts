import { Hono } from 'hono';
import {
  RegisterSchema,
  LoginSchema,
  WhatsAppOtpRequestSchema,
  WhatsAppOtpVerifySchema,
  TelegramLoginSchema,
  DEV_MOCK_OTP,
  formatMicroUsd,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { hashPassword, verifyPassword, signJwt } from '../utils/crypto';
import { buildNetworkTree } from '../utils/mlm-tree';
import { authMiddleware } from '../middleware/auth';

export const authRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

// 1. Standard Registration
authRouter.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parseResult = RegisterSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { username, email, password, referrer_id } = parseResult.data;

  // Check unique constraints
  const existing = await c.env.DB
    .prepare('SELECT id, username, email FROM users WHERE username = ?1 OR email = ?2')
    .bind(username, email)
    .first();

  if (existing) {
    return c.json({ error: 'Username or email already in use' }, 409);
  }

  // Verify referrer if provided
  if (referrer_id) {
    const referrer = await c.env.DB
      .prepare('SELECT id FROM users WHERE id = ?1')
      .bind(referrer_id)
      .first();
    if (!referrer) {
      return c.json({ error: 'Referrer ID not found' }, 400);
    }
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);

  // Atomic batch: Create user & Initialize wallet
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO users (id, username, email, password_hash, referrer_id, role, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
    ).bind(userId, username, email, passwordHash, referrer_id || null, 'player', 'active', now),
    c.env.DB.prepare(
      'INSERT INTO wallets (user_id, balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, updated_at) VALUES (?1, 0, 0, 0, ?2)'
    ).bind(userId, now),
  ]);

  // Build MLM 5-level hierarchy
  if (referrer_id) {
    await buildNetworkTree(c.env.DB, userId, referrer_id);
  }

  const token = await signJwt({ userId, username, role: 'player' }, c.env.JWT_SECRET);

  return c.json({
    success: true,
    token,
    user: {
      id: userId,
      username,
      email,
      role: 'player',
      referrer_id: referrer_id || null,
    },
  }, 201);
});

// 2. Standard Login
authRouter.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parseResult = LoginSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { usernameOrEmail, password } = parseResult.data;

  const user = await c.env.DB
    .prepare('SELECT id, username, email, password_hash, role, status FROM users WHERE username = ?1 OR email = ?1')
    .bind(usernameOrEmail)
    .first<{ id: string; username: string; email: string; password_hash: string; role: string; status: string }>();

  if (!user || user.status === 'banned') {
    return c.json({ error: 'Invalid credentials or account suspended' }, 401);
  }

  const isValid = await verifyPassword(password, user.password_hash);
  if (!isValid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

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
    .prepare('SELECT id, username, email, phone_number, telegram_id, referrer_id, role, status, created_at FROM users WHERE id = ?1')
    .bind(authUser.userId)
    .first();

  const wallet = await c.env.DB
    .prepare('SELECT balance_micro_usd, total_earned_micro_usd, total_withdrawn_micro_usd, updated_at FROM wallets WHERE user_id = ?1')
    .bind(authUser.userId)
    .first<{ balance_micro_usd: number; total_earned_micro_usd: number; total_withdrawn_micro_usd: number }>();

  return c.json({
    user,
    wallet: wallet
      ? {
          ...wallet,
          formatted_balance: formatMicroUsd(wallet.balance_micro_usd),
          formatted_total_earned: formatMicroUsd(wallet.total_earned_micro_usd),
        }
      : null,
  });
});

// 4. WhatsApp OTP Request (DEV_MOCK_MODE prints to console)
authRouter.post('/whatsapp/request-otp', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parseResult = WhatsAppOtpRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Invalid phone number format', details: parseResult.error.format() }, 400);
  }

  const { phoneNumber } = parseResult.data;
  const otpCode = c.env.DEV_MOCK_MODE === 'true' ? DEV_MOCK_OTP : Math.floor(100000 + Math.random() * 900000).toString();

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
        'INSERT INTO users (id, username, email, password_hash, phone_number, referrer_id, role, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
      ).bind(userId, username, email, passwordHash, phoneNumber, referrer_id || null, 'player', 'active', now),
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
  const body = await c.req.json().catch(() => null);
  const parseResult = TelegramLoginSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { id, username: tgUsername, first_name, phone_number, referrer_id } = parseResult.data;
  const telegramIdStr = id.toString();

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
        'INSERT INTO users (id, username, email, password_hash, telegram_id, phone_number, referrer_id, role, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)'
      ).bind(userId, safeUsername, email, passwordHash, telegramIdStr, phone_number || null, referrer_id || null, 'player', 'active', now),
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
