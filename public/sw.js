// Service worker ง่าย ๆ: เปิดเร็ว + ใช้งานออฟไลน์ได้บางส่วน
// - ไฟล์หน้าเว็บ (html/js/css/ไอคอน): network-first เก็บ cache ไว้ใช้ตอนออฟไลน์
// - /api/*: ปล่อยให้เรียก network ตรง ๆ เสมอ (ข้อมูลสต๊อกต้องสด)
const CACHE = 'stockmtt-v5';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;             // บันทึก/อ่านรูป (POST) ไม่แตะ
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API ใช้ network ตรง ๆ เสมอ

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      const cached = await caches.match(req);
      return cached || caches.match('/index.html');
    }
  })());
});
