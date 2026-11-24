'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch, getServerNodes, updateNodeCapacity, type GameNode } from '../../lib/api';
import { formatMicroUsd } from '@mwar/shared';
import { useVisibleInterval } from '../../lib/useVisibleInterval';

export default function AdminAuditPage() {
  const [pendingList, setPendingList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  // Server Nodes State
  const [nodes, setNodes] = useState<GameNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  const [provisionKey, setProvisionKey] = useState('mwar_pvkey_237a3e447ee673a37f79cf2ab01524a1999b0098fd1e063b');
  const [selectedRole, setSelectedRole] = useState<'all' | 'game' | 'logs'>('all');
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
  // Node telemetry: every 60 s while visible (nodes heartbeat every 180 s anyway)
  useVisibleInterval(() => loadNodes(), 60_000);

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
    const key = provisionKey || 'mwar_pvkey_237a3e447ee673a37f79cf2ab01524a1999b0098fd1e063b';
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
      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0 text-2xl">
            🛡️
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight flex items-center space-x-2">
              <span>MWAR SERVER FLEET & CASHOUT AUDIT CONSOLE</span>
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              1-Click Ubuntu server provisioning, Colyseus 20Hz nodes telemetry, and multi-tier fraud prevention.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs font-bold text-amber-400 bg-slate-950/80 px-3.5 py-1.5 rounded-2xl border border-slate-800">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
          <span>Active Auditor Mode</span>
        </div>
      </div>

      {actionMsg && (
        <div className="bg-slate-900 border border-amber-500/60 text-amber-200 text-xs p-3.5 rounded-2xl shadow-md flex justify-between items-center animate-in fade-in">
          <span>{actionMsg}</span>
          <button onClick={() => setActionMsg('')} className="text-slate-400 hover:text-white font-bold ml-2">✕</button>
        </div>
      )}

      {/* 2. SERVER NODES & 1-CLICK INSTALLER SECTION */}
      <div className="bg-slate-900/95 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-2xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">🖥️</span>
            <div>
              <h2 className="text-base sm:text-lg font-black text-white tracking-tight">
                UBUNTU BARE-METAL & VPS SERVER FLEET
              </h2>
              <p className="text-xs text-slate-400">
                Authoritative Colyseus RAM Game Servers & PostgreSQL 16 Financial Audit Log Receivers.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={loadNodes}
              disabled={nodesLoading}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold px-3.5 py-2 rounded-xl border border-slate-700 transition active:scale-95 flex items-center space-x-1.5"
            >
              <span>{nodesLoading ? '🔄 Refreshing...' : '🔄 Refresh Nodes'}</span>
            </button>
          </div>
        </div>

        {/* Nodes Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {nodes.length === 0 ? (
            <div className="col-span-full bg-slate-950/60 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-400">
              No server nodes registered yet. Use the 1-Click Provisioning tool below to connect your first node!
            </div>
          ) : (
            nodes.map((node) => {
              const isOnline = node.status === 'online';
              return (
                <div
                  key={node.id}
                  className={`rounded-2xl border p-4 sm:p-5 transition shadow-lg ${
                    isOnline
                      ? 'bg-slate-950/90 border-emerald-500/40 shadow-emerald-500/5'
                      : 'bg-slate-950/60 border-slate-800/80 opacity-80'
                  }`}
                >
                  {/* Top: Name & Status */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-black text-white tracking-tight truncate max-w-[200px]" title={node.node_name}>
                        {node.node_name}
                      </h3>
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                        Role: <span className="text-amber-400 font-bold uppercase">{node.role}</span> • {node.region || 'Local Bare-Metal'}
                      </div>
                    </div>

                    <span
                      className={`text-[10px] font-black px-2.5 py-1 rounded-full border flex items-center gap-1.5 ${
                        isOnline
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 shadow-sm'
                          : 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
                      {isOnline ? 'ONLINE' : 'OFFLINE'}
                    </span>
                  </div>

                  {/* Telemetry Metrics */}
                  <div className="grid grid-cols-2 gap-2 mt-4 bg-slate-900/80 p-2.5 rounded-xl border border-slate-800/80">
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 font-bold">
                        <span>CPU LOAD</span>
                        <span className="text-white font-mono">{node.cpu_usage.toFixed(1)}%</span>
                      </div>
                      <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            node.cpu_usage > 80 ? 'bg-rose-500' : node.cpu_usage > 50 ? 'bg-amber-500' : 'bg-emerald-400'
                          }`}
                          style={{ width: `${Math.min(100, Math.max(5, node.cpu_usage))}%` }}
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 font-bold">
                        <span>RAM USAGE</span>
                        <span className="text-white font-mono">{node.ram_usage.toFixed(1)}%</span>
                      </div>
                      <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            node.ram_usage > 80 ? 'bg-rose-500' : node.ram_usage > 60 ? 'bg-amber-500' : 'bg-sky-400'
                          }`}
                          style={{ width: `${Math.min(100, Math.max(5, node.ram_usage))}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Live Rooms & Players */}
                  <div className="flex items-center justify-between text-xs py-2.5 border-b border-slate-800/60 font-medium">
                    <span className="text-slate-400 text-[11px]">Combat Rooms:</span>
                    <span className="text-white font-bold">{node.active_rooms} active</span>
                  </div>
                  <div className="flex items-center justify-between text-xs py-2 border-b border-slate-800/60 font-medium">
                    <span className="text-slate-400 text-[11px]">Connected Players:</span>
                    <span className="text-emerald-400 font-black font-mono">{node.player_count} online</span>
                  </div>

                  {/* Capacity Controls */}
                  <div className="mt-3 pt-1 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">Mini Mode Capacity:</span>
                      <div className="flex items-center space-x-1">
                        {[20, 30, 40].map((cap) => (
                          <button
                            key={cap}
                            onClick={() => handleCapacityChange(node.id, cap, node.room_capacity_fast)}
                            disabled={updatingNodeId === node.id}
                            className={`px-2 py-0.5 text-[10px] rounded-md font-bold transition ${
                              node.room_capacity_mini === cap
                                ? 'bg-amber-500 text-slate-950 font-black'
                                : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            {cap}P
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">Standard 100 Capacity:</span>
                      <div className="flex items-center space-x-1">
                        {[60, 100, 120].map((cap) => (
                          <button
                            key={cap}
                            onClick={() => handleCapacityChange(node.id, node.room_capacity_mini, cap)}
                            disabled={updatingNodeId === node.id}
                            className={`px-2 py-0.5 text-[10px] rounded-md font-bold transition ${
                              node.room_capacity_fast === cap
                                ? 'bg-rose-600 text-white font-black'
                                : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            {cap}P
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Footer status */}
                  <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-between items-center text-[10px] text-slate-500">
                    <span className="truncate max-w-[140px] font-mono">{node.ip_address || node.tunnel_hostname || 'localhost'}</span>
                    <span>{formatLastHeartbeat(node.last_heartbeat)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 1-CLICK PROVISIONING COMMAND BUILDER */}
        <div className="bg-slate-950/80 border border-amber-500/30 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xl">⚡</span>
              <h3 className="text-sm font-black text-amber-400 tracking-tight">
                GENERATE 1-CLICK AUTHENTICATED INSTALL COMMAND
              </h3>
            </div>
            <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold px-2 py-0.5 rounded-full">
              UBUNTU 24.04 LTS
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Configure role and node parameters below. Then run the generated one-liner as root (<code className="text-amber-300">sudo bash</code>) on your fresh server.
            The script automatically installs Node 20, pnpm, pm2, PostgreSQL, Redis, builds the codebase, injects live production secrets, and configures auto-boot on power failure.
          </p>

          {/* Form options */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase mb-1">Node Role</label>
              <div className="flex flex-col space-y-1.5">
                {[
                  { id: 'all', label: '🎮 All-in-One (Game + Logs + DBs)' },
                  { id: 'game', label: '⚔️ Game Server Node Only' },
                  { id: 'logs', label: '📜 PostgreSQL Log Receiver Only' },
                ].map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRole(r.id as any)}
                    className={`text-left px-3 py-2 rounded-xl text-xs font-bold border transition ${
                      selectedRole === r.id
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/60 shadow-sm'
                        : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase mb-1">Node Hostname / Name</label>
              <input
                type="text"
                value={nodeNameInput}
                onChange={(e) => setNodeNameInput(e.target.value)}
                placeholder="mwar-game-server-1"
                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500"
              />
              <span className="text-[10px] text-slate-500 mt-1 block">Used for telemetry identification.</span>
            </div>

            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase mb-1">
                Cloudflare Tunnel Token <span className="text-slate-500">(Optional)</span>
              </label>
              <input
                type="text"
                value={tunnelTokenInput}
                onChange={(e) => setTunnelTokenInput(e.target.value)}
                placeholder="eyJh..."
                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500 font-mono"
              />
              <span className="text-[10px] text-slate-500 mt-1 block">Auto-installs cloudflared service if set.</span>
            </div>
          </div>

          {/* Generated Command Box */}
          <div className="bg-black/90 border border-slate-800 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black text-slate-400 tracking-wider">TERMINAL ONE-LINER COMMAND:</span>
              <button
                onClick={handleCopyCommand}
                className={`text-xs font-black px-3.5 py-1.5 rounded-lg transition active:scale-95 shadow-md flex items-center space-x-1.5 ${
                  copied
                    ? 'bg-emerald-500 text-slate-950 font-black'
                    : 'bg-rose-600 hover:bg-rose-500 text-white'
                }`}
              >
                <span>{copied ? '✅ COPIED TO CLIPBOARD!' : '📋 COPY COMMAND'}</span>
              </button>
            </div>

            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-900 font-mono text-xs text-amber-300 break-all select-all">
              {buildInstallCommand()}
            </div>
          </div>
        </div>
      </div>

      {/* 3. 3-Tier Pipeline Architecture Visual */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-900/95 rounded-3xl border border-sky-500/30 p-5 space-y-2 shadow-xl">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-pulse" />
            <h3 className="text-xs font-black text-sky-400 tracking-wider">LAYER 1: DETERMINISTIC AUDIT</h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Instant 1-second verification comparing Cloudflare D1 wallet balance against the 90-day PostgreSQL append-only financial ledger.
          </p>
          <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 text-[10px] font-mono text-slate-300">
            D1 Balance == SUM(Logs)
          </div>
        </div>

        <div className="bg-slate-900/95 rounded-3xl border border-purple-500/30 p-5 space-y-2 shadow-xl">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-400 animate-pulse" />
            <h3 className="text-xs font-black text-purple-400 tracking-wider">LAYER 2: HEURISTIC AUDIT</h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Analyzes kill rate frequencies, aim vectors, 15-second chest collection timings, and IP subnet correlation.
          </p>
          <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 text-[10px] font-mono text-slate-300">
            Kill Rate &lt; 2.5/s • 0 Self-Ref
          </div>
        </div>

        <div className="bg-slate-900/95 rounded-3xl border border-emerald-500/30 p-5 space-y-2 shadow-xl">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <h3 className="text-xs font-black text-emerald-400 tracking-wider">LAYER 3: DEEP AI EVALUATION</h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Large-value cashouts (&gt; $50) undergo anomaly verification before NOWPayments API batch dispatch.
          </p>
          <div className="bg-slate-950 p-2 rounded-xl border border-slate-800 text-[10px] font-mono text-slate-300">
            Confidence &gt; 0.85 Auto-Dispatched
          </div>
        </div>
      </div>

      {/* 4. Pending Cashouts Review Table */}
      <div className="bg-slate-900/95 border border-slate-800 rounded-3xl overflow-hidden shadow-xl">
        <div className="p-4 sm:p-5 border-b border-slate-800 flex justify-between items-center">
          <span className="text-sm font-black text-white">Pending Fraud Reviews ({pendingList.length})</span>
          <button
            onClick={loadPending}
            className="text-xs text-amber-400 hover:text-amber-300 font-bold bg-slate-800 px-3 py-1 rounded-xl border border-slate-700"
          >
            Refresh Queue
          </button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-xs text-slate-400 animate-pulse">Scanning pending withdrawals...</div>
        ) : pendingList.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500">
            ✅ Queue clear! All pending cashouts have been audited and settled.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400 font-bold border-b border-slate-800 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="p-3.5">Withdrawal ID</th>
                  <th className="p-3.5">User</th>
                  <th className="p-3.5">Amount</th>
                  <th className="p-3.5">Currency</th>
                  <th className="p-3.5">AI Score</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-200">
                {pendingList.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-800/40 transition">
                    <td className="p-3.5 font-mono text-slate-300 font-bold">
                      {item.id.slice(0, 8)}...
                    </td>
                    <td className="p-3.5 font-bold text-white">
                      {item.user_id?.slice(0, 8)}...
                    </td>
                    <td className="p-3.5 text-emerald-400 font-black font-mono">
                      {formatMicroUsd(item.amount_micro_usd)}
                    </td>
                    <td className="p-3.5 text-slate-300 font-bold">
                      {item.crypto_currency}
                    </td>
                    <td className="p-3.5">
                      <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-full font-mono font-bold text-[10px]">
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
    </div>
  );
}
