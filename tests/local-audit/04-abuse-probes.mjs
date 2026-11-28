/**
 * 04-abuse-probes.mjs — LOCAL-ONLY probes of the "does the system lose real money?" weak points.
 * Each probe shows whether a scripted client (no real ad, no real aim) can still create paid value.
 * Needs the same local api-worker + game server as 02 (run-local-audit.mjs --probes).
 *
 * V1.2 Round B: banner pings and timer-only direct-link claims must bring ZERO cashable backing (H2), the
 * 60-per-day banner cap holds, a late S2S postback backs the visit exactly once, Golden Boss reservations are
 * paid / returned exactly once, and parallel MLM settlements credit exactly once (M1).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SECRETS, GAME_WS, call, check, note, results, signup, sql1, sqlFile, sleep, colyseus, decodeToken } from './lib.mjs';

const SEC = 'abuse';
const RUN = Date.now().toString(36);
const S = await import(pathToFileURL(path.join(ROOT, 'packages/shared/dist/index.mjs')).href);
console.log('\n── 04 abuse probes ──');
const heartbeat = () => call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${SECRETS.INTERNAL_API_SECRET}` }, body: { nodeId: `audit-probe-${RUN}`, role: 'game' } });
await heartbeat();
const today = new Date().toISOString().slice(0, 10);
const sys = () => sql1("SELECT boss_bounty_pool_micro_usd AS boss, safety_reserve_micro_usd AS safety, platform_micro_usd AS pl FROM system_balances WHERE id = 'global'");
const pending = (id) => Number(sql1(`SELECT pending_ec_micro_usd AS p FROM users WHERE id = '${id}'`).p || 0);
const backedTickets = (id) => Number(sql1(`SELECT COALESCE(SUM(backed_micro_usd),0) AS v FROM user_energy_tickets WHERE user_id = '${id}'`).v || 0);

// live ad config (same as 02, so the probes also work with --probes-only on an existing local DB)
{
  const ops = await signup(`au${RUN}ops4`);
  sqlFile([`UPDATE users SET staff_role = 'super_admin' WHERE id = '${ops.id}';`]);
  const banner = (k) => `<script>atOptions = {'key' : '${k}','format' : 'iframe','height' : 50,'width' : 320,'params' : {}};</script><script src="https://www.highperformanceformat.com/${k}/invoke.js"></script>`;
  const cfg = await call('/api/admin/ads/config', { method: 'PUT', token: ops.token, body: { adMode: 'live', adsterraEnabled: true, adsterraBanner320x50: banner('0123456789abcdef0123456789abcdef'), monetagEnabled: true, monetagDirectLinkUrl: 'https://example.invalid/direct-link' } });
  check(SEC, 'setup: ads live (banner 320x50 + Monetag direct link)', cfg.status === 200, `${cfg.status}`);
}

// 1. Banner impression with a forged "last input" time and no banner ever rendered ----------------
const bot = await signup(`au${RUN}bot`);
const v0 = pending(bot.id) + backedTickets(bot.id);
const b1 = await call('/api/ads/impression', { method: 'POST', token: bot.token, body: { slot: 'adsterra_320x50', count: 1, lastActiveAt: Date.now(), clientNow: Date.now() } });
const v1 = pending(bot.id) + backedTickets(bot.id);
check(SEC, 'H2: a scripted banner ping (no iframe ever loaded) gets ZERO cashable backing — EC % only', b1.status !== 200 || (Number(b1.body.backedMicroUsd ?? 0) === 0 && v1 === v0), `HTTP ${b1.status} · backing +${b1.body.backedMicroUsd ?? 0} µUSD (D1 +${v1 - v0}) · EC +${b1.body.ecProgressAddedPct ?? 0}%`);
// daily cap: pretend 60 banners were already counted today (gate time far in the past)
sqlFile([`UPDATE users SET banner_day = '${today}', banner_day_count = ${S.MAX_DAILY_BANNER_IMPRESSIONS}, last_banner_at = 0 WHERE id = '${bot.id}';`]);
const b61 = await call('/api/ads/impression', { method: 'POST', token: bot.token, body: { slot: 'adsterra_320x50', count: 1, lastActiveAt: Date.now(), clientNow: Date.now() } });
const sim61 = await call('/api/ads/simulate-view', { method: 'POST', token: bot.token, body: { format: 'banner', purpose: 'ec_recharge', count: 1, lastActiveAt: Date.now(), clientNow: Date.now() } });
check(SEC, `V1.2 banner cap: the ${S.MAX_DAILY_BANNER_IMPRESSIONS + 1}st banner of a UTC day → 429 (live and simulated)`, b61.status === 429 && b61.body.code === 'banner_daily_cap' && sim61.status === 429 && sim61.body.code === 'banner_daily_cap', `live ${b61.status}/${b61.body.code} · simulated ${sim61.status}/${sim61.body.code}`);

// 2. Direct-link visit claimed on the server timer without ever opening the link ---------------------
const dl = await call('/api/ads/direct-link/start', { method: 'POST', token: bot.token, body: { purpose: 'ec_recharge', seconds: 15 } });
await sleep(15_500);
const w0 = pending(bot.id) + backedTickets(bot.id);
const dc = dl.status === 200 ? await call('/api/ads/direct-link/claim', { method: 'POST', token: bot.token, body: { token: dl.body.token } }) : { status: dl.status, body: dl.body };
const w1 = pending(bot.id) + backedTickets(bot.id);
check(
  SEC,
  'H2: a timer-only direct-link claim (no S2S postback) gets ZERO cashable backing — EC % only',
  dc.status === 200 && Number(dc.body.valueMicroUsd ?? 0) === 0 && Number(dc.body.ecBackingMicroUsd ?? 0) === 0 && w1 === w0,
  `start ${dl.status} · claim HTTP ${dc.status} · backing ${dc.body.ecBackingMicroUsd ?? 0} µUSD (D1 +${w1 - w0}) · EC +${dc.body.ecProgressAddedPct ?? 0}%`
);
// …then the network's S2S postback (ymid = the dl_ token, estimated_price) arrives: V backs the EC exactly once
if (dc.status === 200) {
  const s0 = sys();
  const price = 0.0021; // $2.10 CPM
  const G = Math.round(price * 1e6);
  const h = S.splitAdGross(G);
  const pb = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: dl.body.token, estimated_price: String(price), click_id: `au_pb_${RUN}_1` })}`);
  const w2 = pending(bot.id) + backedTickets(bot.id);
  const s1 = sys();
  const pb2 = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: dl.body.token, estimated_price: String(price), click_id: `au_pb_${RUN}_2` })}`);
  const pb3 = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: dl.body.token, estimated_price: String(price), click_id: `au_pb_${RUN}_1` })}`);
  const w3 = pending(bot.id) + backedTickets(bot.id);
  check(
    SEC,
    'V1.2: the late S2S postback of a timer-claimed visit backs it once — V = 92 % to the EC, 3 % safety reserve, 5 % boss pool; replays add nothing',
    pb.status === 200 && pb.body.verified === true && w2 - w1 === h.netMicroUsd && Number(s1.safety) - Number(s0.safety) === h.safetyReserveMicroUsd && Number(s1.boss) - Number(s0.boss) === h.bossPoolMicroUsd && w3 === w2 && pb2.body.verified !== true && pb3.body.duplicate === true,
    `G ${G} → EC +${w2 - w1} (want ${h.netMicroUsd}) · safety +${Number(s1.safety) - Number(s0.safety)} · boss +${Number(s1.boss) - Number(s0.boss)} · replay note ${pb2.body.note} · dupe ${pb3.body.duplicate}`
  );
}
// an unpriced postback (valid secret, no estimated_price) for a user: EC % only
{
  const u = await signup(`au${RUN}np`);
  const a = pending(u.id) + backedTickets(u.id);
  const r = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: u.id, geo: 'US', click_id: `au_np_${RUN}` })}`);
  const b = pending(u.id) + backedTickets(u.id);
  check(SEC, 'V1.2: a postback without the network price credits EC % with 0 µUSD backing', r.status === 200 && r.body.verified === false && b === a, `${r.body.note} · backing +${b - a}`);
}

// 3. Hit claimed from across the map (no range / wall line-of-sight check on the server) ----------
const { Client } = colyseus();
const A = await signup(`au${RUN}aim`);
const V = await signup(`au${RUN}vic`);
// give both backed tickets through the real VERIFIED postback path (US, with the network's price)
for (const u of [A, V])
  for (let i = 0; i < 6; i++)
    await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: u.id, geo: 'US', estimated_price: '0.0090', click_id: `au_${RUN}_${u.username}_${i}` })}`);
const enter = async (u) => call('/api/game/enter', { method: 'POST', token: u.token, body: { mode: 'standard_100' } });
const ea0 = await enter(A);
const ev0 = await enter(V);
const ca = new Client(GAME_WS, { headers: { 'cf-connecting-ip': '10.250.0.1' } });
const cv = new Client(GAME_WS, { headers: { 'cf-connecting-ip': '10.250.0.2' } });
let ra, rv;
try {
  ra = await ca.joinOrCreate('standard_100', { entryToken: ea0.body.entryToken, deviceId: `probe-a-${RUN}` });
  rv = await cv.joinById(ra.roomId, { entryToken: ev0.body.entryToken, deviceId: `probe-v-${RUN}` });
} catch (e) {
  check(SEC, 'probe room joined', false, String(e.message || e));
}
if (ra && rv) {
  await sleep(1500);
  let distance = null;
  const shootUntilDead = async () => {
    for (let i = 0; i < 60; i++) {
      const me = ra.state.players.get(ra.sessionId);
      const them = ra.state.players.get(rv.sessionId);
      if (!them || them.isGhost) return true;
      distance = Math.hypot(me.x - them.x, me.z - them.z);
      ra.send('player_shoot', { targetType: 'player', targetId: rv.sessionId, damage: 92, headshot: false });
      await sleep(260);
    }
    return false;
  };
  const tv = ev0.body.entryToken ? decodeToken(ev0.body.entryToken).tv : 0;
  const wA0 = Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${A.id}'`).b || 0);
  const killed = await shootUntilDead();
  await sleep(12_000); // 10 s payout batch
  const wA1 = Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${A.id}'`).b || 0);
  check(
    SEC,
    'server rejects hits claimed from beyond weapon range / through walls (spec §5.1 server authoritative)',
    !(killed && wA1 > wA0),
    `victim ${killed ? 'killed' : 'not killed'} from ${distance?.toFixed(1)} m on the 960 m map without aiming · ticket ${tv} µUSD · shooter paid +${wA1 - wA0} µUSD`
  );
  await ra.leave(true).catch(() => {});
  await rv.leave(true).catch(() => {});
}

// 4. Golden Boss reservations: paid once, returned once, never invented -------------------------------
{
  const B = await signup(`au${RUN}boss`);
  const K = await signup(`au${RUN}hunter`);
  // both hold a paid seat (ticket in_match): the starter ticket is enough for eligibility
  const eb = await enter(B);
  const ek = await enter(K);
  sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd + 400000 WHERE id = 'global';`]);
  const gameId = `probe_game_${RUN}`;
  const reserve = () => call('/api/game/boss-bounty/reserve', { method: 'POST', body: { secret: SECRETS.INTERNAL_API_SECRET, gameId, roomId: 'probe', targetUserId: B.id, entryId: eb.body.entryId } });
  const batch = (payouts) => call('/api/game/batch-payout', { method: 'POST', body: { gameId, timestamp: Math.floor(Date.now() / 1000), secret: SECRETS.INTERNAL_API_SECRET, payouts } });
  const noSecret = await call('/api/game/boss-bounty/reserve', { method: 'POST', body: { gameId, targetUserId: B.id, entryId: eb.body.entryId } });
  const p0 = Number(sys().boss);
  const r1 = await reserve();
  const r1b = await reserve(); // a second live boss in the same room is refused
  const p1 = Number(sys().boss);
  check(
    SEC,
    'V1.2 Golden Boss reserve: internal secret required · 500 C – 2,000 C moved from the pool into ONE reservation per room',
    noSecret.status === 401 && eb.status === 200 && r1.body.reserved === true && r1.body.amountMicroUsd >= 50_000 && r1.body.amountMicroUsd <= 200_000 && p0 - p1 === r1.body.amountMicroUsd && r1b.body.reserved === false && r1b.body.reason === 'already_active',
    `no secret ${noSecret.status} · reserved ${r1.body.amountMicroUsd} · pool ${p0} → ${p1} · 2nd ${r1b.body.reason}`
  );
  const rel = { userId: B.id, amountMicroUsd: 0, actionType: 'BOSS_BOUNTY_RELEASE', gameId, metadata: { reservationId: r1.body.reservationId, reason: 'expired', pid: `${gameId}:r1` } };
  const [x1, x2] = await Promise.all([batch([rel]), batch([{ ...rel, metadata: { ...rel.metadata, pid: `${gameId}:r2` } }])]);
  const p2 = Number(sys().boss);
  check(SEC, 'V1.2 Golden Boss release: 2 parallel releases return the reservation to the pool exactly once', p2 === p0 && Number(x1.body.bossReleases || 0) + Number(x2.body.bossReleases || 0) === 1, `pool ${p2} (start ${p0}) · releases ${x1.body.bossReleases}+${x2.body.bossReleases}`);
  const r2 = await reserve();
  const amount = Number(r2.body.amountMicroUsd || 0);
  const wrong = await batch([{ userId: K.id, amountMicroUsd: 999_999, actionType: 'BOSS_BOUNTY_CLAIM', gameId, metadata: { reservationId: r2.body.reservationId, victimId: K.id, pid: `${gameId}:c0` } }]);
  const kw0 = Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${K.id}'`).b || 0);
  const claim = (pid) => ({ userId: K.id, amountMicroUsd: 999_999, actionType: 'BOSS_BOUNTY_CLAIM', gameId, metadata: { reservationId: r2.body.reservationId, victimId: B.id, pid } });
  const [c1, c2] = await Promise.all([batch([claim(`${gameId}:c1`)]), batch([claim(`${gameId}:c2`)])]);
  const c3 = await batch([claim(`${gameId}:c3`), { ...rel, metadata: { reservationId: r2.body.reservationId, reason: 'late', pid: `${gameId}:r3` } }]);
  const kw1 = Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${K.id}'`).b || 0);
  const want = Number(S.calculateRewardSplit(amount, []).earnerMicroUsd);
  const row = sql1(`SELECT status, claimed_by_user_id AS k FROM boss_bounty_reservations WHERE id = '${r2.body.reservationId}'`);
  check(
    SEC,
    'V1.2 BOSS_BOUNTY_CLAIM: paid from the reservation (never the item amount), once — parallel / re-sent claims and a late release do nothing',
    r2.body.reserved === true && Number(wrong.body.bossClaims || 0) === 0 && kw1 - kw0 === want && Number(c1.body.bossClaims || 0) + Number(c2.body.bossClaims || 0) + Number(c3.body.bossClaims || 0) === 1 && Number(c3.body.bossReleases || 0) === 0 && row.status === 'claimed' && row.k === K.id,
    `reserved ${amount} · killer +${kw1 - kw0} (55 % = ${want}) · claims ${c1.body.bossClaims}/${c2.body.bossClaims}/${c3.body.bossClaims} · wrong-victim claim ${wrong.body.bossClaims ?? 0} · status ${row.status}`
  );
  void ek;
}

// 5. Parallel MLM settlements (M1): credit exactly the rows flipped, once -----------------------------
{
  const dateKey = '2025-01-01';
  const U = await signup(`au${RUN}mlmU`); // unlocked sponsor (paid)
  const L = await signup(`au${RUN}mlmL`); // locked sponsor (burned)
  const D = await signup(`au${RUN}mlmD`); // downline
  const rows = [];
  for (const [who, n] of [[U, 4], [L, 3]]) for (let i = 0; i < n; i++) rows.push(`('mlm_au_${RUN}_${who.username}_${i}', '${who.id}', '${dateKey}', '${D.id}', ${1 + (i % 5)}, ${1000 + i * 37}, 'pending_grey', 'GAME_KILL', unixepoch())`);
  sqlFile([
    `INSERT INTO daily_mlm_pending_ledger (id, user_id, date_key, downline_user_id, depth_level, amount_micro_usd, status, source_type, created_at) VALUES ${rows.join(',')};`,
    `INSERT INTO user_daily_quests (id, user_id, date_key, quest_id, current_count, is_completed) SELECT 'uq_au_${RUN}_' || quest_id, '${U.id}', '${dateKey}', quest_id, target_count, 1 FROM daily_quest_definitions WHERE is_active = 1;`,
  ]);
  const wantU = Number(sql1(`SELECT SUM(amount_micro_usd) AS s FROM daily_mlm_pending_ledger WHERE user_id = '${U.id}' AND date_key = '${dateKey}'`).s);
  const settle = (uid) => call('/api/quests/settle-daily-mlm', { method: 'POST', headers: { 'X-Internal-Secret': SECRETS.INTERNAL_API_SECRET }, body: { dateKey, targetUserId: uid } });
  await Promise.all([...Array(5)].flatMap(() => [settle(U.id), settle(L.id)]));
  const credited = Number(sql1(`SELECT COALESCE(SUM(delta_micro_usd),0) AS s FROM wallet_ledger WHERE user_id = '${U.id}' AND action_type = 'MLM_COMMISSION'`).s);
  const bal = Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${U.id}'`).b);
  const burn = sql1(`SELECT COUNT(DISTINCT settle_id) AS ids, SUM(CASE WHEN status = 'forfeited_burned' THEN 1 ELSE 0 END) AS n FROM daily_mlm_pending_ledger WHERE user_id = '${L.id}' AND date_key = '${dateKey}'`);
  const paid = sql1(`SELECT COUNT(DISTINCT settle_id) AS ids, SUM(CASE WHEN status = 'settled_paid' THEN 1 ELSE 0 END) AS n FROM daily_mlm_pending_ledger WHERE user_id = '${U.id}' AND date_key = '${dateKey}'`);
  check(
    SEC,
    'M1: 10 parallel settlement triggers — the unlocked sponsor is credited exactly once (wallet = ledger = Σ rows), the locked one burned in ONE batch',
    credited === wantU && bal === wantU && Number(paid.ids) === 1 && Number(paid.n) === 4 && Number(burn.ids) === 1 && Number(burn.n) === 3,
    `rows ${wantU} µUSD → ledger ${credited} · wallet ${bal} · paid by ${paid.ids} batch(es) · burned ${burn.n} rows by ${burn.ids} batch(es)`
  );
}

// 6. Headshot ratio ------------------------------------------------------------------------------
note(SEC, `Layer-2 headshot ratio (> ${S.HEADSHOT_RATIO_FLAG * 100} % after ${S.HEADSHOT_MIN_SAMPLE_HITS} hits) uses the SERVER's headshot (hit height), not the client's flag`);

export const abuseResults = results;
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.filter((r) => r.ok && !r.note).length} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
