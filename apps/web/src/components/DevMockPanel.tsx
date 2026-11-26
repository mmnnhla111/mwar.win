'use client';

import React, { useState } from 'react';
import { apiFetch, setAuthToken } from '../lib/api';
import { DEV_MOCK_OTP, DEV_MOCK_PHONE, DEV_MOCK_TELEGRAM_ID } from '@mwar/shared';

interface DevMockPanelProps {
  onAuthSuccess?: () => void;
  onRefreshData?: () => void;
}

export function DevMockPanel({ onAuthSuccess, onRefreshData }: DevMockPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'wa' | 'tg' | 'ads' | 'ai' | 'quests'>('quests');

  // WhatsApp State
  const [phone, setPhone] = useState(DEV_MOCK_PHONE);
  const [otp, setOtp] = useState(DEV_MOCK_OTP);
  const [waStatus, setWaStatus] = useState<string>('');

  // Ad State
  const [country, setCountry] = useState<'US' | 'TH' | 'EU' | 'OTHER'>('US');
  const [adProvider, setAdProvider] = useState<'adswedmedia' | 'onclicka'>('adswedmedia');
  const [adStatus, setAdStatus] = useState<string>('');

  // AI & Faucet State
  const [faucetStatus, setFaucetStatus] = useState<string>('');
  const [aiStatus, setAiStatus] = useState<string>('');

  // Quests & MLM Settlement State
  const [questStatus, setQuestStatus] = useState<string>('');
  const [settleStatus, setSettleStatus] = useState<string>('');

  // 1. WhatsApp OTP Handlers
  const handleRequestOtp = async () => {
    try {
      setWaStatus('Requesting OTP...');
      const res = await apiFetch('/api/auth/whatsapp/request-otp', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber: phone }),
      });
      setWaStatus(`OTP sent! Server terminal printed code: ${res.devMockOtp || '123456'}`);
    } catch (err: any) {
      setWaStatus(`Error: ${err.message}`);
    }
  };

  const handleVerifyOtp = async () => {
    try {
      setWaStatus('Verifying OTP...');
      const res = await apiFetch('/api/auth/whatsapp/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber: phone, code: otp }),
      });
      if (res.token) {
        setAuthToken(res.token);
        setWaStatus(`Logged in as: ${res.user.username}`);
        onAuthSuccess?.();
      }
    } catch (err: any) {
      setWaStatus(`Error: ${err.message}`);
    }
  };

  // 2. Telegram Login Handler
  const handleTelegramMockLogin = async () => {
    try {
      const runId = Math.random().toString(36).substring(2, 6);
      const res = await apiFetch('/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          id: DEV_MOCK_TELEGRAM_ID,
          first_name: 'DevShooter',
          username: `tg_player_${runId}`,
          auth_date: Math.floor(Date.now() / 1000),
          hash: 'mock_dev_hash',
        }),
      });
      if (res.token) {
        setAuthToken(res.token);
        alert(`Logged in via Mock Telegram! User: ${res.user.username}`);
        onAuthSuccess?.();
      }
    } catch (err: any) {
      alert(`Telegram Login Failed: ${err.message}`);
    }
  };

  // 3. Fake Ad Postback Handler
  const handleSimulateAdWatch = async () => {
    try {
      setAdStatus('Triggering S2S Postback...');
      // Get current user ID
      const me = await apiFetch('/api/auth/me');
      if (!me?.user?.id) {
        setAdStatus('Please log in first before simulating ads.');
        return;
      }
      const res = await apiFetch('/api/ads/dev/simulate-watch', {
        method: 'POST',
        body: JSON.stringify({
          userId: me.user.id,
          country,
          provider: adProvider,
        }),
      });
      setAdStatus(`Rewarded ${res.formattedReward} (${country} Tier)! 5-Level MLM distributed.`);
      onRefreshData?.();
    } catch (err: any) {
      setAdStatus(`Ad simulation failed: ${err.message}`);
    }
  };

  // 4. Dev Faucet Handler
  const handleFaucet = async () => {
    try {
      setFaucetStatus('Adding $20 USD...');
      const res = await apiFetch('/api/wallet/dev/faucet', {
        method: 'POST',
        body: JSON.stringify({ amountMicroUsd: 20_000_000 }),
      });
      setFaucetStatus(`Success! New Balance: ${res.formattedNewBalance}`);
      onRefreshData?.();
    } catch (err: any) {
      setFaucetStatus(`Faucet error: ${err.message}`);
    }
  };

  // 5. AI Audit Simulation Handler
  const handleSimulateAiAudit = async (targetState: 'approved' | 'rejected') => {
    try {
      setAiStatus('Fetching pending cashouts...');
      const pendingRes = await apiFetch('/api/audit/withdrawals?status=open');
      const pendingList = pendingRes.withdrawals || [];
      if (pendingList.length === 0) {
        setAiStatus('No pending cashouts to review. Please request a cashout first.');
        return;
      }
      const target = pendingList[0];
      await apiFetch('/api/audit/review', {
        method: 'POST',
        body: JSON.stringify({
          withdrawal_id: target.id,
          action: targetState === 'approved' ? 'approve' : 'reject',
          reason: targetState === 'approved' ? 'Dev panel: clean audit log match' : 'Dev panel: suspicious kill frequency',
        }),
      });
      setAiStatus(`Simulated ${targetState.toUpperCase()} on withdrawal ${target.id.slice(0, 8)}`);
      onRefreshData?.();
    } catch (err: any) {
      setAiStatus(`AI Review Error: ${err.message}`);
    }
  };

  // 6. Quests & Midnight Settlement Handlers
  const handleCompleteAllQuests = async () => {
    try {
      setQuestStatus('Completing 4 quests...');
      await apiFetch('/api/quests/progress', {
        method: 'POST',
        body: JSON.stringify({ questId: 'Q_DAILY_CHECKIN', increment: 1 }),
      });
      await apiFetch('/api/quests/progress', {
        method: 'POST',
        body: JSON.stringify({ questId: 'Q_SPECTATE', increment: 90 }),
      });
      await apiFetch('/api/quests/progress', {
        method: 'POST',
        body: JSON.stringify({ questId: 'Q_PLAY_MATCH', increment: 3 }),
      });
      const res = await apiFetch('/api/quests/progress', {
        method: 'POST',
        body: JSON.stringify({ questId: 'Q_WATCH_AD', increment: 2 }),
      });
      setQuestStatus(`All quests complete! MLM Status: ${res.isMlmUnlocked ? 'UNLOCKED (GREEN) 🎉' : 'Pending'}`);
      onRefreshData?.();
    } catch (err: any) {
      setQuestStatus(`Error: ${err.message}`);
    }
  };

  const handleTriggerMidnightSettlement = async () => {
    try {
      setSettleStatus('Settling daily MLM ledger...');
      const res = await apiFetch('/api/cron/settle-daily-mlm', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSettleStatus(`Settled ${res.settledUsersCount} user(s) (${res.formattedSettled}). Forfeited ${res.forfeitedUsersCount} user(s) (${res.formattedForfeited}).`);
      onRefreshData?.();
    } catch (err: any) {
      setSettleStatus(`Settlement Error: ${err.message}`);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {!isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold px-4 py-2 rounded-full shadow-lg border border-yellow-300 flex items-center space-x-2 transition-all transform hover:scale-105"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping mr-1"></span>
          <span>🛠️ DEV MOCK PANEL</span>
        </button>
      ) : (
        <div className="bg-gray-900 text-white w-96 rounded-xl border border-yellow-500/50 shadow-2xl p-4 font-sans text-sm backdrop-blur-md">
          <div className="flex justify-between items-center pb-2 border-b border-gray-800 mb-3">
            <span className="font-bold text-yellow-400 flex items-center">
              🛠️ DEV SIMULATION TOOLS
            </span>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-white px-2 py-1 rounded bg-gray-800 text-xs"
            >
              Close
            </button>
          </div>

          {/* Navigation Tabs */}
          <div className="grid grid-cols-5 gap-1 mb-3 bg-gray-800 p-1 rounded-lg text-[10px] font-semibold">
            <button
              onClick={() => setActiveTab('quests')}
              className={`py-1 rounded text-center ${activeTab === 'quests' ? 'bg-yellow-500 text-black font-bold' : 'text-gray-300'}`}
            >
              Quests
            </button>
            <button
              onClick={() => setActiveTab('ads')}
              className={`py-1 rounded text-center ${activeTab === 'ads' ? 'bg-yellow-500 text-black font-bold' : 'text-gray-300'}`}
            >
              S2S Ads
            </button>
            <button
              onClick={() => setActiveTab('wa')}
              className={`py-1 rounded text-center ${activeTab === 'wa' ? 'bg-yellow-500 text-black font-bold' : 'text-gray-300'}`}
            >
              WhatsApp
            </button>
            <button
              onClick={() => setActiveTab('tg')}
              className={`py-1 rounded text-center ${activeTab === 'tg' ? 'bg-yellow-500 text-black font-bold' : 'text-gray-300'}`}
            >
              Telegram
            </button>
            <button
              onClick={() => setActiveTab('ai')}
              className={`py-1 rounded text-center ${activeTab === 'ai' ? 'bg-yellow-500 text-black font-bold' : 'text-gray-300'}`}
            >
              AI/Cash
            </button>
          </div>

          {/* Tab 0: Quests & Daily MLM Settlement */}
          {activeTab === 'quests' && (
            <div className="space-y-3">
              <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-700 space-y-2">
                <span className="text-[11px] font-bold text-amber-400 block">Instant Proof-of-Activity:</span>
                <p className="text-[10px] text-gray-400">
                  Instantly marks 4 quests completed (Check-in, Spectate 90s, Play Match, Watch Ad) to test Grey-to-Green MLM unlocking.
                </p>
                <button
                  onClick={handleCompleteAllQuests}
                  className="w-full bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-black py-1.5 rounded-lg text-xs shadow-md transition"
                >
                  ⚡ Complete 4 Quests (Unlock MLM)
                </button>
                {questStatus && <div className="text-[10px] text-emerald-300 font-mono">{questStatus}</div>}
              </div>

              <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-700 space-y-2">
                <span className="text-[11px] font-bold text-rose-400 block">Midnight MLM Settlement Cron:</span>
                <p className="text-[10px] text-gray-400">
                  Triggers daily settlement: Unlocked (Green) commissions are paid to wallet balances; Incomplete (Grey) commissions are burned as forfeited.
                </p>
                <button
                  onClick={handleTriggerMidnightSettlement}
                  className="w-full bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 text-white font-black py-1.5 rounded-lg text-xs shadow-md transition"
                >
                  🕛 Trigger Midnight MLM Settlement
                </button>
                {settleStatus && <div className="text-[10px] text-amber-300 font-mono">{settleStatus}</div>}
              </div>
            </div>
          )}

          {/* Tab 1: WhatsApp OTP */}
          {activeTab === 'wa' && (
            <div className="space-y-2">
              <label className="text-xs text-gray-400">Phone Number (E.164):</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
              />
              <div className="flex space-x-2">
                <button
                  onClick={handleRequestOtp}
                  className="flex-1 bg-green-600 hover:bg-green-500 text-white font-semibold py-1 rounded text-xs"
                >
                  Send OTP (Terminal)
                </button>
              </div>

              <label className="text-xs text-gray-400 mt-2 block">OTP Code (Dev Mode: 123456):</label>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono"
              />
              <button
                onClick={handleVerifyOtp}
                className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-1.5 rounded text-xs"
              >
                Verify & Login
              </button>
              {waStatus && <div className="text-xs text-yellow-300 mt-1">{waStatus}</div>}
            </div>
          )}

          {/* Tab 2: Telegram Mock */}
          {activeTab === 'tg' && (
            <div className="space-y-3">
              <p className="text-xs text-gray-300">
                Simulates official Telegram Login Widget returning verified User ID and Phone without Telegram Bot setup.
              </p>
              <button
                onClick={handleTelegramMockLogin}
                className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-2 rounded text-xs flex items-center justify-center space-x-2"
              >
                <span>✈️ Mock Telegram Login</span>
              </button>
            </div>
          )}

          {/* Tab 3: S2S Ad Postbacks */}
          {activeTab === 'ads' && (
            <div className="space-y-2">
              <label className="text-xs text-gray-400">Country Tier (Reward Rate):</label>
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value as any)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
              >
                <option value="US">US Tier ($0.05 / 500 Coins)</option>
                <option value="TH">TH Tier ($0.01 / 100 Coins)</option>
                <option value="EU">EU Tier ($0.03 / 300 Coins)</option>
                <option value="OTHER">Other ($0.005 / 50 Coins)</option>
              </select>

              <label className="text-xs text-gray-400">Ad Network Provider:</label>
              <select
                value={adProvider}
                onChange={(e) => setAdProvider(e.target.value as any)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
              >
                <option value="adswedmedia">AdswedMedia S2S</option>
                <option value="onclicka">OnClickA S2S</option>
              </select>

              <button
                onClick={handleSimulateAdWatch}
                className="w-full bg-purple-600 hover:bg-purple-500 text-white font-bold py-1.5 rounded text-xs mt-2"
              >
                🎬 Trigger Fake Ad Postback
              </button>
              {adStatus && <div className="text-xs text-green-300 mt-1">{adStatus}</div>}
            </div>
          )}

          {/* Tab 4: AI Audit & Faucet */}
          {activeTab === 'ai' && (
            <div className="space-y-2">
              <button
                onClick={handleFaucet}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 rounded text-xs"
              >
                💰 Faucet: Add $20 USD Test Coins
              </button>
              {faucetStatus && <div className="text-xs text-emerald-300">{faucetStatus}</div>}

              <div className="border-t border-gray-800 pt-2 mt-2">
                <span className="text-xs text-gray-400 block mb-1">AI Cashout Review Simulation:</span>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleSimulateAiAudit('approved')}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-1 rounded text-xs"
                  >
                    AI Approve (0.99)
                  </button>
                  <button
                    onClick={() => handleSimulateAiAudit('rejected')}
                    className="flex-1 bg-red-600 hover:bg-red-500 text-white font-semibold py-1 rounded text-xs"
                  >
                    AI Reject & Refund
                  </button>
                </div>
                {aiStatus && <div className="text-xs text-cyan-300 mt-1">{aiStatus}</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
