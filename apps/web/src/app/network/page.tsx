'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '../../lib/api';
import { formatMicroUsd } from '@mwar/shared';
import { NetworkTreeIcon, QuestChatIcon, GoldCoinIcon } from '../../components/icons';

export default function NetworkPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [upline, setUpline] = useState<any>(null);
  const [selectedDepth, setSelectedDepth] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadNetwork() {
      setLoading(true);
      try {
        const [downlineRes, statsRes, uplineRes] = await Promise.all([
          apiFetch('/api/network/downline'),
          apiFetch('/api/network/stats'),
          apiFetch('/api/network/upline'),
        ]);
        setMembers(downlineRes.members || []);
        setStats(statsRes);
        setUpline(uplineRes.upline);
      } catch (err) {
        console.error('Failed to load network:', err);
      } finally {
        setLoading(false);
      }
    }
    loadNetwork();
  }, []);

  const rates: Record<number, { percent: string; color: string; border: string; bg: string }> = {
    1: { percent: '50% Net Share', color: 'text-amber-400', border: 'border-amber-500/40', bg: 'bg-amber-500/10' },
    2: { percent: '20% Net Share', color: 'text-sky-400', border: 'border-sky-500/40', bg: 'bg-sky-500/10' },
    3: { percent: '15% Net Share', color: 'text-purple-400', border: 'border-purple-500/40', bg: 'bg-purple-500/10' },
    4: { percent: '10% Net Share', color: 'text-emerald-400', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10' },
    5: { percent: '5% Net Share', color: 'text-rose-400', border: 'border-rose-500/40', bg: 'bg-rose-500/10' },
  };

  const filteredMembers = members.filter((m) => {
    const matchesDepth = selectedDepth === null || m.depth === selectedDepth;
    const matchesSearch = !searchQuery || m.username.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesDepth && matchesSearch;
  });

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Page Header */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 rounded-2xl bg-sky-500/20 border border-sky-500/40 flex items-center justify-center shrink-0">
            <NetworkTreeIcon size={28} />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight flex items-center space-x-2">
              <span>5-LEVEL AFFILIATE COMMAND</span>
              <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[10px] font-black px-2 py-0.5 rounded-full">
                CLOSURE TABLE
              </span>
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              5-level hierarchy tracking instant commissions from downline kills, bounty chests, and ad views.
            </p>
          </div>
        </div>

        {upline && (
          <div className="bg-slate-950/80 border border-slate-800 px-4 py-2 rounded-2xl text-xs flex items-center space-x-3 shadow-inner">
            <span className="text-slate-400">Direct Sponsor:</span>
            <span className="font-black text-amber-400">{upline.username}</span>
            <Link
              href={`/chat?userId=${upline.id}`}
              className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-2.5 py-1 rounded-xl text-[11px] transition active:scale-95 flex items-center space-x-1"
            >
              <QuestChatIcon size={14} />
              <span>Squad Chat</span>
            </Link>
          </div>
        )}
      </div>

      {/* 2. 5-Level Interactive Tier Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[1, 2, 3, 4, 5].map((depth) => {
          const count = stats?.levelStats?.[depth] || 0;
          const isSelected = selectedDepth === depth;
          const tier = rates[depth];

          return (
            <button
              key={depth}
              onClick={() => setSelectedDepth(isSelected ? null : depth)}
              className={`p-4 rounded-2xl border text-left transition transform hover:-translate-y-0.5 shadow-md ${
                isSelected
                  ? `bg-slate-800 border-rose-500 ring-2 ring-rose-500/30 text-white`
                  : `bg-slate-900/90 border-slate-800 hover:border-slate-700 text-slate-300`
              }`}
            >
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[11px] font-black tracking-wide text-slate-300">LEVEL {depth}</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${tier.bg} ${tier.color} border ${tier.border}`}>
                  {tier.percent.split(' ')[0]}
                </span>
              </div>
              <div className="text-2xl font-black text-white font-mono">{count}</div>
              <span className="text-[10px] text-slate-400 font-semibold">{tier.percent}</span>
            </button>
          );
        })}
      </div>

      {/* 3. Downline Members Table & Filter Hub */}
      <div className="bg-slate-900/95 rounded-3xl border border-slate-800 shadow-xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-black text-white">
              Downline Squad Members ({filteredMembers.length})
            </span>
            {selectedDepth && (
              <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold px-2 py-0.5 rounded-full">
                Level {selectedDepth} Only
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2 w-full sm:w-auto">
            <input
              type="text"
              placeholder="Search squad username..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full sm:w-48 bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-400 focus:outline-none"
            />
            {selectedDepth && (
              <button
                onClick={() => setSelectedDepth(null)}
                className="text-xs text-slate-400 hover:text-white bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-700 shrink-0 font-bold"
              >
                Clear Filter
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-sm text-slate-400 animate-pulse">Loading affiliate team members...</div>
        ) : filteredMembers.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-800 flex items-center justify-center text-slate-500 text-xl">
              👥
            </div>
            <p className="text-sm font-bold text-slate-300">No squad members found for this level.</p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Share your referral link in the Lobby to start growing your 5-level team and earning passive revenue.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400 font-bold border-b border-slate-800 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="p-3.5">Warrior</th>
                  <th className="p-3.5">MLM Tier</th>
                  <th className="p-3.5">Lifetime Generated</th>
                  <th className="p-3.5">Enlistment Date</th>
                  <th className="p-3.5 text-right">Comms</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-200">
                {filteredMembers.map((m) => (
                  <tr key={m.userId} className="hover:bg-slate-800/40 transition">
                    <td className="p-3.5 font-bold text-white flex items-center space-x-2.5">
                      <div className="w-7 h-7 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-amber-300 font-black text-xs shrink-0">
                        {m.username.substring(0, 2).toUpperCase()}
                      </div>
                      <span className="font-extrabold">{m.username}</span>
                    </td>
                    <td className="p-3.5">
                      <span className="bg-slate-950 border border-slate-700 text-amber-300 px-2.5 py-1 rounded-xl font-mono font-bold text-[11px]">
                        Level {m.depth}
                      </span>
                    </td>
                    <td className="p-3.5 text-emerald-400 font-black font-mono">
                      {formatMicroUsd(m.totalEarnedMicroUsd)}
                    </td>
                    <td className="p-3.5 text-slate-400 font-mono text-[11px]">
                      {new Date(m.createdAt * 1000).toLocaleDateString()}
                    </td>
                    <td className="p-3.5 text-right">
                      <Link
                        href={`/chat?userId=${m.userId}`}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold px-3 py-1.5 rounded-xl border border-slate-700 transition active:scale-95 inline-flex items-center space-x-1"
                      >
                        <QuestChatIcon size={14} />
                        <span>Chat</span>
                      </Link>
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
