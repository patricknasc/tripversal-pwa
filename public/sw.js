self.addEventListener('push', function (event) {
    if (event.data) {
        let data;
        try {
            data = event.data.json();
        } catch (e) {
            data = { title: "Notificação", body: event.data.text() };
        }

        // Alerta de Emergência
        const isEmergency = data.title && data.title.includes("SOS");

        const options = {
            body: data.body,
            icon: '/icon512_maskable.png',
            badge: '/icon512_maskable.png',
            vibrate: isEmergency ? [500, 250, 500, 250, 500, 250, 500, 250, 500] : [200, 100, 200],
            requireInteraction: isEmergency, // Só sai se o usuário fechar
            data: {
                url: data.url || '/'
            }
        };

        event.waitUntil(self.registration.showNotification(data.title, options));
    }
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const targetUrl = event.notification.data.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url === targetUrl && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
