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
      try {
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
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbPromise = null;
          reject(req.error);
        };
      } catch (err) {
        dbPromise = null;
        reject(err);
      }
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
        guestPassToken: sessionData.guestPassToken || null,
        guestPassGalleryUrl: sessionData.guestPassGalleryUrl || null,
        guestPassQrDataUrl: sessionData.guestPassQrDataUrl || null,
        templateId: sessionData.templateId || null,
        templateName: sessionData.templateName || null,
        mode: sessionData.mode || 'single',
        startedAt: sessionData.startedAt || new Date().toISOString(),
        endedAt: sessionData.endedAt || new Date().toISOString(),
        finalImage: finalImageDataUrl,
        captures: capturesDataUrls,
        liveClips: liveClipsDataUrls,
        boomerang: boomerangDataUrl ? { dataUrl: boomerangDataUrl, ext: boomerangExt } : null,
        printRequested: Boolean(sessionData.printRequested),
        printCopies: parseInt(sessionData.printCopies, 10) || 1,
        printPaperSize: sessionData.printPaperSize || null,
        paperConfirmed: Boolean(sessionData.paperConfirmed),
        requestedPrintPaper: sessionData.requestedPrintPaper || null,
        requestedPrintCopies: Math.max(0, Math.min(20, parseInt(sessionData.requestedPrintCopies, 10) || 0)),
        synced: false,
        syncAttempts: 0,
        createdAt: Date.now()
      };

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const existingReq = store.get(sessionId);
        existingReq.onsuccess = () => {
          const existing = existingReq.result;
          if (existing) {
            if (!record.finalImage && existing.finalImage) record.finalImage = existing.finalImage;
            if ((!record.captures || record.captures.length === 0) && Array.isArray(existing.captures) && existing.captures.length > 0) {
              record.captures = existing.captures;
            }
            if ((!record.liveClips || record.liveClips.length === 0) && Array.isArray(existing.liveClips) && existing.liveClips.length > 0) {
              record.liveClips = existing.liveClips;
            }
            if (!record.boomerang && existing.boomerang) record.boomerang = existing.boomerang;
            if (!record.guestPassId && existing.guestPassId) record.guestPassId = existing.guestPassId;
            if (!record.guestPassToken && existing.guestPassToken) record.guestPassToken = existing.guestPassToken;
            if (!record.guestPassGalleryUrl && existing.guestPassGalleryUrl) record.guestPassGalleryUrl = existing.guestPassGalleryUrl;
            if (!record.guestPassQrDataUrl && existing.guestPassQrDataUrl) record.guestPassQrDataUrl = existing.guestPassQrDataUrl;
            if (!record.templateId && existing.templateId) record.templateId = existing.templateId;
            if (!record.templateName && existing.templateName) record.templateName = existing.templateName;

            const shouldPreservePrint = sessionData.preservePrintFlags
              || (existing.printRequested && !sessionData.printRequested && !sessionData.forceClearPrint);
            if (shouldPreservePrint && existing.printRequested) {
              record.printRequested = true;
              record.printCopies = existing.printCopies || record.printCopies;
              record.printPaperSize = existing.printPaperSize || record.printPaperSize;
              record.paperConfirmed = Boolean(existing.paperConfirmed);
            }
            const shouldPreserveOrder = !sessionData.updatePrintOrder
              && (sessionData.preservePrintFlags || ((existing.requestedPrintCopies || 0) > 0 && !(record.requestedPrintCopies > 0)));
            if (shouldPreserveOrder && (existing.requestedPrintCopies || 0) > 0) {
              record.requestedPrintPaper = existing.requestedPrintPaper || record.requestedPrintPaper;
              record.requestedPrintCopies = existing.requestedPrintCopies;
            }
          }
          const putReq = store.put(record);
          putReq.onsuccess = () => {
            this.notifyChange();
            resolve(record);
          };
          putReq.onerror = () => reject(putReq.error);
        };
        existingReq.onerror = () => {
          const putReq = store.put(record);
          putReq.onsuccess = () => {
            this.notifyChange();
            resolve(record);
          };
          putReq.onerror = () => reject(putReq.error);
        };
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

    isLocalDirectMode() {
      try {
        const ls = localStorage.getItem('pb_kiosk_local_mode');
        if (ls === 'true') return true;
        if (ls === 'false') return false;
      } catch (e) {}
      return Boolean(typeof window !== 'undefined' && window.__pbEventLocalMode);
    },

    async disableLocalModeAndSync() {
      try { localStorage.setItem('pb_kiosk_local_mode', 'false'); } catch (e) {}
      if (typeof window !== 'undefined') window.__pbEventLocalMode = false;
      try {
        if (typeof BroadcastChannel === 'function') {
          const ch = new BroadcastChannel('pb_kiosk_mode');
          ch.postMessage({ localPrintMode: false });
          ch.close();
        }
      } catch (e) {}
      this.notifyChange();
      if (navigator.onLine) {
        await this.syncAllPending(null, { manual: true });
      }
      if (this._galleryOpen) {
        await this.renderLocalGalleryModal();
      }
    },

    // 6. Unggah satu sesi ke server (mendukung batching 2 pose per request agar aman di WiFi lambat / limit proxy)
    async uploadSession(session) {
      const caps = Array.isArray(session.captures) ? session.captures : [];
      const totalCaps = caps.length;
      const batchSize = 2;
      const finalBlob = dataUrlToBlob(session.finalImage);
      const url = `/api/kiosk/sessions/${encodeURIComponent(session.id)}/complete`;

      const postFormWithTimeout = async (formData, timeoutMs = 35000) => {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        try {
          const res = await fetch(url, ctrl ? { method: 'POST', body: formData, signal: ctrl.signal } : { method: 'POST', body: formData });
          if (!res.ok) {
            const errJson = await res.json().catch(() => null);
            throw new Error((errJson && errJson.error) || `Server returned HTTP ${res.status}`);
          }
          return await res.json();
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const appendCommonFields = (fd, isLastBatch) => {
        fd.append('tenantId', session.tenantId || 'tenant_studiokeren_01');
        fd.append('eventId', session.eventId || 'event_wedding_dimas_sarah');
        fd.append('deviceId', session.deviceId || 'dev_kiosk_win_01');
        fd.append('localSessionId', session.id);
        fd.append('mode', session.mode || 'single');
        fd.append('startedAt', session.startedAt || new Date().toISOString());
        const doPrint = isLastBatch && Boolean(session.printRequested);
        fd.append('printRequested', doPrint ? 'true' : 'false');
        fd.append('printCopies', String(session.printCopies || 1));
        if (session.printPaperSize) fd.append('printPaperSize', session.printPaperSize);
        if (session.paperConfirmed) fd.append('paperConfirmed', 'true');
        if ((parseInt(session.requestedPrintCopies, 10) || 0) > 0 || session.requestedPrintPaper) {
          fd.append('requestedPrintCopies', String(parseInt(session.requestedPrintCopies, 10) || 0));
          if (session.requestedPrintPaper) fd.append('requestedPrintPaper', session.requestedPrintPaper);
        }
        if (session.guestPassId) fd.append('guestPassId', session.guestPassId);
        if (session.templateId) fd.append('templateId', session.templateId);
      };

      const appendMotionAssets = (fd) => {
        if (session.liveClips && session.liveClips.length > 0) {
          session.liveClips.forEach(clip => {
            const clipBlob = dataUrlToBlob(clip.dataUrl);
            if (clipBlob) {
              fd.append('liveClips', clipBlob, `live_pose_${clip.index}_${Date.now()}.${clip.ext || 'mp4'}`);
            }
          });
          const firstClipBlob = dataUrlToBlob(session.liveClips[0].dataUrl);
          if (firstClipBlob) {
            fd.append('livePhoto', firstClipBlob, `livephoto_${Date.now()}.${session.liveClips[0].ext || 'mp4'}`);
          }
        }
        if (session.boomerang && session.boomerang.dataUrl) {
          const bmBlob = dataUrlToBlob(session.boomerang.dataUrl);
          if (bmBlob) {
            fd.append('boomerang', bmBlob, `boomerang_${Date.now()}.${session.boomerang.ext || 'mp4'}`);
          }
        }
      };

      if (totalCaps === 0) {
        const fd = new FormData();
        appendCommonFields(fd, true);
        if (finalBlob) fd.append('finalImage', finalBlob, `final_off_${session.id}.jpg`);
        appendMotionAssets(fd);
        return await postFormWithTimeout(fd);
      }

      let lastData = null;
      for (let offset = 0; offset < totalCaps; offset += batchSize) {
        const end = Math.min(totalCaps, offset + batchSize);
        const isLastBatch = (end >= totalCaps);
        const fd = new FormData();
        appendCommonFields(fd, isLastBatch);
        fd.append('captureStartIndex', String(offset));
        if (offset === 0 && finalBlob) {
          fd.append('finalImage', finalBlob, `final_off_${session.id}.jpg`);
        }
        for (let i = offset; i < end; i++) {
          const c = caps[i];
          const cBlob = c ? dataUrlToBlob(c.dataUrl) : null;
          if (cBlob) {
            fd.append('captures', cBlob, `pose_${c.poseIndex || (i + 1)}_${Date.now()}.jpg`);
          }
        }
        if (isLastBatch) {
          appendMotionAssets(fd);
        }
        lastData = await postFormWithTimeout(fd);
      }
      return lastData;
    },

    // 7. Sinkronkan semua sesi yang pending secara berurutan
    isSyncing: false,
    async syncAllPending(onProgress, opts = {}) {
      if (this.isSyncing) return;
      if (!opts?.manual && this.isLocalDirectMode()) {
        return;
      }
      if (!navigator.onLine) {
        console.log('📶 Masih offline, sinkronisasi ditunda...');
        return;
      }

      const pending = await this.getPendingSessions();
      if (pending.length === 0) return;

      this.isSyncing = true;
      console.log(`🚀 Memulai sinkronisasi ${pending.length} sesi foto offline...`);
      let successCount = 0;
      let lastErrorMsg = '';

      try {
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          if (onProgress) onProgress({ current: i + 1, total: pending.length, session: item });

          try {
            const uploadRes = await this.uploadSession(item);
            this.recordSyncedSummary(item, uploadRes);
            await this.deleteSession(item.id);
            successCount++;
          } catch (err) {
            lastErrorMsg = String((err && err.message) || err || 'Gagal terhubung ke server');
            console.warn(`Gagal mengunggah sesi ${item.id}:`, err);
            // Tambahkan hitungan percobaan & simpan pesan error agar terlihat di Galeri Lokal
            const db = await openDB();
            await new Promise((res) => {
              const tx = db.transaction(STORE_SESSIONS, 'readwrite');
              item.syncAttempts = (item.syncAttempts || 0) + 1;
              item.lastSyncError = lastErrorMsg;
              tx.objectStore(STORE_SESSIONS).put(item);
              tx.oncomplete = res;
              tx.onerror = res;
            });
          }
        }

        if (successCount > 0 && window.pbToast) {
          window.pbToast(`✅ Berhasil mengunggah ${successCount} sesi foto ke server!`, 'success', 4500);
        } else if (opts?.manual && lastErrorMsg && window.pbToast) {
          window.pbToast(`⚠️ Gagal kirim: ${lastErrorMsg}`, 'error', 4500);
        }
      } finally {
        this.isSyncing = false;
        this.notifyChange();
      }
    },

    // 7b. Sinkronkan satu sesi offline secara aman menggunakan lock isSyncing yang sama
    async syncSingleSessionById(sessionId) {
      if (this.isSyncing) {
        if (window.pbToast) window.pbToast('⏳ Sinkronisasi antrean lain sedang berjalan...', 'info', 2500);
        return { busy: true };
      }
      if (!navigator.onLine) {
        throw new Error('Perangkat masih offline');
      }
      this.isSyncing = true;
      try {
        const pending = await this.getPendingSessions();
        const cur = pending.find(x => x.id === sessionId);
        if (!cur) return { missing: true };
        const uploadRes = await this.uploadSession(cur);
        this.recordSyncedSummary(cur, uploadRes);
        await this.deleteSession(cur.id);
        return { success: true, uploadRes };
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

    // Helper aman & ringan untuk Galeri Offline di Mingle / Kiosk
    recordSyncedSummary(session, uploadRes) {
      try {
        const key = 'pb_offline_synced_history_v1';
        const raw = localStorage.getItem(key);
        const list = raw ? JSON.parse(raw) : [];
        const entry = {
          id: session.id,
          syncedAt: Date.now(),
          createdAt: session.createdAt || Date.now(),
          mode: session.mode || 'single',
          templateName: session.templateName || (session.mode === 'files_only' ? 'File HD Tanpa Bingkai' : 'Foto Booth'),
          capturesCount: Array.isArray(session.captures) ? session.captures.length : 0,
          hasFinal: Boolean(session.finalImage),
          printRequested: Boolean(session.printRequested),
          printCopies: parseInt(session.printCopies, 10) || 1,
          printPaperSize: session.printPaperSize || '4x6',
          requestedPrintCopies: parseInt(session.requestedPrintCopies, 10) || 0,
          requestedPrintPaper: session.requestedPrintPaper || null,
          galleryUrl: (uploadRes && uploadRes.guestPass && uploadRes.guestPass.galleryUrl) || session.guestPassGalleryUrl || null
        };
        const deduped = [entry].concat((Array.isArray(list) ? list : []).filter(x => x && x.id !== entry.id)).slice(0, 12);
        localStorage.setItem(key, JSON.stringify(deduped));
      } catch (e) {}
    },

    getRecentSyncedHistory() {
      try {
        const list = JSON.parse(localStorage.getItem('pb_offline_synced_history_v1') || '[]');
        return Array.isArray(list) ? list : [];
      } catch (e) {
        return [];
      }
    },

    async updateOfflineSessionPrint(sessionId, { printRequested = true, printCopies = 1, printPaperSize = '4x6', paperConfirmed = false } = {}) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.get(sessionId);
        req.onsuccess = () => {
          const rec = req.result;
          if (!rec) { resolve(null); return; }
          rec.printRequested = Boolean(printRequested);
          rec.printCopies = Math.max(1, Math.min(10, parseInt(printCopies, 10) || 1));
          rec.printPaperSize = printPaperSize || rec.printPaperSize || '4x6';
          rec.paperConfirmed = Boolean(paperConfirmed);
          store.put(rec);
          tx.oncomplete = () => {
            this.notifyChange();
            resolve(rec);
          };
        };
        req.onerror = () => reject(req.error);
      });
    },

    async updateOfflineSessionPrintOrder(sessionId, { requestedPrintPaper = null, requestedPrintCopies = 0 } = {}) {
      if (!sessionId) return null;
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.get(sessionId);
        req.onsuccess = () => {
          const rec = req.result;
          if (!rec) { resolve(null); return; }
          const copiesNum = Math.max(0, Math.min(20, parseInt(requestedPrintCopies, 10) || 0));
          rec.requestedPrintCopies = copiesNum;
          rec.requestedPrintPaper = copiesNum > 0 ? (requestedPrintPaper || rec.requestedPrintPaper || '4x6') : null;
          store.put(rec);
          tx.oncomplete = () => {
            this.notifyChange();
            resolve(rec);
          };
        };
        req.onerror = () => reject(req.error);
      });
    },

    _escapeHtml(str) {
      return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    _ensureGalleryModalDom() {
      if (document.getElementById('pbLocalOfflineGalleryModal')) return;
      const modal = document.createElement('div');
      modal.id = 'pbLocalOfflineGalleryModal';
      modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:10050;background:rgba(20,12,8,0.82);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px;';
      modal.innerHTML = `
        <div style="background:#FFFDF9;border:2px solid #EAD8C7;border-radius:24px;width:min(96vw,880px);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.45);font-family:inherit;color:#381E11;" onclick="event.stopPropagation()">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 20px;border-bottom:1.5px solid #EAD8C7;background:#FFF7EB;flex-wrap:wrap;">
            <div>
              <h3 style="margin:0;font-size:18px;font-weight:800;color:#7B482E;">📂 Galeri Foto Lokal &amp; Antrean Offline</h3>
              <div id="pbOfflineGalleryNetStatus" style="font-size:12px;font-weight:700;margin-top:3px;color:#6E584B;">Memeriksa...</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <button type="button" id="pbOfflineDisableLocalBtn" class="btn btn-coral" style="display:none;padding:8px 14px;font-size:12.5px;font-weight:800;border-radius:999px;cursor:pointer;">🌐 Aktifkan Kirim Otomatis</button>
              <button type="button" id="pbOfflineGallerySyncBtn" class="btn btn-teal" style="padding:8px 14px;font-size:12.5px;font-weight:800;border-radius:999px;cursor:pointer;">🔄 Kirim Semua ke Server</button>
              <button type="button" id="pbOfflineGalleryCloseBtn" style="width:36px;height:36px;border-radius:50%;border:none;background:rgba(123,72,46,0.14);color:#7B482E;font-size:16px;font-weight:800;cursor:pointer;">✕</button>
            </div>
          </div>
          <div id="pbOfflineGalleryBody" style="padding:16px 20px;overflow-y:auto;flex:1;"></div>
        </div>
        <div id="pbOfflineDetailOverlay" style="display:none;position:fixed;inset:0;z-index:10060;background:rgba(15,9,6,0.9);align-items:center;justify-content:center;padding:16px;" onclick="event.stopPropagation();document.getElementById('pbOfflineDetailOverlay').style.display='none';">
          <div id="pbOfflineDetailCard" style="background:#FFFDF9;border-radius:20px;width:min(95vw,760px);max-height:90dvh;overflow-y:auto;padding:18px 20px;box-shadow:0 24px 60px rgba(0,0,0,0.5);" onclick="event.stopPropagation()"></div>
        </div>
      `;
      modal.addEventListener('click', () => this.closeLocalGallery());
      document.body.appendChild(modal);
      document.getElementById('pbOfflineGalleryCloseBtn').onclick = () => this.closeLocalGallery();
      document.getElementById('pbOfflineDisableLocalBtn').onclick = async () => {
        await this.disableLocalModeAndSync();
      };
      document.getElementById('pbOfflineGallerySyncBtn').onclick = async () => {
        if (!navigator.onLine) {
          if (window.pbToast) window.pbToast('⚠️ WiFi/Internet belum tersambung. Nyalakan WiFi dulu di tenda.', 'warn', 3500);
          return;
        }
        await this.syncAllPending(null, { manual: true });
        await this.renderLocalGalleryModal();
      };
    },

    async openLocalGallery() {
      this._ensureGalleryModalDom();
      const modal = document.getElementById('pbLocalOfflineGalleryModal');
      if (modal) modal.style.display = 'flex';
      this._galleryOpen = true;
      await this.renderLocalGalleryModal();
    },

    closeLocalGallery() {
      this._galleryOpen = false;
      const detail = document.getElementById('pbOfflineDetailOverlay');
      if (detail) detail.style.display = 'none';
      const modal = document.getElementById('pbLocalOfflineGalleryModal');
      if (modal) modal.style.display = 'none';
    },

    async _showSessionDetail(sessionId) {
      const pending = await this.getPendingSessions();
      const s = pending.find(item => item.id === sessionId);
      const overlay = document.getElementById('pbOfflineDetailOverlay');
      const card = document.getElementById('pbOfflineDetailCard');
      if (!s || !overlay || !card) return;

      const timeStr = new Date(s.createdAt || Date.now()).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
      const caps = Array.isArray(s.captures) ? s.captures : [];
      const paperLbl = s.printPaperSize === '5x7' ? '5R' : (s.printPaperSize === '2x6' ? 'Strip' : '4R');
      const reqCopies = parseInt(s.requestedPrintCopies, 10) || 0;
      const reqPaperLbl = s.requestedPrintPaper === '5x7' ? '5R' : (s.requestedPrintPaper === '2x6' ? 'Strip' : '4R');

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;">
          <div>
            <strong style="font-size:17px;color:#7B482E;">📸 Cek Foto Tersimpan Lokal</strong>
            <div style="font-size:12px;color:#6E584B;">${this._escapeHtml(s.templateName || (s.mode === 'files_only' ? 'Mode File HD' : 'Sesi Foto'))} · ${timeStr} · ${caps.length} pose</div>
          </div>
          <button type="button" id="pbOfflineDetailCloseBtn" style="padding:6px 12px;border-radius:999px;border:1.5px solid #EAD8C7;background:#fff;font-weight:800;cursor:pointer;">✕ Tutup</button>
        </div>
        ${s.finalImage ? `
          <div style="background:#1B1614;border-radius:14px;padding:10px;text-align:center;margin-bottom:12px;">
            <img src="${s.finalImage}" style="max-width:100%;max-height:46dvh;border-radius:8px;object-fit:contain;" alt="Hasil Bingkai">
          </div>
        ` : ''}
        ${caps.length > 0 ? `
          <div style="margin-bottom:12px;">
            <div style="font-size:12px;font-weight:800;color:#7B482E;margin-bottom:6px;">🎞️ Pose Asli Tersimpan (${caps.length} foto):</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;">
              ${caps.map((c, idx) => `
                <div style="background:#1B1614;border-radius:10px;overflow:hidden;position:relative;aspect-ratio:4/3;">
                  <img src="${c.dataUrl}" style="width:100%;height:100%;object-fit:cover;display:block;" alt="Pose ${idx + 1}">
                  <span style="position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.72);color:#fff;font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;">Pose #${c.poseIndex || idx + 1}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        ${s.guestPassQrDataUrl ? `
          <div style="display:flex;align-items:center;gap:14px;background:#FFF7EB;border:1.5px solid #EAD8C7;border-radius:14px;padding:10px 14px;margin-bottom:12px;">
            <img src="${s.guestPassQrDataUrl}" style="width:86px;height:86px;border-radius:10px;border:1px solid #EAD8C7;background:#fff;" alt="QR Tamu">
            <div style="font-size:12px;line-height:1.45;">
              <strong style="color:#1F5B56;">📱 QR Galeri Tamu Sudah Siap</strong>
              <div style="color:#6E584B;margin-top:2px;">Customer bisa scan QR ini sekarang untuk simpan link; fotonya akan muncul begitu tablet terhubung WiFi &amp; sinkronisasi selesai.</div>
            </div>
          </div>
        ` : `
          <div style="background:#FFF8E6;border:1.5px solid #D4A754;border-radius:12px;padding:10px 12px;font-size:12px;color:#5a3e1b;margin-bottom:12px;">
            ⏳ <strong>QR Menunggu WiFi:</strong> Stok QR offline habis; foto aman di tablet &amp; akan otomatis dibuatkan QR saat tersinkron di tenda.
          </div>
        `}
        ${(!s.printRequested && reqCopies > 0) ? `
          <div style="background:#FFF4D6;border:1.5px solid #E5B95C;border-radius:12px;padding:9px 12px;font-size:12px;color:#7A4B0E;margin-bottom:12px;font-weight:700;">
            📝 Pesanan Cetak Tersimpan: <strong>${reqPaperLbl} · ${reqCopies} Lembar</strong> (akan muncul di halaman Admin saat WiFi tersambung).
          </div>
        ` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          <button type="button" id="pbOfflineDetailQueue4R" class="btn btn-secondary" style="padding:8px 12px;font-size:12px;font-weight:800;border-radius:999px;cursor:pointer;">
            ${s.printRequested ? `✅ Antre Cetak ${paperLbl} (${s.printCopies || 1}×)` : '🖨️ Tandai Antre Cetak Server (4R)'}
          </button>
          <button type="button" id="pbOfflineDetailPrintLocal" class="btn btn-coral" style="padding:8px 14px;font-size:12px;font-weight:800;border-radius:999px;cursor:pointer;">
            🖨️ Cetak Langsung Tablet/Perangkat
          </button>
        </div>
      `;
      overlay.style.display = 'flex';
      document.getElementById('pbOfflineDetailCloseBtn').onclick = () => { overlay.style.display = 'none'; };
      document.getElementById('pbOfflineDetailQueue4R').onclick = async () => {
        await this.updateOfflineSessionPrint(s.id, { printRequested: !s.printRequested, printCopies: s.printCopies || 1, printPaperSize: s.printPaperSize || '4x6' });
        await this._showSessionDetail(s.id);
        await this.renderLocalGalleryModal();
      };
      document.getElementById('pbOfflineDetailPrintLocal').onclick = () => {
        const imgSrc = s.finalImage || (caps[0] && caps[0].dataUrl);
        if (imgSrc && window.pbPrintViaBrowser) {
          window.pbPrintViaBrowser({ imageUrl: imgSrc, copies: s.printCopies || 1 });
        }
      };
    },

    async renderLocalGalleryModal() {
      const body = document.getElementById('pbOfflineGalleryBody');
      const netEl = document.getElementById('pbOfflineGalleryNetStatus');
      const syncBtn = document.getElementById('pbOfflineGallerySyncBtn');
      if (!body || !netEl) return;

      const isOnline = navigator.onLine !== false;
      const isLocalMode = this.isLocalDirectMode();
      const pending = await this.getPendingSessions();
      pending.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const history = this.getRecentSyncedHistory();

      if (!isOnline) {
        netEl.innerHTML = `<span style="color:#B93829;">⚡ Tanpa Internet (Offline) · ${pending.length} foto aman tersimpan di perangkat</span>`;
      } else if (isLocalMode) {
        netEl.innerHTML = `<span style="color:#8A5A12;">🔌 Mode Lokal Aktif (otomatis kirim ke server dimatikan meski internet nyala) · ${pending.length} foto tersimpan</span>`;
      } else {
        netEl.innerHTML = `<span style="color:#1F5B56;">🟢 WiFi/Internet Tersambung · ${pending.length} foto menunggu kirim</span>`;
      }
      const disableLocalBtn = document.getElementById('pbOfflineDisableLocalBtn');
      if (disableLocalBtn) {
        disableLocalBtn.style.display = isLocalMode ? '' : 'none';
      }
      if (syncBtn) {
        syncBtn.style.display = pending.length > 0 ? '' : 'none';
        syncBtn.disabled = !isOnline || this.isSyncing;
        syncBtn.textContent = this.isSyncing ? '⏳ Sedang Mengirim...' : `🔄 Kirim Semua Sekarang (${pending.length})`;
      }

      if (pending.length === 0 && history.length === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:34px 16px;background:#FFF7EB;border:2px dashed #EAD8C7;border-radius:16px;">
            <div style="font-size:36px;margin-bottom:8px;">✅</div>
            <strong style="font-size:15px;color:#7B482E;">Belum Ada Antrean Foto Offline</strong>
            <p style="font-size:12.5px;color:#6E584B;margin:6px 0 0;">Saat Anda memotret di luar jangkauan WiFi, semua hasil foto &amp; pose customer akan langsung muncul di sini untuk dicek sebelum terkirim.</p>
          </div>
        `;
        return;
      }

      let html = '';
      if (pending.length > 0) {
        html += `<div style="font-size:13px;font-weight:800;color:#7B482E;margin-bottom:10px;">⏳ Foto Belum Terkirim di Perangkat Ini (${pending.length} Customer):</div>`;
        html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:18px;">`;
        for (const s of pending) {
          const thumb = s.finalImage || (s.captures && s.captures[0] && s.captures[0].dataUrl) || '';
          const timeStr = new Date(s.createdAt || Date.now()).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          const poseCount = Array.isArray(s.captures) ? s.captures.length : 0;
          const paperLbl = s.printPaperSize === '5x7' ? '5R' : (s.printPaperSize === '2x6' ? 'Strip' : '4R');
          const reqCopies = parseInt(s.requestedPrintCopies, 10) || 0;
          const reqPaperLbl = s.requestedPrintPaper === '5x7' ? '5R' : (s.requestedPrintPaper === '2x6' ? 'Strip' : '4R');
          const printTag = s.printRequested
            ? `<span style="background:#FFF8E6;color:#7a581a;border:1px solid #D4A754;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:800;">🖨️ Antre ${paperLbl} (${s.printCopies || 1}×)</span>`
            : (reqCopies > 0
              ? `<span style="background:#FFF4D6;color:#7A4B0E;border:1px solid #E5B95C;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:800;">📝 Mau Cetak: ${reqPaperLbl} (${reqCopies}×)</span>`
              : `<span style="background:#F3EFEA;color:#6E584B;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:700;">⚪ Belum Cetak</span>`);
          const qrTag = s.guestPassQrDataUrl
            ? `<span style="background:rgba(95,143,138,0.14);color:#1F5B56;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:800;">📱 QR Siap</span>`
            : `<span style="background:#FFF0EC;color:#B93829;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:700;">⏳ QR saat WiFi</span>`;

          html += `
            <div style="background:#fff;border:1.5px solid #EAD8C7;border-radius:16px;padding:10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 12px rgba(123,72,46,0.06);" data-off-id="${this._escapeHtml(s.id)}">
              <div style="height:170px;background:#1B1614;border-radius:10px;overflow:hidden;position:relative;cursor:pointer;display:flex;align-items:center;justify-content:center;" data-action="view" data-id="${this._escapeHtml(s.id)}">
                ${thumb ? `<img src="${thumb}" style="max-width:100%;max-height:100%;object-fit:contain;" alt="Preview">` : `<span style="color:#fff;font-size:12px;">Tanpa preview</span>`}
                <span style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.75);color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;">⚡ ${timeStr} · ${poseCount} foto</span>
              </div>
              <div style="font-size:12px;font-weight:800;color:#7B482E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this._escapeHtml(s.templateName || (s.mode === 'files_only' ? '📁 File HD Tanpa Bingkai' : '🖼️ Foto Booth'))}</div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">${printTag}${qrTag}</div>
              ${s.lastSyncError ? `<div style="font-size:10.5px;font-weight:700;color:#B93829;background:#FFF0EC;border:1px solid #F2C7C0;border-radius:8px;padding:4px 7px;line-height:1.3;">⚠️ Gagal kirim: ${this._escapeHtml(s.lastSyncError)}</div>` : ''}
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;">
                <button type="button" class="btn btn-secondary" data-action="view" data-id="${this._escapeHtml(s.id)}" style="flex:1;padding:6px 8px;font-size:11px;font-weight:800;border-radius:999px;cursor:pointer;">👁️ Cek Foto</button>
                <button type="button" class="btn btn-secondary" data-action="toggle-print" data-id="${this._escapeHtml(s.id)}" style="flex:1;padding:6px 8px;font-size:11px;font-weight:800;border-radius:999px;cursor:pointer;">🖨️ ${s.printRequested ? 'Batal Cetak' : 'Antre Cetak'}</button>
                ${isOnline ? `<button type="button" class="btn btn-teal" data-action="upload" data-id="${this._escapeHtml(s.id)}" style="width:100%;padding:6px 8px;font-size:11px;font-weight:800;border-radius:999px;cursor:pointer;">🚀 Kirim ke Server</button>` : ''}
                <button type="button" data-action="delete" data-id="${this._escapeHtml(s.id)}" style="width:100%;padding:5px;font-size:10.5px;font-weight:700;border-radius:999px;border:1px solid #f2c7c0;background:#fff8f7;color:#b93829;cursor:pointer;">🗑️ Hapus dari Perangkat</button>
              </div>
            </div>
          `;
        }
        html += `</div>`;
      }

      if (history.length > 0) {
        html += `<div style="font-size:12.5px;font-weight:800;color:#1F5B56;margin-bottom:8px;">✅ Baru Terkirim ke Server (${history.length} terbaru):</div>`;
        html += `<div style="display:flex;flex-direction:column;gap:6px;">`;
        for (const h of history) {
          const tSynced = new Date(h.syncedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          html += `
            <div style="background:#F6FCF8;border:1px solid #CBE7D6;border-radius:12px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;">
              <div><strong>${this._escapeHtml(h.templateName)}</strong> · ${h.capturesCount} foto · Terkirim ${tSynced}</div>
              <div style="color:#1F5B56;font-weight:800;">${h.printRequested ? `🖨️ Antre Cetak (${h.printCopies}×)` : '☁️ Tersimpan di Admin → Foto'}</div>
            </div>
          `;
        }
        html += `</div>`;
      }

      body.innerHTML = html;
      body.querySelectorAll('[data-action]').forEach(el => {
        el.addEventListener('click', async () => {
          const action = el.getAttribute('data-action');
          const id = el.getAttribute('data-id');
          if (!id) return;
          if (action === 'view') {
            await this._showSessionDetail(id);
          } else if (action === 'toggle-print') {
            const cur = pending.find(x => x.id === id);
            await this.updateOfflineSessionPrint(id, {
              printRequested: !(cur && cur.printRequested),
              printCopies: (cur && cur.printCopies) || 1,
              printPaperSize: (cur && cur.printPaperSize) || '4x6'
            });
            await this.renderLocalGalleryModal();
          } else if (action === 'upload') {
            if (!navigator.onLine) return;
            try {
              const syncRes = await this.syncSingleSessionById(id);
              if (syncRes && syncRes.busy) return;
              await this.renderLocalGalleryModal();
            } catch (err) {
              if (window.pbToast) window.pbToast(`Gagal kirim: ${err.message}`, 'error', 3500);
            }
          } else if (action === 'delete') {
            if (!confirm('Hapus foto offline ini dari tablet? Foto yang dihapus tidak akan dikirim ke server.')) return;
            await this.deleteSession(id);
            await this.renderLocalGalleryModal();
          }
        });
      });
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
      if (this._galleryOpen) {
        this.renderLocalGalleryModal().catch(() => {});
      }
    },

    initAutoSync() {
      // Event saat koneksi pulih
      window.addEventListener('online', () => {
        if (this.isLocalDirectMode()) return;
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
