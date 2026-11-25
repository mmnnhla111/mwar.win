'use client';

import React from 'react';
import { Card, Spinner, btn } from '../../components/ui/Card';
import { NotificationRow, useNotifications } from '../../components/shell/NotificationsPanel';
import { useTranslation } from '../../i18n/I18nProvider';

/** /notifications — every notification, newest first (10 per page; read on demand, never polled). */
export default function NotificationsPage() {
  const { t } = useTranslation();
  const { items, next, loading, loadMore, markOne, markAll, unread } = useNotifications();
  return (
    <div className="max-w-[640px] mx-auto space-y-3">
      <div className="flex items-center gap-2 px-1">
        <h1 className="flex-1 text-xl font-extrabold text-stone-900">{t('nav.notifications')}</h1>
        {(unread > 0 || items.some((n) => !n.isRead)) && (
          <button onClick={markAll} className={btn.soft} data-mark-all>
            {t('notif.markAll')}
          </button>
        )}
      </div>
      <Card className="p-2">
        {items.length === 0 && loading && (
          <div className="py-10 flex justify-center">
            <Spinner />
          </div>
        )}
        {items.length === 0 && !loading && <p className="px-3 py-10 text-center text-sm text-stone-400">{t('notif.empty')}</p>}
        {items.map((n) => (
          <NotificationRow key={n.id} n={n} onClick={() => markOne(n)} />
        ))}
        {next && (
          <button onClick={loadMore} disabled={loading} className="w-full py-3 text-sm font-semibold text-stone-500 hover:text-stone-800">
            {loading ? t('common.loading') : t('notif.seeOlder')}
          </button>
        )}
      </Card>
    </div>
  );
}
