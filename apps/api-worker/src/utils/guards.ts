import type { Context } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';

/**
 * Money-minting dev helpers (faucet, simulated ad watch, simulated AI review) are only allowed on a
 * local `wrangler dev` host. DEV_MOCK_MODE alone is not enough, because it is also set on the live
 * Worker (it powers mock OTP login), and must never let anyone credit balances on api.mwar.win.
 */
export function isLocalDev(c: Context<any>): boolean {
  if (c.env?.DEV_MOCK_MODE !== 'true') return false;
  try {
    const host = new URL(c.req.url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Constant-time-ish string compare for shared secrets. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Internal calls (cron, game server) must present the INTERNAL_API_SECRET. */
export function hasInternalSecret(c: Context<any>): boolean {
  const header = c.req.header('X-Internal-Secret') || c.req.header('x-internal-secret');
  return safeEqual(header, c.env.INTERNAL_API_SECRET);
}

/** Current wallet balance (Micro-USD) for audit-log `balance_after_micro_usd`. */
export async function walletBalance(db: D1Database, userId: string): Promise<bigint> {
  const row = await db.prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1').bind(userId).first<{ balance_micro_usd: number }>();
  return BigInt(row?.balance_micro_usd ?? 0);
}

/** Platform account id used for platform-fee / reserve audit entries. */
export const PLATFORM_ACCOUNT_ID = 'SYSTEM_PLATFORM';
