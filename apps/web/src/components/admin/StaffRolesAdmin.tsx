'use client';

import React, { useEffect, useState } from 'react';
import { ASSIGNABLE_STAFF_ROLES } from '@mwar/shared';
import type { StaffAuditEntry, StaffMember, StaffRole } from '@mwar/shared';
import { getStaff, getStaffAudit, searchStaffCandidates, setStaffRoles } from '../../lib/api';
import { useTranslation } from '../../i18n/I18nProvider';

const ROLE_TINT: Record<StaffRole, string> = {
  super_admin: 'bg-stone-900 text-[#FFE135]',
  admin: 'bg-[#FFE4E6] text-rose-700',
  ops_manager: 'bg-[#EDE9FE] text-violet-700',
  moderator: 'bg-[#E0F2FE] text-sky-700',
  support: 'bg-[#D1FAE5] text-emerald-700',
  finance_auditor: 'bg-[#FFF6C2] text-[#8A6A00]',
  user: 'bg-stone-100 text-stone-600',
};

const rolesOf = (m: StaffMember): StaffRole[] => (m.staffRoles?.length ? m.staffRoles : m.staffRole !== 'user' ? [m.staffRole] : []);

/** /admin → "ทีมงานและตำแหน่ง (Staff & Roles)": super_admin adds members as staff with one or more roles, edits or demotes them. */
export function StaffRolesAdmin() {
  const { t, lang } = useTranslation();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [audit, setAudit] = useState<StaffAuditEntry[]>([]);
  const [msg, setMsg] = useState('');
  // Modal: member = null while picking (add mode); `adding` tells add from edit
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [member, setMember] = useState<StaffMember | null>(null);
  const [picked, setPicked] = useState<Set<StaffRole>>(new Set());
  const [q, setQ] = useState('');
  const [results, setResults] = useState<StaffMember[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

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
    if (!open || !adding || member) return;
    const term = q.trim().replace(/^@/, '');
    if (!term) {
      setResults(null);
      return;
    }
    const id = setTimeout(async () => {
      try {
        setResults((await searchStaffCandidates(term)).items);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q, open, adding, member]);

  const openAdd = () => {
    setAdding(true);
    setMember(null);
    setPicked(new Set());
    setQ('');
    setResults(null);
    setErr('');
    setOpen(true);
  };
  const openEdit = (m: StaffMember) => {
    setAdding(false);
    setMember(m);
    setPicked(new Set(rolesOf(m)));
    setErr('');
    setOpen(true);
  };
  const pick = (m: StaffMember) => {
    setMember(m);
    setPicked(new Set(rolesOf(m)));
  };
  const toggle = (r: StaffRole) =>
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });

  const save = async (roles: StaffRole[]) => {
    if (!member) return;
    setBusy(true);
    setErr('');
    try {
      const r = await setStaffRoles(member.id, roles);
      const now = rolesOf(r.member);
      setMsg(now.length ? t('staff2.saved', { user: member.username, roles: now.map((x) => t(`staff.role.${x}`)).join(' + ') }) : t('staff2.demoted', { user: member.username }));
      setOpen(false);
      await loadAll();
    } catch (e: any) {
      setErr(e?.message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const protectedMember = !!member && rolesOf(member).includes('super_admin');
  // The legacy all-round `admin` role stays visible (and can be unticked) only for accounts that still hold it
  const choices: StaffRole[] = [...ASSIGNABLE_STAFF_ROLES, ...(member && rolesOf(member).includes('admin') ? (['admin'] as StaffRole[]) : [])];

  const rolesText = (v: string | null) => (v ? v.split(',').map((r) => t(`staff.role.${r}`)).join(' + ') : '');

  const row = (m: StaffMember) => {
    const roles = rolesOf(m);
    const locked = roles.includes('super_admin');
    return (
      <div key={m.id} className="flex items-center gap-3 py-2.5 flex-wrap" data-staff-row={m.username} data-staff-locked={locked ? '1' : '0'}>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm text-stone-900 truncate">{m.displayName || m.username}</div>
          <div className="text-xs text-stone-400 truncate">@{m.username}</div>
        </div>
        <div className="flex flex-wrap gap-1 justify-end">
          {roles.map((r) => (
            <span key={r} className={`rounded-full px-2.5 py-0.5 text-[11px] font-black ${ROLE_TINT[r]}`}>
              {r === 'super_admin' ? '🔒 ' : ''}
              {t(`staff.role.${r}`)}
            </span>
          ))}
        </div>
        {locked ? (
          <span className="text-[11px] font-bold text-stone-400" data-staff-protected>{t('staff2.protected')}</span>
        ) : (
          <div className="flex gap-1.5">
            <button onClick={() => openEdit(m)} className="rounded-xl border border-stone-200 bg-white px-3 py-1.5 text-xs font-bold text-stone-700 hover:bg-stone-50" data-staff-edit={m.username}>
              {t('staff2.edit')}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-staff-admin>
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-extrabold text-stone-900">{t('admin.tab.staff')}</h2>
            <p className="text-xs text-stone-500 mt-1">{t('staff2.hint')}</p>
          </div>
          <button onClick={openAdd} className="shrink-0 rounded-2xl bg-[#FFE135] px-3.5 py-2 text-xs font-extrabold text-stone-900 hover:brightness-95 active:scale-95" data-staff-add>
            {t('staff2.add')}
          </button>
        </div>
        {msg && <p className="mt-2 text-xs font-semibold text-amber-700" role="status">{msg}</p>}
        <div className="mt-4 text-[11px] font-black text-stone-400 uppercase tracking-wider">{t('staff.current', { n: staff.length })}</div>
        <div className="divide-y divide-stone-100">{staff.map(row)}</div>
        <div className="mt-4 rounded-2xl bg-stone-50 border border-stone-100 p-3 text-[11px] text-stone-500 leading-relaxed space-y-0.5">
          {(['super_admin', ...ASSIGNABLE_STAFF_ROLES] as StaffRole[]).map((r) => (
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
                  {a.action === 'staff_roles' || a.action === 'staff_role'
                    ? `${a.oldValue ? `${rolesText(a.oldValue)} → ` : ''}${rolesText(a.newValue)}`
                    : `${a.oldValue ? `${a.oldValue} → ` : ''}${a.newValue ?? ''}`}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" role="dialog" aria-modal="true" data-staff-modal onClick={() => !busy && setOpen(false)}>
          <div className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-extrabold text-stone-900">{adding ? t('staff2.add') : t('staff2.editTitle')}</h3>
              <button onClick={() => setOpen(false)} className="text-stone-400 hover:text-stone-900 font-bold" aria-label={t('common.close')}>✕</button>
            </div>

            {!member ? (
              <div className="mt-3">
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('staff2.searchMember')}
                  className="w-full rounded-2xl border border-stone-200 bg-stone-50 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-300"
                  data-staff-search
                />
                <div className="mt-2 divide-y divide-stone-100 max-h-64 overflow-y-auto">
                  {results && results.length === 0 && <p className="py-4 text-center text-sm text-stone-400">{t('search.noPlayers')}</p>}
                  {results?.map((m) => (
                    <button key={m.id} onClick={() => pick(m)} className="w-full text-left py-2.5 px-1 hover:bg-stone-50 flex items-center gap-2" data-staff-candidate={m.username}>
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold text-sm text-stone-900 truncate">{m.displayName || m.username}</span>
                        <span className="block text-xs text-stone-400 truncate">@{m.username}</span>
                      </span>
                      {rolesOf(m).map((r) => (
                        <span key={r} className={`rounded-full px-2 py-0.5 text-[10px] font-black ${ROLE_TINT[r]}`}>{t(`staff.role.${r}`)}</span>
                      ))}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <div className="rounded-2xl bg-stone-50 border border-stone-100 px-3 py-2">
                  <div className="font-bold text-sm text-stone-900 truncate">{member.displayName || member.username}</div>
                  <div className="text-xs text-stone-400 truncate">@{member.username}</div>
                </div>
                {protectedMember ? (
                  <p className="mt-3 text-sm font-bold text-stone-500" data-staff-protected>🔒 {t('staff2.protectedLong')}</p>
                ) : (
                  <>
                    <div className="mt-3 text-[11px] font-black text-stone-400 uppercase tracking-wider">{t('staff2.pickRoles')}</div>
                    <div className="mt-1.5 space-y-1.5">
                      {choices.map((r) => (
                        <label key={r} className="flex items-start gap-2.5 rounded-2xl border border-stone-200 px-3 py-2 cursor-pointer hover:bg-stone-50">
                          <input type="checkbox" checked={picked.has(r)} onChange={() => toggle(r)} className="mt-0.5 h-4 w-4 accent-[#E5B800]" data-role-checkbox={r} />
                          <span className="min-w-0">
                            <span className="block text-sm font-bold text-stone-900">{t(`staff.role.${r}`)}</span>
                            <span className="block text-[11px] text-stone-500">{t(`staff.desc.${r}`)}</span>
                          </span>
                        </label>
                      ))}
                      <div className="flex items-start gap-2.5 rounded-2xl border border-dashed border-stone-200 px-3 py-2 opacity-70" data-role-locked="super_admin">
                        <input type="checkbox" disabled checked={false} className="mt-0.5 h-4 w-4" />
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-stone-600">🔒 {t('staff.role.super_admin')}</span>
                          <span className="block text-[11px] text-stone-400">{t('staff2.superLocked')}</span>
                        </span>
                      </div>
                    </div>
                  </>
                )}
                {err && <p className="mt-2 text-xs font-semibold text-rose-600" role="alert">{err}</p>}
                {!protectedMember && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      onClick={() => save(Array.from(picked))}
                      disabled={busy || (adding && picked.size === 0)}
                      className="flex-1 rounded-2xl bg-[#FFE135] px-4 py-2.5 text-sm font-extrabold text-stone-900 disabled:opacity-50"
                      data-staff-save
                    >
                      {busy ? t('common.loading') : t('common.save')}
                    </button>
                    {!adding && (
                      <button
                        onClick={() => {
                          if (window.confirm(t('staff2.removeConfirm', { user: member.username }))) save([]);
                        }}
                        disabled={busy}
                        className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-bold text-rose-700 disabled:opacity-50"
                        data-staff-remove
                      >
                        {t('staff2.remove')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
