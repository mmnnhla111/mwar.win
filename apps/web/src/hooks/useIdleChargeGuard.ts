'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AD_IDLE_PAUSE_MS } from '@mwar/shared';
import { getLastActiveAt, markActive } from '../lib/activity';

export type IdlePauseReason = 'idle' | 'hidden';

/**
 * Anti-AFK guard for EC charging screens (Practice / Solo bots, Ghost Spectator, EC recharge and
 * "ให้กำลังใจ" modals). While `enabled`, it pauses when there is no mouse / touch / key / scroll input for
 * `idleTimeoutMs` (35 s) or the tab is hidden. Once paused it stays paused until `resume()` (the
 * "Resume Charging" button), so a banner never charges unattended. Cheap: one 1 s check + throttled
 * passive listeners shared app-wide (lib/activity).
 */
export function useIdleChargeGuard({ idleTimeoutMs = AD_IDLE_PAUSE_MS, enabled }: { idleTimeoutMs?: number; enabled: boolean }) {
  const [paused, setPaused] = useState<IdlePauseReason | null>(null);
  const pausedRef = useRef<IdlePauseReason | null>(null);
  pausedRef.current = paused;

  useEffect(() => {
    if (!enabled) {
      setPaused(null);
      return;
    }
    // Starting (or re-enabling) a charging screen counts as activity
    markActive();
    const check = () => {
      if (pausedRef.current) return;
      if (document.visibilityState === 'hidden') setPaused('hidden');
      else if (Date.now() - getLastActiveAt() >= idleTimeoutMs) setPaused('idle');
    };
    const id = window.setInterval(check, 1000);
    const onVis = () => check();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onVis);
    };
  }, [enabled, idleTimeoutMs]);

  const resume = useCallback(() => {
    markActive();
    setPaused(null);
  }, []);

  return { paused: enabled ? paused : null, isPaused: enabled && paused !== null, resume };
}
