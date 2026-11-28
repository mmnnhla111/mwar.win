#!/usr/bin/env node
/**
 * rejoin-persistence-e2e.mjs — V1.1 Round 3 end-to-end test against a LOCAL api-worker (wrangler dev) and a
 * local Colyseus game server that this script starts (real Worker settlement, real D1).
 *
 *   node scripts/load-test/rejoin-persistence-e2e.mjs --api=http://127.0.0.1:8797 [--web-out=apps/web/out] [--screens=dir]
 *
 *  1. Paid-EC entry (TH-02 Skirmish, ticket with real backing + head bounty) → prop disguise → socket loss
 *  2. The body stays in the arena, still the same prop; GET /api/game/active-session reports it
 *     { roomId, mode, mapName, serverUrl, hp, isPropHidden, isDisconnected, enteredAt }
 *  3. A second entry is refused (409 ACTIVE_SESSION, no second ticket locked)
 *  4. Rejoin (?rejoin=1 signed token) re-attaches to the same body: no new EC, no duplicate entity;
 *     a second concurrent connection takes the body over (still one body)
 *  5. Browser (static export + Playwright): the floating ActiveMatchPopup on non-game pages (desktop 1280 +
 *     mobile 390 screenshots), ✕ only hides it for this tab (character untouched), Rejoin link → /game?rejoin=
 *  6. Another player finds and kills the disconnected prop body → the killer gets the victim's ticket value
 *     (55 % share) + the whole head bounty exactly once (D1: ticket settled once, ledger = balance), the
 *     session is cleared at that moment
 *  7. Room-shutdown rule: SIGTERM the game server with an alive disconnected body → its ticket is RETURNED to
 *     available (never paid, never forfeited) and its session ends
 *
 * Needs apps/api-worker/.dev.vars with INTERNAL_API_SECRET=test-internal + TELEGRAM_BOT_TOKEN=123456789:TESTtokenABC
 * and `npx wrangler d1 migrations apply core_db --local`. Never point it at production.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const webRequire = createRequire(path.join(ROOT, 'apps/web/package.json'));
const { Client } = webRequire('colyseus.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const API = String(args.api || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SECRET = String(args['internal-secret'] || 'test-internal');
const TG = String(args['tg-bot-token'] || '123456789:TESTtokenABC');
const WORKER_DIR = path.resolve(ROOT, String(args['worker-dir'] || 'apps/api-worker'));
const WEB_OUT = path.resolve(ROOT, String(args['web-out'] || 'apps/web/out'));
const SCREENS = path.resolve(String(args.screens || '/tmp/claude-0/scratch/v11'));
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API)) {
  console.error('Refusing to run against a non-local API');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok: !!ok, info: String(info) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
};
const earnerShare = (v) => {
  const n = BigInt(v) * 5500n;
  return Number(n % 10000n >= 7000n ? n / 10000n + 1n : n / 10000n);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const call = async (pathname, { method = 'GET', token, body, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const once = () => fetch(API + pathname, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  // wrangler dev drops pooled keep-alive sockets after `wrangler d1 execute`; such a request never reached the Worker
  const r = await once().catch(async (e) => {
    if (e?.cause?.code !== 'UND_ERR_SOCKET') throw e;
    await sleep(500);
    return once();
  });
  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {}
  return { status: r.status, body: j };
};
// Async on purpose: a blocked event loop stops the test's Colyseus sockets from answering pings (→ dropped)
const execFileP = promisify(execFile);
const sqlQuery = async (q) => {
  const { stdout: out } = await execFileP('npx', ['wrangler', 'd1', 'execute', 'core_db', '--local', '--json', '--command', q], { cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 1 << 24 });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
};
// `wrangler d1 execute --json` prints SQL NULL as the string "null"
const q1 = async (sql) => Object.fromEntries(Object.entries((await sqlQuery(sql))[0] || {}).map(([k, v]) => [k, v === 'null' ? null : v]));
const sqlFile = async (statements) => {
  const f = path.join(os.tmpdir(), `mwar-r3-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(f, statements.join('\n'));
  try {
    await execFileP('npx', ['wrangler', 'd1', 'execute', 'core_db', '--local', '--file', f], { cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 1 << 24 });
  } finally {
    fs.rmSync(f, { force: true });
  }
};
const run = Date.now().toString(36);
let tgSeq = Math.floor(Math.random() * 1e8) + 6e9;
const signup = async (label) => {
  const d = { id: tgSeq++, first_name: 'R3', username: `r3${run}${label}`.slice(0, 32), auth_date: Math.floor(Date.now() / 1000) };
  const s = Object.keys(d).sort().map((k) => `${k}=${d[k]}`).join('\n');
  const key = crypto.createHash('sha256').update(TG).digest();
  const r = await call('/api/auth/oauth/telegram', { method: 'POST', body: { ...d, hash: crypto.createHmac('sha256', key).update(s).digest('hex') } });
  if (!r.body?.token) throw new Error(`signup ${label} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { label, id: r.body.user.id, token: r.body.token, username: r.body.user.username };
};
const decode = (tok) => JSON.parse(Buffer.from(String(tok).split('.')[0], 'base64url').toString('utf8'));
const waitFor = async (fn, ms, every = 300) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
};

const children = [];
process.on('exit', () => children.forEach((c) => c.exitCode === null && c.kill('SIGKILL')));

async function startGameServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/game-server'),
    env: { ...process.env, GAME_PORT: String(port), PORT: String(port), WORKER_API_URL: API, API_BASE_URL: API, INTERNAL_API_SECRET: SECRET, REDIS_URL: 'disabled', GAME_PUBLIC_URL: `ws://127.0.0.1:${port}`, NODE_ENV: 'loadtest', MWAR_LOADTEST_TRUST_CLIENT_HITS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const log = [];
  child.stdout.on('data', (c) => log.push(String(c)));
  child.stderr.on('data', (c) => log.push(String(c)));
  const ok = await waitFor(async () => {
    const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    return h && (h.registryRooms || []).includes('TH-02') ? h : null;
  }, 40_000, 500);
  return { port, url: `ws://127.0.0.1:${port}`, child, log, ok: !!ok };
}

async function main() {
  console.log(`── V1.1 R3 e2e: worker ${API} ──`);
  const gs = await startGameServer();
  check('game server started with the worker registry (TH-02)', gs.ok, gs.url);
  if (!gs.ok) return console.log(gs.log.join('').slice(-2000));
  const hb = () => call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: { nodeId: `r3-e2e-${process.pid}`, role: 'game' } });
  await hb();
  const hbTimer = setInterval(() => hb().catch(() => {}), 20_000);

  const V = await signup('vic');
  const K = await signup('kil');
  const W = await signup('wsd');
  const now = Math.floor(Date.now() / 1000);
  const tV = `tkt_r3e2e_v_${run}`;
  const tW = `tkt_r3e2e_w_${run}`;
  const VAL = 13800;
  const BTY = 4321;
  // Oldest available ticket (FIFO) with real backing for V and W; V carries a head bounty
  await sqlFile([
    `INSERT INTO user_energy_tickets (id, user_id, source_type, country_code, backed_micro_usd, status, created_at) VALUES ('${tV}', '${V.id}', 'admin_grant', 'TH', ${VAL}, 'available', 1);`,
    `INSERT INTO user_energy_tickets (id, user_id, source_type, country_code, backed_micro_usd, status, created_at) VALUES ('${tW}', '${W.id}', 'admin_grant', 'TH', 7820, 'available', 1);`,
    `UPDATE users SET energy_tickets = (SELECT COUNT(*) FROM user_energy_tickets t WHERE t.user_id = users.id AND t.status = 'available') WHERE id IN ('${V.id}', '${W.id}');`,
    `UPDATE wallets SET bounty_micro_usd = ${BTY}, updated_at = ${now} WHERE user_id = '${V.id}';`,
  ]);
  const ec = (u) => q1(`SELECT energy_tickets AS n, (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = '${u.id}' AND status = 'in_match') AS live FROM users WHERE id = '${u.id}'`);

  // ---- 1. enter, prop, disconnect -------------------------------------------------------------------
  const eV = await call('/api/game/enter', { method: 'POST', token: V.token, body: { roomCode: 'TH-02' } });
  const eK = await call('/api/game/enter', { method: 'POST', token: K.token, body: { roomCode: 'TH-02' } });
  const tokV = eV.body.entryToken ? decode(eV.body.entryToken) : {};
  check('Paid-EC entry locks V\'s backed ticket (token tid/tv) and K\'s ticket', eV.status === 200 && tokV.tid === tV && tokV.tv === VAL && eK.status === 200, `V ${eV.status} tv ${tokV.tv} · K ${eK.status}`);
  const ecAfterEnter = await ec(V);
  const cl = (ip) => new Client(gs.url, { headers: { 'x-forwarded-for': ip } });
  const k = await cl('203.0.113.20').joinOrCreate('arena', { roomCode: 'TH-02', entryToken: eK.body.entryToken, deviceId: 'r3-dev-k' });
  const kills = [];
  k.onMessage('*', (type, msg) => type === 'player_killed' && kills.push(msg));
  const v1 = await cl('203.0.113.21').joinOrCreate('arena', { roomCode: 'TH-02', entryToken: eV.body.entryToken, deviceId: 'r3-dev-v' });
  v1.onMessage('*', () => {});
  check('both players in the same TH-02 room', v1.roomId === k.roomId, v1.roomId);
  await sleep(600);
  const bodies = (uid) => {
    const out = [];
    k.state.players.forEach((p, sid) => p.id === uid && out.push({ sid, p }));
    return out;
  };
  const vp = bodies(V.id)[0].p;
  v1.send('player_move', { x: vp.x + 0.5, y: vp.y, z: vp.z - 0.5, rotationY: 0.8, stance: 'stand' });
  await sleep(200);
  v1.send('player_set_prop', { isProp: true, propType: 'oil_drum' });
  await sleep(400);
  const spot = { x: bodies(V.id)[0].p.x, z: bodies(V.id)[0].p.z };
  v1.leave(false); // socket loss
  await sleep(800);
  const b = bodies(V.id);
  check('disconnected alive body stays in the arena, still the oil-drum prop at the same spot', b.length === 1 && b[0].p.isProp && b[0].p.propType === 'oil_drum' && b[0].p.x === spot.x && b[0].p.z === spot.z && b[0].p.health === 100 && b[0].p.ticketMicroUsd === VAL && b[0].p.bountyMicroUsd === BTY, JSON.stringify({ n: b.length, prop: b[0]?.p.propType, x: b[0]?.p.x, z: b[0]?.p.z }));

  // ---- 2. active session ------------------------------------------------------------------------------
  const sess = await waitFor(async () => {
    const r = await call('/api/game/active-session', { token: V.token });
    return r.body?.session?.isDisconnected && r.body.session.isPropHidden ? r.body.session : null;
  }, 30_000, 700);
  check(
    'GET /api/game/active-session → { roomId, mode, mapName, serverUrl, hp, isPropHidden, enteredAt } of the body',
    !!sess && sess.roomId === k.roomId && sess.mode === 'mini_30' && sess.mapName === 'small' && sess.serverUrl === gs.url && sess.hp === 100 && sess.isPropHidden && sess.propType === 'oil_drum' && sess.enteredAt > 0 && sess.roomCode === 'TH-02',
    JSON.stringify(sess)
  );
  const vTicket0 = await q1(`SELECT status FROM user_energy_tickets WHERE id = '${tV}'`);
  check('nothing settled on disconnect: V\'s ticket still in_match', vTicket0.status === 'in_match', vTicket0.status);
  const noSess = await call('/api/game/active-session', { token: K.token });
  check('other accounts do not see the session (K: K\'s own connected session only)', noSess.body?.session?.entryId !== sess?.entryId);

  // ---- 3. second entry refused --------------------------------------------------------------------------
  const e2 = await call('/api/game/enter', { method: 'POST', token: V.token, body: { roomCode: 'TH-02' } });
  const ec2 = await ec(V);
  check('a second entry while the body lives → 409 ACTIVE_SESSION, no second ticket locked', e2.status === 409 && e2.body.code === 'ACTIVE_SESSION' && e2.body.session?.roomId === k.roomId && Number(ec2.live) === 1 && Number(ec2.n) === Number(ecAfterEnter.n), `${e2.status} ${e2.body.code} · in_match ${ec2.live} · EC ${ecAfterEnter.n}→${ec2.n}`);

  // ---- 4. rejoin --------------------------------------------------------------------------------------
  const rj = await call('/api/game/active-session?rejoin=1', { token: V.token });
  const claims = rj.body.rejoinToken ? decode(rj.body.rejoinToken) : {};
  check('?rejoin=1 returns a signed token bound to user + entry + room (rj, 120 s)', claims.uid === V.id && claims.eid === sess?.entryId && claims.rid === k.roomId && claims.rj === 1 && claims.exp - Math.floor(Date.now() / 1000) <= 120, JSON.stringify(claims));
  let refused = false;
  try {
    await cl('203.0.113.29').joinById(k.roomId, { rejoinToken: rj.body.rejoinToken.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) });
  } catch {
    refused = true;
  }
  check('a tampered rejoin token is refused', refused);
  const countBefore = k.state.players.size;
  const r1 = await cl('203.0.113.22').joinById(k.roomId, { rejoinToken: rj.body.rejoinToken, deviceId: 'r3-dev-v' });
  const r1Box = [];
  r1.onMessage('*', (type, msg) => r1Box.push({ type, msg }));
  const rejoined = await waitFor(() => r1Box.find((m) => m.type === 'rejoined')?.msg, 4000, 50);
  await sleep(400);
  const ec3 = await ec(V);
  check('Rejoin re-attaches the same body (spot, prop, HP, ticket) with NO new EC and no duplicate entity', !!rejoined && rejoined.isProp && rejoined.propType === 'oil_drum' && rejoined.x === spot.x && rejoined.z === spot.z && rejoined.ticketMicroUsd === VAL && bodies(V.id).length === 1 && k.state.players.size === countBefore && Number(ec3.n) === Number(ecAfterEnter.n) && Number(ec3.live) === 1, `EC ${ecAfterEnter.n}→${ec3.n} · in_match ${ec3.live} · bodies ${bodies(V.id).length} · players ${k.state.players.size}/${countBefore}`);
  const rj2 = await call('/api/game/active-session?rejoin=1', { token: V.token });
  let r1Closed = false;
  r1.onLeave(() => (r1Closed = true));
  const r2 = await cl('203.0.113.23').joinById(k.roomId, { rejoinToken: rj2.body.rejoinToken, deviceId: 'r3-dev-v' });
  r2.onMessage('*', () => {});
  await sleep(800);
  check('a second concurrent connection takes the body over — still exactly one body', bodies(V.id).length === 1 && bodies(V.id)[0].sid === r2.sessionId && r1Closed && k.state.players.size === countBefore, `bodies ${bodies(V.id).length} · sid ${bodies(V.id)[0]?.sid === r2.sessionId} · r1 closed ${r1Closed} · players ${k.state.players.size}/${countBefore}`);
  await r2.leave(true); // navigation away (consented) while alive
  await sleep(600);
  check('consented leave while alive → body stays (prop kept)', bodies(V.id).length === 1 && bodies(V.id)[0].p.isProp);
  await waitFor(async () => (await call('/api/game/active-session', { token: V.token })).body?.session?.isDisconnected, 20_000, 700);

  // ---- 5. browser: floating popup ---------------------------------------------------------------------
  await browserPart(V, sess, k, bodies);

  // ---- 6. the body is found and killed -------------------------------------------------------------
  const kBal0 = await q1(`SELECT balance_micro_usd AS b FROM wallets WHERE user_id = '${K.id}'`);
  const target = bodies(V.id)[0];
  let kp = bodies(K.id)[0].p;
  for (let i = 0; i < 260; i++) {
    const dx = target.p.x + 2 - kp.x;
    const dz = target.p.z - kp.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) break;
    const step = Math.min(1.4, d);
    k.send('player_move', { x: kp.x + (dx / d) * step, y: target.p.y, z: kp.z + (dz / d) * step, rotationY: 0, stance: 'stand' });
    await sleep(110);
    kp = bodies(K.id)[0].p;
  }
  for (let i = 0; i < 4 && bodies(V.id).length && !bodies(V.id)[0].p.isGhost; i++) {
    k.send('player_shoot', { targetType: 'player', targetId: bodies(V.id)[0].sid, damage: 68, headshot: true });
    await sleep(220);
  }
  const kk = await waitFor(() => kills.find((m) => m.victimId === V.id), 3000, 100);
  check('K kills the disconnected prop body (live-kill message: V + bounty)', !!kk && Number(kk.ticketMicroUsd) === VAL && Number(kk.bountyClaimedMicroUsd) === BTY && Number(kk.rewardMicroUsd) === earnerShare(VAL) + BTY, JSON.stringify(kk || {}).slice(0, 220));
  const settled = await waitFor(async () => {
    const t = await q1(`SELECT status, settle_action AS a, settled_to_user_id AS to_id, settled_micro_usd AS paid FROM user_energy_tickets WHERE id = '${tV}'`);
    return t.status === 'settled' ? t : null;
  }, 30_000, 1500);
  await sleep(1500);
  const kw = await q1(`SELECT w.balance_micro_usd AS bal, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = w.user_id) AS ledger,
                        (SELECT COUNT(*) FROM wallet_ledger l WHERE l.user_id = w.user_id AND l.action_type = 'GAME_KILL') AS kills,
                        (SELECT COUNT(*) FROM wallet_ledger l WHERE l.user_id = w.user_id AND l.action_type = 'BOUNTY_CLAIM') AS bounties
                   FROM wallets w WHERE w.user_id = '${K.id}'`);
  const vw = await q1(`SELECT bounty_micro_usd AS bty FROM wallets WHERE user_id = '${V.id}'`);
  const gain = Number(kw.bal) - Number(kBal0.b || 0);
  check('D1: V\'s ticket settled ONCE by GAME_KILL to K for exactly its backed value', settled?.a === 'GAME_KILL' && settled?.to_id === K.id && Number(settled?.paid) === VAL, JSON.stringify(settled));
  check('D1: K credited exactly 55 % of V + the whole bounty, once (1 GAME_KILL + 1 BOUNTY_CLAIM ledger row), ledger = balance', gain === earnerShare(VAL) + BTY && Number(kw.kills) === 1 && Number(kw.bounties) === 1 && Number(kw.bal) === Number(kw.ledger) && Number(vw.bty) === 0, `+${gain} (expected ${earnerShare(VAL) + BTY}) · rows ${kw.kills}/${kw.bounties} · ledger ${kw.ledger} vs ${kw.bal} · V bounty ${vw.bty}`);
  const after = await waitFor(async () => ((await call('/api/game/active-session', { token: V.token })).body?.session === null ? true : null), 15_000, 700);
  check('the active session is cleared at the death', after === true);
  const sRow = await q1(`SELECT end_reason AS r FROM game_active_sessions WHERE entry_id = '${sess?.entryId}'`);
  check('session row ended with reason "died"', sRow.r === 'died', sRow.r);
  const e3 = await call('/api/game/enter', { method: 'POST', token: V.token, body: { roomCode: 'TH-02' } });
  check('after the death a new entry is possible again (no stale block; 402 = no EC left is fine)', e3.status === 200 || e3.status === 402, `${e3.status} ${e3.body.code || ''}`);

  // ---- 7. room-shutdown rule ----------------------------------------------------------------------------
  const eW = await call('/api/game/enter', { method: 'POST', token: W.token, body: { roomCode: 'TH-02' } });
  const w = await cl('203.0.113.24').joinOrCreate('arena', { roomCode: 'TH-02', entryToken: eW.body.entryToken, deviceId: 'r3-dev-w' });
  w.onMessage('*', () => {});
  await sleep(500);
  w.leave(false);
  await waitFor(async () => (await call('/api/game/active-session', { token: W.token })).body?.session?.isDisconnected, 25_000, 700);
  const wEc0 = await ec(W);
  gs.child.kill('SIGTERM');
  const exited = await waitFor(() => (gs.child.exitCode !== null || gs.child.signalCode ? true : null), 90_000, 500);
  check('game server shuts down gracefully on SIGTERM', !!exited, `exit ${gs.child.exitCode} ${gs.child.signalCode || ''}`);
  const wt = await q1(`SELECT status, match_id AS m, settle_action AS a FROM user_energy_tickets WHERE id = '${tW}'`);
  const wEc1 = await ec(W);
  const wSess = await call('/api/game/active-session', { token: W.token });
  check('room-shutdown rule: the alive body\'s ticket is RETURNED to available (not paid, not forfeited), EC back, session ended', wt.status === 'available' && !wt.m && !wt.a && Number(wEc1.n) === Number(wEc0.n) + 1 && wSess.body?.session === null, `ticket ${JSON.stringify(wt)} · EC ${wEc0.n}→${wEc1.n}`);
  const kt = await q1(`SELECT COUNT(*) AS n FROM user_energy_tickets WHERE user_id = '${K.id}' AND status = 'in_match'`);
  check('K (still alive at shutdown) also got the ticket back — no in_match ticket left', Number(kt.n) === 0, `${kt.n}`);
  const wlog = gs.log.join('');
  if (args['gs-log']) fs.writeFileSync(String(args['gs-log']), wlog);
  check('no unexpected errors in the game server log', !/Unhandled|TypeError|ReferenceError/.test(wlog), wlog.match(/.*(Unhandled|TypeError|ReferenceError).*/)?.[0] || '');
  clearInterval(hbTimer);
}

async function browserPart(V, sess, k, bodies) {
  if (!fs.existsSync(path.join(WEB_OUT, 'index.html'))) {
    check('browser part skipped (no static export at --web-out)', true, WEB_OUT);
    return;
  }
  let chromium;
  try {
    ({ chromium } = webRequire('playwright'));
  } catch {
    try {
      ({ chromium } = createRequire(import.meta.url)('playwright'));
    } catch {
      ({ chromium } = createRequire('/usr/lib/node_modules/')('playwright'));
    }
  }
  // Static export server: /profile → profile.html
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
  const srv = createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const cands = [u, `${u}.html`, path.join(u, 'index.html')].map((c) => path.join(WEB_OUT, c));
    const f = cands.find((c) => c.startsWith(WEB_OUT) && fs.existsSync(c) && fs.statSync(c).isFile());
    if (!f) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const web = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctxFor = async (opts) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('mwar_auth_token', t);
        localStorage.setItem('mwar_lang', 'th');
      } catch {}
    }, V.token);
    // The static build talks to http://127.0.0.1:8787 → forward to the worker under test
    await ctx.route(/^http:\/\/127\.0\.0\.1:8787\//, async (route) => {
      const url = route.request().url().replace('http://127.0.0.1:8787', API);
      try {
        const resp = await route.fetch({ url });
        await route.fulfill({ response: resp });
      } catch {
        await route.abort();
      }
    });
    return ctx;
  };
  try {
    fs.mkdirSync(SCREENS, { recursive: true });
    const desk = await ctxFor({ viewport: { width: 1280, height: 800 } });
    const pd = await desk.newPage();
    await pd.goto(`${web}/profile`, { waitUntil: 'domcontentloaded' });
    const card = pd.getByTestId('active-match-popup');
    const shown = await card.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    await pd.waitForTimeout(800);
    await pd.screenshot({ path: path.join(SCREENS, 'r3-popup-desktop.png') });
    const txt = shown ? await card.innerText() : '';
    const href = shown ? await pd.getByTestId('active-match-rejoin').getAttribute('href') : '';
    check('desktop 1280: floating popup on /profile with mode + prop badge + Rejoin', shown && /Skirmish 30P/.test(txt) && /แปลงร่าง/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 140));
    check('Rejoin link → /game?rejoin=<roomId>', typeof href === 'string' && href.startsWith(`/game?rejoin=${sess.roomId}`), href);
    await pd.goto(`${web}/wallet`, { waitUntil: 'domcontentloaded' });
    const onWallet = await pd.getByTestId('active-match-popup').waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
    check('popup follows across pages (/wallet)', onWallet);

    const mob = await ctxFor({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pm = await mob.newPage();
    await pm.goto(`${web}/`, { waitUntil: 'domcontentloaded' });
    const mShown = await pm.getByTestId('active-match-popup').waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    await pm.waitForTimeout(800);
    await pm.screenshot({ path: path.join(SCREENS, 'r3-popup-mobile.png') });
    check('mobile 390: floating popup on /', mShown);
    // ✕ only hides the card (sessionStorage) — the character stays exactly as it was
    await pm.getByTestId('active-match-dismiss').click();
    await pm.waitForTimeout(400);
    const goneNow = !(await pm.getByTestId('active-match-popup').isVisible().catch(() => false));
    const stored = await pm.evaluate(() => sessionStorage.getItem('mwar_rejoin_dismissed_v1'));
    await pm.reload({ waitUntil: 'domcontentloaded' });
    await pm.waitForTimeout(4000);
    const goneAfterReload = !(await pm.getByTestId('active-match-popup').isVisible().catch(() => false));
    await pm.screenshot({ path: path.join(SCREENS, 'r3-popup-mobile-dismissed.png') });
    const still = await call('/api/game/active-session', { token: V.token });
    const body = bodies(V.id)[0]?.p;
    check('✕ hides the popup for this tab only (sessionStorage, survives reload)', goneNow && goneAfterReload && stored === sess.entryId && !(await pm.evaluate(() => localStorage.getItem('mwar_rejoin_dismissed_v1'))), `stored ${stored}`);
    check('✕ never touches the character: body still alive, still the prop, session still active', !!body && !body.isGhost && body.isProp && body.health === 100 && still.body?.session?.entryId === sess.entryId);
    const fresh = await (await ctxFor({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
    await fresh.goto(`${web}/`, { waitUntil: 'domcontentloaded' });
    const again = await fresh.getByTestId('active-match-popup').waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    check('a new tab (new session) shows the popup again', again);
    await fresh.close();

    // Rejoin from the popup → /game resumes the same body (no new EC). Needs WebGL in headless Chromium.
    if (!args['skip-game-page']) {
      const ecRow0 = await q1(`SELECT energy_tickets AS n FROM users WHERE id = '${V.id}'`);
      await pd.goto(`${web}/profile`, { waitUntil: 'domcontentloaded' });
      await pd.getByTestId('active-match-rejoin').click();
      const banner = await pd.getByTestId('rejoin-resume-banner').waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false);
      await pd.waitForTimeout(1200);
      await pd.screenshot({ path: path.join(SCREENS, 'r3-game-resume-desktop.png') });
      const connected = await waitFor(async () => (await call('/api/game/active-session', { token: V.token })).body?.session?.isDisconnected === false, 20_000, 700);
      const ecRow1 = await q1(`SELECT energy_tickets AS n FROM users WHERE id = '${V.id}'`);
      check('popup Rejoin → /game re-attaches to the live body ("Resume" screen, session connected, EC unchanged, one body)', banner && !!connected && Number(ecRow1.n) === Number(ecRow0.n) && bodies(V.id).length === 1 && bodies(V.id)[0].p.isProp, `banner ${banner} · connected ${!!connected} · EC ${ecRow0.n}→${ecRow1.n}`);
      await pd.close(); // tab closed while alive → body again
      await waitFor(async () => (await call('/api/game/active-session', { token: V.token })).body?.session?.isDisconnected, 20_000, 700);
      check('closing the game tab while alive leaves the body in the arena again', bodies(V.id).length === 1 && !bodies(V.id)[0].p.isGhost);
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
}

main()
  .catch((e) => {
    console.error(e);
    check('e2e run completed without exceptions', false, String(e?.stack || e).slice(0, 400));
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
    for (const f of failed) console.log(`  FAIL ${f.name} ${f.info}`);
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    process.exit(failed.length ? 1 : 0);
  });
