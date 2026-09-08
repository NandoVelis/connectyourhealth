// Service worker voor pushmeldingen op de /overig-pagina (ESPN Fantasy
// prijswaarschuwingen). Eigen bestandsnaam/scope, los van andere delen
// van de site.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'ESPN Fantasy', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ESPN Fantasy prijswaarschuwing';
  const options = {
    body: data.body || '',
    icon: '/icon-overig-192.png',
    badge: '/icon-overig-192.png',
    data: { url: data.url || '/overig' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/overig';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const c of clientList) {
        if (c.url.includes('/overig') && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
