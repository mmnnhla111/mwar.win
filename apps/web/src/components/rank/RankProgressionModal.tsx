'use client';

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { RANK_TIERS, getRankStatus } from '@mwar/shared';
import type { PlayerRankStatus } from '@mwar/shared';
import { useTranslation } from '../../i18n/I18nProvider';
import { RankBadge } from '../ui/RankBadge';

const nf = (n: number) => Math.max(0, Math.floor(n || 0)).toLocaleString('en-US');

/**
 * Opened from the header rank chip. Shows the player's rank (big badge), total downlines over the 5 levels, the
 * progress bar to the next tier and the whole 12-tier ladder with the active tier highlighted. Rendered in a
 * portal: the sticky TopNav (backdrop blur) would otherwise trap a position:fixed dialog.
 */
export function RankProgressionModal({ rank, onClose }: { rank?: PlayerRankStatus | null; onClose: () => void }) {
  const { t } = useTranslation();
  const r = rank || getRankStatus(0);
  const curIdx = Math.max(0, RANK_TIERS.findIndex((x) => x.id === r.id));
  const pct = Math.round(Math.min(1, Math.max(0, r.progress)) * 100);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-black/45 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={t('rankx.title')} onClick={onClose} data-rank-modal>
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between bg-white/95 backdrop-blur px-5 pt-4 pb-2">
          <h2 className="font-extrabold text-stone-900">{t('rankx.title')}</h2>
          <button onClick={onClose} className="h-8 w-8 rounded-full bg-stone-100 text-stone-500 hover:text-stone-900 font-bold" aria-label={t('common.close')} data-rank-modal-close>
            ✕
          </button>
        </div>

        <div className="px-5 pb-5">
          {/* Current rank */}
          <div className="flex flex-col items-center text-center rounded-3xl bg-gradient-to-b from-[#FFF9D6] to-white border border-yellow-100 px-4 py-5">
            <RankBadge rankId={r.id} name={r.name} size={112} />
            <div className="mt-2 text-xl font-black text-stone-900" data-rank-current>{r.name}</div>
            <div className="text-sm text-stone-600 font-semibold" data-rank-downlines>
              {t('rankx.totalDownlines', { n: nf(r.totalDownlines) })}
            </div>
            <div className="mt-3 w-full max-w-xs">
              <div className="h-2.5 w-full rounded-full bg-stone-200 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className="h-full rounded-full bg-gradient-to-r from-[#FFE135] to-[#E5B800] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1.5 text-[12px] font-bold text-stone-600" data-rank-next>
                {r.nextRank ? t('rankx.nextHint', { n: nf(r.downlinesNeeded), rank: r.nextRank.name }) : t('rankx.maxed')}
              </div>
            </div>
          </div>

          <p className="mt-3 text-[11px] text-stone-500 leading-relaxed">{t('rankx.how')}</p>

          {/* Ladder */}
          <div className="mt-3 divide-y divide-stone-100 rounded-2xl border border-stone-200/80 overflow-hidden" data-rank-table>
            {RANK_TIERS.map((tier, i) => {
              const active = i === curIdx;
              const unlocked = i < curIdx;
              return (
                <div
                  key={tier.id}
                  className={`flex items-center gap-3 px-3 py-2 ${active ? 'bg-[#FFF6C2]' : unlocked ? 'bg-white' : 'bg-stone-50/70'}`}
                  data-rank-row={tier.id}
                  data-rank-active={active ? '1' : '0'}
                >
                  <span className={unlocked || active ? '' : 'opacity-45 grayscale'}>
                    <RankBadge rankId={tier.id} name={tier.name} size={40} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-extrabold ${active ? 'text-stone-900' : 'text-stone-700'}`}>{tier.name}</div>
                    <div className="text-[11px] text-stone-500">{t('rankx.required', { n: nf(tier.minDownlines) })}</div>
                  </div>
                  {active ? (
                    <span className="rounded-full bg-stone-900 text-[#FFE135] px-2.5 py-0.5 text-[10px] font-black">{t('rankx.you')}</span>
                  ) : unlocked ? (
                    <span className="text-emerald-600 text-sm font-black" aria-label={t('rankx.unlocked')}>✓</span>
                  ) : (
                    <span className="text-stone-300 text-sm" aria-label={t('rankx.locked')}>🔒</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
