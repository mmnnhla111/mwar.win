#!/usr/bin/env node
/**
 * i18n key-parity check (no dependencies). Run: pnpm --filter @mwar/web i18n:check
 *  - every locales/*.json has exactly the keys of en.json, all strings, same {placeholders}
 *  - every language marked `enabled: true` in src/i18n/config.ts has a dictionary
 *  - every literal key used in the source (t('…'), tr('…'), tx('…')) exists in en.json
 * Exit code 1 on any problem.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const dir = join(root, 'i18n', 'locales');
const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'));
const enKeys = Object.keys(en);
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
let problems = 0;
const fail = (msg) => {
  problems++;
  console.error(`✗ ${msg}`);
};

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  const lang = file.replace('.json', '');
  const d = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const missing = enKeys.filter((k) => !(k in d));
  const extra = Object.keys(d).filter((k) => !(k in en));
  const badType = Object.keys(d).filter((k) => typeof d[k] !== 'string' || !d[k].trim());
  const badPh = enKeys.filter((k) => k in d && ph(en[k]) !== ph(d[k]));
  if (missing.length) fail(`${lang}: ${missing.length} missing keys: ${missing.slice(0, 10).join(', ')}`);
  if (extra.length) fail(`${lang}: ${extra.length} unknown keys: ${extra.slice(0, 10).join(', ')}`);
  if (badType.length) fail(`${lang}: empty / non-string values: ${badType.slice(0, 10).join(', ')}`);
  if (badPh.length) fail(`${lang}: placeholder mismatch: ${badPh.slice(0, 10).join(', ')}`);
  if (!missing.length && !extra.length && !badType.length && !badPh.length) console.log(`✓ ${lang}: ${Object.keys(d).length} keys`);
}

const config = readFileSync(join(root, 'i18n', 'config.ts'), 'utf8');
for (const m of config.matchAll(/code:\s*'(\w+)'[^}]*enabled:\s*true/g)) {
  if (!existsSync(join(dir, `${m[1]}.json`))) fail(`${m[1]} is enabled in config.ts but locales/${m[1]}.json is missing`);
}

const used = new Set();
const walk = (p) => {
  for (const f of readdirSync(p)) {
    const fp = join(p, f);
    if (statSync(fp).isDirectory()) {
      if (fp === join(root, 'game')) continue; // the 3D game has its own UI text
      walk(fp);
    } else if (/\.(tsx?|jsx?)$/.test(f)) {
      for (const m of readFileSync(fp, 'utf8').matchAll(/\b(?:t|tr|tx|tq)\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.add(m[1]);
    }
  }
};
walk(root);
const unknown = [...used].filter((k) => !(k in en));
if (unknown.length) fail(`keys used in code but missing from en.json: ${unknown.join(', ')}`);
else console.log(`✓ ${used.size} literal keys used in code all exist in en.json (${enKeys.length} total)`);

if (problems) {
  console.error(`\n${problems} problem(s)`);
  process.exit(1);
}
