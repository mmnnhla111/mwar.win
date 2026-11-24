'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SOCIAL_POST_TAGS } from '@mwar/shared';
import type { SocialAuthor } from '@mwar/shared';
import { Icon } from '../ui/Icon';
import { Avatar } from '../ui/Avatar';
import { searchUsers } from '../../lib/api';
import { displayName } from '../../lib/format';
import { useTranslation } from '../../i18n/I18nProvider';

/** Player search (username prefix, debounced, results cached per query) + #tag shortcuts. */
export function SearchBox({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const { t: tr } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<SocialAuthor[]>([]);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, SocialAuthor[]>());
  const boxRef = useRef<HTMLDivElement>(null);

  const term = q.trim();
  const isTag = term.startsWith('#');
  const tagMatches = isTag ? SOCIAL_POST_TAGS.filter((t) => t.toLowerCase().startsWith(term.slice(1).toLowerCase())) : [];

  useEffect(() => {
    if (isTag || term.replace(/^@/, '').length < 2) {
      setUsers([]);
      return;
    }
    const key = term.toLowerCase();
    if (cache.current.has(key)) {
      setUsers(cache.current.get(key)!);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchUsers(term);
        cache.current.set(key, res.users);
        setUsers(res.users);
      } catch {
        setUsers([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [term, isTag]);

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
              if (isTag && tagMatches[0]) go(`/?tag=${tagMatches[0]}`);
              else if (users[0]) go(`/profile?u=${users[0].username}`);
            }
          }}
          placeholder={tr('search.placeholder')}
          className="bg-transparent outline-none text-sm text-stone-800 placeholder:text-stone-400 w-full"
          aria-label={tr('search.aria')}
        />
      </label>
      {open && term.length > 0 && (
        <div className="absolute left-0 right-0 mt-2 bg-white rounded-2xl border border-stone-200/80 shadow-[0_12px_40px_rgba(0,0,0,0.10)] p-1.5 z-50 min-w-[260px]">
          {isTag ? (
            tagMatches.length ? (
              tagMatches.map((t) => (
                <button key={t} onClick={() => go(`/?tag=${t}`)} className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-800">
                  <span className="text-[#C99A00]">#</span>
                  {t}
                </button>
              ))
            ) : (
              <p className="px-3 py-2.5 text-sm text-stone-400">{tr('search.tags')}: {SOCIAL_POST_TAGS.map((t) => `#${t}`).join(' ')}</p>
            )
          ) : term.replace(/^@/, '').length < 2 ? (
            <p className="px-3 py-2.5 text-sm text-stone-400">{tr('search.typeMore')}</p>
          ) : loading && users.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-stone-400">{tr('search.searching')}</p>
          ) : users.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-stone-400">{tr('search.noPlayers')}</p>
          ) : (
            users.map((u) => (
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
            ))
          )}
        </div>
      )}
    </div>
  );
}
