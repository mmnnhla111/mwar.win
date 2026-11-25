'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { GameDirectoryItem, GamesResponse } from '@mwar/shared';
import { Card } from '../../components/ui/Card';
import { Icon } from '../../components/ui/Icon';
import { getGames } from '../../lib/api';
import { formatCount } from '../../lib/format';
import { memoGet, memoSet } from '../../lib/memo';
import { useTranslation } from '../../i18n/I18nProvider';

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

const FALLBACK_FPS: GameDirectoryItem = {
  id: 'fps',
  slug: 'fps',
  title: 'MWAR Tactical FPS',
  subtitle: null,
  description: null,
  genreTags: ['3D FPS', 'Play-to-Earn', 'Mobile & PC'],
  logoUrl: null,
  coverUrl: null,
  routePath: '/games/fps',
  status: 'active',
  sortOrder: 0,
  updatedAt: 0,
  totalPlayers: 0,
  onlineNow: 0,
};

const STATUS_STYLE: Record<GameDirectoryItem['status'], { cls: string; dot: string }> = {
  active: { cls: 'text-emerald-700', dot: 'bg-[#34D399] animate-pulse' },
  coming_soon: { cls: 'text-violet-700', dot: 'bg-violet-400' },
  maintenance: { cls: 'text-amber-700', dot: 'bg-amber-400' },
};

function GameCard({ g, loaded }: { g: GameDirectoryItem; loaded: boolean }) {
  const { t, ts } = useTranslation();
  const playable = g.status === 'active';
  const st = STATUS_STYLE[g.status] || STATUS_STYLE.active;
  const body = (
    <Card
      className={`overflow-hidden h-full transition ${playable ? 'group-hover:-translate-y-0.5 group-hover:shadow-[0_10px_30px_rgba(0,0,0,0.08)]' : 'opacity-90'}`}
      data-game-card={g.slug}
      data-game-status={g.status}
    >
      <div className="relative h-40 sm:h-44 overflow-hidden bg-stone-100">
        {g.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={g.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
        ) : (
          <FpsThumb />
        )}
        <span className={`absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-extrabold ${st.cls}`}>
          <span className={`w-2 h-2 rounded-full ${st.dot}`} /> {t(`games.status.${g.status}`)}
        </span>
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {g.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={g.logoUrl} alt="" className="w-9 h-9 rounded-xl object-cover border border-stone-100 shrink-0" loading="lazy" />
            )}
            <div className="min-w-0">
              <h2 className="font-extrabold text-lg text-stone-900 truncate">{g.title}</h2>
              {g.subtitle && <p className="text-xs text-stone-500 truncate">{ts(`games.sub.${g.slug}`, g.subtitle)}</p>}
            </div>
          </div>
          {playable && <Icon name="chevron" size={18} className="text-stone-400 group-hover:text-stone-900 transition shrink-0" />}
        </div>
        {g.genreTags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {g.genreTags.map((tg) => (
              <span key={tg} className="rounded-full bg-[#E0F2FE] text-sky-800 px-2.5 py-0.5 text-[11px] font-bold">
                {tg}
              </span>
            ))}
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-[#FFFBEA] px-3 py-2">
            <div className="text-[11px] font-semibold text-stone-500">{t('games.totalPlayers')}</div>
            <div className="text-sm font-extrabold text-stone-900">{t('games.playersN', { n: loaded ? formatCount(g.totalPlayers) : '–' })}</div>
          </div>
          <div className="rounded-2xl bg-[#ECFDF5] px-3 py-2">
            <div className="text-[11px] font-semibold text-stone-500">{t('games.onlineNow')}</div>
            <div className="text-sm font-extrabold text-emerald-700">{t('games.onlineN', { n: loaded ? formatCount(g.onlineNow) : '–' })}</div>
          </div>
        </div>
      </div>
    </Card>
  );
  return playable ? (
    <Link href={g.routePath} className="group">
      {body}
    </Link>
  ) : (
    <div aria-disabled="true">{body}</div>
  );
}

export default function GamesPage() {
  const { t } = useTranslation();
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

  const games = data?.games?.length ? data.games : null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">{t('nav.games')}</h1>
          <p className="text-sm text-stone-500">{t('games.subtitle')}</p>
        </div>
        <button onClick={() => load(true)} className="w-9 h-9 rounded-full bg-white border border-stone-200 text-stone-500 hover:text-stone-900 flex items-center justify-center" aria-label={t('common.refresh')}>
          <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {(games || [FALLBACK_FPS]).map((g) => (
          <GameCard key={g.id} g={g} loaded={!!games} />
        ))}

        <Card className="overflow-hidden border-dashed bg-white/60 flex flex-col items-center justify-center text-center p-8 min-h-[260px]">
          <span className="w-14 h-14 rounded-2xl bg-[#EDE9FE] text-violet-600 flex items-center justify-center">
            <Icon name="sparkle" size={26} />
          </span>
          <div className="mt-3 font-extrabold text-stone-800">{t('games.moreSoon')}</div>
          <p className="text-sm text-stone-500 mt-1 max-w-[240px]">{t('games.moreSoonHint')}</p>
        </Card>
      </div>
    </div>
  );
}
