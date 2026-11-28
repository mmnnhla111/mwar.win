import type { AuditLayer1, AuditLayer2, AuditLayer3, CashoutAuditReport, FlagSeverity } from '@mwar/shared';
import { HEADSHOT_MIN_SAMPLE_KILLS, HEADSHOT_RATIO_THRESHOLD } from '@mwar/shared';
import type { Env } from '../types';
import { logReceiverBase, logReceiverSecret, signedHeaders } from '../utils/audit-logger';

/**
 * 3-layer anti-cheat audit run on every cashout request (spec §6):
 *   Layer 1 — exact Micro-USD reconciliation of wallets.balance against the D1 wallet ledger
 *             (+ a signed cross-check against the Mini PC PostgreSQL copy when LOG_RECEIVER_URL is set).
 *   Layer 2 — behaviour: headshot ratio > 0.85 with ≥ 30 kills, chest collection > 3σ above the room.
 *   Layer 3 — collusion graph: kills or paid spectator gifts on accounts sharing an IP hash / device
 *             fingerprint, or in a direct 1-on-1 referral loop; collusion ratio and collusive earnings.
 * Returns the report; flags are written to anticheat_flags. Score 1.00 = clean, 0.00 = high risk.
 */
export const AUDIT_WINDOW_DAYS = 90;
export const HEADSHOT_RATIO_LIMIT = HEADSHOT_RATIO_THRESHOLD;
export const HEADSHOT_MIN_KILLS = HEADSHOT_MIN_SAMPLE_KILLS;
export const CHEST_SIGMA_LIMIT = 3;
export const CHEST_MIN_ROOM_PLAYERS = 11; // a 3σ outlier is mathematically impossible below 11 players
export const COLLUSION_MIN_KILLS = 3;
export const COLLUSION_RATIO_FLAG = 0.2;
export const COLLUSION_RATIO_CRITICAL = 0.5;
export const AUTO_CLEAR_MIN_SCORE = 0.7;

type Flag = { layer: 1 | 2 | 3; type: string; severity: FlagSeverity; details: Record<string, unknown> };

const n = (v: unknown) => Number(v ?? 0) || 0;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Events newer than this may still be in the queue, so the PostgreSQL window ends here. */
export const PG_LAG_TOLERANCE_SECONDS = 15 * 60;
/** Stay inside PostgreSQL's 90-day retention. */
const PG_WINDOW_DAYS = 89;

/**
 * Independent copy check: the Mini PC PostgreSQL net (wallet-moving events) over a window must equal
 * the D1 wallet_ledger net over the same window. Catches a D1 balance + ledger edited together.
 * PostgreSQL with fewer events than D1 (queue / outbox still delivering) → 'lagging', not a mismatch.
 */
export async function postgresCrossCheck(env: Env, userId: string): Promise<AuditLayer1['postgres']> {
  const base = logReceiverBase(env);
  const secret = logReceiverSecret(env);
  if (!base || !secret) return { status: 'not_configured' };
  const now = Math.floor(Date.now() / 1000);
  const end = now - PG_LAG_TOLERANCE_SECONDS;
  // The D1 ledger starts at the user's first row (OPENING_BALANCE at migration 0019 for older accounts)
  const first = await env.DB.prepare('SELECT MIN(created_at) AS t FROM wallet_ledger WHERE user_id = ?1').bind(userId).first<{ t: number | null }>();
  const start = Math.max(now - PG_WINDOW_DAYS * 86_400, (first?.t ?? now) + 1);
  if (start >= end) return { status: 'match', calculatedMicroUsd: 0, d1WindowNetMicroUsd: 0, pgEvents: 0, d1Events: 0, windowStart: start, windowEnd: end, reason: 'window empty (new ledger)' };
  const d1 = await env.DB.prepare(
    `SELECT COALESCE(SUM(delta_micro_usd), 0) AS net, COUNT(*) AS n FROM wallet_ledger
     WHERE user_id = ?1 AND action_type <> 'OPENING_BALANCE' AND delta_micro_usd <> 0 AND created_at >= ?2 AND created_at < ?3`
  ).bind(userId, start, end).first<{ net: number; n: number }>();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_outbox WHERE user_id = ?1').bind(userId).first<{ n: number }>().catch(() => null);
  const path = `/internal/reconcile/${encodeURIComponent(userId)}?since=${start}&until=${end}`;
  try {
    const res = await fetch(base + path, { headers: await signedHeaders(secret, 'GET', path), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { status: 'unreachable', reason: `HTTP ${res.status}` };
    const j = (await res.json()) as { netMicroUsd?: string; events?: number };
    const pgNet = Number(BigInt(j.netMicroUsd ?? '0'));
    const pgEvents = n(j.events);
    const d1Net = n(d1?.net);
    const d1Events = n(d1?.n);
    const detail = { calculatedMicroUsd: pgNet, d1WindowNetMicroUsd: d1Net, pgEvents, d1Events, windowStart: start, windowEnd: end };
    if (pgNet === d1Net) return { status: 'match', ...detail };
    if (pgEvents < d1Events || n(pending?.n) > 0) return { status: 'lagging', ...detail, reason: n(pending?.n) ? `${n(pending?.n)} events in the D1 outbox` : 'PostgreSQL behind D1' };
    return { status: 'mismatch', ...detail };
  } catch (e: any) {
    return { status: 'unreachable', reason: String(e?.message || e).slice(0, 120) };
  }
}

export async function layer1Reconcile(env: Env, userId: string): Promise<AuditLayer1> {
  const [led, wal] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN delta_micro_usd > 0 THEN delta_micro_usd END), 0) AS credits,
              COALESCE(SUM(CASE WHEN delta_micro_usd < 0 AND action_type = 'CASHOUT_REQUEST' THEN -delta_micro_usd END), 0) AS withdrawals,
              COALESCE(SUM(CASE WHEN delta_micro_usd < 0 AND action_type = 'MARKET_BUY' THEN -delta_micro_usd END), 0) AS purchases,
              COALESCE(SUM(CASE WHEN delta_micro_usd < 0 AND action_type NOT IN ('CASHOUT_REQUEST', 'MARKET_BUY') THEN -delta_micro_usd END), 0) AS other,
              COUNT(*) AS rows
       FROM wallet_ledger WHERE user_id = ?1`
    ).bind(userId),
    env.DB.prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1').bind(userId),
  ]);
  const l = (led.results?.[0] || {}) as any;
  const actual = n((wal.results?.[0] as any)?.balance_micro_usd);
  const expected = n(l.credits) - n(l.withdrawals) - n(l.purchases) - n(l.other);
  const diff = actual - expected;

  const postgres = await postgresCrossCheck(env, userId);
  return {
    status: Math.abs(diff) >= 1 || postgres.status === 'mismatch' ? 'mismatch' : 'match',
    expectedBalanceMicroUsd: expected,
    actualBalanceMicroUsd: actual,
    diffMicroUsd: diff,
    creditsMicroUsd: n(l.credits),
    withdrawalsMicroUsd: n(l.withdrawals),
    purchasesMicroUsd: n(l.purchases),
    otherDebitsMicroUsd: n(l.other),
    ledgerRows: n(l.rows),
    postgres,
  };
}

export async function layer2Behaviour(env: Env, userId: string, since: number): Promise<AuditLayer2> {
  const [k, aim, rooms] = await env.DB.batch([
    env.DB.prepare(
      `SELECT SUM(CASE WHEN action_type IN ('GAME_KILL', 'FAST_MINI_KILL') THEN 1 ELSE 0 END) AS kills, SUM(CASE WHEN action_type = 'CHEST_OPEN' THEN 1 ELSE 0 END) AS chests
       FROM combat_events WHERE user_id = ?1 AND created_at >= ?2`
    ).bind(userId, since),
    // Session totals are cumulative: the max per game is that game's total
    env.DB.prepare(
      `SELECT COALESCE(SUM(h), 0) AS hits, COALESCE(SUM(hs), 0) AS headshots FROM (
         SELECT MAX(session_hits) AS h, MAX(session_headshots) AS hs FROM combat_events
         WHERE user_id = ?1 AND created_at >= ?2 AND session_hits IS NOT NULL GROUP BY game_id)`
    ).bind(userId, since),
    // Chest counts of every player in the (≤ 50 most recent) rooms where this player opened chests
    env.DB.prepare(
      `WITH g AS (SELECT game_id FROM combat_events WHERE user_id = ?1 AND action_type = 'CHEST_OPEN' AND created_at >= ?2
                  GROUP BY game_id ORDER BY MAX(created_at) DESC LIMIT 50)
       SELECT game_id, user_id, SUM(CASE WHEN action_type = 'CHEST_OPEN' THEN 1 ELSE 0 END) AS chests
       FROM combat_events WHERE game_id IN (SELECT game_id FROM g) GROUP BY game_id, user_id`
    ).bind(userId, since),
  ]);
  const kills = n((k.results?.[0] as any)?.kills);
  const chests = n((k.results?.[0] as any)?.chests);
  const hits = n((aim.results?.[0] as any)?.hits);
  const headshots = n((aim.results?.[0] as any)?.headshots);
  const headshotRatio = hits > 0 ? round2(headshots / hits) : null;

  const byGame = new Map<string, Array<{ userId: string; chests: number }>>();
  for (const r of (rooms.results || []) as any[]) {
    const arr = byGame.get(r.game_id) || [];
    arr.push({ userId: r.user_id, chests: n(r.chests) });
    byGame.set(r.game_id, arr);
  }
  let maxChestZ: number | null = null;
  for (const players of byGame.values()) {
    if (players.length < CHEST_MIN_ROOM_PLAYERS) continue;
    const mean = players.reduce((a, p) => a + p.chests, 0) / players.length;
    const sd = Math.sqrt(players.reduce((a, p) => a + (p.chests - mean) ** 2, 0) / players.length);
    const me = players.find((p) => p.userId === userId);
    if (!me || sd <= 0) continue;
    const z = (me.chests - mean) / sd;
    if (maxChestZ === null || z > maxChestZ) maxChestZ = round2(z);
  }

  const reasons: string[] = [];
  if (kills >= HEADSHOT_MIN_KILLS && headshotRatio !== null && headshotRatio > HEADSHOT_RATIO_LIMIT) reasons.push('headshot_ratio');
  if (maxChestZ !== null && maxChestZ > CHEST_SIGMA_LIMIT) reasons.push('chest_rate');
  return { status: reasons.length ? 'suspicious' : 'clean', kills, hits, headshots, headshotRatio, chests, maxChestZ, reasons };
}

export async function layer3Collusion(env: Env, userId: string, since: number): Promise<AuditLayer3> {
  const [victims, shared, refs, gifts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT victim_id, COUNT(*) AS kills, COALESCE(SUM(earner_micro_usd), 0) AS earned
       FROM combat_events WHERE user_id = ?1 AND action_type IN ('GAME_KILL', 'FAST_MINI_KILL') AND victim_id IS NOT NULL AND created_at >= ?2
       GROUP BY victim_id`
    ).bind(userId, since),
    env.DB.prepare(
      `SELECT DISTINCT b.user_id AS partner, a.kind FROM user_device_links a
       JOIN user_device_links b ON b.kind = a.kind AND b.hash = a.hash AND b.user_id <> a.user_id
       WHERE a.user_id = ?1`
    ).bind(userId),
    env.DB.prepare(
      `SELECT id FROM users WHERE referrer_id = ?1
       UNION SELECT referrer_id FROM users WHERE id = ?1 AND referrer_id IS NOT NULL`
    ).bind(userId),
    env.DB.prepare(
      `SELECT CASE WHEN receiver_id = ?1 THEN sender_id ELSE receiver_id END AS partner_id,
              COUNT(*) AS gift_count,
              COALESCE(SUM(CASE WHEN receiver_id = ?1 THEN receiver_micro_usd ELSE 0 END), 0) AS received_micro_usd,
              COALESCE(SUM(gross_micro_usd), 0) AS gross_micro_usd
       FROM gift_transactions
       WHERE status = 'done' AND gross_micro_usd > 0 AND created_at >= ?2
         AND (receiver_id = ?1 OR sender_id = ?1) AND receiver_id IS NOT NULL
       GROUP BY partner_id`
    ).bind(userId, since),
  ]);
  const ipPartners = new Set<string>();
  const fpPartners = new Set<string>();
  for (const r of (shared.results || []) as any[]) (r.kind === 'ip' ? ipPartners : fpPartners).add(r.partner);
  const refPartners = new Set<string>(((refs.results || []) as any[]).map((r) => r.id).filter(Boolean));

  let kills = 0;
  let suspiciousKills = 0;
  let suspiciousGifts = 0;
  let collusiveGiftMicroUsd = 0;
  let collusive = 0;
  const partnerMap = new Map<string, { userId: string; kills: number; reasons: Set<string> }>();
  const addPartner = (pid: string, addKills: number, reasons: string[]) => {
    const cur = partnerMap.get(pid) || { userId: pid, kills: 0, reasons: new Set<string>() };
    cur.kills += addKills;
    for (const r of reasons) cur.reasons.add(r);
    partnerMap.set(pid, cur);
  };

  for (const v of (victims.results || []) as any[]) {
    const c = n(v.kills);
    kills += c;
    const reasons: string[] = [];
    if (ipPartners.has(v.victim_id)) reasons.push('same_ip');
    if (fpPartners.has(v.victim_id)) reasons.push('same_device');
    if (refPartners.has(v.victim_id)) reasons.push('referral_loop');
    if (!reasons.length) continue;
    suspiciousKills += c;
    collusive += n(v.earned);
    addPartner(v.victim_id, c, reasons);
  }

  for (const g of (gifts.results || []) as any[]) {
    const pid = String(g.partner_id || '');
    if (!pid || pid === userId) continue;
    const sameIp = ipPartners.has(pid);
    const sameFp = fpPartners.has(pid);
    if (!sameIp && !sameFp) continue;
    const reasons: string[] = ['gift_collusion'];
    if (sameIp) reasons.push('same_ip');
    if (sameFp) reasons.push('same_device');
    if (refPartners.has(pid)) reasons.push('referral_loop');
    suspiciousGifts += n(g.gift_count);
    collusive += n(g.received_micro_usd);
    collusiveGiftMicroUsd += n(g.gross_micro_usd);
    addPartner(pid, 0, reasons);
  }

  const partners = Array.from(partnerMap.values()).map((p) => ({
    userId: p.userId,
    kills: p.kills,
    reasons: Array.from(p.reasons),
  }));
  partners.sort((a, b) => b.kills - a.kills);
  const top = partners.slice(0, 5);
  const names = new Map<string, string>();
  if (top.length) {
    const rows = await env.DB.prepare(`SELECT id, username FROM users WHERE id IN (${top.map((_, i) => `?${i + 1}`).join(',')})`)
      .bind(...top.map((p) => p.userId))
      .all<{ id: string; username: string }>();
    for (const r of rows.results || []) names.set(r.id, r.username);
  }
  const ratio = kills > 0 ? round2(suspiciousKills / kills) : 0;
  const giftCollusionCritical = suspiciousGifts >= 2 || collusiveGiftMicroUsd >= 50_000;
  const giftCollusionSuspicious = suspiciousGifts >= 1;
  const status: AuditLayer3['status'] =
    (suspiciousKills >= COLLUSION_MIN_KILLS && ratio >= COLLUSION_RATIO_CRITICAL) || giftCollusionCritical
      ? 'collusion'
      : (suspiciousKills >= COLLUSION_MIN_KILLS && ratio >= COLLUSION_RATIO_FLAG) || giftCollusionSuspicious
        ? 'suspicious'
        : 'clean';
  return {
    status,
    kills,
    suspiciousKills,
    collusionRatio: ratio,
    sharedIpPartners: ipPartners.size,
    sharedDevicePartners: fpPartners.size,
    referralLoopPartners: refPartners.size,
    collusiveEarningsMicroUsd: collusive,
    topPartners: top.map((p) => ({ ...p, username: names.get(p.userId) ?? null })),
  };
}

export async function runCashoutAudit(env: Env, userId: string, withdrawalId: string): Promise<CashoutAuditReport> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - AUDIT_WINDOW_DAYS * 86_400;
  const [layer1, layer2, layer3, open] = await Promise.all([
    layer1Reconcile(env, userId),
    layer2Behaviour(env, userId, since),
    layer3Collusion(env, userId, since),
    env.DB.prepare("SELECT COUNT(*) AS c FROM anticheat_flags WHERE user_id = ?1 AND resolved = 0 AND severity IN ('medium', 'critical')")
      .bind(userId)
      .first<{ c: number }>(),
  ]);

  const flags: Flag[] = [];
  let score = 1;
  if (layer1.status === 'mismatch') {
    score = 0;
    flags.push({ layer: 1, type: layer1.postgres.status === 'mismatch' && Math.abs(layer1.diffMicroUsd) < 1 ? 'postgres_mismatch' : 'ledger_mismatch', severity: 'critical', details: { diffMicroUsd: layer1.diffMicroUsd, expected: layer1.expectedBalanceMicroUsd, actual: layer1.actualBalanceMicroUsd, postgres: layer1.postgres } });
  } else if (layer1.postgres.status === 'unreachable') {
    score -= 0.05;
  }
  if (layer2.reasons.includes('headshot_ratio')) {
    score -= 0.35;
    flags.push({ layer: 2, type: 'headshot_ratio', severity: 'medium', details: { ratio: layer2.headshotRatio, kills: layer2.kills, hits: layer2.hits } });
  }
  if (layer2.reasons.includes('chest_rate')) {
    score -= 0.25;
    flags.push({ layer: 2, type: 'chest_rate', severity: 'medium', details: { z: layer2.maxChestZ, chests: layer2.chests } });
  }
  if (layer3.status !== 'clean') {
    score -= layer3.status === 'collusion' ? 0.6 : 0.3;
    flags.push({
      layer: 3,
      type: 'collusion_kills',
      severity: layer3.status === 'collusion' ? 'critical' : 'medium',
      details: { ratio: layer3.collusionRatio, suspiciousKills: layer3.suspiciousKills, collusiveEarningsMicroUsd: layer3.collusiveEarningsMicroUsd, partners: layer3.topPartners.map((p) => p.userId) },
    });
  }
  const openFlags = n(open?.c);
  score -= Math.min(0.3, openFlags * 0.15);
  score = Math.max(0, Math.min(1, round2(score)));

  const decision: CashoutAuditReport['decision'] = layer1.status === 'mismatch' || flags.length > 0 || score < AUTO_CLEAR_MIN_SCORE ? 'flagged_review' : 'pending';
  if (flags.length) {
    await env.DB.batch(
      flags.map((f) =>
        env.DB.prepare('INSERT INTO anticheat_flags (id, user_id, layer, flag_type, severity, details_json, resolved, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)').bind(
          `acf_${crypto.randomUUID()}`,
          userId,
          f.layer,
          f.type,
          f.severity,
          JSON.stringify({ ...f.details, withdrawalId }),
          now
        )
      )
    );
  }
  return {
    version: 1,
    ranAt: now,
    score,
    decision,
    layer1,
    layer2,
    layer3,
    openFlags,
    flagsCreated: flags.map((f) => ({ layer: f.layer, type: f.type, severity: f.severity })),
  };
}
