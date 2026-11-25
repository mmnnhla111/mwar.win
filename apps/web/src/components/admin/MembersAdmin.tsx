'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { MEMBER_FILTERS, MAX_ENERGY_TICKETS, formatUsdGrouped } from '@mwar/shared';
import { formatEc } from '../../lib/format';
import type { AdminMemberDetail, AdminMemberRow, MemberFilter } from '@mwar/shared';
import { apiFetch } from '../../lib/api';
import { Card, Modal, Spinner, btn, inputCls } from '../ui/Card';
import { Avatar } from '../ui/Avatar';
import { useTranslation } from '../../i18n/I18nProvider';

const usd = (micro: number) => formatUsdGrouped(micro);
const toMicro = (v: string) => Math.round(Number(v) * 1_000_000);
const priceOk = (v: string) => Number.isFinite(Number(v)) && Number(v) >= 0.01 && Number(v) <= 100000;

const isOrphan = (m: AdminMemberRow) => !m.referrerId && m.role === 'player';

function StatusBadge({ status }: { status: AdminMemberRow['status'] }) {
  const { t } = useTranslation();
  const cls = status === 'active' ? 'bg-[#D1FAE5] text-emerald-700' : 'bg-[#FFE4E6] text-rose-600';
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${cls}`}>{t(`adminm.status.${status}`)}</span>;
}

/** /admin → Members: directory, inspector, EC / suspend actions, and orphan players listed on the marketplace. */
export function MembersAdmin() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<MemberFilter>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AdminMemberRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({}); // userId -> price (USD text)
  const [bulkPrice, setBulkPrice] = useState('5');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null = null) => {
      setLoading(true);
      setError('');
      try {
        const p = new URLSearchParams({ filter });
        if (query) p.set('q', query);
        if (cursor) p.set('cursor', cursor);
        const r = await apiFetch<{ items: AdminMemberRow[]; nextCursor: string | null }>(`/api/admin/members?${p}`);
        setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
        setNext(r.nextCursor);
      } catch (err: any) {
        setError(err?.message || t('adminm.loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter, query]
  );

  useEffect(() => {
    setSelected({});
    load(null);
  }, [load]);

  const toggle = (m: AdminMemberRow) =>
    setSelected((s) => {
      const n = { ...s };
      if (n[m.id] !== undefined) delete n[m.id];
      else n[m.id] = bulkPrice;
      return n;
    });

  const selectedIds = Object.keys(selected);

  const listSelected = async () => {
    if (!selectedIds.length) return;
    if (selectedIds.some((id) => !priceOk(selected[id]))) return setMsg(t('adminm.badPrice'));
    setBusy(true);
    setMsg('');
    try {
      const r = await apiFetch<{ listed: number; results: Array<{ ok: boolean; error?: string }> }>('/api/admin/members/list-orphans', {
        method: 'POST',
        body: JSON.stringify({ items: selectedIds.map((userId) => ({ userId, priceMicroUsd: toMicro(selected[userId]) })) }),
      });
      setMsg(t('adminm.listedN', { count: r.listed, failed: r.results.length - r.listed }));
      setSelected({});
      await load(null);
    } catch (err: any) {
      setMsg(err?.message || t('adminm.loadFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-admin-members>
      <Card className="p-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <form
            className="flex gap-2 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q.trim());
            }}
          >
            <input className={`${inputCls} !py-2.5`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adminm.search')} aria-label={t('adminm.search')} />
            <button className={btn.soft} type="submit">
              {t('adminm.searchBtn')}
            </button>
          </form>
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar" role="tablist">
          {MEMBER_FILTERS.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              data-member-filter={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                filter === f ? 'bg-stone-900 text-white' : 'bg-white border border-stone-200 text-stone-600 hover:bg-stone-50'
              }`}
            >
              {t(`adminm.filter.${f}`)}
            </button>
          ))}
        </div>

        {filter === 'orphan' && (
          <div className="rounded-2xl bg-[#FFFBEA] border border-yellow-200 p-3 space-y-2" data-orphan-bar>
            <p className="text-xs text-stone-600">{t('adminm.orphanHint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-bold text-stone-600" htmlFor="bulk-price">
                {t('adminm.bulkPrice')}
              </label>
              <div className="relative w-28">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-stone-400">$</span>
                <input id="bulk-price" className={`${inputCls} !py-2 !pl-7`} inputMode="decimal" value={bulkPrice} onChange={(e) => setBulkPrice(e.target.value)} />
              </div>
              <button
                type="button"
                className={btn.soft}
                disabled={!selectedIds.length}
                onClick={() => setSelected((s) => Object.fromEntries(Object.keys(s).map((k) => [k, bulkPrice])))}
              >
                {t('adminm.applyAll')}
              </button>
              <button type="button" className={btn.primary} disabled={!selectedIds.length || busy} onClick={listSelected} data-list-orphans>
                {busy ? t('common.saving') : t('adminm.listSelected', { count: selectedIds.length })}
              </button>
            </div>
          </div>
        )}
        {msg && <p className="text-sm font-semibold text-stone-700 bg-stone-50 rounded-2xl px-3 py-2" data-admin-msg>{msg}</p>}
      </Card>

      {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}

      <Card className="divide-y divide-stone-100 overflow-hidden">
        {items.map((m) => {
          const orphan = isOrphan(m);
          const canSelect = filter === 'orphan' && orphan && !m.listing && m.status === 'active';
          return (
            <div key={m.id} className="flex items-center gap-3 px-3 sm:px-4 py-3" data-member-row={m.username}>
              {canSelect && (
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[#FACC15] shrink-0"
                  checked={selected[m.id] !== undefined}
                  onChange={() => toggle(m)}
                  aria-label={t('adminm.select', { name: m.username })}
                />
              )}
              <button type="button" onClick={() => setOpenId(m.id)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                <Avatar name={m.displayName || m.username} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-sm text-stone-900 truncate">{m.displayName || m.username}</span>
                    <StatusBadge status={m.status} />
                    {orphan && <span className="rounded-full bg-[#EDE9FE] text-violet-700 px-2 py-0.5 text-[10px] font-extrabold">{t('adminm.noUpline')}</span>}
                    {m.listing && (
                      <span className="rounded-full bg-[#E0F2FE] text-sky-700 px-2 py-0.5 text-[10px] font-extrabold">
                        {t('adminm.listedAt', { price: usd(m.listing.priceMicroUsd) })}
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-stone-400 truncate">
                    @{m.username} · {m.referrerUsername ? t('adminm.uplineIs', { name: m.referrerUsername }) : t('adminm.noUpline')} · {formatEc(m.energyTickets, MAX_ENERGY_TICKETS)}
                  </span>
                </span>
                <span className="hidden sm:block text-right shrink-0">
                  <span className="block text-sm font-extrabold text-stone-900">{usd(m.balanceMicroUsd)}</span>
                  <span className="block text-[11px] text-stone-400">{t('earnings.total')}: {usd(m.totalEarnedMicroUsd)}</span>
                </span>
              </button>
              {canSelect && selected[m.id] !== undefined && (
                <div className="relative w-24 shrink-0">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-stone-400">$</span>
                  <input
                    className={`${inputCls} !py-1.5 !pl-6 !text-xs`}
                    inputMode="decimal"
                    value={selected[m.id]}
                    onChange={(e) => setSelected((s) => ({ ...s, [m.id]: e.target.value }))}
                    aria-label={t('adminm.priceFor', { name: m.username })}
                  />
                </div>
              )}
            </div>
          );
        })}
        {!items.length && !loading && <p className="p-8 text-center text-sm text-stone-400">{t('adminm.empty')}</p>}
        {loading && (
          <div className="p-6 flex justify-center">
            <Spinner size={20} />
          </div>
        )}
      </Card>
      {next && !loading && (
        <div className="flex justify-center">
          <button className={btn.soft} onClick={() => load(next)}>
            {t('common.loadMore')}
          </button>
        </div>
      )}

      {openId && <MemberInspector id={openId} onClose={() => setOpenId(null)} onChanged={() => load(null)} />}
    </div>
  );
}

function MemberInspector({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState<AdminMemberDetail | null>(null);
  const [error, setError] = useState('');
  const [ec, setEc] = useState('1');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<AdminMemberDetail>(`/api/admin/members/${encodeURIComponent(id)}`);
      setD(r);
      setPrice(r.listing ? String(r.listing.priceMicroUsd / 1_000_000) : '');
    } catch (err: any) {
      setError(err?.message || t('adminm.loadFailed'));
    }
  }, [id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      onChanged();
    } catch (err: any) {
      setError(err?.message || t('adminm.loadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const patch = (body: Record<string, unknown>) => apiFetch(`/api/admin/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  const listingPatch = (body: Record<string, unknown>) =>
    apiFetch(`/api/admin/listings/${encodeURIComponent(d!.listing!.id)}`, { method: 'PATCH', body: JSON.stringify(body) });

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-stone-500 shrink-0">{label}</span>
      <span className="font-semibold text-stone-900 text-right min-w-0 break-all">{value}</span>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={d ? `@${d.username}` : t('adminm.member')} maxWidth="max-w-lg">
      <div className="p-5 space-y-4" data-member-inspector>
        {!d && !error && (
          <div className="py-8 flex justify-center">
            <Spinner size={22} />
          </div>
        )}
        {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}
        {d && (
          <>
            <div className="divide-y divide-stone-100">
              {row(t('adminm.userId'), <code className="text-xs">{d.id}</code>)}
              {row(t('adminm.displayName'), d.displayName || '—')}
              {row(t('adminm.status'), <StatusBadge status={d.status} />)}
              {row('Telegram', d.telegram ? (d.telegram.username ? `@${d.telegram.username}` : d.telegram.displayName || '✓') : '—')}
              {row('LINE', d.line ? d.line.displayName || '✓' : '—')}
              {row(
                t('adminm.upline'),
                d.referrerUsername ? `@${d.referrerUsername}` : <span className="rounded-full bg-[#EDE9FE] text-violet-700 px-2 py-0.5 text-[11px] font-extrabold">{t('adminm.noUpline')}</span>
              )}
              {row(t('adminm.downlines'), `${d.directDownlines} / ${d.totalDownlines} (${d.downlinesByDepth.join(' · ')})`)}
              {row(t('adminm.balance'), usd(d.balanceMicroUsd))}
              {row(t('earnings.total'), usd(d.totalEarnedMicroUsd))}
              {row('EC', formatEc(d.energyTickets, MAX_ENERGY_TICKETS))}
              {row(t('adminm.stats'), t('adminm.statsValue', { matches: d.totalMatches, kills: d.totalKills }))}
            </div>

            <div className="rounded-2xl bg-stone-50 p-3 space-y-2">
              <div className="text-xs font-bold text-stone-600">{t('adminm.adjustEc')}</div>
              <div className="flex items-center gap-2">
                <input className={`${inputCls} !py-2 !w-24`} inputMode="numeric" value={ec} onChange={(e) => setEc(e.target.value.replace(/[^0-9]/g, ''))} aria-label="EC" />
                <button className={`${btn.soft} whitespace-nowrap`} disabled={busy || !Number(ec)} onClick={() => act(() => patch({ ecDelta: -Number(ec) }))}>
                  − EC
                </button>
                <button className={`${btn.primary} whitespace-nowrap`} disabled={busy || !Number(ec)} onClick={() => act(() => patch({ ecDelta: Number(ec) }))} data-ec-plus>
                  + EC
                </button>
              </div>
            </div>

            {d.role === 'player' && d.status !== 'banned' && (
              <button
                className={d.status === 'active' ? `${btn.soft} text-rose-600 w-full` : `${btn.primary} w-full`}
                disabled={busy}
                onClick={() => act(() => patch({ status: d.status === 'active' ? 'suspended' : 'active' }))}
                data-suspend
              >
                {d.status === 'active' ? t('adminm.suspend') : t('adminm.unsuspend')}
              </button>
            )}

            {d.listing?.type === 'orphan' && (
              <div className="rounded-2xl bg-[#E0F2FE] p-3 space-y-2" data-orphan-listing>
                <div className="text-xs font-bold text-sky-800">{t('adminm.orphanListing')}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-28">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-stone-400">$</span>
                    <input className={`${inputCls} !py-2 !pl-7`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={t('adminm.price')} />
                  </div>
                  <button className={btn.primary} disabled={busy || !priceOk(price)} onClick={() => act(() => listingPatch({ priceMicroUsd: toMicro(price) }))}>
                    {t('adminm.updatePrice')}
                  </button>
                  <button className={`${btn.ghost} text-rose-600`} disabled={busy} onClick={() => act(() => listingPatch({ delist: true }))}>
                    {t('adminm.delist')}
                  </button>
                </div>
              </div>
            )}

            <div>
              <div className="text-xs font-bold text-stone-600 mb-1.5">{t('adminm.tree')}</div>
              {d.tree.length ? (
                <div className="max-h-48 overflow-y-auto rounded-2xl border border-stone-100 divide-y divide-stone-100">
                  {d.tree.map((n) => (
                    <div key={n.id} className="flex items-center gap-2 px-3 py-1.5 text-sm" style={{ paddingLeft: 12 + (n.depth - 1) * 14 }}>
                      <span className="rounded-full bg-stone-100 text-stone-600 text-[10px] font-extrabold px-1.5">L{n.depth}</span>
                      <span className="truncate">@{n.username}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-stone-400">{t('adminm.treeEmpty')}</p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
