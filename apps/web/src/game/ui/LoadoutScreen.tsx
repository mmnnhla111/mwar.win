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
    <div className="flex items-center gap-1.5">
      <span className="w-12 text-[9px] font-black text-slate-400 uppercase">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.round(v * 100)}%` }} />
      </div>
    </div>
  );
}

export default function LoadoutScreen(p: Props) {
  return (
    <div className="absolute inset-0 z-40 overflow-y-auto bg-slate-950/88 backdrop-blur-sm">
      <div className="min-h-full flex items-center justify-center p-3 sm:p-6">
        <div className="w-full max-w-4xl bg-slate-900/95 border border-slate-700 rounded-3xl p-4 sm:p-6 shadow-2xl space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <div className="text-[10px] font-black tracking-widest text-slate-400">{p.modeLabel}</div>
              <h2 className="text-lg sm:text-xl font-black text-white tracking-tight">PRE-DEPLOY LOADOUT</h2>
            </div>
            <div className="text-[10px] sm:text-[11px] font-bold text-slate-300 bg-slate-800/80 border border-slate-700 rounded-xl px-3 py-1.5">
              + 🔫 Pistol (15/45) &nbsp;•&nbsp; + 💣 {GRENADE.start} Frag Grenades — everyone
            </div>
          </div>

          {/* Primary weapon */}
          <div>
            <div className="text-[11px] font-black text-slate-300 mb-2">1 · PRIMARY WEAPON</div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {PRIMARY_IDS.map((id) => {
                const w = WEAPONS[id];
                const sel = p.primary === id;
                return (
                  <button
                    key={id}
                    onClick={() => p.onPrimary(id)}
                    className={`text-left rounded-2xl border p-3 transition active:scale-[0.98] ${
                      sel ? 'border-rose-500 bg-rose-500/15 shadow-lg shadow-rose-500/20' : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-black text-white">
                        {WEAPON_ICON[id]} {w.name}
                      </span>
                      <span className="text-[10px] font-mono font-black text-slate-300">
                        {w.magSize}/{w.reserve}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 font-semibold mt-0.5 mb-2 leading-tight">{w.blurb}</div>
                    <div className="space-y-1">
                      <Bar label="Damage" v={w.stats.damage} color="bg-rose-500" />
                      <Bar label="Rate" v={w.stats.rate} color="bg-amber-400" />
                      <Bar label="Control" v={w.stats.control} color="bg-emerald-400" />
                      <Bar label="Mobility" v={w.stats.mobility} color="bg-sky-400" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Character */}
          <div>
            <div className="text-[11px] font-black text-slate-300 mb-2">2 · OPERATOR AVATAR</div>
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
              {CHARACTERS.map((c) => {
                const sel = p.character === c.id;
                const img = p.portraits[c.id];
                return (
                  <button
                    key={c.id}
                    onClick={() => p.onCharacter(c.id)}
                    title={`${c.name} — ${c.tagline}`}
                    className={`relative rounded-2xl border overflow-hidden transition active:scale-95 ${
                      sel ? 'border-amber-400 ring-2 ring-amber-400/60' : 'border-slate-700 hover:border-slate-500'
                    }`}
                    style={{ background: `linear-gradient(160deg, #${c.accent.toString(16).padStart(6, '0')}33, #0f172a 70%)` }}
                  >
                    <div className="aspect-[3/4] flex items-end justify-center">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt={c.name} className="w-full h-full object-cover" draggable={false} />
                      ) : (
                        <div className="w-10 h-16 mb-3 rounded-t-full" style={{ background: `#${c.top.toString(16).padStart(6, '0')}` }} />
                      )}
                    </div>
                    <div className="absolute bottom-0 inset-x-0 bg-slate-950/80 px-1 py-1">
                      <div className="text-[8.5px] sm:text-[9px] font-black text-white leading-tight truncate">{c.name}</div>
                      <div className="text-[8px] font-bold text-slate-400">{c.gender === 'male' ? '♂' : '♀'}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] text-slate-500 font-semibold mt-1.5">Bots and opponents are assigned random operators from the same 8 models.</div>
          </div>

          {!p.isMobile && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-0.5 text-[10.5px] text-slate-300 font-mono">
              <span>WASD — Move</span>
              <span>Mouse — Look / Fire</span>
              <span>Right-Click — Aim</span>
              <span>1 / 2 / 3 / Wheel — Slots</span>
              <span>R — Reload</span>
              <span>G — Throw weapon</span>
              <span>F — Pick up</span>
              <span>V — Quick grenade</span>
              <span>Q / E — Lean</span>
              <span>Ctrl / Z — Crouch</span>
              <span>Space — Jump</span>
              <span>C — Prop wheel</span>
              <span>Enter — /suicide</span>
              <span>⛶ — Fullscreen</span>
            </div>
          )}
          {p.practice ? (
            <div className="text-[11px] bg-amber-500/15 border border-amber-500/40 text-amber-300 py-2 px-3 rounded-xl font-bold">
              ⚡ ENERGY RECHARGE / TRAINING MODE — 70% skill AI bots • No Micro-USD / coin payouts
            </div>
          ) : (
            <div className="text-[11px] bg-amber-500/15 border border-amber-500/40 text-amber-300 py-2 px-3 rounded-xl font-bold">
              🎁 Bounty chests only drop where a player dies by suicide or the environment (own grenade, falls, /suicide).
            </div>
          )}
          {!p.isMobile && (
            <div className="text-[10.5px] text-sky-300/90 font-semibold">
              🔒 In-game browser shortcuts are blocked{p.kbLockSupported ? ' (Ctrl+W is fully safe after pressing ⛶ fullscreen)' : ' — your browser will ask before closing the tab'}.
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={() => p.onDeploy(false)}
              className="flex-1 bg-gradient-to-r from-rose-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white text-sm font-black py-3 px-4 rounded-2xl shadow-xl shadow-rose-600/30 transition active:scale-[0.98]"
            >
              🪂 DEPLOY — {WEAPONS[p.primary].name.toUpperCase()}
            </button>
            {!p.isMobile && (
              <button
                onClick={() => p.onDeploy(true)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-3 px-4 rounded-2xl border border-slate-600 transition active:scale-95"
              >
                🖱️ Deploy in Drag-Look Mode
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
