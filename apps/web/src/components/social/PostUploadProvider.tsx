'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { PostVisibility, SocialPost, SocialPostTag } from '@mwar/shared';
import { cancelUploads, createPost, MediaGateError, uploadPostMedia } from '../../lib/api';
import { memoDrop } from '../../lib/memo';
import { loadMediaCompress, markMediaLibStale } from '../../lib/mediaCompress';
import { useTranslation } from '../../i18n/I18nProvider';
import { Icon } from '../ui/Icon';

export interface PostDraftPayload {
  body: string;
  tag: SocialPostTag;
  nsfw: boolean;
  visibility: PostVisibility;
  rawFiles: File[];
}

export type PostUploadStage = 'preparing' | 'uploading' | 'done' | 'error';

export interface PostUploadJob {
  id: string;
  stage: PostUploadStage;
  preparePct: number;
  uploadIndex: number;
  uploadTotal: number;
  error?: string;
  draft: PostDraftPayload;
}

type PublishedListener = (post: SocialPost) => void;

interface PostUploadContextValue {
  job: PostUploadJob | null;
  enqueuePost: (draft: PostDraftPayload) => void;
  retryPost: () => void;
  dismissJob: () => void;
  subscribePublished: (listener: PublishedListener) => () => void;
}

const PostUploadContext = createContext<PostUploadContextValue | null>(null);

const newAttemptId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

export function usePostUpload() {
  const ctx = useContext(PostUploadContext);
  if (!ctx) throw new Error('usePostUpload must be used inside PostUploadProvider');
  return ctx;
}

export function PostUploadProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<PostUploadJob | null>(null);
  const listenersRef = useRef<Set<PublishedListener>>(new Set());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRunRef = useRef<string | null>(null);

  const clearDismissTimer = () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  };

  useEffect(() => () => clearDismissTimer(), []);

  const subscribePublished = useCallback((listener: PublishedListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const runJob = useCallback(async (jobId: string, draft: PostDraftPayload) => {
    clearDismissTimer();
    activeRunRef.current = jobId;
    const files = draft.rawFiles;
    const total = files.length;
    const attemptId = newAttemptId();

    setJob({
      id: jobId,
      stage: total > 0 ? 'preparing' : 'uploading',
      preparePct: 0,
      uploadIndex: 0,
      uploadTotal: total,
      draft,
    });

    try {
      const prepared: { blob: Blob; width: number; height: number }[] = [];

      if (total > 0) {
        const lib = await loadMediaCompress();
        for (let i = 0; i < total; i++) {
          if (activeRunRef.current !== jobId) return;
          const f = files[i];
          const isVideo = f.type.startsWith('video/');
          const out = isVideo
            ? await lib.compressVideo(f, {
                onProgress: (p) => {
                  if (activeRunRef.current !== jobId) return;
                  const overall = Math.min(100, Math.max(0, Math.round(((i + p) / total) * 100)));
                  setJob((prev) => (prev && prev.id === jobId ? { ...prev, stage: 'preparing', preparePct: overall } : prev));
                },
              })
            : await lib.compressImage(f);

          prepared.push({ blob: out.blob, width: out.width, height: out.height });
          const overall = Math.min(100, Math.round(((i + 1) / total) * 100));
          setJob((prev) => (prev && prev.id === jobId ? { ...prev, stage: 'preparing', preparePct: overall } : prev));
        }
      }

      if (activeRunRef.current !== jobId) return;
      setJob((prev) =>
        prev && prev.id === jobId ? { ...prev, stage: 'uploading', preparePct: 100, uploadIndex: 1, uploadTotal: total } : prev
      );

      const uploads: string[] = [];
      for (let i = 0; i < prepared.length; i++) {
        if (activeRunRef.current !== jobId) return;
        setJob((prev) => (prev && prev.id === jobId ? { ...prev, stage: 'uploading', uploadIndex: i + 1, uploadTotal: total } : prev));
        const it = prepared[i];
        const up = await uploadPostMedia(it.blob, attemptId, { width: it.width, height: it.height });
        uploads.push(up.uploadId);
      }

      const res = await createPost({
        body: draft.body.trim(),
        tag: draft.tag,
        nsfw: draft.nsfw,
        visibility: draft.visibility,
        uploads,
        attemptId,
      });

      if (activeRunRef.current !== jobId) return;
      memoDrop('feed:');
      const postWithPreview: SocialPost = prepared.length
        ? { ...res.post, localPreviewUrls: prepared.map((p) => URL.createObjectURL(p.blob)) }
        : res.post;
      listenersRef.current.forEach((fn) => fn(postWithPreview));

      setJob((prev) => (prev && prev.id === jobId ? { ...prev, stage: 'done', preparePct: 100 } : prev));
      dismissTimerRef.current = setTimeout(() => {
        setJob((prev) => (prev && prev.id === jobId && prev.stage === 'done' ? null : prev));
      }, 4000);
    } catch (err: any) {
      if (activeRunRef.current !== jobId) return;
      if (total > 0) cancelUploads(attemptId);
      if (err instanceof MediaGateError || err?.code === 'MEDIA_GATE') {
        markMediaLibStale();
      }
      const code = err?.code || '';
      setJob((prev) =>
        prev && prev.id === jobId
          ? { ...prev, stage: 'error', error: code || err?.message || 'POST_FAILED' }
          : prev
      );
    }
  }, []);

  const enqueuePost = useCallback(
    (draft: PostDraftPayload) => {
      const id = newAttemptId();
      void runJob(id, draft);
    },
    [runJob]
  );

  const retryPost = useCallback(() => {
    if (!job) return;
    const id = newAttemptId();
    void runJob(id, job.draft);
  }, [job, runJob]);

  const dismissJob = useCallback(() => {
    clearDismissTimer();
    activeRunRef.current = null;
    setJob(null);
  }, []);

  return (
    <PostUploadContext.Provider value={{ job, enqueuePost, retryPost, dismissJob, subscribePublished }}>
      {children}
      <PostUploadFloatingStatus />
    </PostUploadContext.Provider>
  );
}

function PostUploadFloatingStatus() {
  const { job, retryPost, dismissJob } = usePostUpload();
  const { t } = useTranslation();

  if (!job) return null;

  const resolveErrorText = (codeOrMsg?: string) => {
    if (codeOrMsg === 'VIDEO_TOO_LONG') return t('composer.videoLength', { max: 180 });
    if (codeOrMsg === 'VIDEO_NO_ENCODER') return t('composer.videoNoEncoder');
    if (codeOrMsg === 'MEDIA_GATE') return t('composer.gateFailed');
    if (!codeOrMsg || codeOrMsg === 'POST_FAILED') return t('composer.postFailed');
    return codeOrMsg;
  };

  let label = '';
  if (job.stage === 'preparing') {
    label = t('composer.preparingFile', { pct: job.preparePct });
  } else if (job.stage === 'uploading') {
    label = t('composer.uploadingBg');
  } else if (job.stage === 'done') {
    label = t('composer.postSuccess');
  } else {
    label = resolveErrorText(job.error);
  }

  return (
    <div
      data-post-upload-pill
      data-upload-stage={job.stage}
      role="status"
      aria-live="polite"
      className="fixed bottom-[76px] right-3 md:bottom-5 md:right-5 z-50 max-w-[calc(100vw-24px)] sm:max-w-xs"
    >
      <div
        className={`flex items-center gap-2.5 rounded-2xl px-3.5 py-2.5 shadow-lg border text-xs font-bold backdrop-blur-md transition ${
          job.stage === 'error'
            ? 'bg-rose-50/95 border-rose-200 text-rose-700'
            : job.stage === 'done'
              ? 'bg-emerald-50/95 border-emerald-200 text-emerald-700'
              : 'bg-white/95 border-stone-200 text-stone-800'
        }`}
      >
        {(job.stage === 'preparing' || job.stage === 'uploading') && (
          <span className="w-4 h-4 rounded-full border-2 border-stone-300 border-t-[#EAB308] animate-spin shrink-0" />
        )}
        {job.stage === 'done' && <span className="text-emerald-600 font-black text-sm shrink-0">✓</span>}
        {job.stage === 'error' && <span className="text-rose-600 font-black text-sm shrink-0">!</span>}

        <div className="min-w-0 flex-1">
          <div className="truncate">{label}</div>
          {job.stage === 'preparing' && (
            <div className="mt-1 h-1.5 w-full rounded-full bg-stone-200 overflow-hidden">
              <div
                className="h-full bg-[#FFE135] transition-all duration-200"
                style={{ width: `${job.preparePct}%` }}
              />
            </div>
          )}
        </div>

        {job.stage === 'error' && (
          <button
            type="button"
            onClick={retryPost}
            className="shrink-0 rounded-full bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1 text-[11px] font-bold"
          >
            {t('common.retry')}
          </button>
        )}

        {(job.stage === 'done' || job.stage === 'error') && (
          <button
            type="button"
            onClick={dismissJob}
            aria-label={t('common.close')}
            className="shrink-0 w-6 h-6 rounded-full hover:bg-black/5 flex items-center justify-center text-stone-500"
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
