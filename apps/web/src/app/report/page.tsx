'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card, Spinner } from '../../components/ui/Card';
import { ReportForm } from '../../components/social/ReportModal';

function ReportInner() {
  const params = useSearchParams();
  const postId = (params.get('post') || '').trim().slice(0, 64);
  if (!postId) {
    return (
      <p className="text-sm text-stone-500">
        ไม่พบโพสต์ที่ต้องการแจ้ง (No post selected). เปิดเมนู <b>…</b> บนโพสต์แล้วเลือก <b>แจ้งขอให้ลบ / Report</b>.
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-stone-400 mb-3 break-all">Post: {postId}</p>
      <ReportForm postId={postId} onDone={() => (window.location.href = '/')} />
    </>
  );
}

/** Standalone takedown page: /report?post=<id> (shareable link, same form as the post-card modal). */
export default function ReportPage() {
  return (
    <div className="max-w-lg mx-auto space-y-4">
      <h1 className="text-2xl font-black text-stone-900">แจ้งขอให้ลบ <span className="text-stone-400 text-base font-bold">Report</span></h1>
      <Card className="p-5">
        <Suspense fallback={<Spinner />}>
          <ReportInner />
        </Suspense>
      </Card>
      <Link href="/" className="text-sm font-bold text-amber-700">
        ← Back to feed
      </Link>
    </div>
  );
}
