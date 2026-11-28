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
  /** M4: Ctrl also crouches (opt-in; Z always does). */
  ctrlCrouch?: boolean;
  onCtrlCrouch?: (on: boolean) => void;
  onPrimary(id: PrimaryId): void;
  onCharacter(id: CharacterId): void;
  onDeploy(dragLook: boolean): void;
  /** Space kept free at the bottom for the ad banner (Solo / Practice). */
  bottomPad?: number;
  /** Shown after a death in Solo Bot mode: respawn instead of first deploy. */
  respawn?: boolean;
  /** V1.1 R3 Rejoin: resume control of the live body (its own weapon / spot / prop disguise are kept). */
  resume?: { title: string; detail: string; button: string } | null;
}

const WEAPON_ICON: Record<PrimaryId, string> = { sniper: '🎯', ak47: '💥', m16: '🎖️', uzi: '⚡' };

function Bar({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-12 text-[9px] font-black text-slate-400 uppercase">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.round(v * 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * Compact two-column pre-deploy screen: fits a 1280×720 (and 1920×1080) viewport with no vertical
 * scrolling. Left = primary weapon cards + sidearm/grenade badge; right = 4×2 operator grid + DEPLOY.
 */
export default function LoadoutScreen(p: Props) {
  return (
    <div className="absolute inset-0 z-40 overflow-y-auto bg-slate-950/88 backdrop-blur-sm" style={p.bottomPad ? { paddingBottom: p.bottomPad } : undefined}>
      <div className="min-h-full flex items-center justify-center p-2 sm:p-4">
        <div className="w-full max-w-5xl bg-slate-900/95 border border-slate-700 rounded-3xl p-3 sm:p-4 shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-base sm:text-lg font-black text-white tracking-tight">PRE-DEPLOY LOADOUT</h2>
              <span className="text-[10px] font-black tracking-widest text-slate-400">{p.modeLabel}</span>
              {p.respawn && <span className="text-[10px] font-black tracking-widest text-rose-400">ELIMINATED • CHANGE LOADOUT &amp; REDEPLOY</span>}
            </div>
            <div
              className={`text-[10px] font-bold rounded-lg px-2.5 py-1 border ${
                p.practice ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-slate-800/70 border-slate-700 text-slate-300'
              }`}
            >
              {p.practice ? '⚡ Training: 70% skill bots • EC recharge only, no cash' : '🎁 Chests drop only on suicide / environment deaths'}
            </div>
          </div>
          {p.resume && (
            <div data-testid="rejoin-resume-banner" className="mb-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-200">
              <div className="text-[12px] font-black">🔁 {p.resume.title}</div>
              <div className="text-[10.5px] font-semibold text-emerald-300/90">{p.resume.detail}</div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] gap-3 sm:gap-4">
            {/* LEFT: primary weapon */}
            <div className="flex flex-col gap-2 min-w-0">
              <div className="text-[10px] font-black text-slate-400 tracking-widest">1 · PRIMARY WEAPON</div>
              <div className="grid grid-cols-2 gap-2">
                {PRIMARY_IDS.map((id) => {
                  const w = WEAPONS[id];
                  const sel = p.primary === id;
                  return (
                    <button
                      key={id}
                      onClick={() => p.onPrimary(id)}
                      className={`text-left rounded-xl border px-2.5 py-2 transition active:scale-[0.98] ${
                        sel ? 'border-rose-500 bg-rose-500/15 shadow-lg shadow-rose-500/20' : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[13px] font-black text-white truncate">
                          {WEAPON_ICON[id]} {w.name}
                        </span>
                        <span className="text-[10px] font-mono font-black text-slate-300 shrink-0">
                          {w.magSize}/{w.reserve}
                        </span>
                      </div>
                      <div className="text-[9.5px] text-slate-400 font-semibold leading-tight mt-0.5 mb-1.5 line-clamp-1">{w.blurb}</div>
                      <div className="space-y-0.5">
                        <Bar label="Damage" v={w.stats.damage} color="bg-rose-500" />
                        <Bar label="Rate" v={w.stats.rate} color="bg-amber-400" />
                        <Bar label="Control" v={w.stats.control} color="bg-emerald-400" />
                        <Bar label="Mobility" v={w.stats.mobility} color="bg-sky-400" />
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-1.5 text-[10px] font-bold">
                <span className="bg-slate-800/80 border border-slate-700 text-slate-200 rounded-lg px-2 py-1">🔫 Sidearm: Pistol 15/45</span>
                <span className="bg-slate-800/80 border border-slate-700 text-slate-200 rounded-lg px-2 py-1">💣 {GRENADE.start} Frag grenades</span>
                <span className="bg-slate-800/50 border border-slate-700/70 text-slate-400 rounded-lg px-2 py-1">Everyone gets these</span>
              </div>
              {!p.isMobile && (
                <div className="grid grid-cols-3 gap-x-3 gap-y-0 text-[9.5px] text-slate-400 font-mono leading-snug mt-auto">
                  <span>WASD move</span>
                  <span>RMB aim</span>
                  <span>1/2/3 slots</span>
                  <span>R reload</span>
                  <span>G drop · F pick</span>
                  <span>V grenade</span>
                  <span>Q/E lean</span>
                  <span>{p.ctrlCrouch ? 'Z/Ctrl stance' : 'Z stance'}</span>
                  <span>X prone</span>
                  <span>Space jump/stand</span>
                  <span>C prop wheel</span>
                  <span>Enter /suicide</span>
                </div>
              )}
              {!p.isMobile && (
                <div className="text-[9.5px] text-sky-300/80 font-semibold">
                  🔒 Browser shortcuts blocked in game{p.kbLockSupported ? ' • Ctrl+W fully safe in ⛶ fullscreen' : ''}
                </div>
              )}
              {!p.isMobile && p.onCtrlCrouch && (
                <label className="flex items-center gap-1.5 text-[9.5px] text-slate-400 font-semibold cursor-pointer select-none">
                  <input type="checkbox" className="accent-sky-400" checked={!!p.ctrlCrouch} onChange={(e) => p.onCtrlCrouch?.(e.target.checked)} />
                  Ctrl also crouches (Ctrl+W may close the tab outside fullscreen)
                </label>
              )}
            </div>

            {/* RIGHT: operator avatar + deploy */}
            <div className="flex flex-col gap-2 min-w-0">
              <div className="text-[10px] font-black text-slate-400 tracking-widest">2 · OPERATOR AVATAR</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {CHARACTERS.map((c) => {
                  const sel = p.character === c.id;
                  const img = p.portraits[c.id];
                  return (
                    <button
                      key={c.id}
                      onClick={() => p.onCharacter(c.id)}
                      title={`${c.name} — ${c.tagline}`}
                      className={`relative flex flex-col rounded-xl border overflow-hidden transition active:scale-95 ${
                        sel ? 'border-amber-400 ring-2 ring-amber-400/60' : 'border-slate-700 hover:border-slate-500'
                      }`}
                      style={{ background: `linear-gradient(160deg, #${c.accent.toString(16).padStart(6, '0')}33, #0f172a 70%)` }}
                    >
                      <div className="h-[clamp(64px,15vh,150px)] w-full flex items-end justify-center overflow-hidden">
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={img} alt={c.name} className="h-full w-auto object-contain" draggable={false} />
                        ) : (
                          <div className="w-8 h-12 mb-2 rounded-t-full" style={{ background: `#${c.top.toString(16).padStart(6, '0')}` }} />
                        )}
                      </div>
                      <div className="bg-slate-950/85 px-1 py-1 text-center">
                        <div className="text-[9.5px] font-black text-white leading-tight">{c.name}</div>
                        <div className="text-[8.5px] font-bold text-slate-400 leading-tight line-clamp-1">
                          {c.gender === 'male' ? '♂' : '♀'} {c.tagline}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="text-[9.5px] text-slate-500 font-semibold">Bots and opponents use random operators from the same 8 models.</div>
              <div className="flex gap-2 mt-auto">
                <button
                  onClick={() => p.onDeploy(false)}
                  className="flex-1 bg-gradient-to-r from-rose-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white text-sm sm:text-base font-black tracking-wide py-3 px-4 rounded-2xl shadow-xl shadow-rose-600/30 border border-white/30 transition active:scale-[0.98]"
                >
                  {p.resume ? `🔁 ${p.resume.button}` : '🪂 DEPLOY INTO ARENA'}
                  <span className="block text-[10px] font-bold opacity-85">{p.resume ? p.resume.detail : `${WEAPONS[p.primary].name} + Pistol + ${GRENADE.start}× Frag`}</span>
                </button>
                {!p.isMobile && (
                  <button
                    onClick={() => p.onDeploy(true)}
                    title="Deploy without pointer lock: hold left-click and drag to look"
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold py-2 px-3 rounded-2xl border border-slate-600 transition active:scale-95"
                  >
                    🖱️ Drag-Look
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
