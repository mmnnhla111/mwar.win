import * as THREE from 'three';

export const MEDKIT_DROP_CHANCE = 0.2;
export const MEDKIT_TTL_MS = 600_000; // 10-minute despawn
export const MEDKIT_CAST_SECONDS = 4;
export const MEDKIT_HEAL_MIN = 40;
export const MEDKIT_HEAL_MAX = 80;

/** Random 40–80 HP heal. */
export function rollMedkitHeal() {
  return MEDKIT_HEAL_MIN + Math.floor(Math.random() * (MEDKIT_HEAL_MAX - MEDKIT_HEAL_MIN + 1));
}

/** Small white first-aid case with a red cross and a soft green glow ring. */
export function createMedkitModel(): THREE.Group {
  const g = new THREE.Group();
  const model = new THREE.Group();
  model.name = 'model';
  const caseMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.45, metalness: 0.05 });
  const crossMat = new THREE.MeshBasicMaterial({ color: 0xe11d48, toneMapped: false });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.22, 0.3), caseMat);
  box.position.y = 0.11;
  model.add(box);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.04), new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 }));
  handle.position.set(0, 0.24, 0);
  model.add(handle);
  for (const side of [1, -1]) {
    const h = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.05), crossMat);
    const v = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.16), crossMat);
    for (const m of [h, v]) {
      m.position.set(0, 0.11, side * 0.151);
      if (side < 0) m.rotation.y = Math.PI;
      model.add(m);
    }
  }
  const top = new THREE.Group();
  const th = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.05), crossMat);
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.16), crossMat);
  top.add(th, tv);
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.221;
  model.add(top);
  g.add(model);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.4, 28),
    new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
  );
  ring.name = 'ring';
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  g.add(ring);
  return g;
}

export function animateMedkit(g: THREE.Group, t: number) {
  const model = g.getObjectByName('model');
  if (model) {
    model.rotation.y = t * 1.2;
    model.position.y = 0.05 + Math.sin(t * 2.4) * 0.04;
  }
  const ring = g.getObjectByName('ring') as THREE.Mesh | undefined;
  if (ring) (ring.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.2 * Math.sin(t * 3);
}
