/** Tiny in-memory page cache so going back to a page within `ttl` costs no request. */
const store = new Map<string, { at: number; value: unknown }>();

export function memoGet<T>(key: string, ttlMs = 60_000): T | null {
  const e = store.get(key);
  if (!e || Date.now() - e.at > ttlMs) return null;
  return e.value as T;
}

export function memoSet<T>(key: string, value: T) {
  store.set(key, { at: Date.now(), value });
}

export function memoDrop(prefix: string) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
