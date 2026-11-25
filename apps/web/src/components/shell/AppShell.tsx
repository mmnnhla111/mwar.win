'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { SessionProvider, useSession } from '../../lib/session';
import { getAuthToken } from '../../lib/api';
import { TopNav } from './TopNav';
import { LeftSidebar, RightSidebar } from './Sidebars';
import { BottomNav } from './BottomNav';
import { isAuthPath, isBarePath, isGamePath } from './nav';
import { BrandLogoFull, LemonLogo } from '../ui/Icon';
import { Spinner } from '../ui/Card';
import { FloatingQuestWidget } from '../FloatingQuestWidget';
import { DevMockPanel } from '../DevMockPanel';
import { I18nProvider, useTranslation } from '../../i18n/I18nProvider';

/** Pages whose main stage wants the full centre + right width (no right sidebar on lg). */
const WIDE_PATHS = ['/games/fps', '/admin', '/chat', '/marketplace', '/network', '/wallet'];

function Splash() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4 bg-[#FAF9F5]">
      <BrandLogoFull height={120} alt="" />
      <Spinner size={22} />
    </div>
  );
}

/** The 3D game keeps its own dark full-bleed stage: only a slim "back to Games" bar sits above it. */
function GameFrame({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="game-root min-h-[100dvh] bg-slate-950 text-slate-100">
      <div className="h-12 px-3 sm:px-4 flex items-center gap-3 border-b border-slate-800/80 bg-slate-950">
        <Link href="/games/fps" className="flex items-center gap-1.5 text-sm font-bold text-slate-200 hover:text-white">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {t('nav.rooms')}
        </Link>
        <span className="flex items-center gap-1.5 ml-auto">
          <LemonLogo size={24} />
          <span className="font-extrabold text-sm text-white">
            mwar<span className="text-[#FFE135]">.win</span>
          </span>
        </span>
      </div>
      <main className="p-3 sm:p-4">{children}</main>
    </div>
  );
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status } = useSession();
  // Already signed in: auth pages bounce to the feed
  useEffect(() => {
    if (status === 'ready' && getAuthToken()) router.replace('/');
  }, [status, router]);
  return <div className="min-h-[100dvh] bg-[#FAF9F5]">{children}</div>;
}

function MainFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, boot } = useSession();
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  useEffect(() => {
    setHasToken(!!getAuthToken());
  }, [pathname, status]);

  // Mandatory login gate
  useEffect(() => {
    if (hasToken === false || status === 'anon') {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get('ref');
      // Referral links (/?ref=…) land on the login page with the code pre-filled
      if (ref) router.replace(`/login?ref=${encodeURIComponent(ref)}`);
      else router.replace('/login');
    }
  }, [hasToken, status, router]);

  if (hasToken !== true || status === 'anon' || (status === 'loading' && !boot)) return <Splash />;

  const wide = WIDE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <div className="min-h-[100dvh] bg-[#FAF9F5] text-stone-900">
      <TopNav />
      <div
        className={`max-w-[1320px] mx-auto px-3 md:px-4 pt-3 md:pt-5 pb-28 md:pb-10 grid gap-4 lg:gap-5 ${
          wide
            ? 'md:grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[250px_minmax(0,1fr)]'
            : 'md:grid-cols-[64px_minmax(0,1fr)_250px] lg:grid-cols-[250px_minmax(0,1fr)_290px]'
        }`}
      >
        <aside className="hidden md:block">
          <div className="sticky top-[84px]">
            <LeftSidebar />
          </div>
        </aside>
        <main className="min-w-0">{children}</main>
        {!wide && (
          <aside className="hidden md:block">
            <div className="sticky top-[84px] max-h-[calc(100dvh-100px)] overflow-y-auto no-scrollbar">
              <RightSidebar />
            </div>
          </aside>
        )}
      </div>
      <BottomNav />
      <FloatingQuestWidget />
      <DevPanelGate role={boot?.user.role} />
    </div>
  );
}

/** The dev simulation panel is only for local dev and staff accounts. */
function DevPanelGate({ role }: { role?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const h = window.location.hostname;
    setShow(h === 'localhost' || h === '127.0.0.1' || role === 'admin' || role === 'auditor');
  }, [role]);
  if (!show) return null;
  return (
    <div className="hidden md:block">
      <DevMockPanel />
    </div>
  );
}

function ShellSwitch({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  if (isGamePath(pathname)) return <GameFrame>{children}</GameFrame>;
  if (isAuthPath(pathname)) return <AuthFrame>{children}</AuthFrame>;
  if (isBarePath(pathname)) return <div className="min-h-[100dvh] bg-[#FAF9F5]">{children}</div>;
  return <MainFrame>{children}</MainFrame>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <I18nProvider>
        <ShellSwitch>{children}</ShellSwitch>
      </I18nProvider>
    </SessionProvider>
  );
}
