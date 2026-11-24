type T = (key: string, params?: Record<string, string | number>) => string;

/** Short relative time. Pass the i18n `t` + language to localise ("5m", "5 นาที", "5 phút"). */
export function timeAgo(unixSeconds: number, t?: T, lang?: string): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 45) return t ? t('time.justNow') : 'just now';
  if (s < 3600) return t ? t('time.minutes', { n: Math.round(s / 60) }) : `${Math.round(s / 60)}m`;
  if (s < 86_400) return t ? t('time.hours', { n: Math.round(s / 3600) }) : `${Math.round(s / 3600)}h`;
  if (s < 7 * 86_400) return t ? t('time.days', { n: Math.round(s / 86_400) }) : `${Math.round(s / 86_400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString(lang || undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n || 0);
}

export function formatUsd(microUsd: number): string {
  return `$${((microUsd || 0) / 1_000_000).toFixed(2)}`;
}

export function displayName(a: { displayName?: string | null; username: string }): string {
  return a.displayName?.trim() || a.username;
}
