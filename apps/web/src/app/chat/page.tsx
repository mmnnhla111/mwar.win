'use client';

import React, { useEffect, useState, useRef } from 'react';
import { apiFetch } from '../../lib/api';

export default function ChatPage() {
  const [targetUserId, setTargetUserId] = useState('');
  const [messages, setMessages] = useState<any[]>([]);
  const [inputText, setInputText] = useState('');
  const [teamMembers, setTeamMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Check URL parameters
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlUserId = params.get('userId');
      if (urlUserId) {
        setTargetUserId(urlUserId);
      }
    }

    // Load available chat contacts from network
    async function loadContacts() {
      try {
        const [downlineRes, uplineRes] = await Promise.all([
          apiFetch('/api/network/downline'),
          apiFetch('/api/network/upline'),
        ]);

        const contacts: any[] = [];
        if (uplineRes.upline) {
          contacts.push({ ...uplineRes.upline, roleLabel: 'Direct Sponsor' });
        }
        for (const m of downlineRes.members || []) {
          contacts.push({ id: m.userId, username: m.username, roleLabel: `Level ${m.depth} Downline` });
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
      // Mark as read
      apiFetch(`/api/chat/read/${userId}`, { method: 'POST' }).catch(() => {});
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (targetUserId) {
      loadMessages(targetUserId);
      const interval = setInterval(() => loadMessages(targetUserId), 3000);
      return () => clearInterval(interval);
    }
  }, [targetUserId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !targetUserId) return;

    const text = inputText.trim();
    setInputText('');

    try {
      await apiFetch('/api/chat/messages', {
        method: 'POST',
        body: JSON.stringify({
          receiver_id: targetUserId,
          message_text: text,
        }),
      });
      await loadMessages(targetUserId);
    } catch (err: any) {
      alert(`Send Error: ${err.message}`);
    }
  };

  const currentContact = teamMembers.find((c) => c.id === targetUserId);

  return (
    <div className="h-[calc(100vh-6rem)] flex rounded-2xl border border-gray-800 bg-surface overflow-hidden">
      {/* Left Contacts Sidebar */}
      <div className="w-80 border-r border-gray-800 flex flex-col bg-surfaceLight/30">
        <div className="p-4 border-b border-gray-800">
          <h2 className="text-base font-black text-white">1-on-1 DIRECT CHAT</h2>
          <p className="text-[11px] text-gray-400">Encrypted D1 chat with sponsors & downlines</p>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-gray-800">
          {teamMembers.length === 0 ? (
            <div className="p-4 text-xs text-gray-500 text-center">
              No team contacts found. Share your referral link to build your team.
            </div>
          ) : (
            teamMembers.map((contact) => (
              <button
                key={contact.id}
                onClick={() => setTargetUserId(contact.id)}
                className={`w-full p-3 text-left transition flex items-center space-x-3 ${
                  targetUserId === contact.id ? 'bg-red-600/20 border-l-4 border-red-500' : 'hover:bg-surfaceLight/50'
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center font-bold text-xs text-yellow-400">
                  {contact.username.substring(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 overflow-hidden">
                  <div className="font-bold text-xs text-white truncate">{contact.username}</div>
                  <div className="text-[10px] text-gray-400">{contact.roleLabel}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right Chat Area */}
      <div className="flex-1 flex flex-col bg-background/50">
        {targetUserId ? (
          <>
            {/* Chat Header */}
            <div className="p-4 border-b border-gray-800 bg-surface/80 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white">{currentContact?.username || 'Team Member'}</h3>
                <span className="text-[10px] text-gray-400 font-mono">User ID: {targetUserId}</span>
              </div>
            </div>

            {/* Messages Scroll Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-gray-500">
                  No message history yet. Say hello to coordinate tactical gameplay or team strategies!
                </div>
              ) : (
                messages.map((m) => {
                  const isMine = m.sender_id !== targetUserId;
                  return (
                    <div key={m.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-md p-3 rounded-2xl text-xs space-y-1 ${
                          isMine
                            ? 'bg-red-600 text-white rounded-br-none'
                            : 'bg-surfaceLight border border-gray-700 text-gray-200 rounded-bl-none'
                        }`}
                      >
                        <p>{m.message_text}</p>
                        <span className={`text-[9px] block text-right ${isMine ? 'text-red-200' : 'text-gray-400'}`}>
                          {new Date(m.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Chat Input */}
            <form onSubmit={handleSendMessage} className="p-3 border-t border-gray-800 bg-surface flex space-x-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Type a message to your team member..."
                className="flex-1 bg-surfaceLight border border-gray-700 rounded-xl px-4 py-2 text-xs text-white focus:outline-none focus:border-red-500"
              />
              <button
                type="submit"
                className="bg-red-600 hover:bg-red-500 text-white font-bold px-5 py-2 rounded-xl text-xs transition"
              >
                Send
              </button>
            </form>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-gray-500">
            Select a team member from the left sidebar to start chatting.
          </div>
        )}
      </div>
    </div>
  );
}
