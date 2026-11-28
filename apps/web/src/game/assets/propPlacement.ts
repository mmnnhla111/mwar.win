import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Frame, Kit } from './kit';
import type { MaterialKey } from './materials';
import { createPropModel, propDef, PROPS, type PropId } from './disguiseProps';

/**
 * CONTRACT (owned by the prop-catalog agent; interior / street agents call it, never edit it):
 * places a STATIC copy of Prop-Hunt disguise prop `id` so it looks exactly like the disguise a player can
 * morph into (same model as createPropModel(id)), with its base at height `y` and centre (lx, lz) in frame `f`,
 * rotated by `quarterTurns` × 90° on top of the frame. Solid props get a movement + bullet-blocking collider
 * matching PROPS[id].size; small (inner-ring) props are pass-through. Rendering is batched (static batcher),
 * so hundreds of instances stay cheap. Coordinates follow the Kit conventions (kit.solid / kit.deco):
 * `y` is relative to `f.baseY`, (lx, lz) are local to the frame.
 *
 * HOW IT BATCHES: createPropModel(id) is "baked" ONCE per prop id: every mesh is converted into prop-local space
 * (its matrixWorld inside the model), tinted with its material colour as per-vertex colours, and merged into at
 * most one geometry per static MaterialKey ('trim' = plain standard material, 'metal' = shiny metals, 'foliage'
 * = leaves). Each placement then only clones those 1–3 cached geometries, transforms them into world space and
 * hands them to kit.batcher (keepColors) → they merge into the same per-chunk meshes as the rest of the map.
 * No THREE.Group / Mesh per instance is ever added to the scene.
 *
 * PROP_PLACEMENT_READY turns true once the real implementation has landed.
 */
export const PROP_PLACEMENT_READY = true;

interface BakedPart {
  key: MaterialKey;
  /** Non-indexed geometry in prop-local space (origin = base centre) with position / normal / color attributes. */
  geo: THREE.BufferGeometry;
}

const bakedCache = new Map<PropId, BakedPart[]>();

/** Props up to this height can be stood on (walkable collider top); taller furniture only blocks. */
const WALKABLE_MAX_H = 1.2;

function materialKeyFor(mat: THREE.MeshStandardMaterial): MaterialKey {
  const c = mat.color;
  // Leaves / shrubs: rough and green-dominant -> the flat-shaded foliage material.
  if (mat.roughness >= 0.85 && c.g > c.r * 1.2 && c.g > c.b * 1.2) return 'foliage';
  if (mat.metalness >= 0.5) return 'metal';
  return 'trim';
}

function bake(id: PropId): BakedPart[] {
  const model = createPropModel(id);
  model.updateMatrixWorld(true);
  const lists = new Map<MaterialKey, THREE.BufferGeometry[]>();
  const materials: THREE.Material[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    materials.push(mat);
    const src = mesh.geometry;
    const geo = src.index ? src.toNonIndexed() : src.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    }
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const count = geo.getAttribute('position').count;
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      col[i * 3] = mat.color.r;
      col[i * 3 + 1] = mat.color.g;
      col[i * 3 + 2] = mat.color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const key = materialKeyFor(mat);
    let list = lists.get(key);
    if (!list) lists.set(key, (list = []));
    list.push(geo);
  });
  const parts: BakedPart[] = [];
  lists.forEach((list, key) => {
    const merged = mergeGeometries(list, false);
    list.forEach((g) => g.dispose());
    if (merged) parts.push({ key, geo: merged });
  });
  materials.forEach((m) => m.dispose());
  return parts;
}

function bakedParts(id: PropId): BakedPart[] {
  let parts = bakedCache.get(id);
  if (!parts) bakedCache.set(id, (parts = bake(id)));
  return parts;
}

export function placeDisguiseProp(kit: Kit, f: Frame, id: PropId, lx: number, y: number, lz: number, quarterTurns = 0): void {
  if (!PROPS.some((p) => p.id === id)) return;
  const def = propDef(id);
  const parts = bakedParts(id);

  // Visual: baked geometry -> world space (same yaw convention as Kit.geometry / Object3D.rotation.y).
  const [wx, wz] = f.toWorld(lx, lz);
  // Layout convention (interiors / street): at quarterTurns 0 a directional prop's FRONT faces local +Z.
  // The models are built front = -Z, so the visual gets an extra half turn (the collider is symmetric).
  const m = new THREE.Matrix4().makeRotationY(f.angle + quarterTurns * (Math.PI / 2) + Math.PI);
  m.setPosition(wx, f.baseY + y, wz);
  for (const p of parts) {
    const geo = p.geo.clone();
    geo.applyMatrix4(m);
    kit.batcher.add(p.key, 0xffffff, geo, { keepColors: true });
  }

  // Physics: one box matching PROPS[id].size for solid props; small props are pass-through.
  if (!def.solid) return;
  const [w, d, h] = def.size;
  const odd = ((quarterTurns % 2) + 2) % 2 === 1;
  kit.solid(f, 'trim', 0xffffff, lx, y, lz, odd ? d : w, h, odd ? w : d, {
    visual: false,
    walkable: h <= WALKABLE_MAX_H,
    blocksBullets: true,
    blocksMovement: true,
  });
}
