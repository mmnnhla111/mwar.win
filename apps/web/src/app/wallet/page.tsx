'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatMicroUsd, formatCoins } from '@mwar/shared';

export default function WalletPage() {
  const [wallet, setWallet] = useState<any>(null);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [amountUsd, setAmountUsd] = useState('10.00');
  const [crypto, setCrypto] = useState('USDT');
  const [payoutAddress, setPayoutAddress] = useState('0x71C...DemoTRC20AddressForDev');
  const [statusMsg, setStatusMsg] = useState('');
  const [loading, setLoading] = useState(true);

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
    try {
      const amountMicroUsd = Math.round(parseFloat(amountUsd) * 1_000_000);
      const res = await apiFetch('/api/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          amount_micro_usd: amountMicroUsd,
          crypto_currency: crypto,
          payout_address: payoutAddress,
        }),
      });
      setStatusMsg(`Withdrawal requested successfully! Request ID: ${res.withdrawalId.slice(0, 8)}. Submitted to AI Fraud Audit.`);
      await loadWallet();
    } catch (err: any) {
      setStatusMsg(`Withdrawal Error: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6 py-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-white">WALLET & CASHOUT VAULT</h1>
        <p className="text-xs text-gray-400 mt-1">
          Precision Micro-USD accounting ($1 = 1,000,000 Micro-USD, $0.01 = 100 Coins). Minimum cashout $10.00 USD.
        </p>
      </div>

      {statusMsg && (
        <div className="bg-yellow-950/60 border border-yellow-700/60 text-yellow-300 text-xs p-3 rounded-xl">
          {statusMsg}
        </div>
      )}

      {/* Balance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface rounded-2xl border border-gray-800 p-5">
          <span className="text-xs text-gray-400 font-bold block mb-1">AVAILABLE BALANCE</span>
          <div className="text-3xl font-black text-emerald-400">{wallet?.formattedBalance || '$0.00'}</div>
          <span className="text-xs text-gray-500 font-mono mt-1 block">{wallet?.formattedCoins || '0 Coins'}</span>
        </div>
        <div className="bg-surface rounded-2xl border border-gray-800 p-5">
          <span className="text-xs text-gray-400 font-bold block mb-1">TOTAL EARNED</span>
          <div className="text-3xl font-black text-accent-gold">{wallet?.formattedTotalEarned || '$0.00'}</div>
          <span className="text-xs text-gray-500 mt-1 block">From Combat, 15s Chests & 5-Level MLM</span>
        </div>
        <div className="bg-surface rounded-2xl border border-gray-800 p-5">
          <span className="text-xs text-gray-400 font-bold block mb-1">TOTAL CASHED OUT</span>
          <div className="text-3xl font-black text-cyan-400">{wallet?.formattedTotalWithdrawn || '$0.00'}</div>
          <span className="text-xs text-gray-500 mt-1 block">Approved & Processed via Crypto Vault</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cashout Request Form */}
        <div className="bg-surface rounded-2xl border border-gray-800 p-6 space-y-4">
          <h3 className="text-base font-black text-white border-b border-gray-800 pb-3">Request Withdrawal</h3>
          <form onSubmit={handleWithdrawSubmit} className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-400 block mb-1">Cashout Amount (USD):</label>
              <input
                type="number"
                step="0.01"
                min="10.00"
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
                required
                className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
              />
              <span className="text-[11px] text-gray-500 block mt-1">Min: $10.00 USD (10,000,000 Micro-USD)</span>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-400 block mb-1">Cryptocurrency:</label>
              <select
                value={crypto}
                onChange={(e) => setCrypto(e.target.value)}
                className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
              >
                <option value="USDT">USDT (Tether - TRC20 / Polygon)</option>
                <option value="LTC">Litecoin (LTC - Low Network Fee)</option>
                <option value="TRX">TRON (TRX)</option>
                <option value="BTC">Bitcoin (BTC)</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-400 block mb-1">Destination Wallet Address:</label>
              <input
                type="text"
                value={payoutAddress}
                onChange={(e) => setPayoutAddress(e.target.value)}
                required
                className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
              />
            </div>

            <div className="bg-surfaceLight/50 p-3 rounded-xl border border-gray-800 text-xs space-y-1">
              <div className="flex justify-between text-gray-400">
                <span>Network / Processing Fee:</span>
                <span>$0.50 USD</span>
              </div>
              <div className="flex justify-between font-bold text-white border-t border-gray-700 pt-1">
                <span>Net Estimated Payout:</span>
                <span className="text-emerald-400">
                  ${Math.max(0, parseFloat(amountUsd || '0') - 0.50).toFixed(2)} USD
                </span>
              </div>
            </div>

            <button
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-2.5 rounded-xl text-sm transition shadow-lg"
            >
              SUBMIT CASHOUT REQUEST
            </button>
          </form>
        </div>

        {/* Withdrawal History Table */}
        <div className="lg:col-span-2 bg-surface rounded-2xl border border-gray-800 p-6 space-y-4">
          <h3 className="text-base font-black text-white border-b border-gray-800 pb-3">Withdrawal History & AI Audit Status</h3>

          {withdrawals.length === 0 ? (
            <div className="p-8 text-center text-xs text-gray-500">
              No cashout requests submitted yet. Earn rewards in the 3D game or through 5-level MLM to cash out!
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-surfaceLight/50 text-gray-400 font-semibold border-b border-gray-800">
                  <tr>
                    <th className="p-3">Request ID</th>
                    <th className="p-3">Amount</th>
                    <th className="p-3">Crypto</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">AI Score</th>
                    <th className="p-3">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800 text-gray-200">
                  {withdrawals.map((w) => (
                    <tr key={w.id} className="hover:bg-surfaceLight/30 transition">
                      <td className="p-3 font-mono text-gray-300">{w.id.slice(0, 8)}...</td>
                      <td className="p-3 font-bold text-emerald-400">{w.formattedAmount}</td>
                      <td className="p-3 font-semibold text-white">{w.crypto_currency}</td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            w.status === 'approved'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : w.status === 'rejected'
                              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                              : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                          }`}
                        >
                          {w.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-cyan-400 font-semibold">
                        {w.ai_audit_score ? `${(w.ai_audit_score * 100).toFixed(0)}%` : 'Checking...'}
                      </td>
                      <td className="p-3 text-gray-400">
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
    </div>
  );
}
