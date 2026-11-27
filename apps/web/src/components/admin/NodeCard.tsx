'use client';

import React from 'react';
import type { GameNode } from '../../lib/api';
import { useTranslation } from '../../i18n/I18nProvider';

export type NodeKind = 'all' | 'game' | 'moderator' | 'log';

/** 'logs' is what the installer reports for a log-only node. Unknown values behave like an all-in-one node. */
export function nodeKind(role: string | null | undefined): NodeKind {
  const r = String(role || '').toLowerCase();
  if (r === 'moderator') return 'moderator';
  if (r === 'log' || r === 'logs') return 'log';
  if (r === 'game') return 'game';
  return 'all';
}

function Meter({ label, value, tone }: { label: string; value: number; tone: 'cpu' | 'ram' }) {
  const v = Number.isFinite(value) ? value : 0;
  const hot = tone === 'cpu' ? [80, 50] : [80, 60];
  return (
    <div>
      <div className="flex justify-between text-[10px] text-stone-500 font-bold">
        <span>{label}</span>
        <span className="text-stone-900 font-mono">{v.toFixed(1)}%</span>
      </div>
      <div className="w-full bg-stone-100 h-1.5 rounded-full overflow-hidden mt-1">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            v > hot[0] ? 'bg-rose-500' : v > hot[1] ? 'bg-[#FFE135]' : tone === 'cpu' ? 'bg-emerald-400' : 'bg-sky-400'
          }`}
          style={{ width: `${Math.min(100, Math.max(5, v))}%` }}
        />
      </div>
    </div>
  );
}

function Row({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between text-xs py-2 font-medium ${last ? '' : 'border-b border-stone-200/80'}`}>
      <span className="text-stone-500 text-[11px]">{label}</span>
      {children}
    </div>
  );
}

/**
 * One Ubuntu / VPS node in /admin → Servers. The role decides the telemetry: game / all nodes show rooms, players
 * and the room-capacity buttons; moderation nodes show the AI content-moderation worker instead; log-only nodes
 * show PostgreSQL status. Capacity controls are never rendered for moderator or log nodes.
 */
export function NodeCard({
  node,
  heartbeat,
  updating,
  onCapacity,
}: {
  node: GameNode;
  heartbeat: string;
  updating: boolean;
  onCapacity: (nodeId: string, mini: number, fast: number) => void;
}) {
  const { t } = useTranslation();
  const kind = nodeKind(node.role);
  const isOnline = node.status === 'online';
  const hasGame = kind === 'all' || kind === 'game';
  const reported = (v: number | null | undefined) => v !== null && v !== undefined;

  return (
    <div
      className={`rounded-2xl border p-4 sm:p-5 transition shadow-[0_2px_12px_rgba(0,0,0,0.04)] ${
        isOnline ? 'bg-stone-50 border-emerald-200' : 'bg-stone-50 border-stone-200/80 opacity-80'
      }`}
      data-node-card={node.id}
      data-node-kind={kind}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-extrabold text-stone-900 tracking-tight truncate max-w-[200px]" title={node.node_name}>
            {node.node_name}
          </h3>
          <div className="text-[10px] text-stone-500 font-mono mt-0.5">
            {t('admin.role')}: <span className="text-amber-700 font-bold uppercase">{kind === 'moderator' ? t('node.kind.moderator') : kind === 'log' ? t('node.kind.log') : node.role}</span> •{' '}
            {node.region || t('admin.localBareMetal')}
          </div>
        </div>
        <span
          className={`text-[10px] font-extrabold px-2.5 py-1 rounded-full border flex items-center gap-1.5 ${
            isOnline ? 'bg-emerald-50 text-emerald-600 border-emerald-200 shadow-sm' : 'bg-rose-50 text-rose-500 border-rose-200'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
          {isOnline ? t('admin.online') : t('admin.offline')}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-4 bg-white p-2.5 rounded-xl border border-stone-200/80">
        <Meter label={t('admin.cpu')} value={Number(node.cpu_usage)} tone="cpu" />
        <Meter label={t('admin.ram')} value={Number(node.ram_usage)} tone="ram" />
      </div>

      {hasGame && (
        <div data-node-section="game">
          <Row label={t('admin.rooms')}>
            <span className="text-stone-900 font-bold">{node.active_rooms} active</span>
          </Row>
          <Row label={t('admin.players')}>
            <span className="text-emerald-600 font-extrabold font-mono">{node.player_count} online</span>
          </Row>
          <div className="mt-2 pt-1 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-stone-500">{t('admin.miniCap')}</span>
              <div className="flex items-center space-x-1">
                {[20, 30, 40].map((cap) => (
                  <button
                    key={cap}
                    onClick={() => onCapacity(node.id, cap, node.room_capacity_fast)}
                    disabled={updating}
                    className={`px-2 py-0.5 text-[10px] rounded-md font-bold transition ${
                      node.room_capacity_mini === cap ? 'bg-[#FFE135] text-stone-900 font-extrabold' : 'bg-stone-100 text-stone-500 hover:text-stone-900'
                    }`}
                  >
                    {cap}P
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-stone-500">{t('admin.stdCap')}</span>
              <div className="flex items-center space-x-1">
                {[60, 100, 120].map((cap) => (
                  <button
                    key={cap}
                    onClick={() => onCapacity(node.id, node.room_capacity_mini, cap)}
                    disabled={updating}
                    className={`px-2 py-0.5 text-[10px] rounded-md font-bold transition ${
                      node.room_capacity_fast === cap ? 'bg-rose-600 text-white font-extrabold' : 'bg-stone-100 text-stone-500 hover:text-stone-900'
                    }`}
                  >
                    {cap}P
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {kind === 'moderator' && (
        <div data-node-section="moderation">
          <Row label={t('node.aiMod')}>
            <span className={`font-extrabold text-[11px] ${isOnline ? 'text-emerald-600' : 'text-rose-500'}`}>{isOnline ? t('node.aiModActive') : t('admin.offline')}</span>
          </Row>
          <div className="text-[10px] text-stone-500 pb-2 border-b border-stone-200/80">{t('node.aiModWorkers')}</div>
          {reported(node.mod_pending) && (
            <Row label={t('node.modPending')}>
              <span className="text-stone-900 font-bold font-mono">{node.mod_pending}</span>
            </Row>
          )}
          {reported(node.mod_processed) && (
            <Row label={t('node.modProcessed')} last>
              <span className="text-stone-900 font-bold font-mono">{node.mod_processed}</span>
            </Row>
          )}
        </div>
      )}

      {kind === 'log' && (
        <div data-node-section="log">
          <Row label={t('node.postgres')} last>
            <span
              className={`font-extrabold text-[11px] ${node.pg_status === 'ok' ? 'text-emerald-600' : node.pg_status === 'down' ? 'text-rose-500' : 'text-stone-400'}`}
            >
              {node.pg_status === 'ok' ? t('node.pgOk') : node.pg_status === 'down' ? t('node.pgDown') : t('node.pgUnknown')}
            </span>
          </Row>
        </div>
      )}

      <div className="mt-3 pt-2 border-t border-stone-200/80 flex justify-between items-center text-[10px] text-stone-500">
        <span className="truncate max-w-[140px] font-mono">{node.ip_address || node.tunnel_hostname || 'localhost'}</span>
        <span>{heartbeat}</span>
      </div>
    </div>
  );
}
