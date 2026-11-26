'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  CASHOUT_MIN_MICRO_USD,
  PAYOUT_FEE_MICRO_USD,
  PAYOUT_METHODS,
  formatMicroUsd,
  validatePayoutAccount,
  type CashoutItem,
  type CashoutStatus,
  type PayoutMethod,
} from '@mwar/shared';
import { apiFetch } from '../../lib/api';
import { useTranslation } from '../../i18n/I18nProvider';
import { Spinner } from '../ui/Card';

const METHOD_ICON: Record<PayoutMethod, string> = { usdt_trc20: '🟢', usdt_bep20: '🟡', promptpay: '🇹🇭', bank_transfer: '🏦' };

export const CASHOUT_STATUS_STYLE: Record<CashoutStatus, string> = {
  pending: 'bg-sky-50 text-sky-700 border-sky-200',
  ai_verifying: 'bg-violet-50 text-violet-700 border-violet-200',
  flagged_review: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-600 border-rose-200',
};

export function CashoutStatusBadge({ status }: { status: CashoutStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-extrabold border whitespace-nowrap ${CASHOUT_STATUS_STYLE[status] || CASHOUT_STATUS_STYLE.pending}`} data-cashout-status={status}>
      {t(`cashout.status.${status}`)}
    </span>
  );
}

const usd = (micro: number) => formatMicroUsd(Math.max(0, Math.round(micro)));

/**
 * /wallet cashout: available balance, $10 minimum, method (USDT TRC20 / BEP20, PromptPay, bank),
 * account, live fee breakdown and the player's history. The server deducts atomically and runs the
 * 3-layer anti-cheat audit; the player sees "under review" / "paid" / "rejected (refunded)".
 */
export function CashoutCard({ balanceMicroUsd, onChanged }: { balanceMicroUsd: number; onChanged: () => void }) {
  const { t, lang } = useTranslation();
  const [method, setMethod] = useState<PayoutMethod>('usdt_trc20');
  const [amountUsd, setAmountUsd] = useState('10.00');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<CashoutItem[] | null>(null);

  const load = async () => {
    try {
      const r = await apiFetch<{ requests: CashoutItem[] }>('/api/wallet/withdrawals');
      setHistory(r.requests || []);
    } catch {
      setHistory([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const amountMicro = Math.round((parseFloat(amountUsd) || 0) * 1_000_000);
  const fee = PAYOUT_FEE_MICRO_USD[method];
  const net = amountMicro - fee;
  const belowMin = amountMicro < CASHOUT_MIN_MICRO_USD;
  const overBalance = amountMicro > balanceMicroUsd;
  const accountErr = account ? validatePayoutAccount(method, account) : null;
  const canSubmit = !busy && !belowMin && !overBalance && !!account && !accountErr && net > 0;
  const placeholder = useMemo(() => t(`cashout.placeholder.${method}`), [method, t]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ status: CashoutStatus; withdrawalId: string }>('/api/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount_micro_usd: amountMicro, payout_method: method, payout_account: account }),
      });
      setMsg({ ok: true, text: t('cashout.submitted', { id: r.withdrawalId.slice(0, 8) }) });
      setAccount('');
      await load();
      onChanged();
    } catch (err: any) {
      const key = err?.code === 'BELOW_MINIMUM' ? 'cashout.err.min' : err?.code === 'INSUFFICIENT_BALANCE' ? 'cashout.err.balance' : err?.code === 'BAD_ACCOUNT' ? 'cashout.err.account' : null;
      setMsg({ ok: false, text: key ? t(key) : err?.message || t('cashout.err.generic') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-cashout-card>
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-4">
        <div className="flex flex-wrap justify-between items-start gap-2 border-b border-stone-100 pb-3">
          <div>
            <h3 className="text-base font-extrabold text-stone-900">{t('cashout.title')}</h3>
            <p className="text-xs text-stone-500 mt-0.5">{t('cashout.subtitle')}</p>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-bold text-stone-500">{t('cashout.withdrawable')}</div>
            <div className="text-xl font-extrabold text-emerald-600 font-mono" data-cashout-balance>
              {usd(balanceMicroUsd)}
            </div>
            <span className="inline-block mt-1 bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
              {t('cashout.minimum', { min: usd(CASHOUT_MIN_MICRO_USD) })}
            </span>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <div className="text-xs font-bold text-stone-600 mb-1.5">{t('cashout.method')}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup">
              {PAYOUT_METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  onClick={() => {
                    setMethod(m);
                    setAccount('');
                  }}
                  className={`rounded-2xl border px-3 py-2.5 text-left transition ${method === m ? 'border-[#FACC15] bg-[#FFFBEA] ring-2 ring-[#FACC15]/40' : 'border-stone-200 bg-white hover:bg-stone-50'}`}
                  data-payout-method={m}
                >
                  <div className="text-base leading-none">{METHOD_ICON[m]}</div>
                  <div className="mt-1 text-xs font-extrabold text-stone-900">{t(`cashout.method.${m}`)}</div>
                  <div className="text-[10px] text-stone-500">{t(`cashout.methodHint.${m}`)}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs font-bold text-stone-600 block mb-1">{t('cashout.amount')}</span>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-stone-500 font-bold">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="10"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                  className="w-full bg-stone-50 border border-stone-200/80 rounded-xl pl-7 pr-20 py-2.5 text-sm text-stone-900 font-bold font-mono focus:border-yellow-400 focus:outline-none"
                  data-cashout-amount
                />
                <button
                  type="button"
                  onClick={() => setAmountUsd((Math.floor(balanceMicroUsd / 10_000) / 100).toFixed(2))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-extrabold text-stone-700 bg-white border border-stone-200 rounded-lg px-2 py-1 hover:bg-stone-100"
                >
                  {t('cashout.max')}
                </button>
              </div>
              {belowMin && <span className="text-[11px] text-rose-500 font-semibold mt-1 block">{t('cashout.err.min')}</span>}
              {!belowMin && overBalance && <span className="text-[11px] text-rose-500 font-semibold mt-1 block">{t('cashout.err.balance')}</span>}
            </label>

            <label className="block">
              <span className="text-xs font-bold text-stone-600 block mb-1">{t(`cashout.account.${method}`)}</span>
              <input
                type="text"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                className={`w-full bg-stone-50 border rounded-xl px-3 py-2.5 text-sm text-stone-900 font-mono focus:outline-none ${accountErr ? 'border-rose-300 focus:border-rose-400' : 'border-stone-200/80 focus:border-yellow-400'}`}
                data-cashout-account
              />
              {accountErr && <span className="text-[11px] text-rose-500 font-semibold mt-1 block">{t('cashout.err.account')}</span>}
            </label>
          </div>

          <div className="rounded-2xl bg-stone-50 border border-stone-200/80 p-3.5 text-xs space-y-1.5 font-semibold" data-cashout-breakdown>
            <div className="flex justify-between text-stone-600">
              <span>{t('cashout.fee.amount')}</span>
              <span className="font-mono">{usd(amountMicro)}</span>
            </div>
            <div className="flex justify-between text-stone-600">
              <span>{t('cashout.fee.fee')}</span>
              <span className="font-mono">− {usd(fee)}</span>
            </div>
            <div className="flex justify-between text-stone-900 font-extrabold border-t border-stone-200 pt-1.5">
              <span>{t('cashout.fee.net')}</span>
              <span className="font-mono text-emerald-600" data-cashout-net>
                {usd(net)}
              </span>
            </div>
            <p className="text-[10px] text-stone-400 font-medium pt-0.5">{t('cashout.fee.note')}</p>
          </div>

          {msg && (
            <p className={`text-xs font-semibold rounded-2xl px-3.5 py-2.5 ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`} data-cashout-msg={msg.ok ? 'ok' : 'error'}>
              {msg.text}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full bg-[#FFE135] hover:bg-[#FACC15] text-stone-900 font-extrabold py-3 rounded-2xl text-sm transition active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
            data-cashout-submit
          >
            {busy && <Spinner size={16} />} {busy ? t('cashout.submitting') : t('cashout.submit', { net: usd(Math.max(0, net)) })}
          </button>
          <p className="text-[11px] text-stone-400 text-center">{t('cashout.auditNote')}</p>
        </form>
      </div>

      <div className="bg-white border border-stone-200/80 rounded-3xl overflow-hidden shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <div className="p-4 sm:p-5 border-b border-stone-200/80 flex justify-between items-center">
          <span className="text-sm font-extrabold text-stone-900">{t('cashout.history', { n: history?.length ?? 0 })}</span>
        </div>
        {history === null ? (
          <div className="p-10 flex justify-center">
            <Spinner size={20} />
          </div>
        ) : history.length === 0 ? (
          <div className="p-10 text-center text-xs text-stone-500">{t('cashout.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-cashout-history>
              <thead className="bg-stone-50 text-stone-500 font-bold border-b border-stone-200/80 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="p-3">{t('cashout.col.date')}</th>
                  <th className="p-3">{t('cashout.col.amount')}</th>
                  <th className="p-3">{t('cashout.col.net')}</th>
                  <th className="p-3">{t('cashout.col.method')}</th>
                  <th className="p-3">{t('cashout.col.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-stone-700">
                {history.map((w) => (
                  <tr key={w.id}>
                    <td className="p-3 font-mono text-[11px] text-stone-500 whitespace-nowrap">{new Date(w.createdAt * 1000).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="p-3 font-mono font-extrabold">{usd(w.amountMicroUsd)}</td>
                    <td className="p-3 font-mono text-emerald-600 font-bold">{usd(w.netPayoutMicroUsd)}</td>
                    <td className="p-3 whitespace-nowrap">
                      <div className="font-bold">{t(`cashout.method.${w.payoutMethod}`)}</div>
                      <div className="font-mono text-[10px] text-stone-400">{w.payoutAccount}</div>
                    </td>
                    <td className="p-3">
                      <CashoutStatusBadge status={w.status} />
                      {w.status === 'rejected' && w.rejectReason && <div className="text-[10px] text-rose-500 mt-1 max-w-[180px]">{t('cashout.refunded')} · {w.rejectReason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
