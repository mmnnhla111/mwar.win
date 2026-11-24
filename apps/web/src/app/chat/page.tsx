'use client';

import React, { useEffect, useState, useRef } from 'react';
import { apiFetch } from '../../lib/api';
import { QuestChatIcon } from '../../components/icons';

export default function ChatPage() {
  const [targetUserId, setTargetUserId] = useState('');
  const [messages, setMessages] = useState<any[]>([]);
  const [inputText, setInputText] = useState('');
  const [teamMembers, setTeamMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlUserId = params.get('userId');
      if (urlUserId) {
        setTargetUserId(urlUserId);
      }
    }

    async function loadContacts() {
      try {
        const [downlineRes, uplineRes] = await Promise.all([
          apiFetch('/api/network/downline'),
          apiFetch('/api/network/upline'),
        ]);

        const contacts: any[] = [];
        if (uplineRes.upline) {
          contacts.push({ ...uplineRes.upline, roleLabel: 'Direct Sponsor', isSponsor: true });
        }
        for (const m of downlineRes.members || []) {
          contacts.push({ id: m.userId, username: m.username, roleLabel: `Level ${m.depth} Downline`, isSponsor: false });
        }
        // Opened from a player's profile ("Message"): add them even if they are not in your network
        const params = new URLSearchParams(window.location.search);
        const directId = params.get('userId');
        if (directId && !contacts.some((c) => c.id === directId)) {
          contacts.unshift({ id: directId, username: params.get('name') || 'Player', roleLabel: 'Player', isSponsor: false });
        }
        setTeamMembers(contacts);

        if (!targetUserId && contacts.length > 0) {
          setTargetUserId(contacts[0].id);
        }
      } catch (err) {
        console.error(err);
      }
    }

    loadContacts();
  }, []);

  const loadMessages = async (userId: string) => {
    if (!userId) return;
    try {
      const res = await apiFetch(`/api/chat/messages/${userId}`);
      setMessages(res.messages || []);
      apiFetch(`/api/chat/read/${userId}`, { method: 'POST' }).catch(() => {});
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (targetUserId) loadMessages(targetUserId);
  }, [targetUserId]);
  // No background polling: messages refresh when a chat opens, after sending, or with the Refresh button

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !targetUserId || isSending) return;

    const text = inputText.trim();
    setInputText('');
    setIsSending(true);

    try {
      await apiFetch('/api/chat/messages', {
        method: 'POST',
        body: JSON.stringify({
          receiver_id: targetUserId,
          message_text: text,
        }),
      });
      await loadMessages(targetUserId);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsSending(false);
    }
  };

  const activeContact = teamMembers.find((m) => m.id === targetUserId);

  return (
    <div className="space-y-4 pb-12">
      {/* 1. Header */}
      <div className="bg-white border border-stone-200/80 rounded-3xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
            <QuestChatIcon size={22} />
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-extrabold text-stone-900 tracking-tight flex items-center space-x-2">
              <span>SQUAD COMMS & NETWORK CHAT</span>
              <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
                ENCRYPTED
              </span>
            </h1>
            <p className="text-xs text-stone-500">Direct 1-on-1 squad communications with your sponsors and downlines.</p>
          </div>
        </div>
      </div>

      {/* 2. Responsive Split Chat Pane (Tablet/Desktop: 2 Columns; Mobile: Stack) */}
      <div className="bg-white border border-stone-200/80 rounded-3xl overflow-hidden shadow-[0_2px_12px_rgba(0,0,0,0.04)] grid grid-cols-1 md:grid-cols-12 min-h-[580px]">
        {/* Left: Contacts Sidebar (Desktop: 4 cols) */}
        <div className="md:col-span-4 border-b md:border-b-0 md:border-r border-stone-200/80 p-3 sm:p-4 space-y-3 bg-stone-50">
          <span className="text-xs font-extrabold text-stone-500 block uppercase tracking-wider px-2">
            Squad Contacts ({teamMembers.length})
          </span>

          {teamMembers.length === 0 ? (
            <div className="p-6 text-center text-xs text-stone-500">
              No contacts yet. Enlist downline members in your team to activate squad chat!
            </div>
          ) : (
            <div className="space-y-1.5 max-h-[160px] md:max-h-[500px] overflow-y-auto no-scrollbar">
              {teamMembers.map((m) => {
                const isActive = m.id === targetUserId;
                return (
                  <button
                    key={m.id}
                    onClick={() => setTargetUserId(m.id)}
                    className={`w-full p-2.5 rounded-2xl text-left transition flex items-center justify-between ${
                      isActive
                        ? 'bg-stone-100 border border-amber-200 shadow-[0_2px_12px_rgba(0,0,0,0.04)]'
                        : 'hover:bg-stone-50 border border-transparent text-stone-600'
                    }`}
                  >
                    <div className="flex items-center space-x-2.5">
                      <div className="w-8 h-8 rounded-xl bg-stone-100 border border-stone-200/80 flex items-center justify-center font-extrabold text-xs text-amber-700 shrink-0">
                        {m.username.substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <span className="text-xs font-extrabold text-stone-900 block">{m.username}</span>
                        <span className="text-[10px] text-stone-500">{m.roleLabel}</span>
                      </div>
                    </div>
                    {m.isSponsor && (
                      <span className="bg-amber-50 text-amber-700 border border-amber-200 text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                        SPONSOR
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Active Message Thread & Input (Desktop: 8 cols) */}
        <div className="md:col-span-8 flex flex-col justify-between h-[580px] bg-white">
          {/* Thread Header */}
          <div className="p-4 border-b border-stone-200/80 bg-stone-50 flex items-center justify-between">
            {activeContact ? (
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-xl bg-stone-100 border border-amber-200 flex items-center justify-center font-extrabold text-xs text-amber-700">
                  {activeContact.username.substring(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-xs font-extrabold text-stone-900">{activeContact.username}</h3>
                  <span className="text-[10px] text-stone-500 font-semibold">{activeContact.roleLabel}</span>
                </div>
              </div>
            ) : (
              <span className="text-xs text-stone-500">Select a squad member to start comms</span>
            )}

            <button
              type="button"
              onClick={() => targetUserId && loadMessages(targetUserId)}
              disabled={!targetUserId}
              className="flex items-center gap-1.5 rounded-full bg-white border border-stone-200 px-3 py-1.5 text-[11px] font-bold text-stone-600 hover:text-stone-900 disabled:opacity-40"
              aria-label="Refresh messages"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg>
              Refresh
            </button>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 p-4 overflow-y-auto space-y-3">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-2 text-stone-500">
                <QuestChatIcon size={32} className="opacity-40" />
                <p className="text-xs">No comms logged yet. Send a message to coordinate tactics!</p>
              </div>
            ) : (
              messages.map((msg) => {
                const isMe = msg.sender_id !== targetUserId;
                return (
                  <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl p-3 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.04)] ${
                        isMe
                          ? 'bg-gradient-to-r from-[#FFE135] to-[#FACC15] text-stone-900 font-medium rounded-br-xs'
                          : 'bg-stone-100 border border-stone-200/80 text-stone-700 rounded-bl-xs'
                      }`}
                    >
                      <p className="leading-relaxed">{msg.message_text}</p>
                      <div className="flex justify-end items-center space-x-1 mt-1 text-[9px] text-stone-600">
                        <span>{new Date(msg.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {isMe && <span>{msg.is_read ? '✓✓' : '✓'}</span>}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input Bar */}
          <form onSubmit={handleSendMessage} className="p-3 border-t border-stone-200/80 bg-stone-50 flex items-center space-x-2">
            <input
              type="text"
              placeholder={activeContact ? `Message ${activeContact.username}...` : 'Select a member first'}
              disabled={!targetUserId}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              className="flex-1 bg-white border border-stone-200/80 rounded-2xl px-4 py-2.5 text-xs text-stone-900 placeholder-stone-400 focus:border-yellow-400 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || !targetUserId || isSending}
              className="bg-gradient-to-r from-[#FFE135] to-[#FACC15] hover:from-[#FACC15] hover:to-[#FACC15] text-stone-900 font-extrabold text-xs px-5 py-2.5 rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] active:scale-95 transition disabled:opacity-50"
            >
              SEND
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
