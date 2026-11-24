'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card, Spinner } from '../../components/ui/Card';
import { ReportForm } from '../../components/social/ReportModal';
import { useTranslation } from '../../i18n/I18nProvider';

function ReportInner() {
  const params = useSearchParams();
  const { t } = useTranslation();
  const postId = (params.get('post') || '').trim().slice(0, 64);
  if (!postId) {
    return (
      <p className="text-sm text-stone-500">
        {t('report.noPost')}
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-stone-400 mb-3 break-all">{t('takedown.post')}: {postId}</p>
      <ReportForm postId={postId} onDone={() => (window.location.href = '/')} />
    </>
  );
}

/** Standalone takedown page: /report?post=<id> (shareable link, same form as the post-card modal). */
export default function ReportPage() {
  const { t } = useTranslation();
  return (
    <div className="max-w-lg mx-auto space-y-4">
      <h1 className="text-2xl font-black text-stone-900">{t('report.title')}</h1>
      <Card className="p-5">
        <Suspense fallback={<Spinner />}>
          <ReportInner />
        </Suspense>
      </Card>
      <Link href="/" className="text-sm font-bold text-amber-700">
        ← {t('report.backToFeed')}
      </Link>
    </div>
  );
}
