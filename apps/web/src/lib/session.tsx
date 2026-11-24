'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { BootstrapResponse } from '@mwar/shared';
import { getAuthToken, getBootstrap, isBootstrapFresh, logout, patchBootstrapCache, readBootstrapCache } from './api';

type Status = 'loading' | 'ready' | 'anon';

interface SessionValue {
  boot: BootstrapResponse | null;
  status: Status;
  /** Re-fetch /api/bootstrap (force=true ignores the 60 s fresh window). */
  refresh: (force?: boolean) => Promise<void>;
  /** Optimistic local update (no request), e.g. after claiming a quest or reading notifications. */
  patch: (fn: (b: BootstrapResponse) => BootstrapResponse) => void;
  signOut: () => void;
}

const SessionCtx = createContext<SessionValue | null>(null);

/**
 * Holds the single /api/bootstrap payload for the whole app. Navigation re-checks it only when the 60 s
 * fresh window has passed, so moving between pages normally costs zero API calls. No polling.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const mounted = useRef(true);

  const load = useCallback(async (force = false) => {
    if (!getAuthToken()) {
      setBoot(null);
      setStatus('anon');
      return;
    }
    const cached = readBootstrapCache();
    if (cached) {
      setBoot(cached.data);
      setStatus('ready');
      if (!force && isBootstrapFresh()) return;
    }
    try {
      const data = await getBootstrap(force);
      if (!mounted.current) return;
      setBoot(data);
      setStatus('ready');
    } catch (err: any) {
      if (!mounted.current) return;
      if (err?.status === 401 || err?.status === 404) {
        logout();
        setBoot(null);
        setStatus('anon');
      } else if (!cached) {
        // Network / server hiccup: keep the user signed in, show the shell without numbers
        setStatus('ready');
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // On first load and on every route change (cheap: served from cache while fresh).
  // The 3D game makes its own calls, so the shell does not fetch while a match is open.
  useEffect(() => {
    if (pathname === '/game' || pathname?.startsWith('/game/')) {
      const cached = readBootstrapCache();
      if (cached) setBoot(cached.data);
      return;
    }
    load(false);
  }, [pathname, load]);

  const patch = useCallback((fn: (b: BootstrapResponse) => BootstrapResponse) => {
    const next = patchBootstrapCache(fn);
    if (next) setBoot(next);
  }, []);

  const signOut = useCallback(() => {
    logout();
    setBoot(null);
    setStatus('anon');
  }, []);

  return <SessionCtx.Provider value={{ boot, status, refresh: load, patch, signOut }}>{children}</SessionCtx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}
