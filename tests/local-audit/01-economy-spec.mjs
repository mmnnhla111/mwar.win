/**
 * 01-economy-spec.mjs — pure checks of packages/shared against docs/master_system_specification_updated_v1_1.md
 * (no server needed). Each check names the spec section it verifies.
 *
 *   node tests/local-audit/01-economy-spec.mjs        (packages/shared/dist must be built: pnpm --filter @mwar/shared build)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, note, results, roundShare } from './lib.mjs';

const S = await import(pathToFileURL(path.join(ROOT, 'packages/shared/dist/index.mjs')).href);
const SEC = 'spec-math';

// ---- §1.4 currency: 100 C = $0.01 = 10,000 µUSD, 1 C = 100 µUSD -------------------------------------
check(SEC, '§1.4 1 C = 100 µUSD (MICRO_USD_PER_C / MICRO_USD_PER_COIN)', S.MICRO_USD_PER_C === 100 && S.MICRO_USD_PER_COIN === 100n, `${S.MICRO_USD_PER_C} / ${S.MICRO_USD_PER_COIN}`);
check(SEC, '§1.4 display: 10,000 µUSD → "100.00 C ($0.0100)"', S.formatCoinsAndUsd(10_000) === '100.00 C ($0.0100)', S.formatCoinsAndUsd(10_000));
check(SEC, '§1.4 display: 1 µUSD → "0.01 C"', S.formatCoins2(1) === '0.01 C', S.formatCoins2(1));

// ---- §1.5 rounding of the 3rd decimal of C ---------------------------------------------------------
{
  const bad = [];
  for (let whole = 0; whole < 50; whole++)
    for (let tenth = 0; tenth < 10; tenth++) {
      const raw = whole + tenth / 10; // fraction of 1 µUSD = the 3rd decimal of C
      const want = tenth >= 7 ? whole + 1 : whole;
      const got = S.roundCoinMicroUsd(raw);
      if (got !== want) bad.push(`${raw}→${got}`);
    }
  check(SEC, '§1.5 roundCoinMicroUsd: r ≥ 0.007 C up, r ≤ 0.006 C down (500 cases)', bad.length === 0, bad.slice(0, 6).join(', '));
  const bad2 = [];
  for (let v = 0; v <= 30_000; v++) for (const bps of [5500, 500, 400, 300, 200, 100, 2000, 9000]) if (Number(S.roundCoinShare(BigInt(v), BigInt(bps))) !== roundShare(v, bps)) bad2.push(`${v}×${bps}`);
  check(SEC, '§1.5 roundCoinShare matches an independent oracle for V = 0…30,000 × every rate', bad2.length === 0, bad2.slice(0, 5).join(', '));
}

// ---- §7.3 55/15/5/5/20 split ----------------------------------------------------------------------
const ups = (n) => Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}`, depth: i + 1 }));
{
  let viol = 0;
  let over = 0;
  let farOff = 0;
  let floorViol = 0;
  let maxDev = 0;
  const examples = [];
  const values = [];
  for (let v = 0; v <= 20_000; v++) values.push(v);
  for (let i = 0; i < 20_000; i++) values.push(Math.floor(Math.random() * 50_000_000));
  for (const v of values)
    for (let n = 0; n <= 5; n++) {
      const r = S.calculateRewardSplit(v, ups(n));
      const parts = [r.earnerMicroUsd, r.bountyMicroUsd, r.energyPoolMicroUsd, r.platformTotalMicroUsd, ...r.uplinePayouts.map((p) => p.amountMicroUsd)].map(Number);
      const sum = parts.reduce((a, b) => a + b, 0);
      if (sum !== v) viol++;
      if (parts.some((p) => p < 0) || sum > v) over++;
      const expect = { earner: roundShare(v, 5500), bounty: roundShare(v, 500), pool: roundShare(v, 2000) };
      const dev = Math.max(Math.abs(Number(r.earnerMicroUsd) - expect.earner), Math.abs(Number(r.bountyMicroUsd) - expect.bounty), Math.abs(Number(r.energyPoolMicroUsd) - expect.pool));
      maxDev = Math.max(maxDev, dev);
      if (dev > 1) {
        farOff++;
        if (examples.length < 3) examples.push(`V=${v}`);
      }
      if (Number(r.platformTotalMicroUsd) < Math.floor(v * 0.05)) floorViol++;
      // upline amounts and depths
      for (const p of r.uplinePayouts) if (Math.abs(Number(p.amountMicroUsd) - roundShare(v, [0, 500, 400, 300, 200, 100][p.depth])) > 1) farOff++;
    }
  check(SEC, '§7.3/§1.5 Σ shares === V exactly for 40,001 values × 0–5 uplines (zero-deficit)', viol === 0 && over === 0, `${values.length * 6} splits · violations ${viol} · overpay ${over}`);
  check(SEC, '§7.3 each share is the 0.007-rounded rate (±1 µUSD trim allowed)', farOff === 0, `max deviation ${maxDev} µUSD ${examples.join(' ')}`);
  check(SEC, '§7.3 platform keeps ≥ 5 % floor (missing uplines + rounding go to platform)', floorViol === 0, `${floorViol}`);
  const r0 = S.calculateRewardSplit(1_000_000, []);
  check(SEC, '§7.3 no uplines: the 15 % goes to the platform (platform = 20 %)', Number(r0.platformTotalMicroUsd) === 200_000, `${r0.platformTotalMicroUsd}`);
  const r5 = S.calculateRewardSplit(1_000_000, ups(5));
  check(
    SEC,
    '§7.3 V=$1: shooter 550,000 · L1-L5 50k/40k/30k/20k/10k · bounty 50k · platform 50k · pool 200k',
    Number(r5.earnerMicroUsd) === 550_000 && r5.uplinePayouts.map((p) => Number(p.amountMicroUsd)).join() === '50000,40000,30000,20000,10000' && Number(r5.bountyMicroUsd) === 50_000 && Number(r5.platformTotalMicroUsd) === 50_000 && Number(r5.energyPoolMicroUsd) === 200_000
  );

  // Literal spec algorithm (§7.3): platform = V − (shooter + uplines + bounty + pool); trim rounded-up shares 1 µUSD at a time
  // only when the sum before the platform exceeds V. The code adds a stricter "platform ≥ floor(5 %)" rule.
  let differ = 0;
  const diffEx = [];
  for (let v = 1; v <= 5000; v++) {
    const shares = [5500, 2000, 500, 500, 400, 300, 200, 100].map((b) => roundShare(v, b));
    let s = shares.reduce((a, b) => a + b, 0);
    let i = 0;
    while (s > v && i < 64) {
      const k = shares.indexOf(Math.max(...shares));
      shares[k]--;
      s--;
      i++;
    }
    const literalPlatform = v - s;
    const code = Number(S.calculateRewardSplit(v, ups(5)).platformTotalMicroUsd);
    if (code !== literalPlatform) {
      differ++;
      if (diffEx.length < 4) diffEx.push(`V=${v}: spec→platform ${literalPlatform}, code→${code}`);
    }
  }
  note(SEC, `§7.3 literal spec vs code: the code also enforces platform ≥ floor(V×5 %) — differs for ${differ}/5000 small V`, diffEx.join(' · '));
}

// ---- §7.4 Fast & Mini 90/10 -----------------------------------------------------------------------
{
  let bad = 0;
  for (let v = 0; v <= 50_000; v++) {
    const r = S.calculateFastMiniSplit(v);
    if (Number(r.shooterMicroUsd) + Number(r.platformMicroUsd) !== v || Number(r.platformMicroUsd) < Math.floor(v / 10) || r.uplinesMicroUsd || r.bountyMicroUsd || r.energyPoolMicroUsd) bad++;
  }
  check(SEC, '§7.4 Fast & Mini: shooter 90 % / platform 10 % (+rounding), 0 % uplines/bounty/pool, Σ = V', bad === 0, `${bad} bad of 50,001`);
}

// ---- §7.1 haircut −5 % … −10 % for every country/format --------------------------------------------
{
  const countries = Object.keys(S.COUNTRY_AD_ECPM_USD);
  check(SEC, '§7.1 eCPM table: 26 countries + GLOBAL', countries.length === 27 && countries.includes('GLOBAL'), `${countries.length}: ${countries.join(',')}`);
  let bad = 0;
  for (const cc of countries)
    for (const f of ['banner', 'video_5s', 'video_15s', 'video_30s']) {
      const g = S.getStatisticalAdMicroUsd(cc, f);
      for (const m of [0.9, 0.92, 0.95, '0.92', '92', 9200, 1.2, 0.5, undefined]) {
        const safe = S.safeAdMicroUsd(g, m);
        if (safe > g || safe < Math.floor(g * 0.9) || safe > Math.floor(g * 0.95)) bad++;
      }
    }
  check(SEC, '§7.1 safe = floor(gross × m), m clamped to [0.90, 0.95] for every country × format × config value', bad === 0, `${bad} violations`);
  const lo = S.safeAdMicroUsd(3000, 0.9);
  const hi = S.safeAdMicroUsd(3000, 0.95);
  check(SEC, '§7.1 example: $3.00 eCPM banner (30.00 C) → 27.00 C – 28.50 C, never > 30.00 C', lo === 2700 && hi === 2850, `${lo}…${hi}`);
  check(SEC, '§7.1 misconfigured AD_SAFETY_MULTIPLIER (e.g. "1" or "1.5") still clamps to −5 %', S.parseSafetyMultiplierBp('1') === 9500 && S.parseSafetyMultiplierBp('1.5') === 9500 && S.parseSafetyMultiplierBp('0.5') === 9000, `${S.parseSafetyMultiplierBp('1')} ${S.parseSafetyMultiplierBp('1.5')} ${S.parseSafetyMultiplierBp('0.5')}`);

  // docs/AD_ECPM_BY_COUNTRY.md table == adEcpm.ts
  const md = fs.readFileSync(path.join(ROOT, 'docs/AD_ECPM_BY_COUNTRY.md'), 'utf8');
  const rows = [...md.matchAll(/^\|\s*\*\*[^|]+\*\*\s*\|\s*`([A-Z]+)`\s*\|[^|]*\|\s*\*\*\$([\d.]+)\*\*\s*\|\s*\*\*\$([\d.]+)\*\*\s*\|\s*\*\*\$([\d.]+)\*\*\s*\|\s*\*\*\$([\d.]+)\*\*/gm)];
  const mism = [];
  for (const [, cc, b, v5, v15, v30] of rows) {
    const e = S.COUNTRY_AD_ECPM_USD[cc];
    if (!e) mism.push(`${cc}: missing in code`);
    else if (e.bannerEcpmUsd !== +b || e.video5sEcpmUsd !== +v5 || e.video15sEcpmUsd !== +v15 || e.video30sEcpmUsd !== +v30) mism.push(`${cc}`);
    else if (e.bannerMicroUsd !== Math.round(+b * 1000) || e.video30sMicroUsd !== Math.round(+v30 * 1000)) mism.push(`${cc} µUSD`);
  }
  check(SEC, '§7.1 docs/AD_ECPM_BY_COUNTRY.md table matches adEcpm.ts (eCPM and µUSD per view)', rows.length === 27 && mism.length === 0, `${rows.length} rows · mismatches: ${mism.join(', ') || 'none'}`);
  const docFloor = /\\lfloor V \\times 0\.55 \\rfloor/.test(md);
  check(SEC, 'docs/AD_ECPM_BY_COUNTRY.md still documents floor() splits (V1.1 uses 0.007 C rounding) — doc out of date', !docFloor, docFloor ? 'section 1 shows ⌊V×0.55⌋ etc.' : '');
}

// ---- §7.2 tickets: no fixed price, cap 300, signup 0-backed, backing conserved ---------------------
{
  check(SEC, '§7.2 EC cap 300, 1 EC at sign-up', S.MAX_ENERGY_TICKETS === 300 && S.INITIAL_ENERGY_TICKETS === 1);
  let bad = 0;
  for (let i = 0; i < 20_000; i++) {
    const prevBp = Math.floor(Math.random() * 10_000);
    const prevPending = Math.floor(Math.random() * 50_000);
    const addBp = Math.floor(Math.random() * 40_000);
    const addMicroUsd = Math.floor(Math.random() * 100_000);
    const tickets = Math.floor(Math.random() * 302);
    const r = S.allocateEcProgress({ prevBp, prevPending, addBp, addMicroUsd, tickets, maxTickets: 300 });
    const minted = r.mintedBacking.reduce((a, b) => a + b, 0);
    if (minted + r.newPending !== prevPending + addMicroUsd || r.tickets > Math.max(300, tickets) || r.newBp < 0 || (r.tickets >= 300 && r.newBp >= 10_000)) bad++;
  }
  check(SEC, '§7.2 allocateEcProgress: Σ minted + pending = previous + added (no µUSD created/lost), never > 300 tickets', bad === 0, `${bad} of 20,000 random cases`);
  const intervals = Array.from({ length: 5000 }, () => S.nextBannerIntervalSeconds());
  check(SEC, '§7.2 banner refresh is random 30–45 s', Math.min(...intervals) >= 30 && Math.max(...intervals) <= 45 && new Set(intervals.map(Math.round)).size > 10, `min ${Math.min(...intervals)} max ${Math.max(...intervals)}`);
  check(SEC, '§7.2 server banner gate ≥ 28 s', S.AD_BANNER_MIN_GAP_SECONDS >= 28, `${S.AD_BANNER_MIN_GAP_SECONDS}`);
  check(SEC, '§7.2 Anti-Idle 35 s (server rejects banners when the last input is older than this)', S.AD_IDLE_REJECT_MS === 35_000, `client pause ${S.AD_IDLE_PAUSE_MS} ms · server reject ${S.AD_IDLE_REJECT_MS} ms`);
}

// ---- §7.5 cheer -----------------------------------------------------------------------------------
{
  check(SEC, '§7.5 cheer cooldown ≥ 45 s, 15/day, 3 per creator/day', S.CHEER_COOLDOWN_SECONDS >= 45 && S.CHEER_DAILY_CAP === 15 && S.CHEER_PER_TARGET_DAILY_CAP === 3, `${S.CHEER_COOLDOWN_SECONDS}s ${S.CHEER_DAILY_CAP} ${S.CHEER_PER_TARGET_DAILY_CAP}`);
  let bad = 0;
  for (let v = 0; v <= 20_000; v++) {
    const r = S.calculateCheerSplit(v, ups(v % 6));
    const sum = Number(r.earnerMicroUsd) + Number(r.bountyMicroUsd) + Number(r.platformTotalMicroUsd) + Number(r.viewerEcBackingMicroUsd) + r.uplinePayouts.reduce((a, p) => a + Number(p.amountMicroUsd), 0);
    if (sum !== v) bad++;
  }
  check(SEC, '§7.5 cheer split 55/15/5/5/20 allocates exactly 100 % of V (never 120 %)', bad === 0, `${bad} bad`);
}

// ---- §8.1 ranks -----------------------------------------------------------------------------------
{
  const spec = [
    ['Bronze I', 'bronze_1', 0], ['Bronze II', 'bronze_2', 3], ['Bronze III', 'bronze_3', 10],
    ['Silver I', 'silver_1', 25], ['Silver II', 'silver_2', 50], ['Silver III', 'silver_3', 100],
    ['Gold I', 'gold_1', 250], ['Gold II', 'gold_2', 500], ['Gold III', 'gold_3', 1000],
    ['Platinum I', 'platinum_1', 2500], ['Platinum II', 'platinum_2', 5000], ['Platinum III', 'platinum_3', 10000],
  ];
  const t = S.RANK_TIERS;
  const ok = t.length === 12 && spec.every(([n, id, min], i) => t[i].name === n && t[i].id === id && t[i].minDownlines === min);
  check(SEC, '§8.1 12 ranks: names, icon ids and downline thresholds match the spec table', ok, t.map((r) => `${r.name}:${r.minDownlines}`).join(' '));
  const edges = [[0, 'bronze_1'], [2, 'bronze_1'], [3, 'bronze_2'], [9, 'bronze_2'], [10, 'bronze_3'], [99, 'silver_2'], [100, 'silver_3'], [9999, 'platinum_2'], [10000, 'platinum_3'], [10 ** 7, 'platinum_3']];
  const wrong = edges.filter(([n, id]) => S.getRankForDownlines(n).id !== id);
  check(SEC, '§8.1 getRankForDownlines boundary values', wrong.length === 0, wrong.map(([n]) => `${n}→${S.getRankForDownlines(n).id}`).join(', '));
  const icons = spec.filter(([, id]) => !fs.existsSync(path.join(ROOT, 'apps/web/public/assets/ranks', `${id}.png`)));
  check(SEC, '§8.1 all 12 rank icon PNGs exist in apps/web/public/assets/ranks', icons.length === 0, icons.map((x) => x[1]).join(','));
}

// ---- §6 anti-cheat thresholds ---------------------------------------------------------------------
check(SEC, '§6 L2 headshot flag at ratio > 85 %', S.HEADSHOT_RATIO_FLAG === 0.85, `${S.HEADSHOT_RATIO_FLAG}`);
check(SEC, '§6 L2 headshot check starts when kills ≥ 30 (spec) — code counts HITS ≥ HEADSHOT_MIN_SAMPLE_HITS', S.HEADSHOT_MIN_SAMPLE_HITS === 30, `HEADSHOT_MIN_SAMPLE_HITS = ${S.HEADSHOT_MIN_SAMPLE_HITS} (hits, not kills)`);
check(SEC, '§6 L2 chest-rate anomaly at > 3σ', S.CHEST_RATE_SIGMA_LIMIT === 3, `${S.CHEST_RATE_SIGMA_LIMIT}`);
check(SEC, '§5.5 (updated 2026-11-28) bounty chest: 30 min of time with nobody within 50 m (countdown pauses while someone is near)', S.CHEST_LIFETIME_MS === 30 * 60_000 && S.CHEST_PAUSE_RADIUS_M === 50, `${S.CHEST_LIFETIME_MS} ms · ${S.CHEST_PAUSE_RADIUS_M} m`);
check(SEC, 'L9 same-victim collusion limit raised to 5 kills / 10 min', S.COLLUSION_REPEAT_KILL_LIMIT === 5 && S.COLLUSION_WINDOW_MS === 600_000, `${S.COLLUSION_REPEAT_KILL_LIMIT}`);
check(SEC, '§5.1 server tick 20 Hz', S.GAME_TICK_RATE_HZ === 20, `${S.GAME_TICK_RATE_HZ}`);
check(SEC, '§3 log retention 90 days, chat 12 months', S.LOG_RETENTION_DAYS === 90 && S.CHAT_RETENTION_MONTHS === 12);

export const specMathResults = results;
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.filter((r) => r.ok && !r.note).length} passed, ${fail} failed, ${results.filter((r) => r.note).length} notes`);
  process.exitCode = fail ? 1 : 0;
}
