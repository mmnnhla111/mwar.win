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
    d.position.copy(point).addScaledVector(normal, 0.01);
    d.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    d.visible = true;
  }

  update(dt: number) {
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
  }
}
