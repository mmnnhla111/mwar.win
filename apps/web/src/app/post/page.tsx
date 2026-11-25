'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { SocialPost } from '@mwar/shared';
import { PostCard } from '../../components/social/PostCard';
import { Card, Spinner, btn } from '../../components/ui/Card';
import { getPost } from '../../lib/api';
import { useTranslation } from '../../i18n/I18nProvider';

/** /post?id= — one post (notification click-through; audience rules are applied by the API). */
function PostView() {
  const id = useSearchParams().get('id') || '';
  const { t } = useTranslation();
  const [post, setPost] = useState<SocialPost | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading');

  useEffect(() => {
    if (!id) {
      setState('missing');
      return;
    }
    setState('loading');
    getPost(id)
      .then((r) => {
        setPost(r.post);
        setState('ok');
      })
      .catch(() => setState('missing'));
  }, [id]);

  return (
    <div className="max-w-[640px] mx-auto space-y-3">
      {state === 'loading' && (
        <Card className="p-10 flex justify-center">
          <Spinner size={24} />
        </Card>
      )}
      {state === 'missing' && (
        <Card className="p-10 text-center">
          <div className="text-4xl">🍋</div>
          <div className="mt-2 font-extrabold text-stone-900">{t('post.notFound')}</div>
          <Link href="/" className={`${btn.soft} mt-4 inline-flex`}>
            {t('report.backToFeed')}
          </Link>
        </Card>
      )}
      {state === 'ok' && post && <PostCard post={post} onChange={setPost} onDelete={() => setState('missing')} />}
    </div>
  );
}

export default function PostPage() {
  return (
    <Suspense fallback={null}>
      <PostView />
    </Suspense>
  );
}
