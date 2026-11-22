'use client';

import React from 'react';
import { INNER_PROPS, OUTER_PROPS, PROPS, PropId } from '../assets/disguiseProps';

/** Ring geometry in SVG viewBox units (viewBox is -260..260). */
export const RADIAL = { innerR0: 58, innerR1: 138, outerR0: 146, outerR1: 250, max: 252 };

/** Index into PROPS under a point (viewBox units, centre = 0,0) or null. */
export function propIndexAt(x: number, y: number): number | null {
  const r = Math.hypot(x, y);
  // 0 rad = straight up, clockwise
  let a = Math.atan2(x, -y);
  if (a < 0) a += Math.PI * 2;
  if (r >= RADIAL.innerR0 && r < RADIAL.innerR1) {
    const i = Math.floor(a / ((Math.PI * 2) / INNER_PROPS.length + 1e-9)) % INNER_PROPS.length;
    return PROPS.indexOf(INNER_PROPS[i]);
  }
  if (r >= RADIAL.outerR0 && r <= RADIAL.outerR1 + 6) {
    const i = Math.floor(a / ((Math.PI * 2) / OUTER_PROPS.length + 1e-9)) % OUTER_PROPS.length;
    return PROPS.indexOf(OUTER_PROPS[i]);
  }
  return null;
}

function arcPath(r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

interface Props {
  hover: number | null;
  cursor: { x: number; y: number } | null;
  current: PropId | null;
  onHover(index: number | null): void;
  onSelect(id: PropId): void;
  onClose(): void;
}

export default function RadialPropMenu({ hover, cursor, current, onHover, onSelect, onClose }: Props) {
  const hovered = hover !== null ? PROPS[hover] : null;
  const ring = (list: typeof PROPS, r0: number, r1: number) => {
    const step = (Math.PI * 2) / list.length;
    return list.map((p, i) => {
      const idx = PROPS.indexOf(p);
      const a0 = i * step + 0.012;
      const a1 = (i + 1) * step - 0.012;
      const mid = (a0 + a1) / 2;
      const rm = (r0 + r1) / 2;
      const active = hover === idx;
      const selected = current === p.id;
      return (
        <g
          key={p.id}
          onMouseEnter={() => onHover(idx)}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(p.id);
          }}
          onTouchStart={(e) => {
            e.stopPropagation();
            onSelect(p.id);
          }}
          className="cursor-pointer"
        >
          <path
            d={arcPath(r0, r1, a0, a1)}
            fill={active ? (p.solid ? 'rgba(245,158,11,0.9)' : 'rgba(56,189,248,0.85)') : selected ? 'rgba(30,41,59,0.95)' : 'rgba(15,23,42,0.82)'}
            stroke={active ? '#fff' : p.solid ? 'rgba(245,158,11,0.55)' : 'rgba(56,189,248,0.5)'}
            strokeWidth={active ? 2.5 : 1.2}
          />
          <text x={Math.sin(mid) * rm} y={-Math.cos(mid) * rm + 2} textAnchor="middle" dominantBaseline="middle" fontSize={p.ring === 'inner' ? 22 : 24}>
            {p.icon}
          </text>
          <text
            x={Math.sin(mid) * rm}
            y={-Math.cos(mid) * rm + 22}
            textAnchor="middle"
            fontSize={p.ring === 'inner' ? 7.5 : 8}
            fontWeight={800}
            fill={active ? '#0f172a' : '#cbd5e1'}
          >
            {p.name.length > 16 ? p.name.split(' ').slice(-2).join(' ') : p.name}
          </text>
        </g>
      );
    });
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <svg viewBox="-260 -260 520 520" className="w-[min(560px,94vmin)] h-[min(560px,94vmin)] drop-shadow-2xl select-none" onClick={(e) => e.stopPropagation()} onMouseLeave={() => onHover(null)}>
        {ring(OUTER_PROPS, RADIAL.outerR0, RADIAL.outerR1)}
        {ring(INNER_PROPS, RADIAL.innerR0, RADIAL.innerR1)}
        <circle r={RADIAL.innerR0 - 4} fill="rgba(2,6,23,0.92)" stroke="rgba(148,163,184,0.5)" />
        <text y={-14} textAnchor="middle" fontSize={9} fontWeight={900} fill="#94a3b8">
          PROP DISGUISE
        </text>
        <text y={3} textAnchor="middle" fontSize={hovered && hovered.name.length > 14 ? 8.5 : 10} fontWeight={900} fill="#fff">
          {hovered ? hovered.name : 'Pick a prop'}
        </text>
        <text y={18} textAnchor="middle" fontSize={7.5} fontWeight={800} fill={hovered ? (hovered.solid ? '#fbbf24' : '#7dd3fc') : '#64748b'}>
          {hovered ? (hovered.solid ? 'SOLID • blocks players' : 'SMALL • pass-through') : 'C / Esc to close'}
        </text>
        {cursor && <circle cx={cursor.x} cy={cursor.y} r={5} fill="#fff" stroke="#0f172a" strokeWidth={2} pointerEvents="none" />}
      </svg>
      <div className="pointer-events-none absolute bottom-[8%] left-1/2 -translate-x-1/2 text-[11px] font-black text-slate-200 bg-slate-950/80 border border-slate-700 rounded-full px-3 py-1">
        Inner ring: small (pass-through) • Outer ring: medium / large (solid) • Click to disguise
      </div>
    </div>
  );
}
