'use client';

import React, { useEffect, useState } from 'react';
import { formatMicroUsd, type AdminCashoutItem } from '@mwar/shared';
import { apiFetch } from '../../lib/api';
import { useTranslation } from '../../i18n/I18nProvider';
import { Spinner } from '../ui/Card';
import { CashoutStatusBadge } from '../wallet/CashoutCard';

const FILTERS = ['open', 'flagged_review', 'pending', 'approved', 'rejected', 'all'] as const;
type Filter = (typeof FILTERS)[number];

const usd = (m: number) => (m < 0 ? '−' : '') + formatMicroUsd(Math.abs(Math.round(m)));
const pct = (r: number | null | undefined) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`);

function ScorePill({ score }: { score: number | null }) {
  const cls = score == null ? 'bg-stone-100 text-stone-500 border-stone-200' : score >= 0.7 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : score >= 0.4 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-rose-50 text-rose-600 border-rose-200';
  return <span className={`inline-flex px-2 py-0.5 rounded-full border font-mono font-extrabold text-[11px] ${cls}`} data-audit-score={score ?? ''}>{score == null ? '—' : score.toFixed(2)}</span>;
}

function LayerBox({ title, ok, children, attr }: { title: string; ok: boolean; children: React.ReactNode; attr: string }) {
  return (
    <div className={`rounded-2xl border p-3 text-[11px] space-y-1 ${ok ? 'border-emerald-200 bg-emerald-50/40' : 'border-rose-200 bg-rose-50/50'}`} data-audit-layer={attr} data-ok={ok ? '1' : '0'}>
      <div className="flex items-center justify-between font-extrabold text-stone-900 text-xs">
        <span>{title}</span>
        <span>{ok ? '✅' : '⚠️'}</span>
      </div>
      {children}
    </div>
  );
}

const Row = ({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) => (
  <div className="flex justify-between gap-2">
    <span className="text-stone-500">{k}</span>
    <span className={`font-mono text-right ${strong ? 'font-extrabold text-stone-900' : 'text-stone-700'}`}>{v}</span>
  </div>
);

/**
 * Admin cashout queue: AI score + the 3 audit layers for each request. super_admin approves (marks
 * the payout sent) or rejects (refund, optionally forfeiting Layer-3 collusive earnings); every action
 * is written to the staff audit trail. finance_auditor sees the same data read-only, accounts masked.
 */
export function CashoutReviewAdmin() {
  const { t, lang } = useTranslation();
  const [filter, setFilter] = useState<Filter>('open');
  const [items, setItems] = useState<AdminCashoutItem[] | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [forfeit, setForfeit] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async (f: Filter = filter) => {
    setItems(null);
    try {
      const r = await apiFetch<{ withdrawals: AdminCashoutItem[]; canReview: boolean }>(`/api/audit/withdrawals?status=${f}`);
      setItems(r.withdrawals || []);
      setCanReview(!!r.canReview);
    } catch (e: any) {
      setItems([]);
      setMsg({ ok: false, text: t('common.errorWith', { error: e.message }) });
    }
  };
  useEffect(() => {
    load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const act = async (item: AdminCashoutItem, action: 'approve' | 'reject' | 'rerun') => {
    setBusy(item.id);
    setMsg(null);
    try {
      if (action === 'rerun') {
        await apiFetch(`/api/audit/withdrawals/${item.id}/rerun`, { method: 'POST' });
      } else {
        await apiFetch('/api/audit/review', {
          method: 'POST',
          body: JSON.stringify({ withdrawal_id: item.id, action, reason: reason[item.id]?.trim() || undefined, forfeit_collusive: action === 'reject' ? !!forfeit[item.id] : undefined }),
        });
      }
      setMsg({ ok: true, text: t(`admin.cashout.done.${action}`, { id: item.id.slice(0, 8) }) });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.code === 'REASON_REQUIRED' ? t('admin.cashout.reasonRequired') : t('common.errorWith', { error: e.message }) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-white border border-stone-200/80 rounded-3xl overflow-hidden shadow-[0_2px_12px_rgba(0,0,0,0.04)]" data-cashout-admin data-can-review={canReview ? '1' : '0'}>
      <div className="p-4 sm:p-5 border-b border-stone-200/80 space-y-3">
        <div className="flex flex-wrap justify-between items-center gap-2">
          <div>
            <h3 className="text-sm font-extrabold text-stone-900">{t('admin.cashout.title', { n: items?.length ?? 0 })}</h3>
            <p className="text-[11px] text-stone-500">{canReview ? t('admin.cashout.hintWrite') : t('admin.cashout.hintRead')}</p>
          </div>
          <button onClick={() => load()} className="text-xs font-bold bg-stone-100 px-3 py-1.5 rounded-xl border border-stone-200/80 text-stone-700 hover:bg-stone-200">
            {t('admin.refreshQueue')}
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              data-cashout-filter={f}
              className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-extrabold border ${filter === f ? 'bg-[#FFE135] border-yellow-300 text-stone-900' : 'bg-white border-stone-200 text-stone-500'}`}
            >
              {t(`admin.cashout.filter.${f}`)}
            </button>
          ))}
        </div>
        {msg && <p className={`text-xs font-semibold rounded-xl px-3 py-2 ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`} data-cashout-admin-msg={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      </div>

      {items === null ? (
        <div className="p-12 flex justify-center"><Spinner size={20} /></div>
      ) : items.length === 0 ? (
        <div className="p-12 text-center text-xs text-stone-500">✅ {t('admin.queueClear')}</div>
      ) : (
        <ul className="divide-y divide-stone-100">
          {items.map((it) => {
            const r = it.report;
            const isOpen = open === it.id;
            const reviewable = ['pending', 'ai_verifying', 'flagged_review'].includes(it.status);
            return (
              <li key={it.id} data-cashout-row={it.id} data-status={it.status}>
                <button onClick={() => setOpen(isOpen ? null : it.id)} className="w-full text-left p-4 hover:bg-stone-50 transition flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-[120px]">
                    <div className="text-xs font-extrabold text-stone-900">@{it.username}</div>
                    <div className="text-[10px] font-mono text-stone-400">{it.id.slice(0, 8)} · {new Date(it.createdAt * 1000).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' })}</div>
                  </div>
                  <div className="text-xs">
                    <div className="font-mono font-extrabold text-stone-900">{usd(it.amountMicroUsd)}</div>
                    <div className="text-[10px] text-stone-500">{t('cashout.fee.net')}: {usd(it.netPayoutMicroUsd)}</div>
                  </div>
                  <div className="text-[11px] min-w-[140px]">
                    <div className="font-bold text-stone-700">{t(`cashout.method.${it.payoutMethod}`)}</div>
                    <div className="font-mono text-[10px] text-stone-500 break-all" data-cashout-account-view>{it.payoutAccount}</div>
                  </div>
                  <ScorePill score={it.aiAuditScore} />
                  <CashoutStatusBadge status={it.status} />
                  <span className="ml-auto text-stone-400 text-xs">{isOpen ? '▲' : '▼'}</span>
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 space-y-3" data-cashout-detail>
                    {!r ? (
                      <p className="text-xs text-stone-500">{t('admin.cashout.noReport')}</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <LayerBox title={t('admin.cashout.l1')} ok={r.layer1.status === 'match'} attr="1">
                          <Row k={t('admin.cashout.expected')} v={usd(r.layer1.expectedBalanceMicroUsd)} />
                          <Row k={t('admin.cashout.actual')} v={usd(r.layer1.actualBalanceMicroUsd)} />
                          <Row k={t('admin.cashout.diff')} v={`${r.layer1.diffMicroUsd} µUSD`} strong />
                          <Row k={t('admin.cashout.credits')} v={usd(r.layer1.creditsMicroUsd)} />
                          <Row k={t('admin.cashout.debits')} v={usd(r.layer1.withdrawalsMicroUsd + r.layer1.purchasesMicroUsd + r.layer1.otherDebitsMicroUsd)} />
                          <Row k={t('admin.cashout.ledgerRows')} v={r.layer1.ledgerRows} />
                          <Row k="PostgreSQL" v={t(`admin.cashout.pg.${r.layer1.postgres.status}`)} />
                        </LayerBox>
                        <LayerBox title={t('admin.cashout.l2')} ok={r.layer2.status === 'clean'} attr="2">
                          <Row k={t('admin.cashout.kills')} v={r.layer2.kills} />
                          <Row k={t('admin.cashout.headshot')} v={`${pct(r.layer2.headshotRatio)} (${r.layer2.headshots}/${r.layer2.hits})`} strong />
                          <Row k={t('admin.cashout.chests')} v={r.layer2.chests} />
                          <Row k={t('admin.cashout.chestZ')} v={r.layer2.maxChestZ == null ? '—' : `${r.layer2.maxChestZ.toFixed(2)}σ`} />
                          {r.layer2.reasons.length > 0 && <div className="text-rose-600 font-bold">{r.layer2.reasons.map((x) => t(`admin.cashout.reason.${x}`)).join(' · ')}</div>}
                        </LayerBox>
                        <LayerBox title={t('admin.cashout.l3')} ok={r.layer3.status === 'clean'} attr="3">
                          <Row k={t('admin.cashout.l3status')} v={t(`admin.cashout.l3.${r.layer3.status}`)} strong />
                          <Row k={t('admin.cashout.ratio')} v={`${pct(r.layer3.collusionRatio)} (${r.layer3.suspiciousKills}/${r.layer3.kills})`} />
                          <Row k={t('admin.cashout.collusive')} v={usd(r.layer3.collusiveEarningsMicroUsd)} />
                          <Row k={t('admin.cashout.links')} v={`IP ${r.layer3.sharedIpPartners} · FP ${r.layer3.sharedDevicePartners} · Ref ${r.layer3.referralLoopPartners}`} />
                          {r.layer3.topPartners.map((p) => (
                            <div key={p.userId} className="text-[10px] text-stone-600">@{p.username || p.userId.slice(0, 8)} · {p.kills} kills · {p.reasons.join(', ')}</div>
                          ))}
                        </LayerBox>
                      </div>
                    )}

                    {(it.rejectReason || it.reviewedBy || it.forfeitedMicroUsd > 0) && (
                      <div className="text-[11px] text-stone-500 bg-stone-50 rounded-xl p-2.5">
                        {it.rejectReason && <div>{t('admin.cashout.rejectReason')}: {it.rejectReason}</div>}
                        {it.forfeitedMicroUsd > 0 && <div>{t('admin.cashout.forfeited')}: {usd(it.forfeitedMicroUsd)}</div>}
                        {it.reviewedBy && <div>{t('admin.cashout.reviewedBy')}: @{it.reviewedBy}</div>}
                      </div>
                    )}

                    {reviewable && canReview && (
                      <div className="rounded-2xl border border-stone-200 p-3 space-y-2" data-cashout-actions>
                        <input
                          value={reason[it.id] || ''}
                          onChange={(e) => setReason({ ...reason, [it.id]: e.target.value })}
                          placeholder={it.status === 'pending' ? t('admin.cashout.reasonOptional') : t('admin.cashout.reasonNeeded')}
                          maxLength={255}
                          className="w-full bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 text-xs focus:border-yellow-400 focus:outline-none"
                          data-cashout-reason
                        />
                        {r && r.layer3.collusiveEarningsMicroUsd > 0 && (
                          <label className="flex items-center gap-2 text-[11px] text-stone-700 font-semibold">
                            <input type="checkbox" checked={!!forfeit[it.id]} onChange={(e) => setForfeit({ ...forfeit, [it.id]: e.target.checked })} data-cashout-forfeit />
                            {t('admin.cashout.forfeitLabel', { amount: usd(Math.min(it.amountMicroUsd, r.layer3.collusiveEarningsMicroUsd)) })}
                          </label>
                        )}
                        <div className="flex flex-wrap gap-2 justify-end">
                          <button disabled={busy === it.id} onClick={() => act(it, 'rerun')} className="bg-stone-100 border border-stone-200 text-stone-700 font-bold px-3 py-1.5 rounded-xl text-xs disabled:opacity-50">{t('admin.cashout.rerun')}</button>
                          <button disabled={busy === it.id} onClick={() => act(it, 'reject')} className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-3 py-1.5 rounded-xl text-xs disabled:opacity-50" data-cashout-reject>{t('admin.cashout.rejectRefund')}</button>
                          <button disabled={busy === it.id} onClick={() => act(it, 'approve')} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1.5 rounded-xl text-xs disabled:opacity-50" data-cashout-approve>{t('admin.cashout.approvePaid')}</button>
                        </div>
                      </div>
                    )}
                    {reviewable && !canReview && <div className="text-[11px] font-bold text-stone-400 text-right" data-cashout-readonly>{t('admin.readOnly')}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
