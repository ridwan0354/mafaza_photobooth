/**
 * MAFAZA PHOTOBOOTH - UNIVERSAL PWA SERVICE WORKER
 * ---------------------------------------------------------------------------
 * Menjamin halaman https://mafaza.galipatsistem.com/kiosk dan /admin
 * dapat diakses 100% saat MODE PESAWAT (tanpa internet sama sekali),
 * dan tetap bisa dibuka kembali saat di-refresh (F5 / reload).
 */

const CACHE_NAME = 'mafaza-offline-v3.33';

const PRECACHE_ASSETS = [
  '/',
  '/kiosk',
  '/kiosk.html',
  '/admin',
  '/admin.html',
  '/admin-login.html',
  '/gallery.html',
  '/manifest.json',
  '/manifest-kiosk.json',
  '/js/kiosk.js',
  '/js/admin.js',
  '/js/notify.js',
  '/js/print-client.js',
  '/js/offline-store.js',
  '/css/styles.css',
  '/assets/icons/icon.svg',
  '/assets/icons/logo-mafaza.png',
  '/assets/logo-mafaza.jpg'
];

// Fallback JSON ketika offline agar API call tidak melempar uncaught network error
const API_FALLBACKS = {
  '/api/camera/status': {
    cameraSystemStatus: { detectedCameras: [], activeDevice: null },
    config: { cameraMode: 'virtual', cameraBrand: 'generic' }
  },
  '/api/printers/profile': {
    name: 'Printer Foto Perangkat',
    settings: { maxCopies: 4, mode: 'prompt' }
  },
  '/api/events/active/current': {
    activeEventId: 'event_wedding_dimas_sarah'
  },
  '/api/templates': []
};

// 1. Install Event: Pre-cache seluruh App Shell & Asset Utama
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('📦 [ServiceWorker] Pre-caching App Shell untuk Kiosk & Admin Offline...');
      // Pre-cache satu per satu agar jika salah satu asset 404, asset lain tetap tersimpan sempurna
      for (const url of PRECACHE_ASSETS) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn(`Gagal pre-cache ${url}:`, err.message);
        }
      }
    })
  );
});

// 2. Activate Event: Bersihkan cache versi lama & claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('🧹 [ServiceWorker] Membersihkan cache lama:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event: Intercept semua request saat online maupun offline
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Hanya proses method GET
  if (req.method !== 'GET') return;

  // A. NAVIGASI HALAMAN HTML (Kiosk, Admin, Gallery)
  // Ketika user me-refresh halaman di Mode Pesawat, Service Worker mengembalikan HTML dari cache
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      (async () => {
        try {
          // Coba jaringan dulu dengan batas waktu cepat (2.5 detik)
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Network timeout')), 2500));
          const netRes = await Promise.race([fetch(req), timeoutPromise]);
          if (netRes && netRes.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, netRes.clone());
            return netRes;
          }
        } catch (netErr) {
          // Offline / Mode Pesawat terdeteksi!
        }

        // Ambil dari Cache
        const cached = await caches.match(req);
        if (cached) return cached;

        // Fallback navigasi rute khusus
        if (url.pathname.startsWith('/admin')) {
          const adm = await caches.match('/admin') || await caches.match('/admin.html');
          if (adm) return adm;
        }

        if (url.pathname.startsWith('/kiosk')) {
          const ksk = await caches.match('/kiosk') || await caches.match('/kiosk.html');
          if (ksk) return ksk;
        }

        if (url.pathname.startsWith('/gallery')) {
          const gal = await caches.match('/gallery.html');
          if (gal) return gal;
        }

        return (await caches.match('/')) || new Response('Offline - Silakan buka halaman saat online terlebih dahulu.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      })()
    );
    return;
  }

  // B. ENDPOINT API GET
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        try {
          const netRes = await fetch(req);
          if (netRes && netRes.ok) {
            // Cache respon API sukses untuk cadangan saat offline
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, netRes.clone());
            return netRes;
          }
        } catch (netErr) {}

        // Jika offline, cari di cache terlebih dahulu
        const cached = await caches.match(req);
        if (cached) return cached;

        // Fallback graceful JSON jika belum pernah tercache
        for (const [route, fallbackData] of Object.entries(API_FALLBACKS)) {
          if (url.pathname.startsWith(route)) {
            return new Response(JSON.stringify(fallbackData), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        return new Response(JSON.stringify({ offline: true, error: 'Offline mode active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })()
    );
    return;
  }

  // C. ASSET STATIK (JS, CSS, Gambar, Ikon, Suara)
  // Stale-While-Revalidate: Berikan dari cache instan, perbarui cache di latar belakang jika online
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req)
        .then(async (netRes) => {
          if (netRes && netRes.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, netRes.clone());
          }
          return netRes;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })()
  );
});
