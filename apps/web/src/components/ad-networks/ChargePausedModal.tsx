'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import type { IdlePauseReason } from '../../hooks/useIdleChargeGuard';

/**
 * Lemon8-style "หยุดชาร์จพลังงานชั่วคราว" popup shown by useIdleChargeGuard. `contained` fills the nearest
 * positioned parent (e.g. a modal card); otherwise it covers the viewport (works inside a fullscreen
 * game container because it is rendered as its descendant).
 */
export function ChargePausedModal({ reason, onResume, contained = false }: { reason: IdlePauseReason; onResume: () => void; contained?: boolean }) {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The game may hold the pointer: release it so the button can be tapped / clicked
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock?.();
    btnRef.current?.focus({ preventScroll: true });
  }, []);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      className={`${contained ? 'absolute rounded-[inherit]' : 'fixed'} inset-0 z-[300] flex items-center justify-center p-5 bg-stone-900/45 backdrop-blur-[3px]`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="charge-paused-title"
      data-charge-paused={reason}
      onMouseDown={stop}
      onPointerDown={stop}
      onTouchStart={stop}
      onKeyDown={stop}
    >
      <div className="w-full max-w-[340px] rounded-[28px] bg-white text-center shadow-[0_18px_50px_rgba(0,0,0,0.22)] p-6 animate-[popIn_160ms_ease-out]">
        <div className="mx-auto w-16 h-16 rounded-full bg-[#FFF6C2] flex items-center justify-center text-3xl" aria-hidden>
          ⏸️
        </div>
        <h2 id="charge-paused-title" className="mt-4 text-lg font-extrabold text-stone-900">
          {t('idle.title')}
        </h2>
        <p className="mt-1.5 text-sm text-stone-500 leading-relaxed">{t(reason === 'hidden' ? 'idle.hiddenBody' : 'idle.body')}</p>
        <button
          ref={btnRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResume();
          }}
          className="mt-5 w-full rounded-full bg-[#FFE135] hover:bg-[#FACC15] active:scale-[0.98] transition text-stone-900 font-extrabold py-3.5 text-[15px] outline-none focus-visible:ring-4 focus-visible:ring-[#FACC15]/40 shadow-[0_6px_18px_rgba(250,204,21,0.45)]"
          data-charge-resume
        >
          ⚡ {t('idle.resume')}
        </button>
        <p className="mt-3 text-[11px] text-stone-400">{t('idle.note')}</p>
      </div>
    </div>
  );
}
