'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { ContentReportItem } from '@mwar/shared';
import { actOnReport, getTakedownReports } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useTranslation } from '../../i18n/I18nProvider';

type Action = 'delete' | 'reclassify_18' | 'dismiss';


/** Admin tab "คำขอแจ้งลบ (Takedown Requests)": pending user reports with a post preview and 3 actions. */
export function TakedownQueue() {
  const { t, lang } = useTranslation();
  const [items, setItems] = useState<ContentReportItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [armed, setArmed] = useState<string | null>(null); // two-step confirm for the destructive action

  const load = useCallback(async (cursor?: string | null) => {
    setLoading(true);
    try {
      const r = await getTakedownReports(cursor);
      setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
      setNext(r.nextCursor);
    } catch (err: any) {
      setMsg(t('takedown.loadFailed', { error: err?.message || String(err) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (item: ContentReportItem, action: Action) => {
    if (action === 'delete' && armed !== item.id) {
      setArmed(item.id);
      return;
    }
    setArmed(null);
    setBusyId(item.id);
    setMsg('');
    try {
      await actOnReport(item.id, action);
      // Delete / reclassify close every pending report on that post; dismiss closes only this one
      setItems((prev) => prev.filter((x) => (action === 'dismiss' ? x.id !== item.id : x.postId !== item.postId)));
      setMsg(
        action === 'delete' ? t('takedown.deleted') : action === 'reclassify_18' ? t('takedown.reclassified') : t('takedown.dismissed')
      );
    } catch (err: any) {
      setMsg(t('common.errorWith', { error: err?.message || String(err) }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-white border border-stone-200/80 rounded-3xl overflow-hidden shadow-[0_2px_12px_rgba(0,0,0,0.04)]" data-takedown-queue>
      <div className="p-4 sm:p-5 border-b border-stone-200/80 flex justify-between items-center gap-3">
        <span className="text-sm font-extrabold text-stone-900">{t('takedown.title')} · {items.length}</span>
        <button onClick={() => load()} className="text-xs text-amber-700 font-bold bg-stone-100 px-3 py-1 rounded-xl border border-stone-200/80">
          {t('common.refresh')}
        </button>
      </div>
      {msg && <div className="px-5 py-2.5 text-xs font-semibold text-amber-700 bg-amber-50 border-b border-amber-100">{msg}</div>}
      {loading && items.length === 0 ? (
        <div className="p-12 text-center text-xs text-stone-500 animate-pulse">{t('takedown.loading')}</div>
      ) : items.length === 0 ? (
        <div className="p-12 text-center text-xs text-stone-500">✅ {t('takedown.empty')}</div>
      ) : (
        <ul className="divide-y divide-stone-100">
          {items.map((it) => {
            const p = it.post;
            return (
              <li key={it.id} className="p-4 sm:p-5 flex flex-col md:flex-row gap-4" data-report-row>
                <div className="w-full md:w-40 shrink-0">
                  {p?.mediaUrl && p.mediaType === 'video' ? (
                    <video src={p.mediaUrl} controls muted playsInline preload="metadata" className="w-full max-h-40 rounded-2xl bg-stone-900 object-contain" />
                  ) : p?.mediaUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.mediaUrl} alt="" loading="lazy" className="w-full max-h-40 rounded-2xl object-cover bg-stone-100" />
                  ) : (
                    <div className="w-full h-24 rounded-2xl bg-stone-100 flex items-center justify-center text-[11px] font-bold text-stone-400">
                      {p ? (p.moderationStatus === 'pending' ? t('takedown.mediaInReview') : t('takedown.textPost')) : t('takedown.postDeleted')}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200 font-bold">{t(`report.reason.${it.reasonCategory}`)}</span>
                    {it.reportCount > 1 && <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-bold">{t('takedown.reports', { count: it.reportCount })}</span>}
                    {p?.contentRating === 'nsfw_18' && <span className="px-2 py-0.5 rounded-full bg-stone-900 text-white font-bold">18+</span>}
                    <span className="text-stone-400">{timeAgo(it.createdAt, t, lang)}</span>
                  </div>
                  {p && (
                    <p className="text-sm text-stone-800 break-words line-clamp-3">
                      <b>@{p.author.username}</b> {p.body || <i className="text-stone-400">{t('takedown.noText')}</i>}
                    </p>
                  )}
                  {it.details && <p className="text-xs text-stone-600 break-words">“{it.details}”</p>}
                  <p className="text-[11px] text-stone-400 break-all">
                    {t('takedown.by', { who: it.reporterUsername ? `@${it.reporterUsername}` : t('takedown.guest') })}
                    {it.reporterContact ? ` · ${t('takedown.contact')}: ${it.reporterContact}` : ''} · {t('takedown.post')} {it.postId}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      disabled={busyId === it.id || !p}
                      onClick={() => act(it, 'delete')}
                      className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-3 py-1.5 rounded-xl text-xs disabled:opacity-50"
                    >
                      {armed === it.id ? t('takedown.confirmDelete') : t('takedown.delete')}
                    </button>
                    <button
                      disabled={busyId === it.id || !p || p.contentRating === 'nsfw_18'}
                      onClick={() => act(it, 'reclassify_18')}
                      className="bg-stone-900 hover:bg-stone-700 text-white font-bold px-3 py-1.5 rounded-xl text-xs disabled:opacity-50"
                    >
                      {t('takedown.reclassify')}
                    </button>
                    <button
                      disabled={busyId === it.id}
                      onClick={() => act(it, 'dismiss')}
                      className="bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold px-3 py-1.5 rounded-xl text-xs border border-stone-200"
                    >
                      {t('takedown.dismiss')}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <div className="p-4 text-center border-t border-stone-100">
          <button onClick={() => load(next)} disabled={loading} className="text-xs font-bold text-amber-700">
            {t('common.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
