// WatchLater service worker: app-shell precache, background due-check
// (periodicsync), dormant push handler for the future relay.
importScripts('./db.js');

// Bump VERSION in the SAME commit as any change to a precached file —
// GitHub Pages serves max-age=600, so freshness is delivered by the SW
// update cycle (updateViaCache:'none' + cache:'reload'), not by fetch.
const VERSION = '2026-07-24.1';
const CACHE = 'wl-' + VERSION;
const PRECACHE = [
  './', './index.html', './app.css', './app.js', './db.js',
  './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
  './maskable-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache:'reload' bypasses the HTTP cache so a version bump always
      // precaches the bytes just deployed, not a 10-minute-stale copy.
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('wl-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the same-origin shell: with no hashed filenames, the SW
// version is the atomic deploy unit — mixed-version sessions are impossible.
// Cross-origin (noembed) is never intercepted or cached.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // ignoreSearch also serves share-target launches (./?url=…) offline.
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then((r) => r || fetch(req))
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req))
  );
});

function dueNotificationOptions(link) {
  return {
    body: link.title && link.title.trim() ? link.title : link.url,
    tag: 'wl-due-' + link.id,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: link.url },
  };
}

// Claim-then-notify: notifiedDueAt is stamped inside one IDB transaction
// (no non-IDB awaits — the transaction would auto-commit), then
// notifications are shown from the claimed list. IDB serializes readwrite
// transactions on the store, so a concurrently checking page cannot
// double-claim the same (link, dueAt).
async function checkDueFromSW() {
  const existing = await self.wlDB.get();
  if (!existing) return; // the SW never seeds state
  const now = Date.now();
  const notifyAllowed = 'Notification' in self && Notification.permission === 'granted';
  let claimed = [];
  const state = await self.wlDB.update((s) => {
    claimed = [];
    if (!s) return undefined; // no write
    if (notifyAllowed) {
      for (const l of s.links) {
        if (l.doneAt == null && l.dueAt <= now && l.notifiedDueAt !== l.dueAt) {
          l.notifiedDueAt = l.dueAt;
          claimed.push({ id: l.id, url: l.url, title: l.title });
        }
      }
    }
    return s;
  });

  const openDue = state ? state.links.filter((l) => l.doneAt == null && l.dueAt <= now).length : 0;
  if ('setAppBadge' in self.navigator) {
    (openDue ? self.navigator.setAppBadge(openDue) : self.navigator.clearAppBadge()).catch(() => {});
  }

  if (!claimed.length) return;
  if (claimed.length > 3) {
    await self.registration.showNotification('WatchLater', {
      body: claimed.length + ' links are due',
      tag: 'wl-due-summary',
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: './' },
    });
  } else {
    for (const c of claimed) {
      await self.registration.showNotification('WatchLater reminder', dueNotificationOptions(c));
    }
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'wl-check-due') event.waitUntil(checkDueFromSW());
});

// Dormant until the Cloudflare Worker push relay exists. Payload contract:
// {title, body, url} — keep in sync with the relay when it lands.
self.addEventListener('push', (event) => {
  let data = { title: 'WatchLater', body: 'A link is due.', url: './' };
  if (event.data) {
    try { data = Object.assign(data, event.data.json()); }
    catch (_) { data.body = event.data.text(); }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url },
      icon: './icon-192.png',
      badge: './icon-192.png',
    })
  );
});

// Link notifications open the saved link in a new tab; only app-level
// notifications (data.url === './') focus an existing window. Navigating
// an existing client to a cross-origin URL would replace the app window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    if (target === './') {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version' && event.source) {
    event.source.postMessage({ type: 'version', version: VERSION });
  }
});
