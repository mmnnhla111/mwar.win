import {
  AD_SAFETY_MULTIPLIER_DEFAULT_BP,
  AD_SAFETY_MULTIPLIER_MAX_BP,
  AD_SAFETY_MULTIPLIER_MIN_BP,
  COIN_ROUND_UP_FRACTION,
  EC_PROGRESS_BP_PER_TICKET,
} from '../constants';

/**
 * V1.1 currency standard (integers only in storage):
 *   100 C  = $0.01     = 10,000 µUSD
 *   1 C    = $0.0001   = 100 µUSD
 *   0.01 C = $0.000001 = 1 µUSD   → C has exactly 2 decimals, mapped 1:1 onto integer µUSD.
 */
export const MICRO_USD_PER_C = 100;

/** Float noise guard: 0.7 computed as 0.69999999999 still counts as 0.7. */
const ROUND_EPS = 1e-9;

/**
 * Rounding rule on the 3rd decimal of C (the fraction of one µUSD):
 *   fraction ≥ 0.7 µUSD (≥ 0.007 C) → round UP   (Math.ceil)
 *   fraction < 0.7 µUSD (≤ 0.0069 C) → round DOWN (Math.floor)
 * Negative / non-finite input → 0.
 */
export function roundCoinMicroUsd(rawMicroUsd: number): number {
  const raw = Number(rawMicroUsd);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const whole = Math.floor(raw);
  const f = raw - whole;
  return f >= COIN_ROUND_UP_FRACTION - ROUND_EPS ? Math.ceil(raw - ROUND_EPS) : whole;
}

/**
 * Exact integer version for shares: round(V × bps / 10 000) with the same 0.7 rule, no floats.
 * (the remainder r of V×bps / 10 000 is the fraction × 10 000, so f ≥ 0.7 ⇔ r ≥ 7 000)
 */
export function roundCoinShare(valueMicroUsd: bigint, bps: bigint): bigint {
  if (valueMicroUsd <= 0n || bps <= 0n) return 0n;
  const n = valueMicroUsd * bps;
  const q = n / 10_000n;
  const r = n % 10_000n;
  return r >= BigInt(Math.round(COIN_ROUND_UP_FRACTION * 10_000)) ? q + 1n : q;
}

/** Clamp a safety multiplier (basis points) into 9 000 – 9 500 (−10 % … −5 %); bad input → default 9 200. */
export function clampSafetyMultiplierBp(bp: unknown): number {
  const n = Math.round(Number(bp));
  if (!Number.isFinite(n) || n <= 0) return AD_SAFETY_MULTIPLIER_DEFAULT_BP;
  return Math.min(AD_SAFETY_MULTIPLIER_MAX_BP, Math.max(AD_SAFETY_MULTIPLIER_MIN_BP, n));
}

/**
 * Parse a configured multiplier ("0.92", 0.92, "92", "9200") into clamped basis points.
 * Values ≤ 2 are a fraction (0.92, or 1.2 → clamped), ≤ 100 a percentage, anything else basis points.
 */
export function parseSafetyMultiplierBp(v: unknown): number {
  if (v === undefined || v === null || v === '') return AD_SAFETY_MULTIPLIER_DEFAULT_BP;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return AD_SAFETY_MULTIPLIER_DEFAULT_BP;
  const bp = n <= 2 ? n * 10_000 : n <= 100 ? n * 100 : n;
  return clampSafetyMultiplierBp(bp);
}

/**
 * Conservative ad haircut: safe = floor(gross × multiplier) with the multiplier clamped to 0.90–0.95.
 * Always ≤ gross (never > 100 % of the real ad revenue), integer µUSD.
 * `multiplier` may be a fraction (0.92) or basis points (9200).
 */
export function safeAdMicroUsd(grossMicroUsd: number, multiplier: number = AD_SAFETY_MULTIPLIER_DEFAULT_BP): number {
  const gross = Math.floor(Number(grossMicroUsd));
  if (!Number.isFinite(gross) || gross <= 0) return 0;
  const bp = BigInt(parseSafetyMultiplierBp(multiplier));
  const safe = Number((BigInt(gross) * bp) / 10_000n);
  return Math.max(0, Math.min(gross, safe));
}

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "28.50 C" — 2 decimals, thousands separated (1 C = 100 µUSD). */
export function formatCoins2(microUsd: number | bigint): string {
  const v = typeof microUsd === 'bigint' ? microUsd : BigInt(Math.trunc(Number(microUsd) || 0));
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${group((a / 100n).toString())}.${(a % 100n).toString().padStart(2, '0')} C`;
}

/**
 * "$0.0029" — 4 decimals below $1 (round half up on the 4th decimal), 2 decimals from $1.
 * Display only: payouts always use the exact integer µUSD.
 */
export function formatUsdPrecise(microUsd: number | bigint): string {
  const v = typeof microUsd === 'bigint' ? microUsd : BigInt(Math.trunc(Number(microUsd) || 0));
  const neg = v < 0n;
  const a = neg ? -v : v;
  const sign = neg ? '-' : '';
  if (a < 1_000_000n) {
    const t = (a + 50n) / 100n; // units of $0.0001
    return `${sign}$${(t / 10_000n).toString()}.${(t % 10_000n).toString().padStart(4, '0')}`;
  }
  const cents = (a + 5_000n) / 10_000n;
  return `${sign}$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Both units, e.g. 2850 µUSD → "28.50 C ($0.0029)". */
export function formatCoinsAndUsd(microUsd: number | bigint): string {
  return `${formatCoins2(microUsd)} (${formatUsdPrecise(microUsd)})`;
}

/**
 * Ticket minting from EC progress (pure, used by the Worker): adds `addBp` progress and `addMicroUsd`
 * real backing to a user's progress bar (`prevBp`) and pending backing (`prevPending`). Every time the
 * bar reaches 10 000 bp a ticket is minted carrying the pending backing; the backing of a credit that
 * crosses 100 % is split in proportion to the progress on each side, so
 *   sum(minted) + newPending === prevPending + addMicroUsd   (always — nothing is created or lost).
 * When `tickets` reaches `maxTickets` the bar stays below 100 % and the backing keeps accumulating.
 */
export function allocateEcProgress(input: {
  prevBp: number;
  prevPending: number;
  addBp: number;
  addMicroUsd: number;
  tickets: number;
  maxTickets: number;
}): { mintedBacking: number[]; newBp: number; newPending: number; tickets: number } {
  let curBp = Math.max(0, Math.floor(input.prevBp));
  let pending = Math.max(0, Math.floor(input.prevPending));
  let remBp = Math.max(0, Math.round(input.addBp));
  let remMicro = Math.max(0, Math.floor(input.addMicroUsd));
  let tickets = Math.max(0, Math.floor(input.tickets));
  const minted: number[] = [];
  while (tickets < input.maxTickets && curBp + remBp >= EC_PROGRESS_BP_PER_TICKET) {
    const need = Math.max(0, EC_PROGRESS_BP_PER_TICKET - curBp);
    const part = remBp > 0 ? Number((BigInt(remMicro) * BigInt(need)) / BigInt(remBp)) : 0;
    minted.push(pending + part);
    remMicro -= part;
    remBp -= need;
    curBp = 0;
    pending = 0;
    tickets += 1;
  }
  curBp += remBp;
  pending += remMicro;
  if (tickets >= input.maxTickets) curBp = Math.min(curBp, EC_PROGRESS_BP_PER_TICKET - 1);
  return { mintedBacking: minted, newBp: curBp, newPending: pending, tickets };
}
