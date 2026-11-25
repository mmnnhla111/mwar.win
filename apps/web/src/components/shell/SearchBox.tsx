'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SOCIAL_POST_TAGS } from '@mwar/shared';
import { Icon } from '../ui/Icon';
import { Avatar } from '../ui/Avatar';
import { searchAll, type SearchResult } from '../../lib/api';

const EMPTY: SearchResult = { users: [], posts: [], hashtags: [] };
import { displayName } from '../../lib/format';
import { useTranslation } from '../../i18n/I18nProvider';

/** Live search: players (username prefix), public posts (text) and #hashtags. Debounced, cached per query. */
export function SearchBox({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const { t: tr } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<SearchResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, SearchResult>());
  const boxRef = useRef<HTMLDivElement>(null);

  const term = q.trim();
  const isTag = term.startsWith('#');
  const tagMatches = isTag ? SOCIAL_POST_TAGS.filter((t) => t.toLowerCase().startsWith(term.slice(1).toLowerCase())) : [];
  const minLen = 2;

  useEffect(() => {
    if (term.replace(/^[@#]/, '').length < minLen - (isTag ? 1 : 0)) {
      setRes(EMPTY);
      return;
    }
    const key = term.toLowerCase();
    if (cache.current.has(key)) {
      setRes(cache.current.get(key)!);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await searchAll(term);
        const v = { users: r.users || [], posts: r.posts || [], hashtags: r.hashtags || [] };
        cache.current.set(key, v);
        setRes(v);
      } catch {
        setRes(EMPTY);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [term, isTag, minLen]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    setQ('');
    router.push(href);
  };

  const hasAny = res.users.length + res.posts.length + res.hashtags.length + tagMatches.length > 0;
  const tooShort = term.replace(/^[@#]/, '').length < 1 || (!isTag && term.replace(/^@/, '').length < 2);

  return (
    <div className="relative" ref={boxRef}>
      <label className="flex items-center gap-2 bg-stone-100 rounded-full px-3.5 h-10 text-stone-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-yellow-300 transition">
        <Icon name="search" size={18} />
        <input
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (isTag && res.hashtags[0]) go(`/?hashtag=${encodeURIComponent(res.hashtags[0].tag)}`);
              else if (isTag && tagMatches[0]) go(`/?tag=${tagMatches[0]}`);
              else if (isTag && term.length > 1) go(`/?hashtag=${encodeURIComponent(term.slice(1).toLowerCase())}`);
              else if (res.users[0]) go(`/profile?u=${res.users[0].username}`);
              else if (res.posts[0]) go(`/post?id=${encodeURIComponent(res.posts[0].id)}`);
            }
          }}
          placeholder={tr('search.placeholder')}
          className="bg-transparent outline-none text-sm text-stone-800 placeholder:text-stone-400 w-full"
          aria-label={tr('search.aria')}
        />
      </label>
      {open && term.length > 0 && (
        <div className="absolute left-0 right-0 mt-2 bg-white rounded-2xl border border-stone-200/80 shadow-[0_12px_40px_rgba(0,0,0,0.10)] p-1.5 z-50 min-w-[260px] max-h-[70dvh] overflow-y-auto" data-search-results>
          {tooShort ? (
            <p className="px-3 py-2.5 text-sm text-stone-400">{isTag ? `${tr('search.tags')}: ${SOCIAL_POST_TAGS.map((t) => `#${t}`).join(' ')}` : tr('search.typeMore')}</p>
          ) : loading && !hasAny ? (
            <p className="px-3 py-2.5 text-sm text-stone-400">{tr('search.searching')}</p>
          ) : !hasAny ? (
            <p className="px-3 py-2.5 text-sm text-stone-400">{tr('search.noResults')}</p>
          ) : (
            <>
              {(res.hashtags.length > 0 || tagMatches.length > 0) && <div className="px-3 pt-1.5 pb-1 text-[11px] font-black text-stone-400 uppercase tracking-wider">{tr('search.hashtags')}</div>}
              {res.hashtags.map((h) => (
                <button key={h.tag} onClick={() => go(`/?hashtag=${encodeURIComponent(h.tag)}`)} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-800" data-search-hashtag>
                  <span>
                    <span className="text-sky-600">#</span>
                    {h.tag}
                  </span>
                  <span className="text-xs text-stone-400">{tr('search.postCount', { n: h.count })}</span>
                </button>
              ))}
              {tagMatches.map((t) => (
                <button key={t} onClick={() => go(`/?tag=${t}`)} className="w-full text-left px-3 py-2 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-800">
                  <span className="text-[#C99A00]">#</span>
                  {tr(`tag.${t}`)}
                </button>
              ))}
              {res.users.length > 0 && <div className="px-3 pt-2 pb-1 text-[11px] font-black text-stone-400 uppercase tracking-wider">{tr('search.players')}</div>}
              {res.users.map((u) => (
                <Link
                  key={u.id}
                  href={`/profile?u=${u.username}`}
                  onClick={() => {
                    setOpen(false);
                    setQ('');
                  }}
                  className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-stone-50"
                >
                  <Avatar src={u.avatarUrl} name={displayName(u)} size={34} />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-stone-800 truncate">{displayName(u)}</span>
                    <span className="block text-xs text-stone-400 truncate">@{u.username}</span>
                  </span>
                </Link>
              ))}
              {res.posts.length > 0 && <div className="px-3 pt-2 pb-1 text-[11px] font-black text-stone-400 uppercase tracking-wider">{tr('search.posts')}</div>}
              {res.posts.map((p) => (
                <button key={p.id} onClick={() => go(`/post?id=${encodeURIComponent(p.id)}`)} className="w-full text-left flex items-start gap-3 px-3 py-2 rounded-xl hover:bg-stone-50" data-search-post>
                  <Avatar src={p.author.avatarUrl} name={displayName(p.author)} size={30} />
                  <span className="min-w-0">
                    <span className="block text-xs font-bold text-stone-500 truncate">{displayName(p.author)}</span>
                    <span className="block text-sm text-stone-800 line-clamp-2 break-words">{p.body || '📷'}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
