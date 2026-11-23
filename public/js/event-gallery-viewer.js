/**
 * Shared Framed Photo & Scannable QR Gallery Viewer for Kiosk and Mingle (/kiosk & /mingle).
 * Lets operators inspect framed photos (server-synced + local offline pending), filter by print status,
 * preview in fullscreen, and display the scannable guest QR code modal without Admin login.
 */
(function () {
  if (typeof window === 'undefined' || window.MafazaEventGalleryViewer) return;

  const MODAL_ID = 'pbEventPhotosModal';
  const ZOOM_ID = 'pbEventPhotoZoomOverlay';
  const QR_ID = 'pbEventPhotoQrModal';

  function escHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatPaperLabel(code) {
    const raw = String(code || '').trim().toUpperCase();
    if (!raw) return '4R';
    if (raw === '5R' || raw === '5X7' || raw === '1500X2100' || raw === '2100X1500') return '5R';
    if (raw === '2X6' || raw === 'STRIP') return 'Strip';
    return '4R';
  }

  async function fetchJsonWithTimeout(url, timeoutMs = 6000) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const viewer = {
    eventId: null,
    filterKey: 'all',
    allItems: [],
    filteredItems: [],
    zoomIdx: 0,
    onToast: null,

    ensureDom() {
      if (document.getElementById(MODAL_ID)) return;
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div id="${MODAL_ID}" style="display:none;position:fixed;inset:0;z-index:10040;background:rgba(20,12,8,0.84);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px;">
          <div style="background:#FFFDF9;border:2px solid #EAD8C7;border-radius:24px;width:min(96vw,960px);max-height:92dvh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.45);color:#381E11;font-family:inherit;" data-modal-card="1">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:16px 20px;border-bottom:1.5px solid #EAD8C7;background:#FFF7EB;flex-wrap:wrap;">
              <div>
                <h3 style="margin:0;font-size:18px;font-weight:800;color:#7B482E;">🖼️ Galeri Foto Berframe</h3>
                <div id="pbEventPhotosSubtitle" style="font-size:12px;color:#6E584B;font-weight:600;margin-top:2px;">Memuat hasil foto berframe...</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <button type="button" class="btn btn-secondary pb-evphoto-filter" data-filter="all" style="padding:6px 12px;font-size:12px;font-weight:800;">Semua</button>
                <button type="button" class="btn btn-secondary pb-evphoto-filter" data-filter="unprinted" style="padding:6px 12px;font-size:12px;font-weight:800;">Belum Cetak</button>
                <button type="button" class="btn btn-secondary pb-evphoto-filter" data-filter="ordered" style="padding:6px 12px;font-size:12px;font-weight:800;">📝 Ada Pesanan</button>
                <button type="button" id="pbEventPhotosRefreshBtn" class="btn btn-teal" style="padding:7px 12px;font-size:12px;font-weight:800;">🔄 Segarkan</button>
                <button type="button" id="pbEventPhotosCloseBtn" style="width:36px;height:36px;border-radius:50%;border:none;background:rgba(123,72,46,0.14);color:#7B482E;font-size:16px;font-weight:800;cursor:pointer;">✕</button>
              </div>
            </div>
            <div id="pbEventPhotosBody" style="padding:16px 20px;overflow-y:auto;flex:1;"></div>
          </div>

          <div id="${ZOOM_ID}" style="display:none;position:fixed;inset:0;z-index:10055;background:rgba(12,7,4,0.92);align-items:center;justify-content:center;padding:16px;">
            <div style="background:#FFFDF9;border:2px solid #EAD8C7;border-radius:22px;width:min(94vw,860px);max-height:92dvh;padding:14px 16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 24px 64px rgba(0,0,0,0.55);color:#381E11;" data-modal-card="1">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                <div>
                  <strong id="pbEventPhotoZoomTitle" style="font-size:15.5px;color:#7B482E;">🖼️ Hasil Foto</strong>
                  <div id="pbEventPhotoZoomMeta" style="font-size:11.5px;color:#6E584B;font-weight:600;"></div>
                </div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                  <button type="button" id="pbEventPhotoZoomPrevBtn" class="btn btn-secondary" style="padding:6px 11px;font-size:13px;font-weight:800;">◀</button>
                  <button type="button" id="pbEventPhotoZoomNextBtn" class="btn btn-secondary" style="padding:6px 11px;font-size:13px;font-weight:800;">▶</button>
                  <button type="button" id="pbEventPhotoZoomQrBtn" class="btn btn-coral" style="padding:6px 12px;font-size:12px;font-weight:800;display:none;">📲 Tampilkan QR</button>
                  <button type="button" id="pbEventPhotoZoomCloseBtn" class="btn btn-secondary" style="padding:6px 14px;font-size:12.5px;font-weight:800;">✕ Tutup</button>
                </div>
              </div>
              <div style="background:#1B1614;border-radius:14px;padding:10px;display:flex;align-items:center;justify-content:center;flex:1;min-height:240px;max-height:74dvh;overflow:hidden;">
                <img id="pbEventPhotoZoomImg" src="" alt="Preview Foto Berframe" style="max-width:100%;max-height:70dvh;object-fit:contain;border-radius:8px;">
              </div>
            </div>
          </div>

          <div id="${QR_ID}" style="display:none;position:fixed;inset:0;z-index:10065;background:rgba(24,14,9,0.88);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px;">
            <div style="background:#FFFDF9;border:3px solid #E6786B;border-radius:28px;padding:24px 26px;max-width:440px;width:92vw;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.45);display:flex;flex-direction:column;align-items:center;gap:12px;color:#381E11;" data-modal-card="1">
              <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
                <strong style="font-size:17px;color:#7B482E;">📲 Scan QR Galeri Foto</strong>
                <button type="button" id="pbEventQrCloseTopBtn" style="width:34px;height:34px;border-radius:50%;border:none;background:rgba(123,72,46,0.12);color:#7B482E;font-size:16px;font-weight:800;cursor:pointer;">✕</button>
              </div>
              <div style="background:#FFFFFF;padding:12px;border-radius:20px;border:2px solid #F0E4D7;min-width:220px;min-height:220px;display:flex;align-items:center;justify-content:center;">
                <div id="pbEventQrStatus" style="display:none;font-size:13px;font-weight:700;color:#6E584B;padding:24px;">⏳ Memuat QR Code...</div>
                <img id="pbEventQrImg" src="" alt="QR Code Galeri Tamu" style="width:min(72vw,340px);height:min(72vw,340px);display:block;object-fit:contain;image-rendering:pixelated;">
              </div>
              <p style="margin:0;font-size:12.5px;color:#6E584B;font-weight:600;">Arahkan kamera HP tamu untuk mengunduh semua foto HD</p>
              <div style="display:flex;gap:10px;width:100%;">
                <a id="pbEventQrLink" href="#" target="_blank" class="btn btn-secondary" style="flex:1;padding:10px;font-size:13px;text-decoration:none;text-align:center;">🔗 Buka Link</a>
                <button type="button" id="pbEventQrCloseBtn" class="btn btn-coral" style="flex:1;padding:10px;font-size:13px;">Tutup</button>
              </div>
            </div>
          </div>
        </div>
      `;
      while (wrap.firstElementChild) {
        document.body.appendChild(wrap.firstElementChild);
      }

      const modal = document.getElementById(MODAL_ID);
      const zoom = document.getElementById(ZOOM_ID);
      const qr = document.getElementById(QR_ID);

      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) this.close();
      });
      zoom.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === zoom) this.closeZoom();
      });
      qr.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === qr) this.closeQr();
      });

      document.getElementById('pbEventPhotosCloseBtn').onclick = () => this.close();
      document.getElementById('pbEventPhotosRefreshBtn').onclick = () => this.load();
      document.getElementById('pbEventPhotoZoomPrevBtn').onclick = () => this.stepZoom(-1);
      document.getElementById('pbEventPhotoZoomNextBtn').onclick = () => this.stepZoom(1);
      document.getElementById('pbEventPhotoZoomQrBtn').onclick = () => this.openQr(this.zoomIdx);
      document.getElementById('pbEventPhotoZoomCloseBtn').onclick = () => this.closeZoom();
      document.getElementById('pbEventQrCloseTopBtn').onclick = () => this.closeQr();
      document.getElementById('pbEventQrCloseBtn').onclick = () => this.closeQr();

      document.querySelectorAll(`#${MODAL_ID} .pb-evphoto-filter`).forEach((btn) => {
        btn.onclick = () => this.setFilter(btn.dataset.filter);
      });

      document.getElementById('pbEventPhotosBody').addEventListener('click', (ev) => {
        const qrBtn = ev.target.closest('[data-evphoto-qr]');
        if (qrBtn) {
          ev.stopPropagation();
          this.openQr(parseInt(qrBtn.dataset.evphotoQr, 10));
          return;
        }
        const zoomBtn = ev.target.closest('[data-evphoto-zoom]');
        if (zoomBtn) {
          this.openZoom(parseInt(zoomBtn.dataset.evphotoZoom, 10));
        }
      });
    },

    toast(msg, icon = 'ℹ️', durationMs = 2600) {
      if (typeof this.onToast === 'function') {
        this.onToast(msg, icon, durationMs);
      } else if (window.pbToast) {
        window.pbToast(msg, icon === '⚠️' ? 'warn' : 'info', durationMs);
      }
    },

    open(opts = {}) {
      this.eventId = opts.eventId || this.eventId || null;
      this.onToast = typeof opts.onToast === 'function' ? opts.onToast : this.onToast;
      this.ensureDom();
      this.filterKey = this.filterKey || 'all';
      this.updateFilterButtons();
      document.getElementById(MODAL_ID).style.display = 'flex';
      return this.load();
    },

    close() {
      const modal = document.getElementById(MODAL_ID);
      if (modal) modal.style.display = 'none';
      this.closeZoom();
      this.closeQr();
    },

    closeZoom() {
      const zoom = document.getElementById(ZOOM_ID);
      if (zoom) zoom.style.display = 'none';
    },

    closeQr() {
      const qr = document.getElementById(QR_ID);
      if (qr) qr.style.display = 'none';
    },

    setFilter(key) {
      this.filterKey = ['unprinted', 'ordered'].includes(key) ? key : 'all';
      this.updateFilterButtons();
      this.renderGrid();
    },

    updateFilterButtons() {
      const activeKey = this.filterKey || 'all';
      document.querySelectorAll(`#${MODAL_ID} .pb-evphoto-filter`).forEach((btn) => {
        const isActive = btn.dataset.filter === activeKey;
        btn.style.background = isActive ? '#E6786B' : '';
        btn.style.color = isActive ? '#fff' : '';
        btn.style.borderColor = isActive ? '#E6786B' : '';
      });
    },

    async load() {
      this.ensureDom();
      const body = document.getElementById('pbEventPhotosBody');
      const sub = document.getElementById('pbEventPhotosSubtitle');
      if (body) {
        body.innerHTML = `<div style="text-align:center;padding:34px;color:#6E584B;font-weight:700;">⏳ Memuat foto berframe...</div>`;
      }

      const items = [];
      const seenSessionIds = new Set();

      try {
        if (window.pbOfflineStore && typeof window.pbOfflineStore.getPendingSessions === 'function') {
          const pending = await window.pbOfflineStore.getPendingSessions();
          pending.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          for (const s of pending) {
            if (!s || !s.finalImage) continue;
            if (s.id) seenSessionIds.add(s.id);
            const reqCopies = parseInt(s.requestedPrintCopies, 10) || 0;
            items.push({
              id: s.id,
              assetId: null,
              sessionId: s.id,
              src: s.finalImage,
              createdAt: s.createdAt || Date.now(),
              templateName: s.templateName || 'Foto Booth',
              galleryUrl: s.guestPassGalleryUrl || null,
              qrDataUrl: s.guestPassQrDataUrl || null,
              isPrinted: false,
              printCopies: 0,
              requestedCopies: reqCopies,
              requestedPaperLabel: reqCopies > 0 ? formatPaperLabel(s.requestedPrintPaper || '4R') : null,
              isLocalPending: true
            });
          }
        }
      } catch (e) {}

      let serverCount = 0;
      if (navigator.onLine !== false) {
        try {
          const q = this.eventId ? `?eventId=${encodeURIComponent(this.eventId)}` : '';
          const rows = await fetchJsonWithTimeout(`/api/kiosk/gallery/recent${q}`);
          for (const r of (Array.isArray(rows) ? rows : [])) {
            if (!r || !r.file_path) continue;
            if (r.session_id && seenSessionIds.has(r.session_id)) continue;
            const reqCopies = parseInt(r.requested_print_copies, 10) || 0;
            items.push({
              id: r.asset_id || r.session_id,
              assetId: r.asset_id || null,
              sessionId: r.session_id,
              src: r.file_path,
              createdAt: r.created_at || Date.now(),
              templateName: r.template_name || r.event_name || 'Foto Berframe',
              galleryUrl: r.galleryUrl || null,
              qrDataUrl: null,
              isPrinted: Boolean(r.print_job_id),
              printCopies: parseInt(r.print_copies, 10) || 1,
              requestedCopies: reqCopies,
              requestedPaperLabel: reqCopies > 0 ? formatPaperLabel(r.requested_print_paper || r.template_paper_size || '4R') : null,
              isLocalPending: false
            });
            serverCount++;
          }
        } catch (e) {}
      }

      this.allItems = items;
      if (sub) {
        const localCount = items.filter((x) => x.isLocalPending).length;
        sub.textContent = localCount > 0
          ? `${serverCount} foto di server + ${localCount} menunggu kirim di perangkat ini`
          : `${items.length} foto berframe terbaru`;
      }
      this.renderGrid();
      return items;
    },

    renderGrid() {
      const body = document.getElementById('pbEventPhotosBody');
      if (!body) return;
      const filtered = (this.allItems || []).filter((p) => {
        if (this.filterKey === 'unprinted') return !p.isPrinted;
        if (this.filterKey === 'ordered') return !p.isPrinted && p.requestedCopies > 0;
        return true;
      });
      this.filteredItems = filtered;

      if (filtered.length === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:36px 16px;background:#FFF7EB;border:2px dashed #EAD8C7;border-radius:16px;">
            <div style="font-size:36px;margin-bottom:8px;">🖼️</div>
            <strong style="font-size:15px;color:#7B482E;">Belum Ada Foto Berframe</strong>
            <p style="font-size:12.5px;color:#6E584B;margin:6px 0 0;">Foto tamu yang sudah memakai bingkai frame akan otomatis muncul di sini untuk dicek &amp; scan QR ulang.</p>
          </div>
        `;
        return;
      }

      body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(195px,1fr));gap:12px;">` + filtered.map((p, idx) => {
        const timeStr = new Date(p.createdAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        const statusBadge = p.isPrinted
          ? `<span style="font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;background:rgba(39,174,96,0.14);color:#1E8449;border:1px solid rgba(39,174,96,0.28);">🟢 Dicetak (${p.printCopies}×)</span>`
          : `<span style="font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px;background:#F3EFEA;color:#6E584B;border:1px solid #EAD8C7;">⚪ Belum Cetak</span>`;
        const orderNote = (!p.isPrinted && p.requestedCopies > 0)
          ? `<div style="font-size:11px;font-weight:800;color:#7A4B0E;background:#FFF4D6;border:1px solid #E5B95C;border-radius:8px;padding:4px 7px;display:flex;justify-content:space-between;"><span>📝 Pesanan</span><span>${escHtml(p.requestedPaperLabel)} · ${p.requestedCopies}×</span></div>`
          : '';
        const cardStyle = (!p.isPrinted && p.requestedCopies > 0)
          ? 'border:2px solid #D4A754;background:#FFFDF7;'
          : 'border:1.5px solid #EAD8C7;background:#fff;';
        const hasQr = Boolean(p.qrDataUrl || p.galleryUrl || (!p.isLocalPending && navigator.onLine !== false));

        return `
          <div style="${cardStyle}border-radius:16px;padding:10px;display:flex;flex-direction:column;gap:7px;box-shadow:0 4px 12px rgba(123,72,46,0.06);">
            <div data-evphoto-zoom="${idx}" style="height:190px;background:#1B1614;border-radius:11px;overflow:hidden;position:relative;cursor:pointer;display:flex;align-items:center;justify-content:center;">
              <img src="${escHtml(p.src)}" loading="lazy" style="max-width:100%;max-height:100%;object-fit:contain;" alt="Foto Berframe">
              ${p.isLocalPending ? `<span style="position:absolute;top:6px;left:6px;background:rgba(212,167,84,0.95);color:#381E11;font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;">⚡ Lokal</span>` : ''}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
              <span style="font-size:11.5px;font-weight:800;color:#7B482E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(p.templateName)}</span>
              ${statusBadge}
            </div>
            <div style="font-size:10.5px;color:#6E584B;">${escHtml(timeStr)}</div>
            ${orderNote}
            <div style="display:flex;gap:6px;margin-top:auto;">
              <button type="button" class="btn btn-secondary" data-evphoto-zoom="${idx}" style="flex:1;padding:6px 8px;font-size:11.5px;font-weight:800;">👁️ Perbesar</button>
              ${hasQr ? `<button type="button" class="btn btn-coral" data-evphoto-qr="${idx}" style="padding:6px 10px;font-size:11.5px;font-weight:800;">📲 QR</button>` : ''}
            </div>
          </div>
        `;
      }).join('') + `</div>`;
    },

    openZoom(index) {
      const list = this.filteredItems || [];
      const item = list[index];
      if (!item) return;
      this.zoomIdx = index;
      this.ensureDom();
      const overlay = document.getElementById(ZOOM_ID);
      const img = document.getElementById('pbEventPhotoZoomImg');
      const title = document.getElementById('pbEventPhotoZoomTitle');
      const meta = document.getElementById('pbEventPhotoZoomMeta');
      const qrBtn = document.getElementById('pbEventPhotoZoomQrBtn');
      if (img) img.src = item.src;
      if (title) title.textContent = `🖼️ ${item.templateName || 'Foto Berframe'} (${index + 1}/${list.length})`;
      if (meta) {
        const timeStr = new Date(item.createdAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        const statusText = item.isPrinted
          ? `Dicetak ${item.printCopies}×`
          : (item.requestedCopies > 0 ? `Pesanan Cetak: ${item.requestedPaperLabel} (${item.requestedCopies}×)` : 'Belum Dicetak');
        meta.textContent = `${timeStr} · ${statusText}${item.isLocalPending ? ' · Belum dikirim ke server' : ''}`;
      }
      if (qrBtn) {
        const canShowQr = Boolean(item.qrDataUrl || item.galleryUrl || (!item.isLocalPending && navigator.onLine !== false));
        qrBtn.style.display = canShowQr ? 'inline-flex' : 'none';
      }
      if (overlay) overlay.style.display = 'flex';
    },

    stepZoom(delta) {
      const list = this.filteredItems || [];
      if (list.length === 0) return;
      this.openZoom((this.zoomIdx + delta + list.length) % list.length);
    },

    async openQr(index) {
      const item = (this.filteredItems || [])[index];
      if (!item) return;
      this.ensureDom();

      const modal = document.getElementById(QR_ID);
      const zoomImg = document.getElementById('pbEventQrImg');
      const zoomStatus = document.getElementById('pbEventQrStatus');
      const zoomLink = document.getElementById('pbEventQrLink');
      if (!modal || !zoomImg) return;

      const setLink = (url) => {
        if (!zoomLink) return;
        if (url) {
          zoomLink.href = url;
          zoomLink.style.display = '';
        } else {
          zoomLink.style.display = 'none';
        }
      };

      if (item.qrDataUrl) {
        if (zoomStatus) zoomStatus.style.display = 'none';
        zoomImg.style.display = 'block';
        zoomImg.src = item.qrDataUrl;
        setLink(item.galleryUrl);
        modal.style.display = 'flex';
        return;
      }

      if (item.isLocalPending || navigator.onLine === false) {
        this.toast('⏳ QR belum tersedia karena difoto saat offline tanpa stok QR — akan dibuat saat WiFi tersambung.', 'ℹ️', 3000);
        return;
      }

      zoomImg.style.display = 'none';
      if (zoomStatus) {
        zoomStatus.textContent = '⏳ Menyiapkan QR Code...';
        zoomStatus.style.display = 'block';
      }
      setLink(item.galleryUrl);
      modal.style.display = 'flex';

      try {
        const qs = new URLSearchParams();
        if (item.assetId) qs.set('assetId', item.assetId);
        if (item.sessionId) qs.set('sessionId', item.sessionId);
        const data = await fetchJsonWithTimeout(`/api/kiosk/gallery/qr?${qs.toString()}`);
        if (!data || !data.qrDataUrl) throw new Error('QR kosong');

        item.qrDataUrl = data.qrDataUrl;
        if (data.galleryUrl) item.galleryUrl = data.galleryUrl;
        zoomImg.src = data.qrDataUrl;
        zoomImg.style.display = 'block';
        if (zoomStatus) zoomStatus.style.display = 'none';
        setLink(data.galleryUrl);
      } catch (err) {
        modal.style.display = 'none';
        this.toast('⚠️ Gagal mengambil QR Code. Periksa koneksi server.', '⚠️', 2600);
      }
    }
  };

  window.MafazaEventGalleryViewer = viewer;
})();
