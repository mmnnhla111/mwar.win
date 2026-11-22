import * as THREE from 'three';

/** Bullet tracers, impact sparks and bullet-hole decals (pooled, allocation-free per shot). */
export class CombatEffects {
  private tracers: { line: THREE.Line; life: number; max: number }[] = [];
  private sparks: { pts: THREE.Points; vel: Float32Array; life: number }[] = [];
  private decals: THREE.Mesh[] = [];
  private decalIndex = 0;
  private group = new THREE.Group();
  private tracerMat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, toneMapped: false });
  private enemyTracerMat = new THREE.LineBasicMaterial({ color: 0xff6b5b, transparent: true, opacity: 0.9, toneMapped: false });
  private sparkMat = new THREE.PointsMaterial({ color: 0xffd27a, size: 0.035, transparent: true, depthWrite: false, toneMapped: false });
  private decalMat = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  private decalGeo = new THREE.CircleGeometry(0.06, 8);
  private blasts: { flash: THREE.Sprite; light: THREE.PointLight; smoke: THREE.Sprite[]; smokeVel: THREE.Vector3[]; life: number }[] = [];
  private flashTex: THREE.Texture | null = null;
  private smokeTex: THREE.Texture | null = null;

  private radialTex(inner: string, outer: string) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Grenade explosion: fireball flash, light pulse, rising smoke, debris sparks and a scorch mark. */
  explosion(point: THREE.Vector3) {
    if (!this.flashTex) this.flashTex = this.radialTex('rgba(255,245,200,1)', 'rgba(255,120,20,0)');
    if (!this.smokeTex) this.smokeTex = this.radialTex('rgba(90,90,90,0.85)', 'rgba(60,60,60,0)');
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    flash.position.copy(point).add(new THREE.Vector3(0, 0.6, 0));
    flash.scale.setScalar(1);
    this.group.add(flash);
    const light = new THREE.PointLight(0xffa040, 40, 18, 2);
    light.position.copy(flash.position);
    this.group.add(light);
    const smoke: THREE.Sprite[] = [];
    const smokeVel: THREE.Vector3[] = [];
    for (let i = 0; i < 9; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, depthWrite: false, transparent: true, opacity: 0.0 }));
      s.position.copy(point).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.3 + Math.random() * 0.6, (Math.random() - 0.5) * 1.2));
      s.scale.setScalar(1.2 + Math.random());
      this.group.add(s);
      smoke.push(s);
      smokeVel.push(new THREE.Vector3((Math.random() - 0.5) * 1.6, 1.2 + Math.random() * 1.4, (Math.random() - 0.5) * 1.6));
    }
    this.blasts.push({ flash, light, smoke, smokeVel, life: 0 });
    // Debris sparks + scorch decal
    for (let k = 0; k < 3; k++) this.impact(point.clone().add(new THREE.Vector3(0, 0.05, 0)), new THREE.Vector3((Math.random() - 0.5) * 0.6, 1, (Math.random() - 0.5) * 0.6).normalize());
    const scorch = this.decals[this.decalIndex++ % this.decals.length];
    scorch.position.copy(point).add(new THREE.Vector3(0, 0.02, 0));
    scorch.lookAt(point.x, point.y + 1, point.z);
    scorch.scale.setScalar(14);
    scorch.visible = true;
  }

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    for (let i = 0; i < 48; i++) {
      const d = new THREE.Mesh(this.decalGeo, this.decalMat);
      d.visible = false;
      this.group.add(d);
      this.decals.push(d);
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, enemy = false) {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, (enemy ? this.enemyTracerMat : this.tracerMat).clone());
    this.group.add(line);
    this.tracers.push({ line, life: 0.08, max: 0.08 });
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3) {
    const n = 8;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = point.x;
      pos[i * 3 + 1] = point.y;
      pos[i * 3 + 2] = point.z;
      vel[i * 3] = normal.x * 2 + (Math.random() - 0.5) * 3;
      vel[i * 3 + 1] = normal.y * 2 + Math.random() * 2.5;
      vel[i * 3 + 2] = normal.z * 2 + (Math.random() - 0.5) * 3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, this.sparkMat);
    this.group.add(pts);
    this.sparks.push({ pts, vel, life: 0.22 });

    const d = this.decals[this.decalIndex++ % this.decals.length];
    d.scale.setScalar(1);
    d.position.copy(point).addScaledVector(normal, 0.01);
    d.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    d.visible = true;
  }

  update(dt: number) {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.life += dt;
      const f = b.life / 0.35;
      b.flash.scale.setScalar(1 + Math.min(1, f) * 6);
      (b.flash.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - f);
      b.light.intensity = Math.max(0, 40 * (1 - b.life / 0.3));
      b.smoke.forEach((s, k) => {
        s.position.addScaledVector(b.smokeVel[k], dt);
        b.smokeVel[k].multiplyScalar(1 - dt * 0.8);
        s.scale.multiplyScalar(1 + dt * 0.45);
        const m = s.material as THREE.SpriteMaterial;
        m.opacity = b.life < 0.25 ? b.life * 3 : Math.max(0, 0.75 * (1 - (b.life - 0.25) / 3.2));
      });
      if (b.life > 3.5) {
        this.group.remove(b.flash, b.light, ...b.smoke);
        b.flash.material.dispose();
        b.smoke.forEach((s) => s.material.dispose());
        b.light.dispose();
        this.blasts.splice(i, 1);
      }
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life / t.max);
      if (t.life <= 0) {
        this.group.remove(t.line);
        t.line.geometry.dispose();
        (t.line.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      const attr = s.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let k = 0; k < arr.length; k += 3) {
        s.vel[k + 1] -= 9.8 * dt;
        arr[k] += s.vel[k] * dt;
        arr[k + 1] += s.vel[k + 1] * dt;
        arr[k + 2] += s.vel[k + 2] * dt;
      }
      attr.needsUpdate = true;
      if (s.life <= 0) {
        this.group.remove(s.pts);
        s.pts.geometry.dispose();
        this.sparks.splice(i, 1);
      }
    }
  }

  dispose() {
    this.tracers.forEach((t) => {
      t.line.geometry.dispose();
      (t.line.material as THREE.Material).dispose();
    });
    this.sparks.forEach((s) => s.pts.geometry.dispose());
    this.tracerMat.dispose();
    this.enemyTracerMat.dispose();
    this.sparkMat.dispose();
    this.decalMat.dispose();
    this.decalGeo.dispose();
    this.blasts.forEach((b) => {
      b.flash.material.dispose();
      b.smoke.forEach((s) => s.material.dispose());
    });
    this.flashTex?.dispose();
    this.smokeTex?.dispose();
  }
}
