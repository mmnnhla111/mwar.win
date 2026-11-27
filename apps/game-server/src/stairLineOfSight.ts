/**
 * Server-side bullet blocking by solid staircases (V1.1 round 4).
 *
 * The room validates a shot by checking the segment shooter-eye to target against the solid stair
 * volumes of the map the room runs on (the same step blocks the client collision world registers, from
 * @mwar/shared stairData). It is deliberately conservative: ONLY stair blocks occlude here, nothing else
 * (walls, props, terrain) - so a legitimate hit can never be rejected because of an incomplete server
 * model. A target is treated as covered only when the eye-to-head, eye-to-chest AND eye-to-feet rays are
 * all blocked; a partly visible target can still be hit.
 */
import { LARGE_MAP_STAIRS, SMALL_MAP_STAIRS, StairIndex, stairFromTuple } from '@mwar/shared';

let smallIndex: StairIndex | null = null;
let largeIndex: StairIndex | null = null;

export function stairIndexForMap(large: boolean): StairIndex {
  if (large) return (largeIndex ??= new StairIndex(LARGE_MAP_STAIRS.map(stairFromTuple)));
  return (smallIndex ??= new StairIndex(SMALL_MAP_STAIRS.map(stairFromTuple)));
}

const EYE: Record<string, number> = { stand: 1.7, crouch: 1.05, prone: 0.4 };
const BODY: Record<string, number> = { stand: 1.8, crouch: 1.2, prone: 0.5 };
/** Ignore a stair contact this close to either end (shooter standing on / target standing on a tread). */
const END_MARGIN = 0.35;

interface Pos {
  x: number;
  y: number;
  z: number;
  stance?: string;
}

/** True when solid stairs hide the whole target body from the shooter's eye. */
export function shotBlockedByStairs(index: StairIndex, shooter: Pos, target: Pos): boolean {
  if (index.boxCount === 0) return false;
  const ex = shooter.x;
  const ey = shooter.y + (EYE[shooter.stance ?? 'stand'] ?? EYE.stand);
  const ez = shooter.z;
  const h = BODY[target.stance ?? 'stand'] ?? BODY.stand;
  for (const f of [0.9, 0.5, 0.12]) {
    if (!index.blocksSegment(ex, ey, ez, target.x, target.y + h * f, target.z, END_MARGIN)) return false;
  }
  return true;
}
