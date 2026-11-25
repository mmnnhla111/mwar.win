'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { claimDirectLink, startDirectLink, type DirectLinkClaimResult } from '../../lib/ads';
import { useTranslation } from '../../i18n/I18nProvider';

type Visit =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'away'; token: string; launchUrl: string; required: number; awayMs: number; opened: boolean }
  | { kind: 'claiming' }
  | { kind: 'done'; result: DirectLinkClaimResult }
  | { kind: 'error'; message: string; code?: string };

const isAway = () => document.visibilityState === 'hidden' || !document.hasFocus();

/**
 * Live-mode rewarded "visit": open the network's direct link in a new tab, count only the time the
 * player actually spends away on the ad (tab hidden / window blurred, via visibilitychange + focus),
 * then claim automatically when they come back. The server re-checks the time with its own clock.
 *
 * `begin` must be called straight from a click so the new tab is not blocked as a popup.
 */
export function useDirectLinkVisit(onDone?: (r: DirectLinkClaimResult) => void) {
  const [visit, setVisit] = useState<Visit>({ kind: 'idle' });
  const visitRef = useRef(visit);
  visitRef.current = visit;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const claim = useCallback(async (token: string, attempt = 0) => {
    setVisit({ kind: 'claiming' });
    try {
      const r = await claimDirectLink(token);
      setVisit({ kind: 'done', result: r });
      onDoneRef.current?.(r);
    } catch (e: any) {
      // Server clock says "not yet": wait the few seconds it asks for, once or twice
      if (e?.code === 'AD_TOO_EARLY' && attempt < 2) {
        window.setTimeout(() => claim(token, attempt + 1), 2000);
        return;
      }
      setVisit({ kind: 'error', message: e?.message || 'Error', code: e?.code });
    }
  }, []);

  const begin = useCallback(async (body: Parameters<typeof startDirectLink>[0]) => {
    // Open the tab synchronously inside the click (popup blockers), point it at the ad once we have it
    let w: Window | null = null;
    try {
      w = window.open('about:blank', '_blank');
    } catch {
      w = null;
    }
    setVisit({ kind: 'starting' });
    try {
      const r = await startDirectLink(body);
      let opened = false;
      if (w && !w.closed) {
        try {
          w.opener = null;
          w.location.href = r.launchUrl;
          opened = true;
        } catch {
          opened = false;
        }
      }
      setVisit({ kind: 'away', token: r.token, launchUrl: r.launchUrl, required: r.requiredSeconds, awayMs: 0, opened });
      return r;
    } catch (e: any) {
      try {
        w?.close();
      } catch {
        /* ignore */
      }
      setVisit({ kind: 'error', message: e?.message || 'Error', code: e?.code });
      throw e;
    }
  }, []);

  // Count "away" time; claim once the required time is reached and the player is back on our page
  const away = visit.kind === 'away';
  useEffect(() => {
    if (!away) return;
    let last = Date.now();
    const step = () => {
      const v = visitRef.current;
      if (v.kind !== 'away') return;
      const now = Date.now();
      const dt = now - last;
      last = now;
      const awayMs = v.opened && isAway() ? v.awayMs + dt : v.awayMs;
      const ready = awayMs >= v.required * 1000;
      if (ready && !isAway()) {
        claim(v.token);
        return;
      }
      if (awayMs !== v.awayMs) setVisit({ ...v, awayMs });
    };
    const id = window.setInterval(step, 250);
    const onChange = () => step();
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', onChange);
    window.addEventListener('blur', onChange);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onChange);
      window.removeEventListener('blur', onChange);
    };
  }, [away, claim]);

  const markOpened = useCallback(() => {
    const v = visitRef.current;
    if (v.kind === 'away') setVisit({ ...v, opened: true });
  }, []);
  const reset = useCallback(() => setVisit({ kind: 'idle' }), []);

  return { visit, begin, markOpened, reset };
}

/** Countdown card for a running visit (light theme for the web modals, dark for the game HUD). */
export function DirectLinkCountdown({ visit, onOpen, dark = false }: { visit: Visit; onOpen: () => void; dark?: boolean }) {
  const { t } = useTranslation();
  if (visit.kind !== 'away') return null;
  const left = Math.max(0, Math.ceil(visit.required - visit.awayMs / 1000));
  const pct = Math.min(100, (visit.awayMs / (visit.required * 1000)) * 100);
  const ready = left <= 0;
  return (
    <div className="space-y-3" data-direct-link={ready ? 'ready' : 'counting'}>
      <div
        className={`rounded-2xl px-4 py-4 text-center border ${dark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-gradient-to-br from-[#FFF6C2] via-[#FFFBEA] to-[#E0F2FE] border-stone-100 text-stone-800'}`}
      >
        <div className="text-3xl" aria-hidden>
          🔗
        </div>
        <div className="mt-1 font-bold">{ready ? t('ads.visitReady') : t('ads.visitStay', { s: visit.required })}</div>
        <div className={`text-xs ${dark ? 'text-slate-400' : 'text-stone-500'}`}>{ready ? t('ads.visitComeBack') : t('ads.visitHint')}</div>
        <a
          href={visit.launchUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onOpen}
          className={`mt-3 inline-block rounded-full px-4 py-1.5 text-xs font-extrabold ${dark ? 'bg-amber-400 text-slate-950' : 'bg-[#FFE135] text-stone-900'}`}
          data-direct-link-open
        >
          {visit.opened ? t('ads.visitOpenAgain') : t('ads.visitOpen')}
        </a>
      </div>
      <div className={`h-2 rounded-full overflow-hidden ${dark ? 'bg-slate-800' : 'bg-stone-100'}`}>
        <div className="h-full bg-[#FACC15] transition-[width] duration-300 ease-linear" style={{ width: `${pct}%` }} />
      </div>
      <div className={`text-center text-sm font-bold ${dark ? 'text-slate-200' : 'text-stone-700'}`} data-direct-link-left={left}>
        {ready ? t('ads.visitClaimSoon') : t('cheer.secondsLeft', { s: left })}
      </div>
    </div>
  );
}

/** Game HUD (Solo / Practice / Ghost): live-mode EC recharge through a direct-link visit. */
export function DirectLinkAdModal({ seconds, onClose, onResult }: { seconds: 15 | 30; onClose: () => void; onResult?: (r: any) => void }) {
  const { t } = useTranslation();
  const started = useRef(false);
  const { visit, begin, markOpened } = useDirectLinkVisit((r) =>
    onResult?.({
      format: 'video',
      ecProgressAddedPct: r.ecProgressAddedPct,
      energy_tickets: r.energyTickets,
      max_energy_tickets: r.maxEnergyTickets,
      energy_progress_pct: r.energyProgressPct,
      ticketsAwarded: r.ticketsAwarded,
    })
  );
  return (
    <div className="absolute inset-0 z-[90] bg-black/70 flex items-center justify-center p-4 pointer-events-auto" onMouseDown={(e) => e.stopPropagation()}>
      <div className="w-full max-w-sm rounded-2xl bg-slate-950 border border-slate-700 p-5 space-y-4 text-slate-100" data-direct-link-modal>
        <div className="font-black text-amber-300">⚡ {t('ads.rechargeTitle')}</div>
        {visit.kind === 'idle' && (
          <button
            className="w-full rounded-xl bg-amber-400 text-slate-950 font-black py-2.5"
            onClick={() => {
              if (started.current) return;
              started.current = true;
              begin({ purpose: 'ec_recharge', seconds }).catch(() => {
                started.current = false;
              });
            }}
            data-direct-link-start
          >
            {t('ads.visitStart', { s: seconds })}
          </button>
        )}
        {visit.kind === 'starting' && <div className="text-sm text-slate-400">…</div>}
        <DirectLinkCountdown visit={visit} onOpen={markOpened} dark />
        {visit.kind === 'claiming' && <div className="text-sm text-slate-400">{t('cheer.claiming')}</div>}
        {visit.kind === 'done' && (
          <div className="text-sm font-bold text-emerald-300" data-direct-link-done>
            {visit.result.ticketsAwarded > 0 ? t('cheer.gotTickets', { n: visit.result.ticketsAwarded }) : t('cheer.gotProgress', { pct: Math.round(visit.result.ecProgressAddedPct * 10) / 10 })}
          </div>
        )}
        {visit.kind === 'error' && <div className="text-sm text-rose-300">{visit.message}</div>}
        <button className="w-full rounded-xl border border-slate-600 py-2 text-sm font-bold" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
