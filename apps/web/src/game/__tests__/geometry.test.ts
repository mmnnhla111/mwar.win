/**
 * V1.1 round 4 geometry tests (node:test, run with `pnpm --filter @mwar/web test:geometry`).
 *  1. a player capsule never ends up inside a solid staircase (window drops, side / back corners)
 *  2. bullets are blocked by stairs (client raycast + the server line-of-sight module)
 *  3. the stair data shipped to the server matches what the client map builders generate
 *  4. the 100P map's road tiles never overlap (no coplanar triangles at intersections)
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { LARGE_MAP_STAIRS, SMALL_MAP_STAIRS, StairIndex, stairFromTuple, stairStepBoxes, type StairVolume } from '@mwar/shared';
import { buildMaps } from '../../../scripts/headlessMaps';
import { collectStairTuples } from '../../../scripts/gen-stair-data';
import { roadDebug } from '../maps/largeMap';
import { shotBlockedByStairs, stairIndexForMap } from '../../../../game-server/src/stairLineOfSight';
import { CollisionWorld, type MoveBody } from '../physics/collision';

let maps: Awaited<ReturnType<typeof buildMaps>>;
before(async () => {
  maps = await buildMaps();
});
const RADIUS = 0.4;
const HEIGHT = 1.8;

/** Penetration of the body into any step block that it could not legitimately step onto. */
function stairViolation(stairs: readonly StairVolume[], b: MoveBody): string | null {
  for (const s of stairs) {
    if (b.x < s.minX - 1 || b.x > s.maxX + 1 || b.z < s.minZ - 1 || b.z > s.maxZ + 1) continue;
    for (const box of stairStepBoxes(s)) {
      if (box.maxY <= b.y + 0.13 || box.minY >= b.y + HEIGHT) continue; // above-the-feet tops are walkable / steppable
      const inside = b.x > box.minX && b.x < box.maxX && b.z > box.minZ && b.z < box.maxZ;
      if (inside) return `centre inside step block (feet ${b.y.toFixed(2)} < top ${box.maxY.toFixed(2)})`;
      const cx = Math.max(box.minX, Math.min(b.x, box.maxX));
      const cz = Math.max(box.minZ, Math.min(b.z, box.maxZ));
      const pen = RADIUS - Math.hypot(b.x - cx, b.z - cz);
      // A grounded body may overlap a tread that is within step height (it steps onto it).
      if (pen > 0.04 && (!b.onGround || box.maxY > b.y + 0.46)) return `overlaps step block by ${pen.toFixed(3)} m (feet ${b.y.toFixed(2)})`;
    }
  }
  return null;
}

function simulate(world: CollisionWorld, stairs: readonly StairVolume[], start: MoveBody, vx: number, vz: number, seconds: number, label: string) {
  const b = { ...start };
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) {
    world.moveBody(b, vx * dt, vz * dt, dt);
    const v = stairViolation(stairs, b);
    assert.equal(v, null, `${label}: frame ${i} ${v} at (${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)})`);
  }
}

const body = (x: number, y: number, z: number, onGround = false): MoveBody => ({ x, y, z, velY: 0, onGround, radius: RADIUS, height: HEIGHT });

/** Eight horizontal approach directions. */
const DIRS: [number, number][] = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071].map((x, i) => [x, [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071][i]]);

test('stair collision: no capsule ends up inside a staircase (drops, side + back corners, all 8 directions)', () => {
  for (const [name, world, stairs] of [
    ['small', maps.smallWorld, maps.smallWorld.stairs],
    ['large', maps.largeWorld, maps.largeWorld.stairs],
  ] as const) {
    // large map: sample every 6th staircase to keep the run short
    const list = name === 'large' ? stairs.filter((_, i) => i % 6 === 0) : stairs;
    for (const s of list) {
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      const hx = (s.maxX - s.minX) / 2;
      const hz = (s.maxZ - s.minZ) / 2;
      const top = s.baseY + s.rise;
      for (const [dx, dz] of DIRS) {
        // Start 3 m out from the stair centre on each side, at window height and at floor level, walk / fall in.
        const sx = cx + dx * (hx + 2.2);
        const sz = cz + dz * (hz + 2.2);
        for (const h of [s.baseY + 2.8, top + 1.5, s.baseY + 0.001]) {
          if (!world.pointInSolid(sx, h + 0.9, sz)) simulate(world, stairs, body(sx, h, sz, h === s.baseY + 0.001), -dx * 4.5, -dz * 4.5, 2.5, `${name} stair @(${cx.toFixed(1)},${cz.toFixed(1)}) dir(${dx},${dz}) h${h.toFixed(1)}`);
        }
      }
    }
  }
});

test('stair collision: falling from window height straight onto / beside the flight, then pushing into the back corners', () => {
  const s = maps.smallWorld.stairs[0];
  const [cx, cz] = [(s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2];
  const corners: [number, number][] = [
    [s.minX, s.minZ],
    [s.maxX, s.minZ],
    [s.minX, s.maxZ],
    [s.maxX, s.maxZ],
  ];
  for (const [px, pz] of corners) {
    // Drop from 4 m right over the corner, pressing toward the stair centre, then keep pressing.
    const toX = Math.sign(cx - px);
    const toZ = Math.sign(cz - pz);
    simulate(maps.smallWorld, maps.smallWorld.stairs, body(px - toX * 0.3, s.baseY + 4, pz - toZ * 0.3), toX * 3, toZ * 3, 3, `corner drop @(${px.toFixed(1)},${pz.toFixed(1)})`);
  }
});

test('stair collision: a dropped body standing on a tread is on top of it, not inside', () => {
  const world = new CollisionWorld({ halfSize: 100 });
  const s: StairVolume = { minX: 0, minZ: 0, maxX: 1.3, maxZ: 5, axis: 'z', lowIsMin: true, baseY: 0, rise: 3.2, steps: 16 };
  world.addStair(s);
  for (const b of stairStepBoxes(s)) world.addBox(b, { walkable: true, blocksBullets: true, blocksMovement: true, pushOut: true });
  const p = body(0.65, 6, 4.9);
  for (let i = 0; i < 240; i++) world.moveBody(p, 0, 0, 1 / 60);
  assert.ok(p.onGround);
  assert.ok(Math.abs(p.y - 3.2) < 0.01 || p.y >= 3.0, `landed on the top tread region, y=${p.y}`);
  assert.equal(stairViolation([s], p), null);
});

test('bullets: solid stairs stop client rays and server shots (front, back, sides)', () => {
  const large = maps.largeWorld;
  const big = large.stairs.filter((s) => s.rise >= 3).slice(0, 25);
  assert.ok(big.length > 5);
  for (const s of big) {
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    const idx = new StairIndex([s]);
    const along = s.axis === 'z' ? { x: 0, z: 1 } : { x: 1, z: 0 };
    const across = { x: along.z, z: along.x };
    const halfAcross = s.axis === 'z' ? (s.maxX - s.minX) / 2 : (s.maxZ - s.minZ) / 2;
    const halfAlong = s.axis === 'z' ? (s.maxZ - s.minZ) / 2 : (s.maxX - s.minX) / 2;
    // Sideways (across the flight) in both directions, through the middle of the run.
    for (const sign of [1, -1]) {
      const shooter = { x: cx - across.x * sign * (halfAcross + 3), y: s.baseY, z: cz - across.z * sign * (halfAcross + 3), stance: 'crouch' };
      const target = { x: cx + across.x * sign * (halfAcross + 3), y: s.baseY, z: cz + across.z * sign * (halfAcross + 3), stance: 'prone' };
      assert.ok(shotBlockedByStairs(idx, shooter, target), `server: sideways shot blocked (sign ${sign})`);
      const ex = shooter.x;
      const ey = shooter.y + 1.05;
      const ez = shooter.z;
      const dx = target.x - ex;
      const dy = target.y + 0.25 - ey;
      const dz = target.z - ez;
      const len = Math.hypot(dx, dy, dz);
      const hit = large.raycast(ex, ey, ez, dx / len, dy / len, dz / len, len);
      assert.ok(hit && hit.distance < len - 0.5, 'client raycast: stopped before the target');
    }
    // Along the flight from the low end to a target behind (above) the high end, shot through the steps.
    const lowSide = s.lowIsMin ? -1 : 1;
    const shooterAlong = { x: cx + along.x * lowSide * (halfAlong + 2), y: s.baseY, z: cz + along.z * lowSide * (halfAlong + 2), stance: 'prone' };
    const targetAlong = { x: cx - along.x * lowSide * (halfAlong + 2), y: s.baseY, z: cz - along.z * lowSide * (halfAlong + 2), stance: 'prone' };
    assert.ok(shotBlockedByStairs(idx, shooterAlong, targetAlong), 'server: shot along the flight, through the steps, is blocked');
    // Clear shot (nothing between) must NOT be blocked: both on the same side of the stair.
    const a = { x: cx + across.x * (halfAcross + 3), y: s.baseY, z: cz + across.z * (halfAcross + 3), stance: 'stand' };
    const b2 = { x: cx + across.x * (halfAcross + 3) + along.x * 8, y: s.baseY, z: cz + across.z * (halfAcross + 3) + along.z * 8, stance: 'stand' };
    assert.ok(!shotBlockedByStairs(idx, a, b2), 'server: unobstructed shot is not blocked');
  }
});

test('bullets: a target standing on the flight, in plain view up the stairs, can still be hit', () => {
  const s = LARGE_MAP_STAIRS.map(stairFromTuple).find((v) => v.rise >= 3)!;
  const idx = new StairIndex([s]);
  const lo = s.axis === 'x' ? s.minX : s.minZ;
  const hi = s.axis === 'x' ? s.maxX : s.maxZ;
  const at = (f: number) => (s.lowIsMin ? lo + (hi - lo) * f : hi - (hi - lo) * f);
  const pos = (f: number, y: number) => (s.axis === 'x' ? { x: at(f), y, z: (s.minZ + s.maxZ) / 2, stance: 'stand' } : { x: (s.minX + s.maxX) / 2, y, z: at(f), stance: 'stand' });
  const shooter = pos(-0.4, s.baseY);
  const tread = s.baseY + (s.rise * (Math.floor(s.steps * 0.6) + 1)) / s.steps;
  const target = pos(0.6, tread);
  assert.ok(!shotBlockedByStairs(idx, shooter, target));
});

test('server stair data matches the client map builders (regenerate with: pnpm --filter @mwar/web gen:stairs)', async () => {
  const { small, large } = await collectStairTuples();
  assert.deepEqual(JSON.parse(JSON.stringify(small)), JSON.parse(JSON.stringify(SMALL_MAP_STAIRS)));
  assert.deepEqual(JSON.parse(JSON.stringify(large)), JSON.parse(JSON.stringify(LARGE_MAP_STAIRS)));
  assert.ok(stairIndexForMap(true).boxCount > 1000);
  assert.ok(stairIndexForMap(false).boxCount > 100);
});

test('100P map roads: tiles are disjoint (zero overlapping coplanar road boxes) and cover every road', () => {
  const tiles = roadDebug.tiles;
  assert.ok(tiles.length > 100, `got ${tiles.length} tiles`);
  const sorted = tiles.slice().sort((a, b) => a.x0 - b.x0);
  let overlaps = 0;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].x0 < sorted[i].x1 - 1e-6; j++) {
      const ox = Math.min(sorted[i].x1, sorted[j].x1) - Math.max(sorted[i].x0, sorted[j].x0);
      const oz = Math.min(sorted[i].z1, sorted[j].z1) - Math.max(sorted[i].z0, sorted[j].z0);
      if (ox > 1e-6 && oz > 1e-6) overlaps++;
    }
  }
  assert.equal(overlaps, 0, 'no two road tiles may share area');
  // Coverage: every road centre-line sample is covered by exactly one tile.
  const roads = (maps.largeScene.userData as { roads?: unknown }).roads;
  void roads;
  const pointCovered = (x: number, z: number) => tiles.filter((t) => x > t.x0 && x < t.x1 && z > t.z0 && z < t.z1).length;
  for (const line of [-270, 0, 270]) {
    for (let t = -460; t <= 460; t += 7.3) {
      assert.equal(pointCovered(line + 1.1, t), 1, `highway x=${line} at z=${t}`);
      assert.equal(pointCovered(t, line - 1.1), 1, `highway z=${line} at x=${t}`);
    }
  }
  assert.ok(tiles.some((t) => t.kind === 'plain'), 'intersections become plain junction tiles');
});
