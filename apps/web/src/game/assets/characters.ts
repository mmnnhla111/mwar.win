import * as THREE from 'three';
import { buildWeaponModel, WeaponId, disposeObject } from '../weapons';
import { Bone, Kind } from './character/geometry';
import {
  CHARACTERS,
  CharacterId,
  CharacterStyle,
  SKEL,
  buildCharacter,
  characterMaterials,
  characterStyleOf,
} from './character/build';

/**
 * Semi-realistic tactical/esports 3D operator models (4 male + 4 female, ~7.5 heads tall) built from
 * sculpted Lathe/Tube/RoundedBox meshes, procedural 512px PBR material atlases and 256px face
 * textures. Used for AI bots, remote players and the Pre-Deploy Loadout selector.
 *
 * Rig faces -Z. Meshes carry userData.hitZone = 'head' | 'body' for hit detection.
 */

export { CHARACTERS };
export type { CharacterId, CharacterStyle };

export const CHARACTER_IDS = CHARACTERS.map((c) => c.id);

export function characterStyle(id: CharacterId) {
  return characterStyleOf(id);
}

export function randomCharacterId(): CharacterId {
  return CHARACTER_IDS[Math.floor(Math.random() * CHARACTER_IDS.length)];
}

/** First-person arm colours (glove, sleeve) for the viewmodel. */
export function characterArmColors(id: CharacterId): { glove: number; sleeve: number } {
  const s = characterStyleOf(id);
  return { glove: s.glove, sleeve: s.sleeve };
}

export interface CharacterRig {
  id: CharacterId;
  root: THREE.Group;
  /** Whole-body group (crouch offset / death fall). */
  body: THREE.Group;
  torso: THREE.Group;
  neck: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  gun: THREE.Group;
  head: THREE.Mesh;
  muzzle: THREE.Object3D;
  hitMeshes: THREE.Mesh[];
  nameTag?: THREE.Sprite;
  weapon: WeaponId;
  setWeapon(id: WeaponId): void;
  dispose(): void;
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

/**
 * §8 floating bounty badge ("💰 162 C") above an enemy: what killing them pays (55 % of their ticket + their
 * head bounty). One canvas sprite per remote player, redrawn only when the text changes.
 */
export interface ValueBadge {
  sprite: THREE.Sprite;
  set(text: string | null): void;
  dispose(): void;
}
export function makeValueBadge(): ValueBadge {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true }));
  sprite.scale.set(1.3, 0.33, 1);
  sprite.position.y = 2.62;
  sprite.renderOrder = 10;
  sprite.visible = false;
  let last: string | null = null;
  return {
    sprite,
    set(text) {
      if (text === last) return;
      last = text;
      sprite.visible = !!text;
      if (!text) return;
      ctx.clearRect(0, 0, 256, 64);
      ctx.fillStyle = 'rgba(66,32,6,0.85)';
      ctx.strokeStyle = 'rgba(250,204,21,0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(6, 8, 244, 48, 16);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fde047';
      ctx.font = 'bold 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 33);
      tex.needsUpdate = true;
    },
    dispose() {
      tex.dispose();
      sprite.material.dispose();
    },
  };
}

export function createCharacter(id: CharacterId, opts: { name?: string; tagColor?: string; weapon?: WeaponId } = {}): CharacterRig {
  const built = buildCharacter(id);
  const mats = characterMaterials();

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const legL = new THREE.Group();
  legL.position.set(-built.hipW, SKEL.hipY, 0);
  body.add(legL);

  const legR = new THREE.Group();
  legR.position.set(built.hipW, SKEL.hipY, 0);
  body.add(legR);

  const kneeL = new THREE.Group();
  kneeL.position.set(0, -SKEL.thigh, 0);
  legL.add(kneeL);

  const kneeR = new THREE.Group();
  kneeR.position.set(0, -SKEL.thigh, 0);
  legR.add(kneeR);

  const torso = new THREE.Group();
  torso.position.set(0, SKEL.torsoY, 0);
  body.add(torso);

  const neck = new THREE.Group();
  neck.position.set(0, SKEL.neckY, 0);
  torso.add(neck);

  const armL = new THREE.Group();
  armL.position.set(-built.sh, SKEL.shoulderY, 0);
  torso.add(armL);

  const armR = new THREE.Group();
  armR.position.set(built.sh, SKEL.shoulderY, 0);
  torso.add(armR);

  const elbowL = new THREE.Group();
  elbowL.position.set(0, -SKEL.upper, 0);
  armL.add(elbowL);

  const elbowR = new THREE.Group();
  elbowR.position.set(0, -SKEL.upper, 0);
  armR.add(elbowR);

  const bones: Record<Bone, THREE.Group> = {
    body,
    torso,
    neck,
    legL,
    legR,
    kneeL,
    kneeR,
    armL,
    armR,
    elbowL,
    elbowR,
  };

  const hitMeshes: THREE.Mesh[] = [];
  const matFor = (kind: Kind): THREE.Material => {
    if (kind === 'glow') return mats.glow;
    if (kind === 'visor') return mats.visor;
    return mats.gear;
  };

  for (const [bone, byKind] of built.parts) {
    const parent = bones[bone];
    for (const [kind, geo] of byKind) {
      const m = new THREE.Mesh(geo, matFor(kind));
      m.castShadow = kind === 'gear' || kind === 'loose';
      m.receiveShadow = kind === 'gear';
      if (kind === 'gear') {
        m.userData.hitZone = bone === 'neck' ? 'head' : 'body';
        hitMeshes.push(m);
      }
      parent.add(m);
    }
  }

  const head = new THREE.Mesh(built.head, built.faceMat);
  head.castShadow = true;
  head.receiveShadow = true;
  head.userData.hitZone = 'head';
  neck.add(head);
  hitMeshes.push(head);

  // ---------------- Weapon (held in front of the chest)
  const gun = new THREE.Group();
  gun.position.set(0.06, 0.3, -0.3);
  torso.add(gun);
  const muzzle = new THREE.Object3D();
  gun.add(muzzle);
  let gunModel: THREE.Group | null = null;
  let weapon: WeaponId = opts.weapon ?? 'm16';
  const setWeapon = (w: WeaponId) => {
    weapon = w;
    if (gunModel) {
      gun.remove(gunModel);
      disposeObject(gunModel);
    }
    const m = buildWeaponModel(w);
    m.group.scale.setScalar(w === 'pistol' ? 0.95 : 0.78);
    m.group.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    gunModel = m.group;
    gun.add(m.group);
    muzzle.position.set(0, m.muzzle.position.y * m.group.scale.x, m.muzzleZ * m.group.scale.x);
    rig.weapon = w;
  };

  let nameTag: THREE.Sprite | undefined;
  if (opts.name) {
    nameTag = makeNameTag(opts.name, opts.tagColor ?? '#fca5a5');
    root.add(nameTag);
  }

  const rig: CharacterRig = {
    id,
    root,
    body,
    torso,
    neck,
    legL,
    legR,
    kneeL,
    kneeR,
    armL,
    armR,
    elbowL,
    elbowR,
    gun,
    head,
    muzzle,
    hitMeshes,
    nameTag,
    weapon,
    setWeapon,
    dispose() {
      // Geometries & character materials are cached/shared across operator instances.
      if (gunModel) disposeObject(gunModel);
      if (nameTag) {
        (nameTag.material as THREE.SpriteMaterial).map?.dispose();
        nameTag.material.dispose();
      }
    },
  };
  setWeapon(weapon);
  animateCharacter(rig, 0, 0, false, 0, 1);
  return rig;
}

const lerp = THREE.MathUtils.lerp;

/**
 * Procedural combat animation: natural breathing idle sway, walk/run stride cycle with knee bend
 * and torso lean, smooth crouch stance, and two-handed weapon grip (supporting hand on foregrip,
 * trigger hand on pistol grip).
 */
export function animateCharacter(rig: CharacterRig, t: number, speed: number, aiming: boolean, crouch = 0, blend = 0.2, prone = 0) {
  if (prone > 0.5) {
    animateProne(rig, t, speed, blend);
    return;
  }
  rig.body.rotation.x = lerp(rig.body.rotation.x, 0, 0.3);
  rig.body.position.z = lerp(rig.body.position.z, 0, 0.3);
  const run = Math.min(1, speed / 5.5);
  const walk = Math.min(1, speed / 2.5);
  const swing = walk * (0.48 + run * 0.36);
  const ph = t * (4.2 + speed * 1.35);
  const s = Math.sin(ph);
  const c = Math.cos(ph);
  const cr = crouch;

  // Natural breathing idle sway (fades out as movement speed increases)
  const idleWeight = 1 - walk;
  const breath = Math.sin(t * 2.1) * idleWeight;
  const idleSway = Math.sin(t * 1.05) * idleWeight;

  // Legs: thigh swing + knee bend on the back-swing; crouch folds both
  const thighBase = cr * 0.95;
  rig.legL.rotation.x = lerp(rig.legL.rotation.x, thighBase + s * swing * (1 - cr * 0.5), 0.5);
  rig.legR.rotation.x = lerp(rig.legR.rotation.x, thighBase - s * swing * (1 - cr * 0.5), 0.5);
  rig.kneeL.rotation.x = lerp(rig.kneeL.rotation.x, -cr * 1.9 - Math.max(0, -c) * swing * 1.3, 0.5);
  rig.kneeR.rotation.x = lerp(rig.kneeR.rotation.x, -cr * 1.9 - Math.max(0, c) * swing * 1.3, 0.5);

  // Body: crouch drop + stride bob + subtle idle breathing lift
  rig.body.position.y = lerp(rig.body.position.y, -cr * 0.38 + Math.abs(s) * 0.035 * swing + breath * 0.006, 0.5);
  rig.torso.rotation.x = lerp(rig.torso.rotation.x, -(run * 0.2 + cr * 0.25) + breath * 0.018, blend);
  rig.torso.rotation.y = lerp(rig.torso.rotation.y, s * swing * 0.13 + idleSway * 0.025, blend);
  rig.neck.rotation.x = lerp(rig.neck.rotation.x, run * 0.13 + cr * 0.2 - breath * 0.015, blend);

  // Arms: two-handed grip (shouldered when aiming, low-ready with subtle stride sway when moving)
  const pistol = rig.weapon === 'pistol';
  const aimAmt = aiming ? 1 : 0;
  const ready = 1 - aimAmt;
  const rShoulderX = aimAmt * (pistol ? 1.42 : 1.24) + ready * (pistol ? 0.9 : 0.78) + ready * s * run * 0.1 + breath * 0.015;
  const lShoulderX = aimAmt * (pistol ? 1.42 : 1.42) + ready * (pistol ? 0.92 : 1.06) - ready * s * run * 0.1 + breath * 0.015;
  rig.armR.rotation.x = lerp(rig.armR.rotation.x, rShoulderX, blend);
  rig.armL.rotation.x = lerp(rig.armL.rotation.x, lShoulderX, blend);
  rig.armR.rotation.z = lerp(rig.armR.rotation.z, pistol ? -0.28 : -0.14, blend);
  rig.armL.rotation.z = lerp(rig.armL.rotation.z, pistol ? 0.44 : 0.52, blend);
  rig.armR.rotation.y = lerp(rig.armR.rotation.y, 0, blend);
  rig.armL.rotation.y = lerp(rig.armL.rotation.y, 0, blend);
  rig.elbowR.rotation.x = lerp(rig.elbowR.rotation.x, pistol ? 0.18 : aimAmt * 0.72 + ready * 0.88, blend);
  rig.elbowL.rotation.x = lerp(rig.elbowL.rotation.x, pistol ? 0.18 : aimAmt * 0.28 + ready * 0.5, blend);

  // Weapon: shouldered at eye line when aiming, angled down at low-ready
  const gy = pistol ? (aiming ? 0.46 : 0.34) : aiming ? 0.44 : 0.29;
  const gz = pistol ? -0.46 : aiming ? -0.3 : -0.28;
  rig.gun.position.y = lerp(rig.gun.position.y, gy + breath * 0.005, blend);
  rig.gun.position.z = lerp(rig.gun.position.z, gz, blend);
  rig.gun.position.x = lerp(rig.gun.position.x, pistol ? 0.0 : 0.07, blend);
  rig.gun.rotation.x = lerp(rig.gun.rotation.x, aiming ? 0 : 0.32 + run * 0.1, blend);
  rig.gun.rotation.y = lerp(rig.gun.rotation.y, aiming ? 0 : -0.14, blend);
}

/** Lying flat: body rotated -90° about x around the feet, then slid back so the chest sits on the player. */
function animateProne(rig: CharacterRig, t: number, speed: number, blend: number) {
  const crawl = Math.min(1, speed / 1.1);
  const ph = t * 5.5;
  const s = Math.sin(ph) * crawl;
  rig.body.rotation.x = lerp(rig.body.rotation.x, -Math.PI / 2, 0.3);
  rig.body.position.z = lerp(rig.body.position.z, 1.0, 0.3);
  rig.body.position.y = lerp(rig.body.position.y, 0.16, 0.3);
  rig.legL.rotation.x = lerp(rig.legL.rotation.x, 0.08 + s * 0.35, 0.5);
  rig.legR.rotation.x = lerp(rig.legR.rotation.x, 0.08 - s * 0.35, 0.5);
  rig.kneeL.rotation.x = lerp(rig.kneeL.rotation.x, -0.15 - Math.max(0, s) * 0.9, 0.5);
  rig.kneeR.rotation.x = lerp(rig.kneeR.rotation.x, -0.15 - Math.max(0, -s) * 0.9, 0.5);
  rig.torso.rotation.x = lerp(rig.torso.rotation.x, 0, blend);
  rig.torso.rotation.y = lerp(rig.torso.rotation.y, s * 0.08, blend);
  rig.neck.rotation.x = lerp(rig.neck.rotation.x, 1.1, blend);
  rig.armR.rotation.x = lerp(rig.armR.rotation.x, 2.85 + s * 0.15, blend);
  rig.armL.rotation.x = lerp(rig.armL.rotation.x, 2.9 - s * 0.15, blend);
  rig.armR.rotation.z = lerp(rig.armR.rotation.z, -0.18, blend);
  rig.armL.rotation.z = lerp(rig.armL.rotation.z, 0.35, blend);
  rig.armR.rotation.y = lerp(rig.armR.rotation.y, 0, blend);
  rig.armL.rotation.y = lerp(rig.armL.rotation.y, 0, blend);
  rig.elbowR.rotation.x = lerp(rig.elbowR.rotation.x, 0.25, blend);
  rig.elbowL.rotation.x = lerp(rig.elbowL.rotation.x, 0.2, blend);
  rig.gun.position.y = lerp(rig.gun.position.y, 0.72, blend);
  rig.gun.position.z = lerp(rig.gun.position.z, -0.14, blend);
  rig.gun.position.x = lerp(rig.gun.position.x, 0.06, blend);
  rig.gun.rotation.x = lerp(rig.gun.rotation.x, Math.PI / 2, blend);
  rig.gun.rotation.y = lerp(rig.gun.rotation.y, 0, blend);
}

/**
 * Renders each operator to a transparent PNG data URL for the Pre-Deploy Loadout selector
 * using 3-point esports studio lighting (key + fill + rim + per-operator accent edge light).
 */
export function renderCharacterPortraits(width = 180, height = 240): Record<CharacterId, string> {
  const out = {} as Record<CharacterId, string>;
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xf1f5f9, 0x1e293b, 1.3));

    const key = new THREE.DirectionalLight(0xfffbeb, 2.5);
    key.position.set(-1.8, 2.6, -2.6);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xcbd5e1, 0.95);
    fill.position.set(1.8, 1.1, -1.6);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0x67e8f9, 1.9);
    rim.position.set(2.2, 2.0, 2.2);
    scene.add(rim);

    const accentRim = new THREE.DirectionalLight(0xffffff, 0.85);
    accentRim.position.set(-2.0, 1.4, 1.8);
    scene.add(accentRim);

    const cam = new THREE.PerspectiveCamera(29, width / height, 0.1, 20);
    cam.position.set(-1.15, 1.18, -3.15);
    cam.lookAt(0, 0.96, 0);

    for (const c of CHARACTERS) {
      accentRim.color.setHex(c.accent);
      const rig = createCharacter(c.id);
      animateCharacter(rig, 0.15, 0, false, 0, 1);
      rig.root.rotation.y = 0.34;
      scene.add(rig.root);
      renderer.clear();
      renderer.render(scene, cam);
      out[c.id] = renderer.domElement.toDataURL('image/png');
      scene.remove(rig.root);
      rig.dispose();
    }
  } catch {
    /* WebGL unavailable: selector falls back to colour swatches */
  } finally {
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
  return out;
}
