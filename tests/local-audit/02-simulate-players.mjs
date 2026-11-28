/**
 * 02-simulate-players.mjs — LOCAL-ONLY end-to-end simulation of ~100 players (V1.1 spec audit).
 *
 * Needs (started by run-local-audit.mjs): api-worker on 127.0.0.1:8787 (wrangler dev --local, isolated D1
 * in .local-audit/wrangler-state) and the real Colyseus game server on 127.0.0.1:2599 pointed at it.
 *
 * What a "player" does, through the real HTTP / WebSocket APIs:
 *   1. signs up with Telegram (test bot token) using the sponsor's referral code → 5-level tree
 *   2. charges EC with real-revenue ads valued in their OWN country (Monetag S2S postbacks with geo=CC,
 *      some with a network price) and live Adsterra banner pings while playing
 *   3. does daily missions (check-in, network view, spectate 90 s) — ~60 % unlock the 4/5 MLM gate
 *   4. plays Paid-EC PvP (Skirmish 30P / Warzone 100P) or free Fast & Mini on the real game server:
 *      moves 10 Hz, shoots 2 Hz, dies, "Play again (-1 EC)" or back to lobby, some leave while alive
 *      (body stays) and Rejoin later, some suicide (chest)
 *   5. cheers other players' profiles / posts through the real direct-link flow (and the in-app card); about half
 *      of those visits later get the network's S2S postback with estimated_price (the only VERIFIED revenue)
 *   6. V1.2 Golden Boss: the Boss Bounty Pool is funded (test top-up) and the game server (event interval shortened
 *      by run-local-audit.mjs) reserves draws for players in Paid-EC rooms; kills claim them, the rest return
 * Then the midnight MLM settlement runs, and every money invariant is checked straight in D1.
 * V1.2 money rule checked here: only verified revenue (P1 postbacks) enters the system — as the WHOLE gross G
 * (3 % safety reserve + 5 % boss pool + 92 % ticket value); banners and timer-only claims add 0 µUSD.
 *
 * Options: --players=100 --play-seconds=150
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, STATE_DIR, SECRETS, API, GAME_WS, call, check, note, results, signup, decodeToken, sql, sql1, sqlFile, sleep, uuid, colyseus, roundShare, fmtC, fmtUsd,
} from './lib.mjs';

const S = await import(pathToFileURL(path.join(ROOT, 'packages/shared/dist/index.mjs')).href);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const N = Number(args.players ?? 100);
const PLAY_SECONDS = Number(args['play-seconds'] ?? 150);
const RUN = Date.now().toString(36);
const SEC = 'sim';
const today = new Date().toISOString().slice(0, 10);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// Country mix of a Thai-launched site (sums to 100)
const COUNTRY_MIX = [
  ['TH', 30], ['MM', 10], ['VN', 8], ['LA', 6], ['KH', 6], ['ID', 6], ['PH', 6], ['MY', 4], ['IN', 4], ['BD', 3], ['PK', 2],
  ['SG', 2], ['JP', 2], ['KR', 2], ['TW', 1], ['US', 3], ['GB', 1], ['AU', 1], ['CA', 1], ['DE', 1], ['GLOBAL', 1],
];
const countryPool = COUNTRY_MIX.flatMap(([c, n]) => Array(n).fill(c));

// Independent oracle of the 5-level ancestor list (from who referred whom, not from network_trees)
const sponsorOf = new Map();
const ancestorsOf = (id) => {
  const out = [];
  let cur = sponsorOf.get(id);
  for (let d = 1; d <= 5 && cur; d++) {
    out.push({ userId: cur, depth: d });
    cur = sponsorOf.get(cur);
  }
  return out;
};

// Snapshot of every place money can sit in core_db (µUSD)
function moneySnapshot() {
  const r = sqlFile([
    'SELECT COALESCE(SUM(balance_micro_usd),0) AS bal, COALESCE(SUM(bounty_micro_usd),0) AS bty, SUM(CASE WHEN balance_micro_usd < 0 OR bounty_micro_usd < 0 THEN 1 ELSE 0 END) AS neg FROM wallets;',
    "SELECT platform_micro_usd AS pl, energy_pool_micro_usd AS pool, energy_pool_drawn_micro_usd AS drawn, boss_bounty_pool_micro_usd AS boss, safety_reserve_micro_usd AS safety FROM system_balances WHERE id = 'global';",
    'SELECT COALESCE(SUM(pending_ec_micro_usd),0) AS pend FROM users;',
    "SELECT COALESCE(SUM(CASE WHEN status IN ('available','in_match') THEN backed_micro_usd ELSE 0 END),0) AS live FROM user_energy_tickets;",
    "SELECT COALESCE(SUM(amount_micro_usd),0) AS mlm FROM daily_mlm_pending_ledger WHERE status IN ('pending_grey','unlocked_green');",
    "SELECT COALESCE(SUM(micro_usd),0) AS fm FROM fast_mini_pot_credits WHERE status = 'open';",
    "SELECT COALESCE(SUM(amount_micro_usd),0) AS wd FROM withdrawal_requests WHERE status NOT IN ('rejected');",
    "SELECT COALESCE(SUM(amount_micro_usd),0) AS res FROM boss_bounty_reservations WHERE status = 'reserved';",
  ]).map((x) => x.results[0] || {});
  const [w, sys, u, t, m, f, wd, br] = r;
  const parts = {
    wallets: Number(w.bal), headBounties: Number(w.bty), platform: Number(sys.pl), poolUnspent: Number(sys.pool) - Number(sys.drawn),
    pendingEc: Number(u.pend), liveTickets: Number(t.live), mlmPending: Number(m.mlm), fastMiniOpen: Number(f.fm), withdrawals: Number(wd.wd),
    // V1.2: Boss Bounty Pool + draws reserved for live Golden Bosses + the 3 % Platform Safety Reserve
    bossPool: Number(sys.boss), bossReserved: Number(br.res), safetyReserve: Number(sys.safety),
  };
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0), negativeWallets: Number(w.neg || 0), pool: Number(sys.pool), drawn: Number(sys.drawn) };
}

// VERIFIED revenue inflow kept by the simulation (V1.2: only P1 postbacks — the whole gross G enters the system:
// 3 % safety reserve + 5 % boss pool + 92 % V). Banner pings / timer-only claims are unverified → 0.
const inflow = { postbackVerified: 0, directLinkVerified: 0, bossTopUp: 0, grossClaimed: 0, unverifiedEstimate: 0, byCountry: {} };
const addInflow = (cc, kind, safe, gross) => {
  inflow[kind] += safe;
  inflow.safetyExpected = (inflow.safetyExpected || 0) + S.splitAdGross(safe).safetyReserveMicroUsd;
  inflow.grossClaimed += gross;
  const c = (inflow.byCountry[cc] ||= { safe: 0, gross: 0, events: 0 });
  c.safe += safe;
  c.gross += gross;
  c.events++;
};

// =================================================================================================
console.log(`\n── 02 simulation: ${N} players, ${PLAY_SECONDS}s of play ──`);
const reach = await call('/api/auth/providers');
if (reach.status !== 200 || !reach.body.telegramEnabled) throw new Error(`api-worker not ready at ${API}: ${reach.status}`);

// ---- 0. ops account + live ad config (super_admin set straight in the LOCAL D1: test setup) -------
const ops = await signup(`au${RUN}ops`);
sqlFile([`UPDATE users SET staff_role = 'super_admin' WHERE id = '${ops.id}';`]);
const banner = (k) => `<script>atOptions = {'key' : '${k}','format' : 'iframe','height' : 50,'width' : 320,'params' : {}};</script><script src="https://www.highperformanceformat.com/${k}/invoke.js"></script>`;
const cfg = await call('/api/admin/ads/config', {
  method: 'PUT', token: ops.token,
  body: { adMode: 'live', adsterraEnabled: true, adsterraBanner320x50: banner('0123456789abcdef0123456789abcdef'), monetagEnabled: true, monetagDirectLinkUrl: 'https://example.invalid/direct-link' },
});
check(SEC, 'setup: super_admin switches ads to live (banner 320x50 + Monetag direct link)', cfg.status === 200, `${cfg.status} ${JSON.stringify(cfg.body).slice(0, 120)}`);
const heartbeat = () => call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${SECRETS.INTERNAL_API_SECRET}` }, body: { nodeId: `audit-node-${RUN}`, nodeName: 'audit-node', role: 'game', activeRooms: 3, playerCount: N } });
await heartbeat();
const hbTimer = setInterval(() => heartbeat().catch(() => {}), 20_000);
// V1.2 Golden Boss: fund the Boss Bounty Pool for the test (a marketing top-up, done BEFORE the money snapshot so
// it is part of the starting balance; the 5 % gross + 5 % fee of this run's verified revenue add to it)
const BOSS_TOP_UP = 1_000_000;
sqlFile([`UPDATE system_balances SET boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd + ${BOSS_TOP_UP} WHERE id = 'global';`]);
const bossBefore = sql1("SELECT COUNT(*) AS n FROM boss_bounty_reservations");
const money0 = moneySnapshot();

// ---- 1. sign-ups with referral codes ------------------------------------------------------------
const players = [];
for (let i = 0; i < N; i++) {
  let sponsor = null;
  if (i > 0 && Math.random() > 0.08) {
    // mostly recent players (deep chains > 5 levels) + some popular early recruiters
    sponsor = Math.random() < 0.7 ? players[Math.max(0, i - 1 - Math.floor(Math.random() * 4))] : players[Math.floor(Math.random() * Math.min(i, 6))];
  }
  const p = await signup(`au${RUN}p${i}`, sponsor ? sponsor.username : undefined);
  p.idx = i;
  p.country = i === 0 ? 'TH' : pick(countryPool);
  p.ip = `10.${(i >> 8) & 255}.${i & 255}.${10 + (i % 200)}`;
  p.deviceId = `dev-${RUN}-${i}`;
  p.sponsor = sponsor?.id ?? null;
  p.stats = { ads: 0, banners: 0, entries: 0, restakes: 0, kills: 0, deaths: 0, cheersGiven: 0, cheersRecv: 0, leftAlive: 0, rejoined: 0, suicides: 0, energyLeft: 1 };
  if (sponsor) sponsorOf.set(p.id, sponsor.id);
  players.push(p);
}
const byId = new Map(players.map((p) => [p.id, p]));
check(SEC, `${N} players signed up through Telegram (referral_code = sponsor username)`, players.length === N, `${players.filter((p) => p.sponsor).length} with a sponsor`);

// network_trees vs oracle
{
  const rows = sql(`SELECT ancestor_id AS a, descendant_id AS d, depth FROM network_trees WHERE descendant_id IN (${players.map((p) => `'${p.id}'`).join(',')})`);
  const got = new Map();
  for (const r of rows) (got.get(r.d) || got.set(r.d, []).get(r.d)).push(`${r.depth}:${r.a}`);
  let wrong = 0;
  let deeper = 0;
  for (const p of players) {
    const want = ancestorsOf(p.id).map((x) => `${x.depth}:${x.userId}`).sort().join();
    const have = (got.get(p.id) || []).sort().join();
    if (want !== have) wrong++;
    let cur = p.id;
    let d = 0;
    while (sponsorOf.get(cur)) { cur = sponsorOf.get(cur); d++; }
    if (d > 5) deeper++;
  }
  check(SEC, 'referral: network_trees holds exactly the 5 nearest ancestors of every player (no 6th level)', wrong === 0, `${wrong} mismatches · ${deeper} players have chains deeper than 5`);
  const st = sql1(`SELECT COUNT(*) AS n, SUM(backed_micro_usd) AS v FROM user_energy_tickets WHERE user_id IN (${players.map((p) => `'${p.id}'`).join(',')})`);
  check(SEC, '§7.2 sign-up: exactly 1 starter EC per player, backed 0 µUSD', Number(st.n) === N && Number(st.v) === 0, JSON.stringify(st));
}

// Root posts something people can cheer
const posts = [];
for (const p of players.filter((x) => x.idx % 10 === 0)) {
  const r = await call('/api/social/posts', { method: 'POST', token: p.token, body: { body: `Audit post from player ${p.idx} #mwar`, tag: 'General' } });
  if (r.status < 300 && (r.body.post?.id || r.body.id)) posts.push({ id: r.body.post?.id || r.body.id, owner: p });
}
note(SEC, `${posts.length} social posts created for cheering`);

// ---- 2. EC charging with real-revenue ads valued in each player's own country --------------------
let postbackNetBad = 0;
let unpricedBacked = 0;
const postback = async (p, priced) => {
  const q = new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: p.id, geo: p.country === 'GLOBAL' ? 'ZZ' : p.country, click_id: `au_${RUN}_${uuid()}` });
  // ~1/3 of the postbacks carry the network's own estimated_price (P1): a realistic Monetag direct-link CPM ($0.5–$4)
  let price = null;
  if (priced) {
    const tier = S.COUNTRY_AD_ECPM_USD[p.country]?.tier ?? 0;
    price = (tier === 1 ? rnd(2, 4) : tier === 2 ? rnd(0.8, 2) : rnd(0.3, 0.9)) / 1000;
    q.set('estimated_price', price.toFixed(6));
  }
  const r = await call(`/api/ads/postback/monetag?${q}`);
  if (r.status === 200 && r.body.note === 'credited') {
    const eff = Number(r.body.effectiveMicroUsd);
    if (r.body.verified === true) {
      addInflow(p.country, 'postbackVerified', eff, eff);
      if (Number(r.body.netMicroUsd) !== S.splitAdGross(eff).netMicroUsd) postbackNetBad++;
    } else inflow.unverifiedEstimate += eff;
    if (!priced && Number(r.body.netMicroUsd || 0) !== 0) unpricedBacked++;
    p.stats.ads++;
  }
  return r;
};
{
  const t0 = Date.now();
  const res = await Promise.all(
    players.map(async (p) => {
      // 4–13 direct-link visits before the first match; the players who later leave alive (idx % 9 === 3) get 10 more
      // UNPRICED ones (EC % only, 0 µUSD) so they keep re-staking until they leave (V1.2 multipliers give less EC per visit)
      const n = 4 + Math.floor(Math.random() * 10) + (p.idx % 9 === 3 ? 10 : 0);
      const out = [];
      for (let k = 0; k < n; k++) out.push(await postback(p, k < n - (p.idx % 9 === 3 ? 10 : 0) && Math.random() < 0.33));
      return out;
    })
  );
  const flat = res.flat();
  const bad = flat.filter((r) => r.status !== 200);
  check(SEC, 'Monetag S2S postbacks (geo = player country) accepted', bad.length === 0, `${flat.length} postbacks in ${((Date.now() - t0) / 1000).toFixed(1)} s · non-200: ${bad.length}`);
  const dupe = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: players[1].id, geo: 'TH', click_id: 'au_dupe_1' })}`);
  const dupe2 = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: players[1].id, geo: 'TH', click_id: 'au_dupe_1' })}`);
  check(SEC, 'replayed postback (same click_id) credits nothing', dupe2.body.duplicate === true, JSON.stringify(dupe2.body).slice(0, 80));
  check(SEC, 'V1.2 H2: a postback WITHOUT the network price credits EC % only (0 µUSD backing); a priced one backs V = 92 % of G', unpricedBacked === 0 && postbackNetBad === 0 && dupe.body.verified !== true, `unpriced with backing: ${unpricedBacked} · priced with a wrong V: ${postbackNetBad}`);
  const tk = sql(`SELECT u.id, u.energy_tickets AS cached, (SELECT COUNT(*) FROM user_energy_tickets t WHERE t.user_id = u.id AND t.status = 'available') AS rows_, (SELECT COALESCE(SUM(backed_micro_usd),0) FROM user_energy_tickets t WHERE t.user_id = u.id AND t.status='available') AS v FROM users u WHERE u.id IN (${players.map((p) => `'${p.id}'`).join(',')})`);
  const cacheBad = tk.filter((r) => Number(r.cached) !== Number(r.rows_));
  check(SEC, 'users.energy_tickets cache == available ticket rows after charging', cacheBad.length === 0, `${cacheBad.length} mismatched`);
  for (const r of tk) byId.get(r.id).stats.energyLeft = Number(r.rows_);
  const ecDist = tk.map((r) => Number(r.rows_));
  note(SEC, `EC after charging: min ${Math.min(...ecDist)}, avg ${(ecDist.reduce((a, b) => a + b, 0) / N).toFixed(1)}, max ${Math.max(...ecDist)}`);
}

// ---- 3. daily missions (≈60 % of players unlock the 4/5 MLM gate) --------------------------------
const questers = players.filter(() => Math.random() < 0.6);
for (const p of players) p.quester = questers.includes(p);
await Promise.all(players.map(async (p) => {
  await call('/api/quests/progress', { method: 'POST', token: p.token, body: { questId: 'Q_DAILY_CHECKIN', increment: 1 } });
  if (p.quester || Math.random() < 0.5) await call('/api/network/downline', { token: p.token });
}));
// spectate heartbeats run during the match (every 15 s, 6 × = 90 s)
const spectate = async (p) => {
  for (let k = 0; k < 7; k++) {
    await call('/api/quests/progress', { method: 'POST', token: p.token, body: { questId: 'Q_SPECTATE', increment: 15 } });
    await sleep(15_200);
  }
};

// ---- 4. play on the real game server --------------------------------------------------------------
const { Client } = colyseus();
const modeOf = (i) => (i % 10 < 6 ? 'mini_30' : i % 10 < 8 ? 'standard_100' : 'fast_mini');
const game = { joinFail: 0, joinErrors: [], killEvents: 0, paidKillEvents: 0, bountyEvents: 0, restakeOk: 0, restakeFail: 0, restakeCodes: {}, toLobby: 0, freeRespawn: 0, autoRespawn: 0, rejoinOk: 0, rejoinFail: 0, activeSeen: 0, enterCodes: {}, suicides: 0, chestHits: 0, bannerOk: 0, bannerCodes: {} };
let stopping = false;
const sessions = [];

async function enter(p, mode, restakeAfter) {
  const r = await call('/api/game/enter', { method: 'POST', token: p.token, body: { mode, ...(restakeAfter ? { restakeAfter } : {}) } });
  game.enterCodes[`${restakeAfter ? 'restake' : 'enter'}:${r.status}${r.body.code ? '/' + r.body.code : ''}`] = (game.enterCodes[`${restakeAfter ? 'restake' : 'enter'}:${r.status}${r.body.code ? '/' + r.body.code : ''}`] || 0) + 1;
  if (r.status === 200 && typeof r.body.energyTickets === 'number') p.stats.energyLeft = r.body.energyTickets;
  return r;
}

async function bannerPing(p, sess) {
  const r = await call('/api/ads/impression', { method: 'POST', token: p.token, body: { slot: 'adsterra_320x50', count: 1, lastActiveAt: Date.now(), clientNow: Date.now(), ...(sess?.fastMini ? { fastMiniEntryId: sess.entryId } : {}) } });
  game.bannerCodes[r.status] = (game.bannerCodes[r.status] || 0) + 1;
  if (r.status === 200) {
    game.bannerOk++;
    p.stats.banners++;
    // V1.2 H2: an unverified banner ping never brings cash backing (the Fast & Mini pot share comes from the Energy Pool)
    if (Number(r.body.backedMicroUsd || 0) !== 0) game.bannerBacked = (game.bannerBacked || 0) + 1;
    if (Number(r.body.fastMiniPotAddedMicroUsd || 0) > 0) game.bannerFmPot = (game.bannerFmPot || 0) + 1;
    inflow.unverifiedEstimate += Number(r.body.adValueMicroUsd || 0);
  }
}

async function joinRoom(p, mode, opts) {
  const client = new Client(GAME_WS, { headers: { 'cf-connecting-ip': p.ip } });
  try {
    return opts.roomId ? await client.joinById(opts.roomId, { rejoinToken: opts.rejoinToken, deviceId: p.deviceId }) : await client.joinOrCreate(mode, { entryToken: opts.entryToken, deviceId: p.deviceId, username: p.username });
  } catch (e) {
    game.joinFail++;
    if (game.joinErrors.length < 6) game.joinErrors.push(String(e?.message || e).slice(0, 120));
    return null;
  }
}

function drive(p, room, sess) {
  sess.room = room;
  room.onMessage('*', (type, msg) => {
    if (type === 'player_killed') {
      if (msg.killerId === p.id) p.stats.kills++;
      if (sess.observer) {
        game.killEvents++;
        if (Number(msg.ticketMicroUsd || 0) > 0) game.paidKillEvents++;
        if (Number(msg.bountyClaimedMicroUsd || 0) > 0) game.bountyEvents++;
      }
    }
    if (type === 'player_damaged' && msg?.rejected) game.rejected = (game.rejected || 0) + 1;
    if (type === 'player_eliminated') {
      p.stats.deaths++;
      const diedAt = Date.now();
      sess.alive = false;
      const deathNo = (sess.deathNo = (sess.deathNo || 0) + 1);
      setTimeout(() => {
        const me = room.state?.players?.get(room.sessionId);
        // (only if this is still the latest death: a re-kill right after "Play again" resets choseAgain
        // before the 20 Hz state patch shows the new ghost state)
        if (me && !me.isGhost && !sess.choseAgain && sess.deathNo === deathNo) game.autoRespawn++;
      }, 3500);
      sess.choseAgain = false;
      setTimeout(async () => {
        if (stopping || !room.connection?.isOpen) return;
        if (msg.respawnMode === 'restake') {
          if (p.stats.energyLeft > 0 && (p.idx % 9 === 3 || Math.random() < 0.8)) {
            const r = await enter(p, sess.mode, sess.entryId);
            if (r.status === 200) {
              sess.choseAgain = true;
              sess.entryId = r.body.entryId;
              room.send('player_restake', { entryToken: r.body.entryToken });
              game.restakeOk++;
              p.stats.restakes++;
              sess.alive = true;
            } else {
              game.restakeFail++;
              game.restakeCodes[r.body.code || r.status] = (game.restakeCodes[r.body.code || r.status] || 0) + 1;
              game.toLobby++;
              await room.leave(true).catch(() => {});
            }
          } else {
            game.toLobby++;
            await room.leave(true).catch(() => {});
          }
        } else {
          await sleep(Math.max(0, 3200 - (Date.now() - diedAt)));
          sess.choseAgain = true;
          room.send('player_respawn', {});
          game.freeRespawn++;
          sess.alive = true;
        }
      }, 600 + Math.random() * 900);
    }
  });
  let tick = 0;
  sess.timer = setInterval(() => {
    if (stopping || !room.connection?.isOpen) return;
    const ps = room.state?.players;
    const me = ps?.get(room.sessionId);
    if (!me || me.isGhost) return;
    tick++;
    // like a player: walk toward the nearest live enemy, face it, shoot when it is within ~40 m (H1: the
    // server checks range, aim and walls itself, so a bot that shoots blindly hits nothing)
    let best = null;
    let bestD = Infinity;
    ps.forEach((o, sid) => {
      if (sid === room.sessionId || o.isGhost || o.isSpectator) return;
      const d = Math.hypot(o.x - me.x, o.z - me.z);
      if (d < bestD) { bestD = d; best = { o, sid }; }
    });
    let nx = me.x + rnd(-0.6, 0.6);
    let nz = me.z + rnd(-0.6, 0.6);
    let yaw = me.rotationY || 0;
    if (best) {
      yaw = Math.atan2(-(best.o.x - me.x), -(best.o.z - me.z));
      if (bestD > 12) {
        nx = me.x + ((best.o.x - me.x) / bestD) * 0.9 + rnd(-0.3, 0.3);
        nz = me.z + ((best.o.z - me.z) / bestD) * 0.9 + rnd(-0.3, 0.3);
      }
    }
    room.send('player_move', { x: nx, y: me.y, z: nz, rotationY: yaw, stance: 'stand' });
    if (tick % 5 === 0) {
      const chests = [];
      room.state?.chests?.forEach((c, id) => chests.push({ id, c }));
      const nearChest = chests.find(({ c }) => Math.hypot(c.x - me.x, c.z - me.z) < 30);
      if (nearChest && Math.random() < 0.3) {
        const cy = Math.atan2(-(nearChest.c.x - me.x), -(nearChest.c.z - me.z));
        room.send('player_move', { x: nx, y: me.y, z: nz, rotationY: cy, stance: 'stand' });
        room.send('player_shoot', { targetType: 'chest', targetId: nearChest.id, damage: 34, yaw: cy });
        game.chestHits++;
      } else if (best && bestD < 40 && Math.random() < 0.45) {
        room.send('player_fired', {});
        const head = Math.random() < 0.2;
        room.send('player_shoot', { targetType: 'player', targetId: best.sid, damage: head ? 68 : 34, yaw, hit: { x: best.o.x, y: best.o.y + (head ? 1.68 : 1.1), z: best.o.z } });
        game.shots = (game.shots || 0) + 1;
      }
    }
  }, 100);
}

async function playSession(p) {
  const mode = modeOf(p.idx);
  const e = await enter(p, mode);
  if (e.status !== 200) return;
  p.stats.entries++;
  const sess = { p, mode, entryId: e.body.entryId, fastMini: !!e.body.fastMini, alive: true };
  const room = await joinRoom(p, mode, { entryToken: e.body.entryToken });
  if (!room) return;
  sess.observer = !sessions.some((s) => s.room?.roomId === room.roomId && s.observer);
  sessions.push(sess);
  drive(p, room, sess);
  // banner pings every 30–45 s while playing (Adsterra 320x50, country = this machine's Cloudflare country)
  (async () => {
    while (!stopping) {
      await sleep(rnd(30_000, 45_000));
      if (stopping) break;
      await bannerPing(p, sess).catch(() => {});
    }
  })();
  // behaviours
  if (p.idx % 23 === 5) {
    await sleep(rnd(20_000, 50_000));
    if (sess.room?.connection?.isOpen && sess.alive) {
      sess.room.send('player_suicide', { cause: 'fall' });
      game.suicides++;
      p.stats.suicides++;
    }
  }
  if (p.idx % 9 === 3 && !sess.fastMini) {
    // leaves the match while alive (closes the tab): the body must stay, then half of them Rejoin
    await sleep(rnd(10_000, 20_000));
    // wait until this character is alive (not on the death screen) — up to 60 s
    for (let w = 0; w < 120 && !(sess.alive && sess.room?.connection?.isOpen && !sess.room.state?.players?.get(sess.room.sessionId)?.isGhost); w++) await sleep(500);
    if (stopping || !sess.room?.connection?.isOpen || !sess.alive) return;
    clearInterval(sess.timer);
    await sess.room.leave(true).catch(() => {});
    p.stats.leftAlive++;
    // check after 3 s: in a crowded 30P room an idle body is often shot within seconds
    await sleep(3_000);
    const act = await call('/api/game/active-session?rejoin=1', { token: p.token });
    if (act.body.session) game.activeSeen++;
    sess.awaySession = act.body.session;
    // every other player whose body is still there comes back (Rejoin)
    if (act.body.session && act.body.rejoinToken && (game.leaverSeq = (game.leaverSeq || 0) + 1) % 2 === 1) {
      await sleep(rnd(500, 2_000));
      const again = await call('/api/game/active-session?rejoin=1', { token: p.token });
      if (!again.body.session) return; // killed while away
      const r2 = await joinRoom(p, mode, { roomId: again.body.session.roomId, rejoinToken: again.body.rejoinToken });
      if (r2) {
        game.rejoinOk++;
        p.stats.rejoined++;
        drive(p, r2, sess);
      } else game.rejoinFail++;
    }
  }
}

// ---- 5. cheers (direct link = real revenue; in-app card = no revenue) ----------------------------
const cheer = { ok: 0, codes: {}, selfBlocked: 0, selfTried: 0, targetCapHit: 0, cooldownHit: 0, inAppOk: 0, inAppCreatorPaid: 0, creatorPaid: 0, timerBacked: 0, verified: 0, doubleVerified: 0 };
const cheerCode = (k) => (cheer.codes[k] = (cheer.codes[k] || 0) + 1);
async function directCheer(p, targetType, targetId) {
  const s = await call('/api/ads/direct-link/start', { method: 'POST', token: p.token, body: { purpose: 'cheer', seconds: 15, targetType, targetId } });
  cheerCode(`start:${s.status}${s.body.code ? '/' + s.body.code : ''}`);
  if (s.status !== 200) return s;
  await sleep(15_500);
  const c = await call('/api/ads/direct-link/claim', { method: 'POST', token: p.token, body: { token: s.body.token } });
  cheerCode(`claim:${c.status}${c.body.code ? '/' + c.body.code : ''}`);
  if (c.status === 200) {
    cheer.ok++;
    p.stats.cheersGiven++;
    const owner = targetType === 'profile' ? byId.get(targetId) : posts.find((x) => x.id === targetId)?.owner;
    if (owner) owner.stats.cheersRecv++;
    if (Number(c.body.creatorMicroUsd) > 0) cheer.creatorPaid++;
    // V1.2: the 15 s timer is no network confirmation → creator 0, EC % with 0 µUSD backing
    if (Number(c.body.valueMicroUsd || 0) > 0 || Number(c.body.ecBackingMicroUsd || 0) > 0) cheer.timerBacked++;
    inflow.unverifiedEstimate += Number(c.body.effectiveMicroUsd || 0);
    // ~half of the visits later get Monetag's S2S postback for this token (ymid = dl_ token) with a real price
    if (Math.random() < 0.5) {
      const cc = p.country === 'GLOBAL' ? 'GLOBAL' : p.country;
      const tier = S.COUNTRY_AD_ECPM_USD[cc]?.tier ?? 0;
      const price = (tier === 1 ? rnd(2, 4) : tier === 2 ? rnd(0.8, 2) : rnd(0.3, 0.9)) / 1000;
      const q = new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: s.body.token, estimated_price: price.toFixed(6), click_id: `au_cheer_${RUN}_${uuid()}` });
      const pb = await call(`/api/ads/postback/monetag?${q}`);
      if (pb.status === 200 && pb.body.verified === true) {
        cheer.verified++;
        addInflow(cc, 'directLinkVerified', Number(pb.body.effectiveMicroUsd), Number(pb.body.effectiveMicroUsd));
        if (Number(pb.body.creatorMicroUsd) > 0) cheer.creatorPaid++;
        // a replayed postback for the same visit (new click id) adds nothing
        const again = await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: s.body.token, estimated_price: price.toFixed(6), click_id: `au_cheer_${RUN}_${uuid()}` })}`);
        if (again.body.verified === true) cheer.doubleVerified++;
      } else cheerCode(`postback:${pb.status}/${pb.body.note || pb.body.error || ''}`);
    }
  }
  return c;
}
async function cheerer(p) {
  await sleep(rnd(0, 20_000));
  // self-cheer must be refused (profile + own post)
  if (p.idx % 7 === 0) {
    cheer.selfTried++;
    const s1 = await call('/api/ads/direct-link/start', { method: 'POST', token: p.token, body: { purpose: 'cheer', seconds: 15, targetType: 'profile', targetId: p.id } });
    const s2 = await call('/api/ads/cheer/start', { method: 'POST', token: p.token, body: { format: 'video_15s', targetType: 'profile', targetId: p.id } });
    if (s1.status === 400 && s1.body.code === 'SELF_CHEER' && s2.status === 400 && s2.body.code === 'SELF_CHEER') cheer.selfBlocked++;
  }
  const others = players.filter((o) => o.id !== p.id);
  const n = 1 + Math.floor(Math.random() * 3);
  for (let k = 0; k < n && !stopping; k++) {
    const r = Math.random();
    if (r < 0.35 && p.sponsor) await directCheer(p, 'profile', p.sponsor);
    else if (r < 0.65 && posts.length) {
      const post = pick(posts.filter((x) => x.owner.id !== p.id));
      if (post) await directCheer(p, 'post', post.id);
    } else await directCheer(p, 'profile', pick(others).id);
    await sleep(46_000 - 15_500); // respect the 45 s cooldown between ad starts
  }
}

// cheer limit probes on 3 dedicated accounts (cooldown, 3 per creator / day)
async function cheerLimitProbe() {
  const a = await signup(`au${RUN}cA`);
  const b = await signup(`au${RUN}cB`);
  a.stats = { cheersGiven: 0, cheersRecv: 0 };
  b.stats = { cheersGiven: 0, cheersRecv: 0 };
  const first = await directCheer(a, 'profile', b.id);
  const tooSoon = await call('/api/ads/direct-link/start', { method: 'POST', token: a.token, body: { purpose: 'cheer', seconds: 15, targetType: 'profile', targetId: b.id } });
  if (tooSoon.status === 429) cheer.cooldownHit++;
  check(SEC, '§7.5 cheer cooldown: a 2nd ad start within 45 s → 429', first.status === 200 && tooSoon.status === 429, `first ${first.status} · second ${tooSoon.status}/${tooSoon.body.code}`);
  // 3 per creator per day: fill the cap straight in D1 (2 more events), then the 4th must be refused
  sqlFile([
    `INSERT INTO cheer_events (id, user_id, target_type, target_id, target_user_id, ad_format, view_id, ec_progress_bp, value_micro_usd, country_code, date_key, created_at) SELECT 'chr_au_' || hex(randomblob(6)), '${a.id}', 'profile', '${b.id}', '${b.id}', 'video_15s', 'au_view_' || hex(randomblob(8)), 0, 0, 'TH', '${today}', unixepoch() - 3600 FROM (SELECT 1 UNION ALL SELECT 2);`,
  ]);
  await sleep(46_000);
  const fourth = await call('/api/ads/direct-link/start', { method: 'POST', token: a.token, body: { purpose: 'cheer', seconds: 15, targetType: 'profile', targetId: b.id } });
  if (fourth.status === 429) cheer.targetCapHit++;
  check(SEC, '§7.5 cheer cap: the 4th cheer of one viewer to the same creator in a day → 429 target_cap', fourth.status === 429 && (fourth.body.reason === 'target_cap' || fourth.body.code === 'CHEER_LIMIT'), `${fourth.status} ${fourth.body.code}/${fourth.body.reason}`);
  // in-app (test-mode) cheer card: no network pays → creator gets 0
  const ia = await call('/api/ads/cheer/start', { method: 'POST', token: a.token, body: { format: 'banner', targetType: 'post', targetId: posts[0]?.id } });
  if (ia.status === 200) {
    await sleep((S.CHEER_BANNER_SECONDS + 1) * 1000);
    const done = await call('/api/ads/cheer', { method: 'POST', token: a.token, body: { viewId: ia.body.viewId } });
    if (done.status === 200) cheer.inAppOk++;
    if (Number(done.body.creatorMicroUsd) > 0) cheer.inAppCreatorPaid++;
    note(SEC, `in-app cheer card (no ad network): HTTP ${done.status}, creator paid ${done.body.creatorMicroUsd ?? 0} µUSD, viewer EC backing ${done.body.ecBackingMicroUsd ?? 0} µUSD from the Energy Pool`);
  } else note(SEC, `in-app cheer start → ${ia.status} ${ia.body.code || ia.body.error || ''}`);
}

// ---- run the day ------------------------------------------------------------------------------------
const t0 = Date.now();
const playing = players.map((p, i) => sleep(i * 120).then(() => playSession(p)).catch((e) => console.warn('play', p.idx, e.message)));
const spectating = questers.map((p) => spectate(p).catch(() => {}));
const cheering = players.filter(() => Math.random() < 0.7).map((p) => cheerer(p).catch((e) => console.warn('cheer', p.idx, e.message)));
const probe = cheerLimitProbe().catch((e) => check(SEC, 'cheer limit probe ran', false, e.message));
await Promise.all(playing);
// mid-game: bodies of players who left alive must be visible as active sessions
await sleep(Math.max(0, PLAY_SECONDS * 1000 - (Date.now() - t0)));
stopping = true;
check(SEC, '§5.3 a player who leaves alive still has a live character (GET /api/game/active-session)', game.activeSeen > 0 && game.activeSeen >= Math.floor(players.filter((p) => p.stats.leftAlive).length * 0.5), `${game.activeSeen} of ${players.filter((p) => p.stats.leftAlive).length} who left alive were still in the arena 3 s later`);
check(SEC, '§5.3 Rejoin re-attaches to the same body (no new EC)', game.rejoinOk > 0 && game.rejoinFail === 0, `${game.rejoinOk} ok / ${game.rejoinFail} failed`);
for (const s of sessions) clearInterval(s.timer);
await Promise.allSettled(sessions.map((s) => s.room?.connection?.isOpen && s.room.leave(true)));
await Promise.all([...spectating, ...cheering, probe]);
console.log('  waiting for the last 10 s payout batches + body-only room shutdown…');
await sleep(45_000);
clearInterval(hbTimer);

check(SEC, '§5.2 Paid-EC / Fast & Mini rooms: no automatic respawn', game.autoRespawn === 0, `${game.autoRespawn} automatic respawns`);
check(SEC, 'all game-server joins succeeded', game.joinFail === 0, `${game.joinFail} failed ${game.joinErrors.join(' | ')}`);
note(SEC, `game: ${game.killEvents} kills seen by room observers (${game.paidKillEvents} paid by a ticket, ${game.bountyEvents} with bounty) · restake ok ${game.restakeOk} / refused ${game.restakeFail} ${JSON.stringify(game.restakeCodes)} · to lobby ${game.toLobby} · free respawn ${game.freeRespawn} · suicides ${game.suicides} · chest hits ${game.chestHits} · shots sent ${game.shots || 0}, refused by server ballistics ${game.rejected || 0}`);
note(SEC, `enter codes ${JSON.stringify(game.enterCodes)} · banner pings ${JSON.stringify(game.bannerCodes)}`);
check(SEC, '§7.5 self-cheer refused on post/profile (direct link + in-app)', cheer.selfBlocked === cheer.selfTried, `${cheer.selfBlocked}/${cheer.selfTried}`);
check(SEC, 'V1.2 H2: live banner pings credit EC % with 0 µUSD backing (unverified)', game.bannerOk > 0 && !game.bannerBacked, `${game.bannerOk} banners · ${game.bannerBacked || 0} with backing · ${game.bannerFmPot || 0} funded a Fast & Mini pot from the Energy Pool`);
check(SEC, 'V1.2 H2: timer-only direct-link cheer claims pay the creator 0 and back 0 µUSD', cheer.ok > 0 && cheer.timerBacked === 0, `${cheer.ok} timer claims · ${cheer.timerBacked} with value`);
check(SEC, 'V1.2 H2: the S2S postback (estimated_price) of a claimed cheer visit pays the 55/15/5/5/20 split exactly once', cheer.verified > 0 && cheer.doubleVerified === 0 && cheer.creatorPaid === cheer.verified, `${cheer.verified} verified visits · creator paid ${cheer.creatorPaid} · replay applied ${cheer.doubleVerified}`);
note(SEC, `cheers: ${cheer.ok} direct-link cheers (timer), ${cheer.verified} verified later by postback · codes ${JSON.stringify(cheer.codes)}`);

// ---- 6. midnight MLM settlement (run 3× in parallel to look for double payment) -----------------------
const mlmBefore = sql1(`SELECT COALESCE(SUM(CASE WHEN status IN ('pending_grey','unlocked_green') THEN amount_micro_usd END),0) AS open, SUM(CASE WHEN status IN ('pending_grey','unlocked_green') THEN 1 ELSE 0 END) AS n, COALESCE(SUM(CASE WHEN status = 'settled_paid' THEN amount_micro_usd END),0) AS paid0, COALESCE(SUM(CASE WHEN status = 'forfeited_burned' THEN amount_micro_usd END),0) AS burned0 FROM daily_mlm_pending_ledger WHERE date_key = '${today}'`);
const ledgerBefore = Number(sql1("SELECT COALESCE(SUM(delta_micro_usd),0) AS s FROM wallet_ledger WHERE action_type = 'MLM_COMMISSION'").s);
const settle = await Promise.all([0, 1, 2].map(() => call('/api/quests/settle-daily-mlm', { method: 'POST', headers: { 'X-Internal-Secret': SECRETS.INTERNAL_API_SECRET }, body: { dateKey: today } })));
const mlmAfter = sql1(`SELECT COALESCE(SUM(CASE WHEN status = 'settled_paid' THEN amount_micro_usd END),0) AS paid, COALESCE(SUM(CASE WHEN status = 'forfeited_burned' THEN amount_micro_usd END),0) AS burned, COALESCE(SUM(CASE WHEN status IN ('pending_grey','unlocked_green') THEN amount_micro_usd END),0) AS open FROM daily_mlm_pending_ledger WHERE date_key = '${today}'`);
const ledgerAfter = Number(sql1("SELECT COALESCE(SUM(delta_micro_usd),0) AS s FROM wallet_ledger WHERE action_type = 'MLM_COMMISSION'").s);
const mlmCredited = ledgerAfter - ledgerBefore;
const paidNow = Number(mlmAfter.paid) - Number(mlmBefore.paid0);
const burnedNow = Number(mlmAfter.burned) - Number(mlmBefore.burned0);
check(SEC, 'MLM settlement: 3 parallel triggers credit the day exactly once (wallets get exactly the settled rows)', mlmCredited === paidNow && Number(mlmAfter.open) === 0 && paidNow + burnedNow === Number(mlmBefore.open), `pending ${mlmBefore.open} µUSD in ${mlmBefore.n} rows → paid ${paidNow} + burned ${burnedNow} · wallets credited ${mlmCredited} (${(mlmCredited / Math.max(1, paidNow)).toFixed(2)}×) · HTTP ${settle.map((r) => r.status).join(',')}`);

// ---- 7. invariants in D1 -------------------------------------------------------------------------------
const ids = players.map((p) => `'${p.id}'`).join(',');
const money1 = moneySnapshot();
const inflowTotal = inflow.postbackVerified + inflow.directLinkVerified + inflow.bossTopUp;
const delta = money1.total - money0.total;
const extraMlm = mlmCredited - paidNow; // money created by a double settlement, if any
check(SEC, 'ZERO-DEFICIT: money in the system grew by exactly the real ad revenue credited (nothing created or lost)', delta === inflowTotal, `Δ ${delta} µUSD vs verified inflow ${inflowTotal} µUSD (postback ${inflow.postbackVerified} + direct-link postback ${inflow.directLinkVerified}) · unverified estimate NOT credited ${inflow.unverifiedEstimate} · diff ${delta - inflowTotal}${extraMlm ? ` (double MLM settlement ${extraMlm})` : ''}`);
{
  // V1.2: the 3 % / 5 % of every verified gross reached the safety reserve / boss pool
  const parts = sql1(`SELECT COALESCE(SUM(verified_gross_micro_usd),0) AS g FROM ad_click_tokens WHERE verified_at IS NOT NULL`);
  note(SEC, `V1.2 pools: safety reserve +${money1.safetyReserve - money0.safetyReserve} µUSD · boss pool ${money0.bossPool} → ${money1.bossPool} µUSD · verified direct-link gross ${parts.g} µUSD`);
  check(SEC, 'V1.2 safety reserve grew by exactly Σ 3 % of each verified gross (never from unverified ads)', money1.safetyReserve - money0.safetyReserve === inflow.safetyExpected, `+${money1.safetyReserve - money0.safetyReserve} µUSD vs expected ${inflow.safetyExpected} for verified ${inflowTotal}`);
  // Golden Boss reservations of this run
  const rs = sql(`SELECT id, status, amount_micro_usd AS a, target_user_id AS t, claimed_by_user_id AS k, settle_ref AS ref FROM boss_bounty_reservations LIMIT -1 OFFSET ${Number(bossBefore.n || 0)}`);
  const claimed = rs.filter((r) => r.status === 'claimed');
  const released = rs.filter((r) => r.status === 'released');
  const live = rs.filter((r) => r.status === 'reserved');
  check(SEC, 'V1.2 §5.6 Golden Boss: the game server reserved draws of 500 C – 2,000 C from the Boss Bounty Pool in Paid-EC rooms', rs.length > 0 && rs.every((r) => Number(r.a) >= 50_000 && Number(r.a) <= 200_000), `${rs.length} draws · ${claimed.length} claimed · ${released.length} returned (${[...new Set(released.map((r) => r.ref))].join(',')})`);
  check(SEC, 'V1.2 Golden Boss: every reservation ended exactly once after the rooms closed (none left reserved)', live.length === 0, `${live.length} still reserved`);
  let claimBad = 0;
  for (const r of claimed) {
    const led = sql(`SELECT delta_micro_usd AS d FROM wallet_ledger WHERE action_type = 'BOSS_BOUNTY_CLAIM' AND ref_id = 'boss:${r.id}'`);
    const want = Number(S.calculateRewardSplit(Number(r.a), ancestorsOf(r.k)).earnerMicroUsd);
    if (led.length !== 1 || Number(led[0].d) !== want || r.k === r.t) claimBad++;
  }
  check(SEC, 'V1.2 BOSS_BOUNTY_CLAIM: each claimed boss paid its killer exactly the 55 % share, once', claimBad === 0, `${claimed.length} claims · ${claimBad} wrong`);
}
check(SEC, 'no negative wallet / bounty balance', money1.negativeWallets === 0, `${money1.negativeWallets}`);
check(SEC, 'Energy Pool never overdrawn (pool − drawn ≥ 0)', money1.poolUnspent >= 0, `pool ${money1.pool} drawn ${money1.drawn}`);
{
  const drift = sql(`SELECT w.user_id, w.balance_micro_usd AS b, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = w.user_id) AS l FROM wallets w WHERE w.user_id IN (${ids}) AND w.balance_micro_usd != (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = w.user_id)`);
  check(SEC, '§6 Layer 1: wallet balance == Σ wallet_ledger for every player', drift.length === 0, `${drift.length} wallets drift ${drift.slice(0, 3).map((d) => `${d.b}≠${d.l}`).join(' ')}`);
  const tix = sql1(`SELECT SUM(CASE WHEN status='in_match' THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END) AS settled, SUM(CASE WHEN settle_action IN ('GAME_KILL','CHEST_OPEN') THEN 1 ELSE 0 END) AS paid, COALESCE(SUM(CASE WHEN settle_action IN ('GAME_KILL','CHEST_OPEN') THEN settled_micro_usd END),0) AS paidV, COALESCE(SUM(CASE WHEN settle_action IN ('GAME_KILL','CHEST_OPEN') THEN backed_micro_usd END),0) AS paidB, SUM(CASE WHEN settle_action LIKE 'TICKET_FORFEIT%' THEN 1 ELSE 0 END) AS forf, SUM(CASE WHEN status='available' AND match_id IS NULL AND consumed_at IS NULL THEN 1 ELSE 0 END) AS avail FROM user_energy_tickets WHERE user_id IN (${ids})`);
  check(SEC, '§7.3 every paid ticket paid ≤ its backing (Σ paid ≤ Σ backed)', Number(tix.paidV) <= Number(tix.paidB), `${tix.paid} tickets paid ${tix.paidV} of ${tix.paidB} µUSD backing · forfeited ${tix.forf}`);
  check(SEC, '§5.3 after every room shut down no ticket is left in_match (bodies returned / settled)', Number(tix.live) === 0, `${tix.live} still in_match`);
  const sess = sql1(`SELECT COUNT(*) AS n FROM game_active_sessions WHERE user_id IN (${ids}) AND ended_at IS NULL`);
  check(SEC, '§5.3 no live session row left after the rooms closed', Number(sess.n) === 0, `${sess.n}`);
  // per-kill split vs the oracle (earner share and the 5 upline rows)
  // Fast & Mini kills are ALSO written as action_type 'GAME_KILL' (combat_events + wallet_ledger): tell them apart by the ticket
  const evAll = sql(`SELECT c.user_id, c.victim_id, c.game_id, c.gross_micro_usd AS v, c.earner_micro_usd AS e, EXISTS (SELECT 1 FROM user_energy_tickets t WHERE t.user_id = c.victim_id AND t.settled_to_user_id = c.user_id AND t.settle_action IN ('GAME_KILL','CHEST_OPEN') AND t.settle_ref = c.game_id) AS paidEc FROM combat_events c WHERE c.user_id IN (${ids}) AND c.action_type IN ('GAME_KILL','CHEST_OPEN')`);
  const ev = evAll.filter((x) => Number(x.paidEc) === 1);
  const fmEv = evAll.filter((x) => Number(x.paidEc) !== 1);
  const badE = ev.filter((x) => Number(x.e) !== Number(S.calculateRewardSplit(Number(x.v), ancestorsOf(x.user_id)).earnerMicroUsd));
  check(SEC, '§7.3 every Paid-EC kill / chest: shooter got exactly the 55 % share (0.007 C rounding)', ev.length > 0 && badE.length === 0, `${ev.length} paid kills/chests · ${badE.length} wrong`);
  const badF = fmEv.filter((x) => Number(x.e) !== Number(S.calculateFastMiniSplit(Number(x.v)).shooterMicroUsd));
  check(SEC, '§7.4 every Fast & Mini kill: shooter got exactly 90 % of the victim banner pot', badF.length === 0, `${fmEv.length} Fast & Mini kills · ${badF.length} wrong`);
  const expectUp = new Map();
  for (const x of ev) for (const u of S.calculateRewardSplit(Number(x.v), ancestorsOf(x.user_id)).uplinePayouts) {
    const k = `${u.userId}|${x.user_id}|${u.depth}`;
    expectUp.set(k, (expectUp.get(k) || 0) + Number(u.amountMicroUsd));
  }
  const gotUp = sql(`SELECT user_id AS s, downline_user_id AS d, depth_level AS depth, SUM(amount_micro_usd) AS a FROM daily_mlm_pending_ledger WHERE date_key = '${today}' AND source_type IN ('GAME_KILL','CHEST_OPEN') AND downline_user_id IN (${ids}) GROUP BY 1,2,3`);
  const gotMap = new Map(gotUp.map((r) => [`${r.s}|${r.d}|${r.depth}`, Number(r.a)]));
  let upBad = 0;
  for (const [k, v] of expectUp) if (gotMap.get(k) !== v) upBad++;
  for (const k of gotMap.keys()) if (!expectUp.has(k)) upBad++;
  check(SEC, '§7.3 upline commissions: L1 5 % / L2 4 % / L3 3 % / L4 2 % / L5 1 % to the right ancestor, none beyond L5', upBad === 0 && expectUp.size > 0, `${expectUp.size} (sponsor, downline, level) groups · ${upBad} wrong`);
  // locked sponsors (missions not done) → burned to the platform
  const lock = sql(`SELECT l.user_id AS s, l.status, SUM(l.amount_micro_usd) AS a FROM daily_mlm_pending_ledger l WHERE l.date_key = '${today}' AND l.user_id IN (${ids}) GROUP BY 1,2`);
  const unlockedSet = new Set(sql(`SELECT q.user_id FROM user_daily_quests q JOIN daily_quest_definitions d ON d.quest_id = q.quest_id AND d.is_active = 1 WHERE q.date_key = '${today}' AND q.is_completed = 1 GROUP BY q.user_id HAVING COUNT(*) >= ${S.DAILY_QUESTS_REQUIRED_TO_UNLOCK}`).map((r) => r.user_id));
  const wrongGate = lock.filter((r) => (r.status === 'settled_paid') !== unlockedSet.has(r.s));
  check(SEC, '§7.3 daily 4/5 mission gate: only unlocked sponsors are paid, locked ones are burned to the platform', wrongGate.length === 0, `${unlockedSet.size} unlocked sponsors · ${wrongGate.length} wrong`);
}

// ---- 8. economics per player / country ----------------------------------------------------------------
const wallets = sql(`SELECT u.id, w.balance_micro_usd AS bal, w.bounty_micro_usd AS bty, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = u.id AND action_type='MLM_COMMISSION') AS mlm, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = u.id AND action_type='CHEER_REWARD') AS cheer, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = u.id AND action_type IN ('GAME_KILL','CHEST_OPEN','BOUNTY_CLAIM','FAST_MINI_KILL','BOSS_BOUNTY_CLAIM')) AS game FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.id IN (${ids})`);
for (const w of wallets) Object.assign(byId.get(w.id).stats, { balance: Number(w.bal), bounty: Number(w.bty), mlm: Number(w.mlm), cheerIncome: Number(w.cheer), gameIncome: Number(w.game) });
const tAvg = sql(`SELECT country_code AS cc, COUNT(*) AS n, AVG(backed_micro_usd) AS avg, MIN(backed_micro_usd) AS mn, MAX(backed_micro_usd) AS mx FROM user_energy_tickets WHERE user_id IN (${ids}) AND source_type IN ('ad_charge','cheer_pool') GROUP BY 1 ORDER BY avg DESC`);
const econ = {
  players: players.map((p) => ({ idx: p.idx, country: p.country, sponsorIdx: p.sponsor ? byId.get(p.sponsor).idx : null, quester: p.quester, mode: modeOf(p.idx), ...p.stats })),
  ticketsByCountry: tAvg,
  inflow,
  money0,
  money1,
  mlm: { before: mlmBefore, after: mlmAfter, credited: mlmCredited, paidNow, burnedNow },
  game,
  cheer,
};
const top = [...econ.players].sort((a, b) => b.balance - a.balance);
note(SEC, `wallets after one day: top ${fmtC(top[0].balance)} (${fmtUsd(top[0].balance)}) · median ${fmtC(top[Math.floor(N / 2)].balance)} · zero balance ${econ.players.filter((x) => !x.balance).length} players · platform +${fmtUsd(money1.platform - money0.platform)} · pool unspent ${fmtUsd(money1.poolUnspent)}`);

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(STATE_DIR, 'sim-economics.json'), JSON.stringify(econ, null, 2));
export const simResults = results;
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.filter((r) => r.ok && !r.note).length} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
