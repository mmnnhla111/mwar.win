'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  COLD_START_TARGET_BOTS_MAX,
  COLD_START_TARGET_BOTS_MIN,
  PROMO_DEFAULT_BACKED_MICRO_USD,
  PROMO_MAX_REDEMPTIONS,
  SKIN_MARKET_FEE_PCT_MAX,
  SKIN_MARKET_FEE_PCT_MIN,
  STREAMER_SHARE_PCT_MAX,
  STREAMER_SHARE_PCT_MIN,
  formatCoinsAndUsd,
  type ColdStartAdminStatus,
  type ColdStartSettingsUpdate,
} from '@mwar/shared';
import { Card, Spinner, btn, inputCls } from '../ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';
import { createPromoCode, depositMarketingPool, getColdStartAdmin, saveColdStartSettings, setPromoCodeActive } from '../../lib/liveEconomy';

/**
 * V1.2 C cold-start tools (/admin → Game & Rooms; super_admin / ops_manager): Smart Bot Fill, Happy Hour 2x,
 * Streamer share, skin market fee, marketing pool + launch promo codes. Every change is audited by the Worker.
 */
export function ColdStartAdmin() {
  const { t } = useTranslation();
  const [s, setS] = useState<ColdStartAdminStatus | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [deposit, setDeposit] = useState('');
  const [code, setCode] = useState('MWAR500');
  const [backedC, setBackedC] = useState(String(PROMO_DEFAULT_BACKED_MICRO_USD / 100));
  const [maxRed, setMaxRed] = useState(String(PROMO_MAX_REDEMPTIONS));
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await getColdStartAdmin());
    } catch (e: any) {
      // roles without the cold-start permission (e.g. admin) simply do not see this card
      if (e?.status === 403) setHidden(true);
      else setErr(e?.message || t('adminm.loadFailed'));
    }
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<ColdStartAdminStatus>, ok: string) => {
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      setS(await fn());
      setMsg(ok);
    } catch (e: any) {
      setErr(e?.message || t('cold.failed'));
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: ColdStartSettingsUpdate) => run(() => saveColdStartSettings(patch), t('cold.saved'));

  if (hidden) return null;
  if (!s) {
    return (
      <Card className="p-4">
        {err ? <p className="text-sm text-rose-600 font-semibold">{err}</p> : <Spinner size={20} />}
      </Card>
    );
  }
  const cfg = s.settings;
  return (
    <Card className="p-4 space-y-4" data-cold-start-admin>
      <div>
        <h3 className="font-extrabold text-stone-900">🚀 {t('cold.title')}</h3>
        <p className="text-xs text-stone-500">{t('cold.hint')}</p>
      </div>
      {(msg || err) && <p className={`rounded-2xl text-sm font-semibold px-4 py-2 ${err ? 'bg-[#FFE4E6] text-rose-600' : 'bg-[#D1FAE5] text-emerald-700'}`}>{err || msg}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-stone-50 p-3">
          <div className="text-[11px] font-bold text-stone-500">{t('cold.bossPool')}</div>
          <div className="font-extrabold text-stone-900">{formatCoinsAndUsd(s.pools.bossBountyPoolMicroUsd)}</div>
          <div className="text-[11px] text-stone-500">{t('cold.botReserved', { n: s.pools.botReservedCount, v: formatCoinsAndUsd(s.pools.botReservedMicroUsd) })}</div>
        </div>
        <div className="rounded-2xl bg-stone-50 p-3">
          <div className="text-[11px] font-bold text-stone-500">{t('cold.marketingPool')}</div>
          <div className="font-extrabold text-stone-900">{formatCoinsAndUsd(s.pools.marketingPoolMicroUsd)}</div>
          <div className="mt-1.5 flex gap-1.5">
            <input className={`${inputCls} !py-1.5`} inputMode="decimal" placeholder={t('cold.depositC')} value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            <button
              className={btn.dark}
              disabled={busy || !(Number(deposit) > 0)}
              onClick={() => run(() => depositMarketingPool(Math.round(Number(deposit) * 100)), t('cold.deposited'))}
            >
              {t('cold.deposit')}
            </button>
          </div>
          <div className="text-[10px] text-stone-400 mt-1">{t('cold.depositHint')}</div>
        </div>
      </div>

      {/* Smart Bot Fill */}
      <div className="rounded-2xl border border-stone-200 p-3 space-y-2">
        <label className="flex items-center justify-between gap-2">
          <span className="font-bold text-sm text-stone-800">🤖 {t('cold.botFill')}</span>
          <input type="checkbox" checked={cfg.botFill.enabled} disabled={busy} onChange={(e) => save({ botFillEnabled: e.target.checked })} />
        </label>
        <label className="flex items-center gap-2 text-xs text-stone-600">
          {t('cold.targetBots')}
          <select className="rounded-xl border border-stone-200 px-2 py-1" value={cfg.botFill.targetBots} disabled={busy} onChange={(e) => save({ targetBots: Number(e.target.value) })}>
            {Array.from({ length: COLD_START_TARGET_BOTS_MAX - COLD_START_TARGET_BOTS_MIN + 1 }, (_, i) => COLD_START_TARGET_BOTS_MIN + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-stone-500">{t('cold.botHint')}</p>
      </div>

      {/* Happy Hour */}
      <div className="rounded-2xl border border-stone-200 p-3 space-y-2">
        <label className="flex items-center justify-between gap-2">
          <span className="font-bold text-sm text-stone-800">
            🔥 {t('cold.happyHour')} {cfg.happyHour.active && <span className="text-orange-600">· {t('cold.activeNow')}</span>}
          </span>
          <input type="checkbox" checked={cfg.happyHour.enabled} disabled={busy} onChange={(e) => save({ happyHourEnabled: e.target.checked })} />
        </label>
        <HappyHourTimes start={cfg.happyHour.start} end={cfg.happyHour.end} tz={cfg.happyHour.tzOffsetMinutes} busy={busy} onSave={(a, b, tz) => save({ happyHourStart: a, happyHourEnd: b, happyHourTzOffsetMinutes: tz })} />
        <p className="text-[11px] text-stone-500">{t('cold.happyHint')}</p>
      </div>

      {/* Streamer share + skin fee */}
      <div className="grid gap-3 sm:grid-cols-2">
        <PctField label={t('cold.streamerShare')} hint={t('cold.streamerHint')} value={cfg.streamerSharePct} min={STREAMER_SHARE_PCT_MIN} max={STREAMER_SHARE_PCT_MAX} busy={busy} onSave={(v) => save({ streamerSharePct: v })} />
        <PctField label={t('cold.skinFee')} hint={t('cold.skinFeeHint')} value={cfg.skinMarketFeePct} min={SKIN_MARKET_FEE_PCT_MIN} max={SKIN_MARKET_FEE_PCT_MAX} busy={busy} onSave={(v) => save({ skinMarketFeePct: v })} />
      </div>

      {/* Promo codes */}
      <div className="rounded-2xl border border-stone-200 p-3 space-y-2">
        <div className="font-bold text-sm text-stone-800">🎟️ {t('cold.promoTitle')}</div>
        <div className="grid gap-2 sm:grid-cols-4">
          <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20))} placeholder="MWAR500" />
          <input className={inputCls} inputMode="decimal" value={backedC} onChange={(e) => setBackedC(e.target.value)} placeholder={t('cold.backedC')} title={t('cold.backedC')} />
          <input className={inputCls} inputMode="numeric" value={maxRed} onChange={(e) => setMaxRed(e.target.value)} placeholder={t('cold.maxRedemptions')} title={t('cold.maxRedemptions')} />
          <button
            className={btn.primary}
            disabled={busy || code.length < 4}
            onClick={() =>
              run(
                () =>
                  createPromoCode({
                    code,
                    backedMicroUsdPerTicket: Math.max(0, Math.round(Number(backedC) * 100)),
                    maxRedemptions: Math.min(PROMO_MAX_REDEMPTIONS, Math.max(1, Math.floor(Number(maxRed) || PROMO_MAX_REDEMPTIONS))),
                  }),
                t('cold.promoCreated')
              )
            }
          >
            {t('cold.createCode')}
          </button>
        </div>
        <p className="text-[11px] text-stone-500">{t('cold.promoHint')}</p>
        <div className="divide-y divide-stone-100">
          {s.promoCodes.length === 0 && <p className="text-xs text-stone-400 py-2">{t('cold.noCodes')}</p>}
          {s.promoCodes.map((p) => (
            <div key={p.code} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="font-extrabold text-stone-900">{p.code}</span>{' '}
                <span className="text-xs text-stone-500">
                  {t('cold.codeLine', { used: p.redeemedCount, max: p.maxRedemptions, v: formatCoinsAndUsd(p.backedMicroUsdPerTicket) })}
                </span>
              </div>
              <button className={btn.soft} disabled={busy} onClick={() => run(() => setPromoCodeActive(p.code, !p.isActive), t('cold.saved'))}>
                {p.isActive ? t('cold.deactivate') : t('cold.activate')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function PctField({ label, hint, value, min, max, busy, onSave }: { label: string; hint: string; value: number; min: number; max: number; busy: boolean; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Math.floor(Number(v));
  const ok = Number.isFinite(n) && n >= min && n <= max && n !== value;
  return (
    <div className="rounded-2xl border border-stone-200 p-3 space-y-1.5">
      <div className="font-bold text-sm text-stone-800">{label}</div>
      <div className="flex gap-1.5 items-center">
        <input className={`${inputCls} !py-1.5`} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} />
        <span className="text-sm text-stone-500">%</span>
        <button className={btn.dark} disabled={busy || !ok} onClick={() => onSave(n)}>
          ✓
        </button>
      </div>
      <p className="text-[11px] text-stone-500">{hint}</p>
    </div>
  );
}

function HappyHourTimes({ start, end, tz, busy, onSave }: { start: string; end: string; tz: number; busy: boolean; onSave: (a: string, b: string, tz: number) => void }) {
  const { t } = useTranslation();
  const [a, setA] = useState(start);
  const [b, setB] = useState(end);
  const [z, setZ] = useState(String(tz / 60));
  useEffect(() => {
    setA(start);
    setB(end);
    setZ(String(tz / 60));
  }, [start, end, tz]);
  const tzMin = Math.round(Number(z) * 60);
  const changed = a !== start || b !== end || tzMin !== tz;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
      <input type="time" className="rounded-xl border border-stone-200 px-2 py-1" value={a} onChange={(e) => setA(e.target.value)} />
      <span>→</span>
      <input type="time" className="rounded-xl border border-stone-200 px-2 py-1" value={b} onChange={(e) => setB(e.target.value)} />
      <span>{t('cold.utcOffset')}</span>
      <input className="w-16 rounded-xl border border-stone-200 px-2 py-1" inputMode="decimal" value={z} onChange={(e) => setZ(e.target.value)} />
      <button className={btn.dark} disabled={busy || !changed || a === b || !Number.isFinite(tzMin)} onClick={() => onSave(a, b, tzMin)}>
        ✓
      </button>
    </div>
  );
}
