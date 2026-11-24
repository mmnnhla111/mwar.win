'use client';

import React from 'react';
import { useTranslation } from '../../i18n/I18nProvider';

export function Card({ className = '', children, as: Tag = 'div' }: { className?: string; children: React.ReactNode; as?: any }) {
  return <Tag className={`bg-white rounded-3xl border border-stone-200/80 shadow-[0_2px_12px_rgba(0,0,0,0.04)] ${className}`}>{children}</Tag>;
}

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      style={{ width: size, height: size }}
      className={`inline-block rounded-full border-2 border-stone-200 border-t-yellow-400 animate-spin ${className}`}
      aria-label={t('common.loading')}
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  const { t } = useTranslation();
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-stone-900/30 backdrop-blur-[2px] animate-[fadeIn_160ms_ease-out]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div className={`w-full ${maxWidth} max-h-[88dvh] overflow-y-auto bg-white rounded-3xl shadow-[0_12px_48px_rgba(0,0,0,0.12)] border border-stone-200/80 animate-[popIn_200ms_cubic-bezier(.2,.9,.3,1.2)]`}>
        {title !== undefined && (
          <div className="sticky top-0 z-10 bg-white/95 backdrop-blur flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-stone-100">
            <div className="font-extrabold text-stone-900 text-base">{title}</div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full bg-stone-100 hover:bg-stone-200 text-stone-600 flex items-center justify-center transition"
              aria-label={t('common.close')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export const btn = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-full bg-[#FFE135] hover:bg-[#FACC15] text-[#1C1917] font-bold px-5 py-2.5 text-sm transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none',
  soft: 'inline-flex items-center justify-center gap-2 rounded-full bg-stone-100 hover:bg-stone-200 text-stone-800 font-semibold px-4 py-2 text-sm transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none',
  ghost: 'inline-flex items-center justify-center gap-2 rounded-full hover:bg-stone-100 text-stone-700 font-semibold px-3 py-2 text-sm transition',
  dark: 'inline-flex items-center justify-center gap-2 rounded-full bg-stone-900 hover:bg-stone-800 text-white font-bold px-5 py-2.5 text-sm transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none',
};

export const inputCls =
  'w-full rounded-2xl border border-stone-200 bg-stone-50/60 px-4 py-3 text-sm text-stone-900 placeholder:text-stone-400 outline-none focus:border-yellow-400 focus:bg-white focus:ring-4 focus:ring-yellow-200/50 transition';
