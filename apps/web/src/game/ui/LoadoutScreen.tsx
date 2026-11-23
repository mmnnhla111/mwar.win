'use client';

import React from 'react';
import { CHARACTERS, CharacterId } from '../assets/characters';
import { PRIMARY_IDS, PrimaryId, WEAPONS, GRENADE } from '../weapons';

interface Props {
  modeLabel: string;
  practice: boolean;
  isMobile: boolean;
  primary: PrimaryId;
  character: CharacterId;
  portraits: Partial<Record<CharacterId, string>>;
  kbLockSupported: boolean;
  onPrimary(id: PrimaryId): void;
  onCharacter(id: CharacterId): void;
  onDeploy(dragLook: boolean): void;
}

const WEAPON_ICON: Record<PrimaryId, string> = { sniper: '🎯', ak47: '💥', m16: '🎖️', uzi: '⚡' };

function Bar({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-9 text-[8px] font-black text-slate-500 uppercase">{label}</span>
      <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.round(v * 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * Compact single-screen loadout: 2-column landscape layout (weapons left, 4×2 operators + deploy
 * right) that fits inside a 1280×720 viewport with no vertical scrolling. Narrow / portrait screens
 * fall back to a single column that may scroll.
 */
export default function LoadoutScreen(p: Props) {
  return (
    <div className="absolute inset-0 z-40 overflow-y-auto lg:overflow-hidden bg-slate-950/88 backdrop-blur-sm">
      <div className="min-h-full lg:h-full flex items-center justify-center p-2 sm:p-4">
        <div className="w-full max-w-5xl max-h-full bg-slate-900/95 border border-slate-700 rounded-3xl p-3 sm:p-4 shadow-2xl flex flex-col gap-3">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[9px] font-black tracking-widest text-slate-400">{p.modeLabel}</div>
              <h2 className="text-base sm:text-lg font-black text-white tracking-tight leading-tight">PRE-DEPLOY LOADOUT</h2>
            </div>
            <div
              className={`text-[10px] font-bold py-1 px-2.5 rounded-xl border ${
                p.practice ? 'bg-amber-500/15 border-amber-500/40 text-amber-300' : 'bg-slate-800/80 border-slate-700 text-slate-300'
              }`}
            >
              {p.practice ? '⚡ ENERGY RECHARGE MODE • 70% skill bots • No Micro-USD / coin payouts' : '🎁 Bounty chests drop only on suicide / environmental deaths'}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-3 min-h-0">
            {/* LEFT: primary weapons + universal kit */}
            <div className="flex flex-col gap-2 min-h-0">
              <div className="text-[10px] font-black text-slate-300">1 · PRIMARY WEAPON</div>
              <div className="grid grid-cols-2 lg:grid-cols-1 gap-1.5">
                {PRIMARY_IDS.map((id) => {
                  const w = WEAPONS[id];
                  const sel = p.primary === id;
                  return (
                    <button
                      key={id}
                      onClick={() => p.onPrimary(id)}
                      className={`text-left rounded-xl border px-2.5 py-1.5 transition active:scale-[0.98] ${
                        sel ? 'border-rose-500 bg-rose-500/15 shadow-lg shadow-rose-500/20' : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-black text-white truncate">
                          {WEAPON_ICON[id]} {w.name}
                        </span>
                        <span className="text-[10px] font-mono font-black text-slate-300">
                          {w.magSize}/{w.reserve}
                        </span>
                      </div>
                      <div className="hidden sm:block text-[9px] text-slate-400 font-semibold leading-tight truncate">{w.blurb}</div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1">
                        <Bar label="Dmg" v={w.stats.damage} color="bg-rose-500" />
                        <Bar label="Rate" v={w.stats.rate} color="bg-amber-400" />
                        <Bar label="Ctrl" v={w.stats.control} color="bg-emerald-400" />
                        <Bar label="Move" v={w.stats.mobility} color="bg-sky-400" />
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <span className="text-[10px] font-black text-slate-200 bg-slate-800/80 border border-slate-600 rounded-lg px-2 py-1">
                  🔫 Sidearm {WEAPONS.pistol.magSize}/{WEAPONS.pistol.reserve}
                </span>
                <span className="text-[10px] font-black text-slate-200 bg-slate-800/80 border border-slate-600 rounded-lg px-2 py-1">💣 {GRENADE.start}× Frag Grenade</span>
                <span className="text-[10px] font-bold text-slate-500 py-1">— everyone</span>
              </div>
              {!p.isMobile && (
                <div className="text-[9px] leading-snug text-slate-400 font-mono">
                  WASD move · Mouse look/fire · RMB aim · 1/2/3/Wheel slots · R reload · G throw · F pick up · V grenade · Q/E lean (prop: rotate) · Ctrl/Z
                  crouch→prone→stand · X prone · Space jump/stand · C prop wheel · Enter /suicide · ⛶ fullscreen
                </div>
              )}
            </div>

            {/* RIGHT: 8 operators (4×2) + deploy */}
            <div className="flex flex-col gap-2 min-h-0">
              <div className="text-[10px] font-black text-slate-300">2 · OPERATOR AVATAR</div>
              <div className="grid grid-cols-4 gap-1.5">
                {CHARACTERS.map((c) => {
                  const sel = p.character === c.id;
                  const img = p.portraits[c.id];
                  return (
                    <button
                      key={c.id}
                      onClick={() => p.onCharacter(c.id)}
                      title={`${c.name} — ${c.tagline}`}
                      className={`relative rounded-xl border overflow-hidden transition active:scale-95 ${
                        sel ? 'border-amber-400 ring-2 ring-amber-400/60' : 'border-slate-700 hover:border-slate-500'
                      }`}
                      style={{ background: `linear-gradient(160deg, #${c.accent.toString(16).padStart(6, '0')}33, #0f172a 70%)` }}
                    >
                      <div className="aspect-[4/5] lg:aspect-auto lg:h-[min(17vh,140px)] flex items-end justify-center">
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={img} alt={c.name} className="w-full h-full object-cover object-top" draggable={false} />
                        ) : (
                          <div className="w-8 h-12 mb-6 rounded-t-full" style={{ background: `#${c.top.toString(16).padStart(6, '0')}` }} />
                        )}
                      </div>
                      <div className="bg-slate-950/90 px-1 py-0.5 text-left">
                        <div className="text-[9px] font-black text-white leading-tight">
                          <span className="text-slate-400 mr-0.5">{c.gender === 'male' ? '♂' : '♀'}</span>
                          {c.name}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="text-[9px] text-slate-500 font-semibold">Bots and opponents get random operators from the same 8 models.</div>
              <div className="flex flex-col sm:flex-row gap-2 mt-auto">
                <button
                  onClick={() => p.onDeploy(false)}
                  className="flex-1 bg-gradient-to-r from-rose-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white text-sm font-black py-3 px-4 rounded-2xl shadow-xl shadow-rose-600/30 transition active:scale-[0.98]"
                >
                  🪂 DEPLOY INTO ARENA — {WEAPONS[p.primary].name.toUpperCase()}
                </button>
                {!p.isMobile && (
                  <button
                    onClick={() => p.onDeploy(true)}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-bold py-2 px-3 rounded-2xl border border-slate-600 transition active:scale-95"
                    title={p.kbLockSupported ? 'Ctrl+W is blocked after pressing ⛶ fullscreen' : undefined}
                  >
                    🖱️ Drag-Look Mode
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
