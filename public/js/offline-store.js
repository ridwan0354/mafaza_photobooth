/**
 * MAFAZA PHOTOBOOTH - OFFLINE STORAGE & SYNC ENGINE
 * ---------------------------------------------------------------------------
 * Menyimpan sesi foto, template, dan pengaturan ke IndexedDB saat offline.
 * Menjamin Kiosk dan Admin dapat berjalan 100% tanpa internet (mode pesawat),
 * foto tetap bisa dicetak langsung ke printer lokal, dan otomatis diunggah
 * ke server cloud saat internet kembali terhubung.
 */

(function () {
  const DB_NAME = 'MafazaOfflineDB';
  const DB_VERSION = 2;
  const STORE_SESSIONS = 'offline_sessions';
  const STORE_CACHE = 'offline_cache';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          const sStore = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
          sStore.createIndex('synced', 'synced', { unique: false });
          sStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_CACHE)) {
          db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.target.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // Helper konversi Blob ke DataURL (agar kompatibel 100% di semua versi browser)
  function blobToDataUrl(blob) {
    if (!blob) return Promise.resolve(null);
    if (typeof blob === 'string') return Promise.resolve(blob);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Helper konversi DataURL ke Blob
  function dataUrlToBlob(dataUrl) {
    if (!dataUrl) return null;
    if (dataUrl instanceof Blob) return dataUrl;
    try {
      const arr = dataUrl.split(',');
      const mimeMatch = arr[0].match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new Blob([u8arr], { type: mime });
    } catch (e) {
      console.warn('Failed to parse dataUrl to blob:', e);
      return null;
    }
  }

  const pbOfflineStore = {
    // 1. Simpan sesi foto offline ke IndexedDB
    async saveSession(sessionData) {
      const db = await openDB();
      const sessionId = sessionData.id || ('sess_off_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));

      // Konversi blob ke format aman dataUrl untuk penyimpanan lokal
      const finalImageDataUrl = await blobToDataUrl(sessionData.finalImageBlob || sessionData.finalImage);
      
      const capturesDataUrls = [];
      if (sessionData.captures && sessionData.captures.length > 0) {
        for (const c of sessionData.captures) {
          const dUrl = await blobToDataUrl(c.blob || c.dataUrl || c);
          capturesDataUrls.push({
            poseIndex: c.poseIndex || (capturesDataUrls.length + 1),
            dataUrl: dUrl
          });
        }
      }

      const liveClipsDataUrls = [];
      if (sessionData.liveClips && sessionData.liveClips.length > 0) {
        for (let i = 0; i < sessionData.liveClips.length; i++) {
          const clip = sessionData.liveClips[i];
          if (clip) {
            const dUrl = await blobToDataUrl(clip);
            liveClipsDataUrls.push({
              index: i + 1,
              dataUrl: dUrl,
              ext: (clip.type && clip.type.includes('mp4')) ? 'mp4' : 'webm'
            });
          }
        }
      }

      let boomerangDataUrl = null;
      let boomerangExt = 'mp4';
      if (sessionData.boomerangBlob) {
        boomerangDataUrl = await blobToDataUrl(sessionData.boomerangBlob);
        boomerangExt = sessionData.boomerangExt || 'mp4';
      }

      const record = {
        id: sessionId,
        tenantId: sessionData.tenantId || 'tenant_studiokeren_01',
        eventId: sessionData.eventId || 'event_wedding_dimas_sarah',
        deviceId: sessionData.deviceId || 'dev_kiosk_win_01',
        guestPassId: sessionData.guestPassId || null,
        templateId: sessionData.templateId || null,
        mode: sessionData.mode || 'single',
        startedAt: sessionData.startedAt || new Date().toISOString(),
        endedAt: sessionData.endedAt || new Date().toISOString(),
        finalImage: finalImageDataUrl,
        captures: capturesDataUrls,
        liveClips: liveClipsDataUrls,
        boomerang: boomerangDataUrl ? { dataUrl: boomerangDataUrl, ext: boomerangExt } : null,
        printRequested: Boolean(sessionData.printRequested),
        printCopies: parseInt(sessionData.printCopies, 10) || 1,
        synced: false,
        syncAttempts: 0,
        createdAt: Date.now()
      };

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.put(record);
        req.onsuccess = () => {
          this.notifyChange();
          resolve(record);
        };
        req.onerror = () => reject(req.error);
      });
    },

    // 2. Ambil daftar sesi yang belum terunggah
    async getPendingSessions() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SESSIONS, 'readonly');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          const pending = all.filter(s => !s.synced);
          resolve(pending);
        };
        req.onerror = () => reject(req.error);
      });
    },

    // 3. Hitung jumlah sesi offline yang antre
    async getPendingCount() {
      const pending = await this.getPendingSessions();
      return pending.length;
    },

    // 4. Hapus sesi setelah sukses sinkronisasi
    async deleteSession(sessionId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.delete(sessionId);
        req.onsuccess = () => {
          this.notifyChange();
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    },

    // 5. Tandai sesi sebagai tersinkron
    async markSessionSynced(sessionId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const getReq = store.get(sessionId);
        getReq.onsuccess = () => {
          const rec = getReq.result;
          if (rec) {
            rec.synced = true;
            rec.syncedAt = new Date().toISOString();
            store.put(rec);
          }
          this.notifyChange();
          resolve();
        };
        getReq.onerror = () => reject(getReq.error);
      });
    },

    // 6. Unggah satu sesi ke server
    async uploadSession(session) {
      const formData = new FormData();
      formData.append('tenantId', session.tenantId || 'tenant_studiokeren_01');
      formData.append('eventId', session.eventId || 'event_wedding_dimas_sarah');
      formData.append('deviceId', session.deviceId || 'dev_kiosk_win_01');
      formData.append('localSessionId', session.id);
      formData.append('mode', session.mode || 'single');
      formData.append('startedAt', session.startedAt || new Date().toISOString());
      formData.append('printRequested', session.printRequested ? 'true' : 'false');
      formData.append('printCopies', String(session.printCopies || 1));
      if (session.guestPassId) formData.append('guestPassId', session.guestPassId);
      if (session.templateId) formData.append('templateId', session.templateId);

      // Final Image
      const finalBlob = dataUrlToBlob(session.finalImage);
      if (finalBlob) {
        formData.append('finalImage', finalBlob, `final_off_${session.id}.jpg`);
      }

      // Raw captures
      if (session.captures && session.captures.length > 0) {
        session.captures.forEach(c => {
          const cBlob = dataUrlToBlob(c.dataUrl);
          if (cBlob) {
            formData.append('captures', cBlob, `pose_${c.poseIndex}_${Date.now()}.jpg`);
          }
        });
      }

      // Live clips
      if (session.liveClips && session.liveClips.length > 0) {
        session.liveClips.forEach(clip => {
          const clipBlob = dataUrlToBlob(clip.dataUrl);
          if (clipBlob) {
            formData.append('liveClips', clipBlob, `live_pose_${clip.index}_${Date.now()}.${clip.ext || 'mp4'}`);
          }
        });
        // Sediakan livePhoto thumbnail
        const firstClipBlob = dataUrlToBlob(session.liveClips[0].dataUrl);
        if (firstClipBlob) {
          formData.append('livePhoto', firstClipBlob, `livephoto_${Date.now()}.${session.liveClips[0].ext || 'mp4'}`);
        }
      }

      // Boomerang
      if (session.boomerang && session.boomerang.dataUrl) {
        const bmBlob = dataUrlToBlob(session.boomerang.dataUrl);
        if (bmBlob) {
          formData.append('boomerang', bmBlob, `boomerang_${Date.now()}.${session.boomerang.ext || 'mp4'}`);
        }
      }

      const res = await fetch(`/api/kiosk/sessions/${encodeURIComponent(session.id)}/complete`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      return data;
    },

    // 7. Sinkronkan semua sesi yang pending secara berurutan
    isSyncing: false,
    async syncAllPending(onProgress) {
      if (this.isSyncing) return;
      if (!navigator.onLine) {
        console.log('📶 Masih offline, sinkronisasi ditunda...');
        return;
      }

      const pending = await this.getPendingSessions();
      if (pending.length === 0) return;

      this.isSyncing = true;
      console.log(`🚀 Memulai sinkronisasi ${pending.length} sesi foto offline...`);
      let successCount = 0;

      try {
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          if (onProgress) onProgress({ current: i + 1, total: pending.length, session: item });

          try {
            await this.uploadSession(item);
            await this.deleteSession(item.id);
            successCount++;
          } catch (err) {
            console.warn(`Gagal mengunggah sesi ${item.id}:`, err);
            // Tambahkan hitungan percobaan
            const db = await openDB();
            const tx = db.transaction(STORE_SESSIONS, 'readwrite');
            item.syncAttempts = (item.syncAttempts || 0) + 1;
            item.lastSyncError = String(err.message || err);
            tx.objectStore(STORE_SESSIONS).put(item);
          }
        }

        if (successCount > 0) {
          if (window.pbToast) {
            window.pbToast(`✅ Berhasil mengunggah ${successCount} sesi foto offline ke server cloud!`, 'success', 4500);
          }
        }
      } finally {
        this.isSyncing = false;
        this.notifyChange();
      }
    },

    // 8. Cache & Ambil Pengaturan / Template Lokal
    async cacheConfig(key, value) {
      try {
        const db = await openDB();
        return new Promise((resolve) => {
          const tx = db.transaction(STORE_CACHE, 'readwrite');
          tx.objectStore(STORE_CACHE).put({ key, value, updatedAt: Date.now() });
          tx.oncomplete = resolve;
        });
      } catch (e) {
        try { localStorage.setItem('pb_cache_' + key, JSON.stringify(value)); } catch(err){}
      }
    },

    async getCachedConfig(key) {
      try {
        const db = await openDB();
        return new Promise((resolve) => {
          const tx = db.transaction(STORE_CACHE, 'readonly');
          const req = tx.objectStore(STORE_CACHE).get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => resolve(null);
        });
      } catch (e) {
        try {
          const item = localStorage.getItem('pb_cache_' + key);
          return item ? JSON.parse(item) : null;
        } catch(err) {
          return null;
        }
      }
    },

    // Listener otomatis saat online
    listeners: [],
    subscribe(cb) {
      this.listeners.push(cb);
    },
    notifyChange() {
      this.getPendingCount().then(count => {
        this.listeners.forEach(cb => {
          try { cb(count); } catch(e){}
        });
      });
    },

    initAutoSync() {
      // Event saat koneksi pulih
      window.addEventListener('online', () => {
        console.log('🌐 Koneksi internet terdeteksi pulih. Memulai sinkronisasi otomatis...');
        if (window.pbToast) window.pbToast('🌐 Internet terhubung! Memeriksa foto offline...', 'info', 3000);
        setTimeout(() => this.syncAllPending(), 1200);
      });

      // Heartbeat berkala setiap 15 detik jika online
      setInterval(() => {
        if (navigator.onLine && !this.isSyncing) {
          this.syncAllPending();
        }
      }, 15000);

      // Cek saat awal load
      setTimeout(() => {
        if (navigator.onLine) {
          this.syncAllPending();
        }
      }, 2500);

      this.notifyChange();
    }
  };

  window.pbOfflineStore = pbOfflineStore;
  pbOfflineStore.initAutoSync();
})();
