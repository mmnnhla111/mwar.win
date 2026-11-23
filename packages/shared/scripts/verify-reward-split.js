// Verifies the 100 % reward split: 75 % earner · 15 % uplines (5/4/3/2/1) · 5 % head bounty · 5 % platform.
// Run: pnpm --filter @mwar/shared build && node packages/shared/scripts/verify-reward-split.js
const assert = require('assert');
const { calculateRewardSplit } = require('../dist/index.js');

const ups = (n) => Array.from({ length: n }, (_, i) => ({ userId: `up${i + 1}`, depth: i + 1 }));

// V = $10.00
const full = calculateRewardSplit(10_000_000n, ups(5));
assert.strictEqual(full.earnerMicroUsd, 7_500_000n);
assert.deepStrictEqual(full.uplinePayouts.map((p) => p.amountMicroUsd), [500_000n, 400_000n, 300_000n, 200_000n, 100_000n]);
assert.strictEqual(full.bountyMicroUsd, 500_000n);
assert.strictEqual(full.platformTotalMicroUsd, 500_000n);
assert.strictEqual(full.totalMicroUsd, 10_000_000n);

// Only L1 + L2: L3–L5 (3 % + 2 % + 1 % = 6 %) roll over to the platform → 5 % + 6 % = 11 %
const partial = calculateRewardSplit(10_000_000n, ups(2));
assert.strictEqual(partial.platformTotalMicroUsd, 1_100_000n);
assert.strictEqual(partial.totalMicroUsd, 10_000_000n);

// No uplines: platform gets 5 % + 15 % = 20 %
const none = calculateRewardSplit(100_000n, []);
assert.strictEqual(none.earnerMicroUsd, 75_000n);
assert.strictEqual(none.bountyMicroUsd, 5_000n);
assert.strictEqual(none.platformTotalMicroUsd, 20_000n);

// Rounding dust always lands on the platform; the total is exact for every amount
for (const v of [1n, 7n, 99n, 5_001n, 123_457n, 50_000n]) {
  for (let n = 0; n <= 5; n++) assert.strictEqual(calculateRewardSplit(v, ups(n)).totalMicroUsd, v);
}
console.log('Reward split 75/15/5/5 — all checks passed.');
console.table({
  earner: full.earnerMicroUsd, L1: full.uplinePayouts[0].amountMicroUsd, L2: full.uplinePayouts[1].amountMicroUsd,
  L3: full.uplinePayouts[2].amountMicroUsd, L4: full.uplinePayouts[3].amountMicroUsd, L5: full.uplinePayouts[4].amountMicroUsd,
  headBounty: full.bountyMicroUsd, platform: full.platformTotalMicroUsd,
});
