'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { useTranslation } from '../../i18n/I18nProvider';
import { RankBadge } from '../ui/RankBadge';
import { openDailyQuests } from '../FloatingQuestWidget';
import { RankProgressionModal } from '../rank/RankProgressionModal';

const nf = (n: number) => Math.max(0, Math.floor(n || 0)).toLocaleString('en-US');

/**
 * Slim header strip under the TopNav: rank, ฿ game coins, ¢ cash balance, referral counts and today's
 * upline-share lock (4 of 5 daily missions). Tapping "Locked" opens the daily missions drawer.
 */
export function StatusBar() {
  const { boot } = useSession();
  const { t } = useTranslation();
  const [rankOpen, setRankOpen] = useState(false);
  if (!boot?.user) return null;
  const u = boot.user;
  const net = boot.network;
  const unlocked = !!net?.unlocked;
  const coins = u.coins ?? 0;
  const cents = boot.walletSummary?.balanceCents ?? Math.floor((boot.walletSummary?.balanceMicroUsd || 0) / 10_000);

  return (
    <div className="border-t border-stone-100" data-status-bar>
      <div className="max-w-[1320px] mx-auto px-3 md:px-4 h-10 flex items-center gap-1.5 md:gap-2 overflow-x-auto no-scrollbar text-[12px] font-bold whitespace-nowrap">
        <button
          type="button"
          onClick={() => setRankOpen(true)}
          className="flex items-center gap-1.5 rounded-full bg-stone-100 hover:bg-stone-200 pl-1 pr-2.5 h-7 shrink-0"
          title={t('rankx.chipTitle', { n: nf(u.rank?.totalDownlines ?? net?.totalReferrals ?? 0) })}
          aria-haspopup="dialog"
          data-rank-chip
        >
          <RankBadge rankId={u.rank?.id} name={u.rank?.name} totalDownlines={u.rank?.totalDownlines} size={22} />
          <span className="text-stone-800">{u.rank?.name || 'Bronze I'}</span>
        </button>

        <span className="flex items-center gap-1 rounded-full bg-[#FFF6C2] text-[#7A5B00] px-2.5 h-7 shrink-0" title={t('currency.coinsHint')} data-coins>
          <span className="font-black">฿</span>
          <span className="tabular-nums">{nf(coins)}</span>
        </span>

        <Link href="/wallet" className="flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-800 hover:bg-emerald-100 px-2.5 h-7 shrink-0" title={t('currency.centsHint')} data-cents>
          <span className="tabular-nums">{nf(cents)}</span>
          <span className="font-black">¢</span>
        </Link>

        <button
          type="button"
          onClick={() => openDailyQuests()}
          className={`flex items-center gap-1 rounded-full px-2.5 h-7 shrink-0 ring-1 transition ${
            unlocked
              ? 'bg-gradient-to-r from-emerald-500 to-[#E5B800] text-white ring-emerald-400/40 shadow-[0_2px_8px_rgba(16,185,129,0.25)]'
              : 'bg-rose-50 text-rose-600 ring-rose-200 hover:bg-rose-100'
          }`}
          title={t('mlm.lockHint')}
          data-mlm-lock={unlocked ? 'unlocked' : 'locked'}
        >
          {unlocked ? t('mlm.unlocked') : t('mlm.locked')}
          <span className={`tabular-nums font-semibold ${unlocked ? 'text-white/85' : 'text-rose-400'}`}>
            {net?.completedMissions ?? 0}/{net?.totalMissions || 5}
          </span>
        </button>

        <Link href="/network" className="flex items-center gap-1 rounded-full bg-stone-100 hover:bg-stone-200 text-stone-700 px-2.5 h-7 shrink-0" title={t('mlm.directCount', { n: nf(net?.directReferrals ?? 0) })} data-referrals>
          {t('mlm.totalDownline', { n: nf(net?.totalReferrals ?? 0) })}
          <span className="text-stone-400 font-semibold">· {t('mlm.directShort', { n: nf(net?.directReferrals ?? 0) })}</span>
        </Link>
      </div>
      {rankOpen && <RankProgressionModal rank={u.rank} onClose={() => setRankOpen(false)} />}
    </div>
  );
}
