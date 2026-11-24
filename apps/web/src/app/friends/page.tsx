'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { SocialAuthor } from '@mwar/shared';
import { Avatar } from '../../components/ui/Avatar';
import { Card, Spinner, btn } from '../../components/ui/Card';
import { getFollows } from '../../lib/api';
import { useSession } from '../../lib/session';
import { displayName } from '../../lib/format';

function FriendsView() {
  const params = useSearchParams();
  const { boot } = useSession();
  const username = params.get('u') || boot?.user.username || '';
  const tab = params.get('tab') === 'followers' ? 'followers' : 'following';
  const [items, setItems] = useState<SocialAuthor[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (cursor?: string | null) => {
    if (!username) return;
    setLoading(true);
    try {
      const pg = await getFollows(username, tab, cursor);
      setItems((prev) => (cursor ? [...prev, ...pg.items] : pg.items));
      setNext(pg.nextCursor);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, tab]);

  return (
    <div className="max-w-[640px] mx-auto space-y-3">
      <Card className="p-2 flex gap-1">
        {(['following', 'followers'] as const).map((t) => (
          <Link
            key={t}
            href={`/friends?u=${username}&tab=${t}`}
            className={`flex-1 text-center rounded-2xl py-2.5 text-sm font-bold capitalize ${tab === t ? 'bg-[#FFF6C2] text-stone-900' : 'text-stone-500 hover:bg-stone-50'}`}
          >
            {t}
          </Link>
        ))}
      </Card>
      <Card className="p-2">
        {items.map((u) => (
          <Link key={u.id} href={`/profile?u=${u.username}`} className="flex items-center gap-3 p-2.5 rounded-2xl hover:bg-stone-50">
            <Avatar src={u.avatarUrl} name={displayName(u)} size={44} />
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-stone-900 truncate">{displayName(u)}</span>
              <span className="block text-xs text-stone-400">@{u.username}</span>
            </span>
            <span className="text-xs font-bold text-[#B08600]">View</span>
          </Link>
        ))}
        {loading && items.length === 0 && (
          <div className="py-8 flex justify-center">
            <Spinner />
          </div>
        )}
        {!loading && items.length === 0 && (
          <p className="py-10 text-center text-sm text-stone-500">
            {tab === 'following' ? 'Not following anyone yet. Find players from the sidebar or search!' : 'No followers yet.'}
          </p>
        )}
        {next && (
          <div className="flex justify-center p-2">
            <button onClick={() => load(next)} disabled={loading} className={btn.soft}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function FriendsPage() {
  return (
    <Suspense fallback={null}>
      <FriendsView />
    </Suspense>
  );
}
