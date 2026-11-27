import * as THREE from 'three';

/**
 * Procedural canvas textures + shared materials. Everything is generated at runtime so the
 * static export ships zero texture files (fast first load on Cloudflare).
 * Materials use vertex colours so one material can be tinted per building after batching.
 */

export type MaterialKey =
  | 'plaster'
  | 'brick'
  | 'concrete'
  | 'metal'
  | 'wood'
  | 'roofTile'
  | 'asphalt'
  | 'sidewalk'
  | 'grass'
  | 'glass'
  | 'trim'
  | 'emissive'
  | 'foliage'
  | 'bark'
  | 'rock'
  | 'fabric';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCanvas(size: number, draw: (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void, seed = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size, rng(seed));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function speckle(ctx: CanvasRenderingContext2D, size: number, rand: () => number, count: number, alpha: number, light = 255, dark = 0) {
  for (let i = 0; i < count; i++) {
    const v = rand() > 0.5 ? light : dark;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
    const s = 1 + rand() * 2.2;
    ctx.fillRect(rand() * size, rand() * size, s, s);
  }
}

export const textureFactories = {
  plaster: () =>
    makeCanvas(256, (ctx, s, r) => {
      ctx.fillStyle = '#e9e6df';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, s, r, 5000, 0.12, 255, 90);
    }, 3),
  brick: () =>
    makeCanvas(256, (ctx, s, r) => {
      ctx.fillStyle = '#cfc8c0';
      ctx.fillRect(0, 0, s, s);
      const bh = s / 8;
      const bw = s / 4;
      for (let row = 0; row < 8; row++) {
        const off = row % 2 ? bw / 2 : 0;
        for (let col = -1; col < 5; col++) {
          const v = 200 + Math.floor(r() * 55);
          ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.92)},${Math.floor(v * 0.86)})`;
          ctx.fillRect(col * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
        }
      }
      speckle(ctx, s, r, 2500, 0.12, 255, 40);
    }, 5),
  concrete: () =>
    makeCanvas(256, (ctx, s, r) => {
      ctx.fillStyle = '#d4d4d4';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, s, r, 7000, 0.16, 255, 60);
      ctx.strokeStyle = 'rgba(70,70,70,0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, s - 2, s - 2);
    }, 7),
  metal: () =>
    makeCanvas(128, (ctx, s, r) => {
      ctx.fillStyle = '#d8dde3';
      ctx.fillRect(0, 0, s, s);
      for (let x = 0; x < s; x += 16) {
        ctx.fillStyle = 'rgba(40,50,60,0.25)';
        ctx.fillRect(x, 0, 3, s);
      }
      speckle(ctx, s, r, 800, 0.1);
    }, 9),
  wood: () =>
    makeCanvas(256, (ctx, s, r) => {
      ctx.fillStyle = '#d9b07a';
      ctx.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 32) {
        ctx.fillStyle = 'rgba(80,45,15,0.55)';
        ctx.fillRect(0, y, s, 3);
        for (let i = 0; i < 6; i++) {
          ctx.strokeStyle = `rgba(120,70,30,${0.15 + r() * 0.2})`;
          ctx.beginPath();
          const yy = y + 5 + r() * 24;
          ctx.moveTo(0, yy);
          ctx.bezierCurveTo(s * 0.3, yy + r() * 6 - 3, s * 0.6, yy + r() * 6 - 3, s, yy);
          ctx.stroke();
        }
      }
    }, 11),
  roofTile: () =>
    makeCanvas(256, (ctx, s, r) => {
      ctx.fillStyle = '#b9b9b9';
      ctx.fillRect(0, 0, s, s);
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const v = 170 + Math.floor(r() * 60);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          const off = row % 2 ? 16 : 0;
          ctx.beginPath();
          ctx.ellipse(col * 32 + off + 16, row * 32 + 22, 15, 12, 0, 0, Math.PI);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(0, row * 32 + 30, s, 2);
      }
    }, 13),
  asphalt: () =>
    makeCanvas(256, (ctx, s, r) => {
      ctx.fillStyle = '#3a3d42';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, s, r, 9000, 0.22, 200, 0);
    }, 17),
  sidewalk: () =>
    makeCanvas(256, (ctx, s, r) => {
      ctx.fillStyle = '#c9c6bf';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, s, r, 4000, 0.12, 255, 60);
      ctx.strokeStyle = 'rgba(60,60,60,0.45)';
      ctx.lineWidth = 3;
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (i * s) / 4);
        ctx.lineTo(s, (i * s) / 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo((i * s) / 4, 0);
        ctx.lineTo((i * s) / 4, s);
        ctx.stroke();
      }
    }, 19),
  grass: () =>
    makeCanvas(512, (ctx, s, r) => {
      ctx.fillStyle = '#4f8a35';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 400; i++) {
        const g = 110 + Math.floor(r() * 70);
        ctx.fillStyle = `rgba(${Math.floor(g * 0.45)},${g},${Math.floor(g * 0.3)},0.35)`;
        ctx.beginPath();
        ctx.arc(r() * s, r() * s, 6 + r() * 30, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 14000; i++) {
        const g = 90 + Math.floor(r() * 120);
        ctx.strokeStyle = `rgba(${Math.floor(g * 0.5)},${g},${Math.floor(g * 0.3)},0.6)`;
        const x = r() * s;
        const y = r() * s;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + r() * 2 - 1, y - 2 - r() * 4);
        ctx.stroke();
      }
    }, 23),
  bark: () =>
    makeCanvas(64, (ctx, s, r) => {
      ctx.fillStyle = '#5b3b22';
      ctx.fillRect(0, 0, s, s);
      for (let x = 0; x < s; x += 4) {
        ctx.fillStyle = `rgba(20,10,0,${0.2 + r() * 0.3})`;
        ctx.fillRect(x, 0, 1 + r() * 2, s);
      }
    }, 29),
  rock: () =>
    makeCanvas(128, (ctx, s, r) => {
      ctx.fillStyle = '#7b7d80';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, s, r, 3000, 0.3, 230, 20);
    }, 31),
  fabric: () =>
    makeCanvas(64, (ctx, s, r) => {
      ctx.fillStyle = '#d6cfae';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < s; i += 4) {
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        ctx.fillRect(i, 0, 1, s);
        ctx.fillRect(0, i, s, 1);
      }
      speckle(ctx, s, r, 300, 0.1);
    }, 37),
};

/** Road texture (10 m tile): asphalt, dashed yellow centre line, solid white edge lines. */
export function makeRoadTexture() {
  return makeCanvas(512, (ctx, s, r) => {
    ctx.fillStyle = '#34373c';
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, r, 16000, 0.2, 200, 0);
    // Road runs along canvas Y. Width spans X: 10 m → 512 px.
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(s * 0.05, 0, s * 0.018, s);
    ctx.fillRect(s * 0.932, 0, s * 0.018, s);
    ctx.fillStyle = '#facc15';
    for (let y = 0; y < s; y += s / 2) {
      ctx.fillRect(s * 0.49, y + s * 0.06, s * 0.02, s * 0.3);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    for (let y = 0; y < s; y += s / 2) {
      ctx.fillRect(s * 0.27, y + s * 0.12, s * 0.012, s * 0.18);
      ctx.fillRect(s * 0.72, y + s * 0.12, s * 0.012, s * 0.18);
    }
  }, 41);
}

/** Plain asphalt (no lane markings): road junction tiles. */
export function makeAsphaltTexture() {
  return makeCanvas(512, (ctx, s, r) => {
    ctx.fillStyle = '#34373c';
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, r, 16000, 0.2, 200, 0);
  }, 43);
}

export function makeCloudTexture(seed: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const r = rng(seed);
  for (let i = 0; i < 22; i++) {
    const x = 40 + r() * 176;
    const y = 50 + r() * 40 - (Math.abs(x - 128) / 128) * 10;
    const rad = 18 + r() * 34;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(250,250,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeRadialTexture(inner: string, outer: string, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Texel density: world metres per texture repeat. */
export const TEXTURE_SCALE: Record<MaterialKey, number> = {
  plaster: 3,
  brick: 2.4,
  concrete: 4,
  metal: 2,
  wood: 1.6,
  roofTile: 2,
  asphalt: 6,
  sidewalk: 2.5,
  grass: 8,
  glass: 4,
  trim: 4,
  emissive: 4,
  foliage: 4,
  bark: 1.5,
  rock: 3,
  fabric: 1,
};

export class MaterialLibrary {
  private cache = new Map<MaterialKey, THREE.Material>();
  private textures: THREE.Texture[] = [];

  get(key: MaterialKey): THREE.Material {
    let m = this.cache.get(key);
    if (m) return m;
    const tex = (k: keyof typeof textureFactories) => {
      const t = textureFactories[k]();
      this.textures.push(t);
      return t;
    };
    switch (key) {
      case 'glass':
        m = new THREE.MeshStandardMaterial({
          vertexColors: true,
          color: 0xffffff,
          roughness: 0.05,
          metalness: 0.6,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
        });
        break;
      case 'emissive':
        m = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff, toneMapped: false });
        break;
      case 'trim':
        m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 });
        break;
      case 'foliage':
        m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
        break;
      case 'metal':
        m = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex('metal'), roughness: 0.45, metalness: 0.55 });
        break;
      default: {
        const factoryKey = key as keyof typeof textureFactories;
        const map = textureFactories[factoryKey] ? tex(factoryKey) : undefined;
        m = new THREE.MeshStandardMaterial({
          vertexColors: true,
          map,
          roughness: key === 'asphalt' ? 0.95 : 0.85,
          metalness: 0.02,
        });
      }
    }
    this.cache.set(key, m);
    return m;
  }

  dispose() {
    this.cache.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
    this.cache.clear();
  }
}
