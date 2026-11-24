'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../ui/Icon';
import { MAIN_TABS, isTabActive } from './nav';

/** Mobile (< 768 px) fixed bottom bar: Home · Games (lemon pill) · Market · Wallet · Profile. */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-md border-t border-stone-200/80 pb-[env(safe-area-inset-bottom)]"
      aria-label="Main"
    >
      <div className="h-[64px] grid grid-cols-5 items-center px-1">
        {MAIN_TABS.map((t) => {
          const active = isTabActive(t, pathname);
          if (t.href === '/games') {
            return (
              <Link key={t.href} href={t.href} className="flex flex-col items-center justify-center" aria-current={active ? 'page' : undefined}>
                <span
                  className={`flex items-center justify-center w-14 h-9 rounded-full transition ${active ? 'bg-[#FACC15] text-stone-900 shadow-[0_4px_14px_rgba(250,204,21,0.45)]' : 'bg-[#FFE135] text-stone-900'}`}
                >
                  <Icon name="games" size={22} strokeWidth={2.1} />
                </span>
                <span className="text-[10px] font-bold mt-0.5 text-stone-800">{t.short}</span>
              </Link>
            );
          }
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center justify-center h-full ${active ? 'text-stone-900' : 'text-stone-400'}`}
            >
              <Icon name={t.icon} size={23} strokeWidth={active ? 2.3 : 1.9} />
              <span className={`text-[10px] mt-0.5 ${active ? 'font-extrabold' : 'font-semibold'}`}>{t.short}</span>
              <span className={`mt-0.5 w-1 h-1 rounded-full ${active ? 'bg-[#FACC15]' : 'bg-transparent'}`} />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
