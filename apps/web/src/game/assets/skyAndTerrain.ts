import * as THREE from 'three';
import { Kit, Frame } from './kit';
import { makeCloudTexture, makeRoadTexture, MaterialLibrary, textureFactories } from './materials';
import { map2dTree } from './map2d';

/**
 * Atmosphere, sky, mountains, perimeter forest, roads & grass.
 *
 *  - Gradient sky dome with sun glow + slowly drifting clouds
 *  - 360° layered mountain silhouettes beyond the arena
 *  - Dense impassable pine/broadleaf forest + rock cliffs around all 4 borders of the 240 m map
 *  - Asphalt road grid (lane markings, crosswalks, intersections) with sidewalks,
 *    green grass zones and concrete plazas
 */

export const MAP_SIZE = 240;
export const MAP_HALF = MAP_SIZE / 2;
/** Playable half-extent (hard collision boundary sits just inside the tree line). */
export const PLAY_HALF = 112;
export const ROAD_LINES = [-60, 0, 60];
export const ROAD_WIDTH = 10;
export const SIDEWALK_WIDTH = 2.5;

export const SUN_DIRECTION = new THREE.Vector3(0.45, 0.62, 0.32).normalize();
const HORIZON = new THREE.Color(0xcfe3f2);
const ZENITH = new THREE.Color(0x3a7bd5);

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Sky & clouds
// ---------------------------------------------------------------------------------------------

function createSkyDome() {
  const geo = new THREE.SphereGeometry(1400, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      topColor: { value: ZENITH.clone() },
      horizonColor: { value: HORIZON.clone() },
      groundColor: { value: new THREE.Color(0x6b7d63) },
      sunDir: { value: SUN_DIRECTION.clone() },
      sunColor: { value: new THREE.Color(0xfff2c6) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_Position.z = gl_Position.w * 0.9999; // keep at far plane
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 groundColor;
      uniform vec3 sunDir; uniform vec3 sunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizonColor, groundColor, clamp(-h * 4.0, 0.0, 1.0));
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 60.0) * 0.45 + pow(s, 6.0) * 0.12);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

function createClouds(parent: THREE.Object3D) {
  const textures = [0, 1, 2, 3].map((i) => makeCloudTexture(101 + i * 17));
  const rand = seeded(77);
  const clouds: { sprite: THREE.Sprite; speed: number }[] = [];
  for (let i = 0; i < 34; i++) {
    const mat = new THREE.SpriteMaterial({
      map: textures[i % textures.length],
      transparent: true,
      opacity: 0.75 + rand() * 0.2,
      depthWrite: false,
      fog: false,
    });
    const s = new THREE.Sprite(mat);
    const scale = 140 + rand() * 160;
    s.scale.set(scale, scale * 0.45, 1);
    s.position.set(-900 + rand() * 1800, 170 + rand() * 120, -900 + rand() * 1800);
    s.renderOrder = -5;
    parent.add(s);
    clouds.push({ sprite: s, speed: 2.5 + rand() * 3.5 });
  }
  return {
    update(dt: number) {
      for (const c of clouds) {
        c.sprite.position.x += c.speed * dt;
        c.sprite.position.z += c.speed * 0.25 * dt;
        if (c.sprite.position.x > 950) c.sprite.position.x = -950;
        if (c.sprite.position.z > 950) c.sprite.position.z = -950;
      }
    },
    dispose() {
      textures.forEach((t) => t.dispose());
      clouds.forEach((c) => (c.sprite.material as THREE.Material).dispose());
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Mountains
// ---------------------------------------------------------------------------------------------

function createMountainRing(radius: number, baseHeight: number, peakVar: number, seed: number, low: THREE.Color, high: THREE.Color, snow: boolean) {
  const rand = seeded(seed);
  const segments = 220;
  const phases = Array.from({ length: 5 }, () => rand() * Math.PI * 2);
  const freqs = [3, 7, 13, 23, 41];
  const amps = [0.45, 0.25, 0.14, 0.09, 0.05];
  const positions: number[] = [];
  const colors: number[] = [];
  const snowC = new THREE.Color(0xf8fafc);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    let n = 0;
    for (let k = 0; k < 5; k++) n += Math.sin(a * freqs[k] + phases[k]) * amps[k];
    const h = baseHeight + peakVar * (0.5 + n);
    const r = radius + Math.sin(a * 5 + phases[0]) * radius * 0.06;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    positions.push(x, -10, z, x * 1.02, h, z * 1.02);
    colors.push(low.r, low.g, low.b);
    const top = snow && h > baseHeight + peakVar * 0.7 ? snowC : high;
    colors.push(top.r, top.g, top.b);
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------------------------

function colorize(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const c = new THREE.Color(color);
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

function mergeSimple(list: THREE.BufferGeometry[]) {
  // Minimal merge for same-attribute non-indexed geometries.
  let total = 0;
  for (const g of list) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const nn = g.getAttribute('normal') as THREE.BufferAttribute;
    const cc = g.getAttribute('color') as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, o * 3);
    nor.set(nn.array as Float32Array, o * 3);
    col.set(cc.array as Float32Array, o * 3);
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

export function pineGeometry() {
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 2.4, 6);
  trunk.translate(0, 1.2, 0);
  const parts = [colorize(trunk, 0x5b3a1e)];
  const tiers = [
    [2.4, 3.0, 2.0, 0x1f5f3a],
    [1.9, 2.6, 3.4, 0x237044],
    [1.3, 2.2, 4.7, 0x2b7d4d],
    [0.7, 1.6, 5.8, 0x35905a],
  ] as const;
  for (const [r, h, y, c] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 7);
    cone.translate(0, y + h / 2 - 0.4, 0);
    parts.push(colorize(cone, c));
  }
  return mergeSimple(parts);
}

export function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.25, 0.38, 2.8, 6);
  trunk.translate(0, 1.4, 0);
  const parts = [colorize(trunk, 0x6b4423)];
  const blobs = [
    [0, 4.0, 0, 2.2, 0x3f7d2c],
    [1.2, 3.5, 0.4, 1.5, 0x4a8f34],
    [-1.0, 3.6, -0.5, 1.6, 0x36702a],
    [0.2, 5.0, -0.3, 1.5, 0x55a03c],
  ] as const;
  for (const [x, y, z, r, c] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.translate(x, y, z);
    parts.push(colorize(b, c));
  }
  return mergeSimple(parts);
}

/** Collidable park/street tree inside the arena (batched visual + trunk collider). */
export function addTree(kit: Kit, x: number, z: number, kind: 'pine' | 'broadleaf', scale = 1) {
  map2dTree(x, z, (kind === 'pine' ? 1.6 : 2.2) * scale);
  const geo = kind === 'pine' ? pineGeometry() : broadleafGeometry();
  geo.scale(scale, scale, scale);
  geo.translate(x, 0, z);
  kit.batcher.add('foliage', 0xffffff, geo, { worldUv: true, keepColors: true });
  const f = new Frame(x, z, 0);
  kit.solid(f, 'bark', 0x5b3a1e, 0, 0, 0, 0.6 * scale, 3.0 * scale, 0.6 * scale, { visual: false, walkable: false });
  // Canopy blocks bullets/LOS a bit (not movement)
  kit.solid(f, 'foliage', 0, 0, 2.6 * scale, 0, 2.6 * scale, 3.2 * scale, 2.6 * scale, { visual: false, blocksMovement: false, walkable: false });
}

function createPerimeterForest(parent: THREE.Object3D) {
  const rand = seeded(2024);
  const pine = pineGeometry();
  const broad = broadleafGeometry();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const inner = PLAY_HALF + 2;
  const outer = MAP_HALF + 70;
  const spots: { x: number; z: number; s: number; r: number; kind: number }[] = [];
  // Poisson-ish jittered grid in the square ring
  const step = 5.2;
  for (let x = -outer; x <= outer; x += step) {
    for (let z = -outer; z <= outer; z += step) {
      const jx = x + (rand() - 0.5) * step * 0.9;
      const jz = z + (rand() - 0.5) * step * 0.9;
      const m = Math.max(Math.abs(jx), Math.abs(jz));
      if (m < inner || m > outer) continue;
      // Denser near the boundary
      if (m > inner + 30 && rand() < 0.35) continue;
      spots.push({ x: jx, z: jz, s: 0.9 + rand() * 0.9 + (m - inner) * 0.006, r: rand() * Math.PI * 2, kind: rand() < 0.68 ? 0 : 1 });
    }
  }
  const pines = spots.filter((s) => s.kind === 0);
  const broads = spots.filter((s) => s.kind === 1);
  const dummy = new THREE.Object3D();
  const make = (geo: THREE.BufferGeometry, list: typeof spots) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((s, i) => {
      dummy.position.set(s.x, 0, s.z);
      dummy.rotation.set(0, s.r, 0);
      dummy.scale.setScalar(s.s);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    parent.add(im);
    return im;
  };
  make(pine, pines);
  make(broad, broads);

  // Rock cliffs along the inner edge of the forest
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8d91, roughness: 1, flatShading: true, map: textureFactories.rock() });
  const rocks: THREE.Matrix4[] = [];
  const edge = PLAY_HALF + 3.5;
  for (let side = 0; side < 4; side++) {
    for (let t = -edge; t <= edge; t += 3.2) {
      if (rand() < 0.25) continue;
      const off = rand() * 3;
      const x = side === 0 ? t : side === 1 ? edge + off : side === 2 ? t : -edge - off;
      const z = side === 0 ? -edge - off : side === 1 ? t : side === 2 ? edge + off : t;
      dummy.position.set(x, rand() * 0.6, z);
      dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      const s = 1.6 + rand() * 2.6;
      dummy.scale.set(s, s * (0.7 + rand() * 0.8), s);
      dummy.updateMatrix();
      rocks.push(dummy.matrix.clone());
    }
  }
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);
  rocks.forEach((m, i) => rockMesh.setMatrixAt(i, m));
  rockMesh.receiveShadow = true;
  rockMesh.castShadow = true;
  parent.add(rockMesh);
  return { pine, broad, mat, rockGeo, rockMat };
}

// ---------------------------------------------------------------------------------------------
// Ground: grass, roads, sidewalks, plazas
// ---------------------------------------------------------------------------------------------

function roadSegments() {
  const half = ROAD_WIDTH / 2;
  const cuts = ROAD_LINES.flatMap((c) => [c - half, c + half]);
  const bounds = [-PLAY_HALF - 6, ...cuts, PLAY_HALF + 6];
  const segs: [number, number][] = [];
  for (let i = 0; i < bounds.length - 1; i += 2) segs.push([bounds[i], bounds[i + 1]]);
  return segs; // spans between intersections along a road
}

function createGround(parent: THREE.Object3D, kit: Kit, lib: MaterialLibrary, plazas: { x: number; z: number; w: number; d: number }[]) {
  const disposables: { dispose(): void }[] = [];
  // Grass inside the arena
  const grassTex = textureFactories.grass();
  grassTex.repeat.set(MAP_SIZE / 8, MAP_SIZE / 8);
  const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, color: 0xffffff });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE + 20, MAP_SIZE + 20), grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  parent.add(grass);
  // Forest floor beyond
  const floorTex = textureFactories.grass();
  floorTex.repeat.set(220, 220);
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, color: 0x6f8f5a, roughness: 1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.04;
  parent.add(floor);
  disposables.push(grassTex, grassMat, floorTex, floorMat, grass.geometry, floor.geometry);

  // Roads with lane markings
  const roadTex = makeRoadTexture();
  const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const interTex = textureFactories.asphalt();
  const interMat = new THREE.MeshStandardMaterial({ map: interTex, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  disposables.push(roadTex, roadMat, interTex, interMat);
  const roadGroup = new THREE.Group();
  const segs = roadSegments();
  const addRoad = (cx: number, cz: number, length: number, alongX: boolean) => {
    const g = new THREE.PlaneGeometry(ROAD_WIDTH, length);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * (length / 10));
    g.rotateX(-Math.PI / 2);
    if (alongX) g.rotateY(Math.PI / 2);
    const m = new THREE.Mesh(g, roadMat);
    m.position.set(cx, 0.02, cz);
    m.receiveShadow = true;
    roadGroup.add(m);
  };
  for (const line of ROAD_LINES) {
    for (const [a, b] of segs) {
      addRoad(line, (a + b) / 2, b - a, false); // north-south road at x = line
      addRoad((a + b) / 2, line, b - a, true); // east-west road at z = line
    }
  }
  // Intersections + crosswalks
  const zebraMat = new THREE.MeshBasicMaterial({ color: 0xf1f5f9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  disposables.push(zebraMat);
  for (const ix of ROAD_LINES) {
    for (const iz of ROAD_LINES) {
      const inter = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_WIDTH, ROAD_WIDTH), interMat);
      inter.rotation.x = -Math.PI / 2;
      inter.position.set(ix, 0.021, iz);
      inter.receiveShadow = true;
      roadGroup.add(inter);
      for (const dir of [0, 1, 2, 3]) {
        for (let k = -4; k <= 4; k++) {
          const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 2.2), zebraMat);
          stripe.rotation.x = -Math.PI / 2;
          const off = ROAD_WIDTH / 2 + 1.4;
          const along = k * 1.05;
          if (dir === 0) stripe.position.set(ix + along, 0.03, iz - off);
          if (dir === 1) stripe.position.set(ix + along, 0.03, iz + off);
          if (dir === 2) {
            stripe.position.set(ix - off, 0.03, iz + along);
            stripe.rotation.z = Math.PI / 2;
          }
          if (dir === 3) {
            stripe.position.set(ix + off, 0.03, iz + along);
            stripe.rotation.z = Math.PI / 2;
          }
          roadGroup.add(stripe);
        }
      }
    }
  }
  parent.add(roadGroup);

  // Sidewalks (raised 8 cm, batched) + curbs
  const sw = SIDEWALK_WIDTH;
  const h = 0.08;
  const hw = ROAD_WIDTH / 2;
  for (const line of ROAD_LINES) {
    for (const [a, b] of segs) {
      const len = b - a;
      const mid = (a + b) / 2;
      const s0 = a === -PLAY_HALF - 6 ? a : a + sw;
      const s1 = b === PLAY_HALF + 6 ? b : b - sw;
      const slen = s1 - s0;
      const smid = (s0 + s1) / 2;
      void len;
      void mid;
      for (const side of [-1, 1]) {
        const off = line + side * (hw + sw / 2);
        kit.batcher.addBox('sidewalk', 0xd6d3d1, off, h / 2, smid, sw, h, slen, false);
        kit.batcher.addBox('sidewalk', 0xd6d3d1, smid, h / 2, off, slen, h, sw, false);
        kit.batcher.addBox('concrete', 0x9ca3af, line + side * (hw + 0.1), h / 2 + 0.02, smid, 0.2, h + 0.04, slen, false);
        kit.batcher.addBox('concrete', 0x9ca3af, smid, h / 2 + 0.02, line + side * (hw + 0.1), slen, h + 0.04, 0.2, false);
      }
    }
    // Corner squares at intersections
    for (const other of ROAD_LINES) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          kit.batcher.addBox('sidewalk', 0xd6d3d1, line + sx * (hw + sw / 2), h / 2, other + sz * (hw + sw / 2), sw, h, sw, false);
        }
      }
    }
  }

  // Concrete plazas
  for (const p of plazas) {
    kit.batcher.addBox('concrete', 0xcbd5e1, p.x, 0.03, p.z, p.w, 0.06, p.d, false);
    kit.batcher.addBox('concrete', 0x94a3b8, p.x, 0.04, p.z - p.d / 2, p.w, 0.08, 0.3, false);
    kit.batcher.addBox('concrete', 0x94a3b8, p.x, 0.04, p.z + p.d / 2, p.w, 0.08, 0.3, false);
  }
  void lib;
  return disposables;
}

// ---------------------------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------------------------

export interface SkyAndTerrain {
  sun: THREE.DirectionalLight;
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

export function buildSkyAndTerrain(
  scene: THREE.Scene,
  kit: Kit,
  lib: MaterialLibrary,
  plazas: { x: number; z: number; w: number; d: number }[]
): SkyAndTerrain {
  scene.background = HORIZON.clone();
  scene.fog = new THREE.Fog(HORIZON.clone().lerp(new THREE.Color(0xb8c9d6), 0.3), 140, 1100);

  const sky = createSkyDome();
  scene.add(sky);

  const cloudLayer = new THREE.Group();
  scene.add(cloudLayer);
  const clouds = createClouds(cloudLayer);

  const mountains = new THREE.Group();
  // Pre-hazed colours (far = bluer/lighter) instead of fog so silhouettes stay crisp.
  mountains.add(createMountainRing(980, 70, 190, 11, new THREE.Color(0x9fb4c9), new THREE.Color(0xb7c8d9), true));
  mountains.add(createMountainRing(720, 45, 130, 23, new THREE.Color(0x7d9a9a), new THREE.Color(0x93aeb0), true));
  mountains.add(createMountainRing(470, 25, 80, 37, new THREE.Color(0x4d7356), new THREE.Color(0x6b8f67), false));
  scene.add(mountains);

  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4a5d3a, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -70;
  sc.right = 70;
  sc.top = 70;
  sc.bottom = -70;
  sc.near = 1;
  sc.far = 360;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(sun.target);

  const forest = createPerimeterForest(scene);
  const groundDisposables = createGround(scene, kit, lib, plazas);

  const snap = 4; // snap shadow frustum to reduce shimmering
  return {
    sun,
    update(dt, camera) {
      sky.position.copy(camera.position);
      clouds.update(dt);
      const cx = Math.round(camera.position.x / snap) * snap;
      const cz = Math.round(camera.position.z / snap) * snap;
      sun.target.position.set(cx, 0, cz);
      sun.position.set(cx + SUN_DIRECTION.x * 160, SUN_DIRECTION.y * 160, cz + SUN_DIRECTION.z * 160);
    },
    dispose() {
      clouds.dispose();
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      mountains.children.forEach((m) => {
        (m as THREE.Mesh).geometry.dispose();
        ((m as THREE.Mesh).material as THREE.Material).dispose();
      });
      forest.pine.dispose();
      forest.broad.dispose();
      forest.mat.dispose();
      forest.rockGeo.dispose();
      forest.rockMat.dispose();
      groundDisposables.forEach((d) => d.dispose());
    },
  };
}
