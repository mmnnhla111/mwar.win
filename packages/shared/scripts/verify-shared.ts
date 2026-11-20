import {
  usdToMicroUsd,
  microUsdToUsd,
  coinsToMicroUsd,
  microUsdToCoins,
  formatMicroUsd,
  calculateMlmDistribution,
} from '../src';

console.log('--- TESTING MICRO-USD INTEGER MATH ---');
// $0.01 = 10,000 Micro-USD = 100 Coins
const oneCentMicroUsd = usdToMicroUsd(0.01);
console.log('usdToMicroUsd(0.01):', oneCentMicroUsd, '(Expected: 10000n)');
if (oneCentMicroUsd !== 10000n) throw new Error('One cent micro-usd failed');

const coinsForOneCent = microUsdToCoins(oneCentMicroUsd);
console.log('microUsdToCoins(10000n):', coinsForOneCent, '(Expected: 100n)');
if (coinsForOneCent !== 100n) throw new Error('Coins conversion failed');

const microUsdFor100Coins = coinsToMicroUsd(100);
console.log('coinsToMicroUsd(100):', microUsdFor100Coins, '(Expected: 10000n)');
if (microUsdFor100Coins !== 10000n) throw new Error('Coins to micro-usd failed');

const tenDollars = usdToMicroUsd(10.00);
console.log('usdToMicroUsd(10.00):', tenDollars, '(Expected: 10000000n)');
console.log('formatMicroUsd(10000000n):', formatMicroUsd(tenDollars));

console.log('\n--- TESTING 5-LEVEL MLM DISTRIBUTION (FULL 5 LEVELS) ---');
// $10.00 USD transaction with all 5 uplines present
const uplinesFull = [
  { userId: 'upline-1', depth: 1 as const },
  { userId: 'upline-2', depth: 2 as const },
  { userId: 'upline-3', depth: 3 as const },
  { userId: 'upline-4', depth: 4 as const },
  { userId: 'upline-5', depth: 5 as const },
];

const fullResult = calculateMlmDistribution(tenDollars, uplinesFull);
console.log('Gross:', fullResult.grossAmountMicroUsd);
console.log('Platform Fee (5%):', fullResult.platformFeeMicroUsd, '(Expected: 500000n)');
console.log('Net Pool (95%):', fullResult.netPoolMicroUsd, '(Expected: 9500000n)');
console.log('Payouts:', fullResult.payouts.map(p => ({
  depth: p.depth,
  userId: p.userId,
  amount: p.amountMicroUsd.toString(),
  formatted: formatMicroUsd(p.amountMicroUsd)
})));
console.log('Platform Reserve:', fullResult.platformReserveMicroUsd);
console.log('Total Distributed:', fullResult.totalDistributedMicroUsd);

if (fullResult.platformFeeMicroUsd !== 500000n) throw new Error('Platform fee incorrect');
if (fullResult.payouts[0].amountMicroUsd !== 4750000n) throw new Error('Level 1 incorrect');
if (fullResult.payouts[1].amountMicroUsd !== 1900000n) throw new Error('Level 2 incorrect');
if (fullResult.payouts[2].amountMicroUsd !== 1425000n) throw new Error('Level 3 incorrect');
if (fullResult.payouts[3].amountMicroUsd !== 950000n) throw new Error('Level 4 incorrect');
if (fullResult.payouts[4].amountMicroUsd !== 475000n) throw new Error('Level 5 incorrect');
if (fullResult.totalDistributedMicroUsd !== tenDollars) throw new Error('Total distribution does not match gross');

console.log('\n--- TESTING 5-LEVEL MLM DISTRIBUTION (PARTIAL UPLINES: ONLY LEVEL 1 & 2) ---');
const uplinesPartial = [
  { userId: 'upline-1', depth: 1 as const },
  { userId: 'upline-2', depth: 2 as const },
];
const partialResult = calculateMlmDistribution(tenDollars, uplinesPartial);
console.log('Partial Payouts:', partialResult.payouts.length, 'recipients');
console.log('Platform Reserve (Levels 3, 4, 5):', partialResult.platformReserveMicroUsd, '(Expected: 2850000n)');
if (partialResult.platformReserveMicroUsd !== 2850000n) throw new Error('Platform reserve incorrect for partial');
if (partialResult.totalDistributedMicroUsd !== tenDollars) throw new Error('Total distributed mismatch');

console.log('\nALL SHARED MATH TESTS PASSED PERFECTLY!');
