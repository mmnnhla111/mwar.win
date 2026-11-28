'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { TodayQuestsResponse, UserDailyQuestItem } from '@mwar/shared';
import { useSession } from '../lib/session';
import { claimQuest, getTodayQuests } from '../lib/api';
import { Icon, type IconName } from './ui/Icon';
import { Modal, Spinner } from './ui/Card';
import { isAuthPath, isGamePath } from './shell/nav';
import { useTranslation } from '../i18n/I18nProvider';

const SIZE = 52;
const EDGE = 12;
const TOP_MIN = 116; // below the navbar + status strip
const BOTTOM_MIN = 88; // above the mobile bottom nav
const DRAG_THRESHOLD = 6;
const STORAGE_KEY = 'mwar_quest_fab_v1';
const SNAP_EASE = 'cubic-bezier(.2,.9,.3,1.15)';

type Side = 'left' | 'right';
interface SavedPos {
  side: Side;
  yPercent: number;
}

function readSaved(): SavedPos {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (v && (v.side === 'left' || v.side === 'right') && typeof v.yPercent === 'number') return v;
  } catch {
    /* ignore */
  }
  return { side: 'right', yPercent: 0.72 };
}

function clampTop(top: number, vh: number) {
  return Math.min(Math.max(top, TOP_MIN), Math.max(TOP_MIN, vh - BOTTOM_MIN - SIZE));
}

const QUEST_ICON: Record<string, IconName> = {
  daily_checkin: 'calendar',
  watch_rewarded_ad: 'eye',
  finish_game_match: 'target',
  spectate_match_90s: 'eye',
  send_chat_or_network: 'chat',
  earn_coins: 'coin',
};

const OPEN_EVENT = 'mwar:open-daily-quests';
/** Opens the daily missions drawer from anywhere (e.g. the header "Locked 🔒" chip). */
export function openDailyQuests() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT));
}

// Today's quests stay cached for the session once the popup has been opened
let questCache: TodayQuestsResponse | null = null;

const utcToday = () => new Date().toISOString().slice(0, 10);

/**
 * Global floating Daily Quest button: draggable (mouse + touch via Pointer Events), snaps to the left or
 * right edge only, remembers (side, yPercent), hidden in /game and auth pages, and hidden all day once
 * every quest is claimed (it comes back when the UTC day rolls over).
 */
export function FloatingQuestWidget() {
  const pathname = usePathname() || '/';
  const { boot, patch, refresh } = useSession();
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<SavedPos>({ side: 'right', yPercent: 0.72 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const start = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean; id: number } | null>(null);

  useEffect(() => {
    setMounted(true);
    setPos(readSaved());
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onOpen = () => {
      questCache = null; // always show fresh progress when opened from the header
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // New UTC day: the cached "0 left" is stale, ask the server once
  useEffect(() => {
    if (boot && boot.dateKey !== utcToday()) {
      questCache = null;
      refresh(true);
    }
  }, [boot, refresh]);

  const remaining = boot?.remainingDailyQuestsCount ?? 0;
  const hidden = isGamePath(pathname) || isAuthPath(pathname) || !boot || (remaining === 0 && !open);

  const restTop = clampTop(pos.yPercent * viewport.h, viewport.h);
  const restLeft = pos.side === 'left' ? EDGE : viewport.w - EDGE - SIZE;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    start.current = { px: e.clientX, py: e.clientY, ox: e.clientX - restLeft, oy: e.clientY - restTop, moved: false, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    if (!s.moved && Math.hypot(e.clientX - s.px, e.clientY - s.py) <= DRAG_THRESHOLD) return;
    s.moved = true;
    setDrag({
      x: Math.min(Math.max(e.clientX - s.ox, 0), viewport.w - SIZE),
      y: Math.min(Math.max(e.clientY - s.oy, 0), viewport.h - SIZE),
    });
  };

  const finish = (e: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    if (!s.moved) {
      setDrag(null);
      if (!cancelled) setOpen(true);
      return;
    }
    const x = e.clientX - s.ox;
    const y = e.clientY - s.oy;
    // Snap to the nearer side edge only (never the top or bottom), clamp Y between navbar and bottom nav
    const side: Side = x + SIZE / 2 < viewport.w / 2 ? 'left' : 'right';
    const top = clampTop(y, viewport.h);
    const next = { side, yPercent: top / viewport.h };
    setPos(next);
    setDrag(null);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const onAllDone = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 260);
  }, []);

  if (!mounted || hidden) {
    return open ? <QuestModal open={open} closing={closing} onClose={() => setOpen(false)} onAllDone={onAllDone} patch={patch} /> : null;
  }

  const left = drag ? drag.x : restLeft;
  const top = drag ? drag.y : restTop;

  return (
    <>
      <button
        type="button"
        aria-label={t('quest.fabAria', { count: remaining })}
        title={t('quest.title')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e)}
        onPointerCancel={(e) => finish(e, true)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(true)}
        data-quest-fab
        data-side={pos.side}
        style={{
          left,
          top,
          width: SIZE,
          height: SIZE,
          touchAction: 'none',
          transition: drag ? 'none' : `left 220ms ${SNAP_EASE}, top 220ms ${SNAP_EASE}, transform 150ms ease`,
          transform: drag ? 'scale(1.08)' : undefined,
        }}
        className="fixed z-[45] rounded-full bg-[#FFE135] text-stone-900 border-2 border-white shadow-[0_6px_20px_rgba(250,204,21,0.45),0_2px_6px_rgba(0,0,0,0.08)] flex items-center justify-center select-none cursor-grab active:cursor-grabbing"
      >
        <Icon name="quest" size={24} strokeWidth={2.1} />
        <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-[#FF6B6B] text-white text-[11px] font-extrabold flex items-center justify-center ring-2 ring-white">
          {remaining}
        </span>
      </button>
      <QuestModal open={open} closing={closing} onClose={() => setOpen(false)} onAllDone={onAllDone} patch={patch} />
    </>
  );
}

function QuestModal({
  open,
  closing,
  onClose,
  onAllDone,
  patch,
}: {
  open: boolean;
  closing: boolean;
  onClose: () => void;
  onAllDone: () => void;
  patch: ReturnType<typeof useSession>['patch'];
}) {
  const { t, tx: tq } = useTranslation();
  const [data, setData] = useState<TodayQuestsResponse | null>(questCache);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const syncBadge = (d: TodayQuestsResponse) => {
    const left = d.quests.filter((q) => !q.isCompleted).length;
    patch((b) => ({
      ...b,
      remainingDailyQuestsCount: left,
      network: b.network
        ? { ...b.network, unlocked: d.isMlmUnlocked, completedMissions: d.completedQuests, totalMissions: d.totalQuests, requiredMissions: d.requiredToUnlock }
        : b.network,
    }));
    return left;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getTodayQuests();
      questCache = d;
      setData(d);
      syncBadge(d);
    } catch (err: any) {
      setToast(err?.message || t('quest.loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy: only fetched the first time the popup opens
  useEffect(() => {
    if (open && !questCache) load();
  }, [open, load]);

  const claim = async (q: UserDailyQuestItem) => {
    setClaiming(q.questId);
    setToast(null);
    try {
      const r = await claimQuest(q.questId);
      setToast(t('quest.claimedToast', { n: r.rewardCoins }));
      const coinsNow = r.coinsBalance;
      if (typeof coinsNow === 'number') patch((b) => ({ ...b, user: { ...b.user, coins: coinsNow } }));
      const d = await getTodayQuests();
      questCache = d;
      setData(d);
      if (syncBadge(d) === 0) setTimeout(onAllDone, 700);
    } catch (err: any) {
      setToast(err?.message || t('quest.claimFailed'));
    } finally {
      setClaiming(null);
    }
  };

  const done = data?.completedQuests ?? 0;
  const need = data?.requiredToUnlock ?? 4;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-full bg-[#FFE135] flex items-center justify-center">
            <Icon name="quest" size={18} />
          </span>
          {t('quest.modalTitle')}
        </span>
      }
    >
      <div className={`p-5 space-y-4 transition-all duration-300 ${closing ? 'opacity-0 scale-95' : 'opacity-100'}`}>
        <p className="text-sm font-bold text-stone-800 leading-snug" data-mission-intro>
          {t('mlm.missionIntro')}
        </p>
        <div className={`rounded-2xl p-3.5 flex items-center gap-3 ${data?.isMlmUnlocked ? 'bg-[#ECFDF5]' : 'bg-[#FFFBEA]'}`}>
          <Icon name={data?.isMlmUnlocked ? 'check' : 'lock'} size={22} className={data?.isMlmUnlocked ? 'text-emerald-600' : 'text-[#B08600]'} />
          <div className="text-sm leading-snug">
            <div className="font-bold text-stone-900">
              {data?.isMlmUnlocked ? t('quest.unlocked') : t('quest.finishMore', { count: Math.max(0, need - done) })}
            </div>
            <div className="text-stone-500 text-xs">
              {t('quest.progress', { done, need })}
            </div>
          </div>
        </div>

        {loading && !data && (
          <div className="py-10 flex justify-center">
            <Spinner size={24} />
          </div>
        )}

        <ul className="space-y-2.5">
          {data?.quests.map((q) => {
            const pct = Math.min(100, Math.round((q.current / Math.max(1, q.target)) * 100));
            const doneItem = q.isCompleted;
            const canCheckIn = q.questId === 'Q_DAILY_CHECKIN' && !q.isCompleted;
            return (
              <li key={q.questId} className="rounded-2xl border border-stone-200/80 p-3.5">
                <div className="flex items-start gap-3">
                  <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${doneItem ? 'bg-[#D1FAE5] text-emerald-700' : 'bg-stone-100 text-stone-700'}`}>
                    <Icon name={doneItem ? 'check' : QUEST_ICON[q.actionType] || 'sparkle'} size={20} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-bold text-sm text-stone-900 truncate">{tq(`quest.${q.questId}.title`, q.title)}</div>
                    </div>
                    <div className="text-xs text-stone-500 mt-0.5">{tq(`quest.${q.questId}.desc`, q.description)}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-stone-100 overflow-hidden">
                        <div className={`h-full rounded-full ${doneItem ? 'bg-[#34D399]' : 'bg-[#FACC15]'}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[11px] font-semibold text-stone-500 tabular-nums">
                        {Math.min(q.current, q.target)}/{q.target}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-2.5 flex justify-end">
                  {doneItem ? (
                    <span className="text-xs font-bold text-emerald-700 bg-[#D1FAE5] rounded-full px-3 py-1.5">{t('quest.claimed')}</span>
                  ) : canCheckIn ? (
                    <button
                      onClick={() => claim(q)}
                      disabled={claiming === q.questId}
                      className="rounded-full bg-[#FFE135] hover:bg-[#FACC15] text-stone-900 text-xs font-extrabold px-4 py-1.5 disabled:opacity-60"
                    >
                      {claiming === q.questId ? t('quest.claiming') : t('quest.claim')}
                    </button>
                  ) : (
                    <span className="text-xs font-semibold text-stone-400 bg-stone-100 rounded-full px-3 py-1.5">{t('quest.inProgress')}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {toast && <p className="text-center text-sm font-semibold text-stone-700 bg-stone-50 rounded-2xl py-2">{toast}</p>}
        <button onClick={load} disabled={loading} className="w-full text-sm font-semibold text-stone-500 hover:text-stone-800 py-1 flex items-center justify-center gap-1.5">
          <Icon name="refresh" size={15} className={loading ? 'animate-spin' : ''} /> {t('common.refresh')}
        </button>
      </div>
    </Modal>
  );
}
