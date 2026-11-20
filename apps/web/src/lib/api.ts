/**
 * MWAR Frontend API Client - Connects directly to local Cloudflare Worker (wrangler dev)
 */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787';

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
