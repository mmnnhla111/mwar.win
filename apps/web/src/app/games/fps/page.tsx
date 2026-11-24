'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FPS_ROOMS, fpsLaunchUrl } from '@mwar/shared';
import type { FpsRoomFilter, FpsRoomLive, FpsRosterEntry } from '@mwar/shared';
import { Card, Modal, Spinner, btn } from '../../../components/ui/Card';
import { Icon } from '../../../components/ui/Icon';
import { Avatar } from '../../../components/ui/Avatar';
import { getFpsRooms, getFpsRoster } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useVisibleInterval } from '../../../lib/useVisibleInterval';
import { RewardedVideoModal } from '../../../game/ui/AdEngine';
import { useTranslation } from '../../../i18n/I18nProvider';

const FILTERS: { id: FpsRoomFilter; label: string }[] = [
  { id: 'all', label: 'fps.filter.all' },
  { id: 'large', label: 'fps.filter.large' },
  { id: 'small', label: 'fps.filter.small' },
  { id: 'practice', label: 'fps.filter.practice' },
];

const AUTO_REFRESH_MS = 45_000;

function offlineRooms(): FpsRoomLive[] {
  return FPS_ROOMS.map((r) => ({ ...r, rules: [...r.rules], players: 0, spectators: 0, isFull: false }));
}

function matches(room: FpsRoomLive, f: FpsRoomFilter) {
  if (f === 'all') return true;
  if (f === 'practice') return !room.multiplayer;
  return room.multiplayer && room.mapSize === f;
}

function StatusBadge({ room }: { room: FpsRoomLive }) {
  const { t } = useTranslation();
  if (!room.multiplayer) return <span className="rounded-full bg-[#E0F2FE] text-sky-700 text-[11px] font-extrabold px-2.5 py-1 whitespace-nowrap">{t('fps.solo')}</span>;
  return room.isFull ? (
    <span className="rounded-full bg-[#FFE4E6] text-rose-600 text-[11px] font-extrabold px-2.5 py-1 whitespace-nowrap">{t('fps.full')}</span>
  ) : (
    <span className="rounded-full bg-[#D1FAE5] text-emerald-700 text-[11px] font-extrabold px-2.5 py-1 whitespace-nowrap">{t('fps.open')}</span>
  );
}

function Capacity({ room, wide = false }: { room: FpsRoomLive; wide?: boolean }) {
  const { t } = useTranslation();
  if (room.capacity === null) return <span className="text-sm font-bold text-stone-700">{t('fps.local')}</span>;
  const pct = Math.min(100, Math.round((room.players / room.capacity) * 100));
  return (
    <div className={wide ? 'w-full' : 'w-28'}>
      <div className="text-sm font-extrabold text-stone-900 tabular-nums">
        {room.players}/{room.capacity} <span className="text-stone-400 font-semibold text-xs">{t('fps.people')}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-stone-100 overflow-hidden">
        <div className={`h-full rounded-full ${room.isFull ? 'bg-[#FF6B6B]' : pct > 70 ? 'bg-[#FACC15]' : 'bg-[#34D399]'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * XSHOT-style room browser. Room numbers are fetched on mount, on the Refresh button, and every 45 s
 * ONLY while this page is open and the tab is visible (served from the 15 s edge cache).
 */
export default function FpsLobbyPage() {
  const { boot, patch } = useSession();
  const { t, tx } = useTranslation();
  const [rooms, setRooms] = useState<FpsRoomLive[]>(offlineRooms);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<FpsRoomFilter>('all');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [video, setVideo] = useState<null | 'video_15s' | 'video_30s'>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getFpsRooms();
      setRooms(r.rooms);
      setServerOnline(r.serverOnline);
    } catch {
      setServerOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useVisibleInterval(load, AUTO_REFRESH_MS);

  const visible = rooms.filter((r) => matches(r, filter));
  const room = rooms.find((r) => r.id === selected) || null;
  const ec = boot?.user.energyTickets ?? 0;
  const ecMax = boot?.user.maxEnergyTickets ?? 6;

  return (
    <div className="space-y-3">
      {/* Top bar */}
      <Card className="p-3 sm:p-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/games" className="w-9 h-9 rounded-full bg-stone-100 hover:bg-stone-200 flex items-center justify-center text-stone-700 shrink-0" aria-label={t('fps.backToGames')}>
            <Icon name="back" size={18} />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="font-extrabold text-stone-900 text-lg leading-tight truncate">MWAR Tactical FPS · {t('nav.rooms')}</h1>
            <div className="text-xs text-stone-500 flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${serverOnline === false ? 'bg-stone-300' : 'bg-[#34D399]'}`} />
              {serverOnline === false ? t('fps.offline') : t('fps.liveNumbers')}
            </div>
          </div>
          <span className="inline-flex items-center gap-1 sm:gap-1.5 rounded-full bg-[#FFF6C2] text-stone-900 text-xs sm:text-sm font-extrabold px-2.5 sm:px-3 py-1.5 shrink-0" title={t('fps.energyTickets')}>
            <Icon name="bolt" size={16} filled /> EC: {ec}/{ecMax}
          </span>
          <button onClick={load} disabled={loading} className="w-9 h-9 rounded-full bg-stone-100 hover:bg-stone-200 flex items-center justify-center text-stone-700 shrink-0" aria-label={t('fps.refreshRooms')} title={t('common.refresh')}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${filter === f.id ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}
            >
              {t(f.label)}
            </button>
          ))}
          {ec < ecMax && (
            <button onClick={() => setVideo('video_30s')} className="shrink-0 ml-auto rounded-full bg-[#FFE135] hover:bg-[#FACC15] text-stone-900 text-xs font-extrabold px-3 py-1.5">
              ▶ {t('fps.recharge')}
            </button>
          )}
        </div>
      </Card>

      {/* Desktop / tablet table */}
      <Card className="hidden md:block overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-stone-400 border-b border-stone-100">
              <th className="font-bold px-4 py-3">{t('fps.col.room')}</th>
              <th className="font-bold px-3 py-3">{t('fps.col.modeMap')}</th>
              <th className="font-bold px-3 py-3">{t('side.players')}</th>
              <th className="font-bold px-3 py-3">{t('fps.spectators')}</th>
              <th className="font-bold px-3 py-3">{t('fps.col.entry')}</th>
              <th className="font-bold px-4 py-3 text-right">{t('fps.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r.id)}
                className="border-b last:border-0 border-stone-100 hover:bg-[#FFFBEA] cursor-pointer transition"
                data-room={r.id}
              >
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-lg bg-stone-900 text-[#FFE135] text-[11px] font-extrabold px-2 py-1 tabular-nums">{r.id}</span>
                    <span className="font-bold text-sm text-stone-900">{tx(`fps.room.${r.id}.name`, r.name)}</span>
                  </div>
                </td>
                <td className="px-3 py-3.5">
                  <div className="text-sm font-semibold text-stone-800">{tx(`fps.room.${r.id}.mode`, r.modeLabel)}</div>
                  <div className="text-xs text-stone-500 flex items-center gap-1">
                    <Icon name="map" size={12} /> {r.map}
                  </div>
                </td>
                <td className="px-3 py-3.5">
                  <Capacity room={r} />
                </td>
                <td className="px-3 py-3.5 text-sm text-stone-700">
                  <span className="inline-flex items-center gap-1">
                    <Icon name="eye" size={15} className="text-stone-400" /> {t('fps.watchingN', { n: r.spectators })}
                  </span>
                </td>
                <td className="px-3 py-3.5">
                  {r.costEc ? (
                    <span className="inline-flex items-center gap-1 text-sm font-bold text-stone-900">
                      <Icon name="bolt" size={14} filled className="text-[#E5B800]" /> {r.costEc} EC
                    </span>
                  ) : (
                    <span className="text-sm font-extrabold text-emerald-600">{t('fps.free')}</span>
                  )}
                </td>
                <td className="px-4 py-3.5 text-right">
                  <StatusBadge room={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Mobile compact cards */}
      <div className="md:hidden space-y-2.5">
        {visible.map((r) => (
          <button key={r.id} onClick={() => setSelected(r.id)} className="w-full text-left" data-room={r.id}>
            <Card className="p-3.5 active:scale-[0.99] transition">
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-stone-900 text-[#FFE135] text-[11px] font-extrabold px-2 py-1">{r.id}</span>
                <span className="font-bold text-sm text-stone-900 truncate flex-1">{tx(`fps.room.${r.id}.name`, r.name)}</span>
                <StatusBadge room={r} />
              </div>
              <div className="mt-2.5 grid grid-cols-[1fr_auto] gap-3 items-end">
                <div className="min-w-0">
                  <div className="text-xs text-stone-500 truncate">
                    {tx(`fps.room.${r.id}.mode`, r.modeLabel)} · {r.map}
                  </div>
                  <div className="mt-1.5">
                    <Capacity room={r} wide />
                  </div>
                </div>
                <div className="text-right text-xs text-stone-500 space-y-1">
                  <div className="inline-flex items-center gap-1">
                    <Icon name="eye" size={13} /> {t('fps.watchingN', { n: r.spectators })}
                  </div>
                  <div className="font-extrabold text-stone-900">{r.costEc ? `${r.costEc} EC` : <span className="text-emerald-600">{t('fps.free')}</span>}</div>
                </div>
              </div>
            </Card>
          </button>
        ))}
      </div>

      <RoomDetail room={room} onClose={() => setSelected(null)} ec={ec} />

      {video && (
        <RewardedVideoModal
          format={video}
          onClose={() => setVideo(null)}
          onResult={(r) =>
            patch((b) => ({
              ...b,
              user: {
                ...b.user,
                energyTickets: r.energy_tickets ?? b.user.energyTickets,
                energyProgressPct: r.energy_progress_pct ?? b.user.energyProgressPct,
              },
            }))
          }
        />
      )}
    </div>
  );
}

function RoomDetail({ room, onClose, ec }: { room: FpsRoomLive | null; onClose: () => void; ec: number }) {
  const router = useRouter();
  const { t, tx } = useTranslation();
  const [roster, setRoster] = useState<FpsRosterEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const loadRoster = useCallback(
    async (cursor?: string | null) => {
      if (!room?.multiplayer) return;
      setLoading(true);
      try {
        const r = await getFpsRoster(room.id, cursor);
        setRoster((prev) => (cursor ? [...prev, ...r.items] : r.items));
        setNext(r.nextCursor);
        setTotal(r.total);
      } catch {
        /* roster is optional */
      } finally {
        setLoading(false);
      }
    },
    [room?.id, room?.multiplayer]
  );

  useEffect(() => {
    setRoster([]);
    setNext(null);
    setTotal(0);
    if (room) loadRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  if (!room) return null;
  const full = room.isFull;
  const noEc = room.costEc > 0 && ec < room.costEc;

  return (
    <Modal
      open={!!room}
      onClose={onClose}
      maxWidth="max-w-lg"
      title={
        <span className="flex items-center gap-2">
          <span className="rounded-lg bg-stone-900 text-[#FFE135] text-[11px] font-extrabold px-2 py-1">{room.id}</span>
          <span className="truncate">{tx(`fps.room.${room.id}.name`, room.name)}</span>
        </span>
      }
    >
      <div className="p-5 space-y-4" data-room-detail={room.id}>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full bg-[#E0F2FE] text-sky-800 text-xs font-bold px-2.5 py-1 inline-flex items-center gap-1">
            <Icon name="map" size={13} /> {room.map}
          </span>
          <span className="rounded-full bg-[#EDE9FE] text-violet-700 text-xs font-bold px-2.5 py-1">{tx(`fps.room.${room.id}.mode`, room.modeLabel)}</span>
          <span className="rounded-full bg-[#FFF6C2] text-stone-900 text-xs font-bold px-2.5 py-1 inline-flex items-center gap-1">
            <Icon name="bolt" size={13} filled /> {room.costEc ? t('fps.entryEc', { n: room.costEc }) : t('fps.free')}
          </span>
          <StatusBadge room={room} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-stone-50 border border-stone-100 p-3">
            <div className="text-[11px] font-semibold text-stone-500">{t('side.players')}</div>
            <Capacity room={room} wide />
          </div>
          <div className="rounded-2xl bg-stone-50 border border-stone-100 p-3">
            <div className="text-[11px] font-semibold text-stone-500">{t('fps.spectators')}</div>
            <div className="text-sm font-extrabold text-stone-900">{t('fps.watchingN', { n: room.spectators })}</div>
          </div>
        </div>

        <div>
          <div className="text-xs font-bold text-stone-500 mb-1.5">{t('fps.rules')}</div>
          <ul className="space-y-1">
            {room.rules.map((r, i) => (
              <li key={r} className="text-sm text-stone-700 flex gap-2">
                <Icon name="check" size={16} className="text-emerald-500 mt-0.5 shrink-0" /> {tx(`fps.room.${room.id}.rule${i + 1}`, r)}
              </li>
            ))}
          </ul>
        </div>

        {room.multiplayer && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs font-bold text-stone-500">{t('fps.inRoom')} {total ? `(${total})` : ''}</div>
              <button onClick={() => loadRoster()} className="text-stone-400 hover:text-stone-800" aria-label={t('fps.refreshRoster')}>
                <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="rounded-2xl border border-stone-100 divide-y divide-stone-100 max-h-56 overflow-y-auto">
              {loading && roster.length === 0 && (
                <div className="py-5 flex justify-center">
                  <Spinner />
                </div>
              )}
              {!loading && roster.length === 0 && <p className="py-5 text-center text-sm text-stone-400">{t('fps.nobody')}</p>}
              {roster.map((p, i) => {
                const row = (
                  <>
                    <Avatar name={p.username} size={30} />
                    <span className="flex-1 min-w-0 text-sm font-semibold text-stone-800 truncate">{p.username}</span>
                    <span className="text-xs text-stone-500 tabular-nums">
                      K/D {p.kills}/{p.deaths}
                    </span>
                    <span
                      className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${
                        p.status === 'alive' ? 'bg-[#D1FAE5] text-emerald-700' : p.status === 'dead' ? 'bg-[#FFE4E6] text-rose-600' : 'bg-[#E0F2FE] text-sky-700'
                      }`}
                    >
                      {t(`fps.status.${p.status}`)}
                    </span>
                  </>
                );
                return p.userId ? (
                  <Link key={`${p.username}-${i}`} href={`/profile?u=${p.username}`} className="flex items-center gap-2.5 px-3 py-2 hover:bg-stone-50">
                    {row}
                  </Link>
                ) : (
                  <div key={`${p.username}-${i}`} className="flex items-center gap-2.5 px-3 py-2">
                    {row}
                  </div>
                );
              })}
              {next && (
                <button onClick={() => loadRoster(next)} className="w-full py-2 text-xs font-bold text-stone-500 hover:text-stone-800">
                  {t('fps.morePlayers')}
                </button>
              )}
            </div>
          </div>
        )}

        {noEc && !full && <p className="text-xs font-semibold text-[#B08600] bg-[#FFFBEA] rounded-2xl px-3 py-2">{t('fps.noEc')}</p>}

        <div className={`grid gap-2 ${room.multiplayer ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <button
            type="button"
            disabled={full}
            aria-disabled={full}
            data-action="join"
            onClick={() => !full && router.push(fpsLaunchUrl(room))}
            className={full ? 'rounded-full py-3 text-sm font-extrabold bg-stone-200 text-stone-400 cursor-not-allowed' : `${btn.primary} py-3`}
          >
            {full ? t('fps.roomFull') : room.multiplayer ? t('fps.join') : t('fps.playSolo')}
          </button>
          {room.multiplayer && (
            <button type="button" data-action="spectate" onClick={() => router.push(fpsLaunchUrl(room, true))} className={`${btn.dark} py-3`}>
              <Icon name="eye" size={17} /> {t('fps.spectate')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
