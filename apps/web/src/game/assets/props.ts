import * as THREE from 'three';
import { Frame, Kit } from './kit';
import { textureFactories } from './materials';
import { map2dVehicle } from './map2d';
import { PROP_PLACEMENT_READY, placeDisguiseProp } from './propPlacement';

/**
 * Tactical cover & interactive props: streetlights, sandbag bunkers, Jersey barriers,
 * wooden crates (identical to the 'C' prop disguise), parked vehicles, barrels and the glowing
 * 15-second Bounty Treasure Chest. Static props are batched + collidable via the Kit; dynamic
 * ones (disguise crate, chests) are standalone groups.
 *
 * Sandbag bunkers, crate stacks, barrels and benches are built from the REAL Prop-Hunt disguise props
 * (placeDisguiseProp) so a hider morphed into one blends in perfectly. The hand-drawn look-alikes below
 * remain as a fallback while PROP_PLACEMENT_READY is false.
 */

export function placeStreetlight(kit: Kit, x: number, z: number, quarterTurns: number) {
  const f = new Frame(x, z, quarterTurns);
  kit.solid(f, 'metal', 0x374151, 0, 0, 0, 0.22, 6.2, 0.22, { walkable: false });
  kit.deco(f, 'concrete', 0x9ca3af, 0, 0, 0, 0.5, 0.3, 0.5);
  kit.deco(f, 'metal', 0x374151, 0, 6.0, 0.8, 0.12, 0.12, 1.6);
  kit.deco(f, 'metal', 0x1f2937, 0, 5.85, 1.5, 0.45, 0.2, 0.7);
  kit.deco(f, 'emissive', 0xfff3c4, 0, 5.78, 1.5, 0.36, 0.06, 0.56, false);
  const [lx, lz] = f.toWorld(0, 1.5);
  return new THREE.Vector3(lx, 5.7, lz);
}

export function placeJerseyBarrier(kit: Kit, x: number, z: number, quarterTurns: number, color: THREE.ColorRepresentation = 0xd4d4d8) {
  const f = new Frame(x, z, quarterTurns);
  // Tapered profile built from 3 stacked boxes; one collider for the whole barrier.
  kit.deco(f, 'concrete', color, 0, 0, 0, 3.0, 0.3, 0.8);
  kit.deco(f, 'concrete', color, 0, 0.3, 0, 3.0, 0.35, 0.5);
  kit.deco(f, 'concrete', color, 0, 0.65, 0, 3.0, 0.4, 0.3);
  kit.deco(f, 'trim', 0xef4444, 0, 0.85, 0, 3.02, 0.08, 0.32, false);
  kit.solid(f, 'concrete', color, 0, 0, 0, 3.0, 1.05, 0.6, { visual: false });
}

export function placeSandbagBunker(kit: Kit, x: number, z: number, quarterTurns: number) {
  const f = new Frame(x, z, quarterTurns);
  if (PROP_PLACEMENT_READY) {
    // U-shaped nest from real sandbag_barrier pieces (1.8 × 0.8 × 0.9): 2-piece back wall + one piece per flank.
    placeDisguiseProp(kit, f, 'sandbag_barrier', -0.9, 0, -1.4, 0);
    placeDisguiseProp(kit, f, 'sandbag_barrier', 0.9, 0, -1.4, 0);
    placeDisguiseProp(kit, f, 'sandbag_barrier', -1.4, 0, -0.1, 1);
    placeDisguiseProp(kit, f, 'sandbag_barrier', 1.4, 0, -0.1, 3);
    return;
  }
  const bag = (cx: number, cz: number, y: number, alongX: boolean) =>
    kit.deco(f, 'fabric', 0xc2b280, cx, y, cz, alongX ? 0.7 : 0.42, 0.3, alongX ? 0.42 : 0.7);
  for (let row = 0; row < 4; row++) {
    const y = row * 0.29;
    const off = row % 2 ? 0.35 : 0;
    for (let i = 0; i < 5; i++) bag(-1.75 + off + i * 0.7, -1.4, y, true);
    for (let i = 0; i < 3; i++) {
      bag(-1.9, -0.7 + i * 0.7 + off * 0.5, y, false);
      bag(1.9, -0.7 + i * 0.7 + off * 0.5, y, false);
    }
  }
  kit.solid(f, 'fabric', 0xc2b280, 0, 0, -1.4, 4.0, 1.16, 0.45, { visual: false });
  kit.solid(f, 'fabric', 0xc2b280, -1.9, 0, 0.1, 0.45, 1.16, 2.6, { visual: false });
  kit.solid(f, 'fabric', 0xc2b280, 1.9, 0, 0.1, 0.45, 1.16, 2.6, { visual: false });
}

export function placeCrateStack(kit: Kit, x: number, z: number, quarterTurns: number, tall = false) {
  const f = new Frame(x, z, quarterTurns);
  if (PROP_PLACEMENT_READY) {
    placeDisguiseProp(kit, f, 'supply_crate', 0, 0, 0, 0);
    placeDisguiseProp(kit, f, 'supply_crate', 1.3, 0, 0.1, 0);
    placeDisguiseProp(kit, f, 'supply_crate', 0.65, 1.2, 0.05, 0);
    if (tall) placeDisguiseProp(kit, f, 'supply_crate', 0.65, 2.4, 0.05, 0);
    return;
  }
  const crate = (cx: number, y: number, cz: number, s: number) => {
    kit.solid(f, 'wood', 0xc08a4b, cx, y, cz, s, s, s);
    // Dark slats on the crate faces
    kit.deco(f, 'trim', 0x6b3e17, cx, y + s * 0.47, cz, s + 0.02, s * 0.06, s + 0.02, false);
    kit.deco(f, 'trim', 0x6b3e17, cx, y + 0.02, cz, s + 0.02, s * 0.06, s + 0.02, false);
  };
  crate(0, 0, 0, 1.2);
  crate(1.3, 0, 0.1, 1.2);
  crate(0.6, 1.2, 0.05, 1.1);
  if (tall) crate(0.6, 2.3, 0.05, 1.0);
}

export function placeBarrels(kit: Kit, x: number, z: number, color: THREE.ColorRepresentation = 0x1d4ed8) {
  const f = new Frame(x, z, 0);
  if (PROP_PLACEMENT_READY) {
    // Real oil_drum props (the colour argument only applies to the fallback look-alike).
    placeDisguiseProp(kit, f, 'oil_drum', 0, 0, 0, 0);
    placeDisguiseProp(kit, f, 'oil_drum', 0.8, 0, 0.1, 0);
    placeDisguiseProp(kit, f, 'oil_drum', 0.4, 0, 0.8, 0);
    return;
  }
  const spots: [number, number][] = [
    [0, 0],
    [0.75, 0.1],
    [0.35, 0.68],
  ];
  for (const [bx, bz] of spots) {
    const g = new THREE.CylinderGeometry(0.33, 0.33, 1.0, 14);
    kit.geometry(f, 'metal', color, g, bx, 0.5, bz);
    const ring = new THREE.CylinderGeometry(0.345, 0.345, 0.06, 14);
    kit.geometry(f, 'metal', 0x111827, ring, bx, 0.7, bz, 0, false);
    kit.solid(f, 'metal', color, bx, 0, bz, 0.6, 1.0, 0.6, { visual: false });
  }
}

export function placeVehicle(kit: Kit, x: number, z: number, quarterTurns: number, color: THREE.ColorRepresentation, kind: 'sedan' | 'suv' | 'truck' = 'sedan') {
  const f = new Frame(x, z, quarterTurns);
  const len = kind === 'truck' ? 6.4 : kind === 'suv' ? 4.8 : 4.4;
  const h = kind === 'sedan' ? 0.75 : 0.95;
  map2dVehicle(x, z, quarterTurns, 1.9, len, `#${new THREE.Color(color).getHexString()}`);
  // Body (car points along local z)
  kit.solid(f, 'metal', color, 0, 0.35, 0, 1.9, h, len);
  if (kind === 'truck') {
    kit.solid(f, 'metal', color, 0, 0.35 + h, -len / 2 + 1.1, 1.9, 1.0, 2.0);
    kit.deco(f, 'glass', 0x1e293b, 0, 0.45 + h, -len / 2 + 0.08, 1.7, 0.7, 0.04, false);
    kit.deco(f, 'metal', 0x3f3f46, 0, 0.35 + h, 1.0, 1.9, 0.5, 3.6);
  } else {
    const cabin = kind === 'suv' ? 2.8 : 2.2;
    kit.solid(f, 'metal', color, 0, 0.35 + h, kind === 'suv' ? 0.3 : 0.1, 1.75, 0.6, cabin, { walkable: true });
    kit.deco(f, 'glass', 0x0f172a, 0, 0.4 + h, (kind === 'suv' ? 0.3 : 0.1) - cabin / 2 - 0.01, 1.6, 0.48, 0.04, false);
    kit.deco(f, 'glass', 0x0f172a, 0.885, 0.4 + h, kind === 'suv' ? 0.3 : 0.1, 0.02, 0.45, cabin - 0.3, false);
    kit.deco(f, 'glass', 0x0f172a, -0.885, 0.4 + h, kind === 'suv' ? 0.3 : 0.1, 0.02, 0.45, cabin - 0.3, false);
  }
  // Wheels
  for (const sx of [-0.88, 0.88]) {
    for (const sz of [-len / 2 + 0.85, len / 2 - 0.85]) {
      const g = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14);
      g.rotateZ(Math.PI / 2);
      kit.geometry(f, 'metal', 0x0a0a0a, g, sx, 0.36, sz);
    }
  }
  kit.deco(f, 'emissive', 0xfef9c3, 0.65, 0.65, -len / 2 - 0.01, 0.3, 0.12, 0.03, false);
  kit.deco(f, 'emissive', 0xfef9c3, -0.65, 0.65, -len / 2 - 0.01, 0.3, 0.12, 0.03, false);
  kit.deco(f, 'emissive', 0xdc2626, 0.65, 0.65, len / 2 + 0.01, 0.3, 0.12, 0.03, false);
  kit.deco(f, 'emissive', 0xdc2626, -0.65, 0.65, len / 2 + 0.01, 0.3, 0.12, 0.03, false);
}

export function placeBench(kit: Kit, x: number, z: number, quarterTurns: number) {
  const f = new Frame(x, z, quarterTurns);
  if (PROP_PLACEMENT_READY) {
    // legacy bench seat faces local -z; real props face +z at turn 0
    placeDisguiseProp(kit, f, 'park_bench', 0, 0, 0, 2);
    return;
  }
  kit.solid(f, 'wood', 0x92400e, 0, 0.42, 0, 1.8, 0.08, 0.5);
  kit.deco(f, 'wood', 0x92400e, 0, 0.5, 0.22, 1.8, 0.45, 0.06);
  kit.deco(f, 'metal', 0x1f2937, -0.8, 0, 0, 0.08, 0.42, 0.45);
  kit.deco(f, 'metal', 0x1f2937, 0.8, 0, 0, 0.08, 0.42, 0.45);
  kit.solid(f, 'wood', 0x92400e, 0, 0, 0, 1.8, 0.5, 0.5, { visual: false });
}

// ---------------------------------------------------------------------------------------------
// Dynamic props
// ---------------------------------------------------------------------------------------------

let crateTexture: THREE.Texture | null = null;
function getCrateTexture() {
  if (!crateTexture) crateTexture = textureFactories.wood();
  return crateTexture;
}

/** Wooden supply crate (1.2 m) — the same model used for the 'C' prop-hide disguise. */
export function createWoodenCrate(size = 1.2): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ map: getCrateTexture(), color: 0xd29a5a, roughness: 0.85 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b3e17, roughness: 0.9 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
  box.position.y = size / 2;
  box.castShadow = true;
  box.receiveShadow = true;
  g.add(box);
  const e = size + 0.02;
  const bar = 0.09;
  const edges: [number, number, number, number, number, number][] = [
    [0, 0.05, 0, e, bar, e],
    [0, size - 0.05, 0, e, bar, e],
  ];
  for (const [x, y, z, w, h, d] of edges) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
    m.position.set(x, y, z);
    g.add(m);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(bar, size, bar), frameMat);
      post.position.set((sx * size) / 2, size / 2, (sz * size) / 2);
      g.add(post);
    }
  }
  // Diagonal brace on two faces
  for (const side of [-1, 1]) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(size * 1.3, bar, 0.04), frameMat);
    brace.rotation.z = Math.PI / 4;
    brace.position.set(0, size / 2, (side * (size + 0.03)) / 2);
    g.add(brace);
  }
  return g;
}

/** Glowing 15-second Bounty Treasure Chest with pulsing light, aura ring and countdown ring. */
export function createBountyChest(isDeathDrop = false): THREE.Group {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({
    color: isDeathDrop ? 0xd97706 : 0xf59e0b,
    roughness: 0.3,
    metalness: 0.85,
    emissive: isDeathDrop ? 0x92400e : 0xb45309,
    emissiveIntensity: 0.65,
  });
  const wood = new THREE.MeshStandardMaterial({ color: 0x7c2d12, roughness: 0.7, map: getCrateTexture() });
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.85), wood);
  base.position.y = 0.3;
  base.castShadow = true;
  g.add(base);
  const lidGeo = new THREE.CylinderGeometry(0.425, 0.425, 1.2, 16, 1, false, 0, Math.PI);
  lidGeo.rotateZ(Math.PI / 2);
  const lid = new THREE.Mesh(lidGeo, wood);
  lid.position.y = 0.6;
  lid.castShadow = true;
  g.add(lid);
  for (const x of [-0.45, 0, 0.45]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.62, 0.88), gold);
    band.position.set(x, 0.3, 0);
    g.add(band);
    const bandTop = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.05, 6, 16, Math.PI), gold);
    bandTop.rotation.y = Math.PI / 2;
    bandTop.position.set(x, 0.6, 0);
    g.add(bandTop);
  }
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.06), gold);
  lock.position.set(0, 0.55, -0.45);
  g.add(lock);
  const light = new THREE.PointLight(0xfbbf24, 2.2, 8, 1.6);
  light.position.y = 1.4;
  g.add(light);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.05, 8, 32), new THREE.MeshBasicMaterial({ color: 0xfef08a, toneMapped: false }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  g.add(ring);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.6, 9, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
  );
  beam.position.y = 4.5;
  g.add(beam);
  g.userData.light = light;
  g.userData.ring = ring;
  g.userData.beam = beam;
  g.userData.spawnTime = performance.now();
  return g;
}

/** Per-frame chest animation: bob, spin, pulsing glow. */
export function animateBountyChest(g: THREE.Group, nowMs: number) {
  const t = nowMs * 0.001;
  const baseY = (g.userData.baseY as number) ?? g.position.y;
  if (g.userData.baseY === undefined) g.userData.baseY = baseY;
  g.position.y = baseY + Math.sin(t * 3) * 0.08 + 0.08;
  g.rotation.y += 0.015;
  const light = g.userData.light as THREE.PointLight | undefined;
  if (light) light.intensity = 1.6 + Math.sin(t * 6) * 0.8;
  const ring = g.userData.ring as THREE.Mesh | undefined;
  if (ring) ring.scale.setScalar(1 + Math.sin(t * 4) * 0.08);
}
