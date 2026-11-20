import { MICRO_USD_PER_USD, MICRO_USD_PER_COIN, COINS_PER_CENT, MICRO_USD_PER_CENT } from '../constants';

/**
 * Normalizes input to BigInt Micro-USD safely.
 */
export function toMicroUsdBigInt(val: bigint | number | string): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') {
    // If it's an integer string
    if (/^-?\d+$/.test(val.trim())) {
      return BigInt(val.trim());
    }
    // If it's a decimal string (like "10.50"), convert to micro-usd
    const parsed = parseFloat(val);
    if (isNaN(parsed)) throw new Error(`Invalid numeric input: ${val}`);
    return BigInt(Math.round(parsed * 1_000_000));
  }
  if (typeof val === 'number') {
    return BigInt(Math.round(val));
  }
  throw new Error(`Unsupported type for toMicroUsdBigInt: ${typeof val}`);
}

/**
 * Converts USD amount (float or string) to Integer Micro-USD.
 * e.g. 10.50 USD -> 10,500,000 Micro-USD
 */
export function usdToMicroUsd(usd: number | string): bigint {
  const num = typeof usd === 'string' ? parseFloat(usd) : usd;
  if (isNaN(num)) throw new Error(`Invalid USD amount: ${usd}`);
  // Round to nearest integer Micro-USD to eliminate float representation issues
  return BigInt(Math.round(num * 1_000_000));
}

/**
 * Converts Integer Micro-USD to standard USD float.
 * e.g. 10,500,000 Micro-USD -> 10.50 USD
 */
export function microUsdToUsd(microUsd: bigint | number | string): number {
  const b = toMicroUsdBigInt(microUsd);
  return Number(b) / 1_000_000;
}

/**
 * Converts In-Game Coins to Micro-USD.
 * Specification: $0.01 USD (10,000 Micro-USD) = 100 Coins.
 * Therefore: 1 Coin = 100 Micro-USD.
 */
export function coinsToMicroUsd(coins: bigint | number | string): bigint {
  const c = typeof coins === 'bigint' ? coins : BigInt(Math.floor(Number(coins)));
  return c * MICRO_USD_PER_COIN;
}

/**
 * Converts Micro-USD to In-Game Coins.
 * 10,000 Micro-USD ($0.01) -> 100 Coins.
 */
export function microUsdToCoins(microUsd: bigint | number | string): bigint {
  const b = toMicroUsdBigInt(microUsd);
  return b / MICRO_USD_PER_COIN;
}

/**
 * Formats Micro-USD as human-readable USD string (e.g. "$12.34").
 */
export function formatMicroUsd(microUsd: bigint | number | string): string {
  const b = toMicroUsdBigInt(microUsd);
  const isNegative = b < 0n;
  const abs = isNegative ? -b : b;
  const whole = abs / MICRO_USD_PER_USD;
  const frac = abs % MICRO_USD_PER_USD;
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2); // 2 decimal digits
  return `${isNegative ? '-' : ''}$${whole.toString()}.${fracStr}`;
}

/**
 * Formats Micro-USD as Coins string (e.g. "1,250 Coins").
 */
export function formatCoins(microUsd: bigint | number | string): string {
  const coins = microUsdToCoins(microUsd);
  return `${coins.toLocaleString()} Coins`;
}

/**
 * Safe addition of Micro-USD values.
 */
export function addMicroUsd(a: bigint | number | string, b: bigint | number | string): bigint {
  return toMicroUsdBigInt(a) + toMicroUsdBigInt(b);
}

/**
 * Safe subtraction of Micro-USD values.
 * Optional enforceNonNegative flag prevents negative balances.
 */
export function subMicroUsd(
  a: bigint | number | string,
  b: bigint | number | string,
  enforceNonNegative = true
): bigint {
  const res = toMicroUsdBigInt(a) - toMicroUsdBigInt(b);
  if (enforceNonNegative && res < 0n) {
    throw new Error(`Insufficient funds: result would be negative (${res.toString()} Micro-USD)`);
  }
  return res;
}
