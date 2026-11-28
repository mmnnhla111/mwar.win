'use client';

import React, { useEffect, useRef } from 'react';
import { PROPS, type PropDef, type PropId } from '../assets/disguiseProps';

/**
 * Radial prop-disguise wheel (C). Every prop in PROPS is on screen at once, grouped into three rings:
 *   inner  - small props (pass-through)
 *   middle - street props (solid)
 *   outer  - military / industrial props followed by indoor furniture (solid)
 * Each group has its own accent colour (legend, top-left). Input: mouse hover / click, the virtual cursor driven
 * by game/page.tsx while the pointer is locked (via propIndexAt), touch (touch & slide, release to pick),
 * and the keyboard (arrows move, Enter / Space picks, C / Esc closes - Esc / C are handled by the page).
 */

export type PropCategory = 'small' | 'street' | 'military' | 'indoor';

const CATEGORY_OF: Partial<Record<PropId, PropCategory>> = {
  supply_crate: 'military',
  oil_drum: 'military',
  sandbag_barrier: 'military',
  tire_stack: 'military',
  wooden_pallet: 'military',
  generator_box: 'military',
  ammo_chest: 'military',
  office_desk: 'indoor',
  office_chair: 'indoor',
  filing_cabinet: 'indoor',
  metal_locker: 'indoor',
  storage_shelf: 'indoor',
  bunk_bed: 'indoor',
  tv_stand: 'indoor',
  water_cooler: 'indoor',
  sofa: 'indoor',
};

/** Category of a prop; unknown outer-ring props default to 'street' so a new catalogue entry never disappears. */
export function categoryOf(p: PropDef): PropCategory {
  if (p.ring === 'inner') return 'small';
  return CATEGORY_OF[p.id] ?? 'street';
}

const CATEGORY_STYLE: Record<PropCategory, { label: string; rgb: string; hex: string }> = {
  small: { label: 'Small (pass-through)', rgb: '56,189,248', hex: '#38bdf8' },
  street: { label: 'Street', rgb: '245,158,11', hex: '#fbbf24' },
  military: { label: 'Military / Industrial', rgb: '132,204,22', hex: '#a3e635' },
  indoor: { label: 'Indoor', rgb: '167,139,250', hex: '#c4b5fd' },
};

const SMALL_LIST = PROPS.filter((p) => categoryOf(p) === 'small');
const STREET_LIST = PROPS.filter((p) => categoryOf(p) === 'street');
const OUTER_LIST = [...PROPS.filter((p) => categoryOf(p) === 'military'), ...PROPS.filter((p) => categoryOf(p) === 'indoor')];

/** Ring geometry in SVG viewBox units (viewBox is -260..260). */
export const RADIAL = {
  innerR0: 50,
  innerR1: 108,
  midR0: 114,
  midR1: 176,
  outerR0: 182,
  outerR1: 250,
  max: 252,
};

interface RingDef {
  list: PropDef[];
  r0: number;
  r1: number;
  icon: number;
  font: number;
  wrap: number;
}

const RINGS: RingDef[] = [
  { list: SMALL_LIST, r0: RADIAL.innerR0, r1: RADIAL.innerR1, icon: 20, font: 6.6, wrap: 11 },
  { list: STREET_LIST, r0: RADIAL.midR0, r1: RADIAL.midR1, icon: 22, font: 7, wrap: 13 },
  { list: OUTER_LIST, r0: RADIAL.outerR0, r1: RADIAL.outerR1, icon: 22, font: 7, wrap: 14 },
];

/** Index into PROPS under a point (viewBox units, centre = 0,0) or null. */
export function propIndexAt(x: number, y: number): number | null {
  const r = Math.hypot(x, y);
  // 0 rad = straight up, clockwise
  let a = Math.atan2(x, -y);
  if (a < 0) a += Math.PI * 2;
  for (const ring of RINGS) {
    const hi = ring === RINGS[2] ? ring.r1 + 6 : ring.r1 + 3;
    if (r >= ring.r0 - (ring === RINGS[0] ? 0 : 3) && r < hi) {
      const n = ring.list.length;
      if (!n) return null;
      const i = Math.floor(a / ((Math.PI * 2) / n + 1e-9)) % n;
      return PROPS.indexOf(ring.list[i]);
    }
  }
  return null;
}

function arcPath(r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

/** Greedy word wrap into at most 2 lines of ~max characters. */
function wrapName(name: string, max: number): string[] {
  if (name.length <= max) return [name];
  const words = name.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) return [lines[0], lines.slice(1).join(' ')];
  return lines;
}

/** Keyboard navigation: next / previous in the same ring, or the angularly nearest item of the ring above / below. */
function stepIndex(idx: number, dir: 'next' | 'prev' | 'out' | 'in'): number {
  const prop = PROPS[idx];
  const ringIdx = RINGS.findIndex((r) => r.list.includes(prop));
  if (ringIdx < 0) return idx;
  const ring = RINGS[ringIdx];
  const i = ring.list.indexOf(prop);
  const n = ring.list.length;
  if (dir === 'next') return PROPS.indexOf(ring.list[(i + 1) % n]);
  if (dir === 'prev') return PROPS.indexOf(ring.list[(i - 1 + n) % n]);
  const target = RINGS[ringIdx + (dir === 'out' ? 1 : -1)];
  if (!target) return idx;
  const frac = (i + 0.5) / n;
  let best = 0;
  let bestD = Infinity;
  target.list.forEach((_, j) => {
    const f = (j + 0.5) / target.list.length;
    const d = Math.min(Math.abs(f - frac), 1 - Math.abs(f - frac));
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  });
  return PROPS.indexOf(target.list[best]);
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
  const hoveredCat = hovered ? CATEGORY_STYLE[categoryOf(hovered)] : null;
  const svgRef = useRef<SVGSVGElement>(null);
  const latest = useRef({ hover, current, onHover, onSelect });
  latest.current = { hover, current, onHover, onSelect };

  // Keyboard: arrows move the highlight, Enter / Space picks. Captured so the game does not also jump / move.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { hover: h, current: cur, onHover: setHover, onSelect: pick } = latest.current;
      let dir: 'next' | 'prev' | 'out' | 'in' | null = null;
      switch (e.code) {
        case 'ArrowRight':
        case 'Tab':
          dir = e.code === 'Tab' && e.shiftKey ? 'prev' : 'next';
          break;
        case 'ArrowLeft':
          dir = 'prev';
          break;
        case 'ArrowUp':
          dir = 'out';
          break;
        case 'ArrowDown':
          dir = 'in';
          break;
        case 'Enter':
        case 'NumpadEnter':
        case 'Space':
          if (h !== null) {
            e.preventDefault();
            e.stopPropagation();
            pick(PROPS[h].id);
          }
          return;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (h === null) {
        const start = cur ? PROPS.findIndex((p) => p.id === cur) : -1;
        setHover(start >= 0 ? start : PROPS.indexOf(RINGS[2].list[0]));
      } else setHover(stepIndex(h, dir));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Touch: touch / slide to preview (name shows in the centre), release to pick.
  const idxFromTouch = (t: React.Touch): number | null => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return propIndexAt(((t.clientX - r.left) / r.width) * 520 - 260, ((t.clientY - r.top) / r.height) * 520 - 260);
  };

  const ringNodes = RINGS.map((ring) => {
    const n = ring.list.length;
    const step = (Math.PI * 2) / n;
    return ring.list.map((p, i) => {
      const idx = PROPS.indexOf(p);
      const cat = CATEGORY_STYLE[categoryOf(p)];
      const a0 = i * step + 0.012;
      const a1 = (i + 1) * step - 0.012;
      const mid = (a0 + a1) / 2;
      const rm = (ring.r0 + ring.r1) / 2;
      const active = hover === idx;
      const selected = current === p.id;
      const lines = wrapName(p.name, ring.wrap);
      const cx = Math.sin(mid) * rm;
      const cy = -Math.cos(mid) * rm;
      const top = cy - (lines.length > 1 ? 11 : 8);
      return (
        <g
          key={p.id}
          role="menuitem"
          aria-label={`${p.name}${p.solid ? ' (solid)' : ' (small)'}`}
          onMouseEnter={() => onHover(idx)}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(p.id);
          }}
          className="cursor-pointer"
        >
          <path
            d={arcPath(ring.r0, ring.r1, a0, a1)}
            fill={active ? `rgba(${cat.rgb},0.9)` : selected ? 'rgba(51,65,85,0.97)' : 'rgba(15,23,42,0.84)'}
            stroke={active ? '#fff' : selected ? '#f8fafc' : `rgba(${cat.rgb},0.55)`}
            strokeWidth={active ? 2.5 : selected ? 2 : 1.1}
            strokeDasharray={selected && !active ? '4 3' : undefined}
          />
          <text x={cx} y={top + 2} textAnchor="middle" dominantBaseline="middle" fontSize={ring.icon} pointerEvents="none">
            {p.icon}
          </text>
          {lines.map((ln, k) => (
            <text
              key={k}
              x={cx}
              y={top + ring.icon * 0.78 + 7 + k * (ring.font + 1.6)}
              textAnchor="middle"
              fontSize={ring.font}
              fontWeight={800}
              fill={active ? '#0f172a' : '#cbd5e1'}
              pointerEvents="none"
            >
              {ln}
            </text>
          ))}
          {selected && (
            <circle cx={Math.sin(mid) * (ring.r1 - 7)} cy={-Math.cos(mid) * (ring.r1 - 7)} r={3} fill="#22c55e" stroke="#0f172a" strokeWidth={1} pointerEvents="none" />
          )}
        </g>
      );
    });
  });

  const nameLines = hovered ? wrapName(hovered.name, 15) : [];

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <svg
        ref={svgRef}
        role="menu"
        aria-label="Prop disguise"
        viewBox="-260 -260 520 520"
        className="w-[min(600px,96vmin)] h-[min(600px,96vmin)] drop-shadow-2xl select-none touch-none"
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={() => onHover(null)}
        onTouchStart={(e) => {
          e.stopPropagation();
          const t = e.touches[0];
          if (t) onHover(idxFromTouch(t));
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
          const t = e.touches[0];
          if (t) onHover(idxFromTouch(t));
        }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          const t = e.changedTouches[0];
          const idx = t ? idxFromTouch(t) : null;
          if (idx !== null) {
            e.preventDefault();
            onSelect(PROPS[idx].id);
          } else onHover(null);
        }}
      >
        {ringNodes}
        <circle r={RADIAL.innerR0 - 4} fill="rgba(2,6,23,0.94)" stroke="rgba(148,163,184,0.5)" />
        {hovered && hoveredCat ? (
          <g pointerEvents="none">
            <text y={-22} textAnchor="middle" fontSize={6.5} fontWeight={900} fill={hoveredCat.hex}>
              {hoveredCat.label.toUpperCase()}
            </text>
            {nameLines.map((ln, k) => (
              <text key={k} y={-8 + k * 11 + (nameLines.length > 1 ? 0 : 6)} textAnchor="middle" fontSize={nameLines.length > 1 ? 9 : 9.5} fontWeight={900} fill="#fff">
                {ln}
              </text>
            ))}
            <text y={nameLines.length > 1 ? 18 : 20} textAnchor="middle" fontSize={6.5} fontWeight={700} fill="#94a3b8">
              {hovered.size[0]} × {hovered.size[1]} × {hovered.size[2]} m
            </text>
            <text y={nameLines.length > 1 ? 28 : 30} textAnchor="middle" fontSize={6.5} fontWeight={900} fill={hovered.solid ? '#fbbf24' : '#7dd3fc'}>
              {hovered.solid ? 'SOLID' : 'PASS-THROUGH'}
            </text>
          </g>
        ) : (
          <g pointerEvents="none">
            <text y={-10} textAnchor="middle" fontSize={8} fontWeight={900} fill="#94a3b8">
              PROP DISGUISE
            </text>
            <text y={4} textAnchor="middle" fontSize={10} fontWeight={900} fill="#fff">
              Pick a prop
            </text>
            <text y={18} textAnchor="middle" fontSize={7} fontWeight={800} fill="#64748b">
              C / Esc to close
            </text>
          </g>
        )}
        {cursor && <circle cx={cursor.x} cy={cursor.y} r={5} fill="#fff" stroke="#0f172a" strokeWidth={2} pointerEvents="none" />}
      </svg>

      {/* Legend (top-left): ring colours */}
      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1 rounded-lg border border-slate-700 bg-slate-950/80 px-2 py-1.5 text-[10px] font-black text-slate-200 sm:text-[11px]">
        {(Object.keys(CATEGORY_STYLE) as PropCategory[]).map((c) => (
          <div key={c} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CATEGORY_STYLE[c].hex }} />
            <span>{CATEGORY_STYLE[c].label}</span>
          </div>
        ))}
        <div className="mt-0.5 text-[9px] font-bold text-slate-400">Inner → outer: small, street, military + indoor</div>
      </div>

      {/* Close button (touch friendly) + hints (top-right) */}
      <div className="absolute right-2 top-2 flex max-w-[44vw] flex-col items-end gap-1">
        <button
          type="button"
          aria-label="Close prop menu"
          className="h-9 w-9 rounded-full border border-slate-600 bg-slate-950/85 text-base font-black text-slate-100 active:bg-slate-800"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          onTouchEnd={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          }}
        >
          ✕
        </button>
        <div className="pointer-events-none rounded-lg border border-slate-700 bg-slate-950/80 px-2 py-1 text-right text-[10px] font-black leading-snug text-slate-300">
          Click / tap to disguise
          <br />
          Arrows + Enter • C / Esc closes
        </div>
      </div>
    </div>
  );
}
