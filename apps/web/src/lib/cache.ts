/**
 * Local IndexedDB Asset Cache for 3D Models, Textures, and Audio
 */

const DB_NAME = 'mwar_asset_cache_db';
const DB_VERSION = 1;
const STORE_NAME = 'assets';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('IndexedDB not supported in SSR'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getCachedAsset(url: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(url);

      request.onsuccess = () => {
        if (request.result && request.result.data) {
          resolve(request.result.data);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function storeCachedAsset(url: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put({ url, data, cachedAt: Date.now() });
  } catch {
    // Ignore cache storage errors
  }
}

export async function fetchWithIndexedDbCache(url: string): Promise<ArrayBuffer> {
  const cached = await getCachedAsset(url);
  if (cached) {
    return cached;
  }

  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  await storeCachedAsset(url, buffer);
  return buffer;
}
