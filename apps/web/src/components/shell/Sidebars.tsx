'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { SocialAuthor } from '@mwar/shared';
import { Icon, type IconName } from '../ui/Icon';
import { Avatar } from '../ui/Avatar';
import { Card } from '../ui/Card';
import { useSession } from '../../lib/session';
import { getSuggestions } from '../../lib/api';
import { displayName, formatUsd } from '../../lib/format';

const SHORTCUTS: { href: string; label: string; icon: IconName; tint: string }[] = [
  { href: '/games', label: 'Games', icon: 'games', tint: 'bg-[#FFF6C2] text-[#8A6A00]' },
  { href: '/marketplace', label: 'Marketplace', icon: 'market', tint: 'bg-[#E0F2FE] text-sky-700' },
  { href: '/wallet', label: 'Wallet', icon: 'wallet', tint: 'bg-[#D1FAE5] text-emerald-700' },
  { href: '/network', label: '5-Tier Network', icon: 'network', tint: 'bg-[#EDE9FE] text-violet-700' },
  { href: '/friends', label: 'Friends', icon: 'users', tint: 'bg-[#FFE4E6] text-rose-600' },
  { href: '/chat', label: 'Chat', icon: 'chat', tint: 'bg-[#FDF2E3] text-amber-700' },
];

export function LeftSidebar() {
  const pathname = usePathname();
  const { boot } = useSession();
  const u = boot?.user;
  return (
    <div className="space-y-3">
      {/* Mini profile (hidden on the md icon rail) */}
      <Card className="p-3 hidden lg:block">
        <Link href="/profile" className="flex items-center gap-3 rounded-2xl p-1.5 hover:bg-stone-50">
          <Avatar src={u?.avatarUrl} name={u ? displayName(u) : '?'} size={44} />
          <span className="min-w-0">
            <span className="block font-extrabold text-stone-900 truncate">{u ? displayName(u) : '…'}</span>
            <span className="block text-xs text-stone-400 truncate">@{u?.username || ''}</span>
          </span>
        </Link>
        <div className="mt-2 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-2xl bg-[#FFFBEA] py-2">
            <div className="text-[11px] font-semibold text-stone-500">Energy</div>
            <div className="text-sm font-extrabold text-stone-900">
              {u?.energyTickets ?? '–'}/{u?.maxEnergyTickets ?? 6} EC
            </div>
          </div>
          <div className="rounded-2xl bg-[#ECFDF5] py-2">
            <div className="text-[11px] font-semibold text-stone-500">Balance</div>
            <div className="text-sm font-extrabold text-stone-900">{boot ? formatUsd(boot.walletSummary.balanceMicroUsd) : '–'}</div>
          </div>
        </div>
      </Card>

      <Card className="p-2">
        <nav className="space-y-0.5" aria-label="Shortcuts">
          {SHORTCUTS.map((s) => {
            const active = pathname === s.href || pathname.startsWith(`${s.href}/`);
            return (
              <Link
                key={s.href}
                href={s.href}
                title={s.label}
                className={`flex items-center gap-3 rounded-2xl p-2 transition lg:justify-start justify-center ${active ? 'bg-stone-100' : 'hover:bg-stone-50'}`}
              >
                <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${s.tint}`}>
                  <Icon name={s.icon} size={19} />
                </span>
                <span className="hidden lg:block text-sm font-semibold text-stone-800">{s.label}</span>
              </Link>
            );
          })}
        </nav>
      </Card>

      <Card className="p-2">
        <div className="hidden lg:block px-2 pt-1 pb-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-400">Your games</div>
        <Link href="/games/fps" title="MWAR Tactical FPS" className="flex items-center gap-3 rounded-2xl p-2 hover:bg-stone-50 lg:justify-start justify-center">
          <span className="w-9 h-9 rounded-xl bg-stone-900 text-[#FFE135] flex items-center justify-center shrink-0">
            <Icon name="target" size={19} />
          </span>
          <span className="hidden lg:block min-w-0">
            <span className="block text-sm font-semibold text-stone-800 truncate">MWAR Tactical FPS</span>
            <span className="block text-[11px] text-emerald-600 font-semibold">● Live rooms</span>
          </span>
        </Link>
      </Card>
    </div>
  );
}

// One fetch per app load (the sidebar lives in the persistent layout); refreshed by hand only
let suggestionsCache: { at: number; online: { username: string; userId: string | null; roomId: string }[]; newest: SocialAuthor[] } | null = null;

export function RightSidebar() {
  const { boot } = useSession();
  const [data, setData] = useState(suggestionsCache);
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    if (!force && suggestionsCache && Date.now() - suggestionsCache.at < 5 * 60_000) return;
    setLoading(true);
    try {
      const res = await getSuggestions();
      suggestionsCache = { at: Date.now(), ...res };
      setData(suggestionsCache);
    } catch {
      /* sidebar is optional */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (boot) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!boot]);

  const meId = boot?.user.id;
  const newest = (data?.newest || []).filter((p) => p.id !== meId).slice(0, 5);
  const online = (data?.online || []).filter((p) => p.userId !== meId).slice(0, 5);

  return (
    <div className="space-y-3">
      {/* EC & balance */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Energy & Balance</div>
          <Link href="/wallet" className="text-xs font-bold text-[#B08600] hover:underline">
            Wallet
          </Link>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <span className="w-10 h-10 rounded-2xl bg-[#FFE135] text-stone-900 flex items-center justify-center">
            <Icon name="bolt" size={20} filled />
          </span>
          <div className="flex-1">
            <div className="text-sm font-extrabold text-stone-900">
              {boot?.user.energyTickets ?? '–'} / {boot?.user.maxEnergyTickets ?? 6} EC
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-stone-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-[#FACC15]"
                style={{ width: `${Math.round(((boot?.user.energyTickets || 0) / (boot?.user.maxEnergyTickets || 6)) * 100)}%` }}
              />
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-[#ECFDF5] px-3 py-2">
            <div className="text-[11px] text-stone-500 font-semibold">Balance</div>
            <div className="text-sm font-extrabold text-stone-900">{boot ? formatUsd(boot.walletSummary.balanceMicroUsd) : '–'}</div>
          </div>
          <div className="rounded-2xl bg-[#FFF1F2] px-3 py-2">
            <div className="text-[11px] text-stone-500 font-semibold">Head bounty</div>
            <div className="text-sm font-extrabold text-stone-900">{boot ? formatUsd(boot.walletSummary.bountyMicroUsd) : '–'}</div>
          </div>
        </div>
      </Card>

      {/* Sponsored slot (reserved for future banner monetization: no ad requests yet) */}
      <Card className="p-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Sponsored</div>
        <div className="mt-2 rounded-2xl bg-gradient-to-br from-[#FFF6C2] via-[#FFFBEA] to-[#E0F2FE] border border-stone-100 h-[150px] flex flex-col items-center justify-center text-center px-4">
          <Icon name="megaphone" size={26} className="text-stone-500" />
          <div className="mt-1.5 text-sm font-bold text-stone-700">Your brand here</div>
          <div className="text-xs text-stone-500">300 × 150 ad slot</div>
        </div>
      </Card>

      {/* Online now + suggestions */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Players</div>
          <button onClick={() => load(true)} className="text-stone-400 hover:text-stone-700" aria-label="Refresh players" title="Refresh">
            <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {online.length > 0 && (
          <div className="mt-2 space-y-1">
            {online.map((p) => (
              <Link key={`${p.roomId}-${p.username}`} href={`/profile?u=${p.username}`} className="flex items-center gap-2.5 rounded-2xl p-1.5 hover:bg-stone-50">
                <span className="relative">
                  <Avatar name={p.username} size={32} />
                  <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#34D399] ring-2 ring-white" />
                </span>
                <span className="text-sm font-semibold text-stone-800 truncate flex-1">{p.username}</span>
                <span className="text-[10px] font-bold text-emerald-700 bg-[#D1FAE5] rounded-full px-2 py-0.5">{p.roomId}</span>
              </Link>
            ))}
          </div>
        )}
        <div className="mt-2 text-xs font-semibold text-stone-400">{online.length ? 'New players' : 'No one in rooms right now · new players'}</div>
        <div className="mt-1 space-y-1">
          {newest.map((p) => (
            <Link key={p.id} href={`/profile?u=${p.username}`} className="flex items-center gap-2.5 rounded-2xl p-1.5 hover:bg-stone-50">
              <Avatar src={p.avatarUrl} name={displayName(p)} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-stone-800 truncate">{displayName(p)}</span>
                <span className="block text-[11px] text-stone-400 truncate">@{p.username}</span>
              </span>
              <span className="text-[11px] font-bold text-[#B08600]">View</span>
            </Link>
          ))}
          {!data && !loading && <p className="text-xs text-stone-400 py-2">Suggestions will appear here.</p>}
        </div>
      </Card>
      <p className="px-2 text-[11px] text-stone-400">© 2026 mwar.win · Play fair, have fun</p>
    </div>
  );
}
