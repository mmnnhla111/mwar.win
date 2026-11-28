/**
 * Audit H1 — server-authoritative ballistics against the REAL client maps (node:test; runs with test:geometry).
 *  1. the obstacle data shipped to the game server matches the client map builders
 *  2. a 563 m shot (the audit's exploit) and shots beyond each weapon's range are refused
 *  3. a shot through a building / wall is refused, while a clear line-of-sight shot is accepted
 *  4. the server and the client's own world raycast agree on what is visible (random pairs on both maps)
 *  5. aim cone + server-side headshot (a client "headshot" claim is irrelevant; the hit height decides)
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weaponMaxShotRange } from '@mwar/shared';
import { buildMaps } from '../../../scripts/headlessMaps';
import { collectObstacles } from '../../../scripts/gen-obstacle-data';
import { validateShot, EYE_HEIGHT, BODY_HEIGHT } from '../../../../game-server/src/ballistics';
import type { CollisionWorld } from '../physics/collision';

let maps: Awaited<ReturnType<typeof buildMaps>>;
before(async () => {
  maps = await buildMaps();
});

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
/** yaw that faces from a to b (client convention: forward = (-sin yaw, -cos yaw)). */
const face = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
/** A standing spot on the ground of `w`, not inside anything. */
function standingSpot(w: CollisionWorld, r: () => number, half: number) {
  for (let i = 0; i < 200; i++) {
    const x = (r() * 2 - 1) * half * 0.9;
    const z = (r() * 2 - 1) * half * 0.9;
    const y = w.groundHeightAt(x, z, 0.36, 3);
    if (y > 1) continue; // stay on street level (not on roofs)
    if (w.pointInSolid(x, y + 0.9, z) || w.pointInSolid(x, y + 1.7, z)) continue;
    return { x, y, z, stance: 'stand' as const };
  }
  throw new Error('no free spot');
}

test('server obstacle data matches the client map builders (regenerate with: pnpm --filter @mwar/web gen:obstacles)', async () => {
  const want = await collectObstacles();
  const file = JSON.parse(readFileSync(new URL('../../../../game-server/src/maps/obstacles.json', import.meta.url), 'utf8'));
  assert.deepEqual(file.small, want.small, 'small map obstacles drifted');
  assert.deepEqual(file.large, want.large, 'large map obstacles drifted');
  assert.ok(file.large.length / 6 > 10_000 && file.small.length / 6 > 1_000);
});

test('range: a 563 m shot is refused for every weapon; each weapon hits just inside its range', () => {
  // open sky above the 960 m map: nothing in between, only range decides
  const shooter = { x: -300, y: 400, z: 0, stance: 'stand', rotationY: face({ x: -300, z: 0 }, { x: 263, z: 0 }) };
  for (const w of ['sniper', 'ak47', 'm16', 'uzi', 'pistol']) {
    const far = validateShot({ shooter, target: { x: 263, y: 400, z: 0, stance: 'stand' }, weapon: w, largeMap: true });
    assert.equal(far.ok, false, `${w} at ~563 m must be refused`);
    assert.equal(far.reason, 'range');
    const max = weaponMaxShotRange(w);
    const tx = -300 + max - 1.5;
    const near = validateShot({ shooter: { ...shooter, rotationY: face(shooter, { x: tx, z: 0 }) }, target: { x: tx, y: 400, z: 0, stance: 'stand' }, weapon: w, largeMap: true });
    assert.equal(near.ok, true, `${w} just inside ${max.toFixed(1)} m must hit (${near.reason})`);
  }
});

test('walls: a shot through a building is refused, a clear line of sight is accepted (small + large map)', () => {
  for (const [name, w, large, half] of [['small', maps.smallWorld, false, 100], ['large', maps.largeWorld, true, 420]] as const) {
    const r = rng(large ? 7 : 3);
    let blocked = 0;
    let clear = 0;
    for (let i = 0; i < 4000 && (blocked < 5 || clear < 5); i++) {
      const a = standingSpot(w, r, half);
      const ang = r() * Math.PI * 2;
      const d = 8 + r() * 30; // within AK range
      const bx = a.x + Math.cos(ang) * d;
      const bz = a.z + Math.sin(ang) * d;
      const by = w.groundHeightAt(bx, bz, 0.36, 3);
      if (by > 1 || w.pointInSolid(bx, by + 0.9, bz) || w.pointInSolid(bx, by + 1.7, bz)) continue;
      const b = { x: bx, y: by, z: bz, stance: 'stand' as const };
      const eyeY = a.y + EYE_HEIGHT.stand;
      const pts = [0.92, 0.55, 0.3, 0.12].map((f) => by + BODY_HEIGHT.stand * f);
      const clientSeesAny = pts.some((py) => w.lineOfSight(a.x, eyeY, a.z, bx, py, bz));
      const clientSeesNone = pts.every((py) => !w.lineOfSight(a.x, eyeY, a.z, bx, py, bz));
      const v = validateShot({ shooter: { ...a, rotationY: face(a, b) }, target: b, weapon: 'ak47', largeMap: large });
      if (clientSeesNone && blocked < 5) {
        assert.equal(v.ok, false, `${name}: target behind a wall must be refused (${a.x.toFixed(1)},${a.z.toFixed(1)} → ${bx.toFixed(1)},${bz.toFixed(1)})`);
        assert.equal(v.reason, 'blocked');
        blocked++;
      } else if (clientSeesAny && clear < 5) {
        const pts2 = pts.filter((py) => w.lineOfSight(a.x, eyeY, a.z, bx, py, bz));
        if (pts2.length === pts.length) {
          assert.equal(v.ok, true, `${name}: target in plain view must be hit (${v.reason})`);
          clear++;
        }
      }
    }
    assert.ok(blocked >= 5 && clear >= 5, `${name}: found ${blocked} walled / ${clear} clear pairs`);
  }
});

test('server and client agree on visibility for random shooter/target pairs (≥ 97 %)', () => {
  for (const [name, w, large, half] of [['small', maps.smallWorld, false, 100], ['large', maps.largeWorld, true, 420]] as const) {
    const r = rng(large ? 11 : 5);
    let n = 0;
    let agree = 0;
    const diffs: string[] = [];
    while (n < 400) {
      const a = standingSpot(w, r, half);
      const ang = r() * Math.PI * 2;
      const d = 5 + r() * 45;
      const bx = a.x + Math.cos(ang) * d;
      const bz = a.z + Math.sin(ang) * d;
      const by = w.groundHeightAt(bx, bz, 0.36, 3);
      if (by > 1 || w.pointInSolid(bx, by + 0.9, bz) || w.pointInSolid(bx, by + 1.7, bz)) continue;
      n++;
      const eyeY = a.y + EYE_HEIGHT.stand;
      const client = [0.92, 0.55, 0.3, 0.12].some((f) => w.lineOfSight(a.x, eyeY, a.z, bx, by + BODY_HEIGHT.stand * f, bz));
      const b = { x: bx, y: by, z: bz, stance: 'stand' as const };
      const v = validateShot({ shooter: { ...a, rotationY: face(a, b) }, target: b, weapon: 'm16', largeMap: large });
      if (v.ok === client) agree++;
      else if (diffs.length < 3) diffs.push(`client ${client} server ${v.ok}/${v.reason}`);
    }
    assert.ok(agree / n >= 0.97, `${name}: agreement ${((agree / n) * 100).toFixed(1)} % (${diffs.join('; ')})`);
  }
});

test('aim cone: shooting a target behind you is refused; headshot is decided by the server from the hit height', () => {
  const shooter = { x: 0, y: 400, z: 0, stance: 'stand', rotationY: face({ x: 0, z: 0 }, { x: 0, z: -20 }) };
  const ahead = { x: 0, y: 400, z: -20, stance: 'stand' };
  const behind = { x: 0, y: 400, z: 20, stance: 'stand' };
  assert.equal(validateShot({ shooter, target: ahead, weapon: 'ak47', largeMap: true }).ok, true);
  const back = validateShot({ shooter, target: behind, weapon: 'ak47', largeMap: true });
  assert.equal(back.ok, false);
  assert.equal(back.reason, 'aim');
  // a spoofed shot yaw more than 90° away from the reported facing is ignored
  assert.equal(validateShot({ shooter, target: behind, weapon: 'ak47', aimYaw: face(shooter, behind), largeMap: true }).ok, false);
  // head height on a standing target → headshot; chest height → body; no hit point → body
  assert.equal(validateShot({ shooter, target: ahead, weapon: 'ak47', hit: { x: 0, y: 400 + 1.7, z: -20 }, largeMap: true }).headshot, true);
  assert.equal(validateShot({ shooter, target: ahead, weapon: 'ak47', hit: { x: 0, y: 400 + 1.0, z: -20 }, largeMap: true }).headshot, false);
  assert.equal(validateShot({ shooter, target: ahead, weapon: 'ak47', largeMap: true }).headshot, false);
  // a crouching target's head is lower: 1.7 m is above it (hit point outside the body → not a headshot)
  assert.equal(validateShot({ shooter, target: { ...ahead, stance: 'crouch' }, weapon: 'ak47', hit: { x: 0, y: 400 + 1.7, z: -20 }, largeMap: true }).headshot, false);
  assert.equal(validateShot({ shooter, target: { ...ahead, stance: 'crouch' }, weapon: 'ak47', hit: { x: 0, y: 400 + 1.1, z: -20 }, largeMap: true }).headshot, true);
  // a "hit point" 5 m away from the target is not believed
  assert.equal(validateShot({ shooter, target: ahead, weapon: 'ak47', hit: { x: 5, y: 401.7, z: -20 }, largeMap: true }).headshot, false);
});

test('performance: validateShot stays cheap on the 960 m map (1,000 players × 2 shots/s budget)', () => {
  const r = rng(99);
  const pairs: Array<[Parameters<typeof validateShot>[0]]> = [];
  for (let i = 0; i < 5000; i++) {
    const a = { x: (r() * 2 - 1) * 400, y: 0, z: (r() * 2 - 1) * 400, stance: 'stand' };
    const ang = r() * Math.PI * 2;
    const d = r() * 55;
    const b = { x: a.x + Math.cos(ang) * d, y: 0, z: a.z + Math.sin(ang) * d, stance: 'stand' };
    pairs.push([{ shooter: { ...a, rotationY: face(a, b) }, target: b, weapon: 'm16', largeMap: true }]);
  }
  const t0 = performance.now();
  for (const [p] of pairs) validateShot(p);
  const perShotUs = ((performance.now() - t0) * 1000) / pairs.length;
  // 2,000 shots/s must cost well under one CPU core
  assert.ok(perShotUs < 100, `${perShotUs.toFixed(1)} µs per shot`);
});
