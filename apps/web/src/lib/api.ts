/**
 * MWAR Frontend API Client - Connects directly to local Cloudflare Worker (wrangler dev)
 */

import type { TodayQuestsResponse, DailyMlmSummary } from '@mwar/shared';

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== 'undefined' && (window.location.hostname === 'mwar.win' || window.location.hostname.endsWith('.mwar.win'))
    ? 'https://api.mwar.win'
    : 'http://127.0.0.1:8787');

let inMemoryToken: string | null = null;

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return inMemoryToken || localStorage.getItem('mwar_auth_token');
}

export function setAuthToken(token: string) {
  inMemoryToken = token;
  if (typeof window !== 'undefined') {
    localStorage.setItem('mwar_auth_token', token);
  }
}

export function clearAuthToken() {
  inMemoryToken = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem('mwar_auth_token');
  }
}

export async function apiFetch<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed with status ${response.status}`);
  }

  return data as T;
}

// User & Profile
export async function getCurrentUser() {
  return apiFetch<{ user: any; wallet: any }>('/api/auth/me');
}

export async function updateProfile(data: { username?: string; avatarUrl?: string }) {
  return apiFetch<{ success: boolean; user: any; remainingRenames: number }>('/api/auth/profile', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Daily Quests & MLM Engine
export async function getTodayQuests(dateKey?: string): Promise<TodayQuestsResponse> {
  const query = dateKey ? `?dateKey=${dateKey}` : '';
  return apiFetch<TodayQuestsResponse>(`/api/quests/today${query}`);
}

export async function progressQuest(questId: string, increment = 1, dateKey?: string) {
  return apiFetch<{
    success: boolean;
    questId: string;
    current: number;
    isCompleted: boolean;
    isMlmUnlocked: boolean;
    justUnlockedMlm: boolean;
  }>('/api/quests/progress', {
    method: 'POST',
    body: JSON.stringify({ questId, increment, dateKey }),
  });
}

export async function claimQuest(questId: string, dateKey?: string) {
  return apiFetch<{
    success: boolean;
    questId: string;
    rewardCoins: number;
    rewardMicroUsd: number;
    formattedReward: string;
  }>('/api/quests/claim', {
    method: 'POST',
    body: JSON.stringify({ questId, dateKey }),
  });
}

export async function getDailyMlmSummary(dateKey?: string): Promise<DailyMlmSummary> {
  const query = dateKey ? `?dateKey=${dateKey}` : '';
  return apiFetch<DailyMlmSummary>(`/api/wallet/daily-mlm-summary${query}`);
}

export async function settleDailyMlm(dateKey?: string, targetUserId?: string) {
  return apiFetch<{
    success: boolean;
    dateKey: string;
    settledUsersCount: number;
    forfeitedUsersCount: number;
    totalSettledMicroUsd: number;
    formattedSettled: string;
    totalForfeitedMicroUsd: number;
    formattedForfeited: string;
  }>('/api/cron/settle-daily-mlm', {
    method: 'POST',
    body: JSON.stringify({ dateKey, targetUserId }),
  });
}

// Server Nodes & 1-Click Provisioning API
export interface GameNode {
  id: string;
  node_name: string;
  role: 'all' | 'game' | 'logs';
  status: 'online' | 'offline';
  ip_address?: string;
  region?: string;
  cpu_usage: number;
  ram_usage: number;
  active_rooms: number;
  player_count: number;
  room_capacity_mini: number;
  room_capacity_fast: number;
  provision_token?: string;
  tunnel_hostname?: string;
  last_heartbeat?: number;
  created_at: number;
}

export async function getServerNodes() {
  return apiFetch<{ nodes: GameNode[]; provisionKey?: string }>('/api/nodes');
}

export async function getProvisionCommand(data: { role: string; nodeName: string; tunnelToken?: string }) {
  return apiFetch<{ command: string; provisionKey: string }>('/api/nodes/provision-command', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateNodeCapacity(nodeId: string, data: { room_capacity_mini?: number; room_capacity_fast?: number }) {
  return apiFetch<{ success: boolean; node: GameNode }>(`/api/nodes/${nodeId}/capacity`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
