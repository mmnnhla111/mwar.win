'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatMicroUsd, formatCoins } from '@mwar/shared';
import { UsdDollarIcon, GoldCoinIcon } from '../../components/icons';

export default function WalletPage() {
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
      setStatusMsg(`Withdrawal requested! ID: ${res.withdrawalId.slice(0, 8)}. Submitted to AI Fraud Audit.`);
      await loadWallet();
    } catch (err: any) {
      setStatusMsg(`Withdrawal Error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Header */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
            <UsdDollarIcon size={28} />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight flex items-center space-x-2">
              <span>WALLET & CASHOUT VAULT</span>
              <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-black px-2 py-0.5 rounded-full">
                MICRO-USD INTEGER ENGINE
              </span>
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Precision accounting ($1.00 = 1,000,000 Micro-USD, $0.01 = 100 Coins). Minimum cashout $10.00 USD.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs font-bold text-slate-400 bg-slate-950/80 px-3.5 py-1.5 rounded-2xl border border-slate-800">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>NOWPayments Real-Time API</span>
        </div>
      </div>

      {statusMsg && (
        <div className="bg-slate-900 border border-amber-500/60 text-amber-200 text-xs p-3.5 rounded-2xl shadow-md">
          {statusMsg}
        </div>
      )}

      {/* 2. Tactical Financial Gauges */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Available Balance */}
        <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-2 relative overflow-hidden">
          <div className="flex justify-between items-center">
            <span className="text-xs font-black text-slate-400 uppercase tracking-wider">Available Balance</span>
            <UsdDollarIcon size={20} />
          </div>
          <div className="text-3xl font-black text-emerald-400 font-mono">
            {wallet?.formattedBalance || '$0.00'}
          </div>
          <div className="text-xs font-mono font-bold text-amber-400 flex items-center space-x-1">
            <GoldCoinIcon size={16} />
            <span>{wallet?.formattedCoins || '0 Coins'}</span>
          </div>
        </div>

        {/* Total Earned */}
        <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs font-black text-slate-400 uppercase tracking-wider">Lifetime Revenue</span>
            <span className="text-xs text-amber-400 font-bold">Kills & MLM</span>
          </div>
          <div className="text-3xl font-black text-amber-300 font-mono">
            {wallet?.formattedTotalEarned || '$0.00'}
          </div>
          <p className="text-[10px] text-slate-500 font-semibold">Total earned from matches, chests & MLM</p>
        </div>

        {/* Total Withdrawn */}
        <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs font-black text-slate-400 uppercase tracking-wider">Total Cashouts</span>
            <span className="text-xs text-sky-400 font-bold">Processed</span>
          </div>
          <div className="text-3xl font-black text-sky-400 font-mono">
            {wallet?.formattedTotalWithdrawn || '$0.00'}
          </div>
          <p className="text-[10px] text-slate-500 font-semibold">Verified through 3-tier fraud pipeline</p>
        </div>
      </div>

      {/* 3. Cashout Request Form */}
      <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl space-y-4">
        <div className="flex justify-between items-center border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm sm:text-base font-black text-white">INSTANT CRYPTO CASHOUT REQUEST</h3>
            <p className="text-[11px] text-slate-400">Withdrawals processed automatically via NOWPayments.</p>
          </div>
          <span className="bg-amber-400/20 text-amber-300 border border-amber-500/30 text-[10px] font-black px-2 py-0.5 rounded-full">
            MIN $10.00 USD
          </span>
        </div>

        <form onSubmit={handleWithdrawSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-300 block mb-1">Cashout Amount (USD):</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-slate-400 font-bold">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="10"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-7 pr-3 py-2 text-xs text-white font-bold font-mono focus:border-emerald-400 focus:outline-none"
                />
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                Cost in coins: {(parseFloat(amountUsd || '0') * 10000).toLocaleString()} Coins ($0.01 = 100 Coins).
              </p>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-300 block mb-1">Cryptocurrency Network:</label>
              <select
                value={crypto}
                onChange={(e) => setCrypto(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-bold focus:border-emerald-400 focus:outline-none"
              >
                <option value="USDT (TRC-20)">USDT (TRC-20 / Tron)</option>
                <option value="TON (The Open Network)">TON (The Open Network)</option>
                <option value="BTC (Bitcoin)">BTC (Bitcoin)</option>
                <option value="SOL (Solana)">SOL (Solana)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-slate-300 block mb-1">Recipient Destination Wallet Address:</label>
            <input
              type="text"
              value={payoutAddress}
              onChange={(e) => setPayoutAddress(e.target.value)}
              required
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-slate-950 font-black py-3 rounded-2xl text-xs transition shadow-lg shadow-emerald-600/30 active:scale-95 disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting to AI Audit...' : 'SUBMIT WITHDRAWAL TO AI AUDIT'}
          </button>
        </form>
      </div>

      {/* 4. Cashout History Table */}
      <div className="bg-slate-900/95 border border-slate-800 rounded-3xl overflow-hidden shadow-xl">
        <div className="p-4 sm:p-5 border-b border-slate-800 flex justify-between items-center">
          <span className="text-sm font-black text-white">Recent Cashout Requests ({withdrawals.length})</span>
          <span className="text-xs text-slate-400 font-semibold">90-Day Audit Log</span>
        </div>

        {withdrawals.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500">
            No withdrawal requests logged yet. Earn $10.00 USD to request your first cashout!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400 font-bold border-b border-slate-800 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="p-3.5">Request ID</th>
                  <th className="p-3.5">Amount</th>
                  <th className="p-3.5">Network</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5 text-right">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-200">
                {withdrawals.map((w) => (
                  <tr key={w.id} className="hover:bg-slate-800/40 transition">
                    <td className="p-3.5 font-mono text-slate-300 font-bold">
                      {w.id.slice(0, 8)}...
                    </td>
                    <td className="p-3.5 text-emerald-400 font-black font-mono">
                      {formatMicroUsd(w.amount_micro_usd)}
                    </td>
                    <td className="p-3.5 text-slate-300 font-bold">
                      {w.crypto_currency}
                    </td>
                    <td className="p-3.5">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase ${
                          w.status === 'completed'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : w.status === 'rejected'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        }`}
                      >
                        {w.status}
                      </span>
                    </td>
                    <td className="p-3.5 text-right text-slate-400 font-mono text-[11px]">
                      {new Date(w.created_at * 1000).toLocaleDateString()}
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
