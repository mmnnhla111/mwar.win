import { MAP2D } from '../assets/map2d';
import { PLAY_HALF, ROAD_LINES, ROAD_WIDTH, MAP_HALF } from '../assets/skyAndTerrain';

/**
 * Player-centred, heading-up 2D tactical minimap (drawn on a <canvas>).
 *
 * - Local radius (default 70 m) around the player; the player is fixed at the centre and the map
 *   rotates so "up" is always the camera's look direction (FOV cone + arrow drawn on top).
 * - Geometry comes from the real 3D arena build (MAP2D registry): grass, forest border, asphalt
 *   roads with lane lines, building / house roof footprints, parked vehicles and tree canopies.
 * - Stealth radar: enemies are never shown — only a red pulse for 2 s where a gunshot was fired.
 */
export interface RadarBlip {
  x: number;
  z: number;
  /** performance.now() when the shot was heard. */
  at: number;
}

export const BLIP_LIFETIME_MS = 2000;

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  sizePx: number,
  view: { x: number; z: number; yaw: number; radius?: number; fovDeg?: number },
  blips: RadarBlip[],
  now: number
) {
  const radius = view.radius ?? 70;
  const half = sizePx / 2;
  const scale = half / radius; // px per metre
  const reach = radius * 1.5; // cull distance (corners of the rotated square)

  ctx.save();
  ctx.clearRect(0, 0, sizePx, sizePx);
  // Rounded-square clip
  const r = 14;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(sizePx, 0, sizePx, sizePx, r);
  ctx.arcTo(sizePx, sizePx, 0, sizePx, r);
  ctx.arcTo(0, sizePx, 0, 0, r);
  ctx.arcTo(0, 0, sizePx, 0, r);
  ctx.closePath();
  ctx.clip();

  // World → map: translate to centre, scale, rotate by +yaw so the look direction points up.
  ctx.translate(half, half);
  ctx.scale(scale, scale);
  ctx.rotate(view.yaw);
  ctx.translate(-view.x, -view.z);

  // Forest / mountains outside the playable area, grass inside
  const playHalf = MAP2D.playHalf || PLAY_HALF;
  const mapHalf = MAP2D.mapHalf || MAP_HALF;
  ctx.fillStyle = 'rgba(22, 64, 32, 0.92)';
  ctx.fillRect(-mapHalf - 40, -mapHalf - 40, mapHalf * 2 + 80, mapHalf * 2 + 80);
  ctx.fillStyle = 'rgba(74, 124, 58, 0.88)';
  ctx.fillRect(-playHalf, -playHalf, playHalf * 2, playHalf * 2);

  // Mountains (large map): contour rings
  for (const h of MAP2D.hills) {
    if (Math.abs(h.x - view.x) > reach + h.r || Math.abs(h.z - view.z) > reach + h.r) continue;
    for (let k = 0; k < 5; k++) {
      ctx.fillStyle = `rgba(${110 + k * 18}, ${105 + k * 14}, ${80 + k * 16}, 0.55)`;
      ctx.beginPath();
      ctx.arc(h.x, h.z, h.r * (1 - k * 0.19), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (MAP2D.roads.length) {
    for (const rd of MAP2D.roads) {
      if (Math.abs(rd.x - view.x) > reach + rd.w / 2 || Math.abs(rd.z - view.z) > reach + rd.d / 2) continue;
      ctx.fillStyle = rd.dirt ? 'rgba(146, 116, 80, 0.9)' : 'rgba(51, 55, 62, 0.95)';
      ctx.fillRect(rd.x - rd.w / 2, rd.z - rd.d / 2, rd.w, rd.d);
    }
  } else {
    // Asphalt roads (3×3 grid) + sidewalks + dashed lane lines
    const hw = ROAD_WIDTH / 2;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)'; // sidewalks
    for (const l of ROAD_LINES) {
      ctx.fillRect(l - hw - 2.5, -PLAY_HALF, ROAD_WIDTH + 5, PLAY_HALF * 2);
      ctx.fillRect(-PLAY_HALF, l - hw - 2.5, PLAY_HALF * 2, ROAD_WIDTH + 5);
    }
    ctx.fillStyle = 'rgba(51, 55, 62, 0.95)';
    for (const l of ROAD_LINES) {
      ctx.fillRect(l - hw, -PLAY_HALF, ROAD_WIDTH, PLAY_HALF * 2);
      ctx.fillRect(-PLAY_HALF, l - hw, PLAY_HALF * 2, ROAD_WIDTH);
    }
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
    ctx.lineWidth = 0.35;
    ctx.setLineDash([3, 3]);
    for (const l of ROAD_LINES) {
      ctx.beginPath();
      ctx.moveTo(l, -PLAY_HALF);
      ctx.lineTo(l, PLAY_HALF);
      ctx.moveTo(-PLAY_HALF, l);
      ctx.lineTo(PLAY_HALF, l);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  const near = (x: number, z: number, extra = 0) => Math.abs(x - view.x) < reach + extra && Math.abs(z - view.z) < reach + extra;

  // Buildings / houses (roof footprints + wall outline) and parked vehicles
  for (const rect of MAP2D.rects) {
    if (!near(rect.x, rect.z, Math.max(rect.w, rect.d))) continue;
    const x0 = rect.x - rect.w / 2;
    const z0 = rect.z - rect.d / 2;
    if (rect.kind === 'vehicle') {
      ctx.fillStyle = rect.color ?? '#94a3b8';
      ctx.fillRect(x0, z0, rect.w, rect.d);
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.8)';
      ctx.lineWidth = 0.3;
      ctx.strokeRect(x0, z0, rect.w, rect.d);
    } else {
      ctx.fillStyle = rect.kind === 'house' ? 'rgba(161, 98, 7, 0.9)' : 'rgba(100, 116, 139, 0.95)';
      ctx.fillRect(x0, z0, rect.w, rect.d);
      ctx.strokeStyle = rect.kind === 'house' ? 'rgba(254, 215, 170, 0.85)' : 'rgba(226, 232, 240, 0.85)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(x0, z0, rect.w, rect.d);
    }
  }

  // Tree canopies
  ctx.fillStyle = 'rgba(21, 128, 61, 0.9)';
  for (const t of MAP2D.trees) {
    if (!near(t.x, t.z)) continue;
    ctx.beginPath();
    ctx.arc(t.x, t.z, t.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Gunshot blips (2 s, pulsing then fading)
  for (const b of blips) {
    const age = now - b.at;
    if (age < 0 || age > BLIP_LIFETIME_MS || !near(b.x, b.z)) continue;
    const life = 1 - age / BLIP_LIFETIME_MS;
    const pulse = 1 + 0.6 * Math.abs(Math.sin(age / 140));
    ctx.fillStyle = `rgba(239, 68, 68, ${0.35 * life})`;
    ctx.beginPath();
    ctx.arc(b.x, b.z, (4.5 * pulse) / (scale / 1.6), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(248, 113, 113, ${0.95 * life})`;
    ctx.beginPath();
    ctx.arc(b.x, b.z, 2.2 / (scale / 1.6), 0, Math.PI * 2);
    ctx.fill();
  }

  // Screen-space overlay: FOV cone + player arrow (always pointing up)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const fov = ((view.fovDeg ?? 75) * Math.PI) / 180;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(half, half);
  ctx.arc(half, half, half, -Math.PI / 2 - fov / 2, -Math.PI / 2 + fov / 2);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#facc15';
  ctx.strokeStyle = 'rgba(15,23,42,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(half, half - 7);
  ctx.lineTo(half + 5, half + 5);
  ctx.lineTo(half, half + 2.5);
  ctx.lineTo(half - 5, half + 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
