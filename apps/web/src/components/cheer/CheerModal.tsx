'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CheerAdFormat, CheerOption, CheerStatus, CheerTargetType } from '@mwar/shared';
import { MAX_ENERGY_TICKETS } from '@mwar/shared';
import { Modal, Spinner, btn } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { completeCheer, getCheerStatus, startCheer } from '../../lib/api';
import { formatEc } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useTranslation } from '../../i18n/I18nProvider';

type Phase =
  | { kind: 'menu' }
  | { kind: 'watching'; viewId: string; format: CheerAdFormat; total: number; endsAt: number }
  | { kind: 'claiming'; format: CheerAdFormat }
  | { kind: 'done'; format: CheerAdFormat; addedPct: number; ticketsAwarded: number };

const FORMAT_ICON: Record<CheerAdFormat, string> = { video_30s: '🎬', video_15s: '⚡', banner: '🪧' };

/** "+1 EC", "+50% EC", "+4.1% EC" */
function rewardLabel(bp: number): string {
  if (bp >= 10_000 && bp % 10_000 === 0) return `+${bp / 10_000} EC`;
  const pct = bp / 100;
  return `+${Number.isInteger(pct) ? pct : pct.toFixed(1)}% EC`;
}

/**
 * "ให้กำลังใจ" modal: shows only the ad formats the server says are ready right now, the daily quota
 * (e.g. 12/15 left) and per-creator quota, then runs a server-timed ad and claims it.
 * Requests: 1 status read when opened, 1 start + 1 claim per cheer. No polling.
 */
export function CheerModal({
  open,
  onClose,
  targetType,
  targetId,
  targetName,
  onCheered,
}: {
  open: boolean;
  onClose: () => void;
  targetType: CheerTargetType;
  targetId?: string | null;
  targetName?: string | null;
  onCheered?: (cheerCount: number | null) => void;
}) {
  const { t } = useTranslation();
  const { patch } = useSession();
  const [status, setStatus] = useState<CheerStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'menu' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const claimed = useRef<string | null>(null);

  const loadStatus = useCallback(async () => {
    setError(null);
    try {
      setStatus(await getCheerStatus(targetType, targetId));
    } catch (e: any) {
      setError(e?.message || t('cheer.errorGeneric'));
    }
  }, [targetType, targetId, t]);

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: 'menu' });
    setStatus(null);
    claimed.current = null;
    loadStatus();
  }, [open, loadStatus]);

  // 1 s ticker only while an ad is running or a cooldown is shown
  const ticking = open && (phase.kind === 'watching' || (phase.kind === 'menu' && (status?.cooldownRemaining || 0) > 0));
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  const claim = useCallback(
    async (viewId: string, format: CheerAdFormat, attempt = 0) => {
      if (claimed.current === viewId && attempt === 0) return;
      claimed.current = viewId;
      setPhase({ kind: 'claiming', format });
      try {
        const r = await completeCheer(viewId);
        setStatus(r.status);
        setPhase({ kind: 'done', format, addedPct: r.ecProgressAddedPct, ticketsAwarded: r.ticketsAwarded });
        patch((b) => ({ ...b, user: { ...b.user, energyTickets: r.energyTickets, maxEnergyTickets: r.maxEnergyTickets, energyProgressPct: r.energyProgressPct } }));
        onCheered?.(r.cheerCount);
      } catch (e: any) {
        // The server clock decides: if it says "not finished yet", wait and retry once
        if (e?.status === 425 && attempt < 2) {
          window.setTimeout(() => claim(viewId, format, attempt + 1), 1500);
          return;
        }
        setError(e?.status === 429 ? t('cheer.limitHit') : e?.message || t('cheer.errorGeneric'));
        setPhase({ kind: 'menu' });
        loadStatus();
      }
    },
    [patch, onCheered, loadStatus, t]
  );

  useEffect(() => {
    if (phase.kind === 'watching' && now >= phase.endsAt) claim(phase.viewId, phase.format);
  }, [phase, now, claim]);

  const pick = async (o: CheerOption) => {
    if (!o.available || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await startCheer({ format: o.format, targetType, targetId });
      const start = Date.now();
      setNow(start);
      setPhase({ kind: 'watching', viewId: r.viewId, format: o.format, total: r.durationSeconds, endsAt: start + r.durationSeconds * 1000 });
    } catch (e: any) {
      setError(e?.status === 429 ? t('cheer.limitHit') : e?.message || t('cheer.errorGeneric'));
      loadStatus();
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (phase.kind === 'watching' && !window.confirm(t('cheer.leaveConfirm'))) return;
    onClose();
  };

  const reasonText = (o: CheerOption) =>
    o.reason === 'daily_cap'
      ? t('cheer.reason.daily')
      : o.reason === 'target_cap'
        ? t('cheer.reason.target', { cap: status?.targetCap ?? 3 })
        : o.reason === 'own_content'
          ? t('cheer.reason.own')
          : o.reason === 'cooldown'
            ? t('cheer.reason.cooldown', { s: cooldownLeft })
            : t('cheer.reason.disabled');

  const fetchedAt = useRef(Date.now());
  useEffect(() => {
    if (status) fetchedAt.current = Date.now();
  }, [status]);
  const cooldownLeft = status ? Math.max(0, status.cooldownRemaining - Math.floor((now - fetchedAt.current) / 1000)) : 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-full bg-[#FFE135] text-stone-900 flex items-center justify-center">
            <Icon name="cheer" size={17} />
          </span>
          {t('cheer.title')}
        </span>
      }
    >
      <div className="p-5 space-y-4" data-cheer-modal>
        <p className="text-sm text-stone-600">
          {targetType === 'energy' ? t('cheer.introEnergy') : t('cheer.intro', { name: targetName || '' })}
        </p>

        {!status && !error && (
          <div className="py-6 flex justify-center">
            <Spinner />
          </div>
        )}

        {status && (
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-2xl bg-[#FFFBEA] px-3 py-2" data-cheer-remaining={status.dailyRemaining}>
              <div className="text-[11px] font-semibold text-stone-500">{t('cheer.title')}</div>
              <div className="text-sm font-extrabold text-stone-900 whitespace-nowrap">{t('cheer.todayLeft', { left: status.dailyRemaining, cap: status.dailyCap })}</div>
            </div>
            <div className="rounded-2xl bg-[#ECFDF5] px-3 py-2">
              <div className="text-[11px] font-semibold text-stone-500">{t('side.energy')}</div>
              <div className="text-sm font-extrabold text-stone-900">{formatEc(status.energyTickets, status.maxEnergyTickets || MAX_ENERGY_TICKETS)}</div>
            </div>
            {targetType !== 'energy' && (
              <div className="col-span-2 text-xs text-stone-500">{t('cheer.targetLeft', { left: Math.max(0, status.targetCap - status.targetUsed), cap: status.targetCap })}</div>
            )}
          </div>
        )}

        {phase.kind === 'menu' && status && (
          <div className="space-y-2">
            {status.dailyRemaining <= 0 ? (
              <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-600" data-cheer-capped>
                {t('cheer.dailyDone', { cap: status.dailyCap })}
              </div>
            ) : (
              status.options
                .filter((o) => o.available || o.reason !== 'disabled')
                .map((o) => (
                  <button
                    key={o.format}
                    onClick={() => pick(o)}
                    disabled={!o.available || busy}
                    data-cheer-option={o.format}
                    data-available={o.available ? '1' : '0'}
                    className={`w-full flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                      o.available ? 'border-stone-200 hover:border-[#FACC15] hover:bg-[#FFFBEA]' : 'border-stone-100 bg-stone-50 opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <span className="text-2xl" aria-hidden>
                      {FORMAT_ICON[o.format]}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-bold text-stone-900">{t(`cheer.format.${o.format}`, { s: o.durationSeconds })}</span>
                      <span className="block text-xs text-stone-500">{o.available ? t('cheer.secondsAd', { s: o.durationSeconds }) : reasonText(o)}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-[#FFE135] px-2.5 py-1 text-xs font-extrabold text-stone-900">{rewardLabel(o.ecBp)}</span>
                  </button>
                ))
            )}
            {cooldownLeft > 0 && status.dailyRemaining > 0 && <div className="text-xs text-stone-400 text-center">{t('cheer.cooldownNote', { s: cooldownLeft })}</div>}
          </div>
        )}

        {phase.kind === 'watching' && (
          <div className="space-y-3" data-cheer-watching>
            <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-[#FFF6C2] via-[#FFFBEA] to-[#E0F2FE] border border-stone-100 h-44 flex flex-col items-center justify-center text-center px-6">
              <span className="absolute top-2 left-3 text-[10px] font-bold uppercase tracking-wider text-stone-400">{t('side.sponsored')}</span>
              <span className="text-4xl">{FORMAT_ICON[phase.format]}</span>
              <div className="mt-2 font-bold text-stone-800">{t(`cheer.format.${phase.format}`, { s: phase.total })}</div>
              <div className="text-xs text-stone-500">{t('cheer.watching')}</div>
            </div>
            <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
              <div
                className="h-full bg-[#FACC15] transition-[width] duration-1000 ease-linear"
                style={{ width: `${Math.min(100, ((phase.total * 1000 - Math.max(0, phase.endsAt - now)) / (phase.total * 1000)) * 100)}%` }}
              />
            </div>
            <div className="text-center text-sm font-bold text-stone-700" data-cheer-countdown>
              {t('cheer.secondsLeft', { s: Math.max(0, Math.ceil((phase.endsAt - now) / 1000)) })}
            </div>
          </div>
        )}

        {phase.kind === 'claiming' && (
          <div className="py-6 flex flex-col items-center gap-2 text-sm text-stone-500">
            <Spinner /> {t('cheer.claiming')}
          </div>
        )}

        {phase.kind === 'done' && (
          <div className="rounded-2xl bg-[#FFFBEA] border border-[#FDE68A] px-4 py-4 text-center" data-cheer-done>
            <div className="text-3xl">💛</div>
            <div className="mt-1 font-extrabold text-stone-900">{t('cheer.thanks')}</div>
            <div className="text-sm text-stone-600">
              {phase.ticketsAwarded > 0 ? t('cheer.gotTickets', { n: phase.ticketsAwarded }) : t('cheer.gotProgress', { pct: Math.round(phase.addedPct * 10) / 10 })}
            </div>
            <div className="mt-3 flex justify-center gap-2">
              {status && status.dailyRemaining > 0 && (
                <button className={btn.soft} onClick={() => setPhase({ kind: 'menu' })}>
                  {t('cheer.again')}
                </button>
              )}
              <button className={btn.primary} onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </div>
        )}

        {error && <div className="rounded-2xl bg-rose-50 border border-rose-100 px-3 py-2 text-sm text-rose-600">{error}</div>}
        <p className="text-[11px] text-stone-400 text-center">{t('cheer.rules', { daily: status?.dailyCap ?? 15, target: status?.targetCap ?? 3, cd: status?.cooldownSeconds ?? 45 })}</p>
      </div>
    </Modal>
  );
}

/** Small pill button that opens the Cheer modal. */
export function CheerButton({
  targetType,
  targetId,
  targetName,
  count,
  onCheered,
  className = '',
  label,
  compactLabel = false,
}: {
  targetType: CheerTargetType;
  targetId?: string | null;
  targetName?: string | null;
  count?: number;
  onCheered?: (cheerCount: number | null) => void;
  className?: string;
  label?: string;
  /** Hide the text label on phones (icon + count only). */
  compactLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className={className} data-cheer-button={targetType}>
        <Icon name="cheer" size={18} /> <span className={compactLabel ? 'hidden sm:inline whitespace-nowrap' : 'whitespace-nowrap'}>{label || t('cheer.button')}</span>
        {count ? <span className="text-xs font-extrabold opacity-70">{count}</span> : null}
      </button>
      {open && <CheerModal open={open} onClose={() => setOpen(false)} targetType={targetType} targetId={targetId} targetName={targetName} onCheered={onCheered} />}
    </>
  );
}
