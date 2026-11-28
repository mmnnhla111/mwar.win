'use client';

/**
 * V1.1 Round 2 — Death & Round Summary overlay for server rooms (no automatic respawn).
 *  · Paid-EC room seat (mode 'restake'): round summary in C + $, head bounty status, "Play again?" with the
 *    exact cost (1 EC) and the player's balance X / 300 EC → "Play again (-1 EC)" (a NEW ticket through the
 *    Worker; disabled at 0 EC with "Charge EC") or "Back to Lobby".
 *  · Fast & Mini / unpaid seat (mode 'free'): round summary + "Play again free (0 EC)" / "Back to Lobby".
 * The banner ad slot is rendered by the game page at the bottom of the screen (above this overlay).
 */
import React, { useEffect, useState } from 'react';
import { formatCoins2, formatUsdPrecise } from '@mwar/shared';
import { useTranslation } from '../../i18n/I18nProvider';

export interface DeathPromptData {
  mode: 'restake' | 'free';
  fastMini: boolean;
  killer: string | null;
  kills: number;
  earningsMicroUsd: number;
  bountyMicroUsd: number;
  bountyLostMicroUsd: number;
  /** Ticket value this life carried (now taken by the killer, or inside the death chest). */
  stakeLostMicroUsd?: number;
  /** ms epoch when the free "Play again" unlocks (server minimum 3 s). */
  freeAt: number;
}

const money = (v: number) => (
  <>
    <span className="tabular-nums">{formatCoins2(v)}</span> <span className="text-slate-400 font-semibold tabular-nums">({formatUsdPrecise(v)})</span>
  </>
);

export function DeathSummaryOverlay({
  data,
  energyTickets,
  maxEnergyTickets,
  ecChargedPct,
  ecSpent,
  potMicroUsd,
  busy,
  error,
  bottomPad,
  onRestake,
  onFreePlay,
  onCharge,
  onLobby,
}: {
  data: DeathPromptData;
  energyTickets: number;
  maxEnergyTickets: number;
  ecChargedPct: number;
  ecSpent: number;
  potMicroUsd: number;
  busy: boolean;
  error: string | null;
  bottomPad: number;
  onRestake: () => void;
  onFreePlay: () => void;
  onCharge: () => void;
  onLobby: () => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const freeIn = Math.max(0, Math.ceil((data.freeAt - now) / 1000));
  const paid = data.mode === 'restake';
  const noEc = paid && energyTickets <= 0;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className="absolute inset-0 z-[40] flex items-center justify-center bg-slate-950/70 backdrop-blur-[2px] pointer-events-auto p-3 overflow-y-auto"
      style={{ paddingBottom: bottomPad + 12 }}
      onMouseDown={stop}
      onTouchStart={stop}
      onClick={stop}
      data-death-overlay={data.mode}
    >
      <div className="w-full max-w-sm rounded-3xl border border-rose-500/50 bg-slate-950/95 shadow-2xl overflow-hidden">
        <div className="px-5 pt-4 pb-3 text-center border-b border-slate-800">
          <div className="text-rose-400 font-black text-xl tracking-widest">{t('death.title')}</div>
          {data.killer && <div className="text-slate-300 text-xs font-bold mt-0.5">{t('death.byKiller', { name: data.killer })}</div>}
          {(() => {
            // §8: what this life carried — "คุณถือ X C — ถูก <killer> เก็บไป" (suicide / fall: it waits in the chest)
            const held = Math.max(0, Number(data.stakeLostMicroUsd) || 0) + Math.max(0, data.bountyLostMicroUsd || 0);
            if (held <= 0) return null;
            return (
              <div className="mt-1 text-[11px] font-black text-amber-300" data-death-held>
                {data.killer ? t('death.heldTaken', { v: formatCoins2(held), name: data.killer }) : t('death.heldChest', { v: formatCoins2(held) })}
              </div>
            );
          })()}
          {data.fastMini && <div className="mt-1 text-[11px] font-bold text-sky-300">{t('fastmini.freeMode')}</div>}
        </div>

        {/* Top summary card */}
        <div className="px-5 py-3 space-y-1.5 text-xs" data-death-summary>
          <div className="text-[10px] font-black tracking-widest text-slate-500 uppercase">{t('death.summaryTitle')}</div>
          <Row label={t('death.kills')} value={<span className="tabular-nums">{data.kills}</span>} />
          <Row label={t('death.earned')} value={money(data.earningsMicroUsd)} accent />
          <Row label={t('death.ecUsed')} value={<span className="tabular-nums">{ecSpent} EC</span>} />
          <Row label={t('death.ecCharged')} value={<span className="tabular-nums">+{(Math.floor(ecChargedPct * 10) / 10).toFixed(1)}%</span>} />
          {data.fastMini ? (
            <Row label={t('fastmini.pot')} value={money(potMicroUsd)} />
          ) : (
            <Row
              label={t('death.bounty')}
              value={
                data.bountyLostMicroUsd > 0 ? (
                  <span className="text-rose-300">{t('death.bountyLost', { v: formatCoins2(data.bountyLostMicroUsd) })}</span>
                ) : data.bountyMicroUsd > 0 ? (
                  <span>{t('death.bountyKept', { v: formatCoins2(data.bountyMicroUsd) })}</span>
                ) : (
                  <span className="text-slate-400">{t('death.bountyNone')}</span>
                )
              }
            />
          )}
        </div>

        {/* Continue prompt */}
        <div className="px-5 pb-4 pt-1 space-y-2.5 text-center">
          <div className="text-white font-black text-base">{t('death.question')}</div>
          {paid ? (
            <div className="text-[11px] font-bold text-amber-200" data-ec-cost>
              ⚡ {t('death.ticketCost')} · {t('death.balance', { n: `${energyTickets} / ${maxEnergyTickets} EC` })}
            </div>
          ) : (
            <div className="text-[11px] font-bold text-emerald-300">{data.fastMini ? t('fastmini.freeCost') : t('death.unpaidHint')}</div>
          )}
          {noEc && <div className="text-[11px] font-semibold text-rose-300">{t('death.noEc')}</div>}
          {error && <div className="text-[11px] font-semibold text-rose-300" role="alert">{error}</div>}
          <div className="grid grid-cols-1 gap-2">
            {paid ? (
              <>
                <button
                  type="button"
                  data-action="restake"
                  disabled={busy || noEc}
                  onClick={onRestake}
                  className={`w-full py-2.5 rounded-xl text-sm font-black transition ${busy || noEc ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-amber-400 hover:bg-amber-300 text-slate-950'}`}
                >
                  {busy ? t('death.working') : t('death.playAgain')}
                </button>
                {noEc && (
                  <button type="button" data-action="charge" onClick={onCharge} className="w-full py-2.5 rounded-xl text-sm font-black bg-emerald-400 hover:bg-emerald-300 text-slate-950 transition">
                    ▶ {t('death.charge')}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                data-action="play-free"
                disabled={freeIn > 0 || busy}
                onClick={onFreePlay}
                className={`w-full py-2.5 rounded-xl text-sm font-black transition ${freeIn > 0 || busy ? 'bg-slate-800 text-slate-500' : 'bg-emerald-400 hover:bg-emerald-300 text-slate-950'}`}
              >
                {freeIn > 0 ? t('death.freeIn', { s: freeIn }) : data.fastMini ? t('fastmini.playAgainFree') : t('death.playAgainFree')}
              </button>
            )}
            <button type="button" data-action="lobby" onClick={onLobby} className="w-full py-2.5 rounded-xl text-sm font-black bg-slate-800 hover:bg-slate-700 text-white transition">
              {t('death.lobby')}
            </button>
          </div>
          <div className="text-[10px] text-slate-500 font-semibold">{t('death.bannerHint')}</div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-400 font-semibold">{label}</span>
      <span className={`font-black text-right ${accent ? 'text-emerald-300' : 'text-white'}`}>{value}</span>
    </div>
  );
}
