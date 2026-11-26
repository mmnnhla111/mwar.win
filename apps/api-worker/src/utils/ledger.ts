import type { D1Database } from '@cloudflare/workers-types';

/**
 * D1 wallet ledger (Layer 1 source of truth). Put the returned statement in the SAME D1 batch,
 * directly after the wallet UPDATE it describes: it only inserts when that UPDATE changed a row
 * (changes() = 1), so a missing wallet or a guarded no-op never leaves a phantom ledger row.
 */
export function ledgerAfterUpdate(db: D1Database, userId: string, deltaMicroUsd: number, actionType: string, refId: string | null, now = Math.floor(Date.now() / 1000)) {
  return db
    .prepare('INSERT INTO wallet_ledger (id, user_id, delta_micro_usd, action_type, ref_id, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1')
    .bind(`led_${crypto.randomUUID()}`, userId, Math.trunc(deltaMicroUsd), actionType, refId ? refId.slice(0, 80) : null, now);
}

/**
 * For a clamped debit `balance = MAX(0, balance − x)`: put this BEFORE the UPDATE; it records exactly
 * what will be taken (−MIN(balance, x)) and nothing when the wallet doesn't exist.
 */
export function ledgerClampedDebit(db: D1Database, userId: string, amountMicroUsd: number, actionType: string, refId: string | null, now = Math.floor(Date.now() / 1000)) {
  return db
    .prepare(
      `INSERT INTO wallet_ledger (id, user_id, delta_micro_usd, action_type, ref_id, created_at)
       SELECT ?1, user_id, -MIN(balance_micro_usd, ?3), ?4, ?5, ?6 FROM wallets WHERE user_id = ?2 AND MIN(balance_micro_usd, ?3) > 0`
    )
    .bind(`led_${crypto.randomUUID()}`, userId, Math.trunc(amountMicroUsd), actionType, refId ? refId.slice(0, 80) : null, now);
}

/** SHA-256 hex of a value with a server-side salt (raw IPs are never stored). */
export async function saltedHash(value: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${value}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Remembers the hashed IP (and device fingerprint, when known) of a signed-in account for Layer 3. */
export async function recordDeviceLink(
  db: D1Database,
  salt: string,
  userId: string,
  ip: string | null | undefined,
  deviceFp?: string | null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows: Array<['ip' | 'fp', string]> = [];
  if (ip) rows.push(['ip', await saltedHash(ip, salt)]);
  if (deviceFp && /^[A-Za-z0-9_-]{16,128}$/.test(deviceFp)) rows.push(['fp', deviceFp]);
  if (!rows.length) return;
  await db
    .batch(
      rows.map(([kind, hash]) =>
        db
          .prepare(
            `INSERT INTO user_device_links (user_id, kind, hash, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(user_id, kind, hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`
          )
          .bind(userId, kind, hash, now)
      )
    )
    .catch((e) => console.warn('recordDeviceLink', e));
}
