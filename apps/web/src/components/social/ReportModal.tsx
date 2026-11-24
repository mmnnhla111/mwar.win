'use client';

import React, { useState } from 'react';
import { REPORT_REASONS, SOCIAL_REPORT_CONTACT_MAX_CHARS, SOCIAL_REPORT_DETAILS_MAX_CHARS } from '@mwar/shared';
import type { ReportReason } from '@mwar/shared';
import { Modal, btn, inputCls } from '../ui/Card';
import { reportPost } from '../../lib/api';
import { useTranslation } from '../../i18n/I18nProvider';


/** The report / takedown form body (used by the modal and the standalone /report page). */
export function ReportForm({ postId, onDone, onCancel }: { postId: string; onDone?: () => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || busy) return;
    setBusy(true);
    setError('');
    try {
      await reportPost({ postId, reasonCategory: reason, details: details.trim(), contact: contact.trim() });
      setDone(true);
    } catch (err: any) {
      setError(err?.message || t('report.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="text-center py-4" data-report-done>
        <div className="mx-auto w-14 h-14 rounded-full bg-[#FFF6C2] flex items-center justify-center text-2xl">🍋</div>
        <p className="mt-3 font-bold text-stone-900">{t('report.done')}</p>
        <button onClick={onDone} className={`${btn.primary} mt-4`}>{t('common.ok')}</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-stone-500">{t('report.chooseReason')}</p>
      <div className="space-y-2" role="radiogroup">
        {REPORT_REASONS.map((r) => (
          <label
            key={r}
            className={`flex items-start gap-3 rounded-2xl border px-3 py-2.5 cursor-pointer transition ${reason === r ? 'border-yellow-400 bg-[#FFFBEA]' : 'border-stone-200 hover:bg-stone-50'}`}
          >
            <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="mt-1 accent-yellow-500" />
            <span className="text-sm font-semibold text-stone-800">{t(`report.reason.${r}`)}</span>
          </label>
        ))}
      </div>
      <div>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value.slice(0, SOCIAL_REPORT_DETAILS_MAX_CHARS))}
          rows={3}
          placeholder={t('report.details')}
          className={`${inputCls} resize-none`}
        />
        <div className="text-right text-[11px] text-stone-400">{details.length}/{SOCIAL_REPORT_DETAILS_MAX_CHARS}</div>
      </div>
      <input
        value={contact}
        onChange={(e) => setContact(e.target.value.slice(0, SOCIAL_REPORT_CONTACT_MAX_CHARS))}
        placeholder={t('report.contact')}
        className={inputCls}
      />
      {error && <p className="text-sm font-semibold text-rose-500">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} className={btn.soft}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" disabled={!reason || busy} className={btn.primary}>
          {busy ? t('common.sending') : t('report.send')}
        </button>
      </div>
    </form>
  );
}

/** Cute takedown / report modal opened from a post's "..." menu. */
export function ReportModal({ postId, open, onClose }: { postId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t('report.title')} maxWidth="max-w-lg">
      <ReportForm postId={postId} onDone={onClose} onCancel={onClose} />
      <p className="mt-3 text-[11px] text-stone-400">
        {t('report.directLink')} <a className="underline" href={`/report?post=${encodeURIComponent(postId)}`}>/report?post={postId}</a>
      </p>
    </Modal>
  );
}
