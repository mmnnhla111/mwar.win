'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatMicroUsd, formatCoins } from '@mwar/shared';
import { UsdDollarIcon, GoldCoinIcon } from '../../components/icons';
import { useTranslation } from '../../i18n/I18nProvider';

export default function WalletPage() {
  const { t, tx, lang } = useTranslation();
  const [wallet, setWallet] = useState<any>(null);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [amountUsd, setAmountUsd] = useState('10.00');
  const [crypto, setCrypto] = useState('USDT (TRC-20)');
  const [payoutAddress, setPayoutAddress] = useState('0x71C...DemoTRC20AddressForDev');
  const [statusMsg, setStatusMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadWallet = async () => {
    setLoading(true);
    try {
      const [walletRes, withdrawRes] = await Promise.all([
        apiFetch('/api/wallet'),
        apiFetch('/api/wallet/withdrawals'),
      ]);
      setWallet(walletRes);
      setWithdrawals(withdrawRes.requests || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWallet();
  }, []);

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg('');
    setIsSubmitting(true);
    try {
      const amountMicroUsd = Math.round(parseFloat(amountUsd) * 1_000_000);
      const res = await apiFetch('/api/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          amount_micro_usd: amountMicroUsd,
          crypto_currency: crypto.split(' ')[0],
          payout_address: payoutAddress,
        }),
      });
      setStatusMsg(t('wallet.requested', { id: res.withdrawalId.slice(0, 8) }));
      await loadWallet();
    } catch (err: any) {
      setStatusMsg(t('wallet.error', { error: err.message }));
    } finally {
      setIsSubmitting(false);
    }
  };

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

      {/* 3. Cashout Request Form */}
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-4">
        <div className="flex justify-between items-center border-b border-stone-200/80 pb-3">
          <div>
            <h3 className="text-sm sm:text-base font-extrabold text-stone-900">{t('wallet.formTitle')}</h3>
            <p className="text-[11px] text-stone-500">{t('wallet.formHint')}</p>
          </div>
          <span className="bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
            {t('wallet.min')}
          </span>
        </div>

        <form onSubmit={handleWithdrawSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-stone-600 block mb-1">{t('wallet.amount')}</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-stone-500 font-bold">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="10"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                  required
                  className="w-full bg-stone-50 border border-stone-200/80 rounded-xl pl-7 pr-3 py-2 text-xs text-stone-900 font-bold font-mono focus:border-yellow-400 focus:outline-none"
                />
              </div>
              <p className="text-[10px] text-stone-500 mt-1">
                {t('wallet.cost', { coins: (parseFloat(amountUsd || '0') * 10000).toLocaleString() })}
              </p>
            </div>

            <div>
              <label className="text-xs font-bold text-stone-600 block mb-1">{t('wallet.network')}</label>
              <select
                value={crypto}
                onChange={(e) => setCrypto(e.target.value)}
                className="w-full bg-stone-50 border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 font-bold focus:border-yellow-400 focus:outline-none"
              >
                <option value="USDT (TRC-20)">USDT (TRC-20 / Tron)</option>
                <option value="TON (The Open Network)">TON (The Open Network)</option>
                <option value="BTC (Bitcoin)">BTC (Bitcoin)</option>
                <option value="SOL (Solana)">SOL (Solana)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-stone-600 block mb-1">{t('wallet.address')}</label>
            <input
              type="text"
              value={payoutAddress}
              onChange={(e) => setPayoutAddress(e.target.value)}
              required
              className="w-full bg-stone-50 border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 font-mono focus:border-yellow-400 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-stone-900 font-extrabold py-3 rounded-2xl text-xs transition shadow-[0_2px_12px_rgba(0,0,0,0.04)] active:scale-95 disabled:opacity-50"
          >
            {isSubmitting ? t('wallet.submitting') : t('wallet.submit')}
          </button>
        </form>
      </div>

      {/* 4. Cashout History Table */}
      <div className="bg-white border border-stone-200/80 rounded-3xl overflow-hidden shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <div className="p-4 sm:p-5 border-b border-stone-200/80 flex justify-between items-center">
          <span className="text-sm font-extrabold text-stone-900">{t('wallet.recent', { n: withdrawals.length })}</span>
          <span className="text-xs text-stone-500 font-semibold">{t('wallet.auditLog')}</span>
        </div>

        {withdrawals.length === 0 ? (
          <div className="p-12 text-center text-xs text-stone-500">
            {t('wallet.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-50 text-stone-500 font-bold border-b border-stone-200/80 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="p-3.5">{t('wallet.col.id')}</th>
                  <th className="p-3.5">{t('wallet.col.amount')}</th>
                  <th className="p-3.5">{t('wallet.col.network')}</th>
                  <th className="p-3.5">{t('fps.col.status')}</th>
                  <th className="p-3.5 text-right">{t('wallet.col.date')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-stone-700">
                {withdrawals.map((w) => (
                  <tr key={w.id} className="hover:bg-stone-50 transition">
                    <td className="p-3.5 font-mono text-stone-600 font-bold">
                      {w.id.slice(0, 8)}...
                    </td>
                    <td className="p-3.5 text-emerald-600 font-extrabold font-mono">
                      {formatMicroUsd(w.amount_micro_usd)}
                    </td>
                    <td className="p-3.5 text-stone-600 font-bold">
                      {w.crypto_currency}
                    </td>
                    <td className="p-3.5">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${
                          w.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                            : w.status === 'rejected'
                            ? 'bg-rose-50 text-rose-500 border border-rose-200'
                            : 'bg-amber-50 text-amber-700 border border-amber-200'
                        }`}
                      >
                        {tx(`wallet.status.${w.status}`, w.status)}
                      </span>
                    </td>
                    <td className="p-3.5 text-right text-stone-500 font-mono text-[11px]">
                      {new Date(w.created_at * 1000).toLocaleDateString(lang)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
