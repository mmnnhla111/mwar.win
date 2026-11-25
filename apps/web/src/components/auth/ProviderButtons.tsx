'use client';

import React from 'react';

export function TelegramIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#fff" />
      <path
        fill="#24A1DE"
        d="M5.43 11.7c3.6-1.57 6-2.6 7.2-3.1 3.43-1.43 4.14-1.68 4.6-1.69.1 0 .33.02.48.14.12.1.16.24.17.34.02.1.04.32.02.5-.18 1.96-.99 6.71-1.4 8.9-.17.93-.52 1.24-.85 1.27-.72.07-1.27-.48-1.97-.93-1.09-.72-1.7-1.16-2.76-1.86-1.22-.8-.43-1.25.27-1.97.18-.19 3.35-3.07 3.41-3.33 0-.03.01-.15-.06-.21-.07-.06-.18-.04-.25-.02-.11.02-1.85 1.17-5.22 3.45-.5.34-.94.5-1.35.5-.44-.01-1.3-.25-1.93-.46-.78-.25-1.4-.39-1.34-.82.03-.22.34-.45.93-.68z"
      />
    </svg>
  );
}

export function LineIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#fff" />
      <path
        fill="#06C755"
        d="M12 4.5c-4.69 0-8.5 3.08-8.5 6.88 0 3.4 3.02 6.25 7.1 6.79.28.06.65.18.75.42.08.21.05.55.03.77l-.12.72c-.04.21-.17.84.74.46.9-.38 4.89-2.88 6.67-4.93 1.23-1.35 1.83-2.72 1.83-4.23 0-3.8-3.81-6.88-8.5-6.88zM8.3 13.4H6.6a.45.45 0 0 1-.45-.45V9.57a.45.45 0 0 1 .9 0v2.93H8.3a.45.45 0 0 1 0 .9zm1.75-.45a.45.45 0 0 1-.9 0V9.57a.45.45 0 0 1 .9 0v3.38zm4.06 0a.45.45 0 0 1-.81.27l-1.73-2.36v2.09a.45.45 0 0 1-.9 0V9.57a.45.45 0 0 1 .81-.27l1.73 2.36V9.57a.45.45 0 0 1 .9 0v3.38zm2.73-2.14a.45.45 0 0 1 0 .9h-1.25v.8h1.25a.45.45 0 0 1 0 .9h-1.7a.45.45 0 0 1-.45-.45V9.57c0-.25.2-.45.45-.45h1.7a.45.45 0 0 1 0 .9h-1.25v.8h1.25z"
      />
    </svg>
  );
}

/** Big 1-click provider button (Telegram blue / LINE green). */
export function ProviderButton({
  provider,
  label,
  onClick,
  disabled,
  busy,
  note,
}: {
  provider: 'telegram' | 'line';
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  note?: string | null;
}) {
  const tg = provider === 'telegram';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      data-provider={provider}
      className={`w-full rounded-2xl px-4 py-3.5 flex items-center gap-3 text-white font-extrabold text-[15px] shadow-sm transition active:scale-[0.99] disabled:opacity-55 disabled:cursor-not-allowed ${
        tg ? 'bg-[#24A1DE] hover:bg-[#1f93cc]' : 'bg-[#06C755] hover:bg-[#05b34c]'
      }`}
    >
      <span className="shrink-0">{tg ? <TelegramIcon size={26} /> : <LineIcon size={26} />}</span>
      <span className="flex-1 text-left min-w-0">
        <span className="block truncate">{label}</span>
        {note && <span className="block text-[11px] font-semibold opacity-90 truncate">{note}</span>}
      </span>
      {busy && <span className="w-4 h-4 rounded-full border-2 border-white/60 border-t-transparent animate-spin shrink-0" />}
    </button>
  );
}
