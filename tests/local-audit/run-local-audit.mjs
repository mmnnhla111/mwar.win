#!/usr/bin/env node
/**
 * run-local-audit.mjs — LOCAL-ONLY V1.1 audit: starts an isolated api-worker + the real game server on this PC,
 * runs the spec checks (01) and the ~100-player simulation (02), and writes .local-audit/audit-results.json.
 *
 *   node tests/local-audit/run-local-audit.mjs [--players=100] [--play-seconds=150] [--fresh] [--skip-sim]
 *
 * Safety: the worker runs `wrangler dev --local` with its D1 in .local-audit/wrangler-state (git-ignored),
 * NOT the normal .wrangler state and never the remote D1. Secrets are throw-away --var test values.
 * Nothing is deployed and nothing leaves 127.0.0.1.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE_DIR, PERSIST_DIR, WRANGLER, SECRETS, API, GAME_HTTP, migrate, sleep } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const children = [];
const cleanup = () => { for (const c of children) try { c.kill(); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitFor(url, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

fs.mkdirSync(STATE_DIR, { recursive: true });
if (args.fresh) fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
console.log('• building packages/shared');
execFileSync(process.execPath, [path.join(ROOT, 'packages/shared/node_modules/tsup/dist/cli-default.js'), 'src/index.ts', '--format', 'cjs,esm', '--dts'], { cwd: path.join(ROOT, 'packages/shared'), stdio: 'ignore' });
console.log(`• applying migrations to the isolated local D1 (${path.relative(ROOT, PERSIST_DIR)})`);
migrate();

const reuse = await fetch(API + '/api/auth/providers').then((r) => r.ok).catch(() => false);
if (!reuse) {
  console.log('• starting api-worker (wrangler dev --local)');
  const vars = Object.entries({ ...SECRETS, LOG_RECEIVER_URL: 'http://127.0.0.1:9/none', GAME_SERVER_HTTP_URL: GAME_HTTP }).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  const w = spawn(process.execPath, [WRANGLER.js, 'dev', '--local', '--ip', '127.0.0.1', '--port', new URL(API).port || '8787', '--persist-to', PERSIST_DIR, '--test-scheduled', '--local-upstream', `127.0.0.1:${new URL(API).port || '8787'}`, ...vars], { cwd: WRANGLER.cwd, stdio: ['ignore', fs.openSync(path.join(STATE_DIR, 'wrangler.log'), 'a'), fs.openSync(path.join(STATE_DIR, 'wrangler.log'), 'a')] });
  children.push(w);
  if (!(await waitFor(API + '/api/auth/providers'))) throw new Error('api-worker did not start (see .local-audit/wrangler.log)');
} else console.log('• reusing the api-worker already running at ' + API);

const gameUp = await fetch(GAME_HTTP + '/health').then((r) => r.ok).catch(() => false);
if (!gameUp && !args['skip-sim']) {
  console.log('• starting the real game server (Colyseus) → worker ' + API);
  const env = { ...process.env, GAME_PORT: new URL(GAME_HTTP).port, WORKER_API_URL: API, INTERNAL_API_SECRET: SECRETS.INTERNAL_API_SECRET, BODY_ONLY_ROOM_TTL_SECONDS: '20', BOSS_BOUNTY_INTERVAL_SECONDS: '15', NODE_ID: 'audit-node' };
  delete env.REDIS_URL;
  const tsx = path.join(ROOT, 'apps/game-server/node_modules/tsx/dist/cli.mjs');
  const g = spawn(process.execPath, [tsx, 'src/index.ts'], { cwd: path.join(ROOT, 'apps/game-server'), env, stdio: ['ignore', fs.openSync(path.join(STATE_DIR, 'game-server.log'), 'a'), fs.openSync(path.join(STATE_DIR, 'game-server.log'), 'a')] });
  children.push(g);
  g.on('exit', (code, signal) => fs.appendFileSync(path.join(STATE_DIR, 'game-server.log'), `\n[local-audit] GAME SERVER PROCESS EXITED code=${code} signal=${signal} at ${new Date().toISOString()}\n`));
  if (!(await waitFor(GAME_HTTP + '/health', 60_000))) throw new Error('game server did not start (see .local-audit/game-server.log)');
}

const run = (file, extra = []) =>
  new Promise((res) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'tests/local-audit', file), ...extra, '--json-out'], { stdio: 'inherit', env: { ...process.env, AUDIT_RESULTS: path.join(STATE_DIR, `${file}.json`) } });
    c.on('exit', (code) => res(code));
  });

const codes = {};
codes.spec = await run('01-economy-spec.mjs');
if (!args['skip-sim'] && !args['probes-only']) codes.sim = await run('02-simulate-players.mjs', [`--players=${args.players ?? 100}`, `--play-seconds=${args['play-seconds'] ?? 150}`]);
codes.economics = await run('03-country-economics.mjs');
if (!args['skip-sim']) codes.abuse = await run('04-abuse-probes.mjs');
if (!args['skip-sim']) codes.live = await run('05-live-economy-probes.mjs');
console.log(`\nexit codes ${JSON.stringify(codes)} · logs and JSON in ${path.relative(ROOT, STATE_DIR)}/`);
cleanup();
process.exit(Object.values(codes).some(Boolean) ? 1 : 0);
