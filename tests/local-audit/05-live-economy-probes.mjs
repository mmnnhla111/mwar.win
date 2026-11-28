/**
 * 05-live-economy-probes.mjs — LOCAL-ONLY probes of the V1.2 Round C live economy (needs the local api-worker + game
 * server started by run-local-audit.mjs). Every probe measures the money it touches straight in the isolated D1:
 *   1. spectator gifts: 70 / 30, atomic debit (never below 0), idempotent client request id, parallel spend race,
 *      Worker-signed gift token → game-server broadcast once (forged / replayed tokens refused)
 *   2. launch promo codes: cap per code, 1 per user, 1 per device, backing drawn from the marketing pool (fails cleanly)
 *   3. P2P skin market: listing floor 50 C, two buyers racing for one listing → exactly one sale, 90 / 10 split
 *   4. Happy Hour 2x: the extra comes from the Boss Bounty Pool only when it covers it (else 1x), once per payout
 *   5. cold-start bot bounties: reservations never exceed the pool, paid / returned exactly once; live room spawns
 *      bots, bots never earn, every reservation is returned when the room closes
 *   6. Streamer Room: Silver I+ only; streamer gets 40 % of the VERIFIED net value of a viewer's ad in the room (0 for
 *      an unverified timer claim); the system grows by exactly the verified gross
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { ROOT, SECRETS, GAME_WS, call, check, note, results, signup, sql1, sql, sqlFile, sleep, colyseus } from './lib.mjs';

const SEC = 'live';
const RUN = Date.now().toString(36);
const S = await import(pathToFileURL(path.join(ROOT, 'packages/shared/dist/index.mjs')).href);
console.log('\n── 05 live economy probes (V1.2 Round C) ──');
const heartbeat = () => call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${SECRETS.INTERNAL_API_SECRET}` }, body: { nodeId: `audit-live-${RUN}`, role: 'game' } });
await heartbeat();
const hb = setInterval(() => heartbeat().catch(() => {}), 20_000);

/** Every place money can sit (same parts as 02's moneySnapshot, incl. the V1.2 C marketing pool + bot reservations). */
function total() {
  const r = sqlFile([
    'SELECT COALESCE(SUM(balance_micro_usd),0) AS bal, COALESCE(SUM(bounty_micro_usd),0) AS bty, SUM(CASE WHEN balance_micro_usd < 0 THEN 1 ELSE 0 END) AS neg FROM wallets;',
    "SELECT platform_micro_usd AS pl, energy_pool_micro_usd - energy_pool_drawn_micro_usd AS pool, boss_bounty_pool_micro_usd AS boss, safety_reserve_micro_usd AS safety, marketing_pool_micro_usd AS mk FROM system_balances WHERE id = 'global';",
    'SELECT COALESCE(SUM(pending_ec_micro_usd),0) AS pend FROM users;',
    "SELECT COALESCE(SUM(CASE WHEN status IN ('available','in_match') THEN backed_micro_usd ELSE 0 END),0) AS live FROM user_energy_tickets;",
    "SELECT COALESCE(SUM(amount_micro_usd),0) AS mlm FROM daily_mlm_pending_ledger WHERE status IN ('pending_grey','unlocked_green');",
    "SELECT COALESCE(SUM(micro_usd),0) AS fm FROM fast_mini_pot_credits WHERE status = 'open';",
    "SELECT COALESCE(SUM(amount_micro_usd),0) AS wd FROM withdrawal_requests WHERE status NOT IN ('rejected');",
    "SELECT COALESCE(SUM(amount_micro_usd),0) AS res FROM boss_bounty_reservations WHERE status = 'reserved';",
    "SELECT COALESCE(SUM(amount_micro_usd),0) AS res FROM bot_bounty_reservations WHERE status = 'reserved';",
  ]).map((x) => x.results[0] || {});
  const [w, s, u, t, m, f, wd, br, bt] = r;
  const parts = { wallets: +w.bal, bounties: +w.bty, platform: +s.pl, energyPool: +s.pool, boss: +s.boss, safety: +s.safety, marketing: +s.mk, pending: +u.pend, tickets: +t.live, mlm: +m.mlm, fm: +f.fm, wd: +wd.wd, bossRes: +br.res, botRes: +bt.res };
  return { ...parts, sum: Object.values(parts).reduce((a, b) => a + b, 0), neg: +w.neg || 0 };
}
const bal = (id) => Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${id}'`).b || 0);
const sys = () => sql1("SELECT boss_bounty_pool_micro_usd AS boss, marketing_pool_micro_usd AS mk, platform_micro_usd AS pl FROM system_balances WHERE id = 'global'");
const faucet = (u, x) => call('/api/wallet/dev/faucet', { method: 'POST', token: u.token, body: { amountMicroUsd: x } });
const fp = () => crypto.randomBytes(16).toString('hex');
const enter = (u, body = { mode: 'standard_100' }) => call('/api/game/enter', { method: 'POST', token: u.token, body });
const batch = (gameId, payouts) => call('/api/game/batch-payout', { method: 'POST', body: { gameId, timestamp: Math.floor(Date.now() / 1000), secret: SECRETS.INTERNAL_API_SECRET, payouts } });
const fund = async (u, n = 6, price = '0.0090') => {
  for (let i = 0; i < n; i++) await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: u.id, geo: 'US', estimated_price: price, click_id: `au5_${RUN}_${u.username}_${i}` })}`);
};

// ---- setup: super_admin + live ads -------------------------------------------------------------------------------
const ops = await signup(`au${RUN}ops5`);
sqlFile([`UPDATE users SET staff_role = 'super_admin' WHERE id = '${ops.id}';`]);
{
  const banner = (k) => `<script>atOptions = {'key' : '${k}','format' : 'iframe','height' : 50,'width' : 320,'params' : {}};</script><script src="https://www.highperformanceformat.com/${k}/invoke.js"></script>`;
  const cfg = await call('/api/admin/ads/config', { method: 'PUT', token: ops.token, body: { adMode: 'live', adsterraEnabled: true, adsterraBanner320x50: banner('0123456789abcdef0123456789abcdef'), monetagEnabled: true, monetagDirectLinkUrl: 'https://example.invalid/direct-link' } });
  check(SEC, 'setup: super_admin + live ads', cfg.status === 200, `${cfg.status}`);
}
const { Client } = colyseus();

// ---- 1. Spectator gifts --------------------------------------------------------------------------------------------
{
  const P = await signup(`au${RUN}gP`); // the watched player
  const G = await signup(`au${RUN}gS`); // the spectator who gifts
  const poor = await signup(`au${RUN}gZ`);
  await fund(P, 2);
  const e = await enter(P);
  const cp = new Client(GAME_WS, { headers: { 'cf-connecting-ip': '10.251.0.1' } });
  let rp, rs;
  try {
    rp = await cp.joinOrCreate('standard_100', { entryToken: e.body.entryToken, deviceId: `live-p-${RUN}` });
  } catch (err) {
    check(SEC, 'gift setup: watched player joined a paid room', false, String(err?.message || err));
  }
  if (rp) {
    // the room reports the live session within one 10 s flush
    let row = null;
    for (let i = 0; i < 30 && !row?.ok; i++) {
      await sleep(1000);
      row = sql1(`SELECT 1 AS ok FROM game_active_sessions WHERE user_id = '${P.id}' AND room_id = '${rp.roomId}'`);
    }
    check(SEC, 'gift setup: the watched player has a live session in the room', !!row?.ok, `room ${rp.roomId}`);
    const vt = await call('/api/game/viewer-token', { token: G.token });
    const cs = new Client(GAME_WS, { headers: { 'cf-connecting-ip': '10.251.0.2' } });
    rs = await cs.joinById(rp.roomId, { spectator: true, viewerToken: vt.body.viewerToken, deviceId: `live-s-${RUN}` });
    const seen = [];
    rp.onMessage('spectator_gift', (m) => seen.push(m));
    const giftResults = [];
    rs.onMessage('spectator_gift', () => {});
    rs.onMessage('gift_result', (m) => giftResults.push(m));
    rs.onMessage('room_chat_refused', () => {});

    await faucet(G, 25_000); // 250 C
    const t0 = total();
    const b0 = { g: bal(G.id), p: bal(P.id), pl: Number(sys().pl) };
    const body = { giftCode: 'golden_grenade_100', roomId: rp.roomId, receiverUserId: P.id, clientRequestId: `req_${RUN}_once` };
    const [x1, x2] = await Promise.all([call('/api/gifts/send', { method: 'POST', token: G.token, body }), call('/api/gifts/send', { method: 'POST', token: G.token, body })]);
    const x3 = await call('/api/gifts/send', { method: 'POST', token: G.token, body });
    const b1 = { g: bal(G.id), p: bal(P.id), pl: Number(sys().pl) };
    const t1 = total();
    const ids = new Set([x1, x2, x3].filter((r) => r.status === 200).map((r) => r.body.giftId));
    const led = sql(`SELECT action_type AS a, delta_micro_usd AS d, user_id AS u FROM wallet_ledger WHERE ref_id IN (${[...ids].map((i) => `'${i}'`).join(',') || "''"})`);
    check(
      SEC,
      'gift idempotency: the same client request id (2 parallel + 1 retry) charges ONE Golden Grenade — 100 C out, 70 C to the player, 30 C platform; Δsystem 0',
      ids.size === 1 && b0.g - b1.g === 10_000 && b1.p - b0.p === 7_000 && b1.pl - b0.pl === 3_000 && t1.sum === t0.sum && led.length === 2,
      `HTTP ${x1.status}/${x2.status}/${x3.status} · gifts ${ids.size} · sender −${b0.g - b1.g} · player +${b1.p - b0.p} · platform +${b1.pl - b0.pl} · ledger rows ${led.length} · Δsystem ${t1.sum - t0.sum}`
    );
    // forward the token: broadcast once; replay + forged tokens refused
    const tok = (x1.status === 200 ? x1 : x2).body.giftToken;
    rs.send('spectator_gift', { token: tok });
    await sleep(600);
    rs.send('spectator_gift', { token: tok });
    const parts = String(tok).split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[0], 'base64url').toString()), gid: `gft_${crypto.randomUUID()}`, gc: 'champion_crown_500' })).toString('base64url');
    rs.send('spectator_gift', { token: `${forgedBody}.${parts[1]}` });
    await sleep(1200);
    check(
      SEC,
      'gift token: the game server broadcasts a Worker-signed gift once; a replayed or forged token is refused (no client claim is trusted)',
      seen.length === 1 && seen[0].giftCode === 'golden_grenade_100' && seen[0].targetUserId === P.id && giftResults.filter((r) => r.ok).length === 1 && giftResults.filter((r) => !r.ok).length === 2,
      `broadcasts ${seen.length} · results ${JSON.stringify(giftResults.map((r) => r.reason || 'ok'))}`
    );
    // parallel spend race: 150 C left → of 5 different 50 C... (crown is 500 C) → give 1,100 C and race 3 crowns
    await faucet(G, 100_000 - bal(G.id) + 10_000); // balance = 1,100 C
    const g0 = bal(G.id);
    const t2 = total();
    const race = await Promise.all([1, 2, 3].map((i) => call('/api/gifts/send', { method: 'POST', token: G.token, body: { giftCode: 'champion_crown_500', roomId: rp.roomId, receiverUserId: P.id, clientRequestId: `req_${RUN}_race${i}` } })));
    const ok = race.filter((r) => r.status === 200).length;
    const g1 = bal(G.id);
    const t3 = total();
    check(
      SEC,
      'gift atomicity: 3 parallel 500 C crowns with 1,100 C → exactly 2 paid, the 3rd refused, balance never below 0, Δsystem 0',
      ok === 2 && g0 - g1 === 100_000 && g1 >= 0 && t3.neg === 0 && t3.sum === t2.sum,
      `HTTP ${race.map((r) => r.status).join(',')} · sender ${g0} → ${g1} · Δsystem ${t3.sum - t2.sum}`
    );
    const self = await call('/api/gifts/send', { method: 'POST', token: P.token, body: { ...body, receiverUserId: P.id, clientRequestId: `req_${RUN}_self` } });
    const broke = await call('/api/gifts/send', { method: 'POST', token: poor.token, body: { ...body, giftCode: 'champion_crown_500', clientRequestId: `req_${RUN}_poor` } });
    const notIn = await call('/api/gifts/send', { method: 'POST', token: G.token, body: { ...body, receiverUserId: poor.id, clientRequestId: `req_${RUN}_notin` } });
    check(SEC, 'gift guards: self-gift 400 · empty wallet 402 (nothing charged) · receiver not playing in the room 409', self.status === 400 && broke.status === 402 && notIn.status === 409 && bal(poor.id) === 0, `${self.status}/${broke.status}/${notIn.status}`);
    // Ammo Box: needs a CLAIMED ad visit of the spectator; one box per visit, 0 money
    const dl = await call('/api/ads/direct-link/start', { method: 'POST', token: G.token, body: { purpose: 'ec_recharge', seconds: 15 } });
    const noAd = await call('/api/gifts/ammo-box', { method: 'POST', token: G.token, body: { roomId: rp.roomId, receiverUserId: P.id, adToken: dl.body.token } });
    await sleep(15_500);
    const claim = await call('/api/ads/direct-link/claim', { method: 'POST', token: G.token, body: { token: dl.body.token } });
    const t4 = total();
    const a1 = await call('/api/gifts/ammo-box', { method: 'POST', token: G.token, body: { roomId: rp.roomId, receiverUserId: P.id, adToken: dl.body.token } });
    const a2 = await call('/api/gifts/ammo-box', { method: 'POST', token: G.token, body: { roomId: rp.roomId, receiverUserId: P.id, adToken: dl.body.token } });
    const t5 = total();
    check(
      SEC,
      'Ammo Box: refused before the ad is claimed; one box per claimed visit (retry = same gift), moves 0 µUSD; the timer claim itself credited EC % only (0 backing)',
      noAd.status === 402 && claim.status === 200 && Number(claim.body.ecBackingMicroUsd ?? 0) === 0 && a1.status === 200 && a2.status === 200 && a1.body.giftId === a2.body.giftId && t5.sum === t4.sum,
      `before claim ${noAd.status} · claim ${claim.status} (backing ${claim.body.ecBackingMicroUsd}) · boxes ${a1.body.giftId === a2.body.giftId ? 'same id' : 'different'} · Δsystem ${t5.sum - t4.sum}`
    );
    await rs.leave(true).catch(() => {});
    await rp.leave(true).catch(() => {});
  }
}

// ---- 2. Launch promo codes --------------------------------------------------------------------------------------------
{
  const t0 = total();
  const code = `AU${RUN.toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 16);
  const mk0 = Number(sys().mk);
  const create = await call('/api/admin/cold-start/promo-codes', { method: 'POST', token: ops.token, body: { code, backedMicroUsdPerTicket: 10_000, maxRedemptions: 3, depositMicroUsd: 1_000_000 } });
  const users = [];
  for (let i = 0; i < 5; i++) users.push(await signup(`au${RUN}pr${i}`));
  const devs = users.map(() => fp());
  const res = await Promise.all(users.map((u, i) => call('/api/promo/redeem', { method: 'POST', token: u.token, body: { code, deviceFp: devs[i] } })));
  const ok = res.filter((r) => r.status === 200);
  const row = sql1(`SELECT redeemed_count AS n FROM promo_codes WHERE code = '${code}'`);
  const mk1 = Number(sys().mk);
  const t1 = total();
  check(
    SEC,
    'promo cap: 5 parallel redemptions of a 3-use code → exactly 3 tickets (100 C each) drawn from the marketing pool; Δsystem = the deposit only',
    create.status === 200 && ok.length === 3 && Number(row.n) === 3 && mk0 + 1_000_000 - mk1 === 30_000 && t1.sum - t0.sum === 1_000_000,
    `create ${create.status} · HTTP ${res.map((r) => r.status).join(',')} · count ${row.n} · pool ${mk0} → ${mk1} · Δsystem ${t1.sum - t0.sum}`
  );
  const code2 = `${code.slice(0, 14)}B`;
  await call('/api/admin/cold-start/promo-codes', { method: 'POST', token: ops.token, body: { code: code2, backedMicroUsdPerTicket: 10_000, maxRedemptions: 500 } });
  const u0 = users[0];
  const again = await call('/api/promo/redeem', { method: 'POST', token: u0.token, body: { code: code2, deviceFp: devs[0] } });
  const again2 = await call('/api/promo/redeem', { method: 'POST', token: u0.token, body: { code: code2, deviceFp: fp() } });
  const sameDev = await call('/api/promo/redeem', { method: 'POST', token: users[1].token, body: { code: code2, deviceFp: devs[0] } });
  check(SEC, 'promo: 1 per user (second try 409) and 1 per device fingerprint (another account on the same device 409)', again.status === 200 && again2.status === 409 && again2.body.reason === 'user' && sameDev.status === 409 && sameDev.body.reason === 'device', `${again.status} · user ${again2.status}/${again2.body.reason} · device ${sameDev.status}/${sameDev.body.reason}`);
  // drain the marketing pool: the next redemption fails cleanly (nothing minted)
  const mkNow = Number(sys().mk);
  sqlFile([`UPDATE system_balances SET marketing_pool_micro_usd = 5000 WHERE id = 'global';`]);
  const t2 = total();
  const empty = await call('/api/promo/redeem', { method: 'POST', token: users[2].token, body: { code: code2, deviceFp: fp() } });
  const t3 = total();
  sqlFile([`UPDATE system_balances SET marketing_pool_micro_usd = ${mkNow} WHERE id = 'global';`]);
  check(SEC, 'promo: an empty marketing pool refuses cleanly (POOL_EMPTY, no ticket, no money moved)', empty.status === 409 && empty.body.reason === 'pool_empty' && t3.sum === t2.sum, `${empty.status}/${empty.body.reason} · Δ ${t3.sum - t2.sum}`);
}

// ---- 3. P2P skin market: double purchase race -------------------------------------------------------------------------
{
  const seller = await signup(`au${RUN}sk`);
  const b1u = await signup(`au${RUN}kb1`);
  const b2u = await signup(`au${RUN}kb2`);
  sqlFile([`UPDATE users SET skin_fragments = 3 WHERE id = '${seller.id}';`]); // test setup: three mission fragments
  const crate = await call('/api/skins/crate/open', { method: 'POST', token: seller.token });
  const crate2 = await call('/api/skins/crate/open', { method: 'POST', token: seller.token });
  const skinId = crate.body?.skin?.id;
  const low = await call('/api/skins/list', { method: 'POST', token: seller.token, body: { skinId, priceMicroUsd: 4_999 } });
  const list = await call('/api/skins/list', { method: 'POST', token: seller.token, body: { skinId, priceMicroUsd: 10_000 } });
  const lid = list.body.listingId;
  await faucet(b1u, 20_000);
  await faucet(b2u, 20_000);
  const t0 = total();
  const s0 = { s: bal(seller.id), a: bal(b1u.id), b: bal(b2u.id), pl: Number(sys().pl) };
  const [r1, r2] = await Promise.all([call(`/api/skins/market/${lid}/buy`, { method: 'POST', token: b1u.token }), call(`/api/skins/market/${lid}/buy`, { method: 'POST', token: b2u.token })]);
  const s1 = { s: bal(seller.id), a: bal(b1u.id), b: bal(b2u.id), pl: Number(sys().pl) };
  const t1 = total();
  const owner = sql1(`SELECT owner_id AS o FROM user_skins WHERE id = '${skinId}'`).o;
  const lst = sql1(`SELECT status, buyer_id AS b FROM skin_market_listings WHERE id = '${lid}'`);
  const winner = r1.status === 200 ? b1u : b2u;
  const split = S.splitSkinSale(10_000, 10);
  check(
    SEC,
    'skin market race: 2 buyers in parallel → exactly ONE sale (status guard); buyer −100 C, seller +90 C, platform +10 C, ownership moved, loser untouched; Δsystem 0',
    crate.status === 200 && crate2.status === 409 && low.status === 400 && list.status === 200 &&
      [r1, r2].filter((r) => r.status === 200).length === 1 &&
      s1.s - s0.s === split.sellerMicroUsd && s1.pl - s0.pl === split.feeMicroUsd && s0.a + s0.b - s1.a - s1.b === 10_000 && owner === winner.id && lst.status === 'sold' && lst.b === winner.id && t1.sum === t0.sum,
    `crate ${crate.status}/${crate2.status} · <50 C ${low.status} · buys ${r1.status}/${r2.status} · seller +${s1.s - s0.s} · platform +${s1.pl - s0.pl} · buyers −${s0.a + s0.b - s1.a - s1.b} · owner ok ${owner === winner.id} · Δsystem ${t1.sum - t0.sum}`
  );
}

// ---- 4. Happy Hour pool cap -------------------------------------------------------------------------------------------
{
  const now = new Date();
  const hh = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const on = await call('/api/admin/cold-start/settings', { method: 'PUT', token: ops.token, body: { happyHourEnabled: true, happyHourStart: hh(new Date(now.getTime() - 10 * 60_000)), happyHourEnd: hh(new Date(now.getTime() + 50 * 60_000)), happyHourTzOffsetMinutes: 0 } });
  const lc = await call('/api/game/live-config');
  const K = await signup(`au${RUN}hhK`);
  const V1 = await signup(`au${RUN}hhV1`);
  const V2 = await signup(`au${RUN}hhV2`);
  for (const u of [K, V1, V2]) await fund(u);
  const ek = await enter(K);
  const ev1 = await enter(V1);
  const ev2 = await enter(V2);
  const gameId = `hh_game_${RUN}`;
  const kill = (v, ev, pid) => ({ userId: K.id, amountMicroUsd: ev.body.ticketValueMicroUsd, actionType: 'GAME_KILL', gameId, metadata: { victimId: v.id, ticketId: ev.body.ticketId, pid } });
  const savedBoss = Number(sys().boss);
  const share1 = Number(S.calculateRewardSplit(ev1.body.ticketValueMicroUsd, []).earnerMicroUsd);
  // (a) pool covers the extra → paid from the pool, exactly the 55 % share once more
  sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = ${share1 + 1234} WHERE id = 'global';`]);
  const p0 = Number(sys().boss);
  const k0 = bal(K.id);
  const r1 = await batch(gameId, [kill(V1, ev1, `${gameId}:1`)]);
  const p1 = Number(sys().boss);
  const k1 = bal(K.id);
  const fee1 = Number(S.calculateRewardSplit(ev1.body.ticketValueMicroUsd, []).platformFeeMicroUsd);
  // the redirected 5 % fee also lands in the boss pool in the same settlement (launch default)
  check(
    SEC,
    'Happy Hour 2x: the kill pays its 55 % share once more from the Boss Bounty Pool (base payout unchanged)',
    on.status === 200 && lc.body.happyHour?.active === true && r1.body.happyHourBonuses === 1 && k1 - k0 === 2 * share1 && p0 - p1 === share1 - fee1,
    `live-config active ${lc.body.happyHour?.active} · bonuses ${r1.body.happyHourBonuses} · killer +${k1 - k0} (2 × ${share1}) · pool ${p0} → ${p1} (−extra +5 % fee ${fee1})`
  );
  // (b) re-sent batch: neither the kill nor the bonus pays again
  const r1b = await batch(gameId, [kill(V1, ev1, `${gameId}:1`)]);
  // (c) pool smaller than the extra → falls back to 1x, pool untouched by the bonus
  const share2 = Number(S.calculateRewardSplit(ev2.body.ticketValueMicroUsd, []).earnerMicroUsd);
  const fee2 = Number(S.calculateRewardSplit(ev2.body.ticketValueMicroUsd, []).platformFeeMicroUsd);
  // after the kill's own 5 % fee lands in the pool it holds share2 − 1: one µUSD short of the extra
  sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = ${Math.max(0, share2 - 1 - fee2)} WHERE id = 'global';`]);
  const q0 = Number(sys().boss);
  const kk0 = bal(K.id);
  const t0 = total();
  const r2 = await batch(gameId, [kill(V2, ev2, `${gameId}:2`)]);
  const q1 = Number(sys().boss);
  const kk1 = bal(K.id);
  const t1 = total();
  check(
    SEC,
    'Happy Hour pool cap: when the pool cannot cover the whole extra the kill pays 1x (no partial / negative pool); a re-sent batch pays nothing again',
    Number(r1b.body.happyHourBonuses || 0) === 0 && Number(r1b.body.duplicates || 0) >= 1 && r2.body.happyHourBonuses === 0 && kk1 - kk0 === share2 && q1 - q0 === fee2 && q1 >= 0 && t1.sum === t0.sum,
    `resend bonuses ${r1b.body.happyHourBonuses} · 1x kill +${kk1 - kk0} (${share2}) · pool ${q0} → ${q1} (+fee ${fee2}) · Δsystem ${t1.sum - t0.sum}`
  );
  sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = ${savedBoss} WHERE id = 'global';`]);
  await call('/api/admin/cold-start/settings', { method: 'PUT', token: ops.token, body: { happyHourEnabled: false } });
  void ek;
}

// ---- 5. Cold-start bot bounties ---------------------------------------------------------------------------------------
{
  const set = await call('/api/admin/cold-start/settings', { method: 'PUT', token: ops.token, body: { botFillEnabled: true, targetBots: 6 } });
  const savedBoss = Number(sys().boss);
  sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = 112000 WHERE id = 'global';`]); // 1,120 C (≥ the 1,000 C floor)
  const gameId = `bot_game_${RUN}`;
  const reserve = (botId) => call('/api/game/bot-bounty/reserve', { method: 'POST', body: { secret: SECRETS.INTERNAL_API_SECRET, gameId, roomId: 'probe', botId } });
  const noSecret = await call('/api/game/bot-bounty/reserve', { method: 'POST', body: { gameId, botId: 'bot_aa11' } });
  const pool0 = Number(sys().boss);
  const rs = await Promise.all([...Array(14)].map((_, i) => reserve(`bot_p${i}x`)));
  const got = rs.filter((r) => r.body.reserved);
  const reserved = got.reduce((a, r) => a + Number(r.body.amountMicroUsd), 0);
  const pool1 = Number(sys().boss);
  const live = Number(sql1(`SELECT COALESCE(SUM(amount_micro_usd),0) AS v FROM bot_bounty_reservations WHERE game_id = '${gameId}' AND status = 'reserved'`).v);
  check(
    SEC,
    'bot bounty: 14 parallel reservations never exceed the pool (floor 1,000 C, 10–50 C each) — pool − reserved = before, pool ≥ 0; internal secret required',
    set.status === 200 && noSecret.status === 401 && got.length >= 1 && pool0 - pool1 === reserved && live === reserved && pool1 >= 0 && got.every((r) => r.body.amountMicroUsd >= 1_000 && r.body.amountMicroUsd <= 5_000) && pool1 + Math.min(...got.map((r) => r.body.amountMicroUsd)) >= 0,
    `${got.length}/14 reserved ${reserved} µUSD · pool ${pool0} → ${pool1} · refusals ${[...new Set(rs.filter((r) => !r.body.reserved).map((r) => r.body.reason))].join(',')}`
  );
  // claim: a paid seat, twice in parallel → paid once 55 %; a release after that does nothing
  const K = await signup(`au${RUN}btK`);
  await enter(K);
  const first = got[0]?.body;
  const claim = (pid) => ({ userId: K.id, amountMicroUsd: 999_999, actionType: 'BOT_BOUNTY_CLAIM', gameId, metadata: { reservationId: first.reservationId, botId: 'bot_p0x', pid } });
  const botIdOf = sql1(`SELECT bot_id AS b FROM bot_bounty_reservations WHERE id = '${first?.reservationId}'`).b;
  const c = (pid) => ({ ...claim(pid), metadata: { ...claim(pid).metadata, botId: botIdOf } });
  const kb0 = bal(K.id);
  const [c1, c2] = await Promise.all([batch(gameId, [c(`${gameId}:c1`)]), batch(gameId, [c(`${gameId}:c2`)])]);
  const kb1 = bal(K.id);
  const want = Number(S.calculateRewardSplit(Number(first.amountMicroUsd), []).earnerMicroUsd);
  // release every reservation twice in parallel → each returns to the pool once
  const rel = got.map((r, i) => ({ userId: '00000000-0000-4000-8000-000000000000', amountMicroUsd: 0, actionType: 'BOT_BOUNTY_RELEASE', gameId, metadata: { reservationId: r.body.reservationId, reason: 'despawn', pid: `${gameId}:r${i}` } }));
  const p2 = Number(sys().boss);
  const [x1, x2] = await Promise.all([batch(gameId, rel), batch(gameId, rel.map((x) => ({ ...x, metadata: { ...x.metadata, pid: `${x.metadata.pid}b` } })))]);
  const p3 = Number(sys().boss);
  const left = Number(sql1(`SELECT COUNT(*) AS n FROM bot_bounty_reservations WHERE game_id = '${gameId}' AND status = 'reserved'`).n);
  check(
    SEC,
    'bot bounty claim / release: paid once (55 % from the reservation, never the item amount) to a paid seat; parallel releases return each other reservation exactly once',
    Number(c1.body.botClaims || 0) + Number(c2.body.botClaims || 0) === 1 && kb1 - kb0 === want && p3 - p2 === reserved - Number(first.amountMicroUsd) && left === 0 && Number(x1.body.botReleases || 0) + Number(x2.body.botReleases || 0) === got.length - 1,
    `claims ${c1.body.botClaims}/${c2.body.botClaims} · killer +${kb1 - kb0} (want ${want}) · returned ${p3 - p2} · releases ${x1.body.botReleases}+${x2.body.botReleases} · left ${left}`
  );
  // live room: one real player → the server fills up to 6 with bots; leaving closes the room and returns every bot bounty
  sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = 300000 WHERE id = 'global';`]);
  const R = await signup(`au${RUN}btR`);
  await fund(R, 1);
  const er = await enter(R);
  const cr = new Client(GAME_WS, { headers: { 'cf-connecting-ip': '10.251.0.9' } });
  let room;
  try {
    room = await cr.create('standard_100', { entryToken: er.body.entryToken, deviceId: `live-r-${RUN}` });
  } catch (err) {
    check(SEC, 'bot room joined', false, String(err?.message || err));
  }
  if (room) {
    let bots = 0;
    for (let i = 0; i < 40 && bots < 5; i++) {
      await sleep(500);
      bots = 0;
      room.state.players.forEach((p) => p.isBot && bots++);
    }
    await sleep(3000);
    const gid = sql1(`SELECT game_id AS g FROM bot_bounty_reservations WHERE room_id = '${room.roomId}' ORDER BY created_at DESC LIMIT 1`).g;
    const rsv = gid ? sql1(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_micro_usd),0) AS v FROM bot_bounty_reservations WHERE game_id = '${gid}' AND status = 'reserved'`) : { n: 0, v: 0 };
    const botEarn = Number(sql1("SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id LIKE 'bot_%'").n);
    let names = [];
    room.state.players.forEach((p) => p.isBot && names.push(p.username));
    check(
      SEC,
      'live bot fill: 1 real player + target 6 → 5 server bots (labelled [BOT]), each bounty a Boss-Pool reservation; bots have no wallet / ledger rows',
      bots === 5 && names.every((n) => n.startsWith('[BOT]')) && Number(rsv.n) <= 5 && Number(rsv.v) <= 300_000 && botEarn === 0,
      `bots ${bots} (${names.slice(0, 3).join(', ')}) · reservations ${rsv.n} (${rsv.v} µUSD) · bot ledger rows ${botEarn}`
    );
    await room.leave(true).catch(() => {});
    // the room disposes (no clients, no bodies) → every bot reservation is released by the final batch
    let still = 1;
    for (let i = 0; i < 40 && still > 0; i++) {
      await sleep(1000);
      still = gid ? Number(sql1(`SELECT COUNT(*) AS n FROM bot_bounty_reservations WHERE game_id = '${gid}' AND status = 'reserved'`).n) : 0;
    }
    check(SEC, 'live bot fill: when the room closes every bot bounty returns to the Boss Bounty Pool (none left reserved)', still === 0, `${still} still reserved`);
  }
  await call('/api/admin/cold-start/settings', { method: 'PUT', token: ops.token, body: { botFillEnabled: false } });
  // restore the pool (test setup) — minus nothing: claims above were paid from reservations already out of the pool
  sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = ${savedBoss} WHERE id = 'global';`]);
}

// ---- 6. Streamer Room: Silver I+, 40 % of VERIFIED viewer ad value ---------------------------------------------------------
{
  const st = await signup(`au${RUN}str`);
  const bronze = await call('/api/streamer/rooms', { method: 'POST', token: st.token, body: { title: 'Audit live', mode: 'skirmish' } });
  for (let i = 0; i < 25; i++) await signup(`au${RUN}sd${i}`, st.username); // 25 downlines → Silver I
  const open = await call('/api/streamer/rooms', { method: 'POST', token: st.token, body: { title: 'Audit live', mode: 'skirmish' } });
  const code = open.body.room?.roomCode;
  let listed = null;
  for (let i = 0; i < 10 && !listed; i++) {
    const rooms = await call('/api/game/rooms');
    listed = (rooms.body.rooms || []).find((r) => r.id === code);
    if (!listed) await sleep(2500);
  }
  const viewer = await signup(`au${RUN}viw`);
  const t0 = total();
  const w0 = bal(st.id);
  const dl = await call('/api/ads/direct-link/start', { method: 'POST', token: viewer.token, body: { purpose: 'ec_recharge', seconds: 15, roomCode: code } });
  const row = sql1(`SELECT streamer_user_id AS s, room_code AS rc FROM ad_click_tokens WHERE token = '${dl.body.token}'`);
  const price = 0.0040;
  const G = Math.round(price * 1e6);
  const h = S.splitAdGross(G);
  const share = S.splitStreamerShare(h.netMicroUsd, 40).streamerMicroUsd;
  const pb = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: dl.body.token, estimated_price: String(price), click_id: `au5_str_${RUN}` })}`);
  const w1 = bal(st.id);
  const t1 = total();
  const led = sql1(`SELECT COUNT(*) AS n, COALESCE(SUM(delta_micro_usd),0) AS d FROM wallet_ledger WHERE user_id = '${st.id}' AND action_type = 'STREAMER_AD_SHARE'`);
  check(
    SEC,
    'Streamer Room: Bronze refused (403), Silver I opens a LIVE room listed in the lobby; a viewer ad in it credits the streamer 40 % of the VERIFIED net value once; Δsystem = verified gross',
    bronze.status === 403 && open.status === 200 && !!listed?.isStreamerRoom && row.s === st.id && pb.status === 200 && w1 - w0 === share && Number(led.n) === 1 && t1.sum - t0.sum === G,
    `bronze ${bronze.status} · open ${open.status} ${code} · listed ${!!listed?.isStreamerRoom} · G ${G} → streamer +${w1 - w0} (want ${share}) · Δsystem ${t1.sum - t0.sum}`
  );
  // an unverified (timer-only) visit in the same room credits the streamer nothing
  const viewer2 = await signup(`au${RUN}viw2`);
  const dl2 = await call('/api/ads/direct-link/start', { method: 'POST', token: viewer2.token, body: { purpose: 'ec_recharge', seconds: 15, roomCode: code } });
  await sleep(15_500);
  const cl = await call('/api/ads/direct-link/claim', { method: 'POST', token: viewer2.token, body: { token: dl2.body.token } });
  const w2 = bal(st.id);
  check(SEC, 'Streamer Room: an UNVERIFIED (timer-only) viewer ad credits the streamer 0', dl2.status === 200 && cl.status === 200 && w2 === w1, `claim ${cl.status} · streamer +${w2 - w1}`);
  const close = await call(`/api/streamer/rooms/${code}`, { method: 'DELETE', token: st.token });
  check(SEC, 'Streamer Room: the streamer can end the room', close.status === 200 && !close.body.room, `${close.status}`);
}

note(SEC, 'bots shoot through validateShot() (server ballistics: range, aim cone, walls) — see apps/game-server/src/rooms/ShootingRoom.ts botTick');
clearInterval(hb);
export const liveResults = results;
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.filter((r) => r.ok && !r.note).length} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
