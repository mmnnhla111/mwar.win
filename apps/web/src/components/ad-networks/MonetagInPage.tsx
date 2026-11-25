'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { loadAdConfig } from '../../lib/ads';

/** Pages where the Monetag In-Page Push may run. Never on /game (or any other page). */
const INPAGE_PATHS = ['/', '/profile', '/games', '/marketplace', '/wallet', '/network'];
const INJECTED_FLAG = '__mwarInpageInjected';

export function inpageAllowed(pathname: string) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return INPAGE_PATHS.some((a) => (a === '/' ? p === '/' : p === a || p.startsWith(`${a}/`)));
}

/**
 * Monetag In-Page Push: injected once (live mode, Monetag enabled, allowed page only), with the zone
 * and tag URL taken from the sanitized server config — never raw script HTML. A third-party tag cannot
 * be unloaded from a running page, so when the player moves to a page where it is not allowed
 * (above all the /game combat screen), the page is reloaded once to come back clean.
 */
export function MonetagInPage() {
  const pathname = usePathname() || '/';
  const allowed = inpageAllowed(pathname);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    if (!allowed) {
      if (w[INJECTED_FLAG]) window.location.replace(window.location.href);
      return;
    }
    let alive = true;
    loadAdConfig().then((cfg) => {
      const inpage = cfg?.adMode === 'live' && cfg.monetagEnabled ? cfg.inpage : null;
      if (!alive || !inpage || w[INJECTED_FLAG] || !inpageAllowed(window.location.pathname)) return;
      w[INJECTED_FLAG] = true;
      const s = document.createElement('script');
      s.dataset.zone = inpage.zoneId;
      s.src = inpage.src;
      s.async = true;
      s.setAttribute('data-mwar-inpage', '1');
      (document.body || document.documentElement).appendChild(s);
    });
    return () => {
      alive = false;
    };
  }, [allowed]);

  return null;
}
