/**
 * test-log-receiver.js
 * Integration test for MWAR Financial Log Receiver & AI Audit Layer 1
 */

async function test() {
  console.log('=== [1] Testing Log Receiver Health ===');
  const healthRes = await fetch('http://localhost:3000/health');
  if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
  const health = await healthRes.json();
  console.log('Health check response:', health);
  if (health.status !== 'ok') throw new Error('Health status is not ok');

  console.log('\n=== [2] Ingesting Single Financial Log (GAME_KILL) ===');
  const testUserId = `user_audit_test_${Date.now()}`;
  const log1 = {
    transaction_id: `tx_kill_${Date.now()}`,
    user_id: testUserId,
    action_type: 'GAME_KILL',
    amount_micro_usd: 100_000, // +$0.10
    balance_after_micro_usd: 100_000,
    source_game_id: 'game_test_1',
  };

  const res1 = await fetch('http://localhost:3000/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(log1),
  });
  if (!res1.ok) throw new Error(`Log 1 failed: ${res1.status}`);
  console.log('Log 1 ingested successfully:', await res1.json());

  console.log('\n=== [3] Ingesting Additional Financial Logs (CHEST_OPEN & CASHOUT_REQUEST) ===');
  const log2 = {
    transaction_id: `tx_chest_${Date.now()}`,
    user_id: testUserId,
    action_type: 'CHEST_OPEN',
    amount_micro_usd: 50_000, // +$0.05
    balance_after_micro_usd: 150_000,
    source_game_id: 'game_test_1',
  };

  const res2 = await fetch('http://localhost:3000/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(log2),
  });
  if (!res2.ok) throw new Error(`Log 2 failed: ${res2.status}`);
  console.log('Log 2 (Chest) ingested successfully:', await res2.json());

  const log3 = {
    transaction_id: `tx_cashout_${Date.now()}`,
    user_id: testUserId,
    action_type: 'CASHOUT_REQUEST',
    amount_micro_usd: 50_000, // -$0.05 outflow
    balance_after_micro_usd: 100_000,
  };

  const res3 = await fetch('http://localhost:3000/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(log3),
  });
  if (!res3.ok) throw new Error(`Log 3 failed: ${res3.status}`);
  console.log('Log 3 (Cashout) ingested successfully:', await res3.json());

  console.log('\n=== [4] Querying User Financial Summary for AI Layer 1 Audit ===');
  const summaryRes = await fetch(`http://localhost:3000/api/logs/summary/${testUserId}`);
  if (!summaryRes.ok) throw new Error(`Summary failed: ${summaryRes.status}`);
  const summary = await summaryRes.json();
  console.log('Financial Summary for AI Audit:', summary);

  // Inflows: 100,000 (Kill) + 50,000 (Chest) = 150,000 ($0.15)
  // Outflows: 50,000 (Cashout) = 50,000 ($0.05)
  // Net Balance: 100,000 ($0.10)
  if (BigInt(summary.calculatedBalanceMicroUsd) !== 100_000n) {
    throw new Error(`Expected net balance 100,000, got ${summary.calculatedBalanceMicroUsd}`);
  }

  console.log('\n🎉 ALL LOG RECEIVER & AI AUDIT LAYER 1 TESTS PASSED 100%!');
}

test().catch((err) => {
  console.error('\n❌ Test Failed:', err);
  process.exit(1);
});
