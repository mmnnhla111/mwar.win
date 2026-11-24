export function timeAgo(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
