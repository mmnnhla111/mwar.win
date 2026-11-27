'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, LemonLogo } from '../ui/Icon';
import { Avatar } from '../ui/Avatar';
import { useSession } from '../../lib/session';
import { MAIN_TABS, isTabActive } from './nav';
import { SearchBox } from './SearchBox';
import { NotificationsPanel } from './NotificationsPanel';
import { MobileDrawer } from './MobileDrawer';
import { displayName } from '../../lib/format';
import { LanguageMenu } from '../i18n/LanguagePicker';
import { useTranslation } from '../../i18n/I18nProvider';
import { StatusBar } from './StatusBar';
import { RankBadge } from '../ui/RankBadge';

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#FF6B6B] text-white text-[10px] font-extrabold flex items-center justify-center ring-2 ring-white">
      {n > 99 ? '99+' : n}
    </span>
  );
}

function IconButton({ children, label, onClick, href, active }: { children: React.ReactNode; label: string; onClick?: () => void; href?: string; active?: boolean }) {
  const cls = `relative w-10 h-10 rounded-full flex items-center justify-center transition ${active ? 'bg-[#FFF6C2] text-stone-900' : 'bg-stone-100 hover:bg-stone-200 text-stone-700'}`;
  if (href) {
    return (
      <Link href={href} aria-label={label} title={label} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { boot, signOut } = useSession();
  const { t: tr } = useTranslation();
  const [notifOpen, setNotifOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = React.useCallback(() => setDrawerOpen(false), []);
  const menuRef = useRef<HTMLDivElement>(null);
  const user = boot?.user;

  useEffect(() => {
    setNotifOpen(false);
    setMenuOpen(false);
    setMobileSearch(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const handleLogout = () => {
    signOut();
    router.replace('/login');
  };

  return (
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-stone-200/80">
      <div className="max-w-[1320px] mx-auto h-14 md:h-16 px-3 md:px-4 flex items-center gap-3">
        {/* Left: logo + search */}
        <div className="flex items-center gap-2 md:gap-2.5 md:w-[300px] shrink-0 min-w-0">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="md:hidden w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-stone-700 hover:bg-stone-100"
            aria-label={tr('drawer.title')}
            aria-expanded={drawerOpen}
            data-drawer-toggle
          >
            <Icon name="menu" size={22} />
          </button>
          <Link href="/" className="flex items-center gap-2 shrink-0" aria-label={tr('nav.homeAria')}>
            <LemonLogo size={34} />
            <span className="font-extrabold text-[17px] tracking-tight text-stone-900">
              mwar<span className="text-[#E5B800]">.win</span>
            </span>
          </Link>
          <div className="hidden lg:block flex-1 min-w-0">
            <SearchBox />
          </div>
        </div>

        {/* Center: 5 tabs (md+) */}
        <nav className="hidden md:flex flex-1 items-stretch justify-center h-full" aria-label={tr('nav.main')}>
          {MAIN_TABS.map((t) => {
            const active = isTabActive(t, pathname);
            return (
              <Link
                key={t.href}
                href={t.href}
                title={tr(t.labelKey)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center justify-center px-4 lg:px-6 mx-0.5 my-1.5 rounded-2xl transition ${active ? 'text-stone-900' : 'text-stone-400 hover:text-stone-700 hover:bg-stone-100'}`}
              >
                <Icon name={t.icon} size={24} strokeWidth={active ? 2.2 : 1.9} />
                <span className="sr-only">{tr(t.labelKey)}</span>
                {active && <span className="absolute -bottom-1.5 left-2 right-2 h-[3px] rounded-full bg-[#FACC15]" />}
              </Link>
            );
          })}
        </nav>

        {/* Right */}
        <div className="flex items-center gap-2 ml-auto md:ml-0 md:w-[300px] justify-end">
          <span className="lg:hidden">
            <IconButton label={tr('nav.search')} onClick={() => setMobileSearch((v) => !v)} active={mobileSearch}>
              <Icon name="search" size={20} />
            </IconButton>
          </span>
          <IconButton label={tr('nav.chat')} href="/chat" active={pathname.startsWith('/chat')}>
            <Icon name="chat" size={20} />
            <Badge n={boot?.unreadChatCount || 0} />
          </IconButton>
          <div className="relative" data-notif-bell>
            <IconButton label={tr('nav.notifications')} onClick={() => setNotifOpen((v) => !v)} active={notifOpen}>
              <Icon name="bell" size={20} />
              <Badge n={boot?.unreadNotifCount || 0} />
            </IconButton>
            {notifOpen && <NotificationsPanel onClose={() => setNotifOpen(false)} />}
          </div>

          {user && (
            <div className="relative hidden md:block" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-full bg-stone-100 hover:bg-stone-200 pl-1 pr-3 py-1 transition max-w-[200px]"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Avatar src={user.avatarUrl} name={displayName(user)} size={30} />
                <span className="text-sm font-bold text-stone-800 truncate">{displayName(user)}</span>
                <RankBadge rankId={user.rank?.id} name={user.rank?.name} size={20} />
              </button>
              {menuOpen && (
                <div role="menu" className="absolute right-0 mt-2 w-64 bg-white rounded-2xl border border-stone-200/80 shadow-[0_12px_40px_rgba(0,0,0,0.10)] p-1.5 animate-[popIn_160ms_ease-out]">
                  <Link href="/profile" className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-800">
                    <Icon name="user" size={18} /> {tr('nav.myProfile')}
                  </Link>
                  <Link href="/settings" className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-800">
                    <Icon name="edit" size={18} /> {tr('nav.settings')}
                  </Link>
                  {(user.staffRole || 'user') !== 'user' && (
                    <Link href="/admin" className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-800">
                      <Icon name="shield" size={18} /> {tr('nav.admin')}
                    </Link>
                  )}
                  <LanguageMenu />
                  <button onClick={handleLogout} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-rose-50 text-sm font-semibold text-rose-500">
                    <Icon name="logout" size={18} /> {tr('nav.logout')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <MobileDrawer open={drawerOpen} onClose={closeDrawer} />
      {mobileSearch && (
        <div className="lg:hidden px-3 pb-3">
          <SearchBox autoFocus />
        </div>
      )}
    </header>
  );
}
