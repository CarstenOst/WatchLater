// WatchLater storage — one JSON document in IndexedDB under key "root".
// Classic script on purpose: the page loads it via <script>, the service
// worker via importScripts(). No DOM access, no ES module syntax.
//
// wlDB.update(mutator) is the only mutation primitive: get → mutator →
// put inside a single readwrite transaction, so concurrent writers (page
// tab vs service worker) can never lose updates. Mutators MUST be
// synchronous — an IndexedDB transaction auto-commits as soon as the
// microtask queue drains with no pending request, so an `await` inside a
// mutator would commit the read before the write. A mutator that returns
// undefined writes nothing (used by the SW, which never seeds state).
(() => {
  'use strict';

  const DB_NAME = 'watchlater';
  const STORE = 'state';
  const KEY = 'root';

  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function get() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Whole-document replace; used only by import and never by normal flows.
  async function set(state) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve(state);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  async function update(mutator) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(KEY);
      let next;
      req.onsuccess = () => {
        try {
          next = mutator(req.result);
          if (next !== undefined) store.put(next, KEY);
        } catch (err) {
          reject(err);
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  self.wlDB = { get, set, update };
})();
