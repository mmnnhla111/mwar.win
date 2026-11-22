import * as THREE from 'three';

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

const HIP_POS = new THREE.Vector3(0.19, -0.2, -0.44);
const HIP_ROT = new THREE.Euler(0.02, 0.06, 0.0);
// The red-dot sits at weapon-local y = SIGHT_Y; ADS moves it onto the camera axis.
const SIGHT_Y = 0.112;
const ADS_POS = new THREE.Vector3(0, -SIGHT_Y, -0.36);
const ADS_ROT = new THREE.Euler(0, 0, 0);

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

function cyl(rt: number, rb: number, len: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, seg = 12) {
  const g = new THREE.CylinderGeometry(rt, rb, len, seg);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function buildRifle() {
  const rifle = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.45, metalness: 0.6 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.7, metalness: 0.1 });
  const tan = new THREE.MeshStandardMaterial({ color: 0x9c8462, roughness: 0.8, metalness: 0.05 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.3, metalness: 0.9 });

  // Receiver (upper + lower)
  box(0.068, 0.07, 0.36, metal, 0, 0.035, -0.04, rifle);
  box(0.062, 0.05, 0.26, metal, 0, -0.022, 0.0, rifle);
  // Picatinny rail with teeth
  box(0.044, 0.012, 0.42, steel, 0, 0.077, -0.1, rifle);
  // Handguard (tan) with vents
  box(0.078, 0.078, 0.32, tan, 0, 0.03, -0.38, rifle);
  for (let i = 0; i < 5; i++) box(0.081, 0.012, 0.03, polymer, 0, 0.03, -0.27 - i * 0.055, rifle);
  // Barrel, gas block, muzzle brake
  cyl(0.012, 0.012, 0.24, steel, 0, 0.03, -0.64, rifle);
  box(0.03, 0.03, 0.035, metal, 0, 0.035, -0.56, rifle);
  const muzzle = cyl(0.019, 0.019, 0.075, metal, 0, 0.03, -0.79, rifle);
  // Front sight post
  box(0.012, 0.05, 0.012, metal, 0, 0.1, -0.5, rifle);
  // Magazine (curved look via two angled boxes)
  const mag = new THREE.Group();
  box(0.042, 0.11, 0.075, polymer, 0, -0.055, 0, mag);
  const magLow = box(0.042, 0.1, 0.075, polymer, 0, -0.15, 0.018, mag);
  magLow.rotation.x = 0.28;
  mag.position.set(0, -0.045, -0.12);
  mag.rotation.x = 0.12;
  rifle.add(mag);
  // Magwell + trigger guard
  box(0.05, 0.03, 0.09, metal, 0, -0.05, -0.12, rifle);
  box(0.012, 0.012, 0.07, metal, 0, -0.08, -0.02, rifle);
  // Pistol grip
  const grip = box(0.042, 0.12, 0.055, polymer, 0, -0.1, 0.06, rifle);
  grip.rotation.x = -0.32;
  // Buffer tube + stock
  cyl(0.018, 0.018, 0.16, metal, 0, 0.03, 0.2, rifle);
  box(0.05, 0.09, 0.2, tan, 0, 0.005, 0.32, rifle);
  box(0.055, 0.12, 0.03, polymer, 0, -0.005, 0.43, rifle);
  // Charging handle + ejection port
  box(0.07, 0.015, 0.03, steel, 0, 0.065, 0.12, rifle);
  box(0.004, 0.025, 0.07, steel, 0.036, 0.04, -0.02, rifle);
  // Red-dot sight
  const sight = new THREE.Group();
  box(0.036, 0.016, 0.09, metal, 0, 0.091, -0.06, sight);
  const tube = new THREE.CylinderGeometry(0.024, 0.024, 0.07, 18, 1, true);
  tube.rotateX(Math.PI / 2);
  const tubeMesh = new THREE.Mesh(tube, new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
  tubeMesh.position.set(0, SIGHT_Y, -0.06);
  sight.add(tubeMesh);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.022, 20),
    new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.16, depthWrite: false })
  );
  lens.position.set(0, SIGHT_Y, -0.09);
  sight.add(lens);
  const dotMat = new THREE.SpriteMaterial({ color: 0xff2a2a, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
  const dot = new THREE.Sprite(dotMat);
  dot.scale.setScalar(0.0045);
  dot.position.set(0, SIGHT_Y, -0.095);
  dot.renderOrder = 10;
  sight.add(dot);
  rifle.add(sight);

  rifle.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false;
  });
  return { rifle, muzzle, mag, dot, materials: [metal, polymer, tan, steel, dotMat] };
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
  private muzzle: THREE.Object3D;
  private mag: THREE.Object3D;
  private flash: THREE.Sprite;
  private flashLight: THREE.PointLight;
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];

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
  private landingDip = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.01, 10);
    this.scene.add(this.camera);
    this.camera.add(this.root);
    this.root.add(this.weapon);

    const { rifle, muzzle, mag, materials } = buildRifle();
    this.materials.push(...materials);
    this.muzzle = muzzle;
    this.mag = mag;
    this.weapon.add(rifle);

    const glove = new THREE.MeshStandardMaterial({ color: 0x8a7458, roughness: 0.85 });
    const pad = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.7 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x5f7148, roughness: 0.95 });
    this.materials.push(glove, pad, sleeve);
    // Right hand wraps the pistol grip; forearm runs back towards the lower-right of the screen.
    const right = buildHand(glove, pad, sleeve, false);
    right.scale.setScalar(1.2);
    right.position.set(0.012, -0.095, 0.075);
    right.rotation.set(-0.55, 0.12, -0.25);
    this.weapon.add(right);
    // Left hand cups the handguard from below; forearm angles back-left.
    const left = buildHand(glove, pad, sleeve, true);
    left.scale.setScalar(1.2);
    left.position.set(-0.03, -0.035, -0.4);
    left.rotation.set(0.25, 0.55, 0.35);
    this.weapon.add(left);
    const flashTex = makeFlashTexture();
    this.textures.push(flashTex);
    const flashMat = new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
    this.materials.push(flashMat);
    this.flash = new THREE.Sprite(flashMat);
    this.flash.scale.setScalar(0.22);
    this.flash.position.set(0, 0.03, -0.86);
    this.flash.visible = false;
    this.weapon.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffb347, 0, 2.5, 2);
    this.flashLight.position.set(0, 0.05, -0.8);
    this.weapon.add(this.flashLight);

    const hemi = new THREE.HemisphereLight(0xe0f0ff, 0x3a3a30, 1.4);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff1d6, 1.6);
    key.position.set(0.6, 1, 0.4);
    this.scene.add(key);

    this.root.position.copy(HIP_POS);
    this.root.rotation.copy(HIP_ROT);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 0 = hip, 1 = fully aimed. */
  get adsProgress() {
    return this.adsT;
  }

  /** World-independent muzzle position projected to NDC (for tracers drawn from the gun). */
  muzzleNdc(out: THREE.Vector3) {
    this.muzzle.getWorldPosition(out);
    return out.project(this.camera);
  }

  setVisible(v: boolean) {
    this.visibleTarget = v;
  }

  fire() {
    this.recoilVel += 9 * (this.adsT > 0.5 ? 0.6 : 1);
    this.flashTime = 0.055;
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.18 + Math.random() * 0.1);
  }

  update(dt: number, input: ViewmodelInput) {
    this.time += dt;
    const ads = input.ads && input.reload < 0;
    this.adsT = THREE.MathUtils.damp(this.adsT, ads ? 1 : 0, 14, dt);
    this.leanT = THREE.MathUtils.damp(this.leanT, input.lean, 10, dt);
    this.raise = THREE.MathUtils.damp(this.raise, this.visibleTarget ? 1 : 0, 10, dt);
    this.root.visible = this.raise > 0.02;

    const a = this.adsT;
    const steady = 1 - a * 0.8;

    // Pose blend hip ↔ ADS
    this.root.position.lerpVectors(HIP_POS, ADS_POS, a);
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
      this.mag.position.y = -0.045 - magOut * 0.18;
    } else {
      this.mag.position.y = -0.045;
    }

    const lowered = (1 - this.raise) * 0.35;
    this.weapon.position.set(
      breathX + bobX + this.swayX * 0.6,
      breathY + bobY + this.swayY * 0.6 - reloadDip - lowered - this.landingDip * 0.01,
      this.recoil * 0.06
    );
    this.weapon.rotation.set(
      this.recoil * 0.09 + this.swayY + reloadDip * 0.6,
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
