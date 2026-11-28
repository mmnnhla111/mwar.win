'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from 'colyseus.js';
import { SPECTATOR_GIFTS, formatCoins2, splitGift, type PaidGiftCode } from '@mwar/shared';
import { useTranslation } from '../../i18n/I18nProvider';
import { useDirectLinkVisit } from '../ad-networks/DirectLinkVisit';
import { newGiftRequestId, sendAmmoBox, sendPaidGift } from '../../lib/liveEconomy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Candidate {
  sid: string;
  userId: string;
  username: string;
  alive: boolean;
}

/**
 * V1.2 C Ghost Spectator gift drawer (TikTok-Live style). Targets the player the spectator is watching (nearest to
 * the camera, switchable). Free Ammo Box = a 15 s rewarded visit (credits the spectator's own EC progress; the box
 * itself moves no money); Golden Grenade 100 C / Champion Crown 500 C are paid from the wallet (70 % to the player,
 * 30 % platform) — the Worker charges atomically, then signs a gift token this drawer forwards to the game server.
 */
export function SpectatorGiftDrawer({
  room,
  signedIn,
  getWatchedSessionId,
  onToast,
  compact = false,
}: {
  room: Room | null;
  signedIn: boolean;
  getWatchedSessionId?: () => string | null;
  onToast: (msg: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [targetSid, setTargetSid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PaidGiftCode | null>(null);
  const [busy, setBusy] = useState(false);
  const adToken = useRef<string | null>(null);
  const reqIds = useRef<Partial<Record<PaidGiftCode, string>>>({});
  const targetRef = useRef<Candidate | null>(null);

  const scan = useCallback(() => {
    const st = room?.state as any;
    if (!st?.players) return;
    const list: Candidate[] = [];
    st.players.forEach((p: any, sid: string) => {
      if (p.isSpectator || p.isBot || !UUID_RE.test(String(p.id || ''))) return;
      list.push({ sid, userId: String(p.id), username: String(p.username || '?'), alive: !p.isGhost });
    });
    list.sort((a, b) => Number(b.alive) - Number(a.alive) || a.username.localeCompare(b.username));
    setCandidates(list);
    setTargetSid((cur) => (cur && list.some((c) => c.sid === cur) ? cur : list[0]?.sid ?? null));
  }, [room]);

  useEffect(() => {
    if (!open) return;
    const w = getWatchedSessionId?.();
    scan();
    if (w) setTargetSid(w);
    const id = window.setInterval(scan, 2000);
    return () => window.clearInterval(id);
  }, [open, scan, getWatchedSessionId]);

  const target = candidates.find((c) => c.sid === targetSid) || null;
  targetRef.current = target;

  const forward = (giftToken: string) => room?.send('spectator_gift', { token: giftToken });

  const onAdDone = useCallback(async () => {
    const tok = adToken.current;
    adToken.current = null;
    if (!tok || !room) return;
    try {
      const r = await sendAmmoBox({ roomId: room.roomId, receiverUserId: targetRef.current?.userId ?? null, adToken: tok });
      forward(r.giftToken);
      onToast(t('gift.sentAmmo', { name: targetRef.current?.username || t('gift.everyone') }));
    } catch (e: any) {
      onToast(e?.message || t('gift.failed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, onToast, t]);
  const { visit, begin, markOpened, reset } = useDirectLinkVisit(() => void onAdDone());

  const watchAd = async () => {
    if (!signedIn) return onToast(t('gift.signIn'));
    try {
      const r = await begin({ purpose: 'ec_recharge', seconds: 15 });
      adToken.current = r.token;
    } catch (e: any) {
      onToast(e?.code === 'AD_MODE_TEST' ? t('gift.adsTestMode') : e?.message || t('gift.failed'));
    }
  };

  const sendPaid = async (code: PaidGiftCode) => {
    if (!room || !target || busy) return;
    setBusy(true);
    const clientRequestId = (reqIds.current[code] ||= newGiftRequestId());
    try {
      const r = await sendPaidGift({ giftCode: code, roomId: room.roomId, receiverUserId: target.userId, clientRequestId });
      forward(r.giftToken);
      delete reqIds.current[code];
      onToast(t('gift.sentPaid', { gift: t(`gift.name.${code}`), name: target.username, v: formatCoins2(r.receiverMicroUsd) }));
      setConfirm(null);
    } catch (e: any) {
      if (e?.code !== 'DUPLICATE') delete reqIds.current[code];
      onToast(e?.code === 'INSUFFICIENT' ? t('gift.insufficient') : e?.code === 'NOT_IN_ROOM' ? t('gift.notInRoom') : e?.message || t('gift.failed'));
    } finally {
      setBusy(false);
    }
  };

  const away = visit.kind === 'away' || visit.kind === 'starting' || visit.kind === 'claiming';

  return (
    <div className="pointer-events-auto" data-gift-drawer>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full bg-gradient-to-r from-pink-500 to-amber-400 text-white font-black shadow-lg shadow-pink-500/30 border border-white/40 ${compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'}`}
        aria-expanded={open}
      >
        🎁 {t('gift.open')}
      </button>
      {open && (
        <div className="mt-2 w-[min(92vw,340px)] rounded-2xl bg-slate-950/92 backdrop-blur-md border border-pink-400/40 p-3 text-white shadow-2xl space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-pink-200">{t('gift.title')}</span>
            <button type="button" className="text-white/60 hover:text-white text-sm" onClick={() => setOpen(false)} aria-label={t('gift.close')}>
              ✕
            </button>
          </div>
          <div>
            <div className="text-[10px] font-bold text-white/50 mb-1">{t('gift.target')}</div>
            {candidates.length === 0 ? (
              <p className="text-[11px] text-white/60">{t('gift.noPlayers')}</p>
            ) : (
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
                {candidates.map((c) => (
                  <button
                    key={c.sid}
                    type="button"
                    onClick={() => setTargetSid(c.sid)}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold border ${c.sid === targetSid ? 'bg-pink-500 border-pink-300' : 'bg-white/10 border-white/15'} ${c.alive ? '' : 'opacity-60'}`}
                  >
                    {c.username}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Free Ammo Box (ad) */}
          <button
            type="button"
            disabled={away}
            onClick={watchAd}
            className="w-full flex items-center justify-between rounded-xl bg-white/10 hover:bg-white/15 px-3 py-2 disabled:opacity-60"
          >
            <span className="text-sm font-bold">
              {SPECTATOR_GIFTS.ammo_box_ad.emoji} {t('gift.name.ammo_box_ad')}
            </span>
            <span className="text-[11px] font-black text-emerald-300">{away ? t('gift.watching') : t('gift.freeAd')}</span>
          </button>
          {visit.kind === 'away' && !visit.opened && (
            <a href={visit.launchUrl} target="_blank" rel="noopener noreferrer" onClick={markOpened} className="block text-center text-[11px] font-bold text-sky-300 underline">
              {t('gift.openAd')}
            </a>
          )}
          {visit.kind === 'error' && (
            <button type="button" onClick={reset} className="block w-full text-[11px] text-rose-300">
              {visit.code === 'AD_MODE_TEST' ? t('gift.adsTestMode') : visit.message}
            </button>
          )}
          <p className="text-[10px] text-white/45">{t('gift.ammoHint')}</p>
          {/* Paid gifts */}
          {(['golden_grenade_100', 'champion_crown_500'] as const).map((code) => {
            const g = SPECTATOR_GIFTS[code];
            const s = splitGift(g.priceMicroUsd);
            return (
              <div key={code} className="rounded-xl bg-white/10 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">
                    {g.emoji} {t(`gift.name.${code}`)}
                  </span>
                  <span className="text-[11px] font-black text-amber-300">{formatCoins2(g.priceMicroUsd)}</span>
                </div>
                {confirm === code ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="flex-1 text-[10px] text-white/70">{t('gift.confirm', { name: target?.username || '?', v: formatCoins2(s.receiverMicroUsd) })}</span>
                    <button type="button" disabled={busy || !target} onClick={() => sendPaid(code)} className="rounded-full bg-amber-400 text-slate-950 text-[11px] font-black px-3 py-1 disabled:opacity-50">
                      {busy ? '…' : t('gift.send')}
                    </button>
                    <button type="button" onClick={() => setConfirm(null)} className="text-[11px] text-white/60">
                      {t('gift.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={!target || !signedIn}
                    onClick={() => setConfirm(code)}
                    className="mt-1.5 w-full rounded-full bg-amber-400/90 text-slate-950 text-[11px] font-black py-1 disabled:opacity-40"
                  >
                    {signedIn ? t('gift.sendTo', { name: target?.username || '?' }) : t('gift.signIn')}
                  </button>
                )}
              </div>
            );
          })}
          <p className="text-[10px] text-white/45">{t('gift.splitHint')}</p>
        </div>
      )}
    </div>
  );
}
