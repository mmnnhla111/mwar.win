import * as THREE from 'three';
import { buildGrenadeModel, buildWeaponModel, WeaponId } from './weapons';

/**
 * First-person viewmodel: stylised tactical gloved hands holding a carbine with a red-dot sight.
 *
 * Rendered in its own scene/camera after the world pass (depth cleared) so the weapon never
 * clips into walls and keeps a stable FOV. Procedural animation layers:
 *   idle breathing sway · walk/run bob · mouse-look lag sway · recoil kick + spring recovery
 *   · muzzle flash (sprite + light) · ADS transition aligning the red dot to screen centre
 *   · lean tilt · reload dip · raise/lower when toggling the prop disguise.
 */

export interface ViewmodelInput {
  /** 0 = still, 1 = normal run speed, >1 sprint. */
  moveFactor: number;
  ads: boolean;
  /** -1 (left) … 1 (right) */
  lean: number;
  lookDeltaX: number;
  lookDeltaY: number;
  grounded: boolean;
  crouching: boolean;
  /** 0..1 reload progress, or -1 when not reloading. */
  reload: number;
}

const HIP_ROT = new THREE.Euler(0.02, 0.06, 0.0);
const ADS_ROT = new THREE.Euler(0, 0, 0);

export type ViewItem = WeaponId | 'grenade';

const HIP_POSES: Record<ViewItem, THREE.Vector3> = {
  m16: new THREE.Vector3(0.19, -0.2, -0.44),
  ak47: new THREE.Vector3(0.19, -0.2, -0.44),
  sniper: new THREE.Vector3(0.19, -0.2, -0.4),
  uzi: new THREE.Vector3(0.17, -0.17, -0.38),
  pistol: new THREE.Vector3(0.15, -0.15, -0.34),
  grenade: new THREE.Vector3(0.18, -0.17, -0.36),
};
/** Eye relief: distance from the camera to the sight when aimed. */
const ADS_DEPTH: Record<ViewItem, number> = { m16: -0.3, ak47: -0.26, sniper: -0.2, uzi: -0.28, pistol: -0.36, grenade: -0.36 };

interface ViewSlot {
  item: ViewItem;
  group: THREE.Group;
  muzzle: THREE.Object3D | null;
  mag: THREE.Object3D | null;
  bolt: THREE.Object3D | null;
  magBaseY: number;
  hip: THREE.Vector3;
  ads: THREE.Vector3;
  flashZ: number;
  flashY: number;
}

function makeFlashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.25, 'rgba(255,214,120,0.95)');
  g.addColorStop(0.6, 'rgba(255,140,40,0.35)');
  g.addColorStop(1, 'rgba(255,100,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(255,230,160,0.9)';
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.translate(64, 64);
    ctx.rotate((i / 6) * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(62, 0);
    ctx.lineTo(0, 4);
    ctx.fill();
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent?.add(m);
  return m;
}

function buildHand(glove: THREE.Material, pad: THREE.Material, sleeve: THREE.Material, left: boolean) {
  const hand = new THREE.Group();
  const s = left ? -1 : 1;
  // Palm
  box(0.07, 0.035, 0.085, glove, 0, 0, 0, hand);
  // Knuckle pad
  box(0.072, 0.014, 0.03, pad, 0, 0.022, -0.03, hand);
  // Fingers wrapped around (four curled boxes)
  for (let i = 0; i < 4; i++) {
    const f = box(0.016, 0.018, 0.05, glove, -0.026 + i * 0.0175, -0.02, -0.05, hand);
    f.rotation.x = 1.1;
  }
  // Thumb
  const thumb = box(0.018, 0.018, 0.05, glove, s * -0.04, 0.008, -0.02, hand);
  thumb.rotation.y = s * 0.6;
  // Wrist cuff + forearm sleeve
  box(0.075, 0.05, 0.05, pad, 0, 0, 0.065, hand);
  const fore = new THREE.CylinderGeometry(0.042, 0.05, 0.36, 10);
  fore.rotateX(Math.PI / 2);
  const arm = new THREE.Mesh(fore, sleeve);
  arm.position.set(0, -0.005, 0.26);
  hand.add(arm);
  // Sleeve camo patches
  box(0.03, 0.02, 0.08, pad, 0.03 * s, 0.04, 0.22, hand);
  return hand;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private root = new THREE.Group(); // camera-relative pose
  private weapon = new THREE.Group(); // recoil / bob layer
  private slots = new Map<ViewItem, ViewSlot>();
  private current: ViewSlot;
  private pending: ViewItem | null = null;
  private flash: THREE.Sprite;
  private flashLight: THREE.PointLight;
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private glove: THREE.MeshStandardMaterial;
  private sleeve: THREE.MeshStandardMaterial;

  private time = 0;
  private bobPhase = 0;
  private adsT = 0;
  private recoil = 0; // 0..1 kick energy
  private recoilVel = 0;
  private flashTime = 0;
  private swayX = 0;
  private swayY = 0;
  private leanT = 0;
  private raise = 1; // 1 = shown, 0 = lowered
  private visibleTarget = true;
  private scoped = false;
  private landingDip = 0;
  private boltT = -1;
  private boltDur = 1;
  private throwT = -1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.01, 10);
    this.scene.add(this.camera);
    this.camera.add(this.root);
    this.root.add(this.weapon);

    this.glove = new THREE.MeshStandardMaterial({ color: 0x8a7458, roughness: 0.85 });
    const pad = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.7 });
    this.sleeve = new THREE.MeshStandardMaterial({ color: 0x5f7148, roughness: 0.95 });
    this.materials.push(this.glove, pad, this.sleeve);

    const items: WeaponId[] = ['m16', 'ak47', 'sniper', 'uzi', 'pistol'];
    for (const id of items) {
      const model = buildWeaponModel(id);
      this.materials.push(...model.materials);
      const group = new THREE.Group();
      group.add(model.group);
      const right = buildHand(this.glove, pad, this.sleeve, false);
      right.scale.setScalar(1.2);
      right.position.set(...model.hands.right.pos);
      right.rotation.set(...model.hands.right.rot);
      group.add(right);
      if (model.hands.left) {
        const left = buildHand(this.glove, pad, this.sleeve, true);
        left.scale.setScalar(1.2);
        left.position.set(...model.hands.left.pos);
        left.rotation.set(...model.hands.left.rot);
        group.add(left);
      }
      group.visible = false;
      this.weapon.add(group);
      this.slots.set(id, {
        item: id,
        group,
        muzzle: model.muzzle,
        mag: model.mag,
        bolt: model.bolt,
        magBaseY: model.mag ? model.mag.position.y : 0,
        hip: HIP_POSES[id],
        ads: new THREE.Vector3(0, -model.sightY, ADS_DEPTH[id] - model.sightZ),
        flashZ: model.muzzleZ - 0.06,
        flashY: model.muzzle.position.y,
      });
      group.traverse((o) => ((o as THREE.Mesh).castShadow = false));
    }
    // Grenade in the right hand
    {
      const group = new THREE.Group();
      const g = buildGrenadeModel();
      this.materials.push(...g.materials);
      g.group.scale.setScalar(1.1);
      g.group.position.set(0, 0.0, -0.06);
      group.add(g.group);
      const right = buildHand(this.glove, pad, this.sleeve, false);
      right.scale.setScalar(1.2);
      right.position.set(0.01, -0.05, 0.0);
      right.rotation.set(-0.2, 0.1, -0.2);
      group.add(right);
      group.visible = false;
      this.weapon.add(group);
      this.slots.set('grenade', {
        item: 'grenade',
        group,
        muzzle: null,
        mag: null,
        bolt: null,
        magBaseY: 0,
        hip: HIP_POSES.grenade,
        ads: HIP_POSES.grenade.clone().add(new THREE.Vector3(-0.05, 0.03, 0)),
        flashZ: 0,
        flashY: 0,
      });
    }
    this.current = this.slots.get('m16')!;
    this.current.group.visible = true;

    const flashTex = makeFlashTexture();
    this.textures.push(flashTex);
    const flashMat = new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
    this.materials.push(flashMat);
    this.flash = new THREE.Sprite(flashMat);
    this.flash.scale.setScalar(0.22);
    this.flash.visible = false;
    this.weapon.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffb347, 0, 2.5, 2);
    this.weapon.add(this.flashLight);
    this.placeFlash();

    const hemi = new THREE.HemisphereLight(0xe0f0ff, 0x3a3a30, 1.4);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff1d6, 1.6);
    key.position.set(0.6, 1, 0.4);
    this.scene.add(key);

    this.root.position.copy(this.current.hip);
    this.root.rotation.copy(HIP_ROT);
  }

  private placeFlash() {
    this.flash.position.set(0, this.current.flashY, this.current.flashZ);
    this.flashLight.position.set(0, this.current.flashY + 0.02, this.current.flashZ + 0.04);
  }

  /** Character skin for the first-person arms. */
  setTint(glove: THREE.ColorRepresentation, sleeve: THREE.ColorRepresentation) {
    this.glove.color.set(glove);
    this.sleeve.color.set(sleeve);
  }

  /** Switch the held item (animated lower → swap → raise). */
  setWeapon(item: ViewItem, instant = false) {
    if (item === this.current.item && this.pending === null) return;
    if (instant) {
      this.swapTo(item);
      return;
    }
    this.pending = item;
  }

  get item() {
    return this.pending ?? this.current.item;
  }

  private swapTo(item: ViewItem) {
    this.current.group.visible = false;
    this.current = this.slots.get(item)!;
    this.current.group.visible = true;
    this.boltT = -1;
    this.throwT = -1;
    this.placeFlash();
    this.pending = null;
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 0 = hip, 1 = fully aimed. */
  get adsProgress() {
    return this.adsT;
  }

  /** True while the switch animation is running (no firing). */
  get switching() {
    return this.pending !== null || this.raise < 0.85;
  }

  setVisible(v: boolean) {
    this.visibleTarget = v;
  }

  /** Hide the model while looking through a full-screen sniper scope overlay. */
  setScoped(v: boolean) {
    this.scoped = v;
  }

  fire(kick = 1) {
    this.recoilVel += 9 * kick * (this.adsT > 0.5 ? 0.6 : 1);
    if (!this.current.muzzle) return;
    this.flashTime = 0.055;
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    const base = this.current.item === 'pistol' || this.current.item === 'uzi' ? 0.12 : 0.18;
    this.flash.scale.setScalar(base + Math.random() * 0.1);
  }

  /** Sniper bolt cycle animation. */
  cycleBolt(duration: number) {
    this.boltT = 0;
    this.boltDur = duration;
  }

  /** Grenade / weapon throw swing. */
  throwSwing() {
    this.throwT = 0;
  }

  update(dt: number, input: ViewmodelInput) {
    this.time += dt;
    const ads = input.ads && input.reload < 0 && this.pending === null;
    this.adsT = THREE.MathUtils.damp(this.adsT, ads ? 1 : 0, this.current.item === 'sniper' ? 10 : 14, dt);
    this.leanT = THREE.MathUtils.damp(this.leanT, input.lean, 10, dt);
    const wantRaised = this.visibleTarget && this.pending === null;
    this.raise = THREE.MathUtils.damp(this.raise, wantRaised ? 1 : 0, 12, dt);
    if (this.pending !== null && this.raise < 0.08) this.swapTo(this.pending);
    this.root.visible = this.raise > 0.02 && !(this.scoped && this.adsT > 0.85);

    const a = this.adsT;
    const steady = 1 - a * 0.8;
    const slot = this.current;

    // Pose blend hip ↔ ADS
    this.root.position.lerpVectors(slot.hip, slot.ads, a);
    this.root.rotation.set(
      THREE.MathUtils.lerp(HIP_ROT.x, ADS_ROT.x, a),
      THREE.MathUtils.lerp(HIP_ROT.y, ADS_ROT.y, a),
      THREE.MathUtils.lerp(HIP_ROT.z, ADS_ROT.z, a) + this.leanT * -0.21
    );

    // Breathing
    const breathX = Math.sin(this.time * 0.9) * 0.0035 * steady;
    const breathY = Math.sin(this.time * 1.7) * 0.0045 * steady;

    // Walk / run bob
    const move = input.grounded ? Math.min(1.6, input.moveFactor) : 0;
    this.bobPhase += dt * (6 + move * 5.5) * (move > 0.05 ? 1 : 0);
    const amp = move * (input.crouching ? 0.5 : 1) * steady;
    const bobX = Math.sin(this.bobPhase) * 0.016 * amp;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.014 * amp;
    const bobRot = Math.sin(this.bobPhase) * 0.025 * amp;

    // Look sway (weapon lags behind the view)
    const targetSwayX = THREE.MathUtils.clamp(-input.lookDeltaX * 0.0009, -0.05, 0.05) * steady;
    const targetSwayY = THREE.MathUtils.clamp(input.lookDeltaY * 0.0009, -0.05, 0.05) * steady;
    this.swayX = THREE.MathUtils.damp(this.swayX, targetSwayX, 9, dt);
    this.swayY = THREE.MathUtils.damp(this.swayY, targetSwayY, 9, dt);

    // Recoil spring
    const k = 180;
    const c = 22;
    this.recoilVel += (-k * this.recoil - c * this.recoilVel) * dt;
    this.recoil += this.recoilVel * dt;

    // Landing dip
    if (!input.grounded) this.landingDip = Math.min(1, this.landingDip + dt * 2);
    else this.landingDip = THREE.MathUtils.damp(this.landingDip, 0, 8, dt);

    // Reload: dip + roll the weapon, drop/insert the magazine
    let reloadDip = 0;
    let reloadRoll = 0;
    if (input.reload >= 0) {
      const r = input.reload;
      const env = Math.sin(Math.min(1, r) * Math.PI);
      reloadDip = env * 0.09;
      reloadRoll = env * 0.7;
      const magOut = r < 0.5 ? Math.min(1, r / 0.25) : Math.max(0, 1 - (r - 0.5) / 0.3);
      if (slot.mag) slot.mag.position.y = slot.magBaseY - magOut * 0.18;
    } else if (slot.mag) {
      slot.mag.position.y = slot.magBaseY;
    }

    // Sniper bolt cycle: lift, pull back, push, lower
    let boltDip = 0;
    if (this.boltT >= 0) {
      this.boltT += dt / this.boltDur;
      const b = Math.min(1, this.boltT);
      const env = Math.sin(b * Math.PI);
      boltDip = env * 0.035;
      if (slot.bolt) {
        slot.bolt.rotation.z = Math.min(1, b * 4) * (b < 0.75 ? 1.2 : Math.max(0, 1.2 - (b - 0.75) * 4.8));
        slot.bolt.position.z = 0.06 + Math.sin(Math.min(1, Math.max(0, (b - 0.2) / 0.55)) * Math.PI) * 0.07;
      }
      if (this.boltT >= 1) this.boltT = -1;
    }

    // Throw swing (grenade): pull back then snap forward
    let throwZ = 0;
    let throwY = 0;
    let throwRot = 0;
    if (this.throwT >= 0) {
      this.throwT += dt / 0.45;
      const tt = Math.min(1, this.throwT);
      const back = tt < 0.4 ? tt / 0.4 : Math.max(0, 1 - (tt - 0.4) / 0.25);
      const fwd = tt < 0.4 ? 0 : Math.sin(Math.min(1, (tt - 0.4) / 0.6) * Math.PI);
      throwZ = back * 0.12 - fwd * 0.25;
      throwY = back * 0.08 + fwd * 0.04;
      throwRot = back * 0.8 - fwd * 0.9;
      if (this.throwT >= 1) this.throwT = -1;
    }

    const lowered = (1 - this.raise) * 0.35;
    this.weapon.position.set(
      breathX + bobX + this.swayX * 0.6,
      breathY + bobY + this.swayY * 0.6 - reloadDip - boltDip - lowered - this.landingDip * 0.01 + throwY,
      this.recoil * 0.06 + throwZ
    );
    this.weapon.rotation.set(
      this.recoil * 0.09 + this.swayY + reloadDip * 0.6 + boltDip * 2 + throwRot - lowered * 1.5,
      this.swayX + bobRot * 0.4,
      bobRot + reloadRoll
    );

    // Muzzle flash
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      this.flash.visible = true;
      this.flashLight.intensity = 6;
    } else {
      this.flash.visible = false;
      this.flashLight.intensity = 0;
    }

    // Narrow viewmodel FOV slightly when aiming for a magnified feel
    const fov = THREE.MathUtils.lerp(52, 40, a);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  render(renderer: THREE.WebGLRenderer) {
    if (!this.root.visible) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}
