#!/usr/bin/env node
/**
 * run-load-and-security-test.mjs — pre-launch load test + security audit for mwar.win
 *
 *   node scripts/load-test/run-load-and-security-test.mjs [options]
 *
 * PART A: game server stress test (apps/game-server, Colyseus)
 *   - Starts its own game server (tsx, with server-probe.cjs preloaded) and a mock Worker API that
 *     receives the 10-second batch payouts, or uses --game-url (then server-side metrics are off).
 *   - Combat validation room: fire-rate limit, damage clamp, self / ghost / unknown targets, forged,
 *     replayed, expired and wrong-room entry tokens, same-IP collusion kill → exact payout check.
 *     V1.1: entry tokens carry the victim's ticket (tid + backed value tv). A kill pays EXACTLY the
 *     victim's ticket value, killing a guest pays nothing, every ticket is closed exactly once
 *     (GAME_KILL / CHEST_OPEN / TICKET_FORFEIT) and the total paid never exceeds the total backing.
 *     V1.1 R2: no automatic respawn — a paid seat stays dead until it re-stakes with a NEW signed ticket
 *     ("Play again (-1 EC)" → player_restake: same HMAC + single-use eid, same account only, unusable
 *     tokens are returned), free seats press "Play again" (player_respawn, ≥ 3 s). Fast & Mini room: `fm`
 *     tokens, no tickets, kills queue FAST_MINI_KILL naming the VICTIM's pot (the Worker decides the
 *     amount), one FAST_MINI_CLOSE per pot, no head bounty.
 *     V1.1 R3 (persistent bodies): an alive staked player who leaves keeps a body in the arena (prop kept);
 *     the live session is reported to the Worker in the batch envelope; signed rejoin tokens (forged /
 *     other room / other account / expired / entry token refused) re-attach to the same body with no new
 *     ticket; a second connection takes over; killing the body pays exactly a live kill (ticket + bounty,
 *     once); alive bodies get their ticket RETURNED once when the room shuts down (body-only TTL 5 s here).
 *     Waves: bots leaving alive stay as bodies, nothing is forfeited on leave, tickets return at shutdown.
 *   - Wave 1: --players (default 1,000) bots across mini_30 / standard_100 / fast_mini rooms in
 *     worker threads. Every bot moves at 10 Hz and fires at 2 Hz (35 % hit). Checks 20 Hz tick + patch
 *     stability (server side), event-loop delay, client patch intervals, and that every paid kill /
 *     bounty claim the rooms announced reached the Worker exactly once (first batch of every game is
 *     answered 503 to prove re-queueing).
 *   - Leak check: full GC before wave 1, after wave 1 and after wave 2 (same load, shorter): every
 *     disposed room must be garbage collected and the heap must not keep growing.
 *
 * PART B: API security checks against a running api-worker (wrangler dev), --api URL
 *   - RBAC: user / moderator / support / finance_auditor / admin get 403 on super_admin endpoints.
 *   - Races: 10 parallel cashouts on one wallet, 6 buyers on one listing, 1 buyer on 2 listings →
 *     no negative balance, no double spend, ledger still equals balance.
 *   - OAuth: LINE state single use (sequential + parallel replay), stale / tampered Telegram login,
 *     unknown bot-exchange token.
 *   - Monetag S2S postback: missing / wrong secret → 403, right secret → 200, duplicate ignored.
 *   - Layer-2 media gate: photo > 300 KB and an unreadable MP4 → 422 MEDIA_GATE.
 *   - V1.1 ticket economy: 0-backed signup ticket, FIFO entry lock + token value, pool-backed mint,
 *     GAME_KILL capped at the victim's ticket, re-sent / parallel batches never pay twice, wrong-owner
 *     ticket rejected, forfeit → platform, self-cheer → 400, Energy Pool never overdrawn.
 *   Account setup (staff roles, balances, listings) needs direct D1 access, so PART B runs only
 *   against a LOCAL worker (wrangler dev, `--d1-local`, the default for 127.0.0.1 / localhost).
 *   Never point it at production: it creates test accounts and moves test balances.
 *
 * Options
 *   --players=1000 --duration=60 --wave2-duration=20 --workers=3
 *   --hit-rate=0.35                share of the 2 Hz shots that hit (1 = every shot hits: ~4× the kills)
 *   --skip-game | --skip-security
 *   --game-url=ws://host:port      use a running game server (no probe, no leak check)
 *   --api=http://127.0.0.1:8787    api-worker under test (PART B)
 *   --worker-dir=apps/api-worker   where `wrangler d1 execute core_db --local` runs
 *   --persist-to=dir               isolated wrangler D1 state dir (default: OS temp dir)
 *   --tg-bot-token=…  --postback-secret=…  --internal-secret=…   must match the worker's .dev.vars (local test values)
 *   --report=path.json             write the full JSON report (default: OS temp dir)
 *   --server-cpu-prof=dir          also write a V8 CPU profile of the game server (.cpuprofile)
 *
 * Exit code 0 = every check passed, 1 = at least one FAIL.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
// colyseus.js lives in the web app's dependencies
const webRequire = createRequire(path.join(ROOT, 'apps/web/package.json'));
const { Client } = webRequire('colyseus.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

// ------------------------------------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------------------------------------
/**
 * Same format as the API worker's /api/game/enter token (verified by verifyEntryToken).
 * V1.1: `tid` = the locked user_energy_tickets row, `tv` = its real backed µUSD (what a kill pays).
 */
function mintEntryToken(secret, { uid, un, eid = uuid(), bty = 0, rc = '', tid = `tkt_${uuid()}`, tv = 0, exp = Math.floor(Date.now() / 1000) + 3600, fm = 0, rs = 0 }) {
  const claims = fm ? { uid, un, eid, bty: 0, rc, fm: 1, exp } : { uid, un, eid, bty, rc, tid, tv, tn: 1, exp, ...(rs ? { rs: 1 } : {}) };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Realistic ticket values (µUSD): 0 = signup promo, 1 / 7 / 33 = odd dust, the rest = 30 s videos /
 * banner charges after the 0.92 haircut in different countries (BD 1 840, TH 7 820, US 29 440, …).
 */
const TICKET_VALUES = [0, 1, 7, 33, 230, 1840, 2760, 3496, 7820, 13800, 22080, 29440];
/** 0.007 C rule (fraction >= 0.7 µUSD rounds up) for the 55 % shooter share the HUD shows. */
const earnerShare = (v) => {
  const n = BigInt(v) * 5500n;
  return Number(n % 10000n >= 7000n ? n / 10000n + 1n : n / 10000n);
};

function newHist() {
  return { b: new Array(1001).fill(0), n: 0, sum: 0, max: 0 };
}
function histAdd(h, v) {
  h.b[Math.min(1000, Math.max(0, Math.round(v)))]++;
  h.n++;
  h.sum += v;
  if (v > h.max) h.max = v;
}
function histMerge(into, h) {
  for (let i = 0; i < into.b.length; i++) into.b[i] += h.b[i];
  into.n += h.n;
  into.sum += h.sum;
  into.max = Math.max(into.max, h.max);
}
function histSummary(h) {
  const p = (q) => {
    if (!h.n) return 0;
    const target = Math.ceil(h.n * q);
    let acc = 0;
    for (let i = 0; i < h.b.length; i++) if ((acc += h.b[i]) >= target) return i;
    return 1000;
  };
  return { n: h.n, mean: h.n ? +(h.sum / h.n).toFixed(2) : 0, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: +h.max.toFixed(1) };
}

// ------------------------------------------------------------------------------------------------
// Worker thread: a slice of the bot players
// ------------------------------------------------------------------------------------------------
if (!isMainThread) {
  const { url, bots, rampMs, hitRate, secret } = workerData;
  /** V1.1 R2: tickets minted for "Play again (-1 EC)" re-stakes (each must be closed exactly once) */
  const restakes = [];
  let freeRespawns = 0;
  let autoRespawnSeen = 0;
  const sessions = [];
  const patchHist = newHist();
  const stats = { joinOk: 0, joinFail: 0, joinErrors: [], unexpectedLeaves: 0, msgsSent: 0, positionRejected: 0, afkKicked: 0 };
  /** roomId → tally, kept by one observer bot per room in this thread */
  const roomTally = new Map();
  const observers = new Map();
  let combat = false;
  let measuring = false;
  let leaving = false;

  async function startBot(bot) {
    const client = new Client(url, { headers: { 'x-forwarded-for': bot.ip } });
    let room;
    try {
      room = await client.joinOrCreate(bot.mode, { entryToken: bot.token, deviceId: bot.deviceId, username: bot.un });
    } catch (e) {
      stats.joinFail++;
      if (stats.joinErrors.length < 5) stats.joinErrors.push(String(e?.message || e));
      return;
    }
    stats.joinOk++;
    if (!observers.has(room.roomId)) {
      observers.set(room.roomId, room.sessionId);
      roomTally.set(room.roomId, { mode: bot.mode, killEvents: 0, paidKills: 0, bountyClaims: 0, bountyMicroUsd: 0 });
    }
    const isObserver = observers.get(room.roomId) === room.sessionId;
    let lastPatch = 0;
    room.onStateChange(() => {
      const t = performance.now();
      if (lastPatch && measuring) histAdd(patchHist, t - lastPatch);
      lastPatch = t;
    });
    room.onMessage('*', (type, msg) => {
      if (type === 'player_eliminated') {
        // V1.1 R2: nobody is respawned by the server — the bot chooses like a player on the death screen
        const diedAt = Date.now();
        const life = { chose: false };
        // Alive again 3.4 s after the death without having chosen "Play again" = an automatic respawn (must never happen)
        setTimeout(() => {
          const me = room.state?.players?.get(room.sessionId);
          if (me && !me.isGhost && !life.chose) autoRespawnSeen++;
        }, 3400);
        if (msg?.respawnMode === 'restake') {
          setTimeout(() => {
            if (leaving || !room.connection?.isOpen) return;
            const tid = `tkt_${uuid()}`;
            const tv = TICKET_VALUES[(Math.random() * TICKET_VALUES.length) | 0];
            const eid = uuid();
            life.chose = true;
            restakes.push({ uid: bot.uid, tid, tv, eid });
            room.send('player_restake', { entryToken: mintEntryToken(secret, { uid: bot.uid, un: bot.un, eid, tid, tv, rs: 1 }) });
          }, 400 + Math.random() * 600);
        } else {
          setTimeout(() => {
            if (leaving || !room.connection?.isOpen) return;
            life.chose = true;
            freeRespawns++;
            room.send('player_respawn', {});
          }, Math.max(0, 3100 - (Date.now() - diedAt)));
        }
      }
      if (type === 'position_rejected') stats.positionRejected++;
      else if (type === 'afk_kicked') stats.afkKicked++;
      else if (type === 'player_killed' && isObserver) {
        const t = roomTally.get(room.roomId);
        t.killEvents++;
        // V1.1: a paid kill is one that settles the victim's ticket (ticketMicroUsd = V > 0)
        if (Number(msg.ticketMicroUsd || 0) > 0) t.paidKills++;
        if (Number(msg.bountyClaimedMicroUsd || 0) > 0) {
          t.bountyClaims++;
          t.bountyMicroUsd += Number(msg.bountyClaimedMicroUsd);
        }
      }
    });
    room.onLeave(() => {
      if (!leaving) stats.unexpectedLeaves++;
    });
    let tick = 0;
    const timer = setInterval(() => {
      if (!combat || !room.connection?.isOpen) return;
      const players = room.state?.players;
      const me = players?.get(room.sessionId);
      if (!me || me.isGhost) return;
      tick++;
      // 10 Hz movement, ≤ 0.8 m per step (server allows 20 m/s)
      const x = me.x + (Math.random() - 0.5) * 1.6;
      const z = me.z + (Math.random() - 0.5) * 1.6;
      room.send('player_move', { x, y: me.y, z, rotationY: Math.random() * 6.28, stance: 'stand' });
      stats.msgsSent++;
      // 2 Hz fire at a random live enemy (20 % head shots, well under the 85 % Layer-2 flag)
      if (tick % 5 === 0) {
        const targets = [];
        players.forEach((p, sid) => {
          if (sid !== room.sessionId && !p.isGhost && !p.isSpectator) targets.push(sid);
        });
        if (targets.length) {
          room.send('player_fired', {});
          stats.msgsSent++;
          // Most shots miss in a real fight: only hitRate of them reach the server as hits
          if (Math.random() >= hitRate) return;
          room.send('player_shoot', { targetType: 'player', targetId: targets[(Math.random() * targets.length) | 0], damage: 34, headshot: Math.random() < 0.2 });
          stats.msgsSent++;
        }
      }
    }, 100);
    sessions.push({ room, timer });
  }

  parentPort.on('message', async (cmd) => {
    if (cmd === 'combat') combat = measuring = true;
    else if (cmd === 'stop') combat = measuring = false;
    else if (cmd === 'report') {
      parentPort.postMessage({ type: 'report', stats: { ...stats, freeRespawns, autoRespawnSeen }, patchHist, rooms: Object.fromEntries(roomTally), restakes });
    } else if (cmd === 'leave') {
      leaving = true;
      for (const s of sessions) clearInterval(s.timer);
      await Promise.allSettled(sessions.map((s) => s.room.leave(true)));
      await sleep(300);
      parentPort.postMessage({ type: 'left' });
      process.exit(0);
    }
  });

  // Ramp: spread the joins over rampMs
  const gap = bots.length ? rampMs / bots.length : 0;
  const pending = [];
  for (const bot of bots) {
    pending.push(startBot(bot));
    await sleep(gap);
  }
  await Promise.allSettled(pending);
  parentPort.postMessage({ type: 'joined', joinOk: stats.joinOk, joinFail: stats.joinFail });
}

// ------------------------------------------------------------------------------------------------
// Main thread
// ------------------------------------------------------------------------------------------------
if (isMainThread) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );
  const OPT = {
    players: Number(args.players ?? 1000),
    duration: Number(args.duration ?? 60),
    wave2: Number(args['wave2-duration'] ?? 20),
    hitRate: Math.min(1, Math.max(0, Number(args['hit-rate'] ?? 0.35))),
    workers: Math.max(1, Number(args.workers ?? Math.max(1, Math.min(4, os.cpus().length - 1)))),
    skipGame: !!args['skip-game'],
    skipSecurity: !!args['skip-security'],
    gameUrl: args['game-url'] || null,
    api: String(args.api || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    workerDir: path.resolve(ROOT, String(args['worker-dir'] || 'apps/api-worker')),
    persistTo: args['persist-to'] ? path.resolve(String(args['persist-to'])) : path.join(os.tmpdir(), 'mwar-loadtest-wrangler-state'),
    tgBotToken: String(args['tg-bot-token'] || process.env.TELEGRAM_BOT_TOKEN || '123456789:TESTtokenABC'),
    postbackSecret: String(args['postback-secret'] || process.env.AD_POSTBACK_SECRET || 'test-postback'),
    internalSecret: String(args['internal-secret'] || process.env.INTERNAL_API_SECRET || 'test-internal'),
    report: args.report ? path.resolve(String(args.report)) : path.join(os.tmpdir(), `mwar-load-security-${Date.now()}.json`),
  };
  OPT.d1Local = args['d1-local'] !== undefined ? args['d1-local'] !== 'false' : /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(OPT.api);

  const results = [];
  const metrics = {};
  const check = (section, name, ok, info = '') => {
    results.push({ section, name, ok: !!ok, info: String(info) });
    console.log(`${ok ? 'PASS' : 'FAIL'} [${section}] ${name}${info ? ' — ' + info : ''}`);
  };
  const note = (section, text) => {
    results.push({ section, name: text, ok: true, info: 'note', note: true });
    console.log(`NOTE [${section}] ${text}`);
  };

  const children = [];
  const cleanup = () => {
    for (const c of children) {
      try {
        c.kill('SIGTERM');
      } catch {}
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  // ==============================================================================================
  // PART A — game server
  // ==============================================================================================
  async function partGame() {
    const secret = OPT.gameUrl ? process.env.INTERNAL_API_SECRET || 'local-dev-internal-game-secret-2026' : crypto.randomBytes(24).toString('hex');

    // ---- mock Worker API: batch payouts + room registry -----------------------------------------
    const mock = { requests: 0, badSecret: 0, injected503: 0, items: [], byGame: new Map(), seenGames: new Set(), lastAt: 0, sessionUpserts: [], sessionEnds: [], sessionReports: 0, lastItemAt: 0 };
    const mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url.startsWith('/api/games/rooms-config')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ rooms: [] }));
        }
        if (req.method === 'POST' && req.url === '/api/game/batch-payout') {
          mock.requests++;
          mock.lastAt = Date.now();
          let j = null;
          try {
            j = JSON.parse(body);
          } catch {}
          if (!j || j.secret !== secret) {
            mock.badSecret++;
            res.writeHead(401);
            return res.end('{}');
          }
          // Quiet detection ignores pure session heartbeats (rooms holding bodies report every 10 s)
          if ((j.payouts || []).length || j.sessions?.end?.length) mock.lastItemAt = Date.now();
          // The first batch of every game fails → the room must re-queue and resend it
          if (!mock.seenGames.has(j.gameId)) {
            mock.seenGames.add(j.gameId);
            mock.injected503++;
            res.writeHead(503);
            return res.end('{}');
          }
          const fastMini = [];
          // V1.1 R3: live-session report riding along with the batch (snapshot upserts + ends + room heartbeat)
          if (j.sessions) {
            mock.sessionReports++;
            for (const u of j.sessions.upsert || []) mock.sessionUpserts.push({ ...u, roomId: j.sessions.roomId, gameId: j.gameId, at: Date.now() });
            for (const e of j.sessions.end || []) mock.sessionEnds.push({ ...e, roomId: j.sessions.roomId, gameId: j.gameId, at: Date.now() });
          }
          for (const it of j.payouts || []) {
            mock.items.push({ ...it, gameId: j.gameId });
            const g = mock.byGame.get(j.gameId) || [];
            g.push(it);
            mock.byGame.set(j.gameId, g);
            if (it.actionType === 'FAST_MINI_KILL' && mock.fastMiniReply) {
              fastMini.push({ pid: it.metadata?.pid, killerId: it.userId, victimId: it.metadata?.victimId, status: 'paid', valueMicroUsd: mock.fastMiniReply.value, shooterMicroUsd: mock.fastMiniReply.shooter, platformMicroUsd: mock.fastMiniReply.value - mock.fastMiniReply.shooter });
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ success: true, fastMini }));
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
    await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
    const mockUrl = `http://127.0.0.1:${mockServer.address().port}`;

    // ---- game server ------------------------------------------------------------------------------
    let url = OPT.gameUrl;
    let probe = null;
    if (!url) {
      const port = await freePort();
      const gsDir = path.join(ROOT, 'apps/game-server');
      const profArgs = args['server-cpu-prof'] ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(String(args['server-cpu-prof']))}`] : [];
      const child = spawn(process.execPath, [...profArgs, '--expose-gc', '--max-old-space-size=4096', '--require', path.join(HERE, 'server-probe.cjs'), '--import', 'tsx', 'src/index.ts'], {
        cwd: gsDir,
        // V1.1 R3: rooms that only hold disconnected bodies shut down after 5 s here (30 min in production)
        env: { ...process.env, GAME_PORT: String(port), PORT: String(port), WORKER_API_URL: mockUrl, API_BASE_URL: mockUrl, INTERNAL_API_SECRET: secret, REDIS_URL: 'disabled', NODE_ENV: 'production', BODY_ONLY_ROOM_TTL_SECONDS: '5', GAME_PUBLIC_URL: `ws://127.0.0.1:${port}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      // The bots run on the same machine: give the server CPU priority (as on a dedicated game node)
      // so the load generator's own CPU use does not show up as server tick jitter. Needs root/CAP_SYS_NICE.
      try {
        os.setPriority(child.pid, -10);
        metrics.serverPriority = -10;
      } catch {
        metrics.serverPriority = 'default (could not raise; tick jitter includes bot CPU contention)';
      }
      probe = { last: null, gcWaiters: [], log: [], child };
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
        let i;
        while ((i = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, i);
          out = out.slice(i + 1);
          if (line.startsWith('@@PROBE_GC ')) probe.gcWaiters.shift()?.(JSON.parse(line.slice(11)));
          else if (line.startsWith('@@PROBE ')) probe.last = JSON.parse(line.slice(8));
          else if (probe.log.length < 4000) probe.log.push(line);
        }
      });
      child.stderr.on('data', (c) => probe.log.length < 4000 && probe.log.push(String(c).trimEnd()));
      url = `ws://127.0.0.1:${port}`;
      const healthUrl = `http://127.0.0.1:${port}/health`;
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await sleep(500);
        up = await fetch(healthUrl).then((r) => r.ok).catch(() => false);
      }
      check('game', 'game server started (/health ok)', up, url);
      if (!up) {
        console.log(probe.log.slice(-30).join('\n'));
        return;
      }
    }
    const probeCmd = (cmd) => probe?.child.stdin.write(cmd + '\n');
    const probeGc = () => (probe ? new Promise((r) => (probe.gcWaiters.push(r), probeCmd('gc'))) : Promise.resolve(null));

    // ---- A1. combat validation room ------------------------------------------------------------
    await combatValidation(url, secret, mock);
    // ---- A1b. V1.1 R2 Fast & Mini validation room ------------------------------------------------
    await fastMiniValidation(url, secret, mock);
    // ---- A1c. V1.1 R3 disconnected bodies + Rejoin ------------------------------------------------
    await persistenceValidation(url, secret, mock);

    // Wait until the validation room is disposed and its payouts settled
    await settle(mock, 12_000);
    const baseline = await probeGc();

    // ---- A2. waves -------------------------------------------------------------------------------
    const wave1 = await runWave(url, secret, mock, OPT.players, OPT.duration, 'wave1', probe, probeCmd);
    const afterWave1 = await probeGc();
    const wave2 = await runWave(url, secret, mock, OPT.players, OPT.wave2, 'wave2', probe, probeCmd);
    const afterWave2 = await probeGc();
    metrics.memory = { baseline, afterWave1, afterWave2 };
    metrics.wave1 = wave1;
    metrics.wave2 = wave2;

    if (probe && baseline && afterWave1 && afterWave2) {
      const created = afterWave2.roomsCreated;
      const collected = afterWave2.roomsCollected;
      check('leak', 'every disposed room was garbage collected', afterWave2.gcExposed && collected >= created - 1, `${collected}/${created} room objects collected after 2 waves`);
      const growth = afterWave2.heapUsedMB - afterWave1.heapUsedMB;
      check('leak', 'heap does not grow between equal waves (≤ 20 MB)', growth <= 20, `heap after GC: baseline ${baseline.heapUsedMB} MB → wave1 ${afterWave1.heapUsedMB} MB → wave2 ${afterWave2.heapUsedMB} MB (Δ ${growth.toFixed(1)} MB)`);
      check('leak', 'heap returns near baseline after all rooms closed (≤ baseline + 40 MB)', afterWave2.heapUsedMB <= baseline.heapUsedMB + 40, `RSS ${afterWave2.rssMB} MB`);
    } else if (!probe) note('leak', 'leak check skipped (--game-url: no server probe)');

    // Anything odd in the server log
    if (probe) {
      // (R3: the refused Rejoin attempts of A1c are expected — Colyseus prints every refused join)
      const errs = probe.log.filter((l) => /Error|Unhandled|ERR_/i.test(l) && !/registry refresh/i.test(l) && !/Error: (Invalid rejoin token|Your character is no longer in this match)\n/.test(l + '\n'));
      check('game', 'no errors in the game server log', errs.length === 0, errs.slice(0, 3).join(' | '));
      metrics.serverLogWarnings = {
        antiCheatL2: probe.log.filter((l) => l.includes('[AntiCheat L2]')).length,
        antiCheatL3: probe.log.filter((l) => l.includes('[AntiCheat L3]')).length,
      };
    }
    mockServer.close();
  }

  async function combatValidation(url, secret, mock) {
    const S = 'combat';
    const uidA = uuid();
    const uidB = uuid();
    const uidD = uuid();
    const uidE = uuid();
    const uidF = uuid();
    const uidV = uuid();
    // V1.1 tickets: A, D, V hold paid tickets with real backed values
    const T = { A: { tid: `tkt_${uuid()}`, tv: 2760 }, D: { tid: `tkt_${uuid()}`, tv: 7820 }, V: { tid: `tkt_${uuid()}`, tv: 29440 } };
    const tokA = mintEntryToken(secret, { uid: uidA, un: 'lt_alpha', ...T.A });
    const forgedB = mintEntryToken('not-the-server-secret', { uid: uidB, un: 'lt_forged' });
    const tokD = mintEntryToken(secret, { uid: uidD, un: 'lt_sameip', ...T.D });
    const tokV = mintEntryToken(secret, { uid: uidV, un: 'lt_victim', ...T.V });
    const expiredE = mintEntryToken(secret, { uid: uidE, un: 'lt_expired', exp: Math.floor(Date.now() / 1000) - 60 });
    const wrongRoomF = mintEntryToken(secret, { uid: uidF, un: 'lt_wrongroom', rc: 'OTHER_ROOM' });

    const cl = (ip) => new Client(url, { headers: { 'x-forwarded-for': ip } });
    const A = await cl('198.51.100.10').create('mini_30', { entryToken: tokA, deviceId: 'dev-alpha' });
    const join = (ip, opts) => cl(ip).joinById(A.roomId, opts);
    const B = await join('198.51.100.11', { entryToken: forgedB, deviceId: 'dev-forged' });
    const C = await join('198.51.100.12', { entryToken: tokA, deviceId: 'dev-replay' }); // replayed ticket
    const D = await join('198.51.100.10', { entryToken: tokD, deviceId: 'dev-sameip' }); // same IP as A
    const E = await join('198.51.100.13', { entryToken: expiredE, deviceId: 'dev-expired' });
    const F = await join('198.51.100.14', { entryToken: wrongRoomF, deviceId: 'dev-wrongroom' });
    const V = await join('198.51.100.15', { entryToken: tokV, deviceId: 'dev-victim' });
    const all = [A, B, C, D, E, F, V];
    const inbox = new Map(all.map((r) => [r, []]));
    for (const r of all) r.onMessage('*', (type, msg) => inbox.get(r).push({ type, msg }));
    const msgsOf = (r, type) => inbox.get(r).filter((m) => m.type === type).map((m) => m.msg);
    const elimOf = (r) => msgsOf(r, 'player_eliminated').slice(-1)[0];
    const kills = [];
    A.onMessage('player_killed', (m) => kills.push(m));
    await sleep(600);

    const st = () => A.state.players;
    const p = (r) => st().get(r.sessionId);
    check(S, 'forged entry token → guest seat (identity not taken from token)', p(B)?.id.startsWith('guest_'), p(B)?.id);
    check(S, 'expired entry token → guest seat', p(E)?.id.startsWith('guest_'), p(E)?.id);
    check(S, 'valid token → player id from the signed token', p(A)?.id === uidA);
    check(S, 'V1.1: the signed ticket value is the value on the player (state.ticketMicroUsd)', p(V)?.ticketMicroUsd === T.V.tv && p(B)?.ticketMicroUsd === 0, `V ${p(V)?.ticketMicroUsd} · guest ${p(B)?.ticketMicroUsd}`);

    // Fire-rate limit: 30 shots in one burst, only the first may land (AK-47: 100 ms, 80 ms tolerance)
    for (let i = 0; i < 30; i++) A.send('player_shoot', { targetType: 'player', targetId: B.sessionId, damage: 10 });
    await sleep(300);
    const hB1 = p(B).health;
    check(S, 'fire-rate limit drops a 30-shot burst', hB1 >= 80 && hB1 < 100, `victim health ${hB1} (only ${(100 - hB1) / 10} of 30 shots counted)`);

    A.send('player_shoot', { targetType: 'player', targetId: B.sessionId, damage: 9999 });
    await sleep(200);
    const hB2 = p(B).health;
    check(S, 'damage clamp: body shot 9999 → AK-47 body damage (34)', hB1 - hB2 === 34, `${hB1} → ${hB2}`);

    A.send('player_shoot', { targetType: 'player', targetId: A.sessionId, damage: 50 });
    await sleep(150);
    A.send('player_shoot', { targetType: 'player', targetId: 'no-such-session', damage: 50 });
    await sleep(150);
    A.send('player_shoot', { targetType: 'chest', targetId: 'no-such-chest', damage: 50 });
    await sleep(150);
    check(S, 'self-shot / unknown player / unknown chest ignored', p(A).health === 100 && p(B).health === hB2, `shooter health ${p(A).health}`);

    // Head shot 9999 → clamped to 68 → B (≤ 56 hp) dies. B is a guest (forged token, no ticket): pays 0
    A.send('player_shoot', { targetType: 'player', targetId: B.sessionId, damage: 9999, headshot: true });
    await sleep(250);
    check(S, 'clamped head shot kills the victim', p(B).isGhost === true && kills.length === 1, `kills seen ${kills.length}`);
    check(S, 'V1.1: killing a guest (no ticket) pays nothing — no fixed kill reward', Number(kills[0]?.rewardMicroUsd) === 0 && Number(kills[0]?.ticketMicroUsd) === 0, `reward ${kills[0]?.rewardMicroUsd}`);

    // A kills V (paid ticket, 29 440 µUSD): the kill is worth exactly V's ticket, A sees the 55 % share
    await sleep(160);
    A.send('player_shoot', { targetType: 'player', targetId: V.sessionId, damage: 68, headshot: true });
    await sleep(160);
    A.send('player_shoot', { targetType: 'player', targetId: V.sessionId, damage: 68, headshot: true });
    await sleep(250);
    const kV = kills[kills.length - 1];
    check(S, 'V1.1: paid kill is worth exactly the victim ticket (55 % to the shooter)', p(V).isGhost && kV?.victimId === uidV && Number(kV?.ticketMicroUsd) === T.V.tv && Number(kV?.rewardMicroUsd) === earnerShare(T.V.tv), `ticket ${kV?.ticketMicroUsd} · shooter +${kV?.rewardMicroUsd} (expected ${earnerShare(T.V.tv)})`);
    check(S, 'V1.1: a settled ticket is gone from the victim (respawn is worth 0)', p(V).ticketMicroUsd === 0);

    // ---- V1.1 R2: Paid-EC death prompt — no auto-respawn, re-stake with a NEW ticket only ----
    const vElim = elimOf(V);
    check(S, 'R2: Paid-EC death → death & round summary with respawnMode "restake" (kills / C earnings / bounty in the message)', vElim?.respawnMode === 'restake' && typeof vElim?.sessionEarningsMicroUsd === 'number' && typeof vElim?.kills === 'number' && typeof vElim?.bountyMicroUsd === 'number', JSON.stringify(vElim || {}).slice(0, 160));
    await sleep(3400);
    check(S, 'R2: no automatic respawn in a Paid-EC room (still dead after 3.4 s)', p(V).isGhost === true);
    V.send('player_respawn', {});
    await sleep(250);
    check(S, 'R2: a free "player_respawn" is refused for a paid seat (restake_required)', p(V).isGhost === true && msgsOf(V, 'restake_required').length === 1);
    const R = { tid: `tkt_${uuid()}`, tv: 7820, eid: uuid() };
    V.send('player_restake', { entryToken: mintEntryToken('not-the-server-secret', { uid: uidV, un: 'lt_victim', ...R, rs: 1 }) });
    V.send('player_restake', { entryToken: mintEntryToken(secret, { uid: uidA, un: 'lt_alpha', tid: `tkt_${uuid()}`, tv: 999, rs: 1 }) }); // another account's ticket
    V.send('player_restake', { entryToken: mintEntryToken(secret, { uid: uidV, un: 'lt_victim', tid: `tkt_${uuid()}`, tv: 999, rc: 'OTHER_ROOM', rs: 1 }) });
    await sleep(300);
    const rr0 = msgsOf(V, 'restake_result');
    check(S, 'R2: forged / other-account / wrong-room "Play again" tokens are refused (still dead)', p(V).isGhost === true && rr0.length === 3 && rr0.every((r) => r.ok === false), rr0.map((r) => r.reason).join(','));
    const tokR = mintEntryToken(secret, { uid: uidV, un: 'lt_victim', ...R, rs: 1 });
    V.send('player_restake', { entryToken: tokR });
    await sleep(300);
    const rr1 = msgsOf(V, 'restake_result').slice(-1)[0];
    check(S, 'R2: "Play again (-1 EC)" with a fresh signed ticket respawns the same player carrying the NEW ticket value', p(V).isGhost === false && p(V).health === 100 && p(V).ticketMicroUsd === R.tv && rr1?.ok === true && rr1?.entryId === R.eid, `ticket ${p(V).ticketMicroUsd}`);
    V.send('player_restake', { entryToken: tokR });
    const R2t = { tid: `tkt_${uuid()}`, tv: 1840, eid: uuid() };
    V.send('player_restake', { entryToken: mintEntryToken(secret, { uid: uidV, un: 'lt_victim', ...R2t, rs: 1 }) }); // while alive
    await sleep(300);
    const rr2 = msgsOf(V, 'restake_result').slice(-2);
    check(S, 'R2: replayed token refused; a second ticket while alive is refused (and returned) — no double lock', rr2[0]?.reason === 'used_token' && rr2[1]?.reason === 'not_dead' && p(V).ticketMicroUsd === R.tv, rr2.map((r) => r.reason).join(','));

    // Ghost cannot shoot
    B.send('player_shoot', { targetType: 'player', targetId: A.sessionId, damage: 34 });
    await sleep(200);
    check(S, 'ghost (dead) player cannot deal damage', p(A).health === 100);

    // Same-IP collusion: D (paid, same IP as A) kills A → pays 0
    D.send('player_shoot', { targetType: 'player', targetId: A.sessionId, damage: 68, headshot: true });
    await sleep(150);
    D.send('player_shoot', { targetType: 'player', targetId: A.sessionId, damage: 68, headshot: true });
    await sleep(250);
    const kD = kills[kills.length - 1];
    check(S, 'same-IP kill pays nothing (Layer 3 collusion)', p(A).isGhost && kD?.victimId === uidA && Number(kD?.rewardMicroUsd) === 0, `reward ${kD?.rewardMicroUsd}`);

    // Replayed ticket C kills D; wrong-room ticket F kills C → both unpaid seats
    for (const [shooter, victim] of [
      [C, D],
      [F, C],
    ]) {
      shooter.send('player_shoot', { targetType: 'player', targetId: victim.sessionId, damage: 68, headshot: true });
      await sleep(150);
      shooter.send('player_shoot', { targetType: 'player', targetId: victim.sessionId, damage: 68, headshot: true });
      await sleep(250);
    }
    const unpaid = kills.slice(-2);
    check(S, 'replayed / wrong-room tickets play unpaid', unpaid.length === 2 && unpaid.every((k) => Number(k.rewardMicroUsd) === 0), unpaid.map((k) => k.rewardMicroUsd).join(','));
    // R2: an unpaid seat (C, killed by F) gets the free prompt: "Play again" only after 3 s, never automatically
    check(S, 'R2: unpaid seat death → respawnMode "free"', elimOf(C)?.respawnMode === 'free');
    C.send('player_respawn', {});
    await sleep(200);
    const earlyC = p(C).isGhost;
    await sleep(3000);
    const waitedC = p(C).isGhost;
    C.send('player_respawn', {});
    await sleep(250);
    check(S, 'R2: free "Play again" is refused before 3 s, no auto-respawn, accepted after 3 s', earlyC === true && waitedC === true && p(C).isGhost === false, `early ${earlyC} · waited ${waitedC} · after ${p(C).isGhost}`);

    await Promise.allSettled(all.map((r) => r.leave(true)));
    await settle(mock, 12_000);
    const mine = mock.items.filter((it) => [uidA, uidB, uidD, uidE, uidF, uidV].includes(it.userId));
    const killsA = mine.filter((it) => it.userId === uidA && it.actionType === 'GAME_KILL');
    const money = mine.filter((it) => it.actionType !== 'TICKET_FORFEIT' && it.actionType !== 'TICKET_RETURN');
    const forfeits = mine.filter((it) => it.actionType === 'TICKET_FORFEIT');
    const returns = mine.filter((it) => it.actionType === 'TICKET_RETURN');
    const fTid = (tid) => forfeits.filter((f) => f.metadata?.ticketId === tid);
    check(
      S,
      'batch settlement: exactly one GAME_KILL (A → V) = V\'s ticket value, with its ticket id',
      money.length === 1 && killsA.length === 1 && Number(killsA[0].amountMicroUsd) === T.V.tv && killsA[0].metadata?.ticketId === T.V.tid && killsA[0].metadata?.victimId === uidV,
      `${mine.length} item(s): ${mine.map((m) => `${m.actionType}:${m.amountMicroUsd}`).join(', ')}`
    );
    check(
      S,
      'V1.1: collusion victim A and unpaid-killer victim D → their tickets forfeited (platform), once each',
      fTid(T.A.tid).length === 1 && fTid(T.A.tid)[0].metadata?.reason === 'collusion' && fTid(T.D.tid).length === 1 && fTid(T.D.tid)[0].userId === uidD,
      forfeits.map((f) => `${f.userId === uidA ? 'A' : f.userId === uidD ? 'D' : f.userId === uidV ? 'V' : '?'}:${f.metadata?.reason}`).join(', ')
    );
    // V1.1 R3: V left ALIVE → its body stayed in the arena (never forfeited on leave); the room then held only
    // that body, shut down after the body-only TTL and RETURNED the ticket (room-shutdown rule) — exactly once
    const rShutdown = returns.filter((r) => r.metadata?.ticketId === R.tid);
    const rRefused = returns.filter((r) => r.metadata?.ticketId === R2t.tid);
    check(
      S,
      'R2: the refused second "Play again" ticket is RETURNED (not_dead), never paid',
      rRefused.length === 1 && rRefused[0].metadata?.entryId === R2t.eid && rRefused[0].metadata?.reason === 'not_dead' && rRefused[0].userId === uidV,
      `${returns.length} returns`
    );
    check(
      S,
      'R3: V left alive → no forfeit on leave; its body stayed until the room shut down and the re-staked ticket was RETURNED once (room_shutdown)',
      forfeits.length === 2 && fTid(R.tid).length === 0 && rShutdown.length === 1 && rShutdown[0].metadata?.reason === 'room_shutdown' && rShutdown[0].metadata?.entryId === R.eid && rShutdown[0].userId === uidV && returns.length === 2,
      `${forfeits.length} forfeits · returns ${returns.map((r) => r.metadata?.reason).join(',')}`
    );
    const pids = mine.map((m) => m.metadata?.pid);
    check(S, 'V1.1: every payout item carries a unique payout id (Worker de-duplicates re-sent batches)', pids.every((x) => typeof x === 'string') && new Set(pids).size === pids.length);
    check(S, 'payout batch re-queued after a 503 from the Worker', mock.injected503 >= 1 && killsA.length === 1, `${mock.injected503} injected 503(s)`);
    check(S, 'payout requests carry the internal secret', mock.badSecret === 0);
  }

  /** V1.1 R2: Fast & Mini — free seats, banner-pot kills settled by the Worker, no tickets, no bounty. */
  async function fastMiniValidation(url, secret, mock) {
    const S = 'fast_mini';
    const G = { uid: uuid(), eid: uuid() };
    const H = { uid: uuid(), eid: uuid() };
    const I = { uid: uuid(), tid: `tkt_${uuid()}`, eid: uuid() };
    const cl = (ip) => new Client(url, { headers: { 'x-forwarded-for': ip } });
    mock.fastMiniReply = { value: 1000, shooter: 900 };
    const g = await cl('198.51.100.40').create('fast_mini', { entryToken: mintEntryToken(secret, { uid: G.uid, un: 'lt_fm_g', eid: G.eid, fm: 1 }), deviceId: 'dev-fm-g' });
    const h = await cl('198.51.100.41').joinById(g.roomId, { entryToken: mintEntryToken(secret, { uid: H.uid, un: 'lt_fm_h', eid: H.eid, fm: 1 }), deviceId: 'dev-fm-h' });
    const i = await cl('198.51.100.42').joinById(g.roomId, { entryToken: mintEntryToken(secret, { uid: I.uid, un: 'lt_fm_i', eid: I.eid, tid: I.tid, tv: 2760 }), deviceId: 'dev-fm-i' });
    const box = new Map([[g, []], [h, []], [i, []]]);
    for (const r of [g, h, i]) r.onMessage('*', (type, msg) => box.get(r).push({ type, msg }));
    const of = (r, type) => box.get(r).filter((m) => m.type === type).map((m) => m.msg);
    await sleep(500);
    const pl = (r) => g.state.players.get(r.sessionId);
    check(S, 'R2: Fast & Mini seats carry no ticket value (0 EC, no ticket)', pl(g)?.ticketMicroUsd === 0 && pl(h)?.ticketMicroUsd === 0 && pl(i)?.ticketMicroUsd === 0 && pl(g)?.id === G.uid);
    g.send('player_shoot', { targetType: 'player', targetId: h.sessionId, damage: 68, headshot: true });
    await sleep(160);
    g.send('player_shoot', { targetType: 'player', targetId: h.sessionId, damage: 68, headshot: true });
    await sleep(300);
    const el = of(h, 'player_eliminated').slice(-1)[0];
    const pk = of(g, 'player_killed').slice(-1)[0];
    check(S, 'R2: Fast & Mini death → free prompt (respawnMode "free", fastMini) and no instant reward claimed by the game server', pl(h)?.isGhost && el?.respawnMode === 'free' && el?.fastMini === true && pk?.fastMini === true && Number(pk?.rewardMicroUsd) === 0, JSON.stringify(el || {}).slice(0, 120));
    await sleep(3400);
    check(S, 'R2: Fast & Mini has no automatic respawn either', pl(h)?.isGhost === true);
    h.send('player_respawn', {});
    await sleep(250);
    check(S, 'R2: "Play again free (0 EC)" respawns the Fast & Mini player', pl(h)?.isGhost === false);
    // the Worker answers the FAST_MINI_KILL (after the injected 503 + 10 s batch): the HUD gets what was REALLY paid
    const t0 = Date.now();
    while (!of(g, 'fast_mini_reward').length && Date.now() - t0 < 25_000) await sleep(250);
    const rw = of(g, 'fast_mini_reward')[0];
    check(S, 'R2: shooter HUD credited with the Worker-reported 90 % (not a game-server amount)', rw?.shooterMicroUsd === 900 && pl(g)?.sessionEarningsMicroUsd === 900 && of(h, 'fast_mini_pot_lost').length === 1, `reward ${JSON.stringify(rw)} · earnings ${pl(g)?.sessionEarningsMicroUsd}`);
    await Promise.allSettled([g, h, i].map((r) => r.leave(true)));
    await settle(mock, 12_000);
    const items = mock.items.filter((it) => [G.uid, H.uid, I.uid].includes(it.userId));
    const fk = items.filter((it) => it.actionType === 'FAST_MINI_KILL');
    const fc = items.filter((it) => it.actionType === 'FAST_MINI_CLOSE');
    const ret = items.filter((it) => it.actionType === 'TICKET_RETURN');
    const other = items.filter((it) => !['FAST_MINI_KILL', 'FAST_MINI_CLOSE', 'TICKET_RETURN'].includes(it.actionType));
    check(S, 'R2: one FAST_MINI_KILL = killer G, victim H, H\'s OWN pot, amount 0 (Worker decides), death time attached', fk.length === 1 && fk[0].userId === G.uid && fk[0].metadata?.victimId === H.uid && fk[0].metadata?.potId === H.eid && fk[0].amountMicroUsd === 0 && Number(fk[0].metadata?.diedAt) > 0, JSON.stringify(fk[0]?.metadata || {}).slice(0, 160));
    check(S, 'R2: every Fast & Mini pot closed exactly once on leave; no GAME_KILL / BOUNTY / ticket items', fc.length === 2 && new Set(fc.map((f) => f.metadata?.potId)).size === 2 && fc.some((f) => f.metadata?.potId === G.eid) && fc.some((f) => f.metadata?.potId === H.eid) && other.length === 0, `${fc.length} closes · ${other.length} other`);
    check(S, 'R2: a ticket token used in the free Fast & Mini room is returned, never staked', ret.length === 1 && ret[0].metadata?.ticketId === I.tid && ret[0].userId === I.uid);
    mock.fastMiniReply = null;
  }

  /**
   * V1.1 R3 — an alive Paid-EC seat that leaves stays in the arena as a body (exact position, HP, hitbox, prop
   * disguise, ticket value, head bounty): killable for exactly what a live kill pays, never AFK-kicked, never
   * forfeited on leave. Rejoin (Worker-signed token, here minted with the shared secret) re-attaches the same
   * body without a new ticket; a second connection takes the body over (never a duplicate). A room holding
   * only bodies shuts down after the body-only TTL and RETURNS the alive bodies' tickets (room-shutdown rule).
   */
  async function persistenceValidation(url, secret, mock) {
    const S = 'persist';
    const P = { uid: uuid(), eid: uuid(), tid: `tkt_${uuid()}`, tv: 13800, bty: 4321 };
    const K = { uid: uuid(), eid: uuid(), tid: `tkt_${uuid()}`, tv: 2760 };
    const Q = { uid: uuid(), eid: uuid(), tid: `tkt_${uuid()}`, tv: 7820 };
    const rejoinTok = (sec, { uid, eid, rid, exp = Math.floor(Date.now() / 1000) + 120, rj = 1 }) => {
      const body = Buffer.from(JSON.stringify({ uid, un: 'lt_r3', eid, rid, ...(rj ? { rj } : {}), exp })).toString('base64url');
      return `${body}.${crypto.createHmac('sha256', sec).update(body).digest('hex')}`;
    };
    const cl = (ip) => new Client(url, { headers: { 'x-forwarded-for': ip } });
    const k = await cl('198.51.100.60').create('mini_30', { entryToken: mintEntryToken(secret, { uid: K.uid, un: 'lt_r3_killer', eid: K.eid, tid: K.tid, tv: K.tv }), deviceId: 'dev-r3-k' });
    const kills = [];
    k.onMessage('*', (type, msg) => type === 'player_killed' && kills.push(msg));
    const p1 = await cl('198.51.100.61').joinById(k.roomId, { entryToken: mintEntryToken(secret, { uid: P.uid, un: 'lt_r3_prop', eid: P.eid, tid: P.tid, tv: P.tv, bty: P.bty }), deviceId: 'dev-r3-p' });
    p1.onMessage('*', () => {});
    await sleep(500);
    const bodies = (uid) => {
      const out = [];
      k.state.players.forEach((p, sid) => p.id === uid && out.push({ sid, p }));
      return out;
    };
    const me = bodies(P.uid)[0]?.p;
    p1.send('player_move', { x: me.x + 0.6, y: me.y, z: me.z + 0.4, rotationY: 1.25, stance: 'stand' });
    await sleep(200);
    p1.send('player_set_prop', { isProp: true, propType: 'oil_drum' });
    await sleep(400);
    const bp0 = bodies(P.uid)[0].p;
    const before = { x: bp0.x, z: bp0.z };
    const countBefore = k.state.players.size;
    // Socket loss (not a consented leave): the server must keep the body exactly as it was
    p1.leave(false);
    await sleep(900);
    const b1 = bodies(P.uid);
    const bp = b1[0]?.p;
    check(
      S,
      'R3: alive Paid-EC player disconnects → body stays in the arena, still disguised as the same prop at the same spot (HP, ticket, bounty kept)',
      b1.length === 1 && bp.isProp === true && bp.propType === 'oil_drum' && bp.x === before.x && bp.z === before.z && bp.health === 100 && bp.ticketMicroUsd === P.tv && bp.bountyMicroUsd === P.bty && !bp.isGhost,
      `${b1.length} body · prop ${bp?.isProp}/${bp?.propType} · (${bp?.x},${bp?.z}) vs (${before.x},${before.z}) · hp ${bp?.health} · ticket ${bp?.ticketMicroUsd} · bounty ${bp?.bountyMicroUsd}`
    );
    // The Worker gets the disconnected, prop-hidden live session (first batch of a game is answered 503 → retried)
    const t0 = Date.now();
    const snap = () => mock.sessionUpserts.find((u) => u.entryId === P.eid && u.isDisconnected && u.isPropHidden);
    while (!snap() && Date.now() - t0 < 25_000) await sleep(250);
    const sn = snap();
    check(S, 'R3: live session reported to the Worker: { roomId, mode, mapName, hp, isPropHidden, isDisconnected, enteredAt }', !!sn && sn.roomId === k.roomId && sn.mode === 'mini_30' && sn.mapName === 'small' && sn.hp === 100 && sn.propType === 'oil_drum' && sn.ticketId === P.tid && sn.lifeStartedAt > 0, JSON.stringify(sn || {}).slice(0, 220));
    check(S, 'R3: nothing settled or forfeited on disconnect', !mock.items.some((it) => it.metadata?.ticketId === P.tid));

    // ---- Rejoin: only a valid signed token for this room + this alive life re-attaches -------------------
    const tryJoin = async (opts) => {
      try {
        const r = await cl('198.51.100.62').joinById(k.roomId, opts);
        r.onMessage('*', () => {});
        return r;
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    };
    const bad = [
      await tryJoin({ rejoinToken: rejoinTok('not-the-server-secret', { uid: P.uid, eid: P.eid, rid: k.roomId }) }),
      await tryJoin({ rejoinToken: rejoinTok(secret, { uid: P.uid, eid: P.eid, rid: 'another-room' }) }),
      await tryJoin({ rejoinToken: rejoinTok(secret, { uid: K.uid, eid: P.eid, rid: k.roomId }) }), // another account
      await tryJoin({ rejoinToken: rejoinTok(secret, { uid: P.uid, eid: P.eid, rid: k.roomId, exp: Math.floor(Date.now() / 1000) - 5 }) }),
      await tryJoin({ rejoinToken: mintEntryToken(secret, { uid: P.uid, un: 'x', eid: P.eid, tid: P.tid, tv: P.tv }) }), // an entry token is not a rejoin token
    ];
    check(S, 'R3: forged / other-room / other-account / expired / entry-token Rejoin attempts are refused', bad.every((b) => b.error) && bodies(P.uid).length === 1, bad.map((b) => (b.error ? 'refused' : 'JOINED')).join(','));
    const asEntry = await tryJoin({ entryToken: rejoinTok(secret, { uid: P.uid, eid: P.eid, rid: k.roomId }), deviceId: 'dev-r3-x' });
    await sleep(300);
    const asEntryP = asEntry.sessionId ? k.state.players.get(asEntry.sessionId) : null;
    check(S, 'R3: a Rejoin token used as an entry token only gets a guest seat (no stake, no identity)', !!asEntryP && asEntryP.id.startsWith('guest_') && asEntryP.ticketMicroUsd === 0, asEntryP?.id);
    if (asEntry.leave) await asEntry.leave(true);
    await sleep(300);

    const tokP = rejoinTok(secret, { uid: P.uid, eid: P.eid, rid: k.roomId });
    const r1 = await cl('198.51.100.63').joinById(k.roomId, { rejoinToken: tokP, deviceId: 'dev-r3-p' });
    const r1Box = [];
    r1.onMessage('*', (type, msg) => r1Box.push({ type, msg }));
    let r1Left = false;
    r1.onLeave(() => (r1Left = true));
    const t1 = Date.now();
    while (!r1Box.some((m) => m.type === 'rejoined') && Date.now() - t1 < 3000) await sleep(50);
    await sleep(300);
    const rj = r1Box.find((m) => m.type === 'rejoined')?.msg;
    const b2 = bodies(P.uid);
    check(
      S,
      'R3: Rejoin re-attaches the SAME body (same spot, still the oil-drum prop, same HP / ticket / bounty) — no duplicate entity',
      !!rj && rj.isProp === true && rj.propType === 'oil_drum' && rj.x === before.x && rj.z === before.z && rj.health === 100 && rj.ticketMicroUsd === P.tv && rj.entryId === P.eid && b2.length === 1 && b2[0].sid === r1.sessionId && k.state.players.size === countBefore,
      `rejoined ${JSON.stringify(rj || {}).slice(0, 140)} · bodies ${b2.length} · players ${k.state.players.size}/${countBefore}`
    );
    check(S, 'R3: Rejoin uses no new EC ticket (no ticket / payout item for the player)', !mock.items.some((it) => it.userId === P.uid || it.metadata?.ticketId === P.tid));
    // A second concurrent connection for the same body: it takes over, the first one is closed — still ONE body
    const r2 = await cl('198.51.100.64').joinById(k.roomId, { rejoinToken: tokP, deviceId: 'dev-r3-p' });
    r2.onMessage('*', () => {});
    await sleep(700);
    const b3 = bodies(P.uid);
    check(S, 'R3: a second concurrent connection takes the body over (old one closed with session_replaced) — never a second body', b3.length === 1 && b3[0].sid === r2.sessionId && r1Left && r1Box.some((m) => m.type === 'session_replaced') && k.state.players.size === countBefore, `bodies ${b3.length} · first closed ${r1Left}`);
    // Consented leave (navigation / tab close) while alive → body again
    await r2.leave(true);
    await sleep(600);
    const b4 = bodies(P.uid);
    check(S, 'R3: consented leave while alive → body stays too (prop kept)', b4.length === 1 && b4[0].p.isProp && b4[0].p.propType === 'oil_drum' && !b4[0].p.isGhost);

    // ---- Another player finds and kills the body: exactly the live-kill payout --------------------------
    const target = b4[0];
    let kp = bodies(K.uid)[0].p;
    for (let i = 0; i < 200; i++) {
      const dx = target.p.x + 2 - kp.x;
      const dz = target.p.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) break;
      const step = Math.min(1.4, d);
      k.send('player_move', { x: kp.x + (dx / d) * step, y: target.p.y, z: kp.z + (dz / d) * step, rotationY: 0, stance: 'stand' });
      await sleep(110);
      kp = bodies(K.uid)[0].p;
    }
    for (let i = 0; i < 4 && !bodies(P.uid)[0]?.p.isGhost && bodies(P.uid).length; i++) {
      k.send('player_shoot', { targetType: 'player', targetId: target.sid, damage: 68, headshot: true });
      await sleep(200);
    }
    await sleep(300);
    const kk = kills.find((m) => m.victimId === P.uid);
    check(
      S,
      'R3: killing the disconnected prop body pays exactly a live kill: ticket value V (55 % shown) + the whole head bounty',
      !!kk && kk.killerId === K.uid && Number(kk.ticketMicroUsd) === P.tv && Number(kk.bountyClaimedMicroUsd) === P.bty && Number(kk.rewardMicroUsd) === earnerShare(P.tv) + P.bty,
      JSON.stringify(kk || {}).slice(0, 200)
    );
    await sleep(2600);
    check(S, 'R3: the dead disconnected body is removed from the arena afterwards', bodies(P.uid).length === 0);
    const lateRejoin = await tryJoin({ rejoinToken: rejoinTok(secret, { uid: P.uid, eid: P.eid, rid: k.roomId }) });
    check(S, 'R3: Rejoin after the death is refused (nothing left to control)', !!lateRejoin.error, lateRejoin.error || 'joined');

    // ---- Room-shutdown rule: only bodies left → TTL → alive bodies' tickets RETURNED ------------------
    const q = await cl('198.51.100.65').joinById(k.roomId, { entryToken: mintEntryToken(secret, { uid: Q.uid, un: 'lt_r3_q', eid: Q.eid, tid: Q.tid, tv: Q.tv }), deviceId: 'dev-r3-q' });
    q.onMessage('*', () => {});
    await sleep(400);
    await q.leave(true);
    await k.leave(true); // the killer leaves alive too → body
    await sleep(400);
    const rooms = await fetch(url.replace(/^ws/, 'http') + '/rooms').then((r) => r.json()).catch(() => null);
    check(S, 'R3: with no client connected the room keeps its 2 alive bodies (not disposed at once)', Number(rooms?.modes?.mini_30?.players) >= 2, JSON.stringify(rooms?.modes?.mini_30 || {}).slice(0, 160));
    await settle(mock, 12_000);
    const mine = mock.items.filter((it) => [P.uid, K.uid, Q.uid].includes(it.userId) || [P.tid, K.tid, Q.tid].includes(it.metadata?.ticketId));
    const ofTid = (tid) => mine.filter((it) => it.metadata?.ticketId === tid);
    const pItems = ofTid(P.tid);
    const gk = pItems.filter((it) => it.actionType === 'GAME_KILL');
    const bc = pItems.filter((it) => it.actionType === 'BOUNTY_CLAIM');
    check(
      S,
      'R3: settlement only at the actual death — one GAME_KILL (K, V = P\'s ticket) + one BOUNTY_CLAIM, no forfeit / return for P',
      pItems.length === 2 && gk.length === 1 && gk[0].userId === K.uid && Number(gk[0].amountMicroUsd) === P.tv && gk[0].metadata?.victimId === P.uid && bc.length === 1 && bc[0].userId === K.uid && Number(bc[0].amountMicroUsd) === P.bty,
      pItems.map((it) => `${it.actionType}:${it.amountMicroUsd}`).join(', ')
    );
    const kq = [...ofTid(K.tid), ...ofTid(Q.tid)];
    check(
      S,
      'R3: room-shutdown rule — the alive bodies\' tickets are RETURNED exactly once each (never paid, never forfeited)',
      kq.length === 2 && kq.every((it) => it.actionType === 'TICKET_RETURN' && it.metadata?.reason === 'room_shutdown') && new Set(kq.map((it) => it.metadata?.ticketId)).size === 2 && ofTid(K.tid)[0]?.metadata?.entryId === K.eid,
      kq.map((it) => `${it.actionType}:${it.metadata?.reason}`).join(', ')
    );
    const endOf = (eid) => mock.sessionEnds.filter((e) => e.entryId === eid);
    check(S, 'R3: live sessions end exactly at the death (P: died) / room shutdown (K, Q)', endOf(P.eid).length === 1 && endOf(P.eid)[0].reason === 'died' && endOf(K.eid)[0]?.reason === 'room_shutdown' && endOf(Q.eid)[0]?.reason === 'room_shutdown', ['P', 'K', 'Q'].map((n, i) => `${n}:${endOf([P.eid, K.eid, Q.eid][i]).map((e) => e.reason).join('/')}`).join(' '));
  }

  /** Wait until no payout request arrived for 3 s (and at least minMs passed). */
  async function settle(mock, minMs) {
    const t0 = Date.now();
    await sleep(minMs);
    while (Date.now() - mock.lastItemAt < 3000 && Date.now() - t0 < 60_000) await sleep(500);
  }

  async function runWave(url, secret, mock, players, durationSec, label, probe, probeCmd) {
    const S = label;
    console.log(`\n── ${label}: ${players} players, ${durationSec} s of combat ──`);
    const itemsBefore = mock.items.length;
    // 50 % mini_30 (30 seats), 40 % standard_100 (100 seats), 10 % fast_mini (30 seats)
    const bots = [];
    for (let i = 0; i < players; i++) {
      const r = i % 10;
      const mode = r < 5 ? 'mini_30' : r < 9 ? 'standard_100' : 'fast_mini';
      const uid = uuid();
      const un = `lt_${label}_${i}`;
      const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      if (mode === 'fast_mini') {
        // V1.1 R2: Fast & Mini seats are free — an `fm` token with a pot id (= eid), never a ticket
        const eid = uuid();
        bots.push({ mode, uid, un, tid: null, tv: 0, eid, token: mintEntryToken(secret, { uid, un, eid, fm: 1 }), ip, deviceId: `lt-dev-${label}-${i}` });
        continue;
      }
      const tid = `tkt_${uuid()}`;
      const tv = TICKET_VALUES[i % TICKET_VALUES.length];
      bots.push({ mode, uid, un, tid, tv, token: mintEntryToken(secret, { uid, un, tid, tv }), ip, deviceId: `lt-dev-${label}-${i}` });
    }
    const uids = new Set(bots.map((b) => b.uid));
    const fmBots = bots.filter((b) => b.mode === 'fast_mini');
    const fmUids = new Set(fmBots.map((b) => b.uid));
    const slices = Array.from({ length: OPT.workers }, () => []);
    bots.forEach((b, i) => slices[i % OPT.workers].push(b));
    const rampMs = Math.min(20_000, players * 12);

    const t0 = Date.now();
    const workers = slices.map((s) => new Worker(fileURLToPath(import.meta.url), { workerData: { url, bots: s, rampMs, hitRate: OPT.hitRate, secret } }));
    const inbox = workers.map(() => []);
    const waitFor = (type, timeout) =>
      Promise.all(
        workers.map(
          (w, i) =>
            new Promise((resolve) => {
              const hit = () => {
                const k = inbox[i].findIndex((m) => m.type === type);
                if (k >= 0) return resolve(inbox[i].splice(k, 1)[0]);
                return false;
              };
              if (hit() !== false) return;
              const onMsg = () => {
                if (hit() !== false) w.off('message', onMsg);
              };
              w.on('message', onMsg);
              setTimeout(() => resolve(null), timeout);
            })
        )
      );
    workers.forEach((w, i) => {
      w.on('message', (m) => inbox[i].push(m));
      w.on('error', (e) => console.error('worker error', e));
    });
    const joined = await waitFor('joined', rampMs + 60_000);
    const joinOk = joined.reduce((a, j) => a + (j?.joinOk || 0), 0);
    const joinMs = Date.now() - t0;
    check(S, `${players} players joined`, joinOk === players, `${joinOk}/${players} in ${(joinMs / 1000).toFixed(1)} s`);

    // Combat window
    probeCmd?.('reset');
    workers.forEach((w) => w.postMessage('combat'));
    const samples = [];
    for (let s = 0; s < durationSec; s++) {
      await sleep(1000);
      if (probe?.last) samples.push(probe.last);
      if (s % 10 === 9) {
        const l = probe?.last;
        console.log(`  t+${s + 1}s${l ? ` heap ${l.heapUsedMB} MB · tick p99 ${l.tickGapMs.p99} ms · loop p99 ${l.eventLoopDelayMs.p99} ms · cost p99 ${l.tickCostMs.p99} ms` : ''}`);
      }
    }
    const server = probe?.last || null;
    workers.forEach((w) => w.postMessage('stop'));
    await sleep(1500); // in-flight kills land, then the observers' tallies are final
    workers.forEach((w) => w.postMessage('report'));
    const reports = await waitFor('report', 20_000);

    const patchHist = newHist();
    const rooms = {};
    const st = { joinFail: 0, unexpectedLeaves: 0, msgsSent: 0, positionRejected: 0, afkKicked: 0, freeRespawns: 0, autoRespawnSeen: 0, joinErrors: [] };
    const restakes = [];
    for (const r of reports) {
      if (!r) continue;
      histMerge(patchHist, r.patchHist);
      restakes.push(...(r.restakes || []));
      for (const k of ['joinFail', 'unexpectedLeaves', 'msgsSent', 'positionRejected', 'afkKicked', 'freeRespawns', 'autoRespawnSeen']) st[k] += r.stats[k] || 0;
      st.joinErrors.push(...r.stats.joinErrors);
      // Same room seen by several threads → identical tallies, keep the biggest (latest) one
      for (const [id, t] of Object.entries(r.rooms)) if (!rooms[id] || t.killEvents > rooms[id].killEvents) rooms[id] = t;
    }
    const roomList = Object.values(rooms);
    const observed = roomList.reduce((a, t) => ({ kills: a.kills + t.killEvents, paid: a.paid + t.paidKills, bounty: a.bounty + t.bountyClaims, bountyUsd: a.bountyUsd + t.bountyMicroUsd }), { kills: 0, paid: 0, bounty: 0, bountyUsd: 0 });

    workers.forEach((w) => w.postMessage('leave'));
    await waitFor('left', 30_000);
    // V1.1 R3: bots that left ALIVE are still in their rooms as bodies right after leaving
    const afterLeave = await fetch(url.replace(/^ws/, 'http') + '/rooms').then((r) => r.json()).catch(() => null);
    const bodiesAfterLeave = afterLeave ? Object.values(afterLeave.modes || {}).reduce((a, b) => a + (Number(b.players) || 0), 0) : -1;
    await settle(mock, 12_000);
    const afterShutdown = await fetch(url.replace(/^ws/, 'http') + '/rooms').then((r) => r.json()).catch(() => null);
    const bodiesAfterShutdown = afterShutdown ? Object.values(afterShutdown.modes || {}).reduce((a, b) => a + (Number(b.players) || 0), 0) : -1;
    // Every ticket of the wave: the join tickets + every "Play again (-1 EC)" re-stake ticket (R2)
    const tickets = [...bots.filter((b) => b.tid).map((b) => ({ uid: b.uid, tid: b.tid, tv: b.tv })), ...restakes];
    const ticketById = new Map(tickets.map((t) => [t.tid, t]));

    const items = mock.items.slice(itemsBefore).filter((it) => uids.has(it.userId));
    const kills = items.filter((it) => it.actionType === 'GAME_KILL');
    const claims = items.filter((it) => it.actionType === 'BOUNTY_CLAIM');
    const chestsOpened = items.filter((it) => it.actionType === 'CHEST_OPEN');
    const forfeits = items.filter((it) => it.actionType === 'TICKET_FORFEIT');
    const returns = items.filter((it) => it.actionType === 'TICKET_RETURN');
    const fmKills = items.filter((it) => it.actionType === 'FAST_MINI_KILL');
    const fmCloses = items.filter((it) => it.actionType === 'FAST_MINI_CLOSE');
    // V1.1: every ticket closed exactly once (GAME_KILL / CHEST_OPEN name the victim's ticket, TICKET_FORFEIT
    // the holder's; R2: an unusable re-stake ticket is RETURNED instead)
    const closes = new Map();
    for (const it of [...kills, ...chestsOpened, ...forfeits, ...returns]) {
      const tid = it.metadata?.ticketId;
      closes.set(tid, (closes.get(tid) || 0) + 1);
    }
    const unknownTickets = [...closes.keys()].filter((tid) => !ticketById.has(tid));
    const twice = [...closes.values()].filter((n) => n > 1).length;
    const neverClosed = tickets.filter((t) => !closes.has(t.tid)).length;
    const killExact = [...kills, ...chestsOpened].every((k) => {
      const v = ticketById.get(k.metadata?.ticketId);
      return v && v.uid === k.metadata?.victimId && Number(k.amountMicroUsd) === v.tv && v.tv > 0 && k.userId !== v.uid;
    });
    const forfeitExact = forfeits.every((f) => ticketById.get(f.metadata?.ticketId)?.uid === f.userId && Number(f.amountMicroUsd) === ticketById.get(f.metadata?.ticketId)?.tv);
    const returnExact = returns.every((r) => ticketById.get(r.metadata?.ticketId)?.uid === r.userId);
    const bountyLinked = claims.every((b) => ticketById.get(b.metadata?.ticketId)?.uid === b.metadata?.victimId);
    const totalBacking = tickets.reduce((a, t) => a + t.tv, 0);
    // R2 Fast & Mini: kills name the victim's own pot (amount decided by the Worker), each pot closes once
    const potOf = new Map(fmBots.map((b) => [b.uid, b.eid]));
    const fmKillExact = fmKills.every((k) => fmUids.has(k.userId) && potOf.get(k.metadata?.victimId) === k.metadata?.potId && k.amountMicroUsd === 0 && k.userId !== k.metadata?.victimId);
    const fmCloseCount = new Map();
    for (const f of fmCloses) fmCloseCount.set(f.metadata?.potId, (fmCloseCount.get(f.metadata?.potId) || 0) + 1);
    const fmClosedOnce = fmBots.every((b) => fmCloseCount.get(b.eid) === 1) && fmCloses.every((f) => potOf.get(f.userId) === f.metadata?.potId);
    const fmNoTicketItems = [...kills, ...chestsOpened, ...claims, ...forfeits].every((it) => !fmUids.has(it.userId) && !fmUids.has(String(it.metadata?.victimId)));
    const totalPaid = [...kills, ...chestsOpened].reduce((a, k) => a + Number(k.amountMicroUsd), 0);
    const strangers = mock.items.slice(itemsBefore).filter((it) => !uids.has(it.userId));
    const client = histSummary(patchHist);

    const wave = {
      players,
      joinOk,
      joinSeconds: +(joinMs / 1000).toFixed(1),
      rooms: roomList.length,
      roomsByMode: roomList.reduce((a, t) => ((a[t.mode] = (a[t.mode] || 0) + 1), a), {}),
      msgsSentPerSec: Math.round(st.msgsSent / durationSec),
      server: server && { tickGapMs: server.tickGapMs, tickCostMs: server.tickCostMs, patchGapMs: server.patchGapMs, patchCostMs: server.patchCostMs, eventLoopDelayMs: server.eventLoopDelayMs, heapUsedMB: server.heapUsedMB, rssMB: server.rssMB },
      clientPatchIntervalMs: client,
      bodies: { afterLeave: bodiesAfterLeave, afterShutdown: bodiesAfterShutdown },
      combat: { killEvents: observed.kills, paidKillsAnnounced: observed.paid, gameKillPayouts: kills.length, chestPayouts: chestsOpened.length, ticketForfeits: forfeits.length, ticketReturns: returns.length, bountyClaimsAnnounced: observed.bounty, bountyClaimPayouts: claims.length, positionRejected: st.positionRejected, afkKicked: st.afkKicked, restakes: restakes.length, freeRespawns: st.freeRespawns, fastMiniKills: fmKills.length, fastMiniPotsClosed: fmCloses.length },
      tickets: { total: tickets.length, joinTickets: tickets.length - restakes.length, restakeTickets: restakes.length, totalBackingMicroUsd: totalBacking, paidOutMicroUsd: totalPaid, closedTwice: twice, neverClosed, unknown: unknownTickets.length },
      heapTimelineMB: samples.map((s) => s.heapUsedMB),
    };
    console.log(`  rooms ${wave.rooms} ${JSON.stringify(wave.roomsByMode)} · ${wave.msgsSentPerSec} msg/s from clients · kills ${observed.kills}`);

    check(S, 'all bots placed in rooms without seat errors', st.joinFail === 0, st.joinErrors.slice(0, 2).join(' | '));
    check(S, 'no unexpected disconnects during combat', st.unexpectedLeaves === 0, `${st.unexpectedLeaves}`);
    if (server) {
      const tg = server.tickGapMs;
      check(S, 'server 20 Hz tick: median gap 50 ms (±5)', Math.abs(tg.p50 - 50) <= 5, `p50 ${tg.p50} · p95 ${tg.p95} · p99 ${tg.p99} · max ${tg.max} ms over ${tg.n} ticks`);
      check(S, 'server tick p99 gap ≤ 100 ms (no skipped ticks)', tg.p99 <= 100);
      check(S, 'server tick work p99 ≤ 25 ms (half the 50 ms budget)', server.tickCostMs.p99 <= 25, `cost p50 ${server.tickCostMs.p50} · p99 ${server.tickCostMs.p99} ms`);
      check(S, 'patch broadcast every 50 ms (p50 ±5, p99 ≤ 100)', Math.abs(server.patchGapMs.p50 - 50) <= 5 && server.patchGapMs.p99 <= 100, `p50 ${server.patchGapMs.p50} · p99 ${server.patchGapMs.p99} ms`);
      check(S, 'event-loop delay p99 ≤ 50 ms', server.eventLoopDelayMs.p99 <= 50, `p50 ${server.eventLoopDelayMs.p50} · p99 ${server.eventLoopDelayMs.p99} · max ${server.eventLoopDelayMs.max} ms`);
    }
    check(S, 'clients receive state patches at ~20 Hz (p50 ≤ 60 ms)', client.p50 <= 60 && client.n > 0, `client patch gap p50 ${client.p50} · p95 ${client.p95} · p99 ${client.p99} ms (${client.n} patches; bots share ${OPT.workers} CPU threads)`);
    check(S, 'combat produced kills', observed.kills > 0, `${observed.kills} kills, ${observed.paid} paid`);
    check(S, 'every announced paid kill settled exactly once', kills.length === observed.paid, `announced ${observed.paid} · received ${kills.length}`);
    check(S, 'every announced bounty claim settled exactly once', claims.length === observed.bounty, `announced ${observed.bounty} · received ${claims.length}`);
    check(S, 'V1.1: every GAME_KILL / CHEST_OPEN = the victim\'s ticket value (no fixed 100,000), right ticket id', killExact && kills.length > 0, `${kills.length} kills, ${chestsOpened.length} chests`);
    check(S, 'V1.1: every ticket closed exactly once (killed / chest / R2 returned / R3 returned at room shutdown)', twice === 0 && neverClosed === 0 && unknownTickets.length === 0, `${closes.size}/${tickets.length} closed (${restakes.length} re-stake tickets) · ${twice} twice · ${neverClosed} never · ${unknownTickets.length} unknown`);
    const shutdownReturns = returns.filter((r) => r.metadata?.reason === 'room_shutdown').length;
    const leftForfeits = forfeits.filter((f) => f.metadata?.reason === 'left').length;
    check(S, 'R3: bots that left alive stayed as bodies (no forfeit on leave) and their tickets were RETURNED once when the body-only rooms shut down', bodiesAfterLeave > 0 && leftForfeits === 0 && shutdownReturns > 0 && bodiesAfterShutdown === 0, `${bodiesAfterLeave} bodies right after leaving · ${shutdownReturns} returned at shutdown · ${leftForfeits} forfeited on leave · ${bodiesAfterShutdown} left after shutdown`);
    check(S, 'V1.1: TICKET_FORFEIT names the holder\'s own ticket; bounty claims name the victim\'s ticket', forfeitExact && bountyLinked && returnExact, `${forfeits.length} forfeits · ${returns.length} returns · ${claims.length} bounty claims`);
    check(S, 'R2: no automatic respawn — dead bots came back only through "Play again" (re-stake / free)', st.autoRespawnSeen === 0 && restakes.length > 0, `${restakes.length} re-stakes · ${st.freeRespawns} free plays · ${st.autoRespawnSeen} came back without choosing`);
    check(S, 'R2: Fast & Mini — kills name the victim\'s own pot (amount 0, Worker decides), every pot closed once, no ticket / bounty items', fmKillExact && fmClosedOnce && fmNoTicketItems && fmBots.length > 0, `${fmKills.length} FAST_MINI_KILL · ${fmCloses.length}/${fmBots.length} pots closed`);
    check(S, 'V1.1: zero deficit — total paid out ≤ total ticket backing', totalPaid <= totalBacking, `paid ${totalPaid} µUSD of ${totalBacking} µUSD backing`);
    const zeroOk = new Set(['TICKET_FORFEIT', 'TICKET_RETURN', 'FAST_MINI_KILL', 'FAST_MINI_CLOSE']);
    check(S, 'payout amounts valid (integer µUSD ≥ 0, money items > 0, known players)', items.every((i) => Number.isInteger(Number(i.amountMicroUsd)) && Number(i.amountMicroUsd) >= 0 && (zeroOk.has(i.actionType) || Number(i.amountMicroUsd) > 0)) && strangers.length === 0);
    return wave;
  }

  async function freePort() {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  }

  // ==============================================================================================
  // PART B — API security
  // ==============================================================================================
  async function partSecurity() {
    const API = OPT.api;
    const reachable = await fetch(API + '/api/auth/providers').then((r) => r.status < 500).catch(() => false);
    if (!reachable) {
      check('security', `api-worker reachable at ${API}`, false, 'start it with `npx wrangler dev` in apps/api-worker (or pass --skip-security)');
      return;
    }
    if (!OPT.d1Local) {
      note('security', 'PART B needs a local worker (account setup goes through `wrangler d1 execute --local`); skipped');
      return;
    }

    const tgSign = (d) => {
      const s = Object.keys(d)
        .sort()
        .map((k) => `${k}=${d[k]}`)
        .join('\n');
      const key = crypto.createHash('sha256').update(OPT.tgBotToken).digest();
      return { ...d, hash: crypto.createHmac('sha256', key).update(s).digest('hex') };
    };
    const call = async (pathname, { method = 'GET', token, body, headers = {}, form } = {}) => {
      const h = { ...headers };
      if (token) h.Authorization = `Bearer ${token}`;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      for (let i = 0; ; i++) {
        try {
          const r = await fetch(API + pathname, { method, headers: h, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
          const text = await r.text();
          let j = {};
          try {
            j = JSON.parse(text);
          } catch {}
          return { status: r.status, body: j };
        } catch (e) {
          if (i >= 3) throw e;
          await sleep(300);
        }
      }
    };
    const run = Date.now().toString(36);
    let tgSeq = Math.floor(Math.random() * 1e8) + 7e9;
    const signup = async (label) => {
      const d = tgSign({ id: tgSeq++, first_name: 'LoadTest', username: `lt${run}${label}`.slice(0, 32), auth_date: Math.floor(Date.now() / 1000) });
      const r = await call('/api/auth/oauth/telegram', { method: 'POST', body: d });
      if (!r.body?.token) throw new Error(`signup ${label} failed: ${r.status} ${JSON.stringify(r.body)}`);
      return { label, id: r.body.user.id, token: r.body.token };
    };
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const wranglerExecOpts = { cwd: OPT.workerDir, shell: process.platform === 'win32', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const sqlFile = (statements) => {
      const f = path.join(os.tmpdir(), `mwar-lt-${process.pid}-${Date.now()}.sql`);
      fs.writeFileSync(f, statements.join('\n'));
      try {
        const out = execFileSync(npxCmd, ['wrangler', 'd1', 'execute', 'core_db', '--local', '--persist-to', OPT.persistTo, '--json', '--file', f], wranglerExecOpts);
        return JSON.parse(out.slice(out.indexOf('[')));
      } finally {
        fs.rmSync(f, { force: true });
      }
    };
    const sqlQuery = (q) => {
      const out = execFileSync(npxCmd, ['wrangler', 'd1', 'execute', 'core_db', '--local', '--persist-to', OPT.persistTo, '--json', '--command', q], wranglerExecOpts);
      return JSON.parse(out.slice(out.indexOf('[')))[0].results;
    };

    console.log('\n── PART B: API security ──');
    const roles = ['user', 'moderator', 'support', 'finance_auditor', 'admin', 'super_admin'];
    const U = {};
    for (const r of roles) U[r] = await signup(r.replace('_', '').slice(0, 8));
    for (const l of ['wd', 'seller', 't1', 't2', 't3', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'x']) U[l] = await signup(l);
    check('security', 'test accounts created through Telegram sign-in', true, `${Object.keys(U).length} accounts`);

    const FUND = { wd: 25_000_000, b1: 5_000_000, b2: 5_000_000, b3: 5_000_000, b4: 5_000_000, b5: 5_000_000, b6: 5_000_000, x: 5_000_000 };
    const L1 = uuid();
    const L2 = uuid();
    const L3 = uuid();
    const now = Math.floor(Date.now() / 1000);
    const stmts = [];
    for (const r of roles) stmts.push(`UPDATE users SET staff_role = '${r}' WHERE id = '${U[r].id}';`);
    for (const [k, v] of Object.entries(FUND)) {
      stmts.push(`INSERT OR IGNORE INTO wallets (user_id, balance_micro_usd, updated_at) VALUES ('${U[k].id}', 0, ${now});`);
      // Credit + matching wallet_ledger row (Layer 1 compares the two)
      stmts.push(`INSERT INTO wallet_ledger (id, user_id, delta_micro_usd, action_type, ref_id, created_at) SELECT 'led_lt_${uuid()}', user_id, ${v} - balance_micro_usd, 'LOADTEST_FUND', 'load-test', ${now} FROM wallets WHERE user_id = '${U[k].id}';`);
      stmts.push(`UPDATE wallets SET balance_micro_usd = ${v} WHERE user_id = '${U[k].id}';`);
    }
    stmts.push(`INSERT INTO marketplace_listings (id, seller_id, target_user_id, price_micro_usd, status, created_at) VALUES ('${L1}', '${U.seller.id}', '${U.t1.id}', 5000000, 'active', ${now}), ('${L2}', '${U.seller.id}', '${U.t2.id}', 5000000, 'active', ${now}), ('${L3}', '${U.seller.id}', '${U.t3.id}', 5000000, 'active', ${now});`);
    sqlFile(stmts);

    // ---- B1. RBAC -----------------------------------------------------------------------------
    const superOnly = [
      ['GET', '/api/admin/staff'],
      ['GET', '/api/admin/staff/audit'],
      ['PATCH', '/api/admin/staff', { user_id: U.user.id, staff_role: 'super_admin' }],
      ['GET', '/api/admin/ads/config'],
      ['PUT', '/api/admin/ads/config', { ad_mode: 'live' }],
      ['GET', '/api/admin/ads/stats'],
      ['POST', '/api/audit/review', { withdrawal_id: uuid(), action: 'approve', reason: 'load-test' }],
      ['POST', `/api/audit/withdrawals/${uuid()}/rerun`, {}],
    ];
    for (const role of ['user', 'moderator', 'support', 'finance_auditor', 'admin']) {
      const got = [];
      for (const [method, p, body] of superOnly) got.push([`${method} ${p.replace(/[0-9a-f-]{36}/, ':id')}`, (await call(p, { method, token: U[role].token, body })).status]);
      const bad = got.filter(([, s]) => s !== 403);
      check('rbac', `${role} → 403 on all ${superOnly.length} super_admin endpoints`, bad.length === 0, bad.map(([e, s]) => `${e}=${s}`).join(', '));
    }
    const ctl = await call('/api/admin/staff', { token: U.super_admin.token });
    check('rbac', 'super_admin positive control → 200 on GET /api/admin/staff', ctl.status === 200, `${ctl.status}`);
    const anon = await call('/api/admin/staff');
    check('rbac', 'no token → 401', anon.status === 401, `${anon.status}`);
    const forged = await call('/api/admin/staff', { token: U.user.token.replace(/\.[^.]+$/, '.' + crypto.randomBytes(32).toString('base64url')) });
    check('rbac', 'tampered JWT signature → 401', forged.status === 401, `${forged.status}`);
    const roleNow = sqlQuery(`SELECT staff_role FROM users WHERE id = '${U.user.id}'`)[0]?.staff_role;
    check('rbac', 'privilege escalation attempt did not change the role', roleNow === 'user', roleNow);

    // ---- B2. wallet / marketplace races ---------------------------------------------------------
    const wd = await Promise.all(Array.from({ length: 10 }, () => call('/api/wallet/withdraw', { method: 'POST', token: U.wd.token, body: { amount_micro_usd: 10_000_000, payout_method: 'promptpay', payout_account: '0812345678' } })));
    const wdOk = wd.filter((r) => r.status === 201).length;
    const m1 = await Promise.all(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((b) => call('/api/marketplace/buy', { method: 'POST', token: U[b].token, body: { listing_id: L1 } })));
    const m1Ok = m1.filter((r) => r.status === 200 || r.status === 201).length;
    const m2 = await Promise.all([L2, L3, L2, L3, L2, L3].map((l) => call('/api/marketplace/buy', { method: 'POST', token: U.x.token, body: { listing_id: l } })));
    const m2Ok = m2.filter((r) => r.status === 200 || r.status === 201).length;
    const ids = Object.keys(FUND)
      .map((k) => `'${U[k].id}'`)
      .join(',');
    const rows = sqlFile([
      `SELECT w.user_id, w.balance_micro_usd AS bal, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = w.user_id) AS ledger FROM wallets w WHERE w.user_id IN (${ids});`,
      `SELECT id, status, buyer_id FROM marketplace_listings WHERE id IN ('${L1}','${L2}','${L3}');`,
      `SELECT COUNT(*) AS n FROM withdrawal_requests WHERE user_id = '${U.wd.id}';`,
      `SELECT COUNT(*) AS n FROM wallets WHERE balance_micro_usd < 0;`,
    ]);
    const bal = Object.fromEntries(rows[0].results.map((r) => [r.user_id, r]));
    const listings = Object.fromEntries(rows[1].results.map((r) => [r.id, r]));
    const wdCount = rows[2].results[0].n;
    const negatives = rows[3].results[0].n;
    const B = (k) => Number(bal[U[k].id]?.bal);
    check('race', '10 parallel $10 cashouts on a $25 wallet → exactly 2 accepted', wdOk === 2 && wdCount === 2 && B('wd') === 5_000_000, `${wdOk} × 201, ${wdCount} requests stored, balance ${B('wd')} µUSD; others: ${[...new Set(wd.filter((r) => r.status !== 201).map((r) => r.body?.code || r.status))].join(',')}`);
    const winner = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].find((b) => listings[L1]?.buyer_id === U[b].id);
    const losersUntouched = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].filter((b) => b !== winner).every((b) => B(b) === 5_000_000);
    check('race', '6 buyers race for one listing → one sale, only the winner pays', m1Ok === 1 && listings[L1]?.status === 'sold' && winner && B(winner) === 0 && losersUntouched, `${m1Ok} success, codes ${m1.map((r) => r.status).join(',')}`);
    const soldToX = [L2, L3].filter((l) => listings[l]?.status === 'sold' && listings[l]?.buyer_id === U.x.id).length;
    check('race', 'one buyer, money for one listing, 6 parallel buys of 2 listings → one purchase', m2Ok === 1 && soldToX === 1 && B('x') === 0, `${m2Ok} success, ${soldToX} sold, balance ${B('x')}`);
    check('race', 'no negative wallet balance anywhere', Number(negatives) === 0, `${negatives}`);
    const drift = Object.keys(FUND).filter((k) => Number(bal[U[k].id]?.bal) !== Number(bal[U[k].id]?.ledger));
    check('race', 'wallet_ledger still equals balance for every raced wallet (Layer 1)', drift.length === 0, drift.join(','));

    // ---- B3. OAuth state replay -------------------------------------------------------------------
    const init = await call('/api/auth/oauth/line/init', { method: 'POST', body: {} });
    if (init.status === 200 && init.body.state) {
      const st = init.body.state;
      const first = await call('/api/auth/oauth/line', { method: 'POST', body: { code: 'load-test-code', state: st } });
      const replay = await call('/api/auth/oauth/line', { method: 'POST', body: { code: 'load-test-code', state: st } });
      check('oauth', 'LINE state is single use (replay → 400 OAUTH_STATE_INVALID)', replay.status === 400 && replay.body.code === 'OAUTH_STATE_INVALID', `first ${first.status}/${first.body.code || ''}, replay ${replay.status}/${replay.body.code || ''}`);
      const init2 = await call('/api/auth/oauth/line/init', { method: 'POST', body: {} });
      const par = await Promise.all(Array.from({ length: 6 }, () => call('/api/auth/oauth/line', { method: 'POST', body: { code: 'load-test-code', state: init2.body.state } })));
      const passed = par.filter((r) => r.body.code !== 'OAUTH_STATE_INVALID').length;
      check('oauth', '6 parallel uses of one LINE state → at most 1 gets past the state check', passed <= 1, `${passed} past the state check`);
      const unknown = await call('/api/auth/oauth/line', { method: 'POST', body: { code: 'x', state: crypto.randomBytes(32).toString('base64url') } });
      check('oauth', 'unknown LINE state → 400 OAUTH_STATE_INVALID', unknown.status === 400 && unknown.body.code === 'OAUTH_STATE_INVALID', `${unknown.status}`);
    } else note('oauth', `LINE not configured on this worker (${init.status}); LINE state checks skipped`);
    const stale = await call('/api/auth/oauth/telegram', { method: 'POST', body: tgSign({ id: tgSeq++, first_name: 'Old', auth_date: Math.floor(Date.now() / 1000) - 3 * 86400 }) });
    check('oauth', 'stale Telegram login (3 days old, valid hash) → 401', stale.status === 401, `${stale.status}`);
    const tampered = tgSign({ id: tgSeq++, first_name: 'Tamper', auth_date: Math.floor(Date.now() / 1000) });
    const tam = await call('/api/auth/oauth/telegram', { method: 'POST', body: { ...tampered, id: tampered.id + 1 } });
    check('oauth', 'tampered Telegram payload (id changed after signing) → 401', tam.status === 401, `${tam.status}`);
    const exch = await call('/api/auth/oauth/telegram/bot-exchange', { method: 'POST', body: { token: crypto.randomBytes(24).toString('base64url') } });
    check('oauth', 'unknown Telegram bot-exchange token → 400', exch.status === 400, `${exch.status}`);

    // ---- B4. Monetag S2S postback secret ------------------------------------------------------------
    const pb = '/api/ads/postback/monetag';
    const qs = (o) => '?' + new URLSearchParams(o).toString();
    const base = { ymid: U.user.id, estimated_price: '0.002', zone_id: 'lt', click_id: `lt_${run}_1` };
    const noSecret = await call(pb + qs(base));
    const wrongQ = await call(pb + qs({ ...base, secret: 'wrong' }));
    const wrongH = await call(pb + qs(base), { headers: { 'X-Postback-Secret': 'wrong' } });
    const okQ = await call(pb + qs({ ...base, secret: OPT.postbackSecret }));
    const dupe = await call(pb + qs({ ...base, secret: OPT.postbackSecret }));
    const okH = await call(pb + qs({ ...base, click_id: `lt_${run}_2` }), { method: 'POST', headers: { 'X-Postback-Secret': OPT.postbackSecret } });
    check('postback', 'no secret → 403', noSecret.status === 403, `${noSecret.status}`);
    check('postback', 'wrong secret (query / header) → 403', wrongQ.status === 403 && wrongH.status === 403, `${wrongQ.status}/${wrongH.status}`);
    check('postback', 'right secret (query / header) → 200', okQ.status === 200 && okH.status === 200, `${okQ.status}/${okH.status} ${JSON.stringify(okQ.body).slice(0, 80)}`);
    check('postback', 'replayed postback (same click_id) is not credited twice', dupe.status === 200 && dupe.body.duplicate === true, JSON.stringify(dupe.body).slice(0, 80));

    // ---- B5. Layer-2 media gate ------------------------------------------------------------------------
    const upload = async (bytes, name, type) => {
      const fd = new FormData();
      fd.set('attemptId', crypto.randomBytes(8).toString('hex'));
      fd.set('file', new Blob([bytes], { type }), name);
      return call('/api/social/uploads', { method: 'POST', token: U.user.token, form: fd });
    };
    const jpeg = (size) => {
      const b = crypto.randomBytes(size);
      b[0] = 0xff;
      b[1] = 0xd8;
      b[2] = 0xff;
      return b;
    };
    const big = await upload(jpeg(400 * 1024), 'big.jpg', 'image/jpeg');
    check('media', 'photo 400 KB (> 300 KB device limit bypassed) → 422 MEDIA_GATE', big.status === 422 && big.body.code === 'MEDIA_GATE', `${big.status} ${big.body.code || ''}`);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), crypto.randomBytes(64 * 1024)]);
    const vid = await upload(mp4, 'clip.mp4', 'video/mp4');
    check('media', 'video without readable duration / size → 422 MEDIA_GATE', vid.status === 422 && vid.body.code === 'MEDIA_GATE', `${vid.status} ${vid.body.code || ''}`);
    const small = await upload(jpeg(20 * 1024), 'ok.jpg', 'image/jpeg');
    check('media', 'positive control: 20 KB photo accepted', small.status >= 200 && small.status < 300, `${small.status}`);

    // ---- B6. V1.1 zero-deficit ticket economy ------------------------------------------------------
    await ticketEconomy({ call, signup, sqlFile, sqlQuery, run });
    // ---- B7. V1.1 R2: re-stake, Fast & Mini pot, offline room hiding ------------------------------
    await roundTwo({ call, signup, sqlFile, sqlQuery });

    note('security', `test accounts use usernames lt${run}* in the LOCAL D1 only`);
  }

  let hbTimer = null;
  /** PART B6 — tickets, payouts and cheers against the local worker (D1 checked directly). */
  async function ticketEconomy({ call, signup, sqlFile, sqlQuery, run }) {
    const S = 'tickets';
    const q1 = (sql) => sqlQuery(sql)[0] || {};
    const K = await signup('tk_killer');
    const Vc = await signup('tk_victim');
    const X = await signup('tk_other');
    const Sc = await signup('tk_selfcheer');
    // R2: /api/game/enter refuses entry while no game server is online → register a fresh heartbeat first
    await call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${OPT.internalSecret}` }, body: { nodeId: `lt-node-${process.pid}`, role: 'game' } });
    // Keep it fresh (≤ 90 s window) while the slow `wrangler d1 execute` steps run; B7 stops it for the offline check
    hbTimer = setInterval(() => {
      call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${OPT.internalSecret}` }, body: { nodeId: `lt-node-${process.pid}`, role: 'game' } }).catch(() => {});
    }, 20_000);

    // 1. sign-up: exactly one 0-backed promo ticket
    const st = q1(`SELECT COUNT(*) AS n, COALESCE(SUM(backed_micro_usd),0) AS v, MIN(source_type) AS src FROM user_energy_tickets WHERE user_id = '${Vc.id}' AND status = 'available'`);
    check(S, 'sign-up starter EC = one 0-backed signup_promo ticket', Number(st.n) === 1 && Number(st.v) === 0 && st.src === 'signup_promo', JSON.stringify(st));

    // 2. pool-backed mint: progress 95 % + 2 simulated banners crosses 100 % → ticket backed from the pool
    const pool0 = q1("SELECT energy_pool_micro_usd AS p, energy_pool_drawn_micro_usd AS d FROM system_balances WHERE id = 'global'");
    const now = Math.floor(Date.now() / 1000);
    sqlFile([
      `UPDATE system_balances SET energy_pool_micro_usd = energy_pool_micro_usd + 1000000 WHERE id = 'global';`,
      `UPDATE users SET energy_progress_bp = 9500, energy_progress_pct = 95, pending_ec_micro_usd = 0 WHERE id = '${Vc.id}';`,
    ]);
    const poolA = q1("SELECT energy_pool_micro_usd AS p, energy_pool_drawn_micro_usd AS d FROM system_balances WHERE id = 'global'");
    const ban = await call('/api/ads/simulate-view', { method: 'POST', token: Vc.token, body: { format: 'banner', purpose: 'ec_recharge', count: 2, lastActiveAt: Date.now(), clientNow: Date.now() } });
    const minted = sqlQuery(`SELECT backed_micro_usd AS v, source_type AS src FROM user_energy_tickets WHERE user_id = '${Vc.id}' AND status = 'available' ORDER BY created_at, id`);
    const uV = q1(`SELECT pending_ec_micro_usd AS pending, energy_tickets AS n FROM users WHERE id = '${Vc.id}'`);
    const poolB = q1("SELECT energy_pool_micro_usd AS p, energy_pool_drawn_micro_usd AS d FROM system_balances WHERE id = 'global'");
    const drawn = Number(poolB.d) - Number(poolA.d);
    const mintedV = minted.reduce((a, r) => a + Number(r.v), 0);
    const safeEach = Math.floor((Number(ban.body.adValueMicroUsd) * 9200) / 10000);
    check(
      S,
      'simulated ad: EC backing drawn from the Energy Pool = floor(gross × 0.92) × 2, minted ticket + pending = drawn',
      ban.status === 200 && ban.body.ticketsAwarded === 1 && drawn === safeEach * 2 && mintedV + Number(uV.pending) === drawn && Number(uV.n) === 2,
      `HTTP ${ban.status} · gross ${ban.body.adValueMicroUsd}/banner (${ban.body.country}) · drawn ${drawn} · tickets ${minted.map((r) => r.v).join('+')} · pending ${uV.pending}`
    );
    check(S, 'Energy Pool never overdrawn (pool − drawn ≥ 0)', Number(poolB.p) - Number(poolB.d) >= 0, `pool ${poolB.p} drawn ${poolB.d} (before test: ${pool0.p}/${pool0.d})`);

    // 3. entry: FIFO lock, the token carries the ticket id + value
    const decode = (tok) => JSON.parse(Buffer.from(String(tok).split('.')[0], 'base64url').toString('utf8'));
    const e1 = await call('/api/game/enter', { method: 'POST', token: Vc.token, body: { mode: 'mini_30' } });
    const t1 = e1.body.entryToken ? decode(e1.body.entryToken) : {};
    const e2 = await call('/api/game/enter', { method: 'POST', token: Vc.token, body: { mode: 'mini_30' } });
    const t2 = e2.body.entryToken ? decode(e2.body.entryToken) : {};
    const e3 = await call('/api/game/enter', { method: 'POST', token: Vc.token, body: { mode: 'mini_30' } });
    check(S, 'entry #1 locks the oldest ticket (the 0-backed promo) and signs its value', e1.status === 200 && /^tkt_/.test(t1.tid) && t1.tv === 0, `HTTP ${e1.status} tid ${t1.tid} tv ${t1.tv}`);
    check(S, 'entry #2 locks the minted ticket: token tv = its backed µUSD', e2.status === 200 && t2.tv === Number(minted[minted.length - 1]?.v) && t2.tv > 0, `tv ${t2.tv}`);
    check(S, 'no ticket left → 402 NO_EC', e3.status === 402 && e3.body.code === 'NO_EC', `${e3.status}`);
    const st2 = q1(`SELECT status, match_id FROM user_energy_tickets WHERE id = '${t2.tid}'`);
    check(S, 'locked ticket is in_match with the entry id', st2.status === 'in_match' && st2.match_id === t2.eid, JSON.stringify(st2));
    const eK = await call('/api/game/enter', { method: 'POST', token: K.token, body: { mode: 'mini_30' } }); // the killer has entered too
    const tK = eK.body.entryToken ? decode(eK.body.entryToken) : {};

    // 4. batch payouts: V = the victim's ticket, never the game server's amount; exactly once
    const gameId = `game_lt_${run}`;
    const batch = (payouts) => call('/api/game/batch-payout', { method: 'POST', body: { gameId, timestamp: Math.floor(Date.now() / 1000), secret: OPT.internalSecret, payouts } });
    const wallet = (id) => q1(`SELECT w.balance_micro_usd AS bal, w.bounty_micro_usd AS bty, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = w.user_id) AS ledger FROM wallets w WHERE w.user_id = '${id}'`);
    const sys0 = q1("SELECT platform_micro_usd AS pl, energy_pool_micro_usd AS p FROM system_balances WHERE id = 'global'");
    const kill = { userId: K.id, amountMicroUsd: 100_000, actionType: 'GAME_KILL', gameId, metadata: { victimId: Vc.id, ticketId: t2.tid, pid: `${gameId}:1` } };
    const r1 = await batch([kill]);
    const w1 = wallet(K.id);
    const tkt = q1(`SELECT status, settle_action, settled_to_user_id AS to_id, settled_micro_usd AS paid FROM user_energy_tickets WHERE id = '${t2.tid}'`);
    const sys1 = q1("SELECT platform_micro_usd AS pl, energy_pool_micro_usd AS p FROM system_balances WHERE id = 'global'");
    check(
      S,
      'GAME_KILL claiming 100,000 µUSD pays only the victim ticket: shooter = 55 % of V (0.007 C rounding)',
      r1.status === 200 && r1.body.ticketsSettled === 1 && Number(w1.bal) === earnerShare(t2.tv) && Number(tkt.paid) === t2.tv && tkt.status === 'settled' && tkt.to_id === K.id,
      `HTTP ${r1.status} · V ${t2.tv} · shooter +${w1.bal} (expected ${earnerShare(t2.tv)}) · ticket ${tkt.status}/${tkt.settle_action}`
    );
    const credited = Number(w1.bal) + Number(w1.bty) + (Number(sys1.pl) - Number(sys0.pl)) + (Number(sys1.p) - Number(sys0.p));
    check(S, 'split conservation: shooter + bounty + platform + pool (+ uplines 0) === V', credited === t2.tv, `${credited} vs ${t2.tv}`);
    const r2 = await batch([kill]);
    const r3 = await Promise.all(Array.from({ length: 5 }, () => batch([{ ...kill, metadata: { ...kill.metadata, pid: undefined } }])));
    const w2 = wallet(K.id);
    check(S, 're-sent + 5 parallel copies of the batch never pay twice', r2.status === 200 && r2.body.duplicates === 1 && r3.every((r) => r.status === 200) && Number(w2.bal) === Number(w1.bal), `balance ${w1.bal} → ${w2.bal}; dup ${r2.body.duplicates}`);
    check(S, 'wallet_ledger equals balance after ticket payouts (Layer 1)', Number(w2.bal) === Number(w2.ledger), `${w2.bal} vs ${w2.ledger}`);

    // 5. wrong owner / killer without entry / unknown ticket → rejected; forfeit → platform once
    const eX = await call('/api/game/enter', { method: 'POST', token: X.token, body: { mode: 'mini_30' } });
    const tX = eX.body.entryToken ? decode(eX.body.entryToken) : {};
    const wrong = await batch([
      { userId: K.id, amountMicroUsd: 5000, actionType: 'GAME_KILL', gameId, metadata: { victimId: Vc.id, ticketId: tX.tid, pid: `${gameId}:w1` } }, // ticket of X, not of the victim
      { userId: Sc.id, amountMicroUsd: 5000, actionType: 'GAME_KILL', gameId, metadata: { victimId: X.id, ticketId: tX.tid, pid: `${gameId}:w2` } }, // earner never entered a paid arena
      { userId: K.id, amountMicroUsd: 5000, actionType: 'GAME_KILL', gameId, metadata: { victimId: X.id, ticketId: `tkt_${uuid()}`, pid: `${gameId}:w3` } }, // unknown ticket
      { userId: K.id, amountMicroUsd: 5000, actionType: 'BOUNTY_CLAIM', gameId, metadata: { victimId: X.id, pid: `${gameId}:w4` } }, // no ticket named
      { userId: K.id, amountMicroUsd: 5000, actionType: 'AD_WATCH', gameId, metadata: {} }, // never from a game server
    ]);
    const w3 = wallet(K.id);
    check(S, 'wrong-owner / no-entry / unknown-ticket / ticketless bounty / AD_WATCH items pay nothing', wrong.status === 200 && wrong.body.ticketsSettled === 0 && Number(w3.bal) === Number(w2.bal) && Number(wallet(Sc.id).bal) === 0, `rejected ${wrong.body.rejectedTicket} + ${wrong.body.rejectedItems} · balance ${w3.bal}`);
    const fz = await batch([{ userId: X.id, amountMicroUsd: 0, actionType: 'TICKET_FORFEIT', gameId, metadata: { ticketId: tX.tid, reason: 'left', pid: `${gameId}:f1` } }]);
    const fz2 = await batch([{ userId: X.id, amountMicroUsd: 0, actionType: 'TICKET_FORFEIT', gameId, metadata: { ticketId: tX.tid, reason: 'left', pid: `${gameId}:f2` } }]);
    const tXs = q1(`SELECT status, settle_action FROM user_energy_tickets WHERE id = '${tX.tid}'`);
    check(S, 'TICKET_FORFEIT (left alive) closes the ticket once — never refunded', fz.body.ticketsForfeited === 1 && fz2.body.duplicates === 1 && tXs.status === 'settled' && String(tXs.settle_action).startsWith('TICKET_FORFEIT'), JSON.stringify(tXs));
    const late = await batch([{ userId: K.id, amountMicroUsd: 5000, actionType: 'GAME_KILL', gameId, metadata: { victimId: X.id, ticketId: tX.tid, pid: `${gameId}:w5` } }]);
    check(S, 'a kill on an already-forfeited ticket pays nothing', late.body.ticketsSettled === 0 && Number(wallet(K.id).bal) === Number(w2.bal));
    void tK;

    // 6. self-cheer → 400 (post / profile / direct link); cheering someone else still works
    const selfP = await call('/api/ads/cheer/start', { method: 'POST', token: Sc.token, body: { format: 'video_30s', targetType: 'profile', targetId: Sc.id } });
    const selfDl = await call('/api/ads/direct-link/start', { method: 'POST', token: Sc.token, body: { purpose: 'cheer', seconds: 30, targetType: 'profile', targetId: Sc.id } });
    const other = await call('/api/ads/cheer/start', { method: 'POST', token: Sc.token, body: { format: 'video_30s', targetType: 'profile', targetId: X.id } });
    check(S, 'self-cheer rejected with 400 (cheer/start + direct-link/start)', selfP.status === 400 && selfP.body.code === 'SELF_CHEER' && selfDl.status === 400 && selfDl.body.code === 'SELF_CHEER', `${selfP.status}/${selfP.body.code} · ${selfDl.status}/${selfDl.body.code}`);
    check(S, 'positive control: cheering another creator starts (200)', other.status === 200 && /^cheer_/.test(other.body.viewId || ''), `${other.status}`);
    const forged = await call('/api/ads/cheer', { method: 'POST', token: Sc.token, body: { viewId: other.body.viewId } });
    check(S, 'claiming a cheer before the ad ends → 425 (no EC, no money)', forged.status === 425, `${forged.status}`);
    const poolEnd = q1("SELECT energy_pool_micro_usd AS p, energy_pool_drawn_micro_usd AS d FROM system_balances WHERE id = 'global'");
    check(S, 'Energy Pool still never overdrawn at the end', Number(poolEnd.p) - Number(poolEnd.d) >= 0, `pool ${poolEnd.p} drawn ${poolEnd.d}`);
  }

  /**
   * PART B7 — V1.1 Round 2 against the local worker: "Play again (-1 EC)" re-stake chain, 0 EC, TICKET_RETURN,
   * Fast & Mini (0 EC entry, banner pot split, 90 / 10 kill from the victim's own pot, forfeit on close) and
   * offline room hiding (game_nodes heartbeat ≤ 90 s).
   */
  async function roundTwo({ call, signup, sqlFile, sqlQuery }) {
    const S = 'round2';
    const q1 = (sql) => sqlQuery(sql)[0] || {};
    const decode = (tok) => JSON.parse(Buffer.from(String(tok).split('.')[0], 'base64url').toString('utf8'));
    const fmShooter = (v) => {
      const n = BigInt(v) * 9000n;
      let s = n % 10000n >= 7000n ? n / 10000n + 1n : n / 10000n;
      const cap = BigInt(v) - BigInt(v) / 10n;
      if (s > cap) s = cap;
      return Number(s);
    };
    const heartbeat = (nodeId) =>
      call('/api/nodes/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${OPT.internalSecret}` }, body: { nodeId, nodeName: nodeId, role: 'game', activeRooms: 1, playerCount: 0 } });
    const nodeId = `lt-node-${process.pid}`;
    const hb = await heartbeat(nodeId);
    const on = await call('/api/games/fps/rooms');
    check(S, 'fresh game_nodes heartbeat (role game) → gameServersOnline true', hb.status === 200 && on.status === 200 && on.body.gameServersOnline === true, `heartbeat ${hb.status} · rooms ${on.status} online=${on.body.gameServersOnline}`);
    check(S, 'Fast & Mini room is listed at 0 EC', (on.body.rooms || []).filter((r) => r.mode === 'fast_mini' || r.id === 'TH-03').every((r) => r.costEc === 0), JSON.stringify((on.body.rooms || []).map((r) => `${r.id}:${r.costEc}`)));

    // ---- Re-stake chain ----------------------------------------------------------------------------
    const R = await signup('r2_restake');
    const O = await signup('r2_other');
    const now = Math.floor(Date.now() / 1000);
    sqlFile([
      `INSERT INTO user_energy_tickets (id, user_id, source_type, backed_micro_usd, status, created_at) VALUES ('tkt_${uuid()}', '${R.id}', 'admin_grant', 700, 'available', ${now + 1}), ('tkt_${uuid()}', '${R.id}', 'admin_grant', 900, 'available', ${now + 2});`,
      `UPDATE users SET energy_tickets = (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = '${R.id}' AND status = 'available') WHERE id = '${R.id}';`,
    ]);
    const avail = (id) => Number(q1(`SELECT COUNT(*) AS n FROM user_energy_tickets WHERE user_id = '${id}' AND status = 'available'`).n);
    const inMatch = (id) => Number(q1(`SELECT COUNT(*) AS n FROM user_energy_tickets WHERE user_id = '${id}' AND status = 'in_match'`).n);
    const a0 = await call('/api/game/enter', { method: 'POST', token: R.token, body: { mode: 'mini_30' } });
    const A = a0.body.entryId;
    const tA = a0.body.entryToken ? decode(a0.body.entryToken) : {};
    check(S, 'paid entry returns entryId (= token eid)', a0.status === 200 && typeof A === 'string' && tA.eid === A, `HTTP ${a0.status} entry ${A}`);
    const r1 = await call('/api/game/enter', { method: 'POST', token: R.token, body: { mode: 'mini_30', restakeAfter: A } });
    const t1 = r1.body.entryToken ? decode(r1.body.entryToken) : {};
    check(S, '"Play again (-1 EC)" locks a NEW ticket with a fresh signed token (new eid, rs flag)', r1.status === 200 && r1.body.restake === true && t1.eid && t1.eid !== A && t1.tid && t1.tid !== tA.tid && t1.rs === 1, `HTTP ${r1.status} eid ${t1.eid} tid ${t1.tid} rs ${t1.rs}`);
    const r1b = await call('/api/game/enter', { method: 'POST', token: R.token, body: { mode: 'mini_30', restakeAfter: A } });
    const t1b = r1b.body.entryToken ? decode(r1b.body.entryToken) : {};
    check(S, 'retrying the same death re-signs the SAME successor (idempotent, no second ticket)', r1b.status === 200 && r1b.body.reissued === true && t1b.eid === t1.eid && t1b.tid === t1.tid && inMatch(R.id) === 2 && avail(R.id) === 1, `HTTP ${r1b.status} · in_match ${inMatch(R.id)} · available ${avail(R.id)}`);
    const B = t1.eid;
    const par = await Promise.all(Array.from({ length: 5 }, () => call('/api/game/enter', { method: 'POST', token: R.token, body: { mode: 'mini_30', restakeAfter: B } })));
    const okEids = new Set(par.filter((r) => r.status === 200).map((r) => decode(r.body.entryToken).eid));
    check(S, '5 parallel re-stakes of one death → exactly one successor / one ticket (others 409 or re-signed)', okEids.size === 1 && par.every((r) => r.status === 200 || (r.status === 409 && r.body.code === 'ALREADY_RESTAKED')) && inMatch(R.id) === 3 && avail(R.id) === 0, `statuses ${par.map((r) => r.status).join(',')} · successors ${okEids.size} · in_match ${inMatch(R.id)}`);
    const C = [...okEids][0];
    const tC = decode(par.find((r) => r.status === 200).body.entryToken);
    const r0 = await call('/api/game/enter', { method: 'POST', token: R.token, body: { mode: 'mini_30', restakeAfter: C } });
    const leftover = Number(q1(`SELECT COUNT(*) AS n FROM arena_entries WHERE prev_entry_id = '${C}'`).n);
    check(S, '0 EC → 402 NO_EC and the successor slot is released (no free paid life)', r0.status === 402 && r0.body.code === 'NO_EC' && r0.body.energyTickets === 0 && leftover === 0, `HTTP ${r0.status} ${r0.body.code} · slots ${leftover}`);
    const foreign = await call('/api/game/enter', { method: 'POST', token: O.token, body: { mode: 'mini_30', restakeAfter: C } });
    const wrongRoom = await call('/api/game/enter', { method: 'POST', token: R.token, body: { mode: 'standard_100', restakeAfter: B } });
    check(S, "re-staking another account's entry / another room → 400 RESTAKE_INVALID", foreign.status === 400 && foreign.body.code === 'RESTAKE_INVALID' && wrongRoom.status === 400 && wrongRoom.body.code === 'RESTAKE_INVALID', `${foreign.status}/${foreign.body.code} · ${wrongRoom.status}/${wrongRoom.body.code}`);
    const gameId = `game_lt_r2_${process.pid}`;
    const batch = (payouts) => call('/api/game/batch-payout', { method: 'POST', body: { gameId, timestamp: Math.floor(Date.now() / 1000), secret: OPT.internalSecret, payouts } });
    const ret = await batch([{ userId: R.id, amountMicroUsd: 0, actionType: 'TICKET_RETURN', gameId, metadata: { ticketId: tC.tid, entryId: C, reason: 'not_dead', pid: `${gameId}:ret1` } }]);
    const ret2 = await batch([{ userId: R.id, amountMicroUsd: 0, actionType: 'TICKET_RETURN', gameId, metadata: { ticketId: tC.tid, entryId: C, reason: 'not_dead', pid: `${gameId}:ret2` } }]);
    const retWrong = await batch([{ userId: R.id, amountMicroUsd: 0, actionType: 'TICKET_RETURN', gameId, metadata: { ticketId: t1.tid, entryId: A, reason: 'not_dead', pid: `${gameId}:ret3` } }]);
    const uR = q1(`SELECT energy_tickets AS n FROM users WHERE id = '${R.id}'`);
    check(S, 'TICKET_RETURN (unusable re-stake token) puts the ticket back to available exactly once', ret.body.ticketsReturned === 1 && ret2.body.ticketsReturned === 0 && retWrong.body.ticketsReturned === 0 && avail(R.id) === 1 && Number(uR.n) === 1 && Number(q1(`SELECT COUNT(*) AS n FROM arena_entries WHERE id = '${C}'`).n) === 0, `returned ${ret.body.ticketsReturned}/${ret2.body.ticketsReturned}/${retWrong.body.ticketsReturned} · available ${avail(R.id)} · users.energy_tickets ${uR.n}`);

    // ---- Fast & Mini ---------------------------------------------------------------------------------
    const F1 = await signup('r2_fm_victim');
    const F2 = await signup('r2_fm_killer');
    const F3 = await signup('r2_fm_noseat');
    sqlFile([`UPDATE system_balances SET energy_pool_micro_usd = energy_pool_micro_usd + 2000000 WHERE id = 'global';`]);
    const ec1 = avail(F1.id);
    const f1 = await call('/api/game/enter', { method: 'POST', token: F1.token, body: { mode: 'fast_mini' } });
    const f2 = await call('/api/game/enter', { method: 'POST', token: F2.token, body: { mode: 'fast_mini' } });
    const tf1 = f1.body.entryToken ? decode(f1.body.entryToken) : {};
    check(S, 'Fast & Mini entry: 0 EC, no ticket, signed fm token, a pot opened for this entry', f1.status === 200 && f1.body.fastMini === true && tf1.fm === 1 && !tf1.tid && avail(F1.id) === ec1 && inMatch(F1.id) === 0 && f1.body.potId === f1.body.entryId && q1(`SELECT status FROM fast_mini_pots WHERE id = '${f1.body.potId}'`).status === 'open', `HTTP ${f1.status} fm ${tf1.fm} tid ${tf1.tid} · EC ${ec1} → ${avail(F1.id)}`);
    const P1 = f1.body.potId;
    const P2 = f2.body.potId;
    const pool = () => q1("SELECT energy_pool_micro_usd AS p, energy_pool_drawn_micro_usd AS d, platform_micro_usd AS pl FROM system_balances WHERE id = 'global'");
    const ban = (u, potId) => call('/api/ads/simulate-view', { method: 'POST', token: u.token, body: { format: 'banner', purpose: 'ec_recharge', count: 1, fastMiniEntryId: potId, lastActiveAt: Date.now(), clientNow: Date.now() } });
    const pl0 = pool();
    const b1 = await ban(F1, P1);
    const pl1 = pool();
    const safe1 = Math.floor((Number(b1.body.adValueMicroUsd) * 9200) / 10000);
    const cr1 = q1(`SELECT COALESCE(SUM(micro_usd),0) AS pot, COALESCE(SUM(ec_micro_usd),0) AS ec FROM fast_mini_pot_credits WHERE pot_id = '${P1}'`);
    const drawn1 = Number(pl1.d) - Number(pl0.d);
    check(
      S,
      'banner with fastMiniEntryId: safe value split ONCE — pot 50 % + EC backing 50 % = drawn (no double use)',
      b1.status === 200 && Number(cr1.pot) === Math.floor(safe1 / 2) && Number(b1.body.fastMiniPotAddedMicroUsd) === Number(cr1.pot) && Number(cr1.pot) + Number(cr1.ec) === safe1 && drawn1 === safe1,
      `gross ${b1.body.adValueMicroUsd} · safe ${safe1} · pot ${cr1.pot} · EC ${cr1.ec} · pool drawn ${drawn1} · EC% +${b1.body.ecProgressAddedPct}`
    );
    const b1b = await ban(F1, P1);
    const V = Number(q1(`SELECT COALESCE(SUM(micro_usd),0) AS v FROM fast_mini_pot_credits WHERE pot_id = '${P1}' AND status = 'open'`).v);
    // A 2nd banner right away may be refused by the 30–45 s banner gate; either way the pot = the sum of its open credits
    const added2 = b1b.status === 200 ? Number(b1b.body.fastMiniPotAddedMicroUsd ?? 0) : 0;
    check(S, 'pot total = sum of its own open banner credits (banner gate still applies)', V > 0 && V === Number(cr1.pot) + added2 && (added2 === 0 || Number(b1b.body.fastMiniPotMicroUsd) === V), `pot ${V} · 2nd banner HTTP ${b1b.status} +${added2}`);
    const foreignPot = await ban(F3, P1);
    check(S, "a banner naming someone else's pot never funds it", Number(foreignPot.body.fastMiniPotAddedMicroUsd) === 0 && Number(q1(`SELECT COALESCE(SUM(micro_usd),0) AS v FROM fast_mini_pot_credits WHERE pot_id = '${P1}'`).v) === V, `added ${foreignPot.body.fastMiniPotAddedMicroUsd}`);

    const wallet = (id) => q1(`SELECT COALESCE(w.balance_micro_usd,0) AS bal, (SELECT COALESCE(SUM(delta_micro_usd),0) FROM wallet_ledger l WHERE l.user_id = '${id}') AS ledger FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = '${id}'`);
    const wK0 = wallet(F2.id);
    const sysA = pool();
    const diedAt = Date.now() + 5000;
    const kill = { userId: F2.id, amountMicroUsd: 999_999, actionType: 'FAST_MINI_KILL', gameId, metadata: { victimId: F1.id, potId: P1, diedAt, pid: `${gameId}:fm1`, hits: 4, headshots: 1 } };
    const k1 = await batch([kill]);
    const wK1 = wallet(F2.id);
    const sysB = pool();
    const fm = (k1.body.fastMini || [])[0] || {};
    const shooter = Number(wK1.bal) - Number(wK0.bal);
    const plat = Number(sysB.pl) - Number(sysA.pl);
    check(
      S,
      'FAST_MINI_KILL claiming 999,999 µUSD pays only the victim pot V: shooter 90 % / platform 10 % (sum = V)',
      k1.status === 200 && fm.status === 'paid' && fm.valueMicroUsd === V && shooter === fmShooter(V) && plat === V - fmShooter(V) && plat >= Math.floor(V / 10),
      `V ${V} · shooter +${shooter} (expected ${fmShooter(V)}) · platform +${plat}`
    );
    check(S, 'Fast & Mini kill: 0 % MLM, 0 % bounty, 0 % Energy Pool (pool untouched)', Number(sysB.p) === Number(sysA.p) && Number(sysB.d) === Number(sysA.d), `pool ${sysA.p}/${sysA.d} → ${sysB.p}/${sysB.d}`);
    check(S, 'wallet_ledger equals balance after the Fast & Mini payout', Number(wK1.bal) === Number(wK1.ledger), `${wK1.bal} vs ${wK1.ledger}`);
    const k2 = await batch([kill]);
    const k3 = await batch([{ ...kill, metadata: { ...kill.metadata, pid: `${gameId}:fm2` } }]);
    const k4 = await batch([{ ...kill, userId: F3.id, metadata: { ...kill.metadata, pid: `${gameId}:fm3` } }]);
    const k5 = await batch([{ ...kill, userId: F1.id, metadata: { ...kill.metadata, victimId: F1.id, pid: `${gameId}:fm4` } }]);
    check(
      S,
      'duplicate pid / second kill on an emptied pot / killer without a seat / self-kill pay nothing',
      k2.body.duplicates >= 1 && ((k3.body.fastMini || [])[0] || {}).status === 'empty' && (k4.body.fastMiniKills ?? 0) === 0 && (k5.body.fastMiniKills ?? 0) === 0 && Number(wallet(F2.id).bal) === Number(wK1.bal) && Number(wallet(F3.id).bal) === 0,
      `dup ${k2.body.duplicates} · second ${((k3.body.fastMini || [])[0] || {}).status} · noseat ${k4.body.fastMiniKills} · self ${k5.body.fastMiniKills}`
    );
    // Credits earned AFTER the death fund the next life, not the killer of the earlier death
    const b2 = await ban(F2, P2);
    const V2 = Number(q1(`SELECT COALESCE(SUM(micro_usd),0) AS v FROM fast_mini_pot_credits WHERE pot_id = '${P2}' AND status = 'open'`).v);
    const early = await batch([{ userId: F1.id, amountMicroUsd: 0, actionType: 'FAST_MINI_KILL', gameId, metadata: { victimId: F2.id, potId: P2, diedAt: Date.now() - 120_000, pid: `${gameId}:fm5` } }]);
    check(S, 'credits created after the death time are not paid for that death', b2.status === 200 && V2 > 0 && ((early.body.fastMini || [])[0] || {}).status === 'empty', `pot ${V2} · ${((early.body.fastMini || [])[0] || {}).status}`);
    const sysC = pool();
    const c1 = await batch([{ userId: F2.id, amountMicroUsd: 0, actionType: 'FAST_MINI_CLOSE', gameId, metadata: { potId: P2, reason: 'left', pid: `${gameId}:c1` } }]);
    const c2 = await batch([{ userId: F2.id, amountMicroUsd: 0, actionType: 'FAST_MINI_CLOSE', gameId, metadata: { potId: P2, reason: 'left', pid: `${gameId}:c2` } }]);
    const sysD = pool();
    check(S, 'FAST_MINI_CLOSE forfeits the open pot to the platform exactly once', c1.body.fastMiniPotsClosed === 1 && c1.body.fastMiniForfeitedMicroUsd === V2 && Number(sysD.pl) - Number(sysC.pl) === V2 && (c2.body.fastMiniPotsClosed ?? 0) === 0, `closed ${c1.body.fastMiniPotsClosed}/${c2.body.fastMiniPotsClosed} · forfeited ${c1.body.fastMiniForfeitedMicroUsd} (pot ${V2}) · platform +${Number(sysD.pl) - Number(sysC.pl)}`);
    const afterClose = await ban(F2, P2);
    const lateKill = await batch([{ userId: F1.id, amountMicroUsd: 0, actionType: 'FAST_MINI_KILL', gameId, metadata: { victimId: F2.id, potId: P2, diedAt: Date.now() + 5000, pid: `${gameId}:fm6` } }]);
    check(S, 'a closed pot takes no new banner value and pays no kill', Number(afterClose.body.fastMiniPotAddedMicroUsd) === 0 && (lateKill.body.fastMiniKills ?? 0) === 0, `added ${afterClose.body.fastMiniPotAddedMicroUsd} · kills ${lateKill.body.fastMiniKills}`);
    const poolEnd = pool();
    check(S, 'Energy Pool still never overdrawn after Fast & Mini banners', Number(poolEnd.p) - Number(poolEnd.d) >= 0, `pool ${poolEnd.p} drawn ${poolEnd.d}`);

    // ---- Offline room hiding ------------------------------------------------------------------------
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
    sqlFile([`UPDATE game_nodes SET last_heartbeat = unixepoch() - 120 WHERE last_heartbeat IS NOT NULL;`]);
    const off = await call('/api/games/fps/rooms');
    const hub = await call('/api/games');
    const before = avail(R.id);
    const eOff = await call('/api/game/enter', { method: 'POST', token: R.token, body: { mode: 'mini_30' } });
    check(S, 'heartbeat older than 90 s + dead live check → gameServersOnline false, liveRooms [], Practice only', off.status === 200 && off.body.gameServersOnline === false && off.body.serverOnline === false && Array.isArray(off.body.liveRooms) && off.body.liveRooms.length === 0 && (off.body.rooms || []).length > 0 && off.body.rooms.every((r) => !r.multiplayer), `online ${off.body.gameServersOnline} · live ${off.body.liveRooms?.length} · rooms ${(off.body.rooms || []).map((r) => r.id).join(',')}`);
    check(S, '/api/games reports gameServersOnline false', hub.status === 200 && hub.body.gameServersOnline === false, `${hub.status} ${hub.body.gameServersOnline}`);
    check(S, 'offline → POST /api/game/enter 503 GAME_SERVERS_OFFLINE, no EC locked', eOff.status === 503 && eOff.body.code === 'GAME_SERVERS_OFFLINE' && avail(R.id) === before, `HTTP ${eOff.status} ${eOff.body.code} · EC ${before} → ${avail(R.id)}`);
    await heartbeat(nodeId);
    const back = await call('/api/games/fps/rooms');
    check(S, 'a new heartbeat brings the live rooms back', back.body.gameServersOnline === true && (back.body.liveRooms || []).length > 0, `online ${back.body.gameServersOnline} · live ${(back.body.liveRooms || []).length}`);
    sqlFile([`DELETE FROM game_nodes WHERE id = '${nodeId}';`]);
  }

  // ==============================================================================================
  const t0 = Date.now();
  console.log(`mwar.win load + security suite — ${new Date().toISOString()}`);
  console.log(`players ${OPT.players} · combat ${OPT.duration}s + ${OPT.wave2}s · ${OPT.workers} bot threads · hit rate ${OPT.hitRate} · api ${OPT.api}\n`);
  try {
    if (!OPT.skipGame) await partGame();
    if (!OPT.skipSecurity) await partSecurity();
  } catch (e) {
    check('suite', 'suite crashed', false, e?.stack || e);
  }
  // Stop the game server and let it shut down cleanly (rooms flush, CPU profile is written)
  await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          if (c.exitCode !== null) return resolve();
          c.once('exit', resolve);
          c.kill('SIGTERM');
          setTimeout(resolve, 15_000);
        })
    )
  );
  cleanup();
  const failed = results.filter((r) => !r.ok);
  const report = { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), options: { ...OPT, tgBotToken: undefined, postbackSecret: undefined, internalSecret: undefined }, passed: results.filter((r) => r.ok && !r.note).length, failed: failed.length, results, metrics, host: { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version } };
  fs.writeFileSync(OPT.report, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failed.length} failed in ${report.seconds} s — report: ${OPT.report}`);
  if (failed.length) for (const f of failed) console.log(`  FAIL [${f.section}] ${f.name} ${f.info}`);
  process.exit(failed.length ? 1 : 0);
}
