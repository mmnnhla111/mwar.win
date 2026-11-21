'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  apiFetch,
  setAuthToken,
  clearAuthToken,
  getTodayQuests,
  progressQuest,
  claimQuest,
  getDailyMlmSummary,
} from '../lib/api';
import {
  FightEmblemIcon,
  EnergyTicketIcon,
  GoldCoinIcon,
  UsdDollarIcon,
  NetworkTreeIcon,
  StoryReelIcon,
  LockGreyIcon,
  UnlockGreenIcon,
  BountyChestIcon,
  GhostSpectatorIcon,
  QuestAdVideoIcon,
  QuestCrosshairIcon,
  QuestSpectateIcon,
  QuestChatIcon,
  QuestCheckinIcon,
} from '../components/icons';
import { preloadGameAssets } from '../lib/cache';
import type { TodayQuestsResponse, DailyMlmSummary } from '@mwar/shared';

const RANK_BADGE_MAP: Record<string, string> = {
  Bronze: '/images/rank_bronze.svg',
  Silver: '/images/rank_silver.svg',
  Gold: '/images/rank_gold.svg',
  Diamond: '/images/rank_diamond.svg',
  Legendary: '/images/rank_legendary.svg',
};

export default function LobbyPage() {
  const [user, setUser] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [networkStats, setNetworkStats] = useState<any>(null);
  const [questData, setQuestData] = useState<TodayQuestsResponse | null>(null);
  const [mlmSummary, setMlmSummary] = useState<DailyMlmSummary | null>(null);

  // Auth Form State
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('demo_warrior');
  const [email, setEmail] = useState('warrior@mwar.local');
  const [password, setPassword] = useState('Password123!');
  const [referrerId, setReferrerId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // Modals
  const [isFightModalOpen, setIsFightModalOpen] = useState(false);
  const [isStoryModalOpen, setIsStoryModalOpen] = useState(false);
  const [claimingQuestId, setClaimingQuestId] = useState<string | null>(null);
  const [claimFeedback, setClaimFeedback] = useState<string | null>(null);

  const loadData = async () => {
    try {
      preloadGameAssets();
      const meRes = await apiFetch('/api/auth/me');
      setUser(meRes.user);
      setWallet(meRes.wallet);

      const [stats, quests, mlm] = await Promise.all([
        apiFetch('/api/network/stats').catch(() => null),
        getTodayQuests().catch(() => null),
        getDailyMlmSummary().catch(() => null),
      ]);

      setNetworkStats(stats);
      setQuestData(quests);
      setMlmSummary(mlm);
      setErrorMsg('');
    } catch {
      setUser(null);
      setWallet(null);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    try {
      if (authMode === 'register') {
        const res = await apiFetch('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            username,
            email,
            password,
            referrer_id: referrerId.trim() || undefined,
          }),
        });
        if (res.token) {
          setAuthToken(res.token);
          await loadData();
        }
      } else {
        const res = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            usernameOrEmail: username,
            password,
          }),
        });
        if (res.token) {
          setAuthToken(res.token);
          await loadData();
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleClaimQuest = async (questId: string) => {
    setClaimingQuestId(questId);
    setClaimFeedback(null);
    try {
      const res = await claimQuest(questId);
      if (res.success) {
        setClaimFeedback(`+${res.rewardCoins} Coins credited to wallet!`);
        await loadData();
      }
    } catch (err: any) {
      setClaimFeedback(err.message || 'Failed to claim');
    } finally {
      setClaimingQuestId(null);
      setTimeout(() => setClaimFeedback(null), 3000);
    }
  };

  const handleCheckin = async () => {
    try {
      await progressQuest('Q_DAILY_CHECKIN', 1);
      await claimQuest('Q_DAILY_CHECKIN');
      await loadData();
    } catch (err: any) {
      setClaimFeedback(err.message || 'Check-in failed');
      setTimeout(() => setClaimFeedback(null), 3000);
    }
  };

  const handleCopyRef = () => {
    if (!user?.id) return;
    const url = `${window.location.origin}/?ref=${user.id}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderQuestIcon = (actionType: string) => {
    switch (actionType) {
      case 'daily_checkin':
        return <QuestCheckinIcon size={24} />;
      case 'watch_rewarded_ad':
        return <QuestAdVideoIcon size={24} />;
      case 'finish_game_match':
        return <QuestCrosshairIcon size={24} />;
      case 'spectate_match_90s':
        return <QuestSpectateIcon size={24} />;
      case 'send_chat_or_network':
        return <QuestChatIcon size={24} />;
      case 'earn_coins':
      default:
        return <GoldCoinIcon size={24} />;
    }
  };

  const rankBadgeImg = RANK_BADGE_MAP[user?.rank_badge || 'Gold'] || RANK_BADGE_MAP['Gold'];

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Tactical Hero Lobby Banner with Ambient Cyber Grid */}
      <section className="relative overflow-hidden rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl p-5 sm:p-8 bg-[url('/images/hero_backdrop.svg')] bg-cover bg-center">
        <div className="absolute inset-0 bg-gradient-to-r from-slate-950/90 via-slate-950/70 to-slate-900/40 pointer-events-none" />

        <div className="relative z-10 max-w-3xl space-y-4">
          <div className="inline-flex items-center space-x-2 bg-rose-500/20 border border-rose-500/40 text-rose-300 px-3 py-1 rounded-full text-xs font-black tracking-wide">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
            <span>SEASON 1 • PROOF-OF-ACTIVITY MLM & CASUAL SHOOTER</span>
          </div>

          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-none uppercase">
            Survive. Claim Drops. <br />
            <span className="bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 bg-clip-text text-transparent">
              Unlock 5-Level Wealth.
            </span>
          </h1>

          <p className="text-slate-300 text-xs sm:text-sm max-w-xl leading-relaxed">
            20 Hz pure RAM Colyseus multiplayer arena. Grab 15-second dynamic treasure chests on kills, disguise as prop crates on disconnect, and complete daily quests to unlock your passive downline network revenue at midnight.
          </p>

          {/* Quick Action Navigation Dock */}
          <div className="pt-2 flex flex-wrap items-center gap-3">
            {/* Centerpiece FIGHT Button */}
            <button
              onClick={() => setIsFightModalOpen(true)}
              className="bg-gradient-to-r from-rose-600 via-rose-500 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white font-black text-sm sm:text-base px-6 py-3.5 rounded-2xl shadow-xl shadow-rose-600/40 transition transform active:scale-95 flex items-center space-x-2"
            >
              <FightEmblemIcon size={24} />
              <span>FIGHT ARENA</span>
            </button>

            {/* Story / Reels Button */}
            <button
              onClick={() => setIsStoryModalOpen(true)}
              className="bg-slate-800/90 hover:bg-slate-700/90 text-slate-200 border border-slate-700 font-bold text-xs sm:text-sm px-4 py-3 rounded-2xl transition flex items-center space-x-1.5 shadow-md"
            >
              <StoryReelIcon size={20} />
              <span>STORY CLIPS</span>
            </button>

            {/* Direct Links */}
            <Link
              href="/network"
              className="bg-slate-800/90 hover:bg-slate-700/90 text-sky-300 border border-sky-500/30 font-bold text-xs sm:text-sm px-4 py-3 rounded-2xl transition flex items-center space-x-1.5 shadow-md"
            >
              <NetworkTreeIcon size={20} />
              <span>NETWORK</span>
            </Link>

            <Link
              href="/marketplace"
              className="bg-slate-800/90 hover:bg-slate-700/90 text-amber-300 border border-amber-500/30 font-bold text-xs sm:text-sm px-4 py-3 rounded-2xl transition flex items-center space-x-1.5 shadow-md"
            >
              <span>🛒</span>
              <span>MARKET</span>
            </Link>

            <Link
              href="/wallet"
              className="bg-slate-800/90 hover:bg-slate-700/90 text-emerald-300 border border-emerald-500/30 font-bold text-xs sm:text-sm px-4 py-3 rounded-2xl transition flex items-center space-x-1.5 shadow-md"
            >
              <UsdDollarIcon size={20} />
              <span>WALLET</span>
            </Link>
          </div>
        </div>
      </section>

      {/* Claim Feedback Banner */}
      {claimFeedback && (
        <div className="bg-gradient-to-r from-amber-950/80 via-emerald-950/80 to-slate-900 border border-amber-500/60 text-amber-200 px-4 py-3 rounded-2xl text-center text-xs font-black shadow-lg animate-bounce">
          🎉 {claimFeedback}
        </div>
      )}

      {/* 2. Responsive 2-Column Split View (Tablet & Desktop: Side-by-Side; Mobile: Single Stack) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (Lg: 5 Cols): Character / Rank Showcase & Referral Hub */}
        <div className="lg:col-span-5 space-y-6">
          {user ? (
            <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl space-y-5">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div className="flex items-center space-x-3">
                  <div className="w-14 h-14 rounded-2xl overflow-hidden bg-slate-800 border-2 border-amber-400 shrink-0 shadow-lg">
                    <img src={user.avatar_url || '/images/avatar_1.svg'} alt="Avatar" className="w-full h-full object-cover" />
                  </div>
                  <div>
                    <div className="flex items-center space-x-1.5">
                      <h2 className="text-lg font-black text-white">{user.username}</h2>
                      <img src={rankBadgeImg} alt="Rank" className="w-5 h-5 shrink-0" />
                    </div>
                    <span className="text-xs font-bold text-amber-400">{user.rank_badge || 'Gold'} Rank</span>
                  </div>
                </div>

                <button
                  onClick={() => {
                    clearAuthToken();
                    setUser(null);
                    setWallet(null);
                  }}
                  className="text-xs text-rose-400 hover:text-rose-300 bg-rose-950/40 px-3 py-1.5 rounded-xl border border-rose-900/50 font-bold"
                >
                  Logout
                </button>
              </div>

              {/* Combat & Wallet Stats Grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800">
                  <span className="text-[11px] text-slate-400 font-bold block mb-1">Withdrawable Balance</span>
                  <div className="text-xl font-black text-emerald-400 font-mono">{wallet?.formatted_balance || '$0.00'}</div>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {(((wallet?.balance_micro_usd || 0) / 100)).toLocaleString()} Coins
                  </span>
                </div>

                <div className="bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800">
                  <span className="text-[11px] text-slate-400 font-bold block mb-1">Energy Tickets</span>
                  <div className="text-xl font-black text-amber-300 flex items-center space-x-1">
                    <span>{user.energy_tickets ?? 6} / {user.max_energy_tickets ?? 6}</span>
                    <EnergyTicketIcon size={18} />
                  </div>
                  <span className="text-[10px] text-slate-500">Auto +1 every 60 mins</span>
                </div>

                <div className="bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800">
                  <span className="text-[11px] text-slate-400 font-bold block mb-1">Downline Network</span>
                  <div className="text-xl font-black text-sky-400 font-mono">{networkStats?.totalTeamMembers || 0}</div>
                  <span className="text-[10px] text-slate-500">Across 5 Levels</span>
                </div>

                <div className="bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800">
                  <span className="text-[11px] text-slate-400 font-bold block mb-1">Lifetime Earned</span>
                  <div className="text-xl font-black text-amber-400 font-mono">{wallet?.formatted_total_earned || '$0.00'}</div>
                  <span className="text-[10px] text-slate-500">Kills, Chests & MLM</span>
                </div>
              </div>

              {/* 5-Level MLM Referral Link */}
              <div className="bg-slate-950/90 p-4 rounded-2xl border border-slate-800 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-black text-slate-200">Your 5-Level Referral Link</span>
                  <span className="text-[10px] text-amber-400 font-bold">5% - 1% Commission</span>
                </div>
                <div className="flex space-x-2">
                  <input
                    type="text"
                    readOnly
                    value={typeof window !== 'undefined' ? `${window.location.origin}/?ref=${user.id}` : ''}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-300 font-mono"
                  />
                  <button
                    onClick={handleCopyRef}
                    className="bg-rose-600 hover:bg-rose-500 text-white font-black px-4 py-2 rounded-xl text-xs transition active:scale-95"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500">
                  Share to build your 5-level team. Commissions unlock daily upon completing 4 quests!
                </p>
              </div>

              {/* 15s Bounty Drop Showcase Card */}
              <div className="bg-gradient-to-r from-amber-950/40 via-slate-900 to-slate-950 p-4 rounded-2xl border border-amber-500/30 flex items-center justify-between">
                <div className="space-y-1">
                  <span className="text-xs font-black text-amber-300 flex items-center space-x-1.5">
                    <BountyChestIcon size={18} />
                    <span>15-SECOND DEATH BOUNTY</span>
                  </span>
                  <p className="text-[11px] text-slate-400">
                    Eliminated players drop glowing chests. Open within 15 seconds to claim instant Micro-USD coins!
                  </p>
                </div>
                <img src="/images/chest_3d.svg" alt="Chest" className="w-14 h-14 shrink-0 drop-shadow-md" />
              </div>
            </div>
          ) : (
            /* Auth Login / Register Box */
            <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-5">
              <div className="flex space-x-3 border-b border-slate-800 pb-3">
                <button
                  onClick={() => setAuthMode('login')}
                  className={`text-xs font-black pb-2 border-b-2 transition ${
                    authMode === 'login' ? 'border-rose-500 text-white' : 'border-transparent text-slate-400'
                  }`}
                >
                  WARRIOR SIGN IN
                </button>
                <button
                  onClick={() => setAuthMode('register')}
                  className={`text-xs font-black pb-2 border-b-2 transition ${
                    authMode === 'register' ? 'border-rose-500 text-white' : 'border-transparent text-slate-400'
                  }`}
                >
                  NEW SQUAD MEMBER
                </button>
              </div>

              {errorMsg && (
                <div className="bg-rose-950/80 border border-rose-500/50 text-rose-300 p-3 rounded-xl text-xs font-semibold">
                  {errorMsg}
                </div>
              )}

              <form onSubmit={handleAuthSubmit} className="space-y-3">
                <div>
                  <label className="text-[11px] font-bold text-slate-300 block mb-1">
                    {authMode === 'register' ? 'Choose Username' : 'Username or Email'}
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-bold focus:border-rose-500 focus:outline-none"
                  />
                </div>

                {authMode === 'register' && (
                  <div>
                    <label className="text-[11px] font-bold text-slate-300 block mb-1">Email Address</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-bold focus:border-rose-500 focus:outline-none"
                    />
                  </div>
                )}

                <div>
                  <label className="text-[11px] font-bold text-slate-300 block mb-1">Secret Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-bold focus:border-rose-500 focus:outline-none"
                  />
                </div>

                {authMode === 'register' && (
                  <div>
                    <label className="text-[11px] font-bold text-slate-300 block mb-1">Sponsor Referrer ID (Optional)</label>
                    <input
                      type="text"
                      value={referrerId}
                      onChange={(e) => setReferrerId(e.target.value)}
                      placeholder="e.g. 5-level upline user ID"
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:border-rose-500 focus:outline-none"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-gradient-to-r from-rose-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white font-black py-3 rounded-xl text-xs transition shadow-lg shadow-rose-600/30 active:scale-95 mt-2"
                >
                  {authMode === 'register' ? 'CREATE PROFILE & ENTER LOBBY' : 'DEPLOY TO COMBAT LOBBY'}
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Right Column (Lg: 7 Cols): Daily Quests & Proof-of-Activity Unlock Center */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl space-y-5">
            {/* Header & Grey-to-Green MLM Status Banner */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-xl font-black text-white flex items-center space-x-2">
                  <span>DAILY QUESTS & MLM UNLOCK</span>
                </h3>
                <p className="text-xs text-slate-400">Complete ≥ 4 quests to unlock your 5-level downline commissions</p>
              </div>

              {/* Status Pill */}
              {mlmSummary?.isUnlocked ? (
                <div className="bg-emerald-950 border border-emerald-400/80 text-emerald-300 px-3.5 py-1.5 rounded-2xl flex items-center space-x-2 text-xs font-black shadow-md shadow-emerald-500/20">
                  <UnlockGreenIcon size={18} />
                  <span>COMMISSIONS UNLOCKED</span>
                </div>
              ) : (
                <div className="bg-slate-800 border border-slate-700 text-slate-400 px-3.5 py-1.5 rounded-2xl flex items-center space-x-2 text-xs font-black">
                  <LockGreyIcon size={18} />
                  <span>
                    {mlmSummary?.completedQuestsCount || 0}/4 QUESTS COMPLETED
                  </span>
                </div>
              )}
            </div>

            {/* Daily MLM Proof-of-Activity Explanation Box */}
            <div
              className={`p-4 rounded-2xl border transition-all ${
                mlmSummary?.isUnlocked
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                  : 'bg-slate-950/60 border-slate-800 text-slate-300'
              }`}
            >
              <div className="flex items-start space-x-3">
                <div className="mt-0.5 shrink-0">
                  {mlmSummary?.isUnlocked ? <UnlockGreenIcon size={20} /> : <LockGreyIcon size={20} />}
                </div>
                <div className="space-y-1 text-xs">
                  <div className="font-black text-sm">
                    {mlmSummary?.isUnlocked ? "Today's MLM Downline Earnings: ACTIVE" : "Proof-of-Activity Engine"}
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    {mlmSummary?.message || 'Complete 4 daily quests to activate your 5-level downline commissions for midnight settlement.'}
                  </p>
                  <div className="flex flex-wrap gap-4 pt-1 font-mono text-[11px]">
                    <span className="text-slate-400">
                      Locked Grey: <strong className="text-slate-200">{mlmSummary?.formattedPendingGrey || '$0.00'}</strong>
                    </span>
                    <span className="text-emerald-400">
                      Unlocked Green: <strong className="text-white">{mlmSummary?.formattedUnlockedGreen || '$0.00'}</strong>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Daily Quests List */}
            <div className="space-y-3">
              {questData?.quests.map((q) => {
                const percent = Math.min(100, Math.round((q.current / q.target) * 100));
                return (
                  <div
                    key={q.questId}
                    className="bg-slate-950/90 border border-slate-800/80 hover:border-slate-700 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition shadow-sm"
                  >
                    <div className="flex items-center space-x-3.5">
                      <div className="w-10 h-10 rounded-2xl bg-slate-900 border border-slate-700/80 flex items-center justify-center shrink-0">
                        {renderQuestIcon(q.actionType)}
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <h4 className="text-xs font-black text-white">{q.title}</h4>
                          <span className="bg-amber-400/20 text-amber-300 border border-amber-500/30 text-[10px] font-black px-2 py-0.5 rounded-full">
                            +{q.rewardCoins} Coins
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400">{q.description}</p>
                      </div>
                    </div>

                    <div className="flex items-center space-x-3 self-end sm:self-center shrink-0">
                      {/* Progress Bar & Counter */}
                      <div className="flex flex-col items-end w-24">
                        <span className="text-[10px] font-mono font-bold text-slate-400">
                          {q.current} / {q.target}
                        </span>
                        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              q.isCompleted ? 'bg-emerald-400' : 'bg-rose-500'
                            }`}
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>

                      {/* Claim or Status Action Button */}
                      {q.isClaimed ? (
                        <button
                          disabled
                          className="bg-slate-800 text-slate-500 text-xs font-bold px-3 py-1.5 rounded-xl cursor-default"
                        >
                          CLAIMED ✓
                        </button>
                      ) : q.isCompleted ? (
                        <button
                          onClick={() => handleClaimQuest(q.questId)}
                          disabled={claimingQuestId === q.questId}
                          className="bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-slate-950 font-black text-xs px-3.5 py-1.5 rounded-xl shadow-md shadow-emerald-500/30 active:scale-95 transition"
                        >
                          {claimingQuestId === q.questId ? 'CLAIMING...' : 'CLAIM'}
                        </button>
                      ) : q.questId === 'Q_DAILY_CHECKIN' ? (
                        <button
                          onClick={handleCheckin}
                          className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs px-3.5 py-1.5 rounded-xl shadow-md transition active:scale-95"
                        >
                          CHECK IN
                        </button>
                      ) : q.questId === 'Q_SPECTATE' ? (
                        <Link
                          href="/game?mode=spectator"
                          className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-3 py-1.5 rounded-xl shadow-sm transition"
                        >
                          SPECTATE
                        </Link>
                      ) : (
                        <Link
                          href="/game"
                          className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs px-3 py-1.5 rounded-xl border border-slate-700 transition"
                        >
                          DO QUEST
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Arena Mode Selection Modal (`FIGHT` action centerpiece) */}
      {isFightModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-4xl w-full p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <FightEmblemIcon size={28} />
                <h3 className="text-xl font-black text-white">SELECT ARENA COMBAT MODE</h3>
              </div>
              <button
                onClick={() => setIsFightModalOpen(false)}
                className="text-slate-400 hover:text-white text-2xl font-bold p-1"
              >
                ✕
              </button>
            </div>

            {/* Arena Mode Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 30-Player Skirmish */}
              <Link
                href="/game?mode=mini_30"
                onClick={() => setIsFightModalOpen(false)}
                className="group relative rounded-2xl overflow-hidden border border-slate-700 hover:border-sky-400 transition transform hover:-translate-y-1 shadow-lg"
              >
                <img src="/images/mode_mini30.svg" alt="30-Player Skirmish" className="w-full h-auto object-cover" />
              </Link>

              {/* 100-Player Warzone */}
              <Link
                href="/game?mode=standard_100"
                onClick={() => setIsFightModalOpen(false)}
                className="group relative rounded-2xl overflow-hidden border border-slate-700 hover:border-rose-400 transition transform hover:-translate-y-1 shadow-lg"
              >
                <img src="/images/mode_standard100.svg" alt="100-Player Warzone" className="w-full h-auto object-cover" />
              </Link>

              {/* Fast & Mini Mode */}
              <Link
                href="/game?mode=fast_mini"
                onClick={() => setIsFightModalOpen(false)}
                className="group relative rounded-2xl overflow-hidden border border-slate-700 hover:border-purple-400 transition transform hover:-translate-y-1 shadow-lg"
              >
                <img src="/images/mode_fast.svg" alt="Fast & Mini Mode" className="w-full h-auto object-cover" />
              </Link>

              {/* Practice Range */}
              <Link
                href="/game?mode=practice"
                onClick={() => setIsFightModalOpen(false)}
                className="group relative rounded-2xl overflow-hidden border border-slate-700 hover:border-emerald-400 transition transform hover:-translate-y-1 shadow-lg"
              >
                <img src="/images/mode_practice.svg" alt="Practice Range" className="w-full h-auto object-cover" />
              </Link>
            </div>

            {/* Ghost Spectator Mode Banner */}
            <div className="bg-gradient-to-r from-indigo-950 via-slate-900 to-slate-950 p-4 rounded-2xl border border-indigo-500/40 flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <GhostSpectatorIcon size={32} />
                <div>
                  <h4 className="text-sm font-black text-indigo-300">GHOST SPECTATOR MODE</h4>
                  <p className="text-xs text-slate-400">
                    Spectate live combat matches freely for 90 seconds to complete daily quest Q_SPECTATE!
                  </p>
                </div>
              </div>
              <Link
                href="/game?mode=spectator"
                onClick={() => setIsFightModalOpen(false)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-black px-4 py-2 rounded-xl text-xs transition"
              >
                SPECTATE MATCH
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* 4. Story / Reels Preview Modal */}
      {isStoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <StoryReelIcon size={24} />
                <h3 className="text-lg font-black text-white">MWAR STORY REELS</h3>
              </div>
              <button
                onClick={() => setIsStoryModalOpen(false)}
                className="text-slate-400 hover:text-white text-2xl font-bold p-1"
              >
                ✕
              </button>
            </div>

            <div className="relative rounded-2xl overflow-hidden bg-slate-950 aspect-[9/14] border border-slate-800 flex flex-col justify-end p-5">
              <img
                src="/images/hero_backdrop.svg"
                alt="Story Reel"
                className="absolute inset-0 w-full h-full object-cover opacity-60"
              />
              <div className="relative z-10 space-y-2 bg-gradient-to-t from-slate-950 via-slate-950/80 to-transparent p-4 rounded-2xl">
                <div className="flex items-center space-x-2">
                  <span className="bg-rose-600 text-white text-[10px] font-black px-2 py-0.5 rounded-full">
                    LIVE BOUNTY
                  </span>
                  <span className="text-xs font-bold text-amber-300">Commander Phantom Sniper</span>
                </div>
                <h4 className="text-sm font-black text-white">
                  Triple Kill at Urban Depot • 15s Gold Chest Claimed (+500 Coins)
                </h4>
                <p className="text-[11px] text-slate-400">
                  Watched by 142 squad members in 5-level downline.
                </p>
              </div>
            </div>

            <button
              onClick={() => setIsStoryModalOpen(false)}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold py-2.5 rounded-xl text-xs transition"
            >
              CLOSE STORY
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
