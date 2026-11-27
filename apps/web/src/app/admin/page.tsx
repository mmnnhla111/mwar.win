'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getServerNodes, updateNodeCapacity, type GameNode } from '../../lib/api';
import { staffCanAny } from '@mwar/shared';
import { primaryStaffRole } from '@mwar/shared';
import type { StaffPermission, StaffRole } from '@mwar/shared';
import { StaffRolesAdmin } from '../../components/admin/StaffRolesAdmin';
import { useSession } from '../../lib/session';
import { TakedownQueue } from '../../components/admin/TakedownQueue';
import { MembersAdmin } from '../../components/admin/MembersAdmin';
import { GamesAdmin } from '../../components/admin/GamesAdmin';
import { AdNetworksAdmin } from '../../components/admin/AdNetworksAdmin';
import { CashoutReviewAdmin } from '../../components/admin/CashoutReviewAdmin';
import { NodeCard } from '../../components/admin/NodeCard';
import { useTranslation } from '../../i18n/I18nProvider';

/**
 * Strict /admin guard (static export => client side). Nothing from the console below is mounted, so no admin
 * data is requested, until a FRESH /api/bootstrap says the account holds at least one staff role. Not logged in,
 * or a regular member -> router.replace('/'). The API enforces every permission again (403) regardless.
 */
export default function AdminAuditPage() {
  const router = useRouter();
  const { boot, status, refresh } = useSession();
  const [verified, setVerified] = useState(false);
  const roles = boot?.user.staffRoles || [];
  const isStaff = roles.length > 0;

  useEffect(() => {
    if (status === 'anon') router.replace('/');
  }, [status, router]);

  // Re-check against the server once (the cached bootstrap can be up to 60 s old, e.g. just after a demotion)
  useEffect(() => {
    if (status !== 'ready') return;
    let live = true;
    refresh(true).finally(() => live && setVerified(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status === 'ready']);

  const allowed = status === 'ready' && verified && isStaff;
  useEffect(() => {
    if (status === 'ready' && verified && !isStaff) router.replace('/');
  }, [status, verified, isStaff, router]);

  if (!allowed) return <div className="py-24 text-center text-stone-300" data-admin-guard="checking" aria-busy="true" />;
  return <AdminConsole roles={roles} />;
}

function AdminConsole({ roles }: { roles: StaffRole[] }) {
  const { t } = useTranslation();
  const staffRole = primaryStaffRole(roles);
  const can = (p: StaffPermission) => staffCanAny(roles, p);
  // Each tab mirrors an API permission (the API enforces it; this only hides what you cannot use)
  const TABS = ([
    ['fleet', '🖥️', 'admin.tab.fleet', 'nodes'],
    ['finance', '💸', 'admin.tab.finance', 'financeRead'],
    ['members', '👥', 'admin.tab.members', 'membersRead'],
    ['games', '🎮', 'admin.tab.games', 'games'],
    ['takedown', '🚩', 'takedown.title', 'takedown'],
    ['staff', '🪪', 'admin.tab.staff', 'staff'],
    ['ads', '📣', 'admin.tab.ads', 'ads'],
  ] as const).filter(([, , , perm]) => can(perm));
  type TabId = (typeof TABS)[number][0];
  const [tabState, setTab] = useState<TabId | null>(null);
  const tab: TabId | undefined = tabState && TABS.some(([id]) => id === tabState) ? tabState : TABS[0]?.[0];
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
    if (tab === 'fleet' && nodesLoading && !nodes.length) loadNodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  // No background polling: use the Refresh Nodes button

  const handleCapacityChange = async (nodeId: string, mini: number, fast: number) => {
    setUpdatingNodeId(nodeId);
    try {
      await updateNodeCapacity(nodeId, {
        room_capacity_mini: mini,
        room_capacity_fast: fast,
      });
      await loadNodes();
      setActionMsg(t('admin.capacityUpdated', { node: nodeId }));
    } catch (err: any) {
      setActionMsg(t('admin.capacityFailed', { error: err.message }));
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
    if (!timestamp) return t('admin.never');
    const secondsAgo = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
    if (secondsAgo < 45) return t('admin.activeNow', { s: secondsAgo });
    if (secondsAgo < 90) return t('admin.heartbeatAgo', { s: secondsAgo });
    const mins = Math.floor(secondsAgo / 60);
    return t('admin.offlineAgo', { m: mins });
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
              <span>{t('admin.title')}</span>
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">
              {t('admin.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs font-bold text-amber-700 bg-stone-50 px-3.5 py-1.5 rounded-2xl border border-stone-200/80">
          <span className="w-2 h-2 rounded-full bg-[#FFE135] animate-ping" />
          <span data-staff-role={staffRole} data-staff-roles={roles.join(',')}>{roles.map((r) => t(`staff.role.${r}`)).join(' + ')}</span>
        </div>
      </div>

      {actionMsg && (
        <div className="bg-white border border-amber-200 text-amber-700 text-xs p-3.5 rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex justify-between items-center animate-in fade-in">
          <span>{actionMsg}</span>
          <button onClick={() => setActionMsg('')} className="text-stone-500 hover:text-stone-900 font-bold ml-2">✕</button>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto" role="tablist">
        {TABS.map(([id, icon, label]) => (
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
            {icon} {t(label)}
          </button>
        ))}
      </div>

      {!tab && <div className="bg-white border border-stone-200/80 rounded-3xl p-10 text-center text-sm text-stone-500" data-admin-denied>{t('admin.noAccess')}</div>}
      {tab === 'staff' && <StaffRolesAdmin />}
      {tab === 'ads' && <AdNetworksAdmin />}
      {tab === 'takedown' && <TakedownQueue />}
      {tab === 'members' && <MembersAdmin />}
      {tab === 'games' && <GamesAdmin />}

      {tab === 'fleet' && (
      <>
      {/* 2. SERVER NODES & 1-CLICK INSTALLER SECTION */}
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-200/80 pb-4">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">🖥️</span>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold text-stone-900 tracking-tight">
                {t('admin.fleetTitle')}
              </h2>
              <p className="text-xs text-stone-500">
                {t('admin.fleetSubtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={loadNodes}
              disabled={nodesLoading}
              className="bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-bold px-3.5 py-2 rounded-xl border border-stone-200/80 transition active:scale-95 flex items-center space-x-1.5"
            >
              <span>🔄 {nodesLoading ? t('admin.refreshing') : t('admin.refreshNodes')}</span>
            </button>
          </div>
        </div>

        {/* Nodes Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {nodes.length === 0 ? (
            <div className="col-span-full bg-stone-50 border border-stone-200/80 rounded-2xl p-6 text-center text-xs text-stone-500">
              {t('admin.noNodes')}
            </div>
          ) : (
            nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                heartbeat={formatLastHeartbeat(node.last_heartbeat)}
                updating={updatingNodeId === node.id}
                onCapacity={handleCapacityChange}
              />
            ))
          )}
        </div>

        {/* 1-CLICK PROVISIONING COMMAND BUILDER */}
        <div className="bg-stone-50 border border-amber-200 rounded-2xl p-5 space-y-4 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xl">⚡</span>
              <h3 className="text-sm font-extrabold text-amber-700 tracking-tight">
                {t('admin.genTitle')}
              </h3>
            </div>
            <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 font-bold px-2 py-0.5 rounded-full">
              UBUNTU 24.04 LTS
            </span>
          </div>

          <p className="text-xs text-stone-500 leading-relaxed">
            {t('admin.genHelp')}
          </p>

          {/* Form options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">{t('admin.nodeRole')}</label>
              <div className="flex flex-col space-y-1.5">
                {[
                  { id: 'all', label: '🎮 ' + t('admin.roleAll') },
                  { id: 'game', label: '⚔️ ' + t('admin.roleGame') },
                  { id: 'logs', label: '📜 ' + t('admin.roleLogs') },
                  { id: 'moderator', label: '🛡️ ' + t('admin.roleModerator') },
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
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">{t('admin.nodeName')}</label>
              <input
                type="text"
                value={nodeNameInput}
                onChange={(e) => setNodeNameInput(e.target.value)}
                placeholder="mwar-game-server-1"
                className="w-full bg-white border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 focus:outline-none focus:border-yellow-400"
              />
              <span className="text-[10px] text-stone-500 mt-1 block">{t('admin.nodeNameHint')}</span>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">
                {t('admin.provKey')} {provisionKey ? <span className="text-emerald-600 font-normal">● {t('admin.loaded')}</span> : <span className="text-amber-700 font-normal">● {t('admin.optional')}</span>}
              </label>
              <input
                type="password"
                value={provisionKey}
                onChange={(e) => setProvisionKey(e.target.value)}
                placeholder="mwar_pvkey_..."
                className="w-full bg-white border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 focus:outline-none focus:border-yellow-400 font-mono"
              />
              <span className="text-[10px] text-stone-500 mt-1 block">{t('admin.provKeyHint')}</span>
            </div>

            <div>
              <label className="block text-[10px] font-extrabold text-stone-500 uppercase mb-1">
                {t('admin.tunnel')} <span className="text-stone-500">({t('admin.optional')})</span>
              </label>
              <input
                type="text"
                value={tunnelTokenInput}
                onChange={(e) => setTunnelTokenInput(e.target.value)}
                placeholder="eyJh..."
                className="w-full bg-white border border-stone-200/80 rounded-xl px-3 py-2 text-xs text-stone-900 focus:outline-none focus:border-yellow-400 font-mono"
              />
              <span className="text-[10px] text-stone-500 mt-1 block">{t('admin.tunnelHint')}</span>
            </div>
          </div>

          {/* Generated Command Box */}
          <div className="bg-stone-900/30 border border-stone-200/80 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-extrabold text-stone-500 tracking-wider">{t('admin.terminal')}</span>
              <button
                onClick={handleCopyCommand}
                className={`text-xs font-extrabold px-3.5 py-1.5 rounded-lg transition active:scale-95 shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex items-center space-x-1.5 ${
                  copied
                    ? 'bg-emerald-500 text-stone-900 font-extrabold'
                    : 'bg-rose-600 hover:bg-rose-500 text-white'
                }`}
              >
                <span>{copied ? '✅ ' + t('admin.copiedCmd') : '📋 ' + t('admin.copyCmd')}</span>
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
            <h3 className="text-xs font-extrabold text-sky-600 tracking-wider">{t('admin.layer1')}</h3>
          </div>
          <p className="text-xs text-stone-500 leading-relaxed">
            {t('admin.layer1Text')}
          </p>
          <div className="bg-stone-50 p-2 rounded-xl border border-stone-200/80 text-[10px] font-mono text-stone-600">
            D1 Balance == SUM(Logs)
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-violet-200 p-5 space-y-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-400 animate-pulse" />
            <h3 className="text-xs font-extrabold text-violet-600 tracking-wider">{t('admin.layer2')}</h3>
          </div>
          <p className="text-xs text-stone-500 leading-relaxed">
            {t('admin.layer2Text')}
          </p>
          <div className="bg-stone-50 p-2 rounded-xl border border-stone-200/80 text-[10px] font-mono text-stone-600">
            Kill Rate &lt; 2.5/s • 0 Self-Ref
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-emerald-200 p-5 space-y-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <h3 className="text-xs font-extrabold text-emerald-600 tracking-wider">{t('admin.layer3')}</h3>
          </div>
          <p className="text-xs text-stone-500 leading-relaxed">
            {t('admin.layer3Text')}
          </p>
          <div className="bg-stone-50 p-2 rounded-xl border border-stone-200/80 text-[10px] font-mono text-stone-600">
            Confidence &gt; 0.85 Auto-Dispatched
          </div>
        </div>
      </div>

      </>
      )}

      {tab === 'finance' && <CashoutReviewAdmin />}
    </div>
  );
}
