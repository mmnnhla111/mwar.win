'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { UsdDollarIcon, GoldCoinIcon } from '../../components/icons';
import { useTranslation } from '../../i18n/I18nProvider';
import { PromoRedeemCard } from '../../components/wallet/PromoRedeemCard';
import { CashoutCard } from '../../components/wallet/CashoutCard';

export default function WalletPage() {
  const { t } = useTranslation();
  const [wallet, setWallet] = useState<any>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const loadWallet = async () => {
    setLoading(true);
    try {
      setWallet(await apiFetch('/api/wallet'));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWallet();
  }, []);

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Header */}
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
            <UsdDollarIcon size={28} />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-stone-900 tracking-tight flex items-center space-x-2">
              <span>{t('wallet.title')}</span>
              <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
                {t('wallet.engineBadge')}
              </span>
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">
              {t('wallet.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs font-bold text-stone-500 bg-stone-50 px-3.5 py-1.5 rounded-2xl border border-stone-200/80">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>{t('wallet.nowpayments')}</span>
        </div>
      </div>

      {statusMsg && (
        <div className="bg-white border border-amber-200 text-amber-700 text-xs p-3.5 rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          {statusMsg}
        </div>
      )}

      {/* 2. Tactical Financial Gauges */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Available Balance */}
        <div className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-2 relative overflow-hidden">
          <div className="flex justify-between items-center">
            <span className="text-xs font-extrabold text-stone-500 uppercase tracking-wider">{t('wallet.available')}</span>
            <UsdDollarIcon size={20} />
          </div>
          <div className="text-3xl font-extrabold text-emerald-600 font-mono">
            {wallet?.formattedBalance || '$0.00'}
          </div>
          <div className="text-xs font-mono font-bold text-amber-700 flex items-center space-x-1">
            <GoldCoinIcon size={16} />
            <span>{wallet?.formattedCoins || t('wallet.zeroCoins')}</span>
          </div>
        </div>

        {/* Total Earned */}
        <div className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs font-extrabold text-stone-500 uppercase tracking-wider">{t('wallet.lifetime')}</span>
            <span className="text-xs text-amber-700 font-bold">{t('wallet.killsMlm')}</span>
          </div>
          <div className="text-3xl font-extrabold text-amber-700 font-mono">
            {wallet?.formattedTotalEarned || '$0.00'}
          </div>
          <p className="text-[10px] text-stone-500 font-semibold">{t('wallet.lifetimeHint')}</p>
        </div>

        {/* Total Withdrawn */}
        <div className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs font-extrabold text-stone-500 uppercase tracking-wider">{t('wallet.cashouts')}</span>
            <span className="text-xs text-sky-600 font-bold">{t('wallet.processed')}</span>
          </div>
          <div className="text-3xl font-extrabold text-sky-600 font-mono">
            {wallet?.formattedTotalWithdrawn || '$0.00'}
          </div>
          <p className="text-[10px] text-stone-500 font-semibold">{t('wallet.cashoutsHint')}</p>
        </div>
      </div>

      {/* V1.2 C launch promo code → 1 EC ticket backed by the marketing pool */}
      <PromoRedeemCard />

      {/* 3. Cashout ($10 minimum, 3-layer anti-cheat audit) + history */}
      {wallet && <CashoutCard balanceMicroUsd={Number(wallet.balanceMicroUsd || 0)} onChanged={loadWallet} />}
    </div>
  );
}
