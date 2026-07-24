self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'WatchLater', body: 'A link is due.', url: '/' };
  if (event.data) {
    try { data = Object.assign(data, event.data.json()); }
    catch (_) { data.body = event.data.text(); }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url },
      icon: '/static/icon.svg',
      badge: '/static/icon.svg',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const client of list) {
      if ('focus' in client) return client.navigate(target).then(() => client.focus());
    }
    if (clients.openWindow) return clients.openWindow(target);
  }));
});
