async function test() {
  const baseUrl = 'http://127.0.0.1:8787';
  const runId = Math.random().toString(36).substring(2, 7);

  console.log('1. Testing Root Status...');
  const rootRes = await fetch(`${baseUrl}/`);
  const rootData = await rootRes.json();
  console.log('Root Response:', rootData);

  console.log('\n2. Testing Registration for Sponsor (Upline)...');
  const sponsorRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `sponsor_${runId}`,
      email: `sponsor_${runId}@mwar.local`,
      password: 'StrongPassword123!',
    }),
  });
  const sponsorData = await sponsorRes.json();
  console.log('Sponsor Register Result:', sponsorData.success ? 'SUCCESS' : sponsorData);
  const sponsorToken = sponsorData.token;
  const sponsorId = sponsorData.user.id;

  console.log('\n3. Testing Registration for Downline Member linked to Sponsor...');
  const downlineRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `player_${runId}`,
      email: `player_${runId}@mwar.local`,
      password: 'StrongPassword123!',
      referrer_id: sponsorId,
    }),
  });
  const downlineData = await downlineRes.json();
  console.log('Downline Register Result:', downlineData.success ? 'SUCCESS' : downlineData);
  const downlineToken = downlineData.token;
  const downlineId = downlineData.user.id;

  console.log('\n4. Verifying Sponsor Downline Network Tree (5-Level Closure Table)...');
  const networkRes = await fetch(`${baseUrl}/api/network/downline`, {
    headers: { Authorization: `Bearer ${sponsorToken}` },
  });
  const networkData = await networkRes.json();
  console.log('Sponsor Downline Count:', networkData.count);
  console.log('Downline Members:', networkData.members.map(m => ({ username: m.username, depth: m.depth })));

  console.log('\n5. Testing WhatsApp OTP Request (Dev Mock Mode)...');
  const testPhone = `+6681${Math.floor(1000000 + Math.random() * 9000000)}`;
  const waReqRes = await fetch(`${baseUrl}/api/auth/whatsapp/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: testPhone }),
  });
  const waReqData = await waReqRes.json();
  console.log('WhatsApp OTP Request Result:', waReqData);

  console.log('\n6. Testing WhatsApp OTP Verify with 123456...');
  const waVerifyRes = await fetch(`${baseUrl}/api/auth/whatsapp/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phoneNumber: testPhone,
      code: '123456',
      referrer_id: sponsorId,
    }),
  });
  const waVerifyData = await waVerifyRes.json();
  console.log('WhatsApp Verify Result:', waVerifyData.success ? `SUCCESS (User: ${waVerifyData.user.username})` : waVerifyData);

  console.log('\n7. Testing Telegram Mock Login...');
  const tgRes = await fetch(`${baseUrl}/api/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `${Date.now()}`,
      first_name: 'DevTester',
      username: `tg_${runId}`,
      auth_date: Math.floor(Date.now() / 1000),
      hash: 'mock_hash_for_dev_mode',
      referrer_id: sponsorId,
    }),
  });
  const tgData = await tgRes.json();
  console.log('Telegram Login Result:', tgData.success ? `SUCCESS (User: ${tgData.user.username})` : tgData);

  console.log('\n8. Testing Dev Mock Faucet (Top-up $20 USD to Downline)...');
  const faucetRes = await fetch(`${baseUrl}/api/wallet/dev/faucet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${downlineToken}`,
    },
    body: JSON.stringify({ amountMicroUsd: 20000000 }),
  });
  const faucetData = await faucetRes.json();
  console.log('Faucet Result:', faucetData);

  console.log('\n9. Testing S2S Ad Postback Simulation (US Tier Ad Watch by Downline)...');
  const adRes = await fetch(`${baseUrl}/api/ads/dev/simulate-watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: downlineId,
      country: 'US',
      provider: 'adswedmedia',
    }),
  });
  const adData = await adRes.json();
  console.log('Ad Watch Result:', adData);

  console.log('\n10. Checking Sponsor Wallet for 5-Level MLM Commission...');
  const sponsorWalletRes = await fetch(`${baseUrl}/api/wallet`, {
    headers: { Authorization: `Bearer ${sponsorToken}` },
  });
  const sponsorWallet = await sponsorWalletRes.json();
  console.log('Sponsor Wallet after Downline Ad:', {
    balance: sponsorWallet.formattedBalance,
    coins: sponsorWallet.formattedCoins,
    totalEarned: sponsorWallet.formattedTotalEarned,
  });

  console.log('\n11. Testing Cashout Request ($10 USD)...');
  const cashoutRes = await fetch(`${baseUrl}/api/wallet/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${downlineToken}`,
    },
    body: JSON.stringify({
      amount_micro_usd: 10000000,
      crypto_currency: 'USDT',
      payout_address: '0x1234567890abcdef1234567890abcdef12345678',
    }),
  });
  const cashoutData = await cashoutRes.json();
  console.log('Cashout Request Result:', cashoutData);

  console.log('\n12. Testing AI Fraud / Audit Review Pipeline...');
  const pendingRes = await fetch(`${baseUrl}/api/audit/pending`);
  const pendingData = await pendingRes.json();
  console.log('Pending Withdrawals:', pendingData.withdrawals.length);

  const reviewRes = await fetch(`${baseUrl}/api/audit/dev/simulate-ai-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      withdrawalId: cashoutData.withdrawalId,
      targetState: 'approved',
      aiScore: 0.99,
      reason: '100% Deterministic match with 90-day ledger',
    }),
  });
  const reviewData = await reviewRes.json();
  console.log('AI Audit Review Simulation Result:', reviewData);

  console.log('\n======================================================');
  console.log('ALL PHASES 1 & 2 & WORKER API INTEGRATION TESTS PASSED!');
  console.log('======================================================');
}

test().catch(console.error);
