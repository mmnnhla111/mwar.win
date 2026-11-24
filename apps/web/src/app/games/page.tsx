'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { GamesResponse } from '@mwar/shared';
import { Card } from '../../components/ui/Card';
import { Icon } from '../../components/ui/Icon';
import { getGames } from '../../lib/api';
import { formatCount } from '../../lib/format';
import { memoGet, memoSet } from '../../lib/memo';

function FpsThumb() {
  // Inline SVG banner: no image request, crisp at any size
  return (
    <svg viewBox="0 0 640 260" className="w-full h-full" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFF6C2" />
          <stop offset="1" stopColor="#E0F2FE" />
        </linearGradient>
      </defs>
      <rect width="640" height="260" fill="url(#sky)" />
      <circle cx="520" cy="70" r="38" fill="#FFE135" />
      <path d="M0 200 C120 150 220 170 320 190 C430 210 520 160 640 175 V260 H0Z" fill="#A7F3D0" />
      <path d="M0 225 C140 200 260 215 360 228 C470 240 560 215 640 222 V260 H0Z" fill="#6EE7B7" />
      <g fill="#FFFFFF" stroke="#1C1917" strokeWidth="4">
        <rect x="90" y="120" width="70" height="80" rx="8" />
        <rect x="175" y="95" width="56" height="105" rx="8" />
        <rect x="420" y="130" width="64" height="70" rx="8" />
      </g>
      <g fill="#1C1917">
        <rect x="104" y="136" width="14" height="14" rx="3" />
        <rect x="132" y="136" width="14" height="14" rx="3" />
        <rect x="189" y="112" width="12" height="12" rx="3" />
        <rect x="207" y="112" width="12" height="12" rx="3" />
        <rect x="436" y="146" width="12" height="12" rx="3" />
      </g>
      <g transform="translate(320 120)" stroke="#1C1917" strokeWidth="6" strokeLinecap="round" fill="none">
        <circle r="44" fill="#FFFFFF" fillOpacity="0.55" />
        <circle r="8" fill="#FF6B6B" stroke="none" />
        <path d="M-64 0H-26M26 0H64M0-64V-26M0 26V64" />
      </g>
    </svg>
  );
}

export default function GamesPage() {
  const [data, setData] = useState<GamesResponse | null>(() => memoGet<GamesResponse>('games', 30_000));
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    if (!force && memoGet('games', 30_000)) return;
    setLoading(true);
    try {
      const d = await getGames();
      memoSet('games', d);
      setData(d);
    } catch {
      /* show defaults */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const fps = data?.games.find((g) => g.id === 'fps');

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Games</h1>
          <p className="text-sm text-stone-500">Pick a game, then jump into a room with friends.</p>
        </div>
        <button onClick={() => load(true)} className="w-9 h-9 rounded-full bg-white border border-stone-200 text-stone-500 hover:text-stone-900 flex items-center justify-center" aria-label="Refresh">
          <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/games/fps" className="group">
          <Card className="overflow-hidden transition group-hover:-translate-y-0.5 group-hover:shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
            <div className="relative h-40 sm:h-44 overflow-hidden">
              <FpsThumb />
              <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-extrabold text-emerald-700">
                <span className="w-2 h-2 rounded-full bg-[#34D399] animate-pulse" /> LIVE
              </span>
            </div>
            <div className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-extrabold text-lg text-stone-900">MWAR Tactical FPS</h2>
                <Icon name="chevron" size={18} className="text-stone-400 group-hover:text-stone-900 transition" />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(fps?.tags || ['3D FPS', 'Play-to-Earn', 'Mobile & PC']).map((t) => (
                  <span key={t} className="rounded-full bg-[#E0F2FE] text-sky-800 px-2.5 py-0.5 text-[11px] font-bold">
                    {t}
                  </span>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-[#FFFBEA] px-3 py-2">
                  <div className="text-[11px] font-semibold text-stone-500">จำนวนคนเล่นทั้งหมด</div>
                  <div className="text-sm font-extrabold text-stone-900">{fps ? formatCount(fps.totalPlayers) : '–'} Players</div>
                </div>
                <div className="rounded-2xl bg-[#ECFDF5] px-3 py-2">
                  <div className="text-[11px] font-semibold text-stone-500">กำลังออนไลน์</div>
                  <div className="text-sm font-extrabold text-emerald-700">{fps ? formatCount(fps.onlineNow) : '–'} Online</div>
                </div>
              </div>
            </div>
          </Card>
        </Link>

        <Card className="overflow-hidden border-dashed bg-white/60 flex flex-col items-center justify-center text-center p-8 min-h-[260px]">
          <span className="w-14 h-14 rounded-2xl bg-[#EDE9FE] text-violet-600 flex items-center justify-center">
            <Icon name="sparkle" size={26} />
          </span>
          <div className="mt-3 font-extrabold text-stone-800">More games coming soon</div>
          <p className="text-sm text-stone-500 mt-1 max-w-[240px]">New game modes and mini-games will appear here.</p>
        </Card>
      </div>
    </div>
  );
}
