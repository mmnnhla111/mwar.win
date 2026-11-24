import type { IconName } from '../ui/Icon';

export interface NavTab {
  href: string;
  label: string;
  short: string;
  icon: IconName;
  /** Other paths that light up this tab. */
  match: string[];
}

export const MAIN_TABS: NavTab[] = [
  { href: '/', label: 'Home', short: 'Home', icon: 'home', match: ['/'] },
  { href: '/games', label: 'Games', short: 'Games', icon: 'games', match: ['/games'] },
  { href: '/marketplace', label: 'Marketplace', short: 'Market', icon: 'market', match: ['/marketplace'] },
  { href: '/wallet', label: 'Wallet & Network', short: 'Wallet', icon: 'wallet', match: ['/wallet', '/network'] },
  { href: '/profile', label: 'Profile', short: 'Profile', icon: 'user', match: ['/profile', '/friends'] },
];

export function isTabActive(tab: NavTab, pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  return tab.match.some((m) => (m === '/' ? p === '/' : p === m || p.startsWith(`${m}/`)));
}

export const AUTH_PATHS = ['/login', '/register', '/forgot-password'];

export function isAuthPath(pathname: string) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return AUTH_PATHS.includes(p);
}

export function isGamePath(pathname: string) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p === '/game' || p.startsWith('/game/');
}
