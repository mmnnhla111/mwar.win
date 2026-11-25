'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { SocialNotification } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Spinner } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { getNotifications, markNotificationsRead } from '../../lib/api';
import { useSession } from '../../lib/session';
import { displayName, timeAgo } from '../../lib/format';
import { useTranslation } from '../../i18n/I18nProvider';

const VERB: Record<SocialNotification['type'], string> = {
  like: 'notif.like',
  comment: 'notif.comment',
  follow: 'notif.follow',
  referral_join: 'notif.referralJoin',
  post_rejected: 'notif.moderation',
  system: 'notif.system',
};

/** Where a click goes: the post, the player, or (for removed posts) the notifications page. */
export function notifHref(n: SocialNotification): string {
  if ((n.type === 'like' || n.type === 'comment') && n.postId) return `/post?id=${encodeURIComponent(n.postId)}`;
  if ((n.type === 'follow' || n.type === 'referral_join') && n.actor) return `/profile?u=${encodeURIComponent(n.actor.username)}`;
  return '/notifications';
}

// Kept for the session so re-opening the bell costs no request unless there is something new
let cached: { items: SocialNotification[]; nextCursor: string | null } | null = null;
export function dropNotifCache() {
  cached = null;
}

/** Shared list logic for the bell dropdown and the /notifications page. */
export function useNotifications() {
  const { boot, patch } = useSession();
  const unread = boot?.unreadNotifCount || 0;
  const [items, setItems] = useState<SocialNotification[]>(cached?.items || []);
  const [next, setNext] = useState<string | null>(cached?.nextCursor || null);
  const [loading, setLoading] = useState(!cached || unread > 0);

  useEffect(() => {
    if (cached && unread === 0) return;
    let alive = true;
    (async () => {
      try {
        const pg = await getNotifications();
        if (!alive) return;
        cached = pg;
        setItems(pg.items);
        setNext(pg.nextCursor);
      } catch {
        /* keep whatever we had */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const store = (list: SocialNotification[], nc: string | null) => {
    cached = { items: list, nextCursor: nc };
    setItems(list);
    setNext(nc);
  };

  const loadMore = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const pg = await getNotifications(next);
      store([...items, ...pg.items], pg.nextCursor);
    } finally {
      setLoading(false);
    }
  };

  const markOne = (n: SocialNotification) => {
    if (n.isRead) return;
    store(items.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)), next);
    patch((b) => ({ ...b, unreadNotifCount: Math.max(0, (b.unreadNotifCount || 0) - 1) }));
    markNotificationsRead(n.id)
      .then((r) => patch((b) => ({ ...b, unreadNotifCount: r.unread })))
      .catch(() => {});
  };

  const markAll = () => {
    store(items.map((x) => ({ ...x, isRead: true })), next);
    patch((b) => ({ ...b, unreadNotifCount: 0 }));
    markNotificationsRead().catch(() => {});
  };

  return { items, next, loading, loadMore, markOne, markAll, unread };
}

export function NotificationRow({ n, onClick }: { n: SocialNotification; onClick: () => void }) {
  const { t, lang } = useTranslation();
  const system = n.type === 'post_rejected' || n.type === 'system' || !n.actor;
  return (
    <Link
      href={notifHref(n)}
      onClick={onClick}
      data-notif={n.type}
      data-unread={n.isRead ? undefined : '1'}
      className={`flex items-start gap-3 px-3 py-2.5 rounded-2xl hover:bg-stone-50 ${n.isRead ? '' : 'bg-[#FFFBEA]'}`}
    >
      {system ? (
        <span className="w-[38px] h-[38px] shrink-0 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center">
          <Icon name="shield" size={18} />
        </span>
      ) : (
        <Avatar src={n.actor!.avatarUrl} name={displayName(n.actor!)} size={38} />
      )}
      <span className="text-sm text-stone-700 leading-snug min-w-0 flex-1">
        <b className="text-stone-900">{system ? t('notif.moderationTitle') : displayName(n.actor!)}</b> {t(VERB[n.type] || 'notif.system')}
        {n.type === 'post_rejected' && n.reason ? `: ${n.reason}` : ''}
        <span className="block text-xs text-stone-400 mt-0.5">{timeAgo(n.createdAt, t, lang)}</span>
      </span>
      {!n.isRead && <span className="mt-2 w-2 h-2 rounded-full bg-[#FACC15] shrink-0" aria-hidden />}
    </Link>
  );
}

/** Bell dropdown: fetched only when opened (and only again when the unread badge says there is news). */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { items, next, loading, loadMore, markOne, markAll, unread } = useNotifications();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-notif-bell]')) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-notif-panel
      className="fixed md:absolute left-3 right-3 md:left-auto md:right-0 top-[60px] md:top-auto md:mt-2 md:w-[360px] bg-white rounded-3xl border border-stone-200/80 shadow-[0_12px_40px_rgba(0,0,0,0.12)] p-2 z-50 animate-[popIn_160ms_ease-out]"
    >
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <span className="font-extrabold text-stone-900 flex-1">{t('nav.notifications')}</span>
        {(unread > 0 || items.some((n) => !n.isRead)) && (
          <button onClick={markAll} className="text-xs font-bold text-sky-600 hover:underline" data-mark-all>
            {t('notif.markAll')}
          </button>
        )}
      </div>
      <div className="max-h-[60dvh] overflow-y-auto">
        {items.length === 0 && loading && (
          <div className="py-8 flex justify-center">
            <Spinner />
          </div>
        )}
        {items.length === 0 && !loading && <p className="px-3 py-8 text-center text-sm text-stone-400">{t('notif.empty')}</p>}
        {items.slice(0, 20).map((n) => (
          <NotificationRow
            key={n.id}
            n={n}
            onClick={() => {
              markOne(n);
              onClose();
            }}
          />
        ))}
        {next && items.length < 20 && (
          <button onClick={loadMore} disabled={loading} className="w-full py-2.5 text-sm font-semibold text-stone-500 hover:text-stone-800">
            {loading ? t('common.loading') : t('notif.seeOlder')}
          </button>
        )}
      </div>
      <Link href="/notifications" onClick={onClose} className="block text-center py-2 text-sm font-bold text-stone-600 hover:text-stone-900 border-t border-stone-100 mt-1">
        {t('notif.seeAll')}
      </Link>
    </div>
  );
}
