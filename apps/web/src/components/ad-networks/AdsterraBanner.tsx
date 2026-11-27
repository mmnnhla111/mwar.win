'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AdBannerSpec } from '@mwar/shared';
import { AD_BANNER_INTERVAL_MIN_SECONDS, nextBannerIntervalSeconds } from '@mwar/shared';
import { apiFetch } from '../../lib/api';

/** Impression-cycle progress (30–45 s cycles) kept across an anti-AFK pause (banner unmounted) so charging resumes where it left off. */
const carryMs: Record<string, number> = {};

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** JSON for inline <script>, safe against "</script>" breakouts. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Adsterra iframe banner inside an isolated, sandboxed iframe:
 *  · `sandbox` without allow-same-origin → the ad code runs on an opaque origin and can never read
 *    our cookies / localStorage / auth token, nor touch the page; popups (clicks) may open new tabs.
 *  · Fixed box (width × height), overflow hidden, scaled down to the container width when narrower
 *    (e.g. 300 px creative in a 250 px sidebar), so it never overflows the layout.
 *  · Optional impression ping (`pingSlot`): one impression per randomized 30–45 s cycle while the tab is visible,
 *    batched (3 per request, flushed when the tab hides / the banner unmounts).
 */
export function AdsterraBanner({
  spec,
  pingSlot,
  onResult,
  className = '',
}: {
  spec: AdBannerSpec;
  pingSlot?: 'adsterra_320x50' | 'adsterra_300x250';
  onResult?: (r: any) => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useIsoLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, (el.parentElement?.clientWidth || spec.width) / spec.width));
    fit();
    const ro = new ResizeObserver(fit);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [spec.width]);

  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="origin"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;width:${spec.width}px;height:${spec.height}px}</style></head><body>` +
      `<script>atOptions={key:${js(spec.key)},format:'iframe',height:${spec.height},width:${spec.width},params:{}};</script>` +
      `<script data-cfasync="false" src="${attr(spec.src)}"></script></body></html>`,
    [spec.key, spec.src, spec.width, spec.height]
  );

  // Impression ping (random 30–45 s cycle, re-rolled after every impression; visible tab only), batched
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  useEffect(() => {
    if (!pingSlot) return;
    let pending = 0;
    let cycleMs = nextBannerIntervalSeconds() * 1000;
    const carried = Math.min(carryMs[pingSlot] || 0, AD_BANNER_INTERVAL_MIN_SECONDS * 1000 - 1000);
    carryMs[pingSlot] = 0;
    let visibleSince = document.visibilityState === 'visible' ? Date.now() - carried : 0;
    const flush = (keepalive = false) => {
      if (pending <= 0) return;
      const count = Math.min(10, pending);
      pending -= count;
      apiFetch('/api/ads/impression', { method: 'POST', body: JSON.stringify({ slot: pingSlot, count }), keepalive })
        .then((r) => onResultRef.current?.(r))
        .catch(() => {});
    };
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!visibleSince) visibleSince = Date.now();
      if (Date.now() - visibleSince >= cycleMs) {
        visibleSince = Date.now();
        cycleMs = nextBannerIntervalSeconds() * 1000;
        pending += 1;
        if (pending >= 3) flush();
      }
    }, 1000);
    const onVis = () => {
      if (document.visibilityState === 'visible') visibleSince = Date.now();
      else {
        visibleSince = 0;
        flush(true);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
      if (visibleSince) carryMs[pingSlot] = Date.now() - visibleSince;
      flush(true);
    };
  }, [pingSlot]);

  return (
    <div
      ref={wrapRef}
      className={`relative overflow-hidden mx-auto ${className}`}
      style={{ width: spec.width * scale, height: spec.height * scale, maxWidth: '100%' }}
      data-adsterra={`${spec.width}x${spec.height}`}
    >
      <iframe
        title="Sponsored"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="origin"
        scrolling="no"
        loading="lazy"
        width={spec.width}
        height={spec.height}
        style={{ width: spec.width, height: spec.height, border: 0, overflow: 'hidden', transform: `scale(${scale})`, transformOrigin: 'top left', display: 'block' }}
      />
    </div>
  );
}
