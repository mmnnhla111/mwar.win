'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '../../lib/api';
import { formatMicroUsd } from '@mwar/shared';

export default function NetworkPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [upline, setUpline] = useState<any>(null);
  const [selectedDepth, setSelectedDepth] = useState<number | null>(null);
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

  const rates: Record<number, string> = {
    1: '50% of Net Pool',
    2: '20% of Net Pool',
    3: '15% of Net Pool',
    4: '10% of Net Pool',
    5: '5% of Net Pool',
  };

  const filteredMembers = selectedDepth ? members.filter((m) => m.depth === selectedDepth) : members;

  return (
    <div className="space-y-6 py-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-black text-white">5-LEVEL MLM AFFILIATE TEAM</h1>
          <p className="text-xs text-gray-400 mt-1">
            Closure table hierarchy tracking 5 levels of revenue distribution from in-game combat and ad revenue.
          </p>
        </div>

        {upline && (
          <div className="bg-surface border border-gray-800 px-4 py-2 rounded-xl text-xs flex items-center space-x-3">
            <span className="text-gray-400">Your Direct Sponsor:</span>
            <span className="font-bold text-yellow-400">{upline.username}</span>
            <Link
              href={`/chat?userId=${upline.id}`}
              className="bg-red-600/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded hover:bg-red-600/30 font-semibold"
            >
              Chat
            </Link>
          </div>
        )}
      </div>

      {/* 5-Level Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[1, 2, 3, 4, 5].map((depth) => {
          const count = stats?.levelStats?.[depth] || 0;
          const isSelected = selectedDepth === depth;
          return (
            <button
              key={depth}
              onClick={() => setSelectedDepth(isSelected ? null : depth)}
              className={`p-4 rounded-xl border text-left transition ${
                isSelected
                  ? 'bg-red-600/20 border-red-500 text-white shadow-lg'
                  : 'bg-surface border-gray-800 hover:border-gray-700 text-gray-300'
              }`}
            >
              <div className="flex justify-between items-center mb-1">
                <span className="text-[11px] font-bold text-gray-400">LEVEL {depth}</span>
                <span className="text-[10px] bg-gray-800 px-1.5 py-0.5 rounded text-gray-400 font-mono">
                  {rates[depth].split(' ')[0]}
                </span>
              </div>
              <div className="text-2xl font-black text-white">{count}</div>
              <span className="text-[10px] text-gray-500">{rates[depth]}</span>
            </button>
          );
        })}
      </div>

      {/* Downline Members Table */}
      <div className="bg-surface rounded-2xl border border-gray-800 overflow-hidden">
        <div className="p-4 border-b border-gray-800 flex justify-between items-center">
          <span className="text-sm font-bold text-white">
            Downline Members ({filteredMembers.length}) {selectedDepth && `in Level ${selectedDepth}`}
          </span>
          {selectedDepth && (
            <button
              onClick={() => setSelectedDepth(null)}
              className="text-xs text-gray-400 hover:text-white"
            >
              Clear Filter
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading network members...</div>
        ) : filteredMembers.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm text-gray-400">No downline members registered under this level yet.</p>
            <p className="text-xs text-gray-500">
              Share your referral link to build your team and earn 50% commission on direct referrals.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surfaceLight/50 text-gray-400 font-semibold border-b border-gray-800">
                <tr>
                  <th className="p-3">Member Username</th>
                  <th className="p-3">Hierarchy Depth</th>
                  <th className="p-3">Total Earned</th>
                  <th className="p-3">Joined Date</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 text-gray-200">
                {filteredMembers.map((m) => (
                  <tr key={m.userId} className="hover:bg-surfaceLight/30 transition">
                    <td className="p-3 font-bold text-white flex items-center space-x-2">
                      <div className="w-6 h-6 rounded-full bg-red-600/30 border border-red-500/40 flex items-center justify-center text-[10px]">
                        {m.username.substring(0, 2).toUpperCase()}
                      </div>
                      <span>{m.username}</span>
                    </td>
                    <td className="p-3">
                      <span className="bg-gray-800 text-yellow-400 px-2 py-0.5 rounded font-mono font-bold">
                        Level {m.depth}
                      </span>
                    </td>
                    <td className="p-3 text-emerald-400 font-bold">
                      {formatMicroUsd(m.totalEarnedMicroUsd)}
                    </td>
                    <td className="p-3 text-gray-400">
                      {new Date(m.createdAt * 1000).toLocaleDateString()}
                    </td>
                    <td className="p-3 text-right">
                      <Link
                        href={`/chat?userId=${m.userId}`}
                        className="bg-surfaceLight hover:bg-gray-700 text-gray-200 px-3 py-1 rounded-lg border border-gray-700 font-semibold"
                      >
                        1-on-1 Chat
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
