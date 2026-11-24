import React from 'react';

/**
 * Inline SVG HUD icons (no emoji / Unicode glyphs — those render as tofu boxes on some Android
 * builds). All icons use currentColor so buttons can tint them.
 */
type P = { className?: string; size?: number };
const base = (size = 24) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const BulletIcon = ({ className, size = 34 }: P) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="M12 1.8c-1.9 1.5-3 3.9-3 6.4V18h6V8.2c0-2.5-1.1-4.9-3-6.4z" />
    <rect x="8.4" y="19" width="7.2" height="3.2" rx="0.6" />
  </svg>
);

export const ScopeIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </svg>
);

export const JumpIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="13" cy="3.6" r="1.8" fill="currentColor" stroke="none" />
    <path d="M9 9.5l3.5-2.5 3 2 2.5-1.5" />
    <path d="M12.5 7l-1 5 3 2.5-1 4" />
    <path d="M11.5 12l-3.5 2-1.5-2" />
    <path d="M4 22h16" strokeDasharray="2 2.5" />
  </svg>
);

export const CrouchIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="11" cy="6" r="1.8" fill="currentColor" stroke="none" />
    <path d="M11 8.5l1 5h4l-1 6" />
    <path d="M12 13.5l-4 1.5 1 4.5" />
    <path d="M11 9.5l4 1.5 3-1" />
    <path d="M4 21.5h16" />
  </svg>
);

export const ProneIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="19" cy="13.5" r="1.8" fill="currentColor" stroke="none" />
    <path d="M17 15.5H7l-4 1.5" />
    <path d="M15 15.5l2.5-3.5h3" />
    <path d="M10 15.5l-1.5-2.5" />
    <path d="M2 19.5h20" />
  </svg>
);

export const ReloadIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 3.5v4.5h-4.5" />
  </svg>
);

export const GrenadeIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <ellipse cx="11" cy="14.5" rx="5.5" ry="6.5" />
    <path d="M8.5 8.5V6.5h5v2" />
    <path d="M13.5 7.5c2.5-1 4.5 0 5 2" />
    <circle cx="19" cy="10.5" r="1.5" />
    <path d="M7 14.5h8M11 9.5v10" opacity="0.55" />
  </svg>
);

export const CrateIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="5" width="17" height="15" rx="1.2" />
    <path d="M3.5 10h17M3.5 15h17M8 5l8 15M16 5l-8 15" opacity="0.8" />
  </svg>
);

export const ChevronLeftIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className} strokeWidth={3}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const ChevronRightIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className} strokeWidth={3}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const EnterFullscreenIcon = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
);

export const ExitFullscreenIcon = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </svg>
);

export const SpeakerOnIcon = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);

export const SpeakerOffIcon = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none" />
    <path d="M16 9.5l5 5M21 9.5l-5 5" />
  </svg>
);

export const DropIcon = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3v12M7 10l5 5 5-5M5 20h14" />
  </svg>
);

export const MagnetIcon = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z" />
    <path d="M6 7h4M14 7h4" />
  </svg>
);

/** Window frame with an arrow going through it (vault through window). */
export const VaultIcon = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="7" y="4" width="10" height="13" rx="1" />
    <path d="M7 11h10" />
    <path d="M2 15c4-6 12-6 20-2" />
    <path d="M19 10.5l3 2.5-3.5 1.5" />
  </svg>
);
