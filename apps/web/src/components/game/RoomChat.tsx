'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { Room } from 'colyseus.js';
import { useTranslation } from '../../i18n/I18nProvider';

interface ChatLine {
  key: string;
  username: string;
  text: string;
  spectator: boolean;
  streamer: boolean;
}

/** V1.2 C Streamer Room chat (spectators + players; signed-in only, rate-limited by the game server). */
export function RoomChat({ room, canChat }: { room: Room | null; canChat: boolean }) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    if (!room) return;
    const off1 = room.onMessage('room_chat', (m: any) => {
      setLines((prev) => [...prev.slice(-29), { key: `${Date.now()}_${seq.current++}`, username: String(m?.username || '?'), text: String(m?.text || ''), spectator: !!m?.spectator, streamer: !!m?.streamer }]);
    });
    const off2 = room.onMessage('room_chat_refused', () => setNote(t('chatroom.signIn')));
    return () => {
      off1?.();
      off2?.();
    };
  }, [room, t]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v || !room) return;
    room.send('room_chat', { text: v.slice(0, 140) });
    setText('');
  };

  return (
    <div className="pointer-events-auto w-[min(88vw,300px)] rounded-2xl bg-slate-950/70 backdrop-blur-sm border border-rose-400/30 p-2 text-white" data-room-chat>
      <div className="text-[10px] font-black text-rose-300 mb-1">🔴 {t('chatroom.title')}</div>
      <div className="max-h-36 overflow-y-auto space-y-0.5 text-[11px] leading-snug">
        {lines.length === 0 && <div className="text-white/40">{t('chatroom.empty')}</div>}
        {lines.map((l) => (
          <div key={l.key}>
            <span className={`font-bold ${l.streamer ? 'text-rose-300' : l.spectator ? 'text-sky-300' : 'text-amber-300'}`}>
              {l.streamer ? '🎙️ ' : ''}
              {l.username}
            </span>
            <span className="text-white/85">: {l.text}</span>
          </div>
        ))}
      </div>
      {canChat ? (
        <form onSubmit={send} className="mt-1.5 flex gap-1">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={140}
            placeholder={t('chatroom.placeholder')}
            className="flex-1 min-w-0 rounded-full bg-white/10 border border-white/15 px-2.5 py-1 text-[11px] text-white placeholder:text-white/40 outline-none"
            onKeyDown={(e) => e.stopPropagation()}
            onKeyUp={(e) => e.stopPropagation()}
          />
          <button type="submit" className="rounded-full bg-rose-500 px-2.5 text-[11px] font-black">
            {t('chatroom.send')}
          </button>
        </form>
      ) : (
        <div className="mt-1 text-[10px] text-white/50">{note || t('chatroom.signIn')}</div>
      )}
    </div>
  );
}
