import type { IconName } from '../ui/Icon';

export interface NavTab {
  href: string;
  label: string;
  short: string;
  /** i18n keys for label / short */
  labelKey: string;
  shortKey: string;
  icon: IconName;
  /** Other paths that light up this tab. */
  match: string[];
}

export const MAIN_TABS: NavTab[] = [
  { href: '/', label: 'Home', short: 'Home', labelKey: 'nav.home', shortKey: 'nav.home', icon: 'home', match: ['/'] },
  { href: '/games', label: 'Games', short: 'Games', labelKey: 'nav.games', shortKey: 'nav.games', icon: 'games', match: ['/games'] },
  { href: '/marketplace', label: 'Marketplace', short: 'Market', labelKey: 'nav.marketplace', shortKey: 'nav.market', icon: 'market', match: ['/marketplace'] },
  { href: '/wallet', label: 'Wallet & Network', short: 'Wallet', labelKey: 'nav.walletNetwork', shortKey: 'nav.wallet', icon: 'wallet', match: ['/wallet', '/network'] },
  { href: '/profile', label: 'Profile', short: 'Profile', labelKey: 'nav.profile', shortKey: 'nav.profile', icon: 'user', match: ['/profile', '/friends'] },
];

export function isTabActive(tab: NavTab, pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  return tab.match.some((m) => (m === '/' ? p === '/' : p === m || p.startsWith(`${m}/`)));
}

export const AUTH_PATHS = ['/login', '/register'];

/** Pages with no app chrome that work signed in or out (OAuth callbacks, first-run setup). */
export function isBarePath(pathname: string) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p === '/welcome' || p.startsWith('/auth/');
}

export function isAuthPath(pathname: string) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return AUTH_PATHS.includes(p);
}

export function isGamePath(pathname: string) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p === '/game' || p.startsWith('/game/');
}
