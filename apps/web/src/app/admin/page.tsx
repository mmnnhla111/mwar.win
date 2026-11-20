'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

export default function AdminAuditPage() {
  const [pendingList, setPendingList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  const loadPending = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/audit/pending');
      setPendingList(res.withdrawals || []);
    } catch (err: any) {
      setActionMsg(`Failed to load: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPending();
  }, []);

  const handleReview = async (withdrawalId: string, action: 'approve' | 'reject') => {
    setActionMsg('');
    try {
      const res = await apiFetch('/api/audit/review', {
        method: 'POST',
        body: JSON.stringify({
          withdrawal_id: withdrawalId,
          action,
          reason: action === 'approve' ? 'Audit verified clean' : 'Deterministic audit mismatch',
        }),
      });
      setActionMsg(`Action ${action.toUpperCase()} completed on request ${res.withdrawalId.slice(0, 8)}`);
      await loadPending();
    } catch (err: any) {
      setActionMsg(`Error: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6 py-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-white">3-TIER AI FRAUD & WITHDRAWAL AUDIT PIPELINE</h1>
        <p className="text-xs text-gray-400 mt-1">
          Automated multi-layer verification protecting the platform against aimbots, chest farming, and referral win-trading.
        </p>
      </div>

      {actionMsg && (
        <div className="bg-yellow-950/60 border border-yellow-700/60 text-yellow-300 text-xs p-3 rounded-xl">
          {actionMsg}
        </div>
      )}

      {/* 3-Tier Pipeline Flow Diagram */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface rounded-2xl border border-blue-900/40 p-5 space-y-2">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
            <h3 className="text-xs font-black text-blue-400 tracking-wider">LAYER 1: DETERMINISTIC AUDIT</h3>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            Instant 1-second verification comparing D1 wallet against 90-day PostgreSQL log ledger:
            <span className="block font-mono text-[11px] text-gray-300 mt-1">
              ∑ Inflows - ∑ Outflows = Current Balance (100.00% Match)
            </span>
          </p>
        </div>

        <div className="bg-surface rounded-2xl border border-purple-900/40 p-5 space-y-2">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-500"></span>
            <h3 className="text-xs font-black text-purple-400 tracking-wider">LAYER 2: BEHAVIORAL ANOMALY</h3>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            Real-time heuristic evaluation: Headshot Ratio &gt; 85% or Chest Collection Frequency exceeding 3σ.
          </p>
        </div>

        <div className="bg-surface rounded-2xl border border-emerald-900/40 p-5 space-y-2">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            <h3 className="text-xs font-black text-emerald-400 tracking-wider">LAYER 3: ML NETWORK GRAPH</h3>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            Anti-collusion graph scan to detect sybil accounts repeatedly killing each other in isolated rooms.
          </p>
        </div>
      </div>

      {/* Pending Withdrawals Table */}
      <div className="bg-surface rounded-2xl border border-gray-800 overflow-hidden">
        <div className="p-4 border-b border-gray-800 flex justify-between items-center">
          <h3 className="text-sm font-bold text-white">Pending Cashouts for Review ({pendingList.length})</h3>
          <button
            onClick={loadPending}
            className="text-xs text-gray-400 hover:text-white bg-surfaceLight px-3 py-1 rounded-lg border border-gray-700"
          >
            Refresh List
          </button>
        </div>

        {loading ? (
          <div className="p-10 text-center text-xs text-gray-400">Loading pending requests...</div>
        ) : pendingList.length === 0 ? (
          <div className="p-10 text-center text-xs text-gray-500">
            All clear! No pending withdrawal requests awaiting review.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surfaceLight/50 text-gray-400 font-semibold border-b border-gray-800">
                <tr>
                  <th className="p-3">User</th>
                  <th className="p-3">Amount</th>
                  <th className="p-3">Net Payout</th>
                  <th className="p-3">Destination Address</th>
                  <th className="p-3">AI Score</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 text-gray-200">
                {pendingList.map((w) => (
                  <tr key={w.id} className="hover:bg-surfaceLight/30 transition">
                    <td className="p-3 font-bold text-white">
                      <div>{w.username}</div>
                      <div className="text-[10px] text-gray-400 font-mono">{w.user_id.slice(0, 8)}...</div>
                    </td>
                    <td className="p-3 font-bold text-white">{w.formattedAmount}</td>
                    <td className="p-3 font-bold text-emerald-400">{w.formattedNetAmount}</td>
                    <td className="p-3 font-mono text-gray-400">{w.payout_address}</td>
                    <td className="p-3">
                      <span className="font-mono font-bold text-cyan-400">
                        {w.ai_audit_score ? `${(w.ai_audit_score * 100).toFixed(0)}%` : 'Checking...'}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 px-2 py-0.5 rounded text-[10px] font-bold">
                        {w.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-3 text-right space-x-2">
                      <button
                        onClick={() => handleReview(w.id, 'approve')}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded-lg text-[11px] shadow"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleReview(w.id, 'reject')}
                        className="bg-red-600 hover:bg-red-500 text-white font-bold px-3 py-1 rounded-lg text-[11px] shadow"
                      >
                        Reject & Refund
                      </button>
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
