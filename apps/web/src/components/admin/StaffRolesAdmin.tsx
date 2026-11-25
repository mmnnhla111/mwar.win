'use client';

import React, { useEffect, useState } from 'react';
import { STAFF_ROLES } from '@mwar/shared';
import type { StaffAuditEntry, StaffMember, StaffRole } from '@mwar/shared';
import { getStaff, getStaffAudit, setStaffRole } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useTranslation } from '../../i18n/I18nProvider';

const ROLE_TINT: Record<StaffRole, string> = {
  super_admin: 'bg-stone-900 text-[#FFE135]',
  admin: 'bg-[#FFE4E6] text-rose-700',
  moderator: 'bg-[#E0F2FE] text-sky-700',
  support: 'bg-[#D1FAE5] text-emerald-700',
  finance_auditor: 'bg-[#FFF6C2] text-[#8A6A00]',
  user: 'bg-stone-100 text-stone-600',
};

/** /admin → "ทีมงานและตำแหน่ง (Staff & Roles)": super_admin searches players, assigns roles, reads the audit log. */
export function StaffRolesAdmin() {
  const { t, lang } = useTranslation();
  const { boot } = useSession();
  const [q, setQ] = useState('');
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [results, setResults] = useState<StaffMember[] | null>(null);
  const [audit, setAudit] = useState<StaffAuditEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const loadAll = async () => {
    try {
      const [s, a] = await Promise.all([getStaff(), getStaffAudit()]);
      setStaff(s.items);
      setAudit(a.items);
    } catch (e: any) {
      setMsg(e?.message || t('common.error'));
    }
  };
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = q.trim().replace(/^@/, '');
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const id = setTimeout(async () => {
      try {
        setResults((await getStaff(term)).items);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const assign = async (m: StaffMember, role: StaffRole) => {
    if (role === m.staffRole) return;
    setBusy(m.id);
    setMsg('');
    try {
      const r = await setStaffRole(m.id, role);
      setMsg(t('staff.updated', { user: m.username, role: t(`staff.role.${r.member.staffRole}`) }));
      setResults((prev) => prev?.map((x) => (x.id === m.id ? r.member : x)) || null);
      await loadAll();
    } catch (e: any) {
      setMsg(e?.message || t('common.error'));
    } finally {
      setBusy(null);
    }
  };

  const row = (m: StaffMember) => (
    <div key={m.id} className="flex items-center gap-3 py-2.5 flex-wrap" data-staff-row={m.username}>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-sm text-stone-900 truncate">{m.displayName || m.username}</div>
        <div className="text-xs text-stone-400 truncate">@{m.username}</div>
      </div>
      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-black ${ROLE_TINT[m.staffRole]}`}>{t(`staff.role.${m.staffRole}`)}</span>
      <select
        value={m.staffRole}
        disabled={busy === m.id || m.id === boot?.user.id}
        onChange={(e) => assign(m, e.target.value as StaffRole)}
        aria-label={t('staff.assign')}
        className="rounded-xl border border-stone-200 bg-white px-2 py-1.5 text-xs font-bold text-stone-700 disabled:opacity-50"
        data-staff-select={m.username}
      >
        {STAFF_ROLES.map((r) => (
          <option key={r} value={r}>
            {t(`staff.role.${r}`)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-staff-admin>
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <h2 className="font-extrabold text-stone-900">{t('admin.tab.staff')}</h2>
        <p className="text-xs text-stone-500 mt-1">{t('staff.hint')}</p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('staff.search')}
          className="mt-3 w-full rounded-2xl border border-stone-200 bg-stone-50 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-300"
          data-staff-search
        />
        {msg && <p className="mt-2 text-xs font-semibold text-amber-700" role="status">{msg}</p>}
        {results && (
          <div className="mt-2 divide-y divide-stone-100">
            {results.length ? results.map(row) : <p className="py-4 text-center text-sm text-stone-400">{t('search.noPlayers')}</p>}
          </div>
        )}
        <div className="mt-4 text-[11px] font-black text-stone-400 uppercase tracking-wider">{t('staff.current', { n: staff.length })}</div>
        <div className="divide-y divide-stone-100">{staff.map(row)}</div>
        <div className="mt-4 rounded-2xl bg-stone-50 border border-stone-100 p-3 text-[11px] text-stone-500 leading-relaxed space-y-0.5">
          {STAFF_ROLES.filter((r) => r !== 'user').map((r) => (
            <div key={r}>
              <b className="text-stone-700">{t(`staff.role.${r}`)}</b> — {t(`staff.desc.${r}`)}
            </div>
          ))}
        </div>
      </div>
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <h2 className="font-extrabold text-stone-900">{t('staff.audit')}</h2>
        <div className="mt-2 divide-y divide-stone-100 text-xs" data-staff-audit>
          {audit.length === 0 && <p className="py-6 text-center text-stone-400">{t('staff.auditEmpty')}</p>}
          {audit.map((a) => (
            <div key={a.id} className="py-2 flex items-start gap-2">
              <span className="text-stone-400 tabular-nums shrink-0 w-24">{new Date(a.createdAt * 1000).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="text-stone-700 min-w-0">
                <b>@{a.actorUsername || '?'}</b> · {t(`staff.action.${a.action}`)} · <b>@{a.targetUsername || '?'}</b>{' '}
                <span className="text-stone-500">
                  {a.oldValue ? `${a.action === 'staff_role' ? t(`staff.role.${a.oldValue}`) : a.oldValue} → ` : ''}
                  {a.action === 'staff_role' && a.newValue ? t(`staff.role.${a.newValue}`) : a.newValue}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
