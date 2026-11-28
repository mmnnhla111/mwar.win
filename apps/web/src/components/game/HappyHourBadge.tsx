'use client';

import React, { useEffect, useState } from 'react';
import type { LiveConfigResponse } from '@mwar/shared';
import { useTranslation } from '../../i18n/I18nProvider';
import { getLiveConfig } from '../../lib/liveEconomy';

/** "🔥 HAPPY HOUR 2X" badge (the Worker decides and pays the extra from the Boss Bounty Pool). */
export function HappyHourBadge({ active, endsAt, className = '' }: { active: boolean; endsAt?: number | null; className?: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active) return null;
  const mins = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 60_000)) : null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-orange-500 to-rose-500 text-white font-black px-2.5 py-1 text-[11px] shadow-lg shadow-orange-500/30 animate-pulse ${className}`}
      title={t('happy.tooltip')}
      data-happy-hour
    >
      🔥 {t('happy.badge')}
      {mins !== null && <span className="font-bold text-white/85">· {t('happy.minsLeft', { n: mins })}</span>}
    </span>
  );
}

/** Lobby helper: live config polled every 60 s while the page is open. */
export function useLiveConfig(): LiveConfigResponse | null {
  const [cfg, setCfg] = useState<LiveConfigResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getLiveConfig()
        .then((c) => alive && setCfg(c))
        .catch(() => {});
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return cfg;
}
