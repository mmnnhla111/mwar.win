/**
 * tests/local-audit/lib.mjs — shared helpers for the LOCAL-ONLY V1.1 audit suite.
 *
 * Everything here talks to 127.0.0.1 only: a `wrangler dev --local` api-worker whose D1 lives in
 * .local-audit/wrangler-state (never the developer's normal local DB, never production), and a local
 * game server started by run-local-audit.mjs. Secrets are throw-away test values passed with --var.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const WORKER_DIR = path.join(ROOT, 'apps/api-worker');
export const STATE_DIR = path.join(ROOT, '.local-audit');
export const PERSIST_DIR = path.join(STATE_DIR, 'wrangler-state');
export const WRANGLER_JS = path.join(WORKER_DIR, 'node_modules/wrangler/bin/wrangler.js');

/** Throw-away LOCAL test secrets (must match what run-local-audit.mjs passes to wrangler / the game server). */
export const SECRETS = {
  JWT_SECRET: 'local-audit-jwt-secret-0123456789abcdef',
  INTERNAL_API_SECRET: 'local-audit-internal',
  TELEGRAM_BOT_TOKEN: '123456789:TESTtokenABC',
  AD_POSTBACK_SECRET: 'local-audit-postback',
};

export const API = process.env.AUDIT_API || 'http://127.0.0.1:8787';
export const GAME_HTTP = process.env.AUDIT_GAME_HTTP || 'http://127.0.0.1:2599';
export const GAME_WS = GAME_HTTP.replace(/^http/, 'ws');

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API)) {
  throw new Error(`local-audit refuses to run against a non-local API (${API})`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uuid = () => crypto.randomUUID();

const webRequire = createRequire(path.join(ROOT, 'apps/web/package.json'));
export const colyseus = () => webRequire('colyseus.js');

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------
export const results = [];
if (process.env.AUDIT_RESULTS) process.on('exit', () => fs.writeFileSync(process.env.AUDIT_RESULTS, JSON.stringify(results, null, 2)));
export function check(section, name, ok, info = '', meta = {}) {
  results.push({ section, name, ok: !!ok, info: String(info), ...meta });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${section}] ${name}${info ? ' — ' + info : ''}`);
  return !!ok;
}
export function note(section, name, info = '') {
  results.push({ section, name, ok: true, note: true, info: String(info) });
  console.log(`NOTE [${section}] ${name}${info ? ' — ' + info : ''}`);
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
export async function call(pathname, { method = 'GET', token, body, headers = {}, base = API } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(base + pathname, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let j = {};
      try {
        j = JSON.parse(text);
      } catch {
        j = { _text: text.slice(0, 300) };
      }
      return { status: r.status, body: j };
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

/** Telegram Login Widget signature (core.telegram.org/widgets/login) with the LOCAL test bot token. */
export function tgSign(d) {
  const signed = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date'];
  const s = Object.keys(d)
    .filter((k) => signed.includes(k))
    .sort()
    .map((k) => `${k}=${d[k]}`)
    .join('\n');
  const key = crypto.createHash('sha256').update(SECRETS.TELEGRAM_BOT_TOKEN).digest();
  return { ...d, hash: crypto.createHmac('sha256', key).update(s).digest('hex') };
}

let tgSeq = Math.floor(Math.random() * 1e8) + 6e9;
/** Real sign-up path (POST /api/auth/oauth/telegram), optionally with a referral code (sponsor id / username). */
export async function signup(username, referralCode) {
  const d = tgSign({ id: tgSeq++, first_name: 'Audit', username: username.slice(0, 32), auth_date: Math.floor(Date.now() / 1000), ...(referralCode ? { referral_code: referralCode } : {}) });
  const r = await call('/api/auth/oauth/telegram', { method: 'POST', body: d });
  if (!r.body?.token) throw new Error(`signup ${username} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { username, id: r.body.user.id, token: r.body.token };
}

export const decodeToken = (tok) => JSON.parse(Buffer.from(String(tok).split('.')[0], 'base64url').toString('utf8'));

// ---------------------------------------------------------------------------------------------
// Local D1 (isolated persist dir)
// ---------------------------------------------------------------------------------------------
function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_JS, ...args], { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}
function parseJsonOut(out) {
  const i = out.indexOf('[');
  return JSON.parse(out.slice(i));
}
/** Run several SQL statements in one wrangler call; returns one result set per statement. */
export function sqlFile(statements) {
  const f = path.join(os.tmpdir(), `mwar-audit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(f, statements.join('\n'));
  try {
    return parseJsonOut(wrangler(['d1', 'execute', 'core_db', '--local', '--persist-to', PERSIST_DIR, '--json', '--file', f]));
  } finally {
    fs.rmSync(f, { force: true });
  }
}
/** One SELECT → rows. */
export function sql(q) {
  return parseJsonOut(wrangler(['d1', 'execute', 'core_db', '--local', '--persist-to', PERSIST_DIR, '--json', '--command', q]))[0].results;
}
export const sql1 = (q) => sql(q)[0] || {};
export function migrate() {
  wrangler(['d1', 'migrations', 'apply', 'core_db', '--local', '--persist-to', PERSIST_DIR]);
  wrangler(['d1', 'migrations', 'apply', 'chat_2026_11', '--local', '--persist-to', PERSIST_DIR]);
}
export const WRANGLER = { js: WRANGLER_JS, cwd: WORKER_DIR };

// ---------------------------------------------------------------------------------------------
// Money helpers (independent re-implementation of the V1.1 rules, used as the test oracle)
// ---------------------------------------------------------------------------------------------
/** Spec §1.5: fraction ≥ 0.007 C (0.7 µUSD) rounds up, otherwise down — exact integer version. */
export const roundShare = (v, bps) => {
  const n = BigInt(v) * BigInt(bps);
  const q = n / 10000n;
  return Number(n % 10000n >= 7000n ? q + 1n : q);
};
export const fmtC = (micro) => `${(Number(micro) / 100).toFixed(2)} C`;
export const fmtUsd = (micro) => `$${(Number(micro) / 1e6).toFixed(Number(micro) < 1e6 ? 4 : 2)}`;
