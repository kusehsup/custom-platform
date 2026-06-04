// Минимальный SW: пропускает все запросы напрямую к сети, не кэширует
// API-ответы (они динамические), не блокирует обновления. Существует
// только чтобы браузер считал сайт PWA и предлагал "Установить".

const VERSION = 'v1';

self.addEventListener('install', (event) => {
    // Сразу активируем новый SW без ожидания закрытия вкладок
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Транзитный режим: всегда идём в сеть.
    // API/WS и SSE не должны кэшироваться вообще.
    const url = new URL(event.request.url);

    // Пропускаем нестандартные методы и кросс-доменные запросы как есть
    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

    // Для статики — network first, без обновления кэша
    event.respondWith(
        fetch(event.request).catch(() => {
            // Fallback на корень если нет сети — даёт оболочку SPA
            if (event.request.mode === 'navigate') {
                return caches.match('/');
            }
            return new Response('', { status: 503, statusText: 'Offline' });
        })
    );
});
