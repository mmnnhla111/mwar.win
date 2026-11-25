'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SocialAuthor } from '@mwar/shared';
import { Modal, Spinner, btn } from '../ui/Card';
import { Avatar } from '../ui/Avatar';
import { getFollows } from '../../lib/api';
import { displayName } from '../../lib/format';
import { useTranslation } from '../../i18n/I18nProvider';

/** Followers / following list in a modal (10 per page, loaded only when opened). */
export function FollowListModal({ username, type, onClose }: { username: string; type: 'followers' | 'following' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'followers' | 'following'>('followers');
  const [items, setItems] = useState<SocialAuthor[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (which: 'followers' | 'following', cursor?: string | null) => {
    setLoading(true);
    try {
      const pg = await getFollows(username, which, cursor);
      setItems((prev) => (cursor ? [...prev, ...pg.items] : pg.items));
      setNext(pg.nextCursor);
    } catch {
      if (!cursor) setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!type) return;
    setTab(type);
    setItems([]);
    load(type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, username]);

  const switchTab = (v: 'followers' | 'following') => {
    if (v === tab) return;
    setTab(v);
    setItems([]);
    load(v);
  };

  return (
    <Modal open={!!type} onClose={onClose} title={`@${username}`}>
      <div className="p-4" data-follow-modal>
        <div className="grid grid-cols-2 gap-1 rounded-full bg-stone-100 p-1 mb-3">
          {(['followers', 'following'] as const).map((v) => (
            <button key={v} onClick={() => switchTab(v)} className={`rounded-full py-1.5 text-sm font-bold ${tab === v ? 'bg-white shadow text-stone-900' : 'text-stone-500'}`}>
              {t(`profile.${v}`)}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          {items.map((u) => (
            <Link key={u.id} href={`/profile?u=${u.username}`} onClick={onClose} className="flex items-center gap-3 rounded-2xl px-2 py-2 hover:bg-stone-50">
              <Avatar src={u.avatarUrl} name={displayName(u)} size={38} />
              <span className="min-w-0">
                <span className="block font-bold text-sm text-stone-900 truncate">{displayName(u)}</span>
                <span className="block text-xs text-stone-400 truncate">@{u.username}</span>
              </span>
            </Link>
          ))}
          {loading && (
            <div className="py-4 flex justify-center">
              <Spinner />
            </div>
          )}
          {!loading && !items.length && <p className="py-6 text-center text-sm text-stone-400">{t('follow.empty')}</p>}
          {next && !loading && (
            <button onClick={() => load(tab, next)} className={`${btn.soft} w-full justify-center mt-2`}>
              {t('feed.loadMore')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
