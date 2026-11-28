/**
 * Regenerates apps/game-server/src/maps/obstacles.json from the client map builders: every static
 * bullet-blocking box (buildings, walls, cover, stairs, props) of both maps, for the game server's
 * server-authoritative ballistics (audit H1).
 * Run: pnpm --filter @mwar/web gen:obstacles   (a geometry test fails when the file drifts from the builders)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { obstaclesToFlat } from '@mwar/shared';
import { buildMaps } from './headlessMaps';

export async function collectObstacles() {
  const { smallWorld, largeWorld } = await buildMaps();
  const pick = (w: typeof smallWorld) => obstaclesToFlat(w.allBoxes.filter((b) => b.blocksBullets));
  return { small: pick(smallWorld), large: pick(largeWorld) };
}

export function renderObstacleJson(o: { small: number[]; large: number[] }): string {
  return JSON.stringify({ generatedBy: 'apps/web/scripts/gen-obstacle-data.ts', small: o.small, large: o.large });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  collectObstacles().then((o) => {
    const out = new URL('../../game-server/src/maps/obstacles.json', import.meta.url);
    writeFileSync(out, renderObstacleJson(o));
    console.log(`obstacles.json written: small=${o.small.length / 6} boxes, large=${o.large.length / 6} boxes`);
  });
}
