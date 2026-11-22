'use client';

import React, { useState } from 'react';
import Link from 'next/link';

export interface ArenaModeCardProps {
  href: string;
  imageSrc: string;
  title: string;
  subtitle: string;
  /** Accent colour (hex) used for the border glow and the SVG fallback. */
  accent: string;
  badge?: string;
  /** Optional highlighted info strip rendered under the artwork. */
  highlight?: React.ReactNode;
  onSelect?: () => void;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'
  );
}

/**
 * Builds a self-contained SVG data URI so a card can never render as a broken image,
 * even if the artwork file is missing, blocked or malformed.
 */
export function buildModeFallbackSvg(title: string, subtitle: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#020617"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
<rect width="400" height="220" fill="url(#g)"/>
<g stroke="${accent}" stroke-opacity="0.35"><path d="M0 60H400M0 110H400M0 160H400M80 0V220M200 0V220M320 0V220"/></g>
<circle cx="320" cy="70" r="38" fill="none" stroke="#fff" stroke-width="4"/><circle cx="320" cy="70" r="8" fill="#fff"/>
<path d="M270 70H300M340 70H370M320 20V50M320 90V120" stroke="#fff" stroke-width="3"/>
<text x="20" y="178" fill="#fff" font-family="system-ui,sans-serif" font-size="22" font-weight="900">${escapeXml(title.toUpperCase())}</text>
<text x="20" y="202" fill="#e2e8f0" font-family="system-ui,sans-serif" font-size="12" font-weight="600">${escapeXml(subtitle)}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export default function ArenaModeCard({
  href,
  imageSrc,
  title,
  subtitle,
  accent,
  badge,
  highlight,
  onSelect,
}: ArenaModeCardProps) {
  const [src, setSrc] = useState(imageSrc);
  const [usedFallback, setUsedFallback] = useState(false);

  return (
    <Link
      href={href}
      onClick={onSelect}
      className="group relative flex flex-col rounded-2xl overflow-hidden border border-slate-700 bg-slate-950 transition transform hover:-translate-y-1 shadow-lg"
      style={{ ['--accent' as any]: accent }}
    >
      <div className="relative w-full aspect-[400/220] bg-slate-900 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={title}
          width={400}
          height={220}
          loading="eager"
          decoding="async"
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover transition duration-300 group-hover:scale-[1.03]"
          onError={() => {
            if (!usedFallback) {
              setUsedFallback(true);
              setSrc(buildModeFallbackSvg(title, subtitle, accent));
            }
          }}
        />
        {badge && (
          <span className="absolute top-3 right-3 bg-black/70 text-white text-[10px] font-black px-2 py-1 rounded-full border border-white/20 backdrop-blur-sm">
            {badge}
          </span>
        )}
        <div
          className="pointer-events-none absolute inset-0 rounded-t-2xl opacity-0 group-hover:opacity-100 transition"
          style={{ boxShadow: `inset 0 0 0 2px ${accent}` }}
        />
      </div>
      <div className="flex-1 flex flex-col justify-center px-3.5 py-2.5 border-t border-slate-800 min-h-[64px]">
        <div className="text-sm font-black text-white leading-tight">{title}</div>
        {highlight ? (
          <div className="mt-1">{highlight}</div>
        ) : (
          <div className="text-[11px] text-slate-400 font-semibold mt-0.5">{subtitle}</div>
        )}
      </div>
    </Link>
  );
}
