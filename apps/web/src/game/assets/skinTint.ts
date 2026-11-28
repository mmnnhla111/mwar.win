import * as THREE from 'three';
import { SKIN_BY_SLUG } from '@mwar/shared';

/**
 * V1.2 C cosmetic skins: a simple tint / finish applied on top of an existing model (weapon finish on the viewmodel
 * or a rig's gun, outfit on a rig's body gear). Materials are cloned per mesh the first time, so shared character /
 * weapon materials are never changed; `clearSkinTint` restores and disposes the clones. Purely visual.
 */
const STRENGTH: Record<string, number> = { common: 0.35, rare: 0.5, epic: 0.62, legendary: 0.75 };

type Tintable = THREE.Mesh & { userData: { skinSlug?: string; skinOrig?: THREE.Material | THREE.Material[] } };

function tintMaterial(src: THREE.Material, color: THREE.Color, strength: number, sheen: number): THREE.Material {
  const m = src.clone() as THREE.MeshStandardMaterial;
  if ((m as any).color instanceof THREE.Color) m.color = m.color.clone().lerp(color, strength);
  if (typeof m.metalness === 'number') m.metalness = Math.min(1, m.metalness + sheen * 0.5);
  if (typeof m.roughness === 'number') m.roughness = Math.max(0.15, m.roughness - sheen * 0.4);
  if ((m as any).emissive instanceof THREE.Color && sheen > 0.5) {
    m.emissive = color.clone().multiplyScalar((sheen - 0.5) * 0.25);
  }
  return m;
}

/** Tint every mesh under `root` accepted by `filter` with the skin `slug` ('' / unknown = restore the default look). */
export function applySkinTint(root: THREE.Object3D, slug: string, filter: (m: THREE.Mesh) => boolean = () => true): void {
  const def = slug ? SKIN_BY_SLUG[slug] : undefined;
  root.traverse((o) => {
    const mesh = o as Tintable;
    if (!(mesh as any).isMesh || !filter(mesh)) return;
    if ((mesh.userData.skinSlug || '') === (def?.slug || '')) return;
    // restore first
    if (mesh.userData.skinOrig) {
      const cur = mesh.material;
      (Array.isArray(cur) ? cur : [cur]).forEach((m) => m.dispose());
      mesh.material = mesh.userData.skinOrig;
      delete mesh.userData.skinOrig;
    }
    mesh.userData.skinSlug = def?.slug || '';
    if (!def) return;
    const color = new THREE.Color(def.tint);
    const strength = STRENGTH[def.rarity] ?? 0.4;
    mesh.userData.skinOrig = mesh.material;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => tintMaterial(m, color, strength, def.sheen)) : tintMaterial(mesh.material, color, strength, def.sheen);
  });
}

export const clearSkinTint = (root: THREE.Object3D) => applySkinTint(root, '');
