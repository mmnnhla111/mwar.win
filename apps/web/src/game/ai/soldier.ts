import * as THREE from 'three';

/**
 * Stylised low-poly soldier used for AI bots and remote players.
 * Child meshes carry userData.hitZone = 'head' | 'body' for hit detection.
 */

export interface SoldierRig {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  gun: THREE.Group;
  head: THREE.Mesh;
  muzzle: THREE.Object3D;
  hitMeshes: THREE.Mesh[];
  nameTag?: THREE.Sprite;
  dispose(): void;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function boxGeo(w: number, h: number, d: number) {
  const k = `${w}|${h}|${d}`;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
}

function part(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, zone?: 'head' | 'body') {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  if (zone) m.userData.hitZone = zone;
  parent.add(m);
  return m;
}

function makeNameTag(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(2,6,23,0.7)';
  ctx.beginPath();
  ctx.roundRect(4, 8, 248, 48, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  s.scale.set(1.4, 0.35, 1);
  s.position.y = 2.25;
  return s;
}

export function createSoldier(opts: { uniform: number; vest: number; accent: number; name?: string; tagColor?: string }): SoldierRig {
  const uniform = new THREE.MeshStandardMaterial({ color: opts.uniform, roughness: 0.9 });
  const vest = new THREE.MeshStandardMaterial({ color: opts.vest, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89f7c, roughness: 0.7 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: opts.vest, roughness: 0.6, metalness: 0.1 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141618, roughness: 0.6, metalness: 0.4 });
  const accent = new THREE.MeshBasicMaterial({ color: opts.accent, toneMapped: false });
  const mats = [uniform, vest, skin, helmetMat, black, accent];

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Legs (pivot at hip)
  const mkLeg = (x: number) => {
    const leg = new THREE.Group();
    leg.position.set(x, 0.92, 0);
    part(0.2, 0.48, 0.22, uniform, 0, -0.24, 0, leg, 'body');
    part(0.18, 0.42, 0.2, uniform, 0, -0.68, 0, leg, 'body');
    part(0.2, 0.1, 0.3, black, 0, -0.87, -0.04, leg);
    part(0.21, 0.12, 0.23, vest, 0, -0.45, -0.01, leg); // knee pad
    body.add(leg);
    return leg;
  };
  const legL = mkLeg(-0.13);
  const legR = mkLeg(0.13);

  // Torso
  part(0.5, 0.62, 0.3, uniform, 0, 1.22, 0, body, 'body');
  part(0.54, 0.46, 0.36, vest, 0, 1.28, 0, body, 'body');
  part(0.16, 0.12, 0.06, vest, -0.12, 1.12, -0.2, body); // pouches
  part(0.16, 0.12, 0.06, vest, 0.12, 1.12, -0.2, body);
  part(0.3, 0.22, 0.12, vest, 0, 1.34, 0.22, body); // backpack
  part(0.06, 0.06, 0.02, accent, 0.16, 1.45, -0.19, body); // team light
  // Head
  const head = part(0.24, 0.26, 0.25, skin, 0, 1.7, 0, body, 'head');
  part(0.3, 0.13, 0.31, helmetMat, 0, 1.85, 0.0, body, 'head');
  part(0.32, 0.03, 0.34, helmetMat, 0, 1.79, 0.0, body, 'head');
  part(0.2, 0.06, 0.03, black, 0, 1.72, -0.13, body, 'head'); // goggles
  part(0.18, 0.05, 0.02, accent, 0, 1.72, -0.145, body);

  // Arms holding the rifle
  const mkArm = (x: number) => {
    const arm = new THREE.Group();
    arm.position.set(x, 1.48, 0);
    part(0.15, 0.36, 0.16, uniform, 0, -0.17, 0, arm, 'body');
    part(0.13, 0.3, 0.14, uniform, 0, -0.42, -0.06, arm, 'body');
    part(0.11, 0.1, 0.12, black, 0, -0.58, -0.1, arm);
    body.add(arm);
    return arm;
  };
  const armL = mkArm(-0.3);
  const armR = mkArm(0.3);
  armL.rotation.set(-1.15, 0, -0.35);
  armR.rotation.set(-0.9, 0, 0.25);

  const gun = new THREE.Group();
  part(0.06, 0.09, 0.62, black, 0, 0, -0.1, gun);
  part(0.04, 0.12, 0.06, black, 0, -0.09, -0.05, gun);
  part(0.05, 0.08, 0.2, black, 0, -0.01, 0.3, gun);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.45);
  gun.add(muzzle);
  gun.position.set(0.1, 1.28, -0.32);
  body.add(gun);

  let nameTag: THREE.Sprite | undefined;
  if (opts.name) {
    nameTag = makeNameTag(opts.name, opts.tagColor ?? '#fca5a5');
    root.add(nameTag);
  }

  const hitMeshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData.hitZone) hitMeshes.push(m);
  });

  return {
    root,
    body,
    legL,
    legR,
    armL,
    armR,
    gun,
    head,
    muzzle,
    hitMeshes,
    nameTag,
    dispose() {
      mats.forEach((m) => m.dispose());
      if (nameTag) {
        (nameTag.material as THREE.SpriteMaterial).map?.dispose();
        nameTag.material.dispose();
      }
    },
  };
}

/** Walk cycle + aim pose. */
export function animateSoldier(rig: SoldierRig, t: number, speed: number, aiming: boolean, crouch = 0) {
  const swing = Math.min(1, speed / 4) * 0.7;
  const ph = t * (4 + speed * 1.4);
  rig.legL.rotation.x = Math.sin(ph) * swing;
  rig.legR.rotation.x = -Math.sin(ph) * swing;
  rig.body.position.y = -crouch * 0.35 + Math.abs(Math.sin(ph)) * 0.04 * swing;
  const aimPitch = aiming ? -1.45 : -1.05;
  rig.armL.rotation.x = THREE.MathUtils.lerp(rig.armL.rotation.x, aimPitch - 0.1, 0.2);
  rig.armR.rotation.x = THREE.MathUtils.lerp(rig.armR.rotation.x, aimPitch + 0.15, 0.2);
  rig.gun.position.y = THREE.MathUtils.lerp(rig.gun.position.y, aiming ? 1.42 : 1.22, 0.2);
  rig.gun.rotation.x = THREE.MathUtils.lerp(rig.gun.rotation.x, aiming ? 0 : 0.35, 0.2);
}
