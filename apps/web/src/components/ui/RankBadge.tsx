'use client';

import React, { useState } from 'react';
import { getRankForExp, rankImagePath } from '@mwar/shared';

const FAMILY_STYLE: Record<string, { bg: string; ring: string; text: string }> = {
  bronze: { bg: 'linear-gradient(135deg,#E8B48A 0%,#B06A3B 55%,#7A4425 100%)', ring: '#F3D2B5', text: '#FFF7EE' },
  silver: { bg: 'linear-gradient(135deg,#F4F6F8 0%,#B9C2CC 55%,#7D8895 100%)', ring: '#E5E9EE', text: '#1F2933' },
  gold: { bg: 'linear-gradient(135deg,#FFF1A8 0%,#F5C518 50%,#B8860B 100%)', ring: '#FFE88A', text: '#4A3500' },
  platinum: { bg: 'linear-gradient(135deg,#E0FBFF 0%,#7DD3E8 45%,#4C6FD8 100%)', ring: '#C7F2FA', text: '#0B1A3A' },
};
const ROMAN = ['I', 'II', 'III'];

/** Remembers image ids that 404'd so every badge on the page falls back at once without re-requesting. */
const missing = new Set<string>();

/**
 * Rank icon from /assets/ranks/<id>.png. When the PNG isn't deployed (or fails to load) it falls back
 * to a CSS medal in the tier colour with the level numeral, so the header never shows a broken image.
 */
export function RankBadge({
  rankId,
  exp,
  name,
  size = 24,
  showName = false,
  className = '',
}: {
  /** e.g. "silver_2"; derived from `exp` when omitted. */
  rankId?: string | null;
  exp?: number;
  name?: string;
  size?: number;
  showName?: boolean;
  className?: string;
}) {
  const info = rankId ? null : getRankForExp(exp ?? 0);
  const id = rankId || info!.id;
  const [family, levelStr] = id.split('_');
  const level = Math.min(3, Math.max(1, Number(levelStr) || 1));
  const label = name || info?.name || `${family.charAt(0).toUpperCase()}${family.slice(1)} ${ROMAN[level - 1]}`;
  const [broken, setBroken] = useState(() => missing.has(id));
  const style = FAMILY_STYLE[family] || FAMILY_STYLE.bronze;

  const icon = broken ? (
    <span
      aria-hidden
      data-rank-fallback
      className="inline-flex items-center justify-center rounded-full font-black shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.15)]"
      style={{
        width: size,
        height: size,
        background: style.bg,
        color: style.text,
        boxShadow: `inset 0 0 0 ${Math.max(1, Math.round(size / 12))}px ${style.ring}`,
        fontSize: Math.max(8, Math.round(size * (level === 3 ? 0.34 : 0.4))),
        letterSpacing: '-0.04em',
      }}
    >
      {ROMAN[level - 1]}
    </span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={rankImagePath(id)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
      onError={() => {
        missing.add(id);
        setBroken(true);
      }}
    />
  );

  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 ${className}`} title={label} data-rank={id}>
      {icon}
      {showName ? <span className="text-xs font-extrabold text-stone-700 truncate">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
