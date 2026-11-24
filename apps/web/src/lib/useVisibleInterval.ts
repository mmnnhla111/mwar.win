'use client';

import { useEffect, useRef } from 'react';

/**
 * Polls `fn` every `ms` while the tab is visible. Polling stops completely while
 * `document.hidden` is true; when the tab becomes visible again it refreshes once
 * (if the last run is older than `ms`) and resumes. Keeps Worker / D1 requests low.
 */
export function useVisibleInterval(fn: () => void, ms: number, enabled = true, deps: unknown[] = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastRun = Date.now();
    const run = () => {
      lastRun = Date.now();
      fnRef.current();
    };
    const start = () => {
      if (timer) return;
      timer = setInterval(run, ms);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.hidden) stop();
      else {
        if (Date.now() - lastRun >= ms) run();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, enabled, ...deps]);
}
