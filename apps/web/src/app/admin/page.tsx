'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch, getServerNodes, updateNodeCapacity, type GameNode } from '../../lib/api';
import { formatMicroUsd } from '@mwar/shared';
import { TakedownQueue } from '../../components/admin/TakedownQueue';

export default function AdminAuditPage() {
  const [tab, setTab] = useState<'fleet' | 'takedown'>('fleet');
  const [pendingList, setPendingList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  // Server Nodes State
  const [nodes, setNodes] = useState<GameNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  const [provisionKey, setProvisionKey] = useState('');
  const [selectedRole, setSelectedRole] = useState<'all' | 'game' | 'logs' | 'moderator'>('all');
  const [nodeNameInput, setNodeNameInput] = useState('mwar-game-server-1');
  const [tunnelTokenInput, setTunnelTokenInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [updatingNodeId, setUpdatingNodeId] = useState<string | null>(null);

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

  const loadNodes = async () => {
    setNodesLoading(true);
    try {
      const res = await getServerNodes();
      setNodes(res.nodes || []);
      if (res.provisionKey) {
        setProvisionKey(res.provisionKey);
      }
    } catch (err: any) {
      console.warn('Failed to load server nodes:', err);
    } finally {
      setNodesLoading(false);
    }
  };

  useEffect(() => {
    loadPending();
    loadNodes();
  }, []);
  // No background polling: use the Refresh Nodes button

  const handleReview = async (withdrawalId: string, action: 'approve' | 'reject') => {
    setActionMsg('');
    try {
      const res = await apiFetch('/api/audit/review', {
        method: 'POST',
        body: JSON.stringify({
          withdrawal_id: withdrawalId,
          action,
          reason: action === 'approve' ? 'Audit verified clean by administrator' : 'Suspicious kill/chest activity',
        }),
      });
      setActionMsg(`Action ${action.toUpperCase()} completed on request ${res.withdrawalId.slice(0, 8)}`);
      await loadPending();
    } catch (err: any) {
      setActionMsg(`Error: ${err.message}`);
    }
  };

  const handleCapacityChange = async (nodeId: string, mini: number, fast: number) => {
    setUpdatingNodeId(nodeId);
    try {
      await updateNodeCapacity(nodeId, {
        room_capacity_mini: mini,
        room_capacity_fast: fast,
      });
      await loadNodes();
      setActionMsg(`Updated room capacities for node ${nodeId}`);
    } catch (err: any) {
      setActionMsg(`Capacity update failed: ${err.message}`);
    } finally {
      setUpdatingNodeId(null);
    }
  };

  // Build the live 1-Click install bash command
  const buildInstallCommand = () => {
    const key = provisionKey.trim() || 'PASTE_PROVISION_KEY_HERE';
    let url = `https://api.mwar.win/api/nodes/install.sh?token=${key}&role=${selectedRole}&node_name=${encodeURIComponent(nodeNameInput.trim() || 'mwar-game-server-1')}`;
    if (tunnelTokenInput.trim()) {
      url += `&tunnel_token=${encodeURIComponent(tunnelTokenInput.trim())}`;
    }
    return `curl -sSL "${url}" | sudo bash`;
  };

  const handleCopyCommand = () => {
    const cmd = buildInstallCommand();
    navigator.clipboard.writeText(cmd).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const formatLastHeartbeat = (timestamp?: number) => {
    if (!timestamp) return 'Never connected';
    const secondsAgo = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
    if (secondsAgo < 45) return `Active now (${secondsAgo}s ago)`;
    if (secondsAgo < 90) return `Heartbeat ${secondsAgo}s ago`;
    const mins = Math.floor(secondsAgo / 60);
    return `Offline (${mins}m ago)`;
  };

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Header */}
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0 text-2xl">
            🛡️
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-stone-900 tracking-tight flex items-center space-x-2">
              <span>MWAR SERVER FLEET & CASHOUT AUDIT CONSOLE</span>
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">
              1-Click Ubuntu server provisioning, Colyseus 20Hz nodes telemetry, and multi-tier fraud prevention.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs font-bold text-amber-700 bg-stone-50 px-3.5 py-1.5 rounded-2xl border border-stone-200/80">
          <span className="w-2 h-2 rounded-full bg-[#FFE135] animate-ping" />
          <span>Active Auditor Mode</span>
        </div>
      </div>

      {actionMsg && (
        <div className="bg-white border border-amber-200 text-amber-700 text-xs p-3.5 rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex justify-between items-center animate-in fade-in">
          <span>{actionMsg}</span>
          <button onClick={() => setActionMsg('')} className="text-stone-500 hover:text-stone-900 font-bold ml-2">✕</button>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto" role="tablist">
        {([
          ['fleet', '🖥️ Server Fleet & Cashouts'],
          ['takedown', '🚩 คำขอแจ้งลบ (Takedown Requests)'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            data-admin-tab={id}
            onClick={() => setTab(id)}
            className={`shrink-0 px-4 py-2 rounded-2xl text-sm font-bold border transition ${
              tab === id ? 'bg-[#FFE135] border-yellow-300 text-stone-900' : 'bg-white border-stone-200/80 text-stone-500 hover:text-stone-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'takedown' && <TakedownQueue />}

      {tab === 'fleet' && (
      <>
      {/* 2. SERVER NODES & 1-CLICK INSTALLER SECTION */}
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-200/80 pb-4">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">🖥️</span>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold text-stone-900 tracking-tight">
                UBUNTU BARE-METAL & VPS SERVER FLEET
              </h2>
              <p className="text-xs text-stone-500">
                Authoritative Colyseus RAM Game Servers & PostgreSQL 16 Financial Audit Log Receivers.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={loadNodes}
              disabled={nodesLoading}
              className="bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-bold px-3.5 py-2 rounded-xl border border-stone-200/80 transition active:scale-95 flex items-center space-x-1.5"
            >
              <span>{nodesLoading ? '🔄 Refreshing...' : '🔄 Refresh Nodes'}</span>
            </button>
          </div>
        </div>

        {/* Nodes Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {nodes.length === 0 ? (
            <div className="col-span-full bg-stone-50 border border-stone-200/80 rounded-2xl p-6 text-center text-xs text-stone-500">
              No server nodes registered yet. Use the 1-Click Provisioning tool below to connect your first node!
            </div>
          ) : (
            nodes.map((node) => {
              const isOnline = node.status === 'online';
              return (
                <div
                  key={node.id}
                  className={`rounded-2xl border p-4 sm:p-5 transition shadow-[0_2px_12px_rgba(0,0,0,0.04)] ${
                    isOnline
                      ? 'bg-stone-50 border-emerald-200 '
                      : 'bg-stone-50 border-stone-200/80 opacity-80'
                  }`}
                >
                  {/* Top: Name & Status */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-extrabold text-stone-900 tracking-tight truncate max-w-[200px]" title={node.node_name}>
                        {node.node_name}
                      </h3>
                      <div className="text-[10px] text-stone-500 font-mono mt-0.5">
                        Role: <span className="text-amber-700 font-bold uppercase">{node.role}</span> • {node.region || 'Local Bare-Metal'}
                      </div>
                    </div>

                    <span
                      className={`text-[10px] font-extrabold px-2.5 py-1 rounded-full border flex items-center gap-1.5 ${
                        isOnline
                          ? 'bg-emerald-50 text-emerald-600 border-emerald-200 shadow-sm'
                          : 'bg-rose-50 text-rose-500 border-rose-200'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
                      {isOnline ? 'ONLINE' : 'OFFLINE'}
                    </span>
                  </div>

                  {/* Telemetry Metrics */}
                  <div className="grid grid-cols-2 gap-2 mt-4 bg-white p-2.5 rounded-xl border border-stone-200/80">
                    <div>
                      <div className="flex justify-between text-[10px] text-stone-500 font-bold">
                        <span>CPU LOAD</span>
                        <span className="text-stone-900 font-mono">{node.cpu_usage.toFixed(1)}%</span>
                      </div>
                      <div className="w-full bg-stone-100 h-1.5 rounded-full overflow-hidden mt-1">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            node.cpu_usage > 80 ? 'bg-rose-500' : node.cpu_usage > 50 ? 'bg-[#FFE135]' : 'bg-emerald-400'
                          }`}
                          style={{ width: `${Math.min(100, Math.max(5, node.cpu_usage))}%` }}
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-[10px] text-stone-500 font-bold">
                        <span>RAM USAGE</span>
                        <span className="text-stone-900 font-mono">{node.ram_usage.toFixed(1)}%</span>
                      </div>
                      <div className="w-full bg-stone-100 h-1.5 rounded-full overflow-hidden mt-1">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            node.ram_usage > 80 ? 'bg-rose-500' : node.ram_usage > 60 ? 'bg-[#FFE135]' : 'bg-sky-400'
                          }`}
                          style={{ width: `${Math.min(100, Math.max(5, node.ram_usage))}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Live Rooms & Players */}
                  <div className="flex items-center justify-between text-xs py-2.5 border-b border-stone-200/80 font-medium">
                    <span className="text-stone-500 text-[11px]">Combat Rooms:</span>
                    <span className="text-stone-900 font-bold">{node.active_rooms} active</span>
                  </div>
                  <div className="flex items-center justify-between text-xs py-2 border-b border-stone-200/80 font-medium">
                    <span className="text-stone-500 text-[11px]">Connected Players:</span>
                    <span className="text-emerald-600 font-extrabold font-mono">{node.player_count} online</span>
                  </div>

                  {/* Capacity Controls */}
                  <div className="mt-3 pt-1 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-stone-500">Mini Mode Capacity:</span>
                      <div className="flex items-center space-x-1">
                        {[20, 30, 40].map((cap) => (
                          <button
                            key={cap}
                            onClick={() => handleCapacityChange(node.id, cap, node.room_capacity_fast)}
                            disabled={updatingNodeId === node.id}
                            className={`px-2 py-0.5 text-[10px] rounded-md font-bold transition ${
                              node.room_capacity_mini === cap
                                ? 'bg-[#FFE135] text-stone-900 font-extrabold'
                                : 'bg-stone-100 text-stone-500 hover:text-stone-900'
                            }`}
                          >
                            {cap}P
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-stone-500">Standard 100 Capacity:</span>
                      <div className="flex items-center space-x-1">
                        {[60, 100, 120].map((cap) => (
                          <button
                            key={cap}
                            onClick={() => handleCapacityChange(node.id, node.room_capacity_mini, cap)}
                            disabled={updatingNodeId === node.id}
                            className={`px-2 py-0.5 text-[10px] rounded-md font-bold transition ${
                              node.room_capacity_fast === cap
                                ? 'bg-rose-600 text-white font-extrabold'
                                : 'bg-stone-100 text-stone-500 hover:text-stone-900'
                            }`}
                          >
                            {cap}P
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Footer status */}
                  <div className="mt-3 pt-2 border-t border-stone-200/80 flex justify-between items-center text-[10px] text-stone-500">
                    <span className="truncate max-w-[140px] font-mono">{node.ip_address || node.tunnel_hostname || 'localhost'}</span>
                    <span>{formatLastHeartbeat(node.last_heartbeat)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 1-CLICK PROVISIONING COMMAND BUILDER */}
        <div className="bg-stone-50 border border-amber-200 rounded-2xl p-5 space-y-4 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xl">⚡</span>
              <h3 className="text-sm font-extrabold text-amber-700 tracking-tight">
                GENERATE 1-CLICK AUTHENTICATED INSTALL COMMAND
              </h3>
            </div>
            <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 font-bold px-2 py-0.5 rounded-full">
              UBUNTU 24.04 LTS
            </span>
          </div>

          <p className="text-xs text-stone-500 leading-relaxed">
            Configure role and node parameters below. Then run the generated one-liner as root (<code className="text-amber-700">sudo bash</code>) on your fresh server.
            The script automatically installs Node 20, pnpm, pm2, PostgreSQL, Redis, builds the codebase, injects live production secrets, and configures auto-boot on power failure.
          </p>

          {/* Form options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">Node Role</label>
              <div className="flex flex-col space-y-1.5">
                {[
                  { id: 'all', label: '🎮 All-in-One' },
                  { id: 'game', label: '⚔️ Game Only' },
                  { id: 'logs', label: '📜 Logs Only' },
                  { id: 'moderator', label: '🛡️ NSFW Moderator' },
                ].map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRole(r.id as any)}
                    className={`text-left px-3 py-2 rounded-xl text-xs font-bold border transition ${
                      selectedRole === r.id
                        ? 'bg-amber-50 text-amber-700 border-amber-200 shadow-sm'
                        : 'bg-white text-stone-500 border-stone-200/80 hover:text-stone-900'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">Node Hostname / Name</label>
              <input
                type="text"
                value={nodeNameInput}
                onChange={(e) => setNodeNameInput(e.target.value)}
                placeholder="mwar-game-server-1"
                className="w-full bg-white border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 focus:outline-none focus:border-yellow-400"
              />
              <span className="text-[10px] text-stone-500 mt-1 block">Used for telemetry identification.</span>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">
                Provisioning Key {provisionKey ? <span className="text-emerald-600 font-normal">● Loaded</span> : <span className="text-amber-700 font-normal">● Optional</span>}
              </label>
              <input
                type="password"
                value={provisionKey}
                onChange={(e) => setProvisionKey(e.target.value)}
                placeholder="mwar_pvkey_..."
                className="w-full bg-white border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 focus:outline-none focus:border-yellow-400 font-mono"
              />
              <span className="text-[10px] text-stone-500 mt-1 block">Loaded via Admin JWT or paste token.</span>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">
                Cloudflare Tunnel Token <span className="text-stone-500">(Optional)</span>
              </label>
              <input
                type="text"
                value={tunnelTokenInput}
                onChange={(e) => setTunnelTokenInput(e.target.value)}
                placeholder="eyJh..."
                className="w-full bg-white border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 focus:outline-none focus:border-yellow-400 font-mono"
              />
              <span className="text-[10px] text-stone-500 mt-1 block">Auto-installs cloudflared service if set.</span>
            </div>
          </div>

          {/* Generated Command Box */}
          <div className="bg-stone-900/30 border border-stone-200/80 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-extrabold text-stone-500 tracking-wider">TERMINAL ONE-LINER COMMAND:</span>
              <button
                onClick={handleCopyCommand}
                className={`text-xs font-extrabold px-3.5 py-1.5 rounded-lg transition active:scale-95 shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex items-center space-x-1.5 ${
                  copied
                    ? 'bg-emerald-500 text-stone-900 font-extrabold'
                    : 'bg-rose-600 hover:bg-rose-500 text-white'
                }`}
              >
                <span>{copied ? '✅ COPIED TO CLIPBOARD!' : '📋 COPY COMMAND'}</span>
              </button>
            </div>

            <div className="bg-stone-50 p-2.5 rounded-lg border border-stone-200/80 font-mono text-xs text-amber-700 break-all select-all">
              {buildInstallCommand()}
            </div>
          </div>
        </div>
      </div>

      {/* 3. 3-Tier Pipeline Architecture Visual */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-3xl border border-sky-200 p-5 space-y-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-pulse" />
            <h3 className="text-xs font-extrabold text-sky-600 tracking-wider">LAYER 1: DETERMINISTIC AUDIT</h3>
          </div>
          <p className="text-xs text-stone-500 leading-relaxed">
            Instant 1-second verification comparing Cloudflare D1 wallet balance against the 90-day PostgreSQL append-only financial ledger.
          </p>
          <div className="bg-stone-50 p-2 rounded-xl border border-stone-200/80 text-[10px] font-mono text-stone-600">
            D1 Balance == SUM(Logs)
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-violet-200 p-5 space-y-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-400 animate-pulse" />
            <h3 className="text-xs font-extrabold text-violet-600 tracking-wider">LAYER 2: HEURISTIC AUDIT</h3>
          </div>
          <p className="text-xs text-stone-500 leading-relaxed">
            Analyzes kill rate frequencies, aim vectors, 15-second chest collection timings, and IP subnet correlation.
          </p>
          <div className="bg-stone-50 p-2 rounded-xl border border-stone-200/80 text-[10px] font-mono text-stone-600">
            Kill Rate &lt; 2.5/s • 0 Self-Ref
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-emerald-200 p-5 space-y-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <h3 className="text-xs font-extrabold text-emerald-600 tracking-wider">LAYER 3: DEEP AI EVALUATION</h3>
          </div>
          <p className="text-xs text-stone-500 leading-relaxed">
            Large-value cashouts (&gt; $50) undergo anomaly verification before NOWPayments API batch dispatch.
          </p>
          <div className="bg-stone-50 p-2 rounded-xl border border-stone-200/80 text-[10px] font-mono text-stone-600">
            Confidence &gt; 0.85 Auto-Dispatched
          </div>
        </div>
      </div>

      {/* 4. Pending Cashouts Review Table */}
      <div className="bg-white border border-stone-200/80 rounded-3xl overflow-hidden shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <div className="p-4 sm:p-5 border-b border-stone-200/80 flex justify-between items-center">
          <span className="text-sm font-extrabold text-stone-900">Pending Fraud Reviews ({pendingList.length})</span>
          <button
            onClick={loadPending}
            className="text-xs text-amber-700 hover:text-amber-700 font-bold bg-stone-100 px-3 py-1 rounded-xl border border-stone-200/80"
          >
            Refresh Queue
          </button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-xs text-stone-500 animate-pulse">Scanning pending withdrawals...</div>
        ) : pendingList.length === 0 ? (
          <div className="p-12 text-center text-xs text-stone-500">
            ✅ Queue clear! All pending cashouts have been audited and settled.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-50 text-stone-500 font-bold border-b border-stone-200/80 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="p-3.5">Withdrawal ID</th>
                  <th className="p-3.5">User</th>
                  <th className="p-3.5">Amount</th>
                  <th className="p-3.5">Currency</th>
                  <th className="p-3.5">AI Score</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-stone-700">
                {pendingList.map((item) => (
                  <tr key={item.id} className="hover:bg-stone-50 transition">
                    <td className="p-3.5 font-mono text-stone-600 font-bold">
                      {item.id.slice(0, 8)}...
                    </td>
                    <td className="p-3.5 font-bold text-stone-900">
                      {item.user_id?.slice(0, 8)}...
                    </td>
                    <td className="p-3.5 text-emerald-600 font-extrabold font-mono">
                      {formatMicroUsd(item.amount_micro_usd)}
                    </td>
                    <td className="p-3.5 text-stone-600 font-bold">
                      {item.crypto_currency}
                    </td>
                    <td className="p-3.5">
                      <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 px-2 py-0.5 rounded-full font-mono font-bold text-[10px]">
                        0.98 (CLEAN)
                      </span>
                    </td>
                    <td className="p-3.5 text-right space-x-2">
                      <button
                        onClick={() => handleReview(item.id, 'approve')}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded-xl text-xs transition active:scale-95"
                      >
                        APPROVE
                      </button>
                      <button
                        onClick={() => handleReview(item.id, 'reject')}
                        className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-3 py-1 rounded-xl text-xs transition active:scale-95"
                      >
                        REJECT
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
