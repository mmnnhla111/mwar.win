'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { GAME_STATUSES, MAP_SIZES, ROOM_MODES } from '@mwar/shared';
import type { GameRecord, GameRoomConfig, GameStatus, MapSize, RoomMode } from '@mwar/shared';
import { API_BASE_URL, apiFetch, getAuthToken, getServerNodes } from '../../lib/api';
import type { GameNode } from '../../lib/api';
import { compressImageToWebp } from '../../lib/image';
import { Card, Modal, Spinner, btn, inputCls } from '../ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';
import { ColdStartAdmin } from './ColdStartAdmin';

type GameForm = {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  genreTags: string;
  logoUrl: string;
  coverUrl: string;
  routePath: string;
  status: GameStatus;
  sortOrder: string;
};

type RoomForm = {
  roomCode: string;
  name: string;
  nodeId: string;
  mode: RoomMode;
  mapSize: MapSize;
  maxPlayers: string;
  maxSpectators: string;
  entryCostEc: string;
  isActive: boolean;
  sortOrder: string;
  rules: string;
};

const DEFAULT_PLAYERS: Record<RoomMode, number> = { warzone: 100, skirmish: 30, fast_mini: 16, solo_bot: 20 };
const DEFAULT_MAP: Record<RoomMode, MapSize> = { warzone: 'large', skirmish: 'small', fast_mini: 'small', solo_bot: 'small' };

const toGameForm = (g?: GameRecord): GameForm => ({
  slug: g?.slug || '',
  title: g?.title || '',
  subtitle: g?.subtitle || '',
  description: g?.description || '',
  genreTags: (g?.genreTags || []).join(', '),
  logoUrl: g?.logoUrl || '',
  coverUrl: g?.coverUrl || '',
  routePath: g?.routePath || '/games/',
  status: g?.status || 'coming_soon',
  sortOrder: String(g?.sortOrder ?? 100),
});

const toRoomForm = (r?: GameRoomConfig): RoomForm => ({
  roomCode: r?.roomCode || '',
  name: r?.name || '',
  nodeId: r?.nodeId || '',
  mode: r?.mode || 'skirmish',
  mapSize: r?.mapSize || 'small',
  maxPlayers: String(r?.maxPlayers ?? 30),
  maxSpectators: String(r?.maxSpectators ?? 50),
  entryCostEc: String(r?.entryCostEc ?? 1),
  isActive: r?.isActive ?? true,
  sortOrder: String(r?.sortOrder ?? 100),
  rules: (r?.rules || []).join('\n'),
});

const int = (v: string, d = 0) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-stone-600 mb-1 ml-1">{label}</span>
      {children}
    </label>
  );
}

function StatusPill({ status }: { status: GameStatus }) {
  const { t } = useTranslation();
  const cls = status === 'active' ? 'bg-[#D1FAE5] text-emerald-700' : status === 'maintenance' ? 'bg-[#FEF3C7] text-amber-700' : 'bg-[#EDE9FE] text-violet-700';
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${cls}`}>{t(`games.status.${status}`)}</span>;
}

/** /admin → Games & rooms: the game directory (/games) and each game's server room registry. */
export function GamesAdmin() {
  const { t } = useTranslation();
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<GameRecord | 'new' | null>(null);
  const [roomsFor, setRoomsFor] = useState<GameRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ games: GameRecord[] }>('/api/admin/games');
      setGames(r.games);
    } catch (err: any) {
      setError(err?.message || t('adminm.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3" data-admin-games>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-stone-500">{t('adming.hint')}</p>
        <button className={btn.primary} onClick={() => setEditing('new')} data-new-game>
          + {t('adming.newGame')}
        </button>
      </div>
      {/* V1.2 C cold-start tools: bot fill, Happy Hour, streamer share, skin fee, marketing pool + promo codes */}
      <ColdStartAdmin />
      {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}
      {!games && !error && (
        <div className="py-8 flex justify-center">
          <Spinner size={22} />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {games?.map((g) => (
          <Card key={g.id} className="overflow-hidden" data-admin-game={g.slug}>
            <div className="h-24 bg-gradient-to-br from-[#FFF6C2] to-[#E0F2FE] relative">
              {g.coverUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={g.coverUrl} alt="" className="w-full h-full object-cover" />
              )}
            </div>
            <div className="p-4">
              <div className="flex items-center gap-2.5">
                {g.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={g.logoUrl} alt="" className="w-10 h-10 rounded-xl object-cover border border-stone-100" />
                ) : (
                  <span className="w-10 h-10 rounded-xl bg-stone-100 flex items-center justify-center text-lg">🎮</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-extrabold text-stone-900 truncate">{g.title}</span>
                    <StatusPill status={g.status} />
                  </div>
                  <div className="text-[11px] text-stone-400 truncate">
                    {g.slug} · {g.routePath}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button className={btn.soft} onClick={() => setEditing(g)} data-edit-game={g.slug}>
                  {t('adming.edit')}
                </button>
                <button className={btn.dark} onClick={() => setRoomsFor(g)} data-rooms-game={g.slug}>
                  {t('adming.rooms')}
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {editing && <GameEditor game={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
      {roomsFor && <RoomsManager game={roomsFor} onClose={() => setRoomsFor(null)} />}
    </div>
  );
}

function GameEditor({ game, onClose, onSaved }: { game: GameRecord | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<GameForm>(() => toGameForm(game || undefined));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<'logo' | 'cover' | null>(null);
  const [error, setError] = useState('');
  const set = <K extends keyof GameForm>(k: K, v: GameForm[K]) => setF((s) => ({ ...s, [k]: v }));

  const upload = async (kind: 'logo' | 'cover', file: File | undefined) => {
    if (!file || !game) return;
    setUploading(kind);
    setError('');
    try {
      const blob = await compressImageToWebp(file, kind === 'logo' ? 256 : 1280, kind === 'logo' ? 60 * 1024 : 300 * 1024);
      const token = getAuthToken();
      const res = await fetch(`${API_BASE_URL}/api/admin/games/${encodeURIComponent(game.id)}/media?kind=${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/webp', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('adming.uploadFailed'));
      set(kind === 'logo' ? 'logoUrl' : 'coverUrl', data.url);
    } catch (err: any) {
      setError(err?.message || t('adming.uploadFailed'));
    } finally {
      setUploading(null);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    const body = {
      slug: f.slug.trim(),
      title: f.title.trim(),
      subtitle: f.subtitle.trim() || null,
      description: f.description.trim() || null,
      genreTags: f.genreTags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      logoUrl: f.logoUrl.trim() || null,
      coverUrl: f.coverUrl.trim() || null,
      routePath: f.routePath.trim(),
      status: f.status,
      sortOrder: int(f.sortOrder, 100),
    };
    try {
      if (game) await apiFetch(`/api/admin/games/${encodeURIComponent(game.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await apiFetch('/api/admin/games', { method: 'POST', body: JSON.stringify(body) });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message || t('settings.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const mediaRow = (kind: 'logo' | 'cover') => {
    const key = kind === 'logo' ? 'logoUrl' : 'coverUrl';
    return (
      <Field label={t(`adming.${kind}`)}>
        <div className="flex items-center gap-2">
          <input className={`${inputCls} !py-2`} value={f[key]} onChange={(e) => set(key, e.target.value)} placeholder="https://…" />
          {game ? (
            <label className={`${btn.soft} shrink-0 cursor-pointer`}>
              {uploading === kind ? <Spinner size={14} /> : t('adming.upload')}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => upload(kind, e.target.files?.[0])} data-upload={kind} />
            </label>
          ) : null}
        </div>
      </Field>
    );
  };

  return (
    <Modal open onClose={onClose} title={game ? t('adming.editGame', { name: game.title }) : t('adming.newGame')} maxWidth="max-w-lg">
      <div className="p-5 space-y-3" data-game-editor>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('adming.slug')}>
            <input className={`${inputCls} !py-2`} value={f.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} disabled={!!game} name="slug" />
          </Field>
          <Field label={t('adming.route')}>
            <input className={`${inputCls} !py-2`} value={f.routePath} onChange={(e) => set('routePath', e.target.value)} name="routePath" />
          </Field>
        </div>
        <Field label={t('adming.title')}>
          <input className={`${inputCls} !py-2`} value={f.title} onChange={(e) => set('title', e.target.value)} name="title" />
        </Field>
        <Field label={t('adming.subtitle')}>
          <input className={`${inputCls} !py-2`} value={f.subtitle} onChange={(e) => set('subtitle', e.target.value)} />
        </Field>
        <Field label={t('adming.description')}>
          <textarea className={`${inputCls} !py-2 min-h-[72px]`} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label={t('adming.tags')}>
          <input className={`${inputCls} !py-2`} value={f.genreTags} onChange={(e) => set('genreTags', e.target.value)} placeholder="FPS, Battle Royale" />
        </Field>
        {mediaRow('logo')}
        {mediaRow('cover')}
        {!game && <p className="text-[11px] text-stone-400">{t('adming.uploadAfterCreate')}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('adming.status')}>
            <select className={`${inputCls} !py-2`} value={f.status} onChange={(e) => set('status', e.target.value as GameStatus)} name="status">
              {GAME_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`games.status.${s}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('adming.sortOrder')}>
            <input className={`${inputCls} !py-2`} inputMode="numeric" value={f.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
          </Field>
        </div>
        {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className={btn.ghost} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className={btn.primary} onClick={save} disabled={busy} data-save-game>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RoomsManager({ game, onClose }: { game: GameRecord; onClose: () => void }) {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<GameRoomConfig[] | null>(null);
  const [nodes, setNodes] = useState<GameNode[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ room: GameRoomConfig | null; f: RoomForm } | null>(null);
  const [busy, setBusy] = useState(false);

  const base = `/api/admin/games/${encodeURIComponent(game.id)}/rooms`;
  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ rooms: GameRoomConfig[] }>(base);
      setRooms(r.rooms);
    } catch (err: any) {
      setError(err?.message || t('adminm.loadFailed'));
    }
  }, [base, t]);

  useEffect(() => {
    load();
    getServerNodes()
      .then((r) => setNodes(r.nodes || []))
      .catch(() => setNodes([]));
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      return true;
    } catch (err: any) {
      setError(err?.message || t('settings.saveFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveRoom = async () => {
    if (!form) return;
    const { f, room } = form;
    const body = {
      roomCode: f.roomCode.trim().toUpperCase(),
      name: f.name.trim(),
      nodeId: f.nodeId || null,
      mode: f.mode,
      mapSize: f.mapSize,
      maxPlayers: int(f.maxPlayers, 30),
      maxSpectators: int(f.maxSpectators, 0),
      entryCostEc: int(f.entryCostEc, 1),
      isActive: f.isActive,
      sortOrder: int(f.sortOrder, 100),
      rules: f.rules
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const ok = await run(() =>
      room
        ? apiFetch(`${base}/${encodeURIComponent(room.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
        : apiFetch(base, { method: 'POST', body: JSON.stringify(body) })
    );
    if (ok) setForm(null);
  };

  const setF = <K extends keyof RoomForm>(k: K, v: RoomForm[K]) => setForm((s) => (s ? { ...s, f: { ...s.f, [k]: v } } : s));
  const nodeName = (id: string | null) => (id ? nodes.find((n) => n.id === id)?.node_name || id : t('adming.anyNode'));

  return (
    <Modal open onClose={onClose} title={t('adming.roomsOf', { name: game.title })} maxWidth="max-w-2xl">
      <div className="p-5 space-y-3" data-rooms-manager>
        {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}
        {!form && (
          <>
            <div className="flex justify-end">
              <button className={btn.primary} onClick={() => setForm({ room: null, f: toRoomForm() })} data-new-room>
                + {t('adming.newRoom')}
              </button>
            </div>
            {!rooms ? (
              <div className="py-6 flex justify-center">
                <Spinner size={20} />
              </div>
            ) : rooms.length ? (
              <div className="rounded-2xl border border-stone-100 divide-y divide-stone-100 overflow-hidden">
                {rooms.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2.5" data-admin-room={r.roomCode}>
                    <span className="rounded-xl bg-stone-900 text-white text-[11px] font-black px-2 py-1 shrink-0">{r.roomCode}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-sm text-stone-900 truncate">{r.name}</span>
                        {!r.isActive && <span className="rounded-full bg-stone-100 text-stone-500 px-2 py-0.5 text-[10px] font-extrabold">{t('adming.closed')}</span>}
                      </div>
                      <div className="text-[11px] text-stone-400 truncate">
                        {t(`adming.mode.${r.mode}`)} · <span data-room-map={r.mapSize}>{t(r.mapSize === 'large' ? 'fps.map.large' : 'fps.map.small')}</span> · {r.maxPlayers}P + {r.maxSpectators}👁 ·{' '}
                        {r.entryCostEc} EC · {nodeName(r.nodeId)}
                      </div>
                    </div>
                    <button
                      className={btn.ghost}
                      disabled={busy}
                      onClick={() => run(() => apiFetch(`${base}/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: JSON.stringify({ isActive: !r.isActive }) }))}
                    >
                      {r.isActive ? t('adming.close') : t('adming.open')}
                    </button>
                    <button className={btn.soft} onClick={() => setForm({ room: r, f: toRoomForm(r) })} data-edit-room={r.roomCode}>
                      {t('adming.edit')}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-stone-400 text-center py-6">{t('adming.noRooms')}</p>
            )}
          </>
        )}

        {form && (
          <div className="space-y-3" data-room-form>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('adming.roomCode')}>
                <input className={`${inputCls} !py-2 uppercase`} value={form.f.roomCode} onChange={(e) => setF('roomCode', e.target.value.toUpperCase())} disabled={!!form.room} name="roomCode" />
              </Field>
              <Field label={t('adming.roomName')}>
                <input className={`${inputCls} !py-2`} value={form.f.name} onChange={(e) => setF('name', e.target.value)} name="roomName" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('adming.roomMode')}>
                <select
                  className={`${inputCls} !py-2`}
                  value={form.f.mode}
                  name="mode"
                  onChange={(e) => {
                    const m = e.target.value as RoomMode;
                    // Suggest the standard map and seat count for the mode (still editable)
                    setForm((s) => (s ? { ...s, f: { ...s.f, mode: m, mapSize: DEFAULT_MAP[m], maxPlayers: String(DEFAULT_PLAYERS[m]), ...(m === 'solo_bot' ? { entryCostEc: '0', maxSpectators: '0' } : {}) } } : s));
                  }}
                >
                  {ROOM_MODES.map((m) => (
                    <option key={m} value={m}>
                      {t(`adming.mode.${m}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('adming.map')}>
                <select className={`${inputCls} !py-2`} value={form.f.mapSize} onChange={(e) => setF('mapSize', e.target.value as MapSize)} name="mapSize">
                  {MAP_SIZES.map((m) => (
                    <option key={m} value={m}>
                      {t(m === 'large' ? 'fps.map.large' : 'fps.map.small')}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t('adming.node')}>
              <select className={`${inputCls} !py-2`} value={form.f.nodeId} onChange={(e) => setF('nodeId', e.target.value)} name="nodeId">
                <option value="">{t('adming.anyNode')}</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.node_name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('adming.maxPlayers')}>
                <input className={`${inputCls} !py-2`} inputMode="numeric" value={form.f.maxPlayers} onChange={(e) => setF('maxPlayers', e.target.value)} name="maxPlayers" />
              </Field>
              <Field label={t('adming.maxSpectators')}>
                <input className={`${inputCls} !py-2`} inputMode="numeric" value={form.f.maxSpectators} onChange={(e) => setF('maxSpectators', e.target.value)} />
              </Field>
              <Field label={t('adming.entryCost')}>
                <input className={`${inputCls} !py-2`} inputMode="numeric" value={form.f.entryCostEc} onChange={(e) => setF('entryCostEc', e.target.value)} name="entryCostEc" />
              </Field>
            </div>
            <Field label={t('adming.rules')}>
              <textarea className={`${inputCls} !py-2 min-h-[64px]`} value={form.f.rules} onChange={(e) => setF('rules', e.target.value)} />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
                <input type="checkbox" className="w-4 h-4 accent-[#FACC15]" checked={form.f.isActive} onChange={(e) => setF('isActive', e.target.checked)} />
                {t('adming.isActive')}
              </label>
              <Field label={t('adming.sortOrder')}>
                <input className={`${inputCls} !py-2 !w-24`} inputMode="numeric" value={form.f.sortOrder} onChange={(e) => setF('sortOrder', e.target.value)} />
              </Field>
            </div>
            <div className="flex justify-between gap-2 pt-1">
              {form.room ? (
                <button
                  className={`${btn.ghost} text-rose-600`}
                  disabled={busy}
                  onClick={async () => {
                    if (await run(() => apiFetch(`${base}/${encodeURIComponent(form.room!.id)}`, { method: 'DELETE' }))) setForm(null);
                  }}
                  data-delete-room
                >
                  {t('adming.deleteRoom')}
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button className={btn.ghost} onClick={() => setForm(null)}>
                  {t('common.cancel')}
                </button>
                <button className={btn.primary} onClick={saveRoom} disabled={busy} data-save-room>
                  {busy ? t('common.saving') : t('common.save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
