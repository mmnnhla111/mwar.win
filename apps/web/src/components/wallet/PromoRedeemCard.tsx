'use client';

import React, { useState } from 'react';
import { formatCoins2, PROMO_CODE_RE } from '@mwar/shared';
import { useTranslation } from '../../i18n/I18nProvider';
import { getDeviceFp } from '../../lib/referral';
import { redeemPromo } from '../../lib/liveEconomy';
import { useSession } from '../../lib/session';
import { btn, inputCls } from '../ui/Card';

/** V1.2 C launch promo code (e.g. MWAR500): 1 per account and per device → 1 EC ticket backed by the marketing pool. */
export function PromoRedeemCard() {
  const { t } = useTranslation();
  const { refresh } = useSession();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = PROMO_CODE_RE.test(code);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const fp = await getDeviceFp();
      const r = await redeemPromo(code, fp);
      setMsg({ ok: true, text: t('promo.success', { v: formatCoins2(r.ticketMicroUsd), n: r.energyTickets }) });
      setCode('');
      void refresh?.(true);
    } catch (err: any) {
      const key = typeof err?.code === 'string' && err.code.startsWith('PROMO_') ? `promo.err.${err.code.slice(6).toLowerCase()}` : '';
      const known = ['promo.err.inactive', 'promo.err.expired', 'promo.err.cap', 'promo.err.user', 'promo.err.device', 'promo.err.pool_empty', 'promo.err.ec_full'];
      setMsg({ ok: false, text: known.includes(key) ? t(key) : err?.message || t('promo.failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-2" data-promo-card>
      <div className="flex items-center justify-between">
        <span className="text-xs font-extrabold text-stone-500 uppercase tracking-wider">🎟️ {t('promo.title')}</span>
      </div>
      <p className="text-[11px] text-stone-500">{t('promo.hint')}</p>
      <div className="flex gap-2">
        <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20))} placeholder="MWAR500" aria-label={t('promo.title')} />
        <button type="submit" className={btn.primary} disabled={!valid || busy}>
          {busy ? '…' : t('promo.redeem')}
        </button>
      </div>
      {msg && <p className={`text-xs font-semibold ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>{msg.text}</p>}
    </form>
  );
}
