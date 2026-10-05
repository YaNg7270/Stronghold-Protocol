// Persistence of the offline server state (sessions, rooms, the running match) — IndexedDB in the browser, an in-memory
// map elsewhere. GameServer reads synchronously at start, so the store is loaded fully first; writes go through
// asynchronously (the latest value wins).

export async function openStore(name) {
  const mem = new Map();
  const idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
  if (!idb) return memoryStore(mem);
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const st = tx.objectStore('kv');
      const cur = st.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(); return; }
        mem.set(c.key, c.value);
        c.continue();
      };
      cur.onerror = () => resolve();
    });
  } catch {
    return memoryStore(mem);
  }
  return {
    load: (key) => mem.get(key) ?? null,
    save(key, value) {
      mem.set(key, value);
      try {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
      } catch { /* quota / closed: memory only */ }
    },
    clear(key) {
      mem.delete(key);
      try { db.transaction('kv', 'readwrite').objectStore('kv').delete(key); } catch { /* ignore */ }
    },
  };
}

export function memoryStore(mem = new Map()) {
  return {
    load: (key) => mem.get(key) ?? null,
    save: (key, value) => { mem.set(key, value); },
    clear: (key) => { mem.delete(key); },
  };
}
