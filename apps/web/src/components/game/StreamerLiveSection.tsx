'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fpsLaunchUrl, type FpsRoomLive, type StreamerStatus } from '@mwar/shared';
import { Card, btn, inputCls } from '../ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';
import { closeStreamerRoom, getStreamerStatus, openStreamerRoom } from '../../lib/liveEconomy';

/**
 * V1.2 C "🔴 LIVE สตรีมเมอร์" lobby section: live Streamer Showcase Rooms (watch / join) + "Go live" for a Silver I+
 * player (the streamer earns a share of the VERIFIED ad value of spectators in their room).
 */
export function StreamerLiveSection({ rooms, signedIn, onChanged }: { rooms: FpsRoomLive[]; signedIn: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [me, setMe] = useState<StreamerStatus | null>(null);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'skirmish' | 'fast_mini'>('skirmish');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!signedIn) return;
    try {
      setMe(await getStreamerStatus());
    } catch {
      setMe(null);
    }
  }, [signedIn]);
  useEffect(() => {
    load();
  }, [load]);

  const goLive = async () => {
    setBusy(true);
    setErr('');
    try {
      setMe(await openStreamerRoom(title.trim() || t('streamer.defaultTitle'), mode));
      onChanged();
    } catch (e: any) {
      setErr(e?.code === 'RANK_TOO_LOW' ? t('streamer.rankTooLow') : e?.message || t('streamer.failed'));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!me?.room) return;
    setBusy(true);
    try {
      setMe(await closeStreamerRoom(me.room.roomCode));
      onChanged();
    } catch (e: any) {
      setErr(e?.message || t('streamer.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (!rooms.length && !me?.eligible && !me?.room) return null;
  return (
    <Card className="p-3 sm:p-4 border-rose-200 bg-gradient-to-br from-[#FFF1F2] to-white" data-streamer-live>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="font-extrabold text-rose-600 flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" /> {t('streamer.sectionTitle')}
        </h2>
        {me && <span className="text-[11px] font-bold text-stone-500">{t('streamer.shareNote', { pct: me.sharePct })}</span>}
      </div>
      {rooms.length === 0 ? (
        <p className="text-sm text-stone-500 py-1">{t('streamer.none')}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {rooms.map((r) => (
            <div key={r.id} className="rounded-2xl bg-white border border-rose-100 p-3" data-streamer-room={r.id}>
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-rose-500 text-white text-[10px] font-black px-1.5 py-0.5">LIVE</span>
                <span className="font-extrabold text-stone-900 truncate">{r.name}</span>
              </div>
              <div className="text-[11px] text-stone-500 mt-0.5">
                🎙️ {r.streamerUsername || '?'} · {t('streamer.counts', { p: r.players, s: r.spectators })}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button className={`${btn.dark} !py-1.5`} onClick={() => router.push(fpsLaunchUrl(r, true))}>
                  👁️ {t('streamer.watch')}
                </button>
                <button className={`${btn.primary} !py-1.5`} disabled={r.isFull} onClick={() => router.push(fpsLaunchUrl(r))}>
                  {t('streamer.join', { n: r.costEc })}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {me?.room ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-bold text-stone-800">{t('streamer.yourRoom', { code: me.room.roomCode })}</span>
          <button className={btn.primary} onClick={() => router.push(fpsLaunchUrl({ id: me.room!.roomCode, mode: me.room!.mode === 'fast_mini' ? 'fast_mini' : 'mini_30', mapSize: 'small' }))}>
            {t('streamer.enter')}
          </button>
          <button className={btn.soft} disabled={busy} onClick={stop}>
            {t('streamer.end')}
          </button>
        </div>
      ) : me?.eligible ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className={`${inputCls} !py-2 flex-1 min-w-[160px]`} maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('streamer.titlePlaceholder')} />
          <select className="rounded-2xl border border-stone-200 px-3 py-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value === 'fast_mini' ? 'fast_mini' : 'skirmish')}>
            <option value="skirmish">{t('streamer.modeSkirmish')}</option>
            <option value="fast_mini">{t('streamer.modeFastMini')}</option>
          </select>
          <button className={btn.primary} disabled={busy} onClick={goLive}>
            🔴 {t('streamer.goLive')}
          </button>
        </div>
      ) : null}
      {err && <p className="mt-2 text-xs font-semibold text-rose-600">{err}</p>}
    </Card>
  );
}
