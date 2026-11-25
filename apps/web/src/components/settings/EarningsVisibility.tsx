'use client';

import React, { useState } from 'react';
import { EARNINGS_VISIBILITY } from '@mwar/shared';
import type { EarningsDisplay, EarningsVisibility } from '@mwar/shared';
import { updateSocialSettings } from '../../lib/api';
import { useSession } from '../../lib/session';
import { memoDrop } from '../../lib/memo';
import { useTranslation } from '../../i18n/I18nProvider';

/** Text for a privacy-applied earnings value: "$17,018.00", "$**,***.**" or "Not specified". */
export function useEarningsText() {
  const { t } = useTranslation();
  return (e: EarningsDisplay | null | undefined) => (e && e.display !== null ? e.display : t('earnings.notSpecified'));
}

const ICON: Record<EarningsVisibility, string> = { public: '👀', masked: '✳️', hidden: '🙈' };

/** Public / Masked / Hidden picker for total earnings (saved via PATCH /api/social/settings). */
export function EarningsVisibilityPicker({ compact = false, onSaved }: { compact?: boolean; onSaved?: (v: EarningsVisibility) => void }) {
  const { t } = useTranslation();
  const { boot, refresh } = useSession();
  const current = boot?.user.earningsVisibility || 'public';
  const [busy, setBusy] = useState<EarningsVisibility | null>(null);
  const [error, setError] = useState('');

  const pick = async (v: EarningsVisibility) => {
    if (v === current || busy) return;
    setBusy(v);
    setError('');
    try {
      await updateSocialSettings({ earningsVisibility: v });
      memoDrop('profile:');
      // One bootstrap reload: the server applies the new mode to the sidebar value
      await refresh(true);
      onSaved?.(v);
    } catch (err: any) {
      setError(err?.message || t('settings.saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-earnings-visibility={current}>
      <div className={`grid grid-cols-3 gap-2 ${compact ? '' : 'mt-3'}`} role="radiogroup" aria-label={t('earnings.visibility')}>
        {EARNINGS_VISIBILITY.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={current === v}
            data-earnings-option={v}
            disabled={!!busy}
            onClick={() => pick(v)}
            className={`rounded-2xl border px-2 py-2.5 text-center transition ${
              current === v ? 'border-yellow-400 bg-[#FFFBEA] text-stone-900' : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50'
            }`}
          >
            <span className="block text-lg leading-none">{ICON[v]}</span>
            <span className="block mt-1 text-xs font-extrabold">{t(`earnings.mode.${v}`)}</span>
          </button>
        ))}
      </div>
      {!compact && <p className="text-xs text-stone-500 mt-2">{t(`earnings.modeHint.${current}`)}</p>}
      {error && <p className="text-xs font-semibold text-rose-500 mt-2">{error}</p>}
    </div>
  );
}
