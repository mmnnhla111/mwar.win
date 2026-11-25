'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AD_MULT_MAX_PCT,
  AD_MULT_MIN_PCT,
  AD_PREVIEW_COUNTRIES,
  AD_SLOTS,
  AD_SLOT_FORMAT,
  getAdEcProgressPct,
  getEffectiveAdMicroUsd,
  parseAdsterraBanner,
  parseMonetagInpage,
  sanitizeDirectUrl,
} from '@mwar/shared';
import type { AdMode, AdNetworkConfig, AdSlot, AdStats, AdStatsRow } from '@mwar/shared';
import { clearAdConfigCache, getAdminAdConfig, getAdminAdStats, saveAdminAdConfig } from '../../lib/ads';
import { useTranslation } from '../../i18n/I18nProvider';
import { Spinner, btn } from '../ui/Card';

const card = 'bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)]';
const field = 'w-full rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs font-mono text-stone-800 outline-none focus:ring-2 focus:ring-yellow-300';
const POSTBACK_URL =
  'https://api.mwar.win/api/ads/postback/monetag?secret=<AD_POSTBACK_SECRET>&ymid={ymid}&estimated_price={estimated_price}&zone_id={zone_id}';

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro >= 1_000_000 ? 2 : 4)}`;
const num = (n: number) => n.toLocaleString('en-US');

/** /admin → "จัดการโฆษณา (Ad Networks)" — super_admin only (the API enforces it too). */
export function AdNetworksAdmin() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<AdNetworkConfig | null>(null);
  const [draft, setDraft] = useState<AdNetworkConfig | null>(null);
  const [secretSet, setSecretSet] = useState(false);
  const [stats, setStats] = useState<AdStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const [c, s] = await Promise.all([getAdminAdConfig(), getAdminAdStats()]);
      setCfg(c.config);
      setDraft(c.config);
      setSecretSet(c.postbackSecretSet);
      setStats(s);
    } catch (e: any) {
      setMsg(e?.message || t('common.error'));
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<AdNetworkConfig>, okMsg = t('ads.admin.saved')) => {
    setBusy(true);
    setMsg('');
    try {
      const { updatedAt: _u, updatedBy: _b, ...rest } = patch as AdNetworkConfig;
      const r = await saveAdminAdConfig(rest);
      setCfg(r.config);
      setDraft((d) => (d ? { ...r.config, ...pickUnsaved(d, patch) } : r.config));
      clearAdConfigCache();
      setMsg(okMsg);
    } catch (e: any) {
      setMsg(e?.message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const setMode = (mode: AdMode) => {
    if (!cfg || cfg.adMode === mode) return;
    if (mode === 'live' && !window.confirm(t('ads.admin.liveConfirm'))) return;
    save({ adMode: mode }, mode === 'live' ? t('ads.admin.nowLive') : t('ads.admin.nowTest'));
  };

  const dirty = !!(cfg && draft && JSON.stringify({ ...cfg, adMode: 0 }) !== JSON.stringify({ ...draft, adMode: 0 }));
  const up = (p: Partial<AdNetworkConfig>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const upMult = (slot: AdSlot, v: number) => setDraft((d) => (d ? { ...d, multipliers: { ...d.multipliers, [slot]: v } } : d));

  const checks = useMemo(() => {
    if (!draft) return null;
    return {
      b300: !!parseAdsterraBanner(draft.adsterraBanner300x250, 300, 250),
      b320: !!parseAdsterraBanner(draft.adsterraBanner320x50, 320, 50),
      smart: !!sanitizeDirectUrl(draft.adsterraSmartlinkUrl),
      inpage: !!parseMonetagInpage(draft.monetagInpageScript, draft.monetagInpageZoneId),
      direct: !!sanitizeDirectUrl(draft.monetagDirectLinkUrl),
    };
  }, [draft]);

  if (!cfg || !draft || !checks) {
    return (
      <div className={`${card} flex justify-center py-10`}>
        {msg ? <p className="text-sm text-rose-600">{msg}</p> : <Spinner />}
      </div>
    );
  }

  const live = cfg.adMode === 'live';
  const status = (ok: boolean, value: string) => (
    <span className={`text-[10px] font-black ${!value ? 'text-stone-400' : ok ? 'text-emerald-600' : 'text-rose-600'}`}>
      {!value ? t('ads.admin.empty') : ok ? t('ads.admin.valid') : t('ads.admin.invalid')}
    </span>
  );

  return (
    <div className="space-y-4" data-ads-admin>
      {/* Mode */}
      <div className={card}>
        <h2 className="font-extrabold text-stone-900">{t('admin.tab.ads')}</h2>
        <p className="text-xs text-stone-500 mt-1">{t('ads.admin.hint')}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" data-ad-mode={cfg.adMode}>
          {(['test', 'live'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={cfg.adMode === m}
              disabled={busy}
              onClick={() => setMode(m)}
              data-ad-mode-btn={m}
              className={`rounded-2xl border px-4 py-3 text-left text-sm font-bold transition ${
                cfg.adMode === m
                  ? m === 'live'
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800 ring-2 ring-emerald-200'
                    : 'bg-[#FFFBEA] border-yellow-300 text-stone-900 ring-2 ring-yellow-200'
                  : 'bg-white border-stone-200 text-stone-500 hover:text-stone-900'
              }`}
            >
              {m === 'live' ? '🟢 ' : '🧪 '}
              {t(m === 'live' ? 'ads.admin.modeLive' : 'ads.admin.modeTest')}
            </button>
          ))}
        </div>
        {msg && (
          <p className="mt-2 text-xs font-semibold text-amber-700" role="status" data-ads-msg>
            {msg}
          </p>
        )}
      </div>

      {/* Networks */}
      <div className={card}>
        <h3 className="font-extrabold text-stone-900">{t('ads.admin.networks')}</h3>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-bold text-stone-800">
              <input type="checkbox" checked={draft.adsterraEnabled} onChange={(e) => up({ adsterraEnabled: e.target.checked })} data-ads-toggle="adsterra" />
              Adsterra
            </label>
            <div>
              <div className="flex justify-between text-xs font-semibold text-stone-600">
                <span>Banner 300×250</span>
                {status(checks.b300, draft.adsterraBanner300x250)}
              </div>
              <textarea rows={3} className={field} value={draft.adsterraBanner300x250} onChange={(e) => up({ adsterraBanner300x250: e.target.value })} placeholder={t('ads.admin.snippetPh')} data-ads-field="b300" />
            </div>
            <div>
              <div className="flex justify-between text-xs font-semibold text-stone-600">
                <span>Banner 320×50</span>
                {status(checks.b320, draft.adsterraBanner320x50)}
              </div>
              <textarea rows={3} className={field} value={draft.adsterraBanner320x50} onChange={(e) => up({ adsterraBanner320x50: e.target.value })} placeholder={t('ads.admin.snippetPh')} data-ads-field="b320" />
            </div>
            <div>
              <div className="flex justify-between text-xs font-semibold text-stone-600">
                <span>Smartlink URL</span>
                {status(checks.smart, draft.adsterraSmartlinkUrl)}
              </div>
              <input className={field} value={draft.adsterraSmartlinkUrl} onChange={(e) => up({ adsterraSmartlinkUrl: e.target.value })} placeholder="https://…" data-ads-field="smart" />
            </div>
          </div>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-bold text-stone-800">
              <input type="checkbox" checked={draft.monetagEnabled} onChange={(e) => up({ monetagEnabled: e.target.checked })} data-ads-toggle="monetag" />
              Monetag
            </label>
            <div>
              <div className="flex justify-between text-xs font-semibold text-stone-600">
                <span>In-Page Push — Zone ID</span>
                {status(checks.inpage, draft.monetagInpageZoneId || draft.monetagInpageScript)}
              </div>
              <input className={field} inputMode="numeric" value={draft.monetagInpageZoneId} onChange={(e) => up({ monetagInpageZoneId: e.target.value.replace(/\D/g, '') })} data-ads-field="zone" />
              <textarea rows={3} className={`${field} mt-1.5`} value={draft.monetagInpageScript} onChange={(e) => up({ monetagInpageScript: e.target.value })} placeholder={t('ads.admin.snippetPh')} data-ads-field="inpage" />
            </div>
            <div>
              <div className="flex justify-between text-xs font-semibold text-stone-600">
                <span>Direct Link URL</span>
                {status(checks.direct, draft.monetagDirectLinkUrl)}
              </div>
              <input className={field} value={draft.monetagDirectLinkUrl} onChange={(e) => up({ monetagDirectLinkUrl: e.target.value })} placeholder="https://…" data-ads-field="direct" />
            </div>
            <p className="text-[11px] text-stone-400">{t('ads.admin.directOrder')}</p>
          </div>
        </div>
      </div>

      {/* Multipliers + live preview */}
      <div className={card}>
        <h3 className="font-extrabold text-stone-900">{t('ads.admin.multipliers')}</h3>
        <p className="text-xs text-stone-500 mt-1">{t('ads.admin.multHint', { min: AD_MULT_MIN_PCT, max: AD_MULT_MAX_PCT })}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AD_SLOTS.map((slot) => (
            <label key={slot} className="block rounded-2xl border border-stone-100 bg-stone-50 px-3 py-2">
              <div className="flex items-center justify-between text-xs font-bold text-stone-700">
                <span>{t(`ads.slot.${slot}`)}</span>
                <span className="tabular-nums text-stone-900" data-mult-value={slot}>
                  {draft.multipliers[slot]}%
                </span>
              </div>
              <input
                type="range"
                min={AD_MULT_MIN_PCT}
                max={AD_MULT_MAX_PCT}
                step={5}
                value={draft.multipliers[slot]}
                onChange={(e) => upMult(slot, Number(e.target.value))}
                className="w-full accent-[#FACC15]"
                data-mult-slider={slot}
              />
              <div className="text-[10px] text-stone-400">{t('ads.admin.mappedTo', { f: AD_SLOT_FORMAT[slot] })}</div>
            </label>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto" data-no-swipe>
          <table className="min-w-[640px] w-full text-xs" data-ads-preview>
            <thead>
              <tr className="text-left text-stone-400">
                <th className="py-1.5 pr-2 font-bold">{t('ads.admin.country')}</th>
                {AD_SLOTS.map((slot) => (
                  <th key={slot} className="py-1.5 px-2 font-bold whitespace-nowrap">
                    {t(`ads.slot.${slot}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {AD_PREVIEW_COUNTRIES.map((cc) => (
                <tr key={cc} data-preview-row={cc}>
                  <td className="py-1.5 pr-2 font-black text-stone-800">{cc}</td>
                  {AD_SLOTS.map((slot) => {
                    const micro = getEffectiveAdMicroUsd(cc, slot, draft.multipliers[slot]);
                    return (
                      <td key={slot} className="py-1.5 px-2 tabular-nums whitespace-nowrap" data-preview-cell={`${cc}:${slot}`}>
                        <span className="text-stone-800 font-semibold">{num(micro)} µ$</span>
                        <span className="ml-1 text-[#B08600] font-bold">{getAdEcProgressPct(cc, micro)}% EC</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-stone-400">{t('ads.admin.previewNote')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={btn.primary} disabled={!dirty || busy} onClick={() => save(draft)} data-ads-save>
            {busy ? <Spinner size={14} /> : null} {t('common.save')}
          </button>
          <button className={btn.soft} disabled={!dirty || busy} onClick={() => setDraft(cfg)}>
            {t('ads.admin.reset')}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className={card} data-ads-stats>
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-stone-900">{t('ads.admin.stats')}</h3>
          <button className={btn.ghost} onClick={() => getAdminAdStats().then(setStats).catch(() => {})}>
            {t('common.refresh')}
          </button>
        </div>
        {stats && (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <StatBox label={t('ads.admin.today')} r={stats.today} t={t} data="today" />
              <StatBox label={t('ads.admin.last7')} r={stats.last7} t={t} data="last7" />
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3 text-xs">
              <Breakdown title={t('ads.admin.topCountries')} rows={stats.topCountries.map((r) => ({ k: r.country, ...r }))} />
              <Breakdown title={t('ads.admin.byNetwork')} rows={stats.byNetwork.map((r) => ({ k: r.network, ...r }))} />
              <Breakdown title={t('ads.admin.bySlot')} rows={stats.bySlot.map((r) => ({ k: t(`ads.slot.${r.slot}`), ...r }))} />
            </div>
          </>
        )}
      </div>

      {/* Postback */}
      <div className={card}>
        <h3 className="font-extrabold text-stone-900">{t('ads.admin.postback')}</h3>
        <p className="text-xs text-stone-500 mt-1">{t('ads.admin.postbackHint')}</p>
        <div className="mt-2 flex gap-2 items-stretch">
          <input readOnly value={POSTBACK_URL} className={`${field} flex-1 min-w-0`} onFocus={(e) => e.currentTarget.select()} data-postback-url />
          <button
            className={btn.soft}
            onClick={() => {
              navigator.clipboard?.writeText(POSTBACK_URL).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? t('ads.admin.copied') : t('ads.admin.copy')}
          </button>
        </div>
        <p className={`mt-2 text-[11px] font-semibold ${secretSet ? 'text-emerald-700' : 'text-rose-600'}`} data-postback-secret={secretSet ? 'set' : 'missing'}>
          {secretSet ? t('ads.admin.secretSet') : t('ads.admin.secretMissing')}
        </p>
        <p className="mt-1 text-[11px] text-stone-400">{t('ads.admin.postbackPending')}</p>
      </div>
      {live && <p className="text-center text-[11px] text-emerald-700 font-semibold">{t('ads.admin.liveNote')}</p>}
    </div>
  );
}

/** After saving one field (e.g. the mode), keep the other unsaved edits in the form. */
function pickUnsaved(d: AdNetworkConfig, saved: Partial<AdNetworkConfig>): Partial<AdNetworkConfig> {
  const out: Partial<AdNetworkConfig> = { ...d };
  for (const k of Object.keys(saved) as (keyof AdNetworkConfig)[]) delete out[k];
  delete out.updatedAt;
  delete out.updatedBy;
  delete out.adMode;
  return out;
}

function StatBox({ label, r, t, data }: { label: string; r: AdStatsRow; t: (k: string, v?: any) => string; data: string }) {
  return (
    <div className="rounded-2xl bg-[#FFFBEA] border border-yellow-100 px-4 py-3" data-stat={data}>
      <div className="text-[11px] font-bold text-stone-500">{label}</div>
      <div className="mt-1 grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="font-extrabold text-stone-900 tabular-nums">{num(r.impressions)}</div>
          <div className="text-[10px] text-stone-500">{t('ads.admin.impressions')}</div>
        </div>
        <div>
          <div className="font-extrabold text-stone-900 tabular-nums">{usd(r.estMicroUsd)}</div>
          <div className="text-[10px] text-stone-500">{t('ads.admin.estUsd')}</div>
        </div>
        <div>
          <div className="font-extrabold text-stone-900 tabular-nums">{(r.ecBp / 10_000).toFixed(2)}</div>
          <div className="text-[10px] text-stone-500">{t('ads.admin.ecCredited')}</div>
        </div>
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: (AdStatsRow & { k: string })[] }) {
  return (
    <div className="rounded-2xl border border-stone-100 p-3">
      <div className="text-[11px] font-black uppercase tracking-wider text-stone-400">{title}</div>
      {rows.length === 0 && <div className="py-2 text-stone-400">–</div>}
      {rows.map((r) => (
        <div key={r.k} className="flex items-center justify-between py-1 gap-2">
          <span className="font-bold text-stone-700 truncate">{r.k}</span>
          <span className="tabular-nums text-stone-500 whitespace-nowrap">
            {num(r.impressions)} · {usd(r.estMicroUsd)} · {(r.ecBp / 10_000).toFixed(2)} EC
          </span>
        </div>
      ))}
    </div>
  );
}
