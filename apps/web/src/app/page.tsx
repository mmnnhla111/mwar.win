'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, setAuthToken, clearAuthToken } from '../lib/api';

export default function LobbyPage() {
  const [user, setUser] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [networkStats, setNetworkStats] = useState<any>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('demo_warrior');
  const [email, setEmail] = useState('warrior@mwar.local');
  const [password, setPassword] = useState('Password123!');
  const [referrerId, setReferrerId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const loadProfile = async () => {
    try {
      const data = await apiFetch('/api/auth/me');
      setUser(data.user);
      setWallet(data.wallet);

      const stats = await apiFetch('/api/network/stats');
      setNetworkStats(stats);
      setErrorMsg('');
    } catch {
      setUser(null);
      setWallet(null);
    }
  };

  useEffect(() => {
    loadProfile();
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
          await loadProfile();
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
          await loadProfile();
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleCopyRef = () => {
    if (!user?.id) return;
    const url = `${window.location.origin}/?ref=${user.id}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8 py-4">
      {/* Hero Banner */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-red-950 via-surface to-surface border border-red-900/40 p-8 shadow-2xl">
        <div className="max-w-2xl space-y-4">
          <div className="inline-flex items-center space-x-2 bg-red-600/20 border border-red-500/40 text-red-400 px-3 py-1 rounded-full text-xs font-semibold">
            <span>🔥 AUTHORITATIVE 3D MULTIPLAYER & 5-LEVEL REVENUE SHARING</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white leading-tight">
            SURVIVE. ELIMINATE. <span className="text-red-500">EARN MICRO-USD.</span>
          </h1>
          <p className="text-gray-400 text-sm md:text-base leading-relaxed">
            Stateless Colyseus Game Engine running at 20 Hz in pure RAM. 15-second dynamic treasure chests,
            death drops, prop-hide disguises, and automated 5-level MLM commissions ($0.01 = 100 Coins).
          </p>

          <div className="pt-2 flex flex-wrap gap-4">
            <Link
              href="/game?mode=mini_30"
              className="bg-red-600 hover:bg-red-500 text-white font-black px-6 py-3 rounded-xl shadow-lg transition transform hover:-translate-y-0.5 active:translate-y-0 text-sm flex items-center space-x-2"
            >
              <span>ENTER MINI 30 (250m)</span>
              <span>⚡</span>
            </Link>
            <Link
              href="/game?mode=standard_100"
              className="bg-surfaceLight hover:bg-gray-800 text-gray-200 border border-gray-700 font-bold px-6 py-3 rounded-xl transition text-sm flex items-center space-x-2"
            >
              <span>ENTER STANDARD 100 (600m)</span>
              <span>🎯</span>
            </Link>
          </div>
        </div>
      </section>

      {/* User Dashboard / Auth Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Live User Wallet & Team Stats or Login Form */}
        <div className="lg:col-span-2 space-y-6">
          {user ? (
            <div className="bg-surface rounded-2xl border border-gray-800 p-6 space-y-6">
              <div className="flex justify-between items-center border-b border-gray-800 pb-4">
                <div>
                  <h2 className="text-xl font-black text-white">Commander {user.username}</h2>
                  <p className="text-xs text-gray-400">Account ID: {user.id}</p>
                </div>
                <button
                  onClick={() => {
                    clearAuthToken();
                    setUser(null);
                    setWallet(null);
                  }}
                  className="text-xs text-red-400 hover:text-red-300 bg-red-950/40 px-3 py-1.5 rounded-lg border border-red-900/40"
                >
                  Logout
                </button>
              </div>

              {/* Wallet Balances */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-surfaceLight p-4 rounded-xl border border-gray-700/50">
                  <span className="text-xs font-semibold text-gray-400 block mb-1">Available Balance</span>
                  <div className="text-2xl font-black text-emerald-400">{wallet?.formatted_balance || '$0.00'}</div>
                  <span className="text-xs text-gray-500 font-mono">
                    {((wallet?.balance_micro_usd || 0) / 100).toLocaleString()} Coins
                  </span>
                </div>
                <div className="bg-surfaceLight p-4 rounded-xl border border-gray-700/50">
                  <span className="text-xs font-semibold text-gray-400 block mb-1">Total Lifetime Earned</span>
                  <div className="text-2xl font-black text-accent-gold">{wallet?.formatted_total_earned || '$0.00'}</div>
                  <span className="text-xs text-gray-500">From Kills, Chests & MLM</span>
                </div>
                <div className="bg-surfaceLight p-4 rounded-xl border border-gray-700/50">
                  <span className="text-xs font-semibold text-gray-400 block mb-1">5-Level Team Members</span>
                  <div className="text-2xl font-black text-cyan-400">{networkStats?.totalTeamMembers || 0}</div>
                  <span className="text-xs text-gray-500">Across Level 1 to 5</span>
                </div>
              </div>

              {/* Referral Link Generator */}
              <div className="bg-surfaceLight/60 p-4 rounded-xl border border-gray-700/50 space-y-2">
                <label className="text-xs font-bold text-gray-300">Your 5-Level MLM Referral Link:</label>
                <div className="flex space-x-2">
                  <input
                    type="text"
                    readOnly
                    value={typeof window !== 'undefined' ? `${window.location.origin}/?ref=${user.id}` : ''}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono"
                  />
                  <button
                    onClick={handleCopyRef}
                    className="bg-red-600 hover:bg-red-500 text-white font-bold px-4 py-2 rounded-lg text-xs"
                  >
                    {copied ? 'Copied!' : 'Copy Link'}
                  </button>
                </div>
                <p className="text-[11px] text-gray-500">
                  Earn 50% on L1, 20% on L2, 15% on L3, 10% on L4, and 5% on L5 from all in-game kills, chests, and ad revenue.
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-surface rounded-2xl border border-gray-800 p-6 space-y-6">
              <div className="flex space-x-4 border-b border-gray-800 pb-3">
                <button
                  onClick={() => setAuthMode('login')}
                  className={`text-sm font-bold pb-2 border-b-2 transition ${
                    authMode === 'login' ? 'border-red-500 text-white' : 'border-transparent text-gray-400'
                  }`}
                >
                  Account Login
                </button>
                <button
                  onClick={() => setAuthMode('register')}
                  className={`text-sm font-bold pb-2 border-b-2 transition ${
                    authMode === 'register' ? 'border-red-500 text-white' : 'border-transparent text-gray-400'
                  }`}
                >
                  Create Account (with MLM Sponsor)
                </button>
              </div>

              <form onSubmit={handleAuthSubmit} className="space-y-4 max-w-md">
                {errorMsg && (
                  <div className="bg-red-950/60 border border-red-800 text-red-300 text-xs p-3 rounded-lg">
                    {errorMsg}
                  </div>
                )}

                <div>
                  <label className="text-xs font-semibold text-gray-400 block mb-1">Username / Call-sign:</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                </div>

                {authMode === 'register' && (
                  <div>
                    <label className="text-xs font-semibold text-gray-400 block mb-1">Email Address:</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                    />
                  </div>
                )}

                <div>
                  <label className="text-xs font-semibold text-gray-400 block mb-1">Password:</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                </div>

                {authMode === 'register' && (
                  <div>
                    <label className="text-xs font-semibold text-gray-400 block mb-1">
                      Referrer Sponsor ID (Optional):
                    </label>
                    <input
                      type="text"
                      value={referrerId}
                      onChange={(e) => setReferrerId(e.target.value)}
                      placeholder="UUID of Upline Sponsor"
                      className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-red-600 hover:bg-red-500 text-white font-black py-2.5 rounded-xl text-sm shadow-md transition"
                >
                  {authMode === 'login' ? 'SIGN IN' : 'REGISTER & JOIN MLM TREE'}
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Right Col: Quick Room Matchmaking Cards */}
        <div className="space-y-4">
          <h3 className="text-sm font-black text-gray-300 uppercase tracking-wider">AVAILABLE REAL-TIME ARENAS</h3>

          {/* Mini 30 Card */}
          <div className="bg-surface rounded-2xl border border-gray-800 p-5 space-y-3 hover:border-red-500/50 transition">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold bg-green-500/20 text-green-400 px-2 py-0.5 rounded border border-green-500/30">
                  FAST PACED
                </span>
                <h4 className="text-base font-black text-white mt-1">Mini Outpost (30 Players)</h4>
              </div>
              <span className="text-xs text-gray-400 font-mono">250m x 250m</span>
            </div>
            <p className="text-xs text-gray-400">
              Close quarters combat with 8-12 buildings. High frequency 15s chest spawns and instant kill bounties.
            </p>
            <Link
              href="/game?mode=mini_30"
              className="block text-center w-full bg-red-600 hover:bg-red-500 text-white font-bold py-2 rounded-lg text-xs"
            >
              DEPLOY TO OUTPOST
            </Link>
          </div>

          {/* Standard 100 Card */}
          <div className="bg-surface rounded-2xl border border-gray-800 p-5 space-y-3 hover:border-red-500/50 transition">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded border border-blue-500/30">
                  TACTICAL SURVIVAL
                </span>
                <h4 className="text-base font-black text-white mt-1">Tactical City (100 Players)</h4>
              </div>
              <span className="text-xs text-gray-400 font-mono">600m x 600m</span>
            </div>
            <p className="text-xs text-gray-400">
              Expansive warzone with 40-60 buildings, sniper towers, and deep foliage concealment zones.
            </p>
            <Link
              href="/game?mode=standard_100"
              className="block text-center w-full bg-surfaceLight hover:bg-gray-800 text-gray-200 border border-gray-700 font-bold py-2 rounded-lg text-xs"
            >
              DEPLOY TO CITY
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
