/**
 * End-to-End Verification Test for Daily Quests & Proof-of-Activity MLM Unlock Engine
 */

async function runTest() {
  const baseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:8787';
  const runId = Math.random().toString(36).substring(2, 7);
  console.log(`================================================================`);
  console.log(`[TEST SUITE] Daily Quests & Grey-to-Green MLM Unlock Engine`);
  console.log(`Run ID: ${runId}`);
  console.log(`API Base: ${baseUrl}`);
  console.log(`================================================================\n`);

  function assert(condition, message) {
    if (!condition) {
      console.error(`❌ FAILED: ${message}`);
      process.exit(1);
    }
    console.log(`  ✅ PASS: ${message}`);
  }

  // --------------------------------------------------------------------------
  // STEP 1: Register Sponsor A (Active Warrior)
  // --------------------------------------------------------------------------
  console.log(`[STEP 1] Registering Sponsor A (Active)...`);
  const sponsorRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `spA_${runId}`,
      email: `spA_${runId}@mwar.local`,
      password: 'Password123!',
    }),
  });
  const sponsorData = await sponsorRes.json();
  assert(sponsorData.success, 'Sponsor A registered successfully');
  const spToken = sponsorData.token;
  const spId = sponsorData.user.id;

  // --------------------------------------------------------------------------
  // STEP 2: Register Downline B linked to Sponsor A
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 2] Registering Downline B (Referrer = Sponsor A)...`);
  const downlineRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `downB_${runId}`,
      email: `downB_${runId}@mwar.local`,
      password: 'Password123!',
      referrer_id: spId,
    }),
  });
  const downlineData = await downlineRes.json();
  assert(downlineData.success, 'Downline B registered successfully with referrer Sponsor A');
  const downBId = downlineData.user.id;

  // --------------------------------------------------------------------------
  // STEP 3: Downline B earns ad revenue (US Tier: $0.05, L1 MLM = 5% = 2,500 Micro-USD)
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 3] Downline B triggers AdswedMedia S2S Ad Postback (US Tier)...`);
  const adRes = await fetch(`${baseUrl}/api/ads/postback/adswedmedia?user_id=${downBId}&country=US`);
  const adData = await adRes.json();
  assert(adData.success, `Ad reward processed for Downline B (${adData.formattedReward})`);

  // --------------------------------------------------------------------------
  // STEP 4: Verify Sponsor A Daily MLM shows GREY (LOCKED)
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 4] Checking Sponsor A Daily MLM Summary (Expect GREY / LOCKED)...`);
  const mlmResBefore = await fetch(`${baseUrl}/api/wallet/daily-mlm-summary`, {
    headers: { Authorization: `Bearer ${spToken}` },
  });
  const mlmBefore = await mlmResBefore.json();
  console.log('  Sponsor A MLM Status:', mlmBefore);
  assert(mlmBefore.isUnlocked === false, 'Sponsor A MLM is LOCKED (Grey)');
  assert(mlmBefore.pendingGreyMicroUsd > 0, `Pending Grey Micro-USD is ${mlmBefore.pendingGreyMicroUsd} (> 0)`);
  assert(mlmBefore.unlockedGreenMicroUsd === 0, 'Unlocked Green Micro-USD is 0');
  assert(mlmBefore.completedQuestsCount === 0, 'Completed Quests Count is 0 (< 4)');

  // --------------------------------------------------------------------------
  // STEP 5: Verify Sponsor A Daily Quests List
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 5] Inspecting Sponsor A Daily Quests Definition & Progress...`);
  const questsResBefore = await fetch(`${baseUrl}/api/quests/today`, {
    headers: { Authorization: `Bearer ${spToken}` },
  });
  const questsBefore = await questsResBefore.json();
  assert(questsBefore.totalQuests >= 5, `Found ${questsBefore.totalQuests} daily quests`);
  assert(questsBefore.isMlmUnlocked === false, 'TodayQuestsResponse isMlmUnlocked is false');

  // --------------------------------------------------------------------------
  // STEP 6: Sponsor A Completes 4 Daily Quests to Qualify
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 6] Sponsor A completing 4 daily quests...`);

  // Quest 1: Q_DAILY_CHECKIN (Claim directly)
  console.log('  -> Completing Quest 1: Q_DAILY_CHECKIN...');
  const q1Res = await fetch(`${baseUrl}/api/quests/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spToken}` },
    body: JSON.stringify({ questId: 'Q_DAILY_CHECKIN' }),
  });
  const q1Data = await q1Res.json();
  assert(q1Data.success, `Check-in claimed! (+${q1Data.rewardCoins} Coins)`);

  // Quest 2: Q_SPECTATE (Spectate for 90s)
  console.log('  -> Completing Quest 2: Q_SPECTATE (90s)...');
  const q2Res = await fetch(`${baseUrl}/api/quests/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spToken}` },
    body: JSON.stringify({ questId: 'Q_SPECTATE', increment: 90 }),
  });
  const q2Data = await q2Res.json();
  assert(q2Data.isCompleted, 'Q_SPECTATE completed');

  // Quest 3: Q_PLAY_MATCH (Play 3 matches)
  console.log('  -> Completing Quest 3: Q_PLAY_MATCH (3 matches)...');
  const q3Res = await fetch(`${baseUrl}/api/quests/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spToken}` },
    body: JSON.stringify({ questId: 'Q_PLAY_MATCH', increment: 3 }),
  });
  const q3Data = await q3Res.json();
  assert(q3Data.isCompleted, 'Q_PLAY_MATCH completed');

  // Quest 4: Q_WATCH_AD (Watch 2 ads) -> 4th Quest: Triggers MLM UNLOCK!
  console.log('  -> Completing Quest 4: Q_WATCH_AD (2 ads) -> Triggers MLM Unlock...');
  const q4Res = await fetch(`${baseUrl}/api/quests/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spToken}` },
    body: JSON.stringify({ questId: 'Q_WATCH_AD', increment: 2 }),
  });
  const q4Data = await q4Res.json();
  assert(q4Data.isCompleted, 'Q_WATCH_AD completed');
  assert(q4Data.isMlmUnlocked, 'Q_WATCH_AD response confirms isMlmUnlocked = true');

  // --------------------------------------------------------------------------
  // STEP 7: Verify Sponsor A Daily MLM transitioned to GREEN (UNLOCKED)
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 7] Verifying Sponsor A Daily MLM transitioned from GREY to GREEN...`);
  const mlmResAfter = await fetch(`${baseUrl}/api/wallet/daily-mlm-summary`, {
    headers: { Authorization: `Bearer ${spToken}` },
  });
  const mlmAfter = await mlmResAfter.json();
  console.log('  Sponsor A MLM Status After 4 Quests:', mlmAfter);
  assert(mlmAfter.isUnlocked === true, 'Sponsor A MLM is now UNLOCKED (Green)');
  assert(mlmAfter.pendingGreyMicroUsd === 0, 'Pending Grey Micro-USD is now 0');
  assert(mlmAfter.unlockedGreenMicroUsd > 0, `Unlocked Green Micro-USD is ${mlmAfter.unlockedGreenMicroUsd} (> 0)`);
  assert(mlmAfter.completedQuestsCount >= 4, `Completed Quests Count is ${mlmAfter.completedQuestsCount} (>= 4)`);

  // --------------------------------------------------------------------------
  // STEP 8: Create Sponsor C (Inactive) with Downline D to test FORFEIT / BURN
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 8] Setting up Inactive Sponsor C & Downline D (Inactivity Forfeiture Test)...`);
  const spCRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `spC_${runId}`,
      email: `spC_${runId}@mwar.local`,
      password: 'Password123!',
    }),
  });
  const spCData = await spCRes.json();
  const spCToken = spCData.token;
  const spCId = spCData.user.id;

  const downDRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `downD_${runId}`,
      email: `downD_${runId}@mwar.local`,
      password: 'Password123!',
      referrer_id: spCId,
    }),
  });
  const downDData = await downDRes.json();
  const downDId = downDData.user.id;

  // Downline D generates revenue for Sponsor C
  await fetch(`${baseUrl}/api/ads/postback/adswedmedia?user_id=${downDId}&country=US`);

  // Verify Sponsor C has pending grey and completed 0 quests
  const mlmCRes = await fetch(`${baseUrl}/api/wallet/daily-mlm-summary`, {
    headers: { Authorization: `Bearer ${spCToken}` },
  });
  const mlmC = await mlmCRes.json();
  assert(mlmC.isUnlocked === false, 'Sponsor C MLM is LOCKED (Grey)');
  assert(mlmC.pendingGreyMicroUsd > 0, 'Sponsor C has pending grey commissions');

  // --------------------------------------------------------------------------
  // STEP 9: Trigger Midnight Daily MLM Settlement Cron (/api/cron/settle-daily-mlm)
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 9] Triggering Midnight MLM Settlement Cron (/api/cron/settle-daily-mlm)...`);
  const settleRes = await fetch(`${baseUrl}/api/cron/settle-daily-mlm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const settleData = await settleRes.json();
  console.log('  Settlement Result:', settleData);
  assert(settleData.success, 'Settlement executed successfully');
  assert(settleData.settledUsersCount >= 1, `Settled at least 1 user (Count: ${settleData.settledUsersCount})`);
  assert(settleData.forfeitedUsersCount >= 1, `Forfeited at least 1 user (Count: ${settleData.forfeitedUsersCount})`);

  // --------------------------------------------------------------------------
  // STEP 10: Verify Sponsor A Balance Credited (settled_paid)
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 10] Verifying Sponsor A Main Wallet credited with settled MLM earnings...`);
  const walletARes = await fetch(`${baseUrl}/api/wallet`, {
    headers: { Authorization: `Bearer ${spToken}` },
  });
  const walletA = await walletARes.json();
  console.log('  Sponsor A Final Wallet:', walletA);
  assert(walletA.balanceMicroUsd >= mlmAfter.unlockedGreenMicroUsd, 'Sponsor A wallet balance reflects credited unlocked MLM earnings');

  // --------------------------------------------------------------------------
  // STEP 11: Verify Sponsor C Inactive MLM was FORFEITED / BURNED
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 11] Verifying Sponsor C Inactive MLM was burned as forfeited_burned...`);
  const mlmCAfter = await (await fetch(`${baseUrl}/api/wallet/daily-mlm-summary`, {
    headers: { Authorization: `Bearer ${spCToken}` },
  })).json();
  console.log('  Sponsor C MLM Status After Settlement:', mlmCAfter);
  assert(mlmCAfter.pendingGreyMicroUsd === 0, 'Sponsor C pending grey is now 0');
  assert(mlmCAfter.forfeitedMicroUsd > 0, `Sponsor C forfeitedMicroUsd is ${mlmCAfter.forfeitedMicroUsd} (> 0)`);

  const walletC = await (await fetch(`${baseUrl}/api/wallet`, {
    headers: { Authorization: `Bearer ${spCToken}` },
  })).json();
  console.log('  Sponsor C Final Wallet:', walletC);
  assert(walletC.balanceMicroUsd === 0, 'Sponsor C wallet balance remained 0 (forfeited due to inactivity)');

  // --------------------------------------------------------------------------
  // STEP 12: Verify User Profile Update (Avatar <= 512 KB & Username Rename)
  // --------------------------------------------------------------------------
  console.log(`\n[STEP 12] Testing User Profile Update (Avatar & Username with rename counter)...`);
  const profileRes = await fetch(`${baseUrl}/api/auth/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spToken}` },
    body: JSON.stringify({
      username: `spA_elite_${runId}`,
      avatarUrl: '/images/avatar_2.svg',
    }),
  });
  const profileData = await profileRes.json();
  assert(profileData.success, 'Profile updated successfully');
  assert(profileData.user.username === `spA_elite_${runId}`, 'Username updated to new name');
  assert(profileData.user.avatar_url === '/images/avatar_2.svg', 'Avatar URL updated to avatar_2.svg');
  assert(profileData.remainingRenames === 2, 'Remaining renames decremented to 2');

  console.log(`\n================================================================`);
  console.log(`🎉 ALL 12 VERIFICATION SUITES PASSED WITH ZERO ERRORS!`);
  console.log(`- Downline MLM Locked (Grey) on earning`);
  console.log(`- 4 Daily Quests turn MLM status to Glowing Green (Unlocked)`);
  console.log(`- Midnight Cron Settles Active Users -> Main Wallet Credited`);
  console.log(`- Inactive Users Forfeited & Burned -> Absorb to System Reserve`);
  console.log(`- Profile & Avatar update validated`);
  console.log(`================================================================\n`);
}

runTest().catch((err) => {
  console.error('Test Execution Error:', err);
  process.exit(1);
});
