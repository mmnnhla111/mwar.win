/**
 * 03-country-economics.mjs — what one ad / one Energy Ticket / one kill is worth in each country, computed with
 * the SAME shared functions the Worker uses (eCPM table, default slot multipliers, −8 % haircut, 55/15/5/5/20).
 * Writes .local-audit/country-economics.json and prints a markdown table.
 *
 *   node tests/local-audit/03-country-economics.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, STATE_DIR } from './lib.mjs';

const S = await import(pathToFileURL(path.join(ROOT, 'packages/shared/dist/index.mjs')).href);
const M = S.DEFAULT_AD_MULTIPLIERS;
const HAIRCUT = 0.92;
const rows = [];
for (const [cc, e] of Object.entries(S.COUNTRY_AD_ECPM_USD)) {
  const v30 = S.getStatisticalAdMicroUsd(cc, 'video_30s');
  // Monetag direct link (15 s, default multiplier) — the main real EC source
  const dlEff = S.getEffectiveAdMicroUsd(cc, 'monetag_direct', M.monetag_direct);
  const dlBp = S.getAdEcProgressBp(cc, dlEff);
  const dlSafe = S.safeAdMicroUsd(Math.min(dlEff, S.getStatisticalAdMicroUsd(cc, 'video_15s')), HAIRCUT);
  // Adsterra 320x50 banner (30–45 s)
  const bnEff = S.getEffectiveAdMicroUsd(cc, 'adsterra_320x50', M.adsterra_320x50);
  const bnBp = S.getAdEcProgressBp(cc, bnEff);
  const bnSafe = S.safeAdMicroUsd(Math.min(bnEff, S.getStatisticalAdMicroUsd(cc, 'banner')), HAIRCUT);
  const visitsPerTicket = dlBp > 0 ? 10_000 / dlBp : Infinity;
  const bannersPerTicket = bnBp > 0 ? 10_000 / bnBp : Infinity;
  const ticket = Math.round(dlSafe * visitsPerTicket); // ≈ 0.92 × 30 s video value
  const split = S.calculateRewardSplit(ticket, [1, 2, 3, 4, 5].map((d) => ({ userId: `u${d}`, depth: d })));
  const shooter = Number(split.earnerMicroUsd);
  rows.push({
    cc, tier: e.tier, v30,
    directLink: { grossMicroUsd: dlEff, safeMicroUsd: dlSafe, ecPct: dlBp / 100 },
    banner: { grossMicroUsd: bnEff, safeMicroUsd: bnSafe, ecPct: bnBp / 100, minutesPerTicket: (bannersPerTicket * 37.5) / 60 },
    visitsPerTicket, bannersPerTicket,
    ticketMicroUsd: ticket,
    killShooterMicroUsd: shooter,
    killL1MicroUsd: Number(split.uplinePayouts[0].amountMicroUsd),
    killsFor10Usd: Math.ceil(10_000_000 / Math.max(1, shooter)),
    platformPerKill: Number(split.platformTotalMicroUsd) + Math.round(ticket / HAIRCUT - ticket),
  });
}
rows.sort((a, b) => b.ticketMicroUsd - a.ticketMicroUsd);
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(STATE_DIR, 'country-economics.json'), JSON.stringify(rows, null, 2));
const c = (m) => (m / 100).toFixed(2);
console.log('| ประเทศ | Direct link 15s (C, EC%) | แบนเนอร์ (C, EC%) | ดูกี่ครั้ง/1 EC (DL / แบนเนอร์) | มูลค่าตั๋ว 1 EC | ผู้ยิงได้/คิล | L1 ได้/คิล | คิลเพื่อถอน $10 |');
console.log('|:--|--:|--:|--:|--:|--:|--:|--:|');
for (const r of rows)
  console.log(`| ${r.cc} | ${c(r.directLink.safeMicroUsd)} C · ${r.directLink.ecPct.toFixed(1)}% | ${c(r.banner.safeMicroUsd)} C · ${r.banner.ecPct.toFixed(1)}% | ${r.visitsPerTicket.toFixed(1)} / ${r.bannersPerTicket.toFixed(0)} (~${r.banner.minutesPerTicket.toFixed(0)} นาที) | ${c(r.ticketMicroUsd)} C ($${(r.ticketMicroUsd / 1e6).toFixed(4)}) | ${c(r.killShooterMicroUsd)} C | ${c(r.killL1MicroUsd)} C | ${r.killsFor10Usd.toLocaleString()} |`);
