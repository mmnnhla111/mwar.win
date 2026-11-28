import * as THREE from 'three';

/**
 * V1.2 Golden Boss marker ("เป้าหมายค่าหัวทองคำ"): a floating golden crown with a pulsing glow and the reward
 * on it, drawn above the boss's head. Added to the scene (not to the character rig) so it stays visible even
 * while the boss hides as a prop — the boss is meant to be hunted. `update(t)` animates bob + glow.
 */
export interface GoldenBossMarker {
  group: THREE.Group;
  /** Reward text (e.g. "1,250 C") or null to hide the marker. */
  set(text: string | null): void;
  /** Follow a world position (head height is added) and animate; `t` = seconds. */
  update(pos: THREE.Vector3, t: number): void;
  dispose(): void;
}

function drawCrown(ctx: CanvasRenderingContext2D, text: string) {
  const W = 256;
  const H = 192;
  ctx.clearRect(0, 0, W, H);
  // crown
  const g = ctx.createLinearGradient(0, 20, 0, 110);
  g.addColorStop(0, '#fff7c2');
  g.addColorStop(0.45, '#facc15');
  g.addColorStop(1, '#b45309');
  ctx.fillStyle = g;
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(48, 110);
  ctx.lineTo(40, 34);
  ctx.lineTo(88, 72);
  ctx.lineTo(128, 18);
  ctx.lineTo(168, 72);
  ctx.lineTo(216, 34);
  ctx.lineTo(208, 110);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#dc2626';
  for (const [x, y] of [[128, 78], [86, 92], [170, 92]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  // reward plate
  ctx.fillStyle = 'rgba(66,32,6,0.9)';
  ctx.strokeStyle = 'rgba(250,204,21,1)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(14, 124, 228, 56, 18);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fde047';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 153);
}

export function makeGoldenBossMarker(): GoldenBossMarker {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const ctx = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const crown = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true }));
  crown.scale.set(1.6, 1.2, 1);
  crown.renderOrder = 11;

  // soft additive glow behind the crown
  const gc = document.createElement('canvas');
  gc.width = gc.height = 128;
  const gx = gc.getContext('2d')!;
  const rg = gx.createRadialGradient(64, 64, 4, 64, 64, 64);
  rg.addColorStop(0, 'rgba(255,230,120,0.95)');
  rg.addColorStop(0.4, 'rgba(250,204,21,0.45)');
  rg.addColorStop(1, 'rgba(250,204,21,0)');
  gx.fillStyle = rg;
  gx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(gc);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }));
  glow.scale.set(3, 3, 1);
  glow.renderOrder = 10;

  const group = new THREE.Group();
  group.add(glow, crown);
  group.visible = false;
  let last: string | null = null;
  return {
    group,
    set(text) {
      group.visible = !!text;
      if (!text || text === last) return;
      last = text;
      drawCrown(ctx, text);
      tex.needsUpdate = true;
    },
    update(pos, t) {
      if (!group.visible) return;
      group.position.set(pos.x, pos.y + 3.1 + Math.sin(t * 2.4) * 0.12, pos.z);
      const s = 2.6 + Math.sin(t * 4) * 0.4;
      glow.scale.set(s, s, 1);
      (glow.material as THREE.SpriteMaterial).opacity = 0.65 + Math.sin(t * 4) * 0.25;
    },
    dispose() {
      tex.dispose();
      glowTex.dispose();
      crown.material.dispose();
      glow.material.dispose();
    },
  };
}
