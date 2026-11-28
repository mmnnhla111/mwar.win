/**
 * 04-abuse-probes.mjs — LOCAL-ONLY probes of the "does the system lose real money?" weak points.
 * Each probe shows whether a scripted client (no real ad, no real aim) can still create paid value.
 * Needs the same local api-worker + game server as 02 (run-local-audit.mjs --probes).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SECRETS, GAME_WS, call, check, note, results, signup, sql1, sleep, colyseus, decodeToken } from './lib.mjs';

const SEC = 'abuse';
const RUN = Date.now().toString(36);
const S = await import(pathToFileURL(path.join(ROOT, 'packages/shared/dist/index.mjs')).href);
console.log('\n── 04 abuse probes ──');
const heartbeat = () => call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${SECRETS.INTERNAL_API_SECRET}` }, body: { nodeId: `audit-probe-${RUN}`, role: 'game' } });
await heartbeat();

// 1. Banner impression with a forged "last input" time and no banner ever rendered ----------------
const bot = await signup(`au${RUN}bot`);
const b1 = await call('/api/ads/impression', { method: 'POST', token: bot.token, body: { slot: 'adsterra_320x50', count: 1, lastActiveAt: Date.now(), clientNow: Date.now() } });
check(SEC, 'a script that never loads the Adsterra iframe still gets a banner credited (lastActiveAt is client-supplied)', b1.status !== 200, `HTTP ${b1.status} · backing +${b1.body.backedMicroUsd ?? 0} µUSD · EC +${b1.body.ecProgressAddedPct ?? 0}%`);
note(SEC, `banner gate: 1 credited banner per ${S.AD_BANNER_MIN_GAP_SECONDS} s per account and NO daily banner cap → up to ${Math.floor(86400 / S.AD_BANNER_MIN_GAP_SECONDS)} banners / account / day`);

// 2. Direct-link visit claimed on the server timer without ever opening the link ---------------------
const dl = await call('/api/ads/direct-link/start', { method: 'POST', token: bot.token, body: { purpose: 'ec_recharge', seconds: 15 } });
await sleep(15_500);
const dc = dl.status === 200 ? await call('/api/ads/direct-link/claim', { method: 'POST', token: bot.token, body: { token: dl.body.token } }) : { status: dl.status, body: dl.body };
check(SEC, 'a direct-link visit is credited only after the network confirms it (S2S postback), not on a 15 s timer', dc.status !== 200, `start ${dl.status} · claim HTTP ${dc.status} · real-revenue backing credited ${dc.body.valueMicroUsd ?? 0} µUSD with no postback`);

// 3. Hit claimed from across the map (no range / wall line-of-sight check on the server) ----------
const { Client } = colyseus();
const A = await signup(`au${RUN}aim`);
const V = await signup(`au${RUN}vic`);
// give both a small backed ticket through the real postback path (TH)
for (const u of [A, V])
  for (let i = 0; i < 5; i++)
    await call(`/api/ads/postback/monetag?${new URLSearchParams({ secret: SECRETS.AD_POSTBACK_SECRET, ymid: u.id, geo: 'US', click_id: `au_${RUN}_${u.username}_${i}` })}`);
const enter = async (u) => call('/api/game/enter', { method: 'POST', token: u.token, body: { mode: 'standard_100' } });
// burn the 0-backed starter ticket first so the kill below has real value
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
  // life 1 (0-backed starter) → killed from wherever we stand; then V re-stakes a backed ticket
  await shootUntilDead();
  await sleep(1200);
  const rs = await call('/api/game/enter', { method: 'POST', token: V.token, body: { mode: 'standard_100', restakeAfter: ev0.body.entryId } });
  const tv = rs.body.entryToken ? decodeToken(rs.body.entryToken).tv : 0;
  if (rs.status === 200) rv.send('player_restake', { entryToken: rs.body.entryToken });
  await sleep(1500);
  const w0 = Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${A.id}'`).b || 0);
  const killed = await shootUntilDead();
  await sleep(12_000); // 10 s payout batch
  const w1 = Number(sql1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${A.id}'`).b || 0);
  check(
    SEC,
    'server rejects hits claimed from beyond weapon range / through walls (spec §5.1 server authoritative)',
    !(killed && w1 > w0),
    `victim killed from ${distance?.toFixed(1)} m on the 960 m map without aiming · ticket ${tv} µUSD · shooter paid +${w1 - w0} µUSD (sniper range in code: 200 m, not enforced)`
  );
  await ra.leave(true).catch(() => {});
  await rv.leave(true).catch(() => {});
}

// 4. Headshot ratio is self-reported --------------------------------------------------------------
note(SEC, `Layer-2 headshot flag uses the client's own "headshot" boolean (> ${S.HEADSHOT_RATIO_FLAG * 100} % after ${S.HEADSHOT_MIN_SAMPLE_HITS} hits): an aimbot that reports headshot:false is never flagged`);

export const abuseResults = results;
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.filter((r) => r.ok && !r.note).length} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
