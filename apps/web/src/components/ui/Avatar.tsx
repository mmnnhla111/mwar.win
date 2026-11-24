'use client';

import React, { useState } from 'react';

const PASTELS = ['#FFF3B0', '#D1FAE5', '#FFE4E6', '#E0F2FE', '#EDE9FE', '#FDE7C9'];

/** Rounded avatar: image when present, otherwise a pastel circle with the initial. */
export function Avatar({
  src,
  name,
  size = 40,
  className = '',
  ring = false,
}: {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
  ring?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  // The legacy default '/images/avatars/avatar_1.png' never existed: show the initial instead
  const usable = src && !broken && !src.startsWith('/images/avatars/') ? src : null;
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const bg = PASTELS[(name || '').split('').reduce((s, ch) => s + ch.charCodeAt(0), 0) % PASTELS.length];
  const style = { width: size, height: size };
  const ringCls = ring ? 'ring-2 ring-white shadow-[0_2px_10px_rgba(0,0,0,0.08)]' : '';
  if (usable) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={usable}
        onError={() => setBroken(true)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        style={style}
        className={`rounded-full object-cover bg-stone-100 shrink-0 ${ringCls} ${className}`}
      />
    );
  }
  return (
    <span
      style={{ ...style, background: bg, fontSize: Math.max(11, size * 0.42) }}
      className={`rounded-full inline-flex items-center justify-center font-extrabold text-stone-700 shrink-0 select-none ${ringCls} ${className}`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
