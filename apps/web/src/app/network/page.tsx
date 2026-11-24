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
    1: { percent: '5% of V', color: 'text-amber-700', border: 'border-amber-200', bg: 'bg-amber-50' },
    2: { percent: '4% of V', color: 'text-sky-600', border: 'border-sky-200', bg: 'bg-sky-50' },
    3: { percent: '3% of V', color: 'text-violet-600', border: 'border-violet-200', bg: 'bg-violet-50' },
    4: { percent: '2% of V', color: 'text-emerald-600', border: 'border-emerald-200', bg: 'bg-emerald-50' },
    5: { percent: '1% of V', color: 'text-rose-500', border: 'border-rose-200', bg: 'bg-rose-50' },
  };

  const filteredMembers = members.filter((m) => {
    const matchesDepth = selectedDepth === null || m.depth === selectedDepth;
    const matchesSearch = !searchQuery || m.username.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesDepth && matchesSearch;
  });

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Page Header */}
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 rounded-2xl bg-sky-50 border border-sky-200 flex items-center justify-center shrink-0">
            <NetworkTreeIcon size={28} />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-stone-900 tracking-tight flex items-center space-x-2">
              <span>5-LEVEL AFFILIATE COMMAND</span>
              <span className="bg-sky-50 text-sky-600 border border-sky-200 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
                CLOSURE TABLE
              </span>
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">
              5-level hierarchy tracking instant commissions from downline kills, bounty chests, and ad views.
            </p>
          </div>
        </div>

        {upline && (
          <div className="bg-stone-50 border border-stone-200/80 px-4 py-2 rounded-2xl text-xs flex items-center space-x-3 ">
            <span className="text-stone-500">Direct Sponsor:</span>
            <span className="font-extrabold text-amber-700">{upline.username}</span>
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
              className={`p-4 rounded-2xl border text-left transition transform hover:-translate-y-0.5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] ${
                isSelected
                  ? `bg-[#FFFBEA] border-[#FACC15] ring-2 ring-[#FFE135]/50 text-stone-900`
                  : `bg-white border-stone-200/80 hover:border-stone-300 text-stone-600`
              }`}
            >
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[11px] font-extrabold tracking-wide text-stone-600">LEVEL {depth}</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${tier.bg} ${tier.color} border ${tier.border}`}>
                  {tier.percent.split(' ')[0]}
                </span>
              </div>
              <div className="text-2xl font-extrabold text-stone-900 font-mono">{count}</div>
              <span className="text-[10px] text-stone-500 font-semibold">{tier.percent}</span>
            </button>
          );
        })}
      </div>

      {/* 3. Downline Members Table & Filter Hub */}
      <div className="bg-white rounded-3xl border border-stone-200/80 shadow-[0_2px_12px_rgba(0,0,0,0.04)] overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-stone-200/80 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-extrabold text-stone-900">
              Downline Squad Members ({filteredMembers.length})
            </span>
            {selectedDepth && (
              <span className="bg-rose-50 text-rose-500 border border-rose-200 text-[10px] font-bold px-2 py-0.5 rounded-full">
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
              className="w-full sm:w-48 bg-stone-50 border border-stone-200/80 rounded-xl px-3 py-1.5 text-xs text-stone-900 placeholder-stone-400 focus:border-yellow-400 focus:outline-none"
            />
            {selectedDepth && (
              <button
                onClick={() => setSelectedDepth(null)}
                className="text-xs text-stone-500 hover:text-stone-900 bg-stone-100 px-3 py-1.5 rounded-xl border border-stone-200/80 shrink-0 font-bold"
              >
                Clear Filter
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-sm text-stone-500 animate-pulse">Loading affiliate team members...</div>
        ) : filteredMembers.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-stone-100 flex items-center justify-center text-stone-500 text-xl">
              👥
            </div>
            <p className="text-sm font-bold text-stone-600">No squad members found for this level.</p>
            <p className="text-xs text-stone-500 max-w-sm mx-auto">
              Share your referral link in the Lobby to start growing your 5-level team and earning passive revenue.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-50 text-stone-500 font-bold border-b border-stone-200/80 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="p-3.5">Warrior</th>
                  <th className="p-3.5">MLM Tier</th>
                  <th className="p-3.5">Lifetime Generated</th>
                  <th className="p-3.5">Enlistment Date</th>
                  <th className="p-3.5 text-right">Comms</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-stone-700">
                {filteredMembers.map((m) => (
                  <tr key={m.userId} className="hover:bg-stone-50 transition">
                    <td className="p-3.5 font-bold text-stone-900 flex items-center space-x-2.5">
                      <div className="w-7 h-7 rounded-xl bg-stone-100 border border-stone-200/80 flex items-center justify-center text-amber-700 font-extrabold text-xs shrink-0">
                        {m.username.substring(0, 2).toUpperCase()}
                      </div>
                      <span className="font-extrabold">{m.username}</span>
                    </td>
                    <td className="p-3.5">
                      <span className="bg-stone-50 border border-stone-200/80 text-amber-700 px-2.5 py-1 rounded-xl font-mono font-bold text-[11px]">
                        Level {m.depth}
                      </span>
                    </td>
                    <td className="p-3.5 text-emerald-600 font-extrabold font-mono">
                      {formatMicroUsd(m.totalEarnedMicroUsd)}
                    </td>
                    <td className="p-3.5 text-stone-500 font-mono text-[11px]">
                      {new Date(m.createdAt * 1000).toLocaleDateString()}
                    </td>
                    <td className="p-3.5 text-right">
                      <Link
                        href={`/chat?userId=${m.userId}`}
                        className="bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold px-3 py-1.5 rounded-xl border border-stone-200/80 transition active:scale-95 inline-flex items-center space-x-1"
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
