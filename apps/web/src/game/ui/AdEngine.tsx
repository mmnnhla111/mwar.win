'use client';

/**
 * Ad Simulation Engine (client side).
 *  · SimulatedAdBanner — rotating simulated creatives in the bottom slot; every 20 s while the tab
 *    is visible it reports one impression (POST /api/ads/simulate-view, format 'banner'), which
 *    adds EC Recharge % in proportion to the banner's ad value (100 % = +1 EC).
 *  · RewardedVideoModal — simulated 15 s / 30 s rewarded video with a countdown. The server opens a
 *    video session first and only credits it after the full duration (15 s = +50 %, 30 s = +100 %).
 *  · RechargeVideoButtons — "Recharge EC via Video Ad" buttons (Practice / Spectator HUD, Arena screen).
 * Values come from the three-tier engine on the API: network payout → yesterday's average for the
 * country + format → Agy's country eCPM table in @mwar/shared.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AD_BANNER_INTERVAL_SECONDS } from '@mwar/shared';
import { apiFetch, getAuthToken } from '../../lib/api';

export interface AdEcResult {
  energy_tickets?: number;
  max_energy_tickets?: number;
  energy_progress_pct?: number;
  ecProgressAddedPct?: number;
  /** Banner impressions credited by this (batched) request. */
  impressions?: number;
  ticketsAwarded?: number;
  ticketsFull?: boolean;
  adValueMicroUsd?: number;
  valueSource?: string;
  country?: string;
  format?: string;
}

const CREATIVES = [
  { title: 'MWAR Marketplace', line: 'Trade skins with 30-day escrow', from: '#0ea5e9', to: '#6366f1' },
  { title: 'Squad Up', line: 'Invite friends • earn 5-tier upline rewards', from: '#f59e0b', to: '#ef4444' },
  { title: 'Daily Quests', line: 'Finish 4 quests to unlock your green ledger', from: '#10b981', to: '#0ea5e9' },
  { title: 'Ghost Spectator', line: 'Watch live arenas • earn EC from ads', from: '#8b5cf6', to: '#ec4899' },
];

/**
 * Completed banner impressions are batched: credited in one POST every BANNER_BATCH impressions,
 * or immediately when the player opens a video ad, deploys, hides the tab or leaves the page.
 * Keeps Worker / D1 requests ~5× lower than one request per 20 s banner.
 */
export const BANNER_BATCH = 5;
const BANNER_BATCH_MAX = 10;
let pendingBanners = 0;
let bannerFlushing = false;
let bannerResultCb: ((r: AdEcResult) => void) | null = null;
const bannerListeners = new Set<(pending: number) => void>();
const notifyPending = () => bannerListeners.forEach((f) => f(pendingBanners));

export function flushBannerImpressions(opts: { keepalive?: boolean } = {}) {
  if (pendingBanners <= 0 || bannerFlushing || !getAuthToken()) return;
  const count = Math.min(BANNER_BATCH_MAX, pendingBanners);
  bannerFlushing = true;
  apiFetch<AdEcResult>('/api/ads/simulate-view', {
    method: 'POST',
    body: JSON.stringify({ format: 'banner', purpose: 'ec_recharge', count }),
    keepalive: opts.keepalive,
  })
    .then((r) => {
      pendingBanners = Math.max(0, pendingBanners - count);
      notifyPending();
      bannerResultCb?.(r);
    })
    .catch(() => {
      /* rate-limited / offline: keep the impressions and retry with the next flush */
    })
    .finally(() => {
      bannerFlushing = false;
    });
}

/** Number of completed banner impressions waiting for the next batched credit. */
export function usePendingBanners() {
  const [n, setN] = useState(pendingBanners);
  useEffect(() => {
    bannerListeners.add(setN);
    return () => {
      bannerListeners.delete(setN);
    };
  }, []);
  return n;
}

export function SimulatedAdBanner({ className, onResult }: { className?: string; onResult?: (r: AdEcResult) => void }) {
  const [i, setI] = useState(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    bannerResultCb = (r) => onResultRef.current?.(r);
    let visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
    const onVis = () => {
      visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
      if (document.visibilityState === 'hidden') flushBannerImpressions({ keepalive: true });
    };
    const onHide = () => flushBannerImpressions({ keepalive: true });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    // One verified impression per 20 s of continuous visibility
    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible' || !visibleSince) return;
      if (Date.now() - visibleSince < AD_BANNER_INTERVAL_SECONDS * 1000 - 500) return;
      visibleSince = Date.now();
      // One creative per impression: the banner rotates only when its impression completes
      setI((x) => (x + 1) % CREATIVES.length);
      if (!getAuthToken()) return;
      pendingBanners = Math.min(BANNER_BATCH_MAX, pendingBanners + 1);
      notifyPending();
      if (pendingBanners >= BANNER_BATCH) flushBannerImpressions();
    }, 1000);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      flushBannerImpressions({ keepalive: true });
    };
  }, []);

  const c = CREATIVES[i];
  return (
    <div
      id="mwar-ad-banner"
      data-ad-slot="game-bottom"
      className={`relative overflow-hidden flex items-center gap-3 px-3 text-white select-none ${className ?? ''}`}
      style={{ background: `linear-gradient(90deg, ${c.from}, ${c.to})` }}
    >
      <span className="absolute top-0.5 right-1 text-[7px] font-black tracking-widest text-white/70">AD • SIMULATED</span>
      <div className="w-8 h-8 shrink-0 rounded-lg bg-white/20 flex items-center justify-center font-black text-xs">MW</div>
      <div className="min-w-0">
        <div className="text-[12px] font-black leading-tight truncate">{c.title}</div>
        <div className="text-[10px] font-semibold text-white/85 leading-tight truncate">{c.line}</div>
      </div>
    </div>
  );
}

type VideoFormat = 'video_15s' | 'video_30s';

export function RewardedVideoModal({
  format,
  purpose = 'ec_recharge',
  onClose,
  onResult,
}: {
  format: VideoFormat;
  purpose?: 'ec_recharge' | 'monetized';
  onClose: () => void;
  onResult?: (r: AdEcResult & Record<string, unknown>) => void;
}) {
  const duration = format === 'video_15s' ? 15 : 30;
  const [left, setLeft] = useState(duration);
  const [status, setStatus] = useState<'starting' | 'playing' | 'claiming' | 'done' | 'error'>('starting');
  const [message, setMessage] = useState('');
  const viewIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    apiFetch<{ viewId: string }>('/api/ads/video/start', { method: 'POST', body: JSON.stringify({ format, purpose }) })
      .then((r) => {
        if (cancelled) return;
        viewIdRef.current = r.viewId;
        setStatus('playing');
        const endAt = Date.now() + duration * 1000;
        timer = setInterval(() => {
          const s = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
          setLeft(s);
          if (s <= 0 && timer) {
            clearInterval(timer);
            timer = null;
            setStatus('claiming');
            apiFetch('/api/ads/simulate-view', { method: 'POST', body: JSON.stringify({ format, purpose, viewId: viewIdRef.current }) })
              .then((res: any) => {
                if (cancelled) return;
                setStatus('done');
                if (purpose === 'monetized') setMessage(`Postback test credited ${res.formattedReward ?? ''} (${res.valueSource ?? ''}, ${res.country ?? ''})`);
                else if (res.ticketsFull) setMessage('EC is already full (6/6) — impression logged.');
                else setMessage(`+${Math.round(res.ecProgressAddedPct ?? 0)}% EC recharge${res.ticketsAwarded ? ` • +${res.ticketsAwarded} EC!` : ''}`);
                onResult?.(res);
              })
              .catch((e: Error) => {
                if (cancelled) return;
                setStatus('error');
                setMessage(e.message);
              });
          }
        }, 250);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(getAuthToken() ? e.message : 'Sign in to recharge EC with video ads.');
      });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = ((duration - left) / duration) * 100;
  const canClose = status === 'done' || status === 'error';
  return (
    <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
      <div className="w-full max-w-md rounded-3xl overflow-hidden border border-slate-700 bg-slate-950 shadow-2xl">
        <div className="relative aspect-video bg-gradient-to-br from-indigo-700 via-fuchsia-600 to-amber-500 flex items-center justify-center">
          <div className="absolute inset-0 opacity-30 animate-pulse bg-[radial-gradient(circle_at_30%_30%,white,transparent_60%)]" />
          <div className="relative text-center text-white">
            <div className="text-[10px] font-black tracking-[0.3em] text-white/80">SIMULATED REWARDED VIDEO</div>
            <div className="text-2xl font-black mt-1">MWAR.WIN</div>
            <div className="text-xs font-semibold text-white/85 mt-1">{purpose === 'monetized' ? 'Monetized Ad Postback Test' : `${duration}s ad • ${duration === 30 ? '+100%' : '+50%'} EC`}</div>
          </div>
          <div className="absolute top-2 right-3 bg-black/60 text-white text-xs font-black px-2 py-0.5 rounded-full">
            {status === 'playing' ? `${left}s` : status === 'starting' ? '…' : '✓'}
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/40">
            <div className="h-full bg-white transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="p-4 space-y-3 text-center">
          <div className={`text-sm font-black ${status === 'error' ? 'text-rose-400' : 'text-amber-300'}`}>
            {status === 'starting' && 'Loading ad…'}
            {status === 'playing' && 'Watch to the end to get your reward'}
            {status === 'claiming' && 'Verifying view…'}
            {(status === 'done' || status === 'error') && message}
          </div>
          <button
            disabled={!canClose}
            onClick={onClose}
            className={`w-full py-2.5 rounded-xl text-xs font-black transition ${canClose ? 'bg-amber-500 hover:bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-500'}`}
          >
            {canClose ? 'CLOSE' : `Reward in ${left}s`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RechargeVideoButtons({ onPick, compact }: { onPick: (f: VideoFormat) => void; compact?: boolean }) {
  const btn = `rounded-full font-black border whitespace-nowrap transition active:scale-95 ${compact ? 'text-[10px] px-2.5 py-1' : 'text-xs px-3 py-1'}`;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="flex flex-nowrap gap-1.5 pointer-events-auto">
      <button title="Recharge EC via Video Ad (15 s)" onClick={() => onPick('video_15s')} onTouchStart={stop} onMouseDown={stop} className={`${btn} bg-slate-950/45 border-amber-300/40 text-amber-200 hover:bg-slate-900/70`}>
        ▶ 15s Video (+50% EC)
      </button>
      <button title="Recharge EC via Video Ad (30 s)" onClick={() => onPick('video_30s')} onTouchStart={stop} onMouseDown={stop} className={`${btn} bg-amber-500/85 border-white/50 text-slate-950 hover:bg-amber-400`}>
        ▶ 30s Video (+100% EC)
      </button>
    </div>
  );
}
