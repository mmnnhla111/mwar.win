import * as THREE from 'three';

/**
 * V1.2 C spectator gift visuals: a Champion Crown sprite that floats above a player while their giftCrownUntil is in
 * the future, and short-lived 3D pops (ammo box / golden grenade) at the receiver. Visual only — gifts are paid and
 * verified by the Worker + game server before any of this is shown.
 */
function emojiTexture(emoji: string, size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.font = `${Math.floor(size * 0.78)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let crownTex: THREE.CanvasTexture | null = null;
/** A crown sprite to parent under a rig root (≈ 2.55 m above the feet, above the name tag). */
export function makeGiftCrown(): THREE.Sprite {
  crownTex ??= emojiTexture('👑');
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: crownTex, depthTest: false, transparent: true }));
  s.scale.set(0.8, 0.8, 0.8);
  s.position.set(0, 2.55, 0);
  s.renderOrder = 999;
  s.visible = false;
  return s;
}

interface Pop {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  base: THREE.Vector3;
}

/** Floating gift pops (📦 ammo box, 💣 golden grenade, 👑 crown) that rise and fade over ~2.4 s. */
export class GiftPops {
  private pops: Pop[] = [];
  private tex = new Map<string, THREE.CanvasTexture>();
  constructor(private scene: THREE.Scene) {}

  spawn(emoji: string, at: THREE.Vector3, count = 5) {
    let tex = this.tex.get(emoji);
    if (!tex) {
      tex = emojiTexture(emoji);
      this.tex.set(emoji, tex);
    }
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      s.scale.setScalar(0.7);
      s.renderOrder = 998;
      const base = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.4, 1.2 + Math.random() * 0.6, (Math.random() - 0.5) * 1.4));
      s.position.copy(base);
      this.scene.add(s);
      this.pops.push({ sprite: s, age: -i * 0.12, life: 2.4, base });
    }
  }

  update(dt: number) {
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.age += dt;
      if (p.age < 0) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.visible = true;
      const k = p.age / p.life;
      p.sprite.position.set(p.base.x, p.base.y + k * 1.8, p.base.z);
      (p.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - k);
      if (k >= 1) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.pops.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const p of this.pops) {
      this.scene.remove(p.sprite);
      p.sprite.material.dispose();
    }
    this.pops = [];
    for (const t of this.tex.values()) t.dispose();
    this.tex.clear();
  }
}
