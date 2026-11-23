/**
 * MAFAZA MINGLE BOOTH ENGINE (/mingle)
 * Alur cepat foto keliling:
 *   1) Tamu pilih 1 bingkai Mingle
 *   2) Fotografer langsung tekan tombol shutter fisik kamera Sony / Canon (tanpa countdown)
 *   3) Foto otomatis terpasang ke bingkai + muncul QR Code download untuk tamu
 */
class MingleBoothEngine {
  constructor() {
    this.tenantId = 'tenant_studiokeren_01';
    const urlParams = new URLSearchParams(window.location.search);
    this.eventId = urlParams.get('eventId') || localStorage.getItem('pb_active_event_id') || 'event_wedding_dimas_sarah';
    this.deviceId = 'dev_mingle_tablet_01';

    this.templates = [];
    this.allTemplates = [];
    this.showFallbackFrames = false;
    this.orientFilter = 'all';
    this.selectedTemplate = null;
    this.cachedKeyedFrame = null;
    this.filesOnlyMode = false;
    this.shotsOverride = 'auto';
    this.activeTargetShots = 1;
    this.eventShotsCount = 1;

    this.currentScreen = 'screenMingleWelcome';
    this.currentAppliedBgKey = null;
    this.isProcessingCapture = false;
    this.capturedPhotos = [];
    this.syncedCaptureCount = 0;
    this.slotAssignments = [];
    this.slotTransforms = [];
    this.selectedSlotIdx = 0;
    this.selectedFileIdx = 0;
    this.rawPhotoDataUrl = null;
    this.cachedPhotoImg = null;
    this.cachedPhotoMap = {};
    this.activeFilter = 'normal';
    this.isTopLiveLayout = urlParams.get('fullscreen') === '1' || localStorage.getItem('pb_mingle_top_live') === 'true';

    this.guestPass = null;
    this.sessionId = null;

    // USB PTP bridge state (127.0.0.1:19898)
    this.usbStatus = null;
    this.baselinePhysicalSeq = 0;
    this._lastAcceptedPhysicalSeq = 0;
    this._physicalReadyArmed = false;
    this.canonLiveViewInMingle = true;
    const savedRot = parseInt(localStorage.getItem('pb_camera_rotation') || '0', 10);
    this.cameraRotation = [0, 90, 180, 270].includes(savedRot) ? savedRot : 0;
    this.liveViewTimerId = null;
    this.statusTimerId = null;
    this.webcamStream = null;
    this.toastTimerId = null;

    this.init();
  }

  async init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }
    this.setupAudio();
    this.setupCanvasPanAndZoom();
    this.setupLifecycleListeners();

    // Tampilkan data event & frame dari cache lokal seketika (< 50ms) agar bebas lag meski sinyal lambat/mati
    await this.hydrateCacheFirst();

    this.updateCameraRotationUI();
    this.applyTopLiveLayout();
    this.startStatusPolling();
    this.setUsbMingleListen(false);

    await Promise.allSettled([
      this.fetchEventConfig(),
      this.fetchTemplates()
    ]);

    this.renderFramesGrid();
    this.updateOfflineGalleryBadge();
    this.replenishGuestPassPool(20).catch(() => {});
  }

  async hydrateCacheFirst() {
    if (!window.pbOfflineStore) return;
    try {
      const [cachedEv, cachedMingle, cachedAll] = await Promise.all([
        window.pbOfflineStore.getCachedConfig('event_' + this.eventId),
        window.pbOfflineStore.getCachedConfig('mingle_templates_' + this.eventId),
        window.pbOfflineStore.getCachedConfig('mingle_all_templates_' + this.eventId)
      ]);
      if (cachedEv) {
        this.tenantId = cachedEv.tenant_id || this.tenantId;
        this.eventConfig = cachedEv.config || {};
        if (this.eventConfig.shotsCount) {
          this.eventShotsCount = parseInt(this.eventConfig.shotsCount, 10) || 1;
        }
        const titleEl = document.getElementById('mingleEventTitle');
        if (titleEl) titleEl.innerText = `Event: ${cachedEv.name || 'Siap'}`;
        this.applyEventPresentation(cachedEv.name);
      }
      if (Array.isArray(cachedMingle) && cachedMingle.length > 0) {
        this.templates = cachedMingle;
      }
      if (Array.isArray(cachedAll) && cachedAll.length > 0) {
        this.allTemplates = cachedAll;
      }
      if (this.templates.length > 0 || this.allTemplates.length > 0) {
        this.renderFramesGrid();
      }
    } catch (e) {}
  }

  getGuestPassPoolKey() {
    return `pb_guest_pass_pool_${this.tenantId || 'default'}_${this.eventId || 'default'}`;
  }

  popGuestPassFromPool() {
    try {
      const key = this.getGuestPassPoolKey();
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const pool = JSON.parse(raw);
      if (!Array.isArray(pool) || pool.length === 0) return null;
      const idx = pool.findIndex(p => p && p.id && (p.token || p.token_plain) && p.qrDataUrl);
      if (idx === -1) return null;
      const picked = pool.splice(idx, 1)[0];
      localStorage.setItem(key, JSON.stringify(pool));
      if (navigator.onLine !== false) {
        setTimeout(() => this.replenishGuestPassPool().catch(() => {}), 300);
      }
      return picked;
    } catch (e) {
      return null;
    }
  }

  async replenishGuestPassPool(targetCount = 20) {
    if (navigator.onLine === false || this._replenishingPassPool) return;
    this._replenishingPassPool = true;
    try {
      const key = this.getGuestPassPoolKey();
      let pool = [];
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(parsed)) pool = parsed.filter(p => p && p.id && (p.token || p.token_plain) && p.qrDataUrl);
      } catch (e) {}

      while (pool.length < targetCount && navigator.onLine !== false) {
        const res = await this.fetchWithTimeout('/api/guest-passes/issue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId: this.tenantId,
            eventId: this.eventId,
            baseUrl: window.location.origin
          })
        }, 2200);
        if (!res.ok) break;
        const pass = await res.json();
        if (!pass || !pass.id || !pass.qrDataUrl) break;
        pool.push({
          id: pass.id,
          token: pass.token || pass.token_plain,
          token_plain: pass.token_plain || pass.token,
          galleryUrl: pass.galleryUrl,
          fullQrUrl: pass.fullQrUrl,
          qrDataUrl: pass.qrDataUrl
        });
        try { localStorage.setItem(key, JSON.stringify(pool)); } catch (e) { break; }
      }
    } catch (e) {
    } finally {
      this._replenishingPassPool = false;
    }
  }

  isLocalDirectMode() {
    try {
      const ls = localStorage.getItem('pb_kiosk_local_mode');
      if (ls === 'true') return true;
      if (ls === 'false') return false;
    } catch (e) {}
    return Boolean(this.eventConfig && this.eventConfig.localPrintMode);
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = 2500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  setupAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.audioCtx = new AudioCtx();
    } catch (e) {}
  }

  playShutterSound() {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1350, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.09);
      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.09);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch (e) {}
  }

  setupLifecycleListeners() {
    window.addEventListener('mafaza:physical-shutter', (ev) => {
      const detail = (ev && ev.detail) || {};
      const seq = Number(detail.seq || 0);
      const minSeq = Math.max(this.baselinePhysicalSeq || 0, this._lastAcceptedPhysicalSeq || 0);
      if (this._physicalReadyArmed && this.currentScreen === 'screenMingleReady' && seq > minSeq && !this.isProcessingCapture) {
        this.baselinePhysicalSeq = seq;
        this._lastAcceptedPhysicalSeq = seq;
        this.handleIncomingPhysicalPhoto(detail.url || `http://127.0.0.1:19898/physical_capture.jpg?seq=${seq}`);
      }
    });

    const releaseResources = () => {
      this._physicalReadyArmed = false;
      this.setUsbMingleListen(false);
      this.stopLiveViewLoop();
      this.stopWebcam();
    };
    window.addEventListener('pagehide', releaseResources);
    window.addEventListener('beforeunload', releaseResources);

    window.addEventListener('online', () => {
      this.updateOfflineGalleryBadge();
      setTimeout(() => this.replenishGuestPassPool(20).catch(() => {}), 800);
    });
    window.addEventListener('offline', () => {
      this.updateOfflineGalleryBadge();
    });
    if (window.pbOfflineStore && typeof window.pbOfflineStore.subscribe === 'function') {
      window.pbOfflineStore.subscribe(() => {
        this.updateOfflineGalleryBadge();
        if (navigator.onLine !== false) {
          this.replenishGuestPassPool(20).catch(() => {});
        }
      });
    }
    this._poolRefillTimerId = setInterval(() => {
      if (navigator.onLine !== false) {
        this.replenishGuestPassPool(20).catch(() => {});
      }
      this.updateOfflineGalleryBadge();
    }, 30000);
  }

  async updateOfflineGalleryBadge() {
    let count = 0;
    try {
      if (window.pbOfflineStore && typeof window.pbOfflineStore.getPendingCount === 'function') {
        count = await window.pbOfflineStore.getPendingCount();
      }
    } catch (e) {}
    const isOnline = navigator.onLine !== false;
    const label = count > 0
      ? (isOnline ? `🔄 Mengirim (${count}) · 📂 Galeri` : `📦 Belum Terkirim (${count})`)
      : (isOnline ? '📂 Galeri Lokal' : '⚡ Offline · 📂 Galeri');

    for (const id of ['btnMingleOfflineGallery', 'btnMingleWelcomeOfflineGallery']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.textContent = label;
      btn.style.borderColor = count > 0 ? (isOnline ? '#5F8F8A' : '#E6786B') : '';
      btn.style.background = count > 0 ? (isOnline ? 'rgba(95, 143, 138, 0.16)' : '#FFF0EC') : '';
      btn.style.color = count > 0 ? (isOnline ? '#1F5B56' : '#B93829') : '';
    }
  }

  async refreshAll() {
    this.showToast('Memuat ulang event & bingkai Mingle...', '🔄', 1800);
    await Promise.allSettled([this.fetchEventConfig(), this.fetchTemplates()]);
    this.renderFramesGrid();
  }

  async fetchEventConfig() {
    const titleEl = document.getElementById('mingleEventTitle');
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (!urlParams.get('eventId')) {
        try {
          const curRes = await this.fetchWithTimeout('/api/events/active/current', {}, 1800);
          if (curRes.ok) {
            const curData = await curRes.json();
            if (curData && curData.activeEventId) {
              this.eventId = curData.activeEventId;
              try { localStorage.setItem('pb_active_event_id', this.eventId); } catch (e) {}
            }
          }
        } catch (err) {}
      }
      const evRes = await this.fetchWithTimeout(`/api/events/${encodeURIComponent(this.eventId)}`, {}, 2000);
      if (evRes.ok) {
        const ev = await evRes.json();
        if (ev && !ev.offline) {
          this.tenantId = ev.tenant_id || this.tenantId;
          this.eventConfig = ev.config || {};
          if (this.eventConfig.shotsCount) {
            this.eventShotsCount = parseInt(this.eventConfig.shotsCount, 10) || 1;
          }
          if (window.pbOfflineStore) {
            window.pbOfflineStore.cacheConfig('event_' + this.eventId, ev);
          }
          const bgUrl = this.eventConfig?.kioskBackground?.url;
          if (bgUrl && (!this.eventConfig.kioskBackground.type || this.eventConfig.kioskBackground.type === 'image')) {
            const bgWarm = new Image();
            bgWarm.src = bgUrl;
          }
          if (titleEl) titleEl.innerText = `Event: ${ev.name || 'Aktif'}`;
          this.applyEventPresentation(ev.name);
          this.replenishGuestPassPool(20).catch(() => {});
          return;
        }
      }
    } catch (e) {}

    if (window.pbOfflineStore) {
      try {
        const cachedEv = await window.pbOfflineStore.getCachedConfig('event_' + this.eventId);
        if (cachedEv) {
          this.tenantId = cachedEv.tenant_id || this.tenantId;
          this.eventConfig = cachedEv.config || {};
          if (this.eventConfig.shotsCount) {
            this.eventShotsCount = parseInt(this.eventConfig.shotsCount, 10) || 1;
          }
          if (titleEl) titleEl.innerText = `Event: ${cachedEv.name || 'Offline Siap'}`;
          this.applyEventPresentation(cachedEv.name);
          return;
        }
      } catch (e) {}
    }
    if (titleEl) titleEl.innerText = 'Mingle Booth · Mode Siap';
    this.applyEventPresentation(null);
  }

  applyEventPresentation(eventName) {
    const brandEl = document.getElementById('mingleWelcomeBrandTitle');
    if (brandEl) {
      brandEl.innerText = eventName ? `MAFAZA • ${eventName}` : 'MAFAZA • Mingle';
    }
    if (eventName) {
      document.title = `Mafaza — ${eventName}`;
    }
    this.applyMingleWelcomeText();
    this.applyMingleBackground();
  }

  applyMingleWelcomeText() {
    const headlineEl = document.getElementById('mingleWelcomeHeadlineText');
    const startBtn = document.getElementById('mingleWelcomeStartBtn');
    const headline = (this.eventConfig && this.eventConfig.welcomeHeadline) || 'Abadikan Momen Spesialmu Di Sini! 😊';
    const btnText = (this.eventConfig && this.eventConfig.welcomeBtnText) || 'Mulai Foto ➔';

    if (headlineEl) {
      headlineEl.innerHTML = String(headline).replace(/\n/g, '<br>');
    }
    if (startBtn) {
      startBtn.innerText = btnText;
    }
  }

  extractYouTubeId(url) {
    if (!url) return null;
    const trimmed = String(url).trim();
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{6,15})/,
      /[?&]v=([a-zA-Z0-9_-]{6,15})/
    ];
    for (const re of patterns) {
      const m = trimmed.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  applyMingleBackground() {
    const wrapper = document.getElementById('mingleWrapper');
    const bgContainer = document.getElementById('mingleCustomBgContainer');
    const bgImg = document.getElementById('mingleBgImage');
    const bgVideo = document.getElementById('mingleBgVideo');
    const bgYtWrap = document.getElementById('mingleBgYoutubeWrap');
    const bgYtIframe = document.getElementById('mingleBgYoutubeIframe');
    const bgOverlay = document.getElementById('mingleBgOverlay');
    const headlineEl = document.getElementById('mingleWelcomeHeadlineText');

    if (!bgContainer) return;

    const bgCfg = (this.eventConfig && this.eventConfig.kioskBackground) || { type: 'default', url: '', overlayOpacity: 35 };
    const type = bgCfg.type || 'default';
    const url = (bgCfg.url || '').trim();
    const opacityVal = (bgCfg.overlayOpacity !== undefined && bgCfg.overlayOpacity !== null) ? parseInt(bgCfg.overlayOpacity, 10) : 35;
    const opacityFloat = Math.max(0, Math.min(0.85, (isNaN(opacityVal) ? 35 : opacityVal) / 100));

    if (type === 'default' || !url) {
      this.currentAppliedBgKey = 'default';
      bgContainer.style.display = 'none';
      if (wrapper) wrapper.classList.remove('has-custom-bg');
      if (bgImg) { bgImg.style.display = 'none'; bgImg.removeAttribute('src'); }
      if (bgVideo) { bgVideo.style.display = 'none'; bgVideo.pause(); bgVideo.removeAttribute('src'); }
      if (bgYtWrap) bgYtWrap.style.display = 'none';
      if (bgYtIframe) bgYtIframe.src = '';
      if (headlineEl) {
        headlineEl.style.color = 'var(--caramel-brown)';
        headlineEl.style.textShadow = '0 2px 4px rgba(123,72,46,0.05)';
      }
      return;
    }

    bgContainer.style.display = 'block';
    if (wrapper) wrapper.classList.add('has-custom-bg');
    if (bgOverlay) {
      bgOverlay.style.background = `rgba(28, 18, 12, ${opacityFloat})`;
    }
    if (headlineEl) {
      if (opacityVal >= 15) {
        headlineEl.style.color = '#FFFBF5';
        headlineEl.style.textShadow = '0 4px 20px rgba(0, 0, 0, 0.75)';
      } else {
        headlineEl.style.color = 'var(--caramel-brown)';
        headlineEl.style.textShadow = '0 2px 14px rgba(255, 251, 245, 0.95)';
      }
    }

    const bgKey = `${type}::${url}`;
    if (this.currentAppliedBgKey === bgKey) return;
    this.currentAppliedBgKey = bgKey;

    if (bgImg) bgImg.style.display = 'none';
    if (bgVideo) { bgVideo.style.display = 'none'; bgVideo.pause(); }
    if (bgYtWrap) bgYtWrap.style.display = 'none';

    if (type === 'youtube') {
      const ytId = this.extractYouTubeId(url);
      if (ytId && bgYtWrap && bgYtIframe) {
        bgYtIframe.src = `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&loop=1&playlist=${ytId}&controls=0&showinfo=0&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1`;
        bgYtWrap.style.display = 'block';
      }
    } else if (type === 'video') {
      if (bgVideo) {
        bgVideo.src = url;
        bgVideo.style.display = 'block';
        bgVideo.play().catch(() => {});
      }
    } else if (bgImg) {
      bgImg.src = url;
      bgImg.style.display = 'block';
    }
  }

  async fetchTemplates() {
    try {
      const [mingleRes, allRes] = await Promise.all([
        this.fetchWithTimeout(`/api/templates?eventId=${encodeURIComponent(this.eventId)}&scope=include_global&booth=mingle`, { cache: 'no-store' }, 2500),
        this.fetchWithTimeout(`/api/templates?eventId=${encodeURIComponent(this.eventId)}&scope=include_global`, { cache: 'no-store' }, 2500)
      ]);
      if (mingleRes.ok) {
        const mingleList = await mingleRes.json();
        if (Array.isArray(mingleList) && mingleList.length > 0) {
          this.templates = mingleList;
          if (window.pbOfflineStore) {
            window.pbOfflineStore.cacheConfig('mingle_templates_' + this.eventId, this.templates);
          }
        }
      }
      if (allRes.ok) {
        const allList = await allRes.json();
        if (Array.isArray(allList) && allList.length > 0) {
          this.allTemplates = allList.filter(t => (t.slots && t.slots.length <= 1) || t.orientation !== 'strip');
          if (window.pbOfflineStore) {
            window.pbOfflineStore.cacheConfig('mingle_all_templates_' + this.eventId, this.allTemplates);
          }
        }
      }
      if (this.selectedTemplate && this.selectedTemplate.id) {
        const freshSelected = (this.allTemplates || []).find(t => t.id === this.selectedTemplate.id)
          || (this.templates || []).find(t => t.id === this.selectedTemplate.id);
        if (freshSelected) this.selectedTemplate = freshSelected;
      }
    } catch (e) {
      console.warn('Mingle template fetch fallback:', e);
    }

    if ((!this.templates || this.templates.length === 0) && window.pbOfflineStore) {
      try {
        const cachedMingle = await window.pbOfflineStore.getCachedConfig('mingle_templates_' + this.eventId);
        if (Array.isArray(cachedMingle) && cachedMingle.length > 0) this.templates = cachedMingle;
      } catch (e) {}
    }
    if ((!this.allTemplates || this.allTemplates.length === 0) && window.pbOfflineStore) {
      try {
        const cachedAll = await window.pbOfflineStore.getCachedConfig('mingle_all_templates_' + this.eventId);
        if (Array.isArray(cachedAll) && cachedAll.length > 0) this.allTemplates = cachedAll;
      } catch (e) {}
    }

    // Pre-warm image URLs into browser/SW cache while signal is available
    [...(this.templates || []), ...(this.allTemplates || [])].forEach(t => {
      if (t && t.image_storage_key && !String(t.image_storage_key).startsWith('data:')) {
        const preImg = new Image();
        preImg.src = t.image_storage_key;
      }
    });

    if ((!this.templates || this.templates.length === 0) && (!this.allTemplates || this.allTemplates.length === 0)) {
      this.allTemplates = [{
        id: 'tpl_mingle_default',
        name: 'Bingkai Klasik Mingle (4×6)',
        orientation: 'portrait',
        width: 1200,
        height: 1800,
        booth_mode: 'mingle',
        slots: [{ id: 'slot_1', pose_index: 1, x: 80, y: 120, width: 1040, height: 1400 }],
        image_storage_key: '/assets/templates/single-green-template.svg'
      }];
    }
  }

  isTemplateLandscape(tpl) {
    if (!tpl) return false;
    if (String(tpl.orientation || '').toLowerCase() === 'landscape') return true;
    return !!(tpl.width && tpl.height && Number(tpl.width) > Number(tpl.height));
  }

  getTemplateFormatLabel(tpl) {
    if (!tpl) return '4R Potret';
    const orient = String(tpl.orientation || '').toLowerCase();
    if (orient === 'strip') return 'Strip 2×6';
    if (orient === 'square' || (tpl.width && tpl.height && Math.abs(tpl.width - tpl.height) <= 12)) return 'Square 4×4';
    const w = parseInt(tpl.width, 10) || 1200;
    const h = parseInt(tpl.height, 10) || 1800;
    const maxD = Math.max(w, h);
    const minD = Math.min(w, h);
    const ratio = maxD / Math.max(1, minD);
    const pSize = String(tpl.paper_size || '').toUpperCase();
    const is5R = pSize === '5R' || (ratio >= 1.34 && ratio <= 1.44) || (maxD >= 2000 && ratio < 1.46);
    const prefix = is5R ? '5R' : '4R';
    return this.isTemplateLandscape(tpl) ? `${prefix} Lanskap` : `${prefix} Potret`;
  }

  applyOrientationLayout(tplW, tplH) {
    const isLand = tplW > tplH;
    const isSquare = Math.abs(tplW - tplH) <= 12;
    const ratioCss = `${tplW} / ${tplH}`;

    const readyGrid = document.getElementById('mingleReadyGrid');
    const viewfinder = document.getElementById('mingleViewfinder');
    const thumb = document.getElementById('mingleSelectedThumb');
    const resultGrid = document.getElementById('mingleResultGrid');
    const canvasStage = document.getElementById('mingleCanvasStage');
    const finalCanvas = document.getElementById('mingleFinalCanvas');

    if (readyGrid) readyGrid.classList.toggle('is-landscape', isLand);
    if (viewfinder) {
      viewfinder.classList.toggle('is-landscape', isLand);
      viewfinder.classList.toggle('is-portrait', !isLand && !isSquare);
      viewfinder.style.aspectRatio = ratioCss;
    }
    if (thumb) {
      thumb.style.width = isLand ? '100px' : '72px';
      thumb.style.height = isLand ? '70px' : '96px';
    }
    if (resultGrid) resultGrid.classList.toggle('is-landscape', isLand);
    if (canvasStage) canvasStage.classList.toggle('is-landscape', isLand);
    if (finalCanvas) {
      finalCanvas.classList.toggle('is-landscape', isLand);
      finalCanvas.style.aspectRatio = ratioCss;
    }
  }

  setOrientFilter(orient) {
    this.orientFilter = orient || 'all';
    document.querySelectorAll('#mingleOrientFilterRow .mingle-orient-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-orient') === this.orientFilter);
    });
    this.renderFramesGrid();
  }

  toggleShowFallbackFrames() {
    this.showFallbackFrames = !this.showFallbackFrames;
    this.renderFramesGrid();
  }

  renderFramesGrid() {
    const grid = document.getElementById('mingleFramesGrid');
    const hintEl = document.getElementById('mingleTemplateHint');
    const toggleBtn = document.getElementById('btnToggleAllMingleFrames');
    if (!grid) return;

    const hasDedicatedMingle = this.templates && this.templates.length > 0;
    let list = (this.showFallbackFrames || !hasDedicatedMingle)
      ? (this.allTemplates.length > 0 ? this.allTemplates : this.templates)
      : this.templates;

    if (this.orientFilter === 'portrait') {
      list = list.filter(t => !this.isTemplateLandscape(t));
    } else if (this.orientFilter === 'landscape') {
      list = list.filter(t => this.isTemplateLandscape(t));
    }

    if (hintEl) {
      if (!hasDedicatedMingle) {
        hintEl.innerHTML = 'Belum ada frame bertanda <strong>Khusus Mingle</strong> di Admin — menampilkan bingkai 1-foto yang ada. Tandai bingkai di menu <strong>Template Admin</strong> untuk memisahkannya.';
      } else if (this.showFallbackFrames) {
        hintEl.innerText = 'Menampilkan semua bingkai 1-pose event ini.';
      } else {
        hintEl.innerText = 'Tunjukkan layar ke tamu, ketuk 1 bingkai favoritnya, lalu langsung tekan shutter kamera.';
      }
    }

    if (toggleBtn) {
      toggleBtn.style.display = hasDedicatedMingle && this.allTemplates.length > this.templates.length ? '' : 'none';
      toggleBtn.innerText = this.showFallbackFrames ? '📸 Khusus Bingkai Mingle' : '🖼️ Tampilkan Semua Frame 1-Pose';
    }

    if (!list || list.length === 0) {
      const orientText = this.orientFilter === 'landscape' ? 'Lanskap' : (this.orientFilter === 'portrait' ? 'Potret' : '');
      grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:36px;">Belum ada template bingkai ${orientText} tersedia.</div>`;
      return;
    }

    grid.innerHTML = list.map((tpl) => {
      const isMingle = tpl.booth_mode === 'mingle' || tpl.booth_mode === 'both';
      const fmtLabel = this.getTemplateFormatLabel(tpl);
      const target = this.resolveTemplateShotsTarget(tpl);
      const shotBadge = target === 'unlimited' ? '♾️ Banyak Foto' : `📸 ${target}× Cekrek`;
      return `
        <div class="mingle-frame-card" onclick="mingle.selectFrame('${tpl.id}')">
          <div class="mingle-frame-thumb">
            <img src="${tpl.image_storage_key}" alt="${this.escapeHtml(tpl.name)}" onerror="this.src='/assets/templates/single-green-template.svg'">
          </div>
          <div style="display:flex; justify-content:center; gap:4px; flex-wrap:wrap;">
            <span class="sticker-badge sticker-mustard" style="font-size:10.5px; padding:3px 8px;">${fmtLabel}</span>
            <span class="sticker-badge ${isMingle ? 'sticker-teal' : 'sticker-coral'}" style="font-size:10.5px; padding:3px 8px;">
              ${shotBadge}
            </span>
          </div>
          <div style="font-size:14.5px; font-weight:800; color:var(--caramel-brown); line-height:1.25;">${this.escapeHtml(tpl.name)}</div>
        </div>
      `;
    }).join('');
  }

  resolveTemplateShotsTarget(tpl) {
    if (this.shotsOverride && this.shotsOverride !== 'auto') {
      if (this.shotsOverride === 'unlimited') return 'unlimited';
      const ov = parseInt(this.shotsOverride, 10);
      if (!isNaN(ov) && ov >= 1) return ov;
    }
    if (!tpl) return 'unlimited';
    const sm = String(tpl.shots_mode || '1').toLowerCase();
    if (sm === 'unlimited') return 'unlimited';
    if (sm === 'slots') {
      if (tpl.slots && tpl.slots.length > 0) {
        const poseNums = tpl.slots.map((s, idx) => Math.max(1, parseInt(s.pose_index, 10) || (idx + 1)));
        const uniquePoses = new Set(poseNums);
        const maxPoseIdx = Math.max(...poseNums);
        return Math.max(uniquePoses.size, maxPoseIdx);
      }
      return 1;
    }
    if (sm === 'event') {
      return this.eventShotsCount || 1;
    }
    const n = parseInt(sm, 10);
    return (!isNaN(n) && n >= 1) ? n : 1;
  }

  setShotsOverride(val) {
    const v = val || 'auto';
    if (this.currentScreen === 'screenMingleReady') {
      this.activeTargetShots = (v === 'unlimited') ? 'unlimited' : (parseInt(v, 10) || 1);
      this.updateReadyCaptureUI();
      if (this.activeTargetShots !== 'unlimited' && this.capturedPhotos.length >= this.activeTargetShots) {
        this.finishCaptureSession();
      }
      return;
    }
    this.shotsOverride = v;
    const selTop = document.getElementById('mingleSelectShotsOverride');
    if (selTop && selTop.value !== v) selTop.value = v;
    this.renderFramesGrid();
  }

  escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  showScreen(id) {
    document.querySelectorAll('.mingle-screen').forEach(el => {
      el.classList.toggle('active', el.id === id);
    });
    document.body.classList.toggle('mingle-on-welcome', id === 'screenMingleWelcome');
    this.currentScreen = id;
  }

  enterFrameSelection() {
    this.openSelectScreen();
  }

  resetSessionCaptureState() {
    this._activeSessionToken = (this._activeSessionToken || 0) + 1;
    this.capturedPhotos = [];
    this.syncedCaptureCount = 0;
    this.slotAssignments = [];
    this.slotTransforms = [];
    this.selectedSlotIdx = 0;
    this.selectedFileIdx = 0;
    this.rawPhotoDataUrl = null;
    this.cachedPhotoImg = null;
    this.cachedPhotoMap = {};
    this.activeFilter = 'normal';
    this.guestPass = null;
    this.sessionId = null;
    const qrHint = document.getElementById('mingleQrTapHint');
    if (qrHint) qrHint.style.display = 'none';
  }

  async startFilesOnlyMode() {
    this.filesOnlyMode = true;
    this.selectedTemplate = null;
    this.activeTargetShots = 'unlimited';
    this.resetSessionCaptureState();

    const thumb = document.getElementById('mingleSelectedThumb');
    const nameEl = document.getElementById('mingleSelectedName');
    const fmtBadge = document.getElementById('mingleSelectedFormatBadge');
    const readySel = document.getElementById('mingleReadyShotsSelect');
    if (thumb) thumb.src = '/assets/logo-mafaza.jpg';
    if (nameEl) nameEl.innerText = 'Mode Jual File · Banyak Foto';
    if (fmtBadge) fmtBadge.innerText = 'Original HD · Tanpa Bingkai';
    if (readySel) readySel.value = 'unlimited';

    this.applyOrientationLayout(1800, 1200);
    this.updateReadyCaptureUI();
    this.showScreen('screenMingleReady');
    await this.armPhysicalCaptureBaseline();
    this.syncViewfinderForReadyScreen();
  }

  async selectFrame(templateId) {
    const found = [...this.templates, ...this.allTemplates].find(t => t.id === templateId);
    if (!found) return;

    this.filesOnlyMode = false;
    this.selectedTemplate = found;
    this.activeTargetShots = this.resolveTemplateShotsTarget(found);
    this.resetSessionCaptureState();

    const thumb = document.getElementById('mingleSelectedThumb');
    const nameEl = document.getElementById('mingleSelectedName');
    const fmtBadge = document.getElementById('mingleSelectedFormatBadge');
    const readySel = document.getElementById('mingleReadyShotsSelect');
    if (thumb) thumb.src = found.image_storage_key || '/assets/templates/single-green-template.svg';
    if (nameEl) nameEl.innerText = found.name || 'Bingkai Mingle';
    if (fmtBadge) fmtBadge.innerText = this.getTemplateFormatLabel(found);
    if (readySel) readySel.value = String(this.activeTargetShots);

    const w = parseInt(found.width, 10) || (this.isTemplateLandscape(found) ? 1800 : 1200);
    const h = parseInt(found.height, 10) || (this.isTemplateLandscape(found) ? 1200 : 1800);
    this.applyOrientationLayout(w, h);

    this.updateReadyCaptureUI();
    this.showScreen('screenMingleReady');
    await this.armPhysicalCaptureBaseline();
    this.syncViewfinderForReadyScreen();
  }

  updateReadyCaptureUI() {
    const count = this.capturedPhotos.length;
    const pill = document.getElementById('mingleShotsProgressPill');
    const finishBtn = document.getElementById('btnMingleFinishSession');
    const stripWrap = document.getElementById('mingleReadyStripWrap');
    const strip = document.getElementById('mingleCapturedStrip');
    const stripLbl = document.getElementById('mingleStripCountLabel');

    if (pill) {
      pill.innerText = this.activeTargetShots === 'unlimited'
        ? `♾️ ${count} Foto Tersimpan`
        : `📸 ${count} / ${this.activeTargetShots} Foto`;
    }
    if (finishBtn) {
      finishBtn.style.display = count >= 1 ? 'block' : 'none';
      finishBtn.innerText = `✅ Selesai Foto (${count}) & Buat QR Galeri ➔`;
    }
    if (stripWrap) {
      stripWrap.style.display = count >= 1 ? 'block' : 'none';
    }
    if (stripLbl) {
      stripLbl.innerText = `🎞️ Foto Tersimpan: ${count}`;
    }
    if (strip) {
      strip.innerHTML = this.capturedPhotos.map((src, idx) => `
        <div class="mingle-thumb-item">
          <img src="${src}" alt="Foto ${idx + 1}">
          <span class="mingle-thumb-badge">#${idx + 1}</span>
          <button type="button" class="mingle-thumb-del" onclick="mingle.deleteCapturedPhoto(${idx})" title="Hapus foto ini">✕</button>
        </div>
      `).join('');
    }
  }

  deleteCapturedPhoto(idx) {
    if (idx < 0 || idx >= this.capturedPhotos.length) return;
    this.capturedPhotos.splice(idx, 1);
    if (this.syncedCaptureCount > this.capturedPhotos.length) {
      this.syncedCaptureCount = this.capturedPhotos.length;
    }
    this.updateReadyCaptureUI();
  }

  openSelectScreen() {
    this._physicalReadyArmed = false;
    this.setUsbMingleListen(false);
    this.stopLiveViewLoop();
    this.stopWebcam();
    this.showScreen('screenMingleSelect');
  }

  appendBridgeCacheBuster(url) {
    if (!url || !/^https?:\/\//i.test(url)) return url;
    const cb = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return `${url}${url.includes('?') ? '&' : '?'}_cb=${cb}`;
  }

  async readUsbStatusNow(timeoutMs = 450) {
    let st = null;
    try {
      const res = await this.fetchWithTimeout('http://127.0.0.1:19898/status', { mode: 'cors', cache: 'no-store' }, timeoutMs);
      if (res.ok) st = await res.json();
    } catch (e) {}

    if (!st && window.MafazaAndroidBridge && typeof window.MafazaAndroidBridge.getCameraStatus === 'function') {
      try { st = JSON.parse(window.MafazaAndroidBridge.getCameraStatus()); } catch (e) {}
    }
    if (st) this.usbStatus = st;
    return st;
  }

  async armPhysicalCaptureBaseline() {
    this._physicalReadyArmed = false;
    await this.setUsbMingleListen(true);
    const st = await this.readUsbStatusNow(450);
    const latestSeq = Math.max(
      Number(this.baselinePhysicalSeq || 0),
      Number(this._lastAcceptedPhysicalSeq || 0),
      Number((st && st.physicalCaptureSeq) || 0),
      Number((this.usbStatus && this.usbStatus.physicalCaptureSeq) || 0)
    );
    this.baselinePhysicalSeq = latestSeq;
    this._lastAcceptedPhysicalSeq = latestSeq;
    this._physicalReadyArmed = true;
  }

  async setUsbMingleListen(enabled) {
    try {
      const lvParam = this.canonLiveViewInMingle ? '&mingle_lv=1' : '&mingle_lv=0';
      await this.fetchWithTimeout(`http://127.0.0.1:19898/control?mingle=${enabled ? '1' : '0'}${lvParam}&_t=${Date.now()}`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store'
      }, 500);
    } catch (e) {}
  }

  applyTopLiveLayout() {
    document.body.classList.toggle('mingle-top-live', Boolean(this.isTopLiveLayout));
    const btn = document.getElementById('btnMingleTopLiveToggle');
    if (btn) {
      btn.classList.toggle('btn-coral', Boolean(this.isTopLiveLayout));
      btn.classList.toggle('btn-secondary', !this.isTopLiveLayout);
      btn.innerText = this.isTopLiveLayout ? '🖥️ Live Besar ON' : '🖥️ Live Besar';
    }
    requestAnimationFrame(() => this.applyMingleVideoTransform());
  }

  toggleTopLiveLayout() {
    this.isTopLiveLayout = !this.isTopLiveLayout;
    try {
      localStorage.setItem('pb_mingle_top_live', this.isTopLiveLayout ? 'true' : 'false');
    } catch (e) {}
    this.applyTopLiveLayout();
  }

  setCameraRotation(deg) {
    const val = ((parseInt(deg, 10) || 0) % 360 + 360) % 360;
    const clean = [0, 90, 180, 270].includes(val) ? val : 0;
    this.cameraRotation = clean;
    try {
      localStorage.setItem('pb_camera_rotation', String(clean));
    } catch (e) {}
    this.updateCameraRotationUI();
    this.applyMingleVideoTransform();
    this.showToast(`🔁 Rotasi Kamera Mingle: ${clean}°`, '📷', 1600);
  }

  cycleCameraRotation() {
    const order = [0, 90, 270, 180];
    const idx = order.indexOf(this.cameraRotation || 0);
    const next = order[(idx + 1) % order.length];
    this.setCameraRotation(next);
  }

  updateCameraRotationUI() {
    const cur = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    const btn = document.getElementById('btnMingleRotate');
    if (btn) {
      btn.innerText = `🔁 Putar: ${cur}°`;
      btn.classList.toggle('btn-coral', cur !== 0);
      btn.classList.toggle('btn-secondary', cur === 0);
    }
  }

  applyMingleVideoTransform() {
    const video = document.getElementById('mingleVideoFeed');
    const vf = document.getElementById('mingleViewfinder');
    if (!video) return;
    const rot = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    let rotScale = 1.0;
    if ((rot === 90 || rot === 270) && vf && vf.clientWidth > 0 && vf.clientHeight > 0) {
      const W = vf.clientWidth;
      const H = vf.clientHeight;
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      const s0 = Math.min(W / vw, H / vh);
      const pw = vw * s0;
      const ph = vh * s0;
      if (ph > 0 && pw > 0) rotScale = Math.max(W / ph, H / pw);
    }
    video.style.objectFit = (rot === 90 || rot === 270) ? 'contain' : 'cover';
    video.style.transform = rot ? `rotate(${rot}deg) scale(${rotScale.toFixed(3)})` : '';
  }

  async rotateDataUrlIfNeeded(dataUrl, checkPortraitExifGuard = true) {
    const rot = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    if (!rot || !dataUrl) return dataUrl;
    const img = new Image();
    img.src = dataUrl;
    await new Promise(res => { img.onload = res; img.onerror = res; });
    if (!img.naturalWidth || !img.naturalHeight) return dataUrl;
    if (checkPortraitExifGuard && (rot === 90 || rot === 270) && img.naturalHeight > img.naturalWidth) {
      return dataUrl;
    }
    const swap = (rot === 90 || rot === 270);
    const c = document.createElement('canvas');
    c.width = swap ? img.naturalHeight : img.naturalWidth;
    c.height = swap ? img.naturalWidth : img.naturalHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return c.toDataURL('image/jpeg', 0.92);
  }

  async toggleCanonLiveView() {
    this.canonLiveViewInMingle = !this.canonLiveViewInMingle;
    await this.setUsbMingleListen(true);
    this.syncViewfinderForReadyScreen();
    this.showToast(
      this.canonLiveViewInMingle
        ? 'Live View Canon aktif di tablet (untuk flash hotshoe pakai mode OVF).'
        : 'Mode Viewfinder Optik Canon aktif — flash hotshoe siap!',
      '📷',
      2600
    );
  }

  startStatusPolling() {
    if (this.statusTimerId) clearInterval(this.statusTimerId);
    const poll = async () => {
      let st = null;
      try {
        const res = await fetch('http://127.0.0.1:19898/status', { mode: 'cors', cache: 'no-store' });
        if (res.ok) st = await res.json();
      } catch (e) {}

      if (!st && window.MafazaAndroidBridge && typeof window.MafazaAndroidBridge.getCameraStatus === 'function') {
        try { st = JSON.parse(window.MafazaAndroidBridge.getCameraStatus()); } catch (e) {}
      }

      this.usbStatus = st;
      this.updateCameraStatusUI(st);

      if (st && typeof st.physicalCaptureSeq === 'number') {
        if (this.currentScreen !== 'screenMingleReady' || !this._physicalReadyArmed) {
          // Always sync baseline while not armed on Ready screen so older/pre-session camera shots are ignored
          if (st.physicalCaptureSeq > this.baselinePhysicalSeq) {
            this.baselinePhysicalSeq = st.physicalCaptureSeq;
          }
          if (st.physicalCaptureSeq > (this._lastAcceptedPhysicalSeq || 0)) {
            this._lastAcceptedPhysicalSeq = st.physicalCaptureSeq;
          }
        } else {
          const minSeq = Math.max(this.baselinePhysicalSeq || 0, this._lastAcceptedPhysicalSeq || 0);
          if (!this.isProcessingCapture && st.physicalCaptureSeq > minSeq) {
            this.baselinePhysicalSeq = st.physicalCaptureSeq;
            this._lastAcceptedPhysicalSeq = st.physicalCaptureSeq;
            const photoUrl = st.physicalPhotoUrl || `http://127.0.0.1:19898/physical_capture.jpg?seq=${st.physicalCaptureSeq}`;
            this.handleIncomingPhysicalPhoto(photoUrl);
          }
        }
      }
    };

    poll();
    this.statusTimerId = setInterval(poll, 320);
  }

  updateCameraStatusUI(st) {
    const pill = document.getElementById('mingleCamStatusPill');
    const welcomePill = document.getElementById('mingleWelcomeCamPill');
    const readyLbl = document.getElementById('mingleReadyCamLabel');
    const toggleLvBtn = document.getElementById('btnToggleCanonLv');
    const waitDesc = document.getElementById('mingleWaitDesc');
    if (!pill && !welcomePill) return;

    if (st && st.active) {
      const driver = String(st.driverType || '').toLowerCase();
      const label = st.camera || (driver === 'sony' ? 'Sony USB' : driver === 'canon' ? 'Canon EOS' : 'Kamera USB');
      if (pill) {
        pill.className = 'mingle-status-pill';
        pill.innerText = `🟢 ${label} · Shutter Siap`;
      }
      if (welcomePill) {
        welcomePill.className = 'mingle-status-pill';
        welcomePill.innerText = `🟢 ${label} · Siap`;
      }
      if (readyLbl) readyLbl.innerText = `🟢 ${label} Terhubung (Tekan Shutter Kamera)`;
      if (toggleLvBtn) {
        toggleLvBtn.style.display = driver === 'canon' ? '' : 'none';
        toggleLvBtn.innerText = this.canonLiveViewInMingle ? '📺 Live View ON (Klik utk OVF)' : '👁️ Mode OVF (Klik utk Live View)';
      }
      if (waitDesc) {
        waitDesc.innerText = driver === 'canon' && !this.canonLiveViewInMingle
          ? 'Bidik langsung lewat viewfinder Canon & tekan shutter fisik (Godox flash aktif).'
          : 'Live View aktif di layar agar tamu ikut melihat — jepret via kamera atau tombol layar.';
      }
    } else {
      const offlineText = st && st.usbAttached ? '⏳ Menghubungkan USB...' : '📱 Mode Kamera Tablet (atau Colok USB)';
      if (pill) {
        pill.className = 'mingle-status-pill offline';
        pill.innerText = offlineText;
      }
      if (welcomePill) {
        welcomePill.className = 'mingle-status-pill offline';
        welcomePill.innerText = st && st.usbAttached ? '⏳ USB...' : '📷 Kamera Tablet';
      }
      if (readyLbl) readyLbl.innerText = '📱 Kamera Bawaan / Menunggu USB DSLR';
      if (toggleLvBtn) toggleLvBtn.style.display = 'none';
      if (waitDesc) waitDesc.innerText = 'Colok kamera Sony / Canon lewat USB OTG, atau jepret dengan kamera tablet.';
    }

    if (this.currentScreen === 'screenMingleReady') {
      this.syncViewfinderForReadyScreen();
    }
  }

  syncViewfinderForReadyScreen() {
    const st = this.usbStatus;
    const canvas = document.getElementById('mingleLiveCanvas');
    const video = document.getElementById('mingleVideoFeed');
    const ovf = document.getElementById('mingleOvfPrompt');
    const heading = document.getElementById('minglePromptHeading');
    const desc = document.getElementById('minglePromptDesc');

    if (st && st.active) {
      this.stopWebcam();
      if (video) video.style.display = 'none';
      const isCanonOvf = st.driverType === 'canon' && !this.canonLiveViewInMingle;
      const hasBridgeLv = Boolean(window.MafazaAndroidBridge && typeof window.MafazaAndroidBridge.getLiveViewFrame === 'function' && st.hasFrame);
      if (isCanonOvf || (!st.hasFrame && !hasBridgeLv)) {
        this.stopLiveViewLoop();
        if (canvas) canvas.style.display = 'none';
        if (ovf) ovf.style.display = 'block';
        if (heading) {
          heading.innerText = isCanonOvf
            ? 'Mode Viewfinder Optik Canon Siap!'
            : (this.canonLiveViewInMingle ? 'Menyiapkan Live View Kamera...' : 'Kamera Terhubung · Tekan Shutter!');
        }
        if (desc) {
          desc.innerText = isCanonOvf
            ? 'Bidik langsung lewat jendela bidik Canon EOS agar flash hotshoe menyala, lalu tekan tombol shutter.'
            : 'Menunggu gambar Live View dari kamera... Anda tetap bisa langsung menekan shutter.';
        }
      } else {
        if (ovf) ovf.style.display = 'none';
        if (canvas) canvas.style.display = 'block';
        this.startLiveViewLoop();
      }
      return;
    }

    this.stopLiveViewLoop();
    if (canvas) canvas.style.display = 'none';
    if (st && st.usbAttached) {
      this.stopWebcam();
      if (video) video.style.display = 'none';
      if (ovf) ovf.style.display = 'block';
      if (heading) heading.innerText = 'Menghubungkan Kamera USB...';
      return;
    }

    // Fallback ke kamera bawaan tablet jika tidak ada kamera USB terhubung
    if (ovf) ovf.style.display = 'none';
    if (video) video.style.display = 'block';
    this.startWebcam();
  }

  startLiveViewLoop() {
    if (this.liveViewTimerId) return;
    const canvas = document.getElementById('mingleLiveCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) return;

    let busy = false;
    this.liveViewTimerId = setInterval(() => {
      if (busy || this.currentScreen !== 'screenMingleReady' || this.isProcessingCapture) return;
      if (!this.usbStatus || !this.usbStatus.active || !this.usbStatus.hasFrame) return;
      busy = true;
      let frameSrc = '';
      if (window.MafazaAndroidBridge && typeof window.MafazaAndroidBridge.getLiveViewFrame === 'function') {
        try {
          frameSrc = window.MafazaAndroidBridge.getLiveViewFrame() || '';
        } catch (e) {}
      }
      if (!frameSrc) {
        frameSrc = `http://127.0.0.1:19898/frame.jpg?t=${Date.now()}`;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const rot = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
        const swap = (rot === 90 || rot === 270);
        const targetW = swap ? img.naturalHeight : img.naturalWidth;
        const targetH = swap ? img.naturalWidth : img.naturalHeight;
        if (canvas.width !== targetW) canvas.width = targetW;
        if (canvas.height !== targetH) canvas.height = targetH;
        if (rot === 0) {
          ctx.drawImage(img, 0, 0);
        } else {
          ctx.save();
          ctx.clearRect(0, 0, targetW, targetH);
          ctx.translate(targetW / 2, targetH / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
          ctx.restore();
        }
        busy = false;
      };
      img.onerror = () => { busy = false; };
      img.src = frameSrc;
    }, 75);
  }

  stopLiveViewLoop() {
    if (this.liveViewTimerId) {
      clearInterval(this.liveViewTimerId);
      this.liveViewTimerId = null;
    }
  }

  async startWebcam() {
    if (this.webcamStream) return;
    const video = document.getElementById('mingleVideoFeed');
    if (!video || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      this.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      video.srcObject = this.webcamStream;
      await video.play().catch(() => {});
      this.applyMingleVideoTransform();
    } catch (e) {
      console.warn('Mingle built-in camera fallback unavailable:', e);
    }
  }

  stopWebcam() {
    if (this.webcamStream) {
      try { this.webcamStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      this.webcamStream = null;
    }
    const video = document.getElementById('mingleVideoFeed');
    if (video) video.srcObject = null;
  }

  async triggerBackupCapture() {
    if (this.isProcessingCapture) return;
    if (this.usbStatus && this.usbStatus.active) {
      this.isProcessingCapture = true;
      this.setProcessingOverlay(true, 'Menekan shutter kamera USB...');
      try {
        const res = await fetch('http://127.0.0.1:19898/capture', { method: 'POST', mode: 'cors', cache: 'no-store' });
        const data = await res.json();
        if (data && data.ok && data.imageUrl && !/\/frame\.jpg/i.test(data.imageUrl)) {
          await this.handleIncomingPhysicalPhoto(data.imageUrl, { fromCaptureLock: true });
          return;
        }
        this.isProcessingCapture = false;
        this.setProcessingOverlay(false);
        this.showToast((data && data.error) || 'Gagal memotret dari kamera USB.', '⚠️', 3500);
      } catch (e) {
        this.isProcessingCapture = false;
        this.setProcessingOverlay(false);
        this.showToast('Koneksi bridge USB terganggu.', '⚠️', 3200);
      }
      return;
    }

    const video = document.getElementById('mingleVideoFeed');
    if (!video || !video.videoWidth) {
      this.showToast('Kamera belum siap. Periksa izin kamera atau sambungkan Sony/Canon USB.', '⚠️', 3200);
      return;
    }
    this.playShutterSound();
    this.setProcessingOverlay(true, 'Mengambil foto & memasang bingkai...');
    const rot = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    const swap = (rot === 90 || rot === 270);
    const c = document.createElement('canvas');
    c.width = swap ? video.videoHeight : video.videoWidth;
    c.height = swap ? video.videoWidth : video.videoHeight;
    const vCtx = c.getContext('2d');
    if (rot === 0) {
      vCtx.drawImage(video, 0, 0, c.width, c.height);
    } else {
      vCtx.translate(c.width / 2, c.height / 2);
      vCtx.rotate((rot * Math.PI) / 180);
      vCtx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2, video.videoWidth, video.videoHeight);
    }
    await this.finalizeCapturedDataUrl(c.toDataURL('image/jpeg', 0.92));
  }

  async handleIncomingPhysicalPhoto(url, opts = {}) {
    if (!opts.fromCaptureLock && this.isProcessingCapture) return;
    if (!url || /\/frame\.jpg/i.test(url)) {
      this.isProcessingCapture = false;
      this.setProcessingOverlay(false);
      this.showToast('Foto kamera belum siap (masih frame preview). Silakan jepret ulang.', '⚠️', 3200);
      return;
    }
    this.isProcessingCapture = true;
    this.playShutterSound();
    this.stopLiveViewLoop();
    const isMulti = (this.activeTargetShots === 'unlimited' || Number(this.activeTargetShots) > 1);
    this.setProcessingOverlay(true, isMulti ? `Mengunduh foto #${this.capturedPhotos.length + 1} dari kamera...` : 'Mengunduh foto kamera beresolusi penuh...');

    try {
      const fetchUrl = this.appendBridgeCacheBuster(url);
      const res = await fetch(fetchUrl, { mode: 'cors', cache: 'no-store' });
      if (!res.ok) throw new Error('Foto dari kamera tidak ditemukan.');
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Gagal membaca data JPEG.'));
        reader.readAsDataURL(blob);
      });
      const rotatedUrl = await this.rotateDataUrlIfNeeded(dataUrl, true);
      await this.finalizeCapturedDataUrl(rotatedUrl);
    } catch (e) {
      console.error('Physical shutter load error:', e);
      this.setProcessingOverlay(false);
      this.isProcessingCapture = false;
      this.syncViewfinderForReadyScreen();
      this.showToast(e.message || 'Gagal memuat foto dari kamera.', '⚠️', 3500);
    }
  }

  async finalizeCapturedDataUrl(dataUrl) {
    try {
      this.capturedPhotos.push(dataUrl);
      this.rawPhotoDataUrl = this.capturedPhotos[0] || dataUrl;
      this.cachedPhotoImg = null;
      this.updateReadyCaptureUI();

      const count = this.capturedPhotos.length;
      const target = this.activeTargetShots;
      const reachedTarget = (target !== 'unlimited' && count >= Number(target));

      if (reachedTarget) {
        await this.finishCaptureSession();
      } else {
        this.setProcessingOverlay(false);
        this.syncViewfinderForReadyScreen();
        this.showToast(
          target === 'unlimited'
            ? `📸 Foto #${count} tersimpan! Terus jepret atau ketuk Selesai.`
            : `📸 Foto ${count}/${target} tersimpan! Tekan shutter untuk pose berikutnya.`,
          '✅',
          2200
        );
      }
    } finally {
      this.isProcessingCapture = false;
    }
  }

  async finishCaptureSession() {
    if (this.capturedPhotos.length === 0) {
      this.showToast('Belum ada foto yang diambil.', '⚠️', 2000);
      return;
    }

    this._physicalReadyArmed = false;
    this.setProcessingOverlay(true, this.filesOnlyMode ? 'Menyiapkan galeri file HD & QR...' : 'Memasang bingkai & membuat QR...');
    try {
      await this.setUsbMingleListen(false);
      this.stopLiveViewLoop();
      this.stopWebcam();

      const canvasStage = document.getElementById('mingleCanvasStage');
      const filterRow = document.getElementById('mingleFilterRow');
      const slotBar = document.getElementById('mingleResultSlotBar');
      const filesBox = document.getElementById('mingleFilesPreviewBox');
      const printBtn = document.getElementById('btnMinglePrint');
      const resTitle = document.getElementById('mingleResultTitle');
      const resHint = document.getElementById('mingleResultHint');
      const resultGrid = document.getElementById('mingleResultGrid');

      const slotZoomBar = document.getElementById('mingleSlotZoomBar');
      const slotBadge = document.getElementById('mingleActiveSlotBadge');
      if (this.filesOnlyMode) {
        if (canvasStage) canvasStage.style.display = 'none';
        if (slotZoomBar) slotZoomBar.style.display = 'none';
        if (slotBadge) slotBadge.style.display = 'none';
        if (filterRow) filterRow.style.display = 'none';
        if (slotBar) slotBar.style.display = 'none';
        if (filesBox) filesBox.style.display = 'flex';
        if (printBtn) printBtn.style.display = 'none';
        if (resultGrid) resultGrid.classList.remove('is-landscape');
        if (resTitle) resTitle.innerText = `📁 ${this.capturedPhotos.length} File Foto HD Siap Diunduh`;
        if (resHint) resHint.innerText = 'Semua foto masuk ke 1 QR Code';
        this.selectedFileIdx = this.capturedPhotos.length - 1;
        this.renderFilesPreview();
      } else {
        if (filesBox) filesBox.style.display = 'none';
        if (canvasStage) canvasStage.style.display = 'flex';
        if (slotZoomBar) slotZoomBar.style.display = 'inline-flex';
        if (slotBadge) slotBadge.style.display = '';
        if (filterRow) filterRow.style.display = 'flex';
        if (printBtn) printBtn.style.display = '';
        if (resTitle) resTitle.innerText = '✨ Hasil Foto Tamu';
        if (resHint) resHint.innerText = 'Geser foto untuk atur posisi';

        try {
          if (navigator.onLine !== false) {
            await Promise.race([this.fetchTemplates(), new Promise(r => setTimeout(r, 1200))]);
          }
        } catch (e) {}
        await this.loadAndKeySelectedTemplate();
        const slotsArr = this.activeSlots || [];
        const slotsCount = slotsArr.length || 1;
        if (!this.slotAssignments || this.slotAssignments.length !== slotsCount) {
          this.slotAssignments = Array.from({ length: slotsCount }, (_, i) => {
            const pIdx = (slotsArr[i] && parseInt(slotsArr[i].pose_index, 10)) ? (parseInt(slotsArr[i].pose_index, 10) - 1) : i;
            return pIdx % this.capturedPhotos.length;
          });
        } else {
          this.slotAssignments = this.slotAssignments.map(idx => idx % this.capturedPhotos.length);
        }
        this.slotTransforms = Array.from({ length: slotsCount }, () => ({ panX: 0, panY: 0, zoom: 1.0 }));
        this.selectedSlotIdx = 0;
        await this.renderResultCanvas();
        this.renderResultSlotBar();
        this.updateSlotZoomBadge();
      }

      this.showScreen('screenMingleResult');
      this.setProcessingOverlay(false);

      await this.issuePassCreateAndSync();
    } catch (e) {
      console.error('finishCaptureSession error:', e);
      this.setProcessingOverlay(false);
    }
  }

  setProcessingOverlay(visible, subtitle = '') {
    const el = document.getElementById('mingleProcessingOverlay');
    const sub = document.getElementById('mingleProcessingSub');
    if (sub && subtitle) sub.innerText = subtitle;
    if (el) el.style.display = visible ? 'flex' : 'none';
  }

  async loadAndKeySelectedTemplate() {
    if (!this.selectedTemplate) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = this.selectedTemplate.image_storage_key;
    await new Promise(res => { img.onload = res; img.onerror = res; });

    const tplW = img.naturalWidth || this.selectedTemplate.width || 1200;
    const tplH = img.naturalHeight || this.selectedTemplate.height || 1800;
    const canvas = document.getElementById('mingleFinalCanvas');
    if (canvas) {
      canvas.width = tplW;
      canvas.height = tplH;
    }
    this.applyOrientationLayout(tplW, tplH);

    const dbW = this.selectedTemplate.width || tplW;
    const dbH = this.selectedTemplate.height || tplH;
    const rawSlots = Array.isArray(this.selectedTemplate.slots) ? this.selectedTemplate.slots : [];
    const isSvgTpl = String(this.selectedTemplate.image_storage_key || '').toLowerCase().includes('.svg');
    const fitsNatural = rawSlots.length > 0 && rawSlots.every(s =>
      (Number(s.x) || 0) >= -4 &&
      (Number(s.y) || 0) >= -4 &&
      ((Number(s.x) || 0) + (Number(s.width) || 0)) <= tplW + 4 &&
      ((Number(s.y) || 0) + (Number(s.height) || 0)) <= tplH + 4
    );
    const shouldScale = (dbW > 0 && dbH > 0) && (dbW !== tplW || dbH !== tplH) && (isSvgTpl || !fitsNatural);
    const sx = shouldScale ? (tplW / dbW) : 1;
    const sy = shouldScale ? (tplH / dbH) : 1;

    let slots = rawSlots.length > 0
      ? rawSlots.map(s => ({
          ...s,
          x: Math.round(s.x * sx),
          y: Math.round(s.y * sy),
          width: Math.round(s.width * sx),
          height: Math.round(s.height * sy)
        }))
      : [{ id: 'slot_1', pose_index: 1, x: Math.round(tplW * 0.06), y: Math.round(tplH * 0.06), width: Math.round(tplW * 0.88), height: Math.round(tplH * 0.78) }];

    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = tplW;
    frameCanvas.height = tplH;
    const fCtx = frameCanvas.getContext('2d');
    fCtx.drawImage(img, 0, 0, tplW, tplH);

    const useChromaKey = Boolean(this.selectedTemplate && (
      this.selectedTemplate.chroma_key === true ||
      this.selectedTemplate.chroma_key === 1 ||
      /^\/assets\/templates\/.*\.svg$/i.test(this.selectedTemplate.image_storage_key || '')
    ));

    try {
      const imgData = fCtx.getImageData(0, 0, tplW, tplH);
      const data = imgData.data;
      const isGreen = (r, g, b, a) => {
        if (a < 50) return false;
        if (g >= 150 && r <= 100 && b <= 100) return true;
        if (g >= 135 && (g - r) >= 28 && (g - b) >= 32) return true;
        return g >= 115 && (g - r) >= 35 && (g - b) >= 35;
      };

      // Guard for single-slot templates whose stored slot didn't cover the actual green rectangle (only when Chroma Key is enabled)
      if (useChromaKey && slots.length === 1) {
        let minGX = tplW, maxGX = -1, minGY = tplH, maxGY = -1, greenCount = 0;
        const step = 6;
        for (let y = 0; y < tplH; y += step) {
          for (let x = 0; x < tplW; x += step) {
            const i = (y * tplW + x) * 4;
            if (isGreen(data[i], data[i + 1], data[i + 2], data[i + 3])) {
              greenCount++;
              if (x < minGX) minGX = x;
              if (x > maxGX) maxGX = x;
              if (y < minGY) minGY = y;
              if (y > maxGY) maxGY = y;
            }
          }
        }
        if (greenCount > 30 && maxGX > minGX + 60 && maxGY > minGY + 60) {
          const gW = (maxGX - minGX) + step;
          const gH = (maxGY - minGY) + step;
          if (!this.selectedTemplate.slots || this.selectedTemplate.slots.length === 0 ||
              gW > slots[0].width * 1.15 || gH > slots[0].height * 1.15) {
            slots = [{ id: slots[0].id || 'slot_1', pose_index: 1, x: minGX, y: minGY, width: gW, height: gH }];
          }
        }
      }

      const pad = 2;
      for (const slot of slots) {
        const sx0 = Math.max(0, Math.floor(slot.x));
        const ex0 = Math.min(tplW, Math.ceil(slot.x + slot.width));
        const sy0 = Math.max(0, Math.floor(slot.y));
        const ey0 = Math.min(tplH, Math.ceil(slot.y + slot.height));

        let sampled = 0, transCount = 0, greenCount = 0;
        for (let y = sy0; y < ey0; y += 4) {
          for (let x = sx0; x < ex0; x += 4) {
            const idx = (y * tplW + x) * 4;
            sampled++;
            if (data[idx + 3] < 50) transCount++;
            else if (useChromaKey && isGreen(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) greenCount++;
          }
        }

        if (useChromaKey) {
          const startX = Math.max(0, Math.floor(slot.x - pad));
          const endX = Math.min(tplW, Math.ceil(slot.x + slot.width + pad));
          const startY = Math.max(0, Math.floor(slot.y - pad));
          const endY = Math.min(tplH, Math.ceil(slot.y + slot.height + pad));
          for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
              const i = (y * tplW + x) * 4;
              if (isGreen(data[i], data[i + 1], data[i + 2], data[i + 3])) {
                data[i + 3] = 0;
              }
            }
          }
        }

        // Jika slot template tidak transparan & tidak memakai chroma key hijau (mis. ekspor Canva berlubang putih solid #FFFFFF),
        // lubangi isi warna datar di dalam area slot tanpa menyentuh dekorasi tepi.
        if (sampled > 0 && (transCount / sampled) < 0.05 && (!useChromaKey || (greenCount / sampled) < 0.05)) {
          const cx = Math.min(tplW - 1, Math.max(0, Math.floor(slot.x + slot.width / 2)));
          const cy = Math.min(tplH - 1, Math.max(0, Math.floor(slot.y + slot.height / 2)));
          const cIdx = (cy * tplW + cx) * 4;
          const bgR = data[cIdx], bgG = data[cIdx + 1], bgB = data[cIdx + 2];
          let matchCount = 0;
          for (let y = sy0; y < ey0; y += 4) {
            for (let x = sx0; x < ex0; x += 4) {
              const idx = (y * tplW + x) * 4;
              const diff = Math.abs(data[idx] - bgR) + Math.abs(data[idx + 1] - bgG) + Math.abs(data[idx + 2] - bgB);
              if (diff <= 45) matchCount++;
            }
          }
          if ((matchCount / sampled) >= 0.35) {
            for (let y = sy0; y < ey0; y++) {
              for (let x = sx0; x < ex0; x++) {
                const idx = (y * tplW + x) * 4;
                const diff = Math.abs(data[idx] - bgR) + Math.abs(data[idx + 1] - bgG) + Math.abs(data[idx + 2] - bgB);
                if (diff <= 45) {
                  data[idx + 3] = 0;
                } else if (diff <= 68) {
                  data[idx + 3] = Math.round(data[idx + 3] * ((diff - 45) / 23));
                }
              }
            }
          }
        }
      }
      fCtx.putImageData(imgData, 0, 0);
    } catch (e) {}

    this.cachedKeyedFrame = frameCanvas;
    this.activeSlots = slots;
    this.activeSlot = slots[0];
  }

  getFilterCss(key) {
    const map = {
      normal: 'none',
      glowing: 'brightness(107%) contrast(104%) saturate(108%)',
      korean: 'brightness(112%) contrast(96%) saturate(106%)',
      warm_retro: 'sepia(24%) contrast(108%) brightness(102%) saturate(112%)',
      vivid: 'contrast(114%) saturate(135%) brightness(102%)',
      bw: 'grayscale(100%) contrast(120%) brightness(104%)'
    };
    return map[key] || 'none';
  }

  async getCachedImage(src) {
    if (!src) return null;
    if (this.cachedPhotoMap[src]) return this.cachedPhotoMap[src];
    const pImg = new Image();
    pImg.src = src;
    await new Promise(res => { pImg.onload = res; pImg.onerror = res; });
    this.cachedPhotoMap[src] = pImg;
    return pImg;
  }

  getSlotTransform(idx) {
    if (!Array.isArray(this.slotTransforms)) this.slotTransforms = [];
    if (!this.slotTransforms[idx]) {
      this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };
    }
    return this.slotTransforms[idx];
  }

  updateSlotZoomBadge() {
    const idx = typeof this.selectedSlotIdx === 'number' ? this.selectedSlotIdx : 0;
    const tr = this.getSlotTransform(idx);
    const z = Math.max(0.35, Math.min(3.5, tr.zoom || 1.0));
    const zoomLbl = document.getElementById('mingleSlotZoomLabel');
    if (zoomLbl) zoomLbl.innerText = `🔍 ${z.toFixed(1)}x`;
    const slotBadge = document.getElementById('mingleActiveSlotBadge');
    if (slotBadge) slotBadge.innerText = `Slot #${idx + 1} Aktif`;
  }

  getSlotPoseIndex(slotIdx) {
    const slots = (this.activeSlots && Array.isArray(this.activeSlots)) ? this.activeSlots : [];
    const slot = slots[slotIdx];
    return slot ? (parseInt(slot.pose_index, 10) || (slotIdx + 1)) : (slotIdx + 1);
  }

  getSyncedSlotIndices(slotIdx) {
    const slots = (this.activeSlots && Array.isArray(this.activeSlots)) ? this.activeSlots : [];
    if (slots.length === 0 || slotIdx < 0 || slotIdx >= slots.length) return [slotIdx];
    const targetPose = this.getSlotPoseIndex(slotIdx);
    const matches = [];
    for (let i = 0; i < slots.length; i++) {
      if (this.getSlotPoseIndex(i) === targetPose) matches.push(i);
    }
    return matches.length > 0 ? matches : [slotIdx];
  }

  syncDuplicateSlotTransforms(sourceIdx) {
    if (!Array.isArray(this.slotTransforms) || !this.slotTransforms[sourceIdx]) return;
    const src = this.slotTransforms[sourceIdx];
    this.getSyncedSlotIndices(sourceIdx).forEach((i) => {
      if (i === sourceIdx) return;
      this.slotTransforms[i] = { panX: src.panX || 0, panY: src.panY || 0, zoom: src.zoom || 1.0 };
    });
  }

  syncDuplicateSlotPhoto(sourceIdx, photoIdx) {
    if (!Array.isArray(this.slotAssignments)) return;
    this.getSyncedSlotIndices(sourceIdx).forEach((i) => {
      this.slotAssignments[i] = photoIdx;
    });
  }

  async adjustActiveSlotZoom(delta) {
    const idx = typeof this.selectedSlotIdx === 'number' ? this.selectedSlotIdx : 0;
    const tr = this.getSlotTransform(idx);
    tr.zoom = Math.max(0.35, Math.min(3.5, Number(((tr.zoom || 1.0) + delta).toFixed(2))));
    this.syncDuplicateSlotTransforms(idx);
    this.updateSlotZoomBadge();
    await this.renderResultCanvas();
    this.syncFinalImageOnly();
  }

  async renderResultCanvas() {
    const canvas = document.getElementById('mingleFinalCanvas');
    if (!canvas || !this.selectedTemplate) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const photos = this.capturedPhotos.length > 0
      ? this.capturedPhotos
      : (this.rawPhotoDataUrl ? [this.rawPhotoDataUrl] : []);

    if (photos.length > 0) {
      const slotsToRender = (this.activeSlots && this.activeSlots.length > 0)
        ? this.activeSlots
        : [this.activeSlot || { x: 60, y: 60, width: w - 120, height: h - 180 }];
      const filterStr = this.getFilterCss(this.activeFilter);

      for (let i = 0; i < slotsToRender.length; i++) {
        const slot = slotsToRender[i];
        const assignedIdx = (this.slotAssignments && this.slotAssignments[i] !== undefined)
          ? (this.slotAssignments[i] % photos.length)
          : (i % photos.length);
        const pImg = await this.getCachedImage(photos[assignedIdx]);
        if (!pImg) continue;

        const bleed = 4;
        const clipX = slot.x - bleed;
        const clipY = slot.y - bleed;
        const clipW = slot.width + bleed * 2;
        const clipH = slot.height + bleed * 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(clipX, clipY, clipW, clipH);
        ctx.clip();
        if (filterStr !== 'none') ctx.filter = filterStr;

        const tr = this.getSlotTransform(i);
        const zoom = Math.max(0.35, Math.min(3.5, tr.zoom || 1.0));
        const baseScale = Math.max(clipW / Math.max(1, pImg.width), clipH / Math.max(1, pImg.height));
        const drawW = pImg.width * baseScale * zoom;
        const drawH = pImg.height * baseScale * zoom;
        const maxPanX = Math.max(Math.abs(drawW - clipW) / 2, Math.round(clipW * 0.45));
        const maxPanY = Math.max(Math.abs(drawH - clipH) / 2, Math.round(clipH * 0.45));
        tr.panX = Math.max(-maxPanX, Math.min(maxPanX, tr.panX || 0));
        tr.panY = Math.max(-maxPanY, Math.min(maxPanY, tr.panY || 0));

        const drawX = (clipX + clipW / 2) - (drawW / 2) + tr.panX;
        const drawY = (clipY + clipH / 2) - (drawH / 2) + tr.panY;
        ctx.drawImage(pImg, drawX, drawY, drawW, drawH);
        ctx.restore();
      }
    }

    if (this.cachedKeyedFrame) {
      ctx.drawImage(this.cachedKeyedFrame, 0, 0, w, h);
    }
    this.updateSlotZoomBadge();
  }

  renderFilesPreview() {
    const heroImg = document.getElementById('mingleFilesHeroImg');
    const heading = document.getElementById('mingleFilesCountHeading');
    const grid = document.getElementById('mingleFilesThumbsGrid');
    const photos = this.capturedPhotos || [];
    if (heroImg && photos[this.selectedFileIdx]) {
      heroImg.src = photos[this.selectedFileIdx];
    }
    if (heading) {
      heading.innerText = `📁 ${photos.length} File Foto HD Siap Diunduh`;
    }
    if (grid) {
      grid.innerHTML = photos.map((src, idx) => `
        <div class="mingle-thumb-item ${idx === this.selectedFileIdx ? 'active' : ''}" style="width: 100%; height: 74px;" onclick="mingle.selectFilePreview(${idx})">
          <img src="${src}" alt="File ${idx + 1}">
          <span class="mingle-thumb-badge">#${idx + 1}</span>
        </div>
      `).join('');
    }
  }

  selectFilePreview(idx) {
    this.selectedFileIdx = idx;
    this.renderFilesPreview();
  }

  renderResultSlotBar() {
    const bar = document.getElementById('mingleResultSlotBar');
    const tabsEl = document.getElementById('mingleResultSlotTabs');
    const pickerEl = document.getElementById('mingleResultPhotoPicker');
    if (!bar || !tabsEl || !pickerEl) return;

    const showBar = !this.filesOnlyMode && this.capturedPhotos.length > 1;
    bar.style.display = showBar ? 'flex' : 'none';
    if (!showBar) return;

    const slotsCount = (this.activeSlots && this.activeSlots.length) || 1;
    tabsEl.innerHTML = Array.from({ length: slotsCount }, (_, idx) => `
      <button type="button" class="mingle-filter-btn ${idx === this.selectedSlotIdx ? 'active' : ''}" onclick="mingle.selectResultSlot(${idx})">
        Slot #${idx + 1} (Foto #${(this.slotAssignments[idx] || 0) + 1})
      </button>
    `).join('');

    const activePhotoIdx = this.slotAssignments[this.selectedSlotIdx] || 0;
    pickerEl.innerHTML = this.capturedPhotos.map((src, pIdx) => `
      <div class="mingle-thumb-item ${pIdx === activePhotoIdx ? 'active' : ''}" onclick="mingle.assignPhotoToActiveSlot(${pIdx})">
        <img src="${src}" alt="Foto ${pIdx + 1}">
        <span class="mingle-thumb-badge">#${pIdx + 1}</span>
      </div>
    `).join('');
  }

  selectResultSlot(slotIdx) {
    this.selectedSlotIdx = slotIdx;
    this.updateSlotZoomBadge();
    this.renderResultSlotBar();
  }

  async assignPhotoToActiveSlot(photoIdx) {
    if (!this.slotAssignments) return;
    this.syncDuplicateSlotPhoto(this.selectedSlotIdx, photoIdx);
    this.renderResultSlotBar();
    await this.renderResultCanvas();
    await this.syncFinalImageOnly(false, false);
  }

  findResultSlotAt(canvasX, canvasY) {
    const slots = (this.activeSlots && this.activeSlots.length > 0)
      ? this.activeSlots
      : [this.activeSlot || { x: 0, y: 0, width: 1200, height: 1800 }];
    if (slots.length <= 1) return 0;
    const exact = slots.findIndex(s =>
      canvasX >= s.x && canvasX <= (s.x + s.width) &&
      canvasY >= s.y && canvasY <= (s.y + s.height)
    );
    if (exact !== -1) return exact;
    const pad = 28;
    const near = slots.findIndex(s =>
      canvasX >= (s.x - pad) && canvasX <= (s.x + s.width + pad) &&
      canvasY >= (s.y - pad) && canvasY <= (s.y + s.height + pad)
    );
    if (near !== -1) return near;
    return (typeof this.selectedSlotIdx === 'number' && this.selectedSlotIdx < slots.length) ? this.selectedSlotIdx : 0;
  }

  setupCanvasPanAndZoom() {
    const canvas = document.getElementById('mingleFinalCanvas');
    if (!canvas) return;
    canvas.style.touchAction = 'none';
    const activePointers = new Map();
    let dragging = false;
    let pinching = false;
    let lastX = 0;
    let lastY = 0;
    let pinchInitDist = 0;
    let pinchInitZoom = 1.0;
    let syncTimer = null;
    const scheduleSync = () => {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => this.syncFinalImageOnly(), 500);
    };
    const toCanvasCoords = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / Math.max(1, rect.width);
      const sy = canvas.height / Math.max(1, rect.height);
      return {
        x: (clientX - rect.left) * sx,
        y: (clientY - rect.top) * sy,
        sx,
        sy
      };
    };

    canvas.addEventListener('pointerdown', (e) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      const coords = toCanvasCoords(e.clientX, e.clientY);
      const hitIdx = this.findResultSlotAt(coords.x, coords.y);
      if (this.selectedSlotIdx !== hitIdx) {
        this.selectedSlotIdx = hitIdx;
        this.updateSlotZoomBadge();
        this.renderResultSlotBar();
      }
      const tr = this.getSlotTransform(hitIdx);

      if (activePointers.size === 1) {
        dragging = true;
        pinching = false;
        lastX = e.clientX;
        lastY = e.clientY;
      } else if (activePointers.size >= 2) {
        const pts = Array.from(activePointers.values());
        dragging = false;
        pinching = true;
        pinchInitDist = Math.max(15, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        pinchInitZoom = tr.zoom || 1.0;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const idx = typeof this.selectedSlotIdx === 'number' ? this.selectedSlotIdx : 0;
      const tr = this.getSlotTransform(idx);

      if (pinching && activePointers.size >= 2) {
        const pts = Array.from(activePointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        tr.zoom = Math.max(0.35, Math.min(3.5, pinchInitZoom * (dist / pinchInitDist)));
        this.syncDuplicateSlotTransforms(idx);
        this.updateSlotZoomBadge();
        this.renderResultCanvas();
      } else if (dragging && activePointers.size === 1) {
        const rect = canvas.getBoundingClientRect();
        const sx = canvas.width / Math.max(1, rect.width);
        const sy = canvas.height / Math.max(1, rect.height);
        tr.panX += (e.clientX - lastX) * sx;
        tr.panY += (e.clientY - lastY) * sy;
        lastX = e.clientX;
        lastY = e.clientY;
        this.syncDuplicateSlotTransforms(idx);
        this.renderResultCanvas();
      }
    });
    const endPointer = (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        if (dragging || pinching) {
          dragging = false;
          pinching = false;
          scheduleSync();
        }
      } else if (activePointers.size === 1) {
        const rem = Array.from(activePointers.values())[0];
        pinching = false;
        dragging = true;
        lastX = rem.x;
        lastY = rem.y;
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const coords = toCanvasCoords(e.clientX, e.clientY);
      const hitIdx = this.findResultSlotAt(coords.x, coords.y);
      if (this.selectedSlotIdx !== hitIdx) {
        this.selectedSlotIdx = hitIdx;
        this.renderResultSlotBar();
      }
      const tr = this.getSlotTransform(hitIdx);
      tr.zoom = Math.max(0.35, Math.min(3.5, (tr.zoom || 1.0) + (e.deltaY < 0 ? 0.08 : -0.08)));
      this.syncDuplicateSlotTransforms(hitIdx);
      this.updateSlotZoomBadge();
      this.renderResultCanvas();
      scheduleSync();
    }, { passive: false });
  }

  async openChangeFrameModal() {
    const modal = document.getElementById('mingleChangeFrameModal');
    const grid = document.getElementById('mingleChangeFrameGrid');
    if (!modal || !grid) return;
    modal.style.display = 'flex';
    await this.fetchTemplates();

    const list = (this.allTemplates && this.allTemplates.length > 0) ? this.allTemplates : (this.templates || []);
    const currentId = this.selectedTemplate ? this.selectedTemplate.id : null;
    grid.innerHTML = list.map((tpl) => {
      const isSelected = tpl.id === currentId;
      const fmtLabel = this.getTemplateFormatLabel(tpl);
      return `
        <div class="mingle-frame-card ${isSelected ? 'selected' : ''}" style="padding: 10px; ${isSelected ? 'border-color: var(--coral); background: rgba(230,120,107,0.06);' : ''}" onclick="mingle.applyFrameInResult('${tpl.id}')">
          <div class="mingle-frame-thumb" style="height: 150px;">
            <img src="${tpl.image_storage_key}" alt="${this.escapeHtml(tpl.name)}" onerror="this.src='/assets/templates/single-green-template.svg'">
          </div>
          <span class="sticker-badge ${isSelected ? 'sticker-coral' : 'sticker-mustard'}" style="font-size: 10.5px; padding: 3px 8px;">
            ${isSelected ? `✓ Dipakai (${fmtLabel})` : fmtLabel}
          </span>
          <div style="font-size: 13.5px; font-weight: 800; color: var(--caramel-brown); line-height: 1.25;">${this.escapeHtml(tpl.name)}</div>
        </div>
      `;
    }).join('');
  }

  closeChangeFrameModal(event) {
    if (event && event.target && event.target.closest('.photo-modal-card') && !event.target.classList.contains('photo-modal-close') && event.target.tagName !== 'BUTTON') {
      return;
    }
    const modal = document.getElementById('mingleChangeFrameModal');
    if (modal) modal.style.display = 'none';
  }

  async applyFrameInResult(templateId) {
    const list = (this.allTemplates && this.allTemplates.length > 0) ? this.allTemplates : (this.templates || []);
    const newTpl = list.find(t => t.id === templateId);
    if (!newTpl) return;

    this.closeChangeFrameModal();
    this.selectedTemplate = newTpl;
    this.filesOnlyMode = false;

    const thumb = document.getElementById('mingleSelectedThumb');
    const nameEl = document.getElementById('mingleSelectedName');
    const fmtBadge = document.getElementById('mingleSelectedFormatBadge');
    if (thumb) thumb.src = newTpl.image_storage_key;
    if (nameEl) nameEl.innerText = newTpl.name || 'Bingkai Mingle';
    if (fmtBadge) fmtBadge.innerText = this.getTemplateFormatLabel(newTpl);

    const filesBox = document.getElementById('mingleFilesPreviewBox');
    const canvasStage = document.getElementById('mingleCanvasStage');
    const slotZoomBar = document.getElementById('mingleSlotZoomBar');
    const slotBadge = document.getElementById('mingleActiveSlotBadge');
    const filterRow = document.getElementById('mingleFilterRow');
    const printBtn = document.getElementById('btnMinglePrint');
    if (filesBox) filesBox.style.display = 'none';
    if (canvasStage) canvasStage.style.display = 'flex';
    if (slotZoomBar) slotZoomBar.style.display = 'inline-flex';
    if (slotBadge) slotBadge.style.display = '';
    if (filterRow) filterRow.style.display = 'flex';
    if (printBtn) printBtn.style.display = '';

    await this.loadAndKeySelectedTemplate();
    const slotsArr = this.activeSlots || [];
    const slotsCount = slotsArr.length || 1;
    const photosCount = Math.max(1, this.capturedPhotos.length);
    this.slotAssignments = Array.from({ length: slotsCount }, (_, idx) => {
      const pIdx = (slotsArr[idx] && parseInt(slotsArr[idx].pose_index, 10)) ? (parseInt(slotsArr[idx].pose_index, 10) - 1) : idx;
      return pIdx % photosCount;
    });
    this.slotTransforms = Array.from({ length: slotsCount }, (_, idx) => (
      (this.slotTransforms && this.slotTransforms[idx]) ? { ...this.slotTransforms[idx] } : { panX: 0, panY: 0, zoom: 1.0 }
    ));
    this.selectedSlotIdx = 0;

    this.renderResultSlotBar();
    await this.renderResultCanvas();
    this.updateSlotZoomBadge();
    await this.syncFinalImageOnly(false, false);
    this.showToast(`✨ Frame diganti ke ${newTpl.name}!`, '🎨', 2400);
  }

  openQrZoomModal() {
    const qrImg = document.getElementById('mingleQrImg');
    const modal = document.getElementById('mingleQrZoomModal');
    const zoomImg = document.getElementById('mingleQrZoomImg');
    const zoomLink = document.getElementById('mingleQrZoomLink');
    const directLink = document.getElementById('mingleGalleryLink');
    if (!modal || !zoomImg || !qrImg || !qrImg.src || qrImg.style.display === 'none') return;
    zoomImg.src = qrImg.src;
    if (zoomLink) {
      if (directLink && directLink.href && directLink.href !== '#') {
        zoomLink.href = directLink.href;
        zoomLink.style.display = '';
      } else {
        zoomLink.style.display = 'none';
      }
    }
    modal.style.display = 'flex';
  }

  closeQrZoomModal(event) {
    if (event && event.target && event.target !== document.getElementById('mingleQrZoomModal') && event.target.tagName !== 'BUTTON') {
      return;
    }
    const modal = document.getElementById('mingleQrZoomModal');
    if (modal) modal.style.display = 'none';
  }

  async setFilter(filterKey) {
    this.activeFilter = filterKey || 'normal';
    document.querySelectorAll('.mingle-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-filter') === this.activeFilter);
    });
    await this.renderResultCanvas();
    await this.syncFinalImageOnly();
  }

  async saveMingleOfflineSession(finalBlob, {
    sessionId = null,
    tenantId = null,
    eventId = null,
    guestPassId = undefined,
    guestPass = null,
    templateId = undefined,
    templateName = undefined,
    photos = null,
    modeVal = 'single',
    printRequested = false,
    printCopies = 1,
    printPaperSize = null,
    paperConfirmed = false
  } = {}) {
    if (!window.pbOfflineStore) return false;
    const srcPhotos = Array.isArray(photos) ? photos : (this.capturedPhotos || []);
    const offlineCaps = [];
    for (let i = 0; i < srcPhotos.length; i++) {
      try {
        const b = await (await fetch(srcPhotos[i])).blob();
        offlineCaps.push({ poseIndex: i + 1, blob: b });
      } catch (e) {}
    }
    const resolvedPass = guestPass || this.guestPass || null;
    await window.pbOfflineStore.saveSession({
      id: sessionId || this.sessionId,
      tenantId: tenantId || this.tenantId,
      eventId: eventId || this.eventId,
      deviceId: this.deviceId,
      guestPassId: guestPassId !== undefined ? guestPassId : (resolvedPass ? resolvedPass.id : null),
      guestPassToken: resolvedPass ? (resolvedPass.token || resolvedPass.token_plain || null) : null,
      guestPassGalleryUrl: resolvedPass ? (resolvedPass.galleryUrl || null) : null,
      guestPassQrDataUrl: resolvedPass ? (resolvedPass.qrDataUrl || null) : null,
      templateId: templateId !== undefined ? templateId : (this.selectedTemplate ? this.selectedTemplate.id : null),
      templateName: templateName !== undefined ? templateName : (this.selectedTemplate ? this.selectedTemplate.name : null),
      mode: modeVal,
      finalImageBlob: finalBlob,
      captures: offlineCaps,
      printRequested: Boolean(printRequested),
      printCopies: parseInt(printCopies, 10) || 1,
      printPaperSize: printPaperSize || null,
      paperConfirmed: Boolean(paperConfirmed)
    });
    this.updateOfflineGalleryBadge();
    return true;
  }

  async issuePassCreateAndSync() {
    const qrImg = document.getElementById('mingleQrImg');
    const qrPh = document.getElementById('mingleQrPlaceholder');
    const qrHint = document.getElementById('mingleQrTapHint');
    const linkEl = document.getElementById('mingleGalleryLink');
    const statusEl = document.getElementById('mingleSyncStatus');
    const isLocalMode = this.isLocalDirectMode();
    const canTryNetwork = !isLocalMode && navigator.onLine !== false;

    const snapToken = this._activeSessionToken || 0;
    const isStillCurrent = () => (this._activeSessionToken || 0) === snapToken;
    const snap = {
      sessionId: this.sessionId || null,
      tenantId: this.tenantId,
      eventId: this.eventId,
      guestPass: this.guestPass || null,
      templateId: this.selectedTemplate ? this.selectedTemplate.id : null,
      templateName: this.selectedTemplate ? this.selectedTemplate.name : null,
      photos: [...(this.capturedPhotos || [])],
      filesOnlyMode: Boolean(this.filesOnlyMode),
      syncedCaptureCount: this.syncedCaptureCount || 0
    };

    if (!snap.guestPass) {
      if (qrImg) qrImg.style.display = 'none';
      if (qrHint) qrHint.style.display = 'none';
      if (qrPh) {
        qrPh.style.display = 'block';
        qrPh.innerText = canTryNetwork
          ? 'Membuat QR Code Galeri...'
          : (isLocalMode ? '🔌 Mode Lokal Aktif — Foto disimpan di perangkat' : '⚡ Offline — Foto disimpan lokal, QR siap setelah ada WiFi');
      }
      if (statusEl) {
        statusEl.innerText = canTryNetwork
          ? '⏳ Mengunggah foto ke galeri tamu...'
          : '⚡ Menyimpan foto di penyimpanan lokal perangkat...';
      }

      if (isLocalMode || navigator.onLine === false) {
        const cachedPass = this.popGuestPassFromPool();
        if (cachedPass) snap.guestPass = cachedPass;
      }

      if (!snap.guestPass && navigator.onLine !== false) {
        try {
          const passRes = await this.fetchWithTimeout('/api/guest-passes/issue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenantId: snap.tenantId,
              eventId: snap.eventId,
              baseUrl: window.location.origin
            })
          }, 1400);
          if (passRes.ok) {
            snap.guestPass = await passRes.json();
          }
        } catch (e) {}
      }

      if (!snap.guestPass) {
        const fallbackPass = this.popGuestPassFromPool();
        if (fallbackPass) snap.guestPass = fallbackPass;
      }

      if (snap.guestPass && isStillCurrent()) {
        this.guestPass = snap.guestPass;
        if (snap.guestPass.qrDataUrl && qrImg) {
          qrImg.src = snap.guestPass.qrDataUrl;
          qrImg.style.display = 'block';
          if (qrPh) qrPh.style.display = 'none';
          if (qrHint) qrHint.style.display = 'block';
        }
        const token = snap.guestPass.token || snap.guestPass.token_plain;
        const gUrl = snap.guestPass.galleryUrl || (token ? `/gallery/g/${token}` : null);
        if (linkEl && gUrl) {
          linkEl.href = gUrl;
          linkEl.style.display = 'inline-block';
        }
      }
    }

    if (!snap.sessionId && canTryNetwork) {
      try {
        const modeVal = snap.filesOnlyMode ? 'files_only' : (snap.photos.length > 1 ? 'multi' : 'single');
        const sessRes = await this.fetchWithTimeout('/api/kiosk/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId: snap.tenantId,
            eventId: snap.eventId,
            deviceId: this.deviceId,
            guestPassId: snap.guestPass ? snap.guestPass.id : null,
            mode: modeVal,
            templateId: snap.templateId
          })
        }, 1500);
        if (sessRes.ok) {
          const sData = await sessRes.json();
          snap.sessionId = sData.sessionId;
        }
      } catch (e) {}
    }

    if (!snap.sessionId) {
      snap.sessionId = 'sess_mgl_off_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    }
    if (isStillCurrent()) {
      this.sessionId = snap.sessionId;
    }
    await this.syncFinalImageOnly(true, false, {}, snap);
  }

  async syncFinalImageOnly(includeRaw = false, printRequested = false, printOpts = {}, overrideSnap = null) {
    const canvas = document.getElementById('mingleFinalCanvas');
    const statusEl = document.getElementById('mingleSyncStatus');
    const qrPh = document.getElementById('mingleQrPlaceholder');
    const snapSessionId = (overrideSnap && overrideSnap.sessionId) || this.sessionId;
    if (!snapSessionId) return null;

    // Snapshot seluruh state sesi saat ini agar klik "Tamu Berikutnya" saat sinyal lambat tidak menghapus foto tamu sebelumnya
    const snapTenantId = (overrideSnap && overrideSnap.tenantId) || this.tenantId;
    const snapEventId = (overrideSnap && overrideSnap.eventId) || this.eventId;
    const snapPassId = overrideSnap
      ? (overrideSnap.guestPass ? overrideSnap.guestPass.id : null)
      : (this.guestPass ? this.guestPass.id : null);
    const snapTemplateId = overrideSnap
      ? overrideSnap.templateId
      : (this.selectedTemplate ? this.selectedTemplate.id : null);
    const snapPhotos = overrideSnap ? overrideSnap.photos : [...(this.capturedPhotos || [])];
    const snapFilesOnly = overrideSnap ? overrideSnap.filesOnlyMode : Boolean(this.filesOnlyMode);
    const snapSyncedOffset = overrideSnap ? (overrideSnap.syncedCaptureCount || 0) : (this.syncedCaptureCount || 0);

    let finalBlob = null;
    if (!snapFilesOnly && canvas && canvas.width > 0) {
      finalBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    }

    const totalPhotos = snapPhotos.length;
    const modeVal = snapFilesOnly ? 'files_only' : (totalPhotos > 1 ? 'multi' : 'single');
    const printCopies = String(printOpts.copies || 1);
    const printPaperSize = printOpts.paperSize || '';
    const paperConfirmed = !!printOpts.paperConfirmed;

    const snapPassObj = overrideSnap ? (overrideSnap.guestPass || null) : (this.guestPass || null);
    const snapTemplateName = overrideSnap
      ? (overrideSnap.templateName || (this.selectedTemplate && this.selectedTemplate.id === overrideSnap.templateId ? this.selectedTemplate.name : null))
      : (this.selectedTemplate ? this.selectedTemplate.name : null);

    if (!navigator.onLine || this.isLocalDirectMode()) {
      await this.saveMingleOfflineSession(finalBlob, {
        sessionId: snapSessionId,
        tenantId: snapTenantId,
        eventId: snapEventId,
        guestPassId: snapPassId,
        guestPass: snapPassObj,
        templateId: snapTemplateId,
        templateName: snapTemplateName,
        photos: snapPhotos,
        modeVal,
        printRequested: !this.isLocalDirectMode() && Boolean(printRequested),
        printCopies,
        printPaperSize: printPaperSize || null,
        paperConfirmed
      }).catch(() => {});
      if (this.sessionId === snapSessionId) {
        if (statusEl) {
          statusEl.innerText = this.isLocalDirectMode()
            ? `🔌 Mode Lokal: ${totalPhotos} foto aman tersimpan di perangkat.`
            : `⚡ Disimpan offline (${totalPhotos} foto) — otomatis terkirim saat WiFi tersambung!`;
        }
        if (!this.guestPass && qrPh) {
          qrPh.innerText = this.isLocalDirectMode()
            ? '🔌 Mode Lokal Aktif — Foto disimpan di perangkat'
            : '⚡ Offline — QR & galeri tersedia setelah WiFi tersambung';
        }
      }
      return { offlineSaved: true };
    }

    try {
      const startOffset = includeRaw ? snapSyncedOffset : totalPhotos;
      const unsyncedCount = Math.max(0, totalPhotos - startOffset);
      const batchSize = 5;

      if (unsyncedCount === 0) {
        const formData = new FormData();
        if (finalBlob) formData.append('finalImage', finalBlob, `mingle_${Date.now()}.jpg`);
        formData.append('printRequested', printRequested ? 'true' : 'false');
        if (printRequested) {
          formData.append('printCopies', printCopies);
          if (printPaperSize) formData.append('printPaperSize', printPaperSize);
          if (paperConfirmed) formData.append('paperConfirmed', 'true');
        }
        formData.append('mode', modeVal);
        formData.append('tenantId', snapTenantId);
        formData.append('eventId', snapEventId);
        if (snapPassId) formData.append('guestPassId', snapPassId);
        if (snapTemplateId) formData.append('templateId', snapTemplateId);
        const res = await this.fetchWithTimeout(`/api/kiosk/sessions/${snapSessionId}/complete`, { method: 'POST', body: formData }, 7500);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json().catch(() => null);
        if (this.sessionId === snapSessionId && statusEl) {
          const pj = data && data.printJob;
          if (printRequested) {
            statusEl.innerText = pj && pj.requiresPaperConfirm
              ? `⏳ Antrean 5R (${printCopies} lbr) dikirim! Menunggu konfirmasi kertas di Laptop Printer.`
              : `✅ Antrean cetak ${pj?.paperLabel || printOpts.paperLabel || '4R'} (${printCopies} lbr) terkirim ke server!`;
          } else {
            statusEl.innerText = `✅ Siap! ${totalPhotos} file foto siap diunduh lewat QR.`;
          }
        }
        return data;
      }

      let lastData = null;
      for (let offset = startOffset; offset < totalPhotos; offset += batchSize) {
        const end = Math.min(totalPhotos, offset + batchSize);
        if (this.sessionId === snapSessionId && statusEl) {
          statusEl.innerText = `⏳ Mengunggah foto ${end}/${totalPhotos}...`;
        }

        const formData = new FormData();
        if (offset === startOffset && finalBlob) {
          formData.append('finalImage', finalBlob, `mingle_${Date.now()}.jpg`);
        }
        const isLastBatch = (end >= totalPhotos);
        const batchPrint = (printRequested && isLastBatch);
        formData.append('printRequested', batchPrint ? 'true' : 'false');
        if (batchPrint) {
          formData.append('printCopies', printCopies);
          if (printPaperSize) formData.append('printPaperSize', printPaperSize);
          if (paperConfirmed) formData.append('paperConfirmed', 'true');
        }
        formData.append('mode', modeVal);
        formData.append('tenantId', snapTenantId);
        formData.append('eventId', snapEventId);
        formData.append('captureStartIndex', String(offset));
        if (snapPassId) formData.append('guestPassId', snapPassId);
        if (snapTemplateId) formData.append('templateId', snapTemplateId);

        for (let i = offset; i < end; i++) {
          try {
            const rawBlob = await (await fetch(snapPhotos[i])).blob();
            formData.append('captures', rawBlob, `mingle_pose_${i + 1}_${Date.now()}.jpg`);
          } catch (e) {}
        }

        const res = await this.fetchWithTimeout(`/api/kiosk/sessions/${snapSessionId}/complete`, { method: 'POST', body: formData }, 8500);
        if (!res.ok) throw new Error('Gagal mengunggah batch foto');
        lastData = await res.json().catch(() => lastData);
        if (this.sessionId === snapSessionId) {
          this.syncedCaptureCount = end;
        }
      }

      if (this.sessionId === snapSessionId && statusEl) {
        statusEl.innerText = printRequested
          ? `✅ ${totalPhotos} foto tersimpan & antrean cetak terkirim ke server!`
          : `✅ Siap! Semua ${totalPhotos} foto tersedia di QR Code.`;
      }
      return lastData;
    } catch (e) {
      await this.saveMingleOfflineSession(finalBlob, {
        sessionId: snapSessionId,
        tenantId: snapTenantId,
        eventId: snapEventId,
        guestPassId: snapPassId,
        guestPass: snapPassObj,
        templateId: snapTemplateId,
        templateName: snapTemplateName,
        photos: snapPhotos,
        modeVal,
        printRequested: Boolean(printRequested),
        printCopies,
        printPaperSize: printPaperSize || null,
        paperConfirmed
      }).catch(() => {});
      if (this.sessionId === snapSessionId) {
        if (statusEl) statusEl.innerText = `⚡ Sinyal lambat/terputus — ${totalPhotos} foto aman tersimpan di tablet & otomatis terkirim!`;
        if (!this.guestPass && qrPh) {
          qrPh.innerText = '⚡ Sinyal lemah — foto aman tersimpan di tablet';
        }
      }
      return { offlineSaved: true };
    }
  }

  openPrintOptionsModal() {
    if (this.filesOnlyMode) {
      this.showToast('Mode Jual File tidak memakai bingkai cetak.', 'ℹ️', 2200);
      return;
    }
    const modal = document.getElementById('minglePrintOptionsModal');
    if (!modal) {
      this.printResult();
      return;
    }
    this.setModalPrintCopies(this.modalPrintCopies || 1);
    const tpl = this.selectedTemplate;
    const is5rTpl = Boolean(tpl && (
      String(tpl.paper_format || '').toUpperCase() === '5R' ||
      /5r|5x7|1500x2100|2100x1500/i.test(`${tpl.name || ''} ${tpl.orientation || ''} ${tpl.width || ''}x${tpl.height || ''}`)
    ));
    this.setModalPrintPaper(is5rTpl ? '5R' : '4R');
    const readyCheck = document.getElementById('minglePaperAlreadyReadyCheck');
    if (readyCheck) readyCheck.checked = false;
    const confirmBtn = document.getElementById('minglePrintModalConfirmBtn');
    if (confirmBtn) {
      confirmBtn.innerText = this.isLocalDirectMode()
        ? '⚡ Cetak Langsung di Perangkat (Mode Lokal)'
        : '🚀 Kirim Cetak ke Antrean Server';
    }
    modal.style.display = 'flex';
  }

  closePrintOptionsModal(event) {
    if (event && event.target && event.target.closest('div[onclick*="stopPropagation"]')) return;
    const modal = document.getElementById('minglePrintOptionsModal');
    if (modal) modal.style.display = 'none';
  }

  setModalPrintCopies(qty) {
    const val = Math.max(1, Math.min(10, parseInt(qty, 10) || 1));
    this.modalPrintCopies = val;
    const qtyEl = document.getElementById('minglePrintModalQty');
    if (qtyEl) qtyEl.innerText = String(val);
    document.querySelectorAll('.mingle-qty-chip').forEach(btn => {
      const active = Number(btn.dataset.qty) === val;
      btn.style.background = active ? 'var(--coral, #E6786B)' : '';
      btn.style.color = active ? '#fff' : '';
      btn.style.borderColor = active ? 'var(--coral, #E6786B)' : '';
    });
  }

  adjustModalPrintCopies(delta) {
    this.setModalPrintCopies((this.modalPrintCopies || 1) + delta);
  }

  setModalPrintPaper(size) {
    this.modalPrintPaper = size === '5R' ? '5R' : '4R';
    const opt4 = document.getElementById('minglePaperOpt4R');
    const opt5 = document.getElementById('minglePaperOpt5R');
    const notice5r = document.getElementById('minglePrint5rNotice');
    if (opt4) {
      const a = this.modalPrintPaper === '4R';
      opt4.style.borderColor = a ? 'var(--coral, #E6786B)' : 'var(--border-soft, #EAD8C7)';
      opt4.style.background = a ? 'rgba(230,120,107,0.12)' : '#fff';
    }
    if (opt5) {
      const a = this.modalPrintPaper === '5R';
      opt5.style.borderColor = a ? '#D4A754' : 'var(--border-soft, #EAD8C7)';
      opt5.style.background = a ? '#FFF8E6' : '#fff';
    }
    if (notice5r) {
      notice5r.style.display = this.modalPrintPaper === '5R' ? 'block' : 'none';
    }
  }

  resolveSelectedServerPaperSize() {
    if (this.modalPrintPaper === '5R') return '5x7';
    if (this.selectedTemplate && this.selectedTemplate.orientation === 'strip') return '2x6';
    return '4x6';
  }

  async confirmSendServerPrint() {
    const modal = document.getElementById('minglePrintOptionsModal');
    if (modal) modal.style.display = 'none';
    const copies = this.modalPrintCopies || 1;
    const paperSize = this.resolveSelectedServerPaperSize();
    const paperConfirmed = this.modalPrintPaper === '5R'
      ? Boolean(document.getElementById('minglePaperAlreadyReadyCheck')?.checked)
      : true;
    await this.printResult({ copies, paperSize, paperLabel: this.modalPrintPaper, paperConfirmed });
  }

  drawQrCardAt(ctx, startX, startY, w, h, qrImg, targetSizePx) {
    const qrSize = Math.max(52, Math.round(targetSizePx));
    const pad = Math.max(4, Math.round(qrSize * 0.05));
    const cardSize = qrSize + pad * 2;
    const sx = Math.max(0, Math.min(w - cardSize, Math.round(startX)));
    const sy = Math.max(0, Math.min(h - cardSize, Math.round(startY)));

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(sx, sy, cardSize, cardSize, 8);
    } else {
      ctx.rect(sx, sy, cardSize, cardSize);
    }
    ctx.fill();
    ctx.drawImage(qrImg, sx + pad, sy + pad, qrSize, qrSize);
    ctx.restore();
  }

  async resolveMinglePrintableQrImage() {
    const domImg = document.getElementById('mingleQrImg');
    if (domImg && domImg.src && domImg.complete && domImg.naturalWidth > 0) return domImg;
    const qrSrc = (this.guestPass && this.guestPass.qrDataUrl) || (domImg && domImg.src) || '';
    if (!qrSrc || !qrSrc.startsWith('data:')) return null;
    try {
      const img = new Image();
      img.src = qrSrc;
      await Promise.race([
        new Promise((res) => { img.onload = res; img.onerror = res; }),
        new Promise((res) => setTimeout(res, 600))
      ]);
      return img.naturalWidth > 0 ? img : null;
    } catch (e) {
      return null;
    }
  }

  async buildPrintableDataUrl() {
    const canvas = document.getElementById('mingleFinalCanvas');
    if (!canvas) return null;

    const tpl = this.selectedTemplate || null;
    const rawQrCoords = (tpl && Array.isArray(tpl.qr_coords) && tpl.qr_coords.length > 0) ? tpl.qr_coords : null;
    const qrPos = (tpl && tpl.qr_position) || 'bottom-right';
    const qrEnabled = Boolean(rawQrCoords) || (qrPos !== 'none');

    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = canvas.width;
    baseCanvas.height = canvas.height;
    const bCtx = baseCanvas.getContext('2d');
    bCtx.drawImage(canvas, 0, 0);

    if (qrEnabled && !this.guestPass) {
      const cachedPass = this.popGuestPassFromPool();
      if (cachedPass) this.guestPass = cachedPass;
    }

    if (qrEnabled && this.guestPass) {
      const qrImg = await this.resolveMinglePrintableQrImage();
      if (qrImg) {
        const w = baseCanvas.width;
        const h = baseCanvas.height;
        if (rawQrCoords) {
          const refW = (tpl && tpl.width) || w;
          const refH = (tpl && tpl.height) || h;
          const sx = w / Math.max(1, refW);
          const sy = h / Math.max(1, refH);
          for (const item of rawQrCoords) {
            const sizePx = Math.max(60, Math.round((Number(item.size) || 150) * Math.min(sx, sy)));
            this.drawQrCardAt(bCtx, (Number(item.x) || 0) * sx, (Number(item.y) || 0) * sy, w, h, qrImg, sizePx);
          }
        } else if (qrPos === 'dual-bottom-right') {
          const halfW = Math.round(w / 2);
          const qSize = Math.round(Math.min(w, h) * 0.115);
          this.drawQrCardAt(bCtx, halfW - qSize - 32, h - qSize - 32, w, h, qrImg, qSize);
          this.drawQrCardAt(bCtx, w - qSize - 32, h - qSize - 32, w, h, qrImg, qSize);
        } else {
          const qSize = (w <= 700) ? 100 : 140;
          const pad = Math.max(4, Math.round(qSize * 0.05));
          const cardSize = qSize + pad * 2;
          const margin = (w <= 700) ? 18 : 32;
          let sx = w - cardSize - margin;
          let sy = h - cardSize - margin;
          if (qrPos === 'bottom-left') { sx = margin; }
          else if (qrPos === 'top-right') { sy = margin; }
          else if (qrPos === 'top-left') { sx = margin; sy = margin; }
          this.drawQrCardAt(bCtx, sx, sy, w, h, qrImg, qSize);
        }
      }
    }

    return baseCanvas.toDataURL('image/png');
  }

  async printFromModalViaDevice() {
    const modal = document.getElementById('minglePrintOptionsModal');
    if (modal) modal.style.display = 'none';
    const canvas = document.getElementById('mingleFinalCanvas');
    const copies = this.modalPrintCopies || 1;
    const is5r = this.modalPrintPaper === '5R';
    if (window.pbPrintViaBrowser && canvas) {
      const printableUrl = await this.buildPrintableDataUrl();
      window.pbPrintViaBrowser({
        imageUrl: printableUrl || canvas.toDataURL('image/png'),
        copies,
        job: {
          paperSize: is5r ? '5x7' : '4x6',
          paperWidthIn: is5r ? 5 : 4,
          paperHeightIn: is5r ? 7 : 6,
          borderless: true
        }
      });
    }
  }

  async printResult(printOpts = null) {
    if (this.filesOnlyMode) {
      this.showToast('Mode Jual File tidak memakai bingkai cetak.', 'ℹ️', 2200);
      return;
    }
    if (!printOpts) {
      this.openPrintOptionsModal();
      return;
    }
    if (this.isLocalDirectMode()) {
      await this.printFromModalViaDevice();
      await this.syncFinalImageOnly(false, false, printOpts);
      this.showToast(`⚡ ${printOpts.copies || 1}× ${printOpts.paperLabel || '4R'} dicetak langsung & disimpan lokal!`, '🖨️', 2800);
      return;
    }
    const resData = await this.syncFinalImageOnly(false, true, printOpts);
    const job = resData && resData.printJob ? resData.printJob : null;
    if (job && job.requiresPaperConfirm) {
      this.showToast(`📄 Antrean 5R (${printOpts.copies}×) dikirim! Menunggu konfirmasi kertas di Laptop Printer.`, '⏳', 3500);
    } else if (job && (job.dispatchedToOs || job.awaitingAgent)) {
      this.showToast(`🖨️ ${printOpts.copies}× ${printOpts.paperLabel || '4R'} langsung dicetak di ${job.printerName || 'printer'}!`, '🖨️', 2800);
    } else if (job) {
      this.showToast(`✅ Antrean ${printOpts.paperLabel || '4R'} (${printOpts.copies}×) dikirim ke Server Admin!`, '🖨️', 3000);
    } else if (resData && resData.offlineSaved) {
      this.showToast(`⚡ WiFi terputus: Foto & antrean cetak (${printOpts.copies}×) disimpan lokal & dikirim otomatis saat ada WiFi!`, '⚡', 3500);
    } else {
      this.showToast('⚠️ Gagal mengirim ke server.', '⚠️', 2600);
    }
  }

  async addMorePhotos() {
    if (this.activeTargetShots !== 'unlimited') {
      this.activeTargetShots = 'unlimited';
      const readySel = document.getElementById('mingleReadyShotsSelect');
      if (readySel) readySel.value = 'unlimited';
    }
    this.updateReadyCaptureUI();
    this.showScreen('screenMingleReady');
    await this.armPhysicalCaptureBaseline();
    this.syncViewfinderForReadyScreen();
    this.showToast('📸 Siap tambah foto ke QR Code yang sama!', '➕', 2400);
  }

  async retakeSameFrame() {
    this.resetSessionCaptureState();
    this.updateReadyCaptureUI();
    this.showScreen('screenMingleReady');
    await this.armPhysicalCaptureBaseline();
    this.syncViewfinderForReadyScreen();
  }

  nextGuest() {
    this._physicalReadyArmed = false;
    this.setUsbMingleListen(false);
    this.stopLiveViewLoop();
    this.stopWebcam();
    this.showScreen('screenMingleWelcome');
  }

  async toggleFullScreen() {
    try {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (isFs) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      }
    } catch (e) {}
  }

  showToast(msg, icon = '✨', durationMs = 2400) {
    const toast = document.getElementById('mingleToast');
    if (!toast) return;
    toast.innerHTML = `<span>${icon}</span><span>${this.escapeHtml(msg)}</span>`;
    toast.style.display = 'inline-flex';
    if (this.toastTimerId) clearTimeout(this.toastTimerId);
    this.toastTimerId = setTimeout(() => { toast.style.display = 'none'; }, durationMs);
  }
}

window.mingle = new MingleBoothEngine();
