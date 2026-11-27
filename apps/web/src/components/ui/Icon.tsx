import React from 'react';

/**
 * Tiny inline-SVG icon set (stroke icons, 24x24 grid). No icon library, so the bundle only carries
 * the few path strings below.
 */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  games: 'M7 8h10a5 5 0 0 1 4.9 6l-.6 3a2.5 2.5 0 0 1-4.3 1.2L15 16H9l-2 2.2A2.5 2.5 0 0 1 2.7 17l-.6-3A5 5 0 0 1 7 8zM7.5 11v3M6 12.5h3M15.5 12h.01M17.5 14h.01',
  market: 'M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9zM9 8V6a3 3 0 0 1 6 0v2',
  wallet: 'M4 7a2 2 0 0 1 2-2h12v4M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2zM16 14.5h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 6',
  chat: 'M4 5h16v11H9l-5 4z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z',
  network: 'M12 3v5M12 8a2 2 0 1 0 0 .01M5 16a2 2 0 1 0 0 .01M19 16a2 2 0 1 0 0 .01M12 10l-6 4.5M12 10l6 4.5M12 10v6M12 18a2 2 0 1 0 0 .01',
  plus: 'M12 5v14M5 12h14',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  comment: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  share: 'M8 12h.01M16 6a2 2 0 1 0 0-.01M16 18a2 2 0 1 0 0-.01M8 12a2 2 0 1 0 0-.01M9.8 11 14.2 7M9.8 13l4.4 4',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18M15.5 9h.01',
  close: 'M6 6l12 12M18 6 6 18',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  quest: 'M9 4h6v3H9zM7 5.5H5.5V21h13V5.5H17M8.5 12l2 2 4-4M8.5 17.5h7',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  check: 'M5 12.5l4.5 4.5L19 7',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  coin: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM14.5 9.5c-.4-.9-1.3-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.1-.6-2.5-1.5M12 6.5v1.5M12 16v1.5',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  // V1.1 Cheer / Support: an open hand holding a small heart + a sparkle (never a thumbs-up, never the Like heart)
  cheer: 'M12 11.6s-3.6-2.2-3.6-4.8a2 2 0 0 1 3.6-1.3 2 2 0 0 1 3.6 1.3c0 2.6-3.6 4.8-3.6 4.8zM3 14.2h3.2l3 1.9h3.6a1.3 1.3 0 0 1 0 2.6H9.6M12.8 18.7l5.4-2.4a1.4 1.4 0 0 1 1.3 2.5L14 21.4H6.4L3 19.9M19 2.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z',
  megaphone: 'M4 10v4h3l7 4V6l-7 4zM17 9a4 4 0 0 1 0 6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 22,
  className = '',
  filled = false,
  strokeWidth = 1.9,
}: {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The lemon-badge brand mark. */
/** mwar.win "MW$" brand mark (public/brand/logo-mark.webp, from Lah's Logo-without-text.png). */
export function LemonLogo({ size = 34 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/logo-mark.webp" width={Math.round(size * 0.89)} height={size} alt="" aria-hidden="true" decoding="async" className="shrink-0 object-contain" style={{ width: Math.round(size * 0.89), height: size }} />
  );
}

/** Full logo with "mwar.win · Money War" (public/brand/logo-full.webp, from Logo-with-text.png). */
export function BrandLogoFull({ height = 96, alt = 'mwar.win — Money War' }: { height?: number; alt?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/logo-full.webp" width={Math.round(height * 0.78)} height={height} alt={alt} decoding="async" className="object-contain" style={{ width: Math.round(height * 0.78), height }} />
  );
}
