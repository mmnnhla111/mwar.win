'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, type IconName } from '../ui/Icon';
import { Avatar } from '../ui/Avatar';
import { useSession } from '../../lib/session';
import { displayName } from '../../lib/format';
import { LanguageMenu } from '../i18n/LanguagePicker';
import { useTranslation } from '../../i18n/I18nProvider';

/** < 768 px: ☰ slide-in menu (left of the logo) with everything that has no bottom tab. */
export function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { boot, signOut } = useSession();
  const { t } = useTranslation();
  const user = boot?.user;
  // Portal to <body>: the sticky header's backdrop-blur would otherwise trap position:fixed inside it
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const items: { href: string; icon: IconName; label: string; badge?: number }[] = [
    { href: '/settings', icon: 'edit', label: t('nav.settings') },
    { href: '/network', icon: 'network', label: t('drawer.network') },
    { href: '/friends', icon: 'users', label: t('drawer.friends') },
    { href: '/chat', icon: 'chat', label: t('nav.chat'), badge: boot?.unreadChatCount || 0 },
    { href: '/notifications', icon: 'bell', label: t('nav.notifications'), badge: boot?.unreadNotifCount || 0 },
  ];
  const isStaff = !!user && (user.staffRole || 'user') !== 'user';

  if (!mounted) return null;
  return createPortal(
    <div className={`md:hidden fixed inset-0 z-[60] ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open} data-drawer={open ? 'open' : 'closed'}>
      <div className={`absolute inset-0 bg-stone-900/35 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`} onClick={onClose} />
      <aside
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label={t('drawer.title')}
        className={`absolute inset-y-0 left-0 w-[82%] max-w-[320px] bg-white shadow-2xl flex flex-col transition-transform duration-200 ease-out ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="p-4 pt-[max(1rem,env(safe-area-inset-top))] border-b border-stone-100 flex items-center gap-3">
          {user && <Avatar src={user.avatarUrl} name={displayName(user)} size={44} />}
          <div className="min-w-0 flex-1">
            <div className="font-extrabold text-stone-900 truncate">{user ? displayName(user) : 'mwar.win'}</div>
            {user && <div className="text-xs text-stone-400 truncate">@{user.username}</div>}
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-stone-100 flex items-center justify-center" aria-label={t('common.close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {items.map((it) => {
            const active = pathname === it.href || pathname.startsWith(`${it.href}/`);
            return (
              <Link
                key={it.href}
                href={it.href}
                onClick={onClose}
                className={`flex items-center gap-3 px-3 py-3 rounded-2xl text-[15px] font-semibold ${active ? 'bg-[#FFF6C2] text-stone-900' : 'text-stone-700 hover:bg-stone-50'}`}
              >
                <Icon name={it.icon} size={20} />
                <span className="flex-1">{it.label}</span>
                {!!it.badge && <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[#FF6B6B] text-white text-[11px] font-extrabold flex items-center justify-center">{it.badge > 99 ? '99+' : it.badge}</span>}
              </Link>
            );
          })}
          <LanguageMenu />
          {isStaff && (
            <Link href="/admin" onClick={onClose} className="flex items-center gap-3 px-3 py-3 rounded-2xl text-[15px] font-semibold text-stone-700 hover:bg-stone-50" data-drawer-admin>
              <Icon name="shield" size={20} /> {t('nav.admin')}
            </Link>
          )}
        </nav>
        <div className="p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] border-t border-stone-100">
          <button
            onClick={() => {
              onClose();
              signOut();
              router.replace('/login');
            }}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-[15px] font-semibold text-rose-500 hover:bg-rose-50"
          >
            <Icon name="logout" size={20} /> {t('nav.logout')}
          </button>
        </div>
      </aside>
    </div>,
    document.body
  );
}
