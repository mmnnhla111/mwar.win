'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { SocialNotification } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Spinner } from '../ui/Card';
import { getNotifications, markNotificationsRead } from '../../lib/api';
import { useSession } from '../../lib/session';
import { displayName, timeAgo } from '../../lib/format';

const VERB: Record<SocialNotification['type'], string> = {
  like: 'liked your post',
  comment: 'commented on your post',
  follow: 'started following you',
};

// Kept for the session so re-opening the bell costs no request unless there is something new
let cached: { items: SocialNotification[]; nextCursor: string | null } | null = null;

/** Bell dropdown: fetched only when opened (and only again when the unread badge says there is news). */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { boot, patch } = useSession();
  const unread = boot?.unreadNotifCount || 0;
  const [items, setItems] = useState<SocialNotification[]>(cached?.items || []);
  const [next, setNext] = useState<string | null>(cached?.nextCursor || null);
  const [loading, setLoading] = useState(!cached || unread > 0);
  const ref = useRef<HTMLDivElement>(null);

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
        if (unread > 0) {
          markNotificationsRead().catch(() => {});
          patch((b) => ({ ...b, unreadNotifCount: 0 }));
        }
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

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[aria-label="Notifications"]')) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);

  const loadMore = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const pg = await getNotifications(next);
      const merged = [...items, ...pg.items];
      cached = { items: merged, nextCursor: pg.nextCursor };
      setItems(merged);
      setNext(pg.nextCursor);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      ref={ref}
      className="fixed md:absolute left-3 right-3 md:left-auto md:right-0 top-[60px] md:top-auto md:mt-2 md:w-[360px] bg-white rounded-3xl border border-stone-200/80 shadow-[0_12px_40px_rgba(0,0,0,0.12)] p-2 z-50 animate-[popIn_160ms_ease-out]"
    >
      <div className="px-3 pt-2 pb-1 font-extrabold text-stone-900">Notifications</div>
      <div className="max-h-[60dvh] overflow-y-auto">
        {items.length === 0 && loading && (
          <div className="py-8 flex justify-center">
            <Spinner />
          </div>
        )}
        {items.length === 0 && !loading && <p className="px-3 py-8 text-center text-sm text-stone-400">No notifications yet. Post something cute!</p>}
        {items.map((n) => (
          <Link
            key={n.id}
            href={n.type === 'follow' ? `/profile?u=${n.actor.username}` : `/profile?u=${boot?.user.username || ''}`}
            onClick={onClose}
            className={`flex items-start gap-3 px-3 py-2.5 rounded-2xl hover:bg-stone-50 ${n.isRead ? '' : 'bg-[#FFFBEA]'}`}
          >
            <Avatar src={n.actor.avatarUrl} name={displayName(n.actor)} size={38} />
            <span className="text-sm text-stone-700 leading-snug">
              <b className="text-stone-900">{displayName(n.actor)}</b> {VERB[n.type]}
              <span className="block text-xs text-stone-400 mt-0.5">{timeAgo(n.createdAt)}</span>
            </span>
          </Link>
        ))}
        {next && (
          <button onClick={loadMore} disabled={loading} className="w-full py-2.5 text-sm font-semibold text-stone-500 hover:text-stone-800">
            {loading ? 'Loading…' : 'See older'}
          </button>
        )}
      </div>
    </div>
  );
}
