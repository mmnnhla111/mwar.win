'use client';

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  EnergyTicketIcon,
  GoldCoinIcon,
  UsdDollarIcon,
  NetworkTreeIcon,
  LockGreyIcon,
  UnlockGreenIcon,
} from './icons';
import { getCurrentUser, getDailyMlmSummary, updateProfile } from '../lib/api';
import type { DailyMlmSummary } from '@mwar/shared';
import { useVisibleInterval } from '../lib/useVisibleInterval';

const AVATAR_PRESETS = [
  '/images/avatar_1.svg',
  '/images/avatar_2.svg',
  '/images/avatar_3.svg',
  '/images/avatar_4.svg',
];

const RANK_BADGES: Record<string, string> = {
  Bronze: '/images/rank_bronze.svg',
  Silver: '/images/rank_silver.svg',
  Gold: '/images/rank_gold.svg',
  Diamond: '/images/rank_diamond.svg',
  Legendary: '/images/rank_legendary.svg',
};

export function TopResourceHud() {
  const [userData, setUserData] = useState<any>(null);
  const [walletData, setWalletData] = useState<any>(null);
  const [mlmSummary, setMlmSummary] = useState<DailyMlmSummary | null>(null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('');
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadHudData = async () => {
    try {
      const userRes = await getCurrentUser();
      setUserData(userRes.user);
      setWalletData(userRes.wallet);
      setNewUsername(userRes.user?.username || '');
      setSelectedAvatar(userRes.user?.avatar_url || '/images/avatar_1.svg');

      const mlmRes = await getDailyMlmSummary();
      setMlmSummary(mlmRes);
    } catch {
      // User not logged in or token expired
    }
  };

  useEffect(() => {
    loadHudData();
  }, []);
  // Wallet / EC / MLM summary: every 60 s, only while the tab is visible
  useVisibleInterval(loadHudData, 60_000);

  const handleAvatarFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 512 * 1024) {
      setProfileError(`File too large! Max allowed size is 512 KB (Current: ${(file.size / 1024).toFixed(1)} KB)`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setSelectedAvatar(reader.result as string);
      setProfileError('');
    };
    reader.readAsDataURL(file);
  };

  const handleSaveProfile = async () => {
    setProfileError('');
    setProfileSuccess('');
    setIsSaving(true);
    try {
      const res = await updateProfile({
        username: newUsername !== userData?.username ? newUsername : undefined,
        avatarUrl: selectedAvatar,
      });
      if (res.success) {
        setProfileSuccess('Profile updated successfully!');
        setUserData((prev: any) => ({ ...prev, ...res.user }));
        setTimeout(() => setIsProfileModalOpen(false), 800);
      }
    } catch (err: any) {
      setProfileError(err.message || 'Failed to update profile');
    } finally {
      setIsSaving(false);
    }
  };

  if (!userData) {
    return (
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 shadow-md">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center space-x-2">
            <span className="text-2xl font-black tracking-wider text-rose-500">
              M<span className="text-white">WAR</span>.WIN
            </span>
            <span className="text-[10px] bg-rose-500/20 text-rose-400 font-extrabold px-2 py-0.5 rounded-full border border-rose-500/30">
              CASUAL SHOOTER
            </span>
          </Link>
          <div className="flex items-center space-x-3">
            <Link
              href="/"
              className="bg-rose-600 hover:bg-rose-500 text-white font-extrabold px-4 py-2 rounded-xl text-xs sm:text-sm shadow-lg shadow-rose-600/30 transition active:scale-95"
            >
              SIGN IN / PLAY
            </Link>
          </div>
        </div>
      </header>
    );
  }

  const rankBadgeImg = RANK_BADGES[userData.rank_badge || 'Gold'] || RANK_BADGES['Gold'];
  const energyPercent = Math.min(100, Math.round(((userData.energy_tickets || 0) / (userData.max_energy_tickets || 6)) * 100));

  return (
    <>
      <header className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur-lg border-b border-slate-800/80 shadow-xl">
        <div className="max-w-7xl mx-auto px-2 sm:px-4 h-16 flex items-center justify-between gap-2 overflow-x-auto no-scrollbar">
          {/* 1. Left: Brand & Player Profile Badge */}
          <div className="flex items-center space-x-2 sm:space-x-3 shrink-0">
            <Link href="/" className="hidden lg:flex items-center space-x-1.5 mr-1">
              <span className="text-xl font-black tracking-wider text-rose-500">
                M<span className="text-white">WAR</span>
              </span>
            </Link>

            {/* Profile Badge Pill */}
            <button
              onClick={() => setIsProfileModalOpen(true)}
              className="flex items-center space-x-2 bg-slate-900/90 hover:bg-slate-800/90 border border-slate-700/60 hover:border-slate-500/80 rounded-2xl p-1 sm:pr-3 transition shadow-inner group"
              title="Click to view & edit profile"
            >
              <div className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl overflow-hidden bg-slate-800 border-2 border-amber-400/80 shrink-0">
                <img
                  src={userData.avatar_url || '/images/avatar_1.svg'}
                  alt="Avatar"
                  className="w-full h-full object-cover"
                />
              </div>

              <div className="text-left hidden sm:block">
                <div className="flex items-center space-x-1">
                  <span className="text-xs font-black text-slate-100 max-w-[100px] truncate group-hover:text-amber-300">
                    {userData.username}
                  </span>
                  <img src={rankBadgeImg} alt="Rank" className="w-4 h-4 shrink-0" />
                </div>
                <div className="text-[10px] text-slate-400 font-semibold flex items-center space-x-1">
                  <span className="text-amber-400 font-bold">{userData.rank_badge || 'Gold'}</span>
                  <span>•</span>
                  <span>Edit</span>
                </div>
              </div>
            </button>
          </div>

          {/* 2. Center: Tactical Resource Gauges */}
          <div className="flex items-center space-x-2 sm:space-x-3 shrink-0">
            {/* Energy Ticket Gauge */}
            <div className="flex items-center space-x-1.5 bg-slate-900/90 border border-amber-500/30 px-2.5 py-1 rounded-2xl shadow-sm">
              <EnergyTicketIcon size={20} className="shrink-0 animate-pulse" />
              <div className="flex flex-col">
                <div className="flex items-center justify-between text-[11px] font-black text-amber-300">
                  <span>EC {userData.energy_tickets ?? 6}/{userData.max_energy_tickets ?? 6}</span>
                </div>
                <div className="w-14 sm:w-20 bg-slate-950 h-1.5 rounded-full overflow-hidden border border-amber-500/20">
                  <div
                    className="bg-gradient-to-r from-amber-500 to-yellow-400 h-full rounded-full transition-all duration-500"
                    style={{ width: `${energyPercent}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Network Count */}
            <Link
              href="/network"
              className="flex items-center space-x-1.5 bg-slate-900/90 hover:bg-slate-800/90 border border-sky-500/30 px-2.5 py-1.5 rounded-2xl text-xs font-black text-sky-300 transition shadow-sm"
              title="5-Level Affiliate Network"
            >
              <NetworkTreeIcon size={18} />
              <span className="hidden md:inline text-[11px] text-slate-400">Team:</span>
              <span className="text-sky-400 font-mono font-bold">{userData.downline_count || 0}</span>
            </Link>

            {/* Dual Currency Wallet */}
            <Link
              href="/wallet"
              className="flex items-center space-x-2 bg-slate-900/90 hover:bg-slate-800/90 border border-emerald-500/30 px-2.5 py-1 rounded-2xl transition shadow-sm"
              title="Wallet & Cashout"
            >
              {/* Micro-USD */}
              <div className="flex items-center space-x-1">
                <UsdDollarIcon size={18} />
                <span className="text-xs font-black text-emerald-400 font-mono">
                  {walletData?.formatted_balance || '$0.00'}
                </span>
              </div>
              <span className="text-slate-600 hidden sm:inline">|</span>
              {/* Coins */}
              <div className="hidden sm:flex items-center space-x-1">
                <GoldCoinIcon size={18} />
                <span className="text-xs font-black text-amber-400 font-mono">
                  {(((walletData?.balance_micro_usd || 0) / 100)).toLocaleString()}
                </span>
              </div>
            </Link>
          </div>

          {/* 3. Right: Daily MLM Grey-to-Green Unlock Pill & Action */}
          <div className="flex items-center space-x-2 shrink-0">
            {mlmSummary?.isUnlocked ? (
              <div
                className="flex items-center space-x-1.5 bg-gradient-to-r from-emerald-950/80 to-emerald-900/60 border border-emerald-400/80 text-emerald-300 px-3 py-1.5 rounded-2xl shadow-lg shadow-emerald-500/20 text-xs font-black animate-pulse"
                title="Daily Quests Complete! MLM commission unlocked for midnight settlement."
              >
                <UnlockGreenIcon size={16} />
                <span className="hidden sm:inline">MLM UNLOCKED:</span>
                <span className="text-white font-mono">{mlmSummary.formattedUnlockedGreen}</span>
              </div>
            ) : (
              <div
                className="flex items-center space-x-1.5 bg-slate-900/90 border border-slate-700/80 text-slate-400 px-2.5 py-1.5 rounded-2xl text-xs font-black shadow-sm"
                title="Complete >= 4 daily quests to unlock today's MLM downline earnings!"
              >
                <LockGreyIcon size={16} />
                <span className="hidden sm:inline">MLM LOCKED:</span>
                <span className="text-slate-300 font-mono">{mlmSummary?.formattedPendingGrey || '$0.00'}</span>
                <span className="text-[10px] bg-slate-800 text-amber-400 px-1.5 py-0.5 rounded-md font-bold">
                  {mlmSummary?.completedQuestsCount || 0}/4
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Profile & Avatar Customization Modal */}
      {isProfileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <img src={rankBadgeImg} alt="Rank" className="w-6 h-6" />
                <h3 className="text-lg font-black text-white">Player Profile & Rank</h3>
              </div>
              <button
                onClick={() => setIsProfileModalOpen(false)}
                className="text-slate-400 hover:text-white text-xl font-bold p-1"
              >
                ✕
              </button>
            </div>

            {profileError && (
              <div className="bg-rose-950/80 border border-rose-500/50 text-rose-300 px-3 py-2 rounded-xl text-xs font-semibold">
                {profileError}
              </div>
            )}
            {profileSuccess && (
              <div className="bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 px-3 py-2 rounded-xl text-xs font-semibold">
                {profileSuccess}
              </div>
            )}

            {/* Avatar Preview & Selection */}
            <div className="space-y-3">
              <label className="text-xs font-bold text-slate-300 block">Avatar Selection</label>
              <div className="flex items-center space-x-4">
                <div className="w-16 h-16 rounded-2xl overflow-hidden bg-slate-800 border-2 border-amber-400 shadow-md shrink-0">
                  <img src={selectedAvatar} alt="Selected Avatar" className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 space-y-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full bg-slate-800 hover:bg-slate-700 text-xs font-bold text-amber-300 px-3 py-2 rounded-xl border border-slate-700 transition"
                  >
                    Upload Custom (≤ 512 KB)
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleAvatarFileUpload}
                  />
                  <p className="text-[10px] text-slate-500">Supports PNG, JPG, WebP, SVG up to 512 KB.</p>
                </div>
              </div>

              {/* Avatar Presets */}
              <div className="grid grid-cols-4 gap-2 pt-1">
                {AVATAR_PRESETS.map((preset, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setSelectedAvatar(preset);
                      setProfileError('');
                    }}
                    className={`rounded-2xl p-1 bg-slate-800 border-2 transition ${
                      selectedAvatar === preset ? 'border-amber-400 scale-105' : 'border-transparent hover:border-slate-600'
                    }`}
                  >
                    <img src={preset} alt={`Preset ${idx + 1}`} className="w-full h-12 object-cover rounded-xl" />
                  </button>
                ))}
              </div>
            </div>

            {/* Username & Rename Counter */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-xs font-bold text-slate-300">Username</label>
                <span className="text-[11px] text-amber-400 font-bold">
                  Renames Left: {Math.max(0, 3 - (userData.rename_count || 0))} / 3
                </span>
              </div>
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                maxLength={20}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white font-bold focus:border-amber-400 focus:outline-none"
              />
              <p className="text-[10px] text-slate-500">Allowed characters: a-z, 0-9, and underscore (3-20 chars).</p>
            </div>

            {/* Rank Status Information */}
            <div className="bg-slate-950/80 rounded-2xl p-3 border border-slate-800 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">Current Rank</span>
                <span className="text-sm font-black text-amber-300">{userData.rank_badge || 'Gold'} Combatant</span>
              </div>
              <img src={rankBadgeImg} alt="Badge" className="w-10 h-10" />
            </div>

            {/* Action Buttons */}
            <div className="flex space-x-3 pt-2">
              <button
                type="button"
                onClick={() => setIsProfileModalOpen(false)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-2.5 rounded-xl text-xs transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={isSaving}
                className="flex-1 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black py-2.5 rounded-xl text-xs transition shadow-lg shadow-amber-500/20 disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
