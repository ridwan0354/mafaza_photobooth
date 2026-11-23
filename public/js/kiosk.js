// PHOTOBOOTH KIOSK TOUCHSCREEN STATE MACHINE & CAMERA ENGINE
if (!window.__pbNotifyInitialized) {
  const s = document.createElement('script');
  s.src = '/js/notify.js?v=warm-retro-v3.2';
  document.head.appendChild(s);
}

class KioskEngine {
  constructor() {
    this.currentScreen = 'screenWelcome';
    this.tenantId = 'tenant_studiokeren_01';
    const urlParams = new URLSearchParams(window.location.search);
    this.eventId = urlParams.get('eventId') || localStorage.getItem('pb_active_event_id') || 'event_wedding_dimas_sarah';
    this.deviceId = 'dev_kiosk_win_01';
    this.guestPass = null;
    this.selectedMode = 'strip'; // 'strip' or 'single'
    this.selectedTemplate = null;
    this.templates = [];
    this.mediaStream = null;
    this.posesCaptured = [];
    this.liveClips = [];
    this.activeLiveRecorder = null;
    this.activeLiveChunks = [];
    this.activePoseIndex = 0;
    this.totalPosesRequired = 3;
    this.sessionId = null;
    this.autoReturnTimerId = null;
    this.audioCtx = null;
    this.isCountingDown = false;
    this.isCapturingSnap = false;
    this.countdownTimerId = null;
    this.interPoseTimerId = null;
    this.reviewAutoAdvanceTimerId = null;
    this.modalSelectedPoseIndex = null;
    this.toastTimerId = null;
    try {
      const savedZoom = parseFloat(localStorage.getItem('pb_camera_zoom'));
      this.cameraZoom = (!isNaN(savedZoom) && savedZoom >= 0.5 && savedZoom <= 3.0) ? savedZoom : 1.0;
    } catch (e) {
      this.cameraZoom = 1.0;
    }
    this.cameraPanX = 0;
    this.cameraPanY = 0;
    this.cameraFitMode = localStorage.getItem('pb_camera_fit_mode') || 'cover';
    this.cameraAspectRatio = localStorage.getItem('pb_camera_aspect_ratio') || '16/9';
    const savedCamOrient = localStorage.getItem('pb_camera_capture_orientation') || 'auto';
    this.cameraCaptureOrientation = ['auto', 'portrait', 'landscape'].includes(savedCamOrient) ? savedCamOrient : 'auto';
    const savedRot = parseInt(localStorage.getItem('pb_camera_rotation') || '0', 10);
    this.cameraRotation = [0, 90, 180, 270].includes(savedRot) ? savedRot : 0;

    // Interactive Photo Selection & Panning State in Preview
    this.slotAssignments = [];
    this.slotTransforms = [];
    this.selectedPreviewSlotIndex = 0;
    this.activePhotoFilter = 'normal';
    this.activePhotoFilterIntensity = 1.0;
    this._sessionFilterManuallyChosen = false;
    this.cachedPhotoImages = {};
    this.cachedKeyedFrame = null;
    this.isDraggingPhoto = false;
    this.dragStart = null;
    this.canvasListenersAttached = false;
    this.syncDebounceTimer = null;

    // Flash Trigger via Audio Headphone Jack (Godox CT-16 / Studio Strobe)
    this.audioFlashEnabled = localStorage.getItem('pb_audio_flash_enabled') !== 'false';
    this.audioFlashLeadMs = parseInt(localStorage.getItem('pb_audio_flash_lead_ms') || '25', 10);
    this.audioFlashSinkId = localStorage.getItem('pb_audio_flash_sink_id') || '';
    this.flashWavDataUrl = null;
    this.flashAudioElement = null;

    this.init();
  }

  async init() {
    console.log('🎬 Initializing Photobooth Kiosk Engine...');
    this.activePrinterName = 'Printer Foto';
    this.autoPrintEnabled = localStorage.getItem('pb_kiosk_auto_print') === 'true';
    const autoToggle = document.getElementById('autoPrintToggle');
    if (autoToggle) autoToggle.checked = this.autoPrintEnabled;

    const chkFlash = document.getElementById('chkAudioFlashEnabled');
    if (chkFlash) chkFlash.checked = this.audioFlashEnabled;
    const selLead = document.getElementById('selAudioFlashLead');
    if (selLead) selLead.value = (this.audioFlashLeadMs || 25).toString();

    this.setupOfflineEngine();
    await this.fetchEventConfig();
    await Promise.allSettled([
      this.fetchCameraConfig(),
      this.fetchPrinterProfile(),
      this.fetchTemplates()
    ]);
    this.updateLocalModeUI();
    this.replenishGuestPassPool(20).catch(() => {});
    this.setupAudio();
    this.setupFullScreenSupport();
    this.setupKeyboardRemoteListeners();
    this.setupMediaDeviceChangeListener();
    this.updateCameraFitButtonsUI();
    this.updateCameraAspectRatioButtonsUI();
    if (typeof this.updateCameraCaptureOrientationUI === 'function') {
      this.updateCameraCaptureOrientationUI();
    }
    this.updateCameraRotationButtonsUI();
    this.applyCameraTransform();
    this.startCanonUsbAutoDetector();

    // Deteksi iPad / Mobile: Jangan panggil getUserMedia saat #screenCapture masih display:none,
    // karena WebKit iPadOS akan membekukan/menggelapkan buffer UVC (seperti DJI Osmo Action 4) jika elemen <video> tersembunyi.
    const isIpadOs = (navigator.userAgent.includes('Macintosh') && (navigator.maxTouchPoints > 1)) || /iPad/i.test(navigator.userAgent || '');
    const isAndroidBridge = Boolean(typeof window !== 'undefined' && window.MafazaAndroidBridge);
    const isMobileDevice = /Android|iPhone|iPod/i.test(navigator.userAgent || '') || isIpadOs || isAndroidBridge;
    if (!isMobileDevice) {
      this.startCamera().catch(err => console.warn('Initial camera warmup:', err));
    }

    // Panel diagnosa kamera (hanya aktif jika URL berisi ?debug=1) untuk melacak masalah layar hitam UVC di iPad
    try {
      if (new URLSearchParams(window.location.search).get('debug') === '1') {
        this.startCameraDebugOverlay();
      }
    } catch (e) {}

    // Support direct testing of screens via hash (e.g. #template, #camera)
    const hash = window.location.hash.toLowerCase();
    if (hash === '#template') {
      this.renderTemplateSelection('all');
      this.showScreen('screenTemplate');
    } else if (hash === '#camera' || hash === '#kamera') {
      this.selectedTemplate = this.templates[0] || null;
      this.startCountdownSequence();
    }
  }

  setupMediaDeviceChangeListener() {
    if (!this._unloadCameraBound) {
      this._unloadCameraBound = true;
      const releaseOnUnload = () => {
        if (this.mediaStream) {
          try {
            this.mediaStream.getTracks().forEach(t => t.stop());
          } catch (e) {}
          this.mediaStream = null;
        }
      };
      window.addEventListener('pagehide', releaseOnUnload);
      window.addEventListener('beforeunload', releaseOnUnload);
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.addEventListener !== 'function') return;
    if (this._deviceChangeBound) return;
    this._deviceChangeBound = true;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (this._deviceChangeTimer) clearTimeout(this._deviceChangeTimer);
      // Tunggu 1100ms agar endpoint UVC kamera USB (seperti DJI Osmo Action 4) siap sepenuhnya di iPadOS / Mac
      this._deviceChangeTimer = setTimeout(async () => {
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devs.filter(d => d.kind === 'videoinput');
          const activeTrack = this.mediaStream?.getVideoTracks?.()[0];
          const activeId = activeTrack?.getSettings?.()?.deviceId || '';
          this.populateQuickCameraSelect(videoInputs, activeId);

          // Jika saat ini di layar kamera/QR dan stream belum aktif, virtual, atau ada kamera eksternal baru dicolok
          const extCam = videoInputs.find(d => /osmo|action|dji|gopro|insta360|uvc|usb|hdmi|capture|canon|sony/i.test(d.label || ''));
          const activeLabel = activeTrack?.label || '';
          const isCurrentlyExt = /osmo|action|dji|gopro|insta360|uvc|usb|hdmi|capture|canon|sony/i.test(activeLabel);
          if (
            (this.currentScreen === 'screenCapture' || this.currentScreen === 'screenQR') &&
            (!this.isMediaStreamLive() || this.isVirtualFallbackStream || (extCam && !isCurrentlyExt))
          ) {
            console.log('🔌 Kamera UVC / Eksternal baru terdeteksi, mengalihkan otomatis:', extCam?.label || '');
            await this.startCamera(null, true);
          }
        } catch (e) {}
      }, 1100);
    });
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

  updateLocalModeUI() {
    if (typeof window !== 'undefined') {
      window.__pbEventLocalMode = Boolean(this.eventConfig && this.eventConfig.localPrintMode);
    }
    if (typeof this._updateOfflineBadge === 'function') {
      this._updateOfflineBadge();
    }
    const modal = document.getElementById('kioskPrintOptionsModal');
    if (modal && modal.style.display === 'flex') {
      this.syncPrintOptionsModalLabels();
    }
  }

  setupOfflineEngine() {
    const updateOfflineBadge = () => {
      const badge = document.getElementById('kioskOfflineBadge');
      const textEl = document.getElementById('kioskOfflineBadgeText');
      const galleryBtn = document.getElementById('btnKioskOfflineGallery');

      const isOnline = navigator.onLine;
      const isLocal = this.isLocalDirectMode();
      const applyGalleryBtn = (count) => {
        if (!galleryBtn) return;
        const c = Number(count) || 0;
        galleryBtn.textContent = c > 0
          ? (isOnline ? `🔄 Mengirim (${c}) · 📂 Galeri` : `📦 Belum Terkirim (${c})`)
          : (isOnline ? '📂 Galeri Lokal' : '⚡ Offline · 📂 Galeri');
        galleryBtn.style.borderColor = c > 0 ? (isOnline ? 'var(--teal)' : 'var(--coral)') : 'var(--border-soft)';
        galleryBtn.style.background = c > 0 ? (isOnline ? 'rgba(95, 143, 138, 0.16)' : '#FFF0EC') : 'var(--cream-card)';
        galleryBtn.style.color = c > 0 ? (isOnline ? '#1F5B56' : '#B93829') : 'var(--caramel-brown)';
      };

      if (window.pbOfflineStore) {
        window.pbOfflineStore.getPendingCount().then((count) => {
          applyGalleryBtn(count);
          if (!badge) return;
          if (isLocal) {
            badge.style.display = 'inline-flex';
            badge.style.borderColor = '#D4A754';
            badge.style.color = '#7a581a';
            badge.style.background = 'rgba(212, 167, 84, 0.18)';
            if (textEl) textEl.innerText = count > 0 ? `🔌 Mode Lokal (${count} foto tersimpan)` : '🔌 Mode Lokal • Cetak Langsung';
          } else if (!isOnline || count > 0) {
            badge.style.display = 'inline-flex';
            if (!isOnline) {
              badge.style.borderColor = 'var(--coral)';
              badge.style.color = 'var(--coral)';
              badge.style.background = 'rgba(230, 120, 107, 0.16)';
              if (textEl) textEl.innerText = count > 0 ? `Mode Offline (${count} foto tersimpan)` : 'Mode Offline';
            } else {
              badge.style.borderColor = 'var(--teal)';
              badge.style.color = 'var(--teal)';
              badge.style.background = 'rgba(95, 143, 138, 0.16)';
              if (textEl) textEl.innerText = `🔄 Menyinkronkan ${count} foto...`;
            }
          } else {
            badge.style.display = 'none';
          }
        });
      } else {
        applyGalleryBtn(0);
        if (badge && (isLocal || !isOnline)) {
          badge.style.display = 'inline-flex';
          if (textEl) textEl.innerText = isLocal ? '🔌 Mode Lokal • Cetak Langsung' : 'Mode Offline';
        } else if (badge) {
          badge.style.display = 'none';
        }
      }
    };
    this._updateOfflineBadge = updateOfflineBadge;

    window.addEventListener('storage', (ev) => {
      if (ev.key === 'pb_kiosk_local_mode') {
        updateOfflineBadge();
        if (ev.newValue !== 'true' && navigator.onLine !== false && window.pbOfflineStore) {
          window.pbOfflineStore.syncAllPending();
        }
      }
    });
    try {
      if (typeof BroadcastChannel === 'function') {
        const ch = new BroadcastChannel('pb_kiosk_mode');
        this._modeBroadcastChannel = ch;
        ch.onmessage = (msg) => {
          if (msg && msg.data && msg.data.localPrintMode === false) {
            if (this.eventConfig) this.eventConfig.localPrintMode = false;
            if (typeof window !== 'undefined') window.__pbEventLocalMode = false;
            if (navigator.onLine !== false && window.pbOfflineStore) {
              window.pbOfflineStore.syncAllPending();
            }
          } else if (msg && msg.data && msg.data.localPrintMode === true) {
            if (this.eventConfig) this.eventConfig.localPrintMode = true;
            if (typeof window !== 'undefined') window.__pbEventLocalMode = true;
          }
          updateOfflineBadge();
        };
      }
    } catch (e) {}

    window.addEventListener('online', () => {
      updateOfflineBadge();
      setTimeout(() => this.replenishGuestPassPool(20).catch(() => {}), 800);
      if (!this.isLocalDirectMode() && window.pbToast) {
        window.pbToast('🌐 Koneksi internet aktif kembali', 'info', 3000);
      }
    });
    window.addEventListener('offline', () => {
      updateOfflineBadge();
      if (window.pbToast) window.pbToast('⚡ Mode Offline: Foto & cetak tetap berfungsi normal!', 'warn', 4000);
    });
    if (window.pbOfflineStore) {
      window.pbOfflineStore.subscribe(() => {
        updateOfflineBadge();
        if (navigator.onLine !== false) {
          this.replenishGuestPassPool(20).catch(() => {});
        }
      });
    }
    this._poolRefillTimerId = setInterval(() => {
      if (!document.hidden && navigator.onLine !== false) {
        this.replenishGuestPassPool(20).catch(() => {});
      }
    }, 30000);
    window.addEventListener('pagehide', () => {
      if (this._poolRefillTimerId) { clearInterval(this._poolRefillTimerId); this._poolRefillTimerId = null; }
      if (this.canonAutoDetectInterval) { clearInterval(this.canonAutoDetectInterval); this.canonAutoDetectInterval = null; }
      if (this._modeBroadcastChannel) { try { this._modeBroadcastChannel.close(); } catch (e) {} this._modeBroadcastChannel = null; }
      this.clearAllTimers();
    });
    updateOfflineBadge();
  }

  async fetchCameraConfig() {
    try {
      const res = await this.fetchWithTimeout('/api/camera/status', {}, 2000);
      if (res.ok) {
        const data = await res.json();
        this.cameraSystemStatus = data;
        this.cameraConfig = data.config || { cameraMode: 'sony_canon_flash', cameraBrand: 'sony_a7iii' };
        return;
      }
    } catch (e) {}
    this.cameraConfig = this.cameraConfig || { cameraMode: 'sony_canon_flash', cameraBrand: 'sony_a7iii' };
  }

  applyPrinterProfileData(profile) {
    if (!profile || !profile.name) return;
    this.activePrinterName = profile.name;
    this.cachedPrinterProfile = profile;
    const shortName = profile.name.replace(/\s*series.*$/i, '').slice(0, 18);
    const badge = document.getElementById('printerReadyBadge');
    if (badge) badge.innerText = `● ${shortName} Ready`;

    const st = profile.settings || {};
    const select = document.getElementById('printCopiesSelect');
    const maxCopies = parseInt(st.maxCopies, 10);
    if (select && maxCopies >= 1) {
      select.innerHTML = Array.from({ length: maxCopies }, (_, i) =>
        `<option value="${i + 1}" ${i === 0 ? 'selected' : ''}>${i + 1} Lembar</option>`).join('');
      select.value = '1';
    }
    if (st.mode === 'auto') {
      this.autoPrintEnabled = true;
      const autoToggle = document.getElementById('autoPrintToggle');
      if (autoToggle) autoToggle.checked = true;
    }
  }

  async fetchPrinterProfile() {
    try {
      const res = await this.fetchWithTimeout('/api/printers/profile', {}, 1800);
      if (res.ok) {
        const profile = await res.json();
        try { localStorage.setItem('pb_printer_profile_cache', JSON.stringify(profile)); } catch (e) {}
        this.applyPrinterProfileData(profile);
        return;
      }
    } catch (e) {}
    try {
      const cached = localStorage.getItem('pb_printer_profile_cache');
      if (cached) this.applyPrinterProfileData(JSON.parse(cached));
    } catch (e) {}
  }

  toggleAutoPrintSetting(checked) {
    this.autoPrintEnabled = !!checked;
    localStorage.setItem('pb_kiosk_auto_print', this.autoPrintEnabled ? 'true' : 'false');
    const banner = document.getElementById('printStatusBanner');
    if (banner) {
      banner.style.display = 'block';
      banner.innerText = this.autoPrintEnabled
        ? '⚡ Mode Auto-Cetak Aktif: Foto otomatis dicetak saat masuk Preview!'
        : 'ℹ️ Mode Auto-Cetak Nonaktif: Klik tombol Cetak untuk mencetak.';
    }
  }

  async fetchEventConfig() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const paramEventId = urlParams.get('eventId');
      if (!paramEventId) {
        try {
          const activeRes = await this.fetchWithTimeout('/api/events/active/current', {}, 1800);
          if (activeRes.ok) {
            const activeData = await activeRes.json();
            if (activeData.activeEventId) {
              this.eventId = activeData.activeEventId;
              localStorage.setItem('pb_active_event_id', this.eventId);
            }
          }
        } catch (err) {}
      }

      const res = await this.fetchWithTimeout(`/api/events/${this.eventId}`, {}, 2000);
      if (res.ok) {
        this.eventData = await res.json();
        if (this.eventData && window.pbOfflineStore) {
          window.pbOfflineStore.cacheConfig('event_' + this.eventId, this.eventData);
        }
        this.eventConfig = this.eventData.config || {};
        this.updateLocalModeUI();
    this.replenishGuestPassPool(20).catch(() => {});
        if (this.eventConfig.shotsCount) {
          this.totalPosesRequired = parseInt(this.eventConfig.shotsCount) || 3;
        }
        if (this.eventData && this.eventData.name) {
          document.title = `Mafaza — ${this.eventData.name}`;
          const brandEl = document.getElementById('kioskBrandTitle');
          if (brandEl) brandEl.innerText = `MAFAZA • ${this.eventData.name}`;
        }
        this.applyKioskWelcomeText();
        this.applyKioskBackground();
        this.syncDefaultEventPhotoFilter(false);
        this.applyCameraImageAdjustToLiveVideo();
        this.renderStepProgressBars();
      }
    } catch (e) {
      if (window.pbOfflineStore) {
        const cached = await window.pbOfflineStore.getCachedConfig('event_' + this.eventId);
        if (cached) {
          this.eventData = cached;
          this.eventConfig = this.eventData.config || {};
          if (this.eventConfig.shotsCount) {
            this.totalPosesRequired = parseInt(this.eventConfig.shotsCount) || 3;
          }
          if (this.eventData && this.eventData.name) {
            document.title = `Mafaza — ${this.eventData.name}`;
            const brandEl = document.getElementById('kioskBrandTitle');
            if (brandEl) brandEl.innerText = `MAFAZA • ${this.eventData.name}`;
          }
          this.applyKioskWelcomeText();
          this.applyKioskBackground();
          this.syncDefaultEventPhotoFilter(false);
          this.applyCameraImageAdjustToLiveVideo();
          this.renderStepProgressBars();
        }
      }
    }
  }

  applyKioskWelcomeText() {
    const headlineEl = document.getElementById('welcomeHeadlineText');
    const startBtn = document.getElementById('welcomeStartBtn');
    const headline = (this.eventConfig && this.eventConfig.welcomeHeadline) || 'Abadikan Momen Spesialmu Di Sini! 😊';
    const btnText = (this.eventConfig && this.eventConfig.welcomeBtnText) || 'Mulai Foto ➔';

    if (headlineEl) {
      const cleanHeadline = headline.replace(/\n/g, '<br>');
      headlineEl.innerHTML = cleanHeadline;
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

  applyKioskBackground() {
    const wrapper = document.getElementById('kioskWrapper') || document.querySelector('.kiosk-wrapper');
    const bgContainer = document.getElementById('kioskCustomBgContainer');
    const bgImg = document.getElementById('kioskBgImage');
    const bgVideo = document.getElementById('kioskBgVideo');
    const bgYtWrap = document.getElementById('kioskBgYoutubeWrap');
    const bgYtIframe = document.getElementById('kioskBgYoutubeIframe');
    const bgOverlay = document.getElementById('kioskBgOverlay');
    const headlineEl = document.getElementById('welcomeHeadlineText');

    if (!bgContainer) return;

    const bgCfg = (this.eventConfig && this.eventConfig.kioskBackground) || { type: 'default', url: '', overlayOpacity: 35 };
    const type = bgCfg.type || 'default';
    const url = (bgCfg.url || '').trim();
    const opacityVal = (bgCfg.overlayOpacity !== undefined && bgCfg.overlayOpacity !== null) ? parseInt(bgCfg.overlayOpacity) : 35;
    const opacityFloat = Math.max(0, Math.min(0.85, (isNaN(opacityVal) ? 35 : opacityVal) / 100));

    // If default or empty URL, restore default warm cream background
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

    // Active custom background (image, video, or youtube)
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
    if (this.currentAppliedBgKey === bgKey) {
      return; // Avoid reloading video/iframe if identical
    }
    this.currentAppliedBgKey = bgKey;

    if (bgImg) bgImg.style.display = 'none';
    if (bgVideo) { bgVideo.style.display = 'none'; bgVideo.pause(); }
    if (bgYtWrap) bgYtWrap.style.display = 'none';

    if (type === 'youtube') {
      const ytId = this.extractYouTubeId(url);
      if (ytId && bgYtWrap && bgYtIframe) {
        const embedUrl = `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&loop=1&playlist=${ytId}&controls=0&showinfo=0&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1`;
        bgYtIframe.src = embedUrl;
        bgYtWrap.style.display = 'block';
      }
    } else if (type === 'video') {
      if (bgVideo) {
        bgVideo.src = url;
        bgVideo.style.display = 'block';
        bgVideo.play().catch(() => {});
      }
    } else {
      if (bgImg) {
        bgImg.src = url;
        bgImg.style.display = 'block';
      }
    }
  }

  isQrScanDisabled() {
    const req = (this.eventConfig && this.eventConfig.qrRequirement) || 'disabled';
    return req === 'disabled';
  }

  renderStepProgressBars() {
    const qrDisabled = this.isQrScanDisabled();
    const steps = qrDisabled
      ? [
          { screen: 'screenTemplate', label: 'Pilih Frame' },
          { screen: 'screenCapture', label: 'Foto' },
          { screen: 'screenPreview', label: 'Selesai' }
        ]
      : [
          { screen: 'screenQR', label: 'Pindai QR' },
          { screen: 'screenTemplate', label: 'Pilih Frame' },
          { screen: 'screenCapture', label: 'Foto' },
          { screen: 'screenPreview', label: 'Selesai' }
        ];

    document.querySelectorAll('.step-progress-retro[data-step-screen]').forEach(container => {
      const screenKey = container.getAttribute('data-step-screen');
      const activeIdx = steps.findIndex(s => s.screen === screenKey);
      if (activeIdx === -1) return;

      const htmlParts = [];
      steps.forEach((step, idx) => {
        if (idx < activeIdx) {
          let clickAttr = '';
          if (screenKey === 'screenPreview' && step.screen === 'screenTemplate') {
            clickAttr = `onclick="kiosk.openChangeFrameModal()" style="cursor: pointer;" title="Klik untuk ganti frame"`;
          } else if (screenKey === 'screenPreview' && step.screen === 'screenCapture') {
            clickAttr = `onclick="kiosk.returnToCameraFromPreview()" style="cursor: pointer;" title="Klik untuk kembali ke kamera"`;
          }
          htmlParts.push(`
            <div class="step-item completed" ${clickAttr}>
              <div class="step-circle">✓</div>
              <div class="step-label">${step.label}</div>
            </div>
          `);
        } else if (idx === activeIdx) {
          htmlParts.push(`
            <div class="step-item active">
              <div class="step-circle">${idx + 1}</div>
              <div class="step-label">${step.label}</div>
            </div>
          `);
        } else {
          htmlParts.push(`
            <div class="step-item">
              <div class="step-circle">${idx + 1}</div>
              <div class="step-label">${step.label}</div>
            </div>
          `);
        }

        if (idx < steps.length - 1) {
          let lineClass = 'step-line';
          if (idx < activeIdx - 1) lineClass += ' completed';
          else if (idx === activeIdx - 1) lineClass += ' active';
          htmlParts.push(`<div class="${lineClass}"></div>`);
        }
      });

      container.innerHTML = htmlParts.join('');
    });
  }

  setupAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.audioCtx = new AudioCtx();
    } catch (e) {}
  }

  setupFullScreenSupport() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }

    const updateBtn = () => {
      const btn = document.getElementById('btnKioskFullscreen');
      if (!btn) return;
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      btn.innerHTML = isFs ? '✕ Keluar Full Screen' : '⛶ Layar Penuh';
    };

    document.addEventListener('fullscreenchange', updateBtn);
    document.addEventListener('webkitfullscreenchange', updateBtn);
    updateBtn();

    // If opened with ?fullscreen=1 (from Windows/MacBook/Android Kiosk App), enter fullscreen on first touch/click
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('fullscreen') === '1' || /Android/i.test(navigator.userAgent)) {
      const autoFsHandler = () => {
        this.ensureFullScreen();
        document.removeEventListener('click', autoFsHandler);
        document.removeEventListener('touchstart', autoFsHandler);
      };
      document.addEventListener('click', autoFsHandler, { once: true });
      document.addEventListener('touchstart', autoFsHandler, { once: true });
    }
  }

  async ensureFullScreen() {
    try {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!isFs) {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      }
    } catch (e) {}
  }

  async toggleFullScreen() {
    try {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (isFs) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } else {
        await this.ensureFullScreen();
      }
    } catch (e) {}
  }

  playBeep(freq = 600, duration = 0.15) {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.35, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + duration);
      osc.start();
      osc.stop(this.audioCtx.currentTime + duration);
    } catch (e) {}
  }

  playShutterSound() {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      const now = this.audioCtx.currentTime;
      // Click 1 (mechanical shutter open)
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1400, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);
      gain.gain.setValueAtTime(0.45, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.08);

      // Click 2 (mirror return)
      const osc2 = this.audioCtx.createOscillator();
      const gain2 = this.audioCtx.createGain();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(800, now + 0.09);
      osc2.frequency.exponentialRampToValueAtTime(80, now + 0.18);
      gain2.gain.setValueAtTime(0.35, now + 0.09);
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
      osc2.connect(gain2);
      gain2.connect(this.audioCtx.destination);
      osc2.start(now + 0.09);
      osc2.stop(now + 0.18);
    } catch (e) {}
  }

  // Flash Trigger via Audio Headphone Jack (Godox CT-16 / Strobe) - Universal (MacBook, Windows, iPad, Android)
  buildFlashTriggerWavDataUrl() {
    if (this.flashWavDataUrl) return this.flashWavDataUrl;
    try {
      const sampleRate = 44100;
      const numChannels = 2;
      const durationSec = 0.10; // 100ms pulse
      const numSamples = Math.floor(sampleRate * durationSec);
      const dataByteLen = numSamples * numChannels * 2;
      const buffer = new ArrayBuffer(44 + dataByteLen);
      const view = new DataView(buffer);

      const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + dataByteLen, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * numChannels * 2, true);
      view.setUint16(32, numChannels * 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, dataByteLen, true);

      // Phase-inverted Differential Square Wave (Left = +Max, Right = -Max)
      // Melipatgandakan beda potensial tegangan (2x Voltage) antara Tip & Ring serta Tip/Ring ke Ground
      const freq = 1000;
      const halfPeriod = Math.max(1, Math.floor(sampleRate / (freq * 2)));
      let offset = 44;
      for (let i = 0; i < numSamples; i++) {
        const sign = (Math.floor(i / halfPeriod) % 2 === 0) ? 1 : -1;
        view.setInt16(offset, sign * 32767, true);     // Left channel
        view.setInt16(offset + 2, -sign * 32767, true); // Right channel (inverted phase)
        offset += 4;
      }

      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      this.flashWavDataUrl = 'data:audio/wav;base64,' + btoa(binary);
      return this.flashWavDataUrl;
    } catch (e) {
      return null;
    }
  }

  async refreshAudioFlashOutputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      const sel = document.getElementById('selAudioFlashDevice');
      if (!sel) return;

      // Auto-select Headphone / External / USB audio port if user hasn't manually picked one
      if (!this.audioFlashSinkId && outputs.length > 0) {
        const hp = outputs.find(d => /headphone|headset|external|usb|earphone|aux|line/i.test(d.label || ''));
        if (hp && hp.deviceId && hp.deviceId !== 'default') {
          this.audioFlashSinkId = hp.deviceId;
        }
      }

      sel.innerHTML = '<option value="">🔊 Otomatis (Port Headset / Default Sistem)</option>';
      outputs.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        const lbl = d.label || `Output Audio #${idx + 1}`;
        opt.textContent = /headphone|headset|external/i.test(lbl) ? `🎧 ${lbl}` : `🔊 ${lbl}`;
        if (d.deviceId === this.audioFlashSinkId) opt.selected = true;
        sel.appendChild(opt);
      });
    } catch (e) {}
  }

  async setAudioFlashOutputDevice(sinkId) {
    this.audioFlashSinkId = sinkId || '';
    localStorage.setItem('pb_audio_flash_sink_id', this.audioFlashSinkId);
    if (this.audioCtx && typeof this.audioCtx.setSinkId === 'function') {
      try { await this.audioCtx.setSinkId(this.audioFlashSinkId); } catch (e) {}
    }
    this.showToast('🎧 Port Output Flash Trigger diperbarui!', '⚡', 1800);
  }

  triggerAudioJackFlash() {
    if (!this.audioFlashEnabled) return;
    try {
      // 1. Web Audio API Differential Pulse (L = +1.0, R = -1.0)
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx && AudioCtx) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx) {
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
        if (this.audioFlashSinkId && typeof this.audioCtx.setSinkId === 'function' && this.audioCtx.sinkId !== this.audioFlashSinkId) {
          this.audioCtx.setSinkId(this.audioFlashSinkId).catch(() => {});
        }

        const ctx = this.audioCtx;
        const sampleRate = ctx.sampleRate || 44100;
        const duration = 0.10; // 100ms high-energy pulse
        const buffer = ctx.createBuffer(2, Math.floor(sampleRate * duration), sampleRate);
        const chL = buffer.getChannelData(0);
        const chR = buffer.getChannelData(1);

        const freq = 1000;
        const halfPeriod = Math.max(1, Math.floor(sampleRate / (freq * 2)));
        for (let i = 0; i < buffer.length; i++) {
          const val = (Math.floor(i / halfPeriod) % 2 === 0) ? 1.0 : -1.0;
          chL[i] = val;
          chR[i] = -val; // Phase-inverted for 2x differential voltage across Tip-Ring
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
      }

      // 2. HTML5 <audio> Element WAV Playback (Guarantees output on iPadOS/iOS Safari, Android & Dedicated Sink)
      const wavUrl = this.buildFlashTriggerWavDataUrl();
      if (wavUrl) {
        if (!this.flashAudioElement) {
          this.flashAudioElement = new Audio(wavUrl);
          this.flashAudioElement.volume = 1.0;
        }
        if (this.audioFlashSinkId && typeof this.flashAudioElement.setSinkId === 'function') {
          this.flashAudioElement.setSinkId(this.audioFlashSinkId).catch(() => {});
        }
        this.flashAudioElement.currentTime = 0;
        this.flashAudioElement.play().catch(() => {});
      }

      console.log('⚡ [Godox CT-16] Differential Audio Jack Flash Trigger ditembakkan!');
    } catch (e) {
      console.warn('Audio jack flash error:', e);
    }
  }

  testAudioJackFlash() {
    this.refreshAudioFlashOutputDevices();
    this.triggerAudioJackFlash();
    // Jika kamera Canon / Sony USB aktif, tembakkan sinyal fisik shutter & flash hotshoe ke bridge lokal
    if (this.canonUsbStreamActive || (this.canonUsbBridgeInfo && this.canonUsbBridgeInfo.active)) {
      try {
        fetch('http://127.0.0.1:19898/capture', {
          method: 'POST',
          mode: 'cors',
          cache: 'no-store'
        }).catch(err => console.warn('Canon local flash test error:', err));
      } catch (e) {}
    } else {
      try {
        fetch('/api/camera/trigger-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeoutMs: 2500 })
        }).catch(() => {});
      } catch (e) {}
    }
    this.showToast('⚡ Sinyal Flash Trigger ditembakkan!', '⚡', 2200);
  }

  toggleAudioFlashSetting(enabled) {
    this.audioFlashEnabled = Boolean(enabled);
    localStorage.setItem('pb_audio_flash_enabled', this.audioFlashEnabled ? 'true' : 'false');
    this.showToast(this.audioFlashEnabled ? '⚡ Flash Trigger Headset: AKTIF' : 'Flash Trigger Headset: NONAKTIF', '⚡', 2000);
  }

  setAudioFlashLead(val) {
    this.audioFlashLeadMs = parseInt(val, 10) || 0;
    localStorage.setItem('pb_audio_flash_lead_ms', this.audioFlashLeadMs.toString());
  }

  async fetchTemplates() {
    try {
      const res = await this.fetchWithTimeout(`/api/templates?eventId=${encodeURIComponent(this.eventId)}&booth=kiosk`, { cache: 'no-store' }, 2500);
      if (res.ok) {
        const fetched = await res.json();
        if (Array.isArray(fetched) && fetched.length > 0) {
          this.templates = fetched;
          if (this.selectedTemplate && this.selectedTemplate.id) {
            const freshSelected = this.templates.find(t => t.id === this.selectedTemplate.id);
            if (freshSelected) this.selectedTemplate = freshSelected;
          }
          if (window.pbOfflineStore) {
            window.pbOfflineStore.cacheConfig('templates_' + this.eventId, this.templates);
          }
          this.templates.forEach(t => {
            if (t && t.image_storage_key && !String(t.image_storage_key).startsWith('data:')) {
              const preImg = new Image();
              preImg.src = t.image_storage_key;
            }
          });
        }
      }
    } catch (e) {
      console.warn('Failed to load templates from server, checking local offline cache');
    }

    if (!this.templates || this.templates.length === 0) {
      if (window.pbOfflineStore) {
        const cached = await window.pbOfflineStore.getCachedConfig('templates_' + this.eventId);
        if (cached && cached.length > 0) {
          this.templates = cached;
          console.log(`✅ Memuat ${this.templates.length} template dari cache offline lokal!`);
        }
      }
    }

    if (!this.templates || this.templates.length === 0) {
      this.templates = [
        {
          id: 'tpl_classic_frame',
          name: 'Classic Frame (2x6)',
          orientation: 'strip',
          category: 'wedding',
          image_storage_key: '/assets/templates/strip-green-template.svg',
          slots: [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ]
        },
        {
          id: 'tpl_floral_romance',
          name: 'Floral Romance (2x6)',
          orientation: 'strip',
          category: 'wedding',
          image_storage_key: '/assets/templates/strip-green-template.svg',
          slots: [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ]
        },
        {
          id: 'tpl_retro_film',
          name: 'Retro Film Strip (2x6)',
          orientation: 'strip',
          category: 'retro',
          image_storage_key: '/assets/templates/strip-green-template.svg',
          slots: [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ]
        },
        {
          id: 'tpl_minimal_portrait',
          name: 'Single Elegant (4x6)',
          orientation: 'portrait',
          category: 'portrait',
          image_storage_key: '/assets/templates/single-green-template.svg',
          slots: [
            { id: 'slot_single', pose_index: 1, x: 100, y: 180, width: 1000, height: 1350 }
          ]
        },
        {
          id: 'tpl_colorful_pop',
          name: 'Colorful Pop (2x6)',
          orientation: 'strip',
          category: 'birthday',
          image_storage_key: '/assets/templates/strip-green-template.svg',
          slots: [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ]
        },
        {
          id: 'tpl_polaroid_vintage',
          name: 'Polaroid Classic (4x6)',
          orientation: 'portrait',
          category: 'event',
          image_storage_key: '/assets/templates/single-green-template.svg',
          slots: [
            { id: 'slot_single', pose_index: 1, x: 100, y: 180, width: 1000, height: 1350 }
          ]
        }
      ];
    }
  }

  showScreen(screenId) {
    this.renderStepProgressBars();
    document.querySelectorAll('.kiosk-screen').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) {
      target.classList.add('active');
      this.currentScreen = screenId;
    }
    if (screenId === 'screenCapture' || screenId === 'screenQR') {
      requestAnimationFrame(() => {
        this.wakeUpVideoFeedOnVisibleScreen(screenId);
      });
    }
  }

  isMediaStreamLive() {
    if (!this.mediaStream) return false;
    const tracks = this.mediaStream.getVideoTracks ? this.mediaStream.getVideoTracks() : [];
    if (!tracks || tracks.length === 0) return false;
    return tracks[0].readyState === 'live' && tracks[0].enabled !== false;
  }

  async wakeUpVideoFeedOnVisibleScreen(screenId = 'screenCapture') {
    const video = document.getElementById('videoFeed');
    const qrVideo = document.getElementById('qrVideoFeed');
    const activeVid = screenId === 'screenQR' ? (qrVideo || video) : (video || qrVideo);

    // Jika belum ada stream fisik yang hidup (atau masih virtual simulator), nyalakan kamera sekarang saat <video> sudah visible!
    if (!this.isMediaStreamLive() || this.isVirtualFallbackStream) {
      await this.startCamera();
      return;
    }

    // Jika stream sudah hidup, pastikan HANYA elemen <video> di layar yang sedang aktif yang memegang srcObject
    // (Pada WebKit iPadOS, menempelkan MediaStream UVC yang sama ke #qrVideoFeed yang sedang display:none membekukan decoder #videoFeed!)
    const inactiveVid = screenId === 'screenQR' ? video : qrVideo;
    if (inactiveVid && inactiveVid.srcObject) {
      try {
        inactiveVid.pause();
        inactiveVid.srcObject = null;
      } catch (e) {}
    }

    if (activeVid) {
      activeVid.muted = true;
      activeVid.defaultMuted = true;
      activeVid.playsInline = true;
      activeVid.setAttribute('playsinline', '');
      activeVid.setAttribute('webkit-playsinline', '');
      if (activeVid.srcObject !== this.mediaStream) {
        activeVid.srcObject = this.mediaStream;
      }
      const p = activeVid.play();
      if (p && typeof p.then === 'function') p.catch(() => {});
    }

    this.applyCameraTransform();
    this.updateLiveCameraBadgeUI();

    // Verifikasi apakah frame benar-benar muncul (tidak gelap/hitam di iPadOS UVC seperti DJI Osmo Action 4)
    if (activeVid) {
      this.scheduleUvcStreamHealthVerification(activeVid);
    }
  }

  // State 1 -> State 2: Welcome to QR Scan or Directly to Frame Selection
  async startSession() {
    this.posesCaptured = [null, null, null];
    this.liveClips = [];
    this.cachedPhotoImages = {};
    this.rawPosesSyncedForSession = null;
    this.activePoseIndex = 0;
    this.guestPass = null;
    this.sessionId = null;
    this._sessionFilterManuallyChosen = false;
    this.syncDefaultEventPhotoFilter(true);
    if (this.autoReturnTimerId) clearInterval(this.autoReturnTimerId);

    // Refresh event config & event frames (skip remote wait when Mode Lokal is active; cap timeout when online)
    if (!this.isLocalDirectMode() && navigator.onLine !== false) {
      try {
        await Promise.race([
          Promise.allSettled([
            this.fetchEventConfig(),
            this.fetchTemplates()
          ]),
          new Promise(r => setTimeout(r, 1500))
        ]);
      } catch (e) {
        console.warn('Config refresh skipped on startSession:', e);
      }
    }
    this.syncDefaultEventPhotoFilter(true);
    this.applyCameraImageAdjustToLiveVideo();

    // Jika Mode Lokal aktif atau event diatur Tidak Pakai Pindai QR, langsung masuk ke Pilih Frame (No. 1)
    if (this.isLocalDirectMode() || this.isQrScanDisabled()) {
      this.stopQrScannerLoop();
      this.renderTemplateSelection('all');
      this.showScreen('screenTemplate');
      return;
    }

    // Jika wajib QR, sembunyikan tombol Lewati
    const skipBtn = document.getElementById('btnSkipQr');
    if (skipBtn) {
      skipBtn.style.display = (this.eventConfig && this.eventConfig.qrRequirement === 'required') ? 'none' : '';
    }

    // Buka Layar Pindai QR Tamu (showScreen otomatis membangunkan kamera pada screenQR)
    this.showScreen('screenQR');
    this.loadActiveGuestPassesForKiosk();
    this.startQrScannerLoop();
  }

  goBackFromTemplate() {
    if (this.isQrScanDisabled()) {
      this.showScreen('screenWelcome');
    } else {
      this.showScreen('screenQR');
      this.loadActiveGuestPassesForKiosk();
      this.startQrScannerLoop();
    }
  }

  skipQR() {
    this.stopQrScannerLoop();
    this.guestPass = null;
    this.renderTemplateSelection('all');
    this.showScreen('screenTemplate');
  }

  async generateGuestPassOnSpot() {
    this.stopQrScannerLoop();
    try {
      const res = await fetch('/api/guest-passes/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: this.tenantId,
          eventId: this.eventId,
          baseUrl: window.location.origin
        })
      });
      if (res.ok) {
        this.guestPass = await res.json();
      }
    } catch (e) {}
    this.renderTemplateSelection('all');
    this.showScreen('screenTemplate');
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
      if (navigator.onLine !== false && pool.length <= 15) {
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

      if (pool.length >= targetCount) return;

      const normalizePass = (pass) => ({
        id: pass.id,
        token: pass.token || pass.token_plain,
        token_plain: pass.token_plain || pass.token,
        galleryUrl: pass.galleryUrl,
        fullQrUrl: pass.fullQrUrl,
        qrDataUrl: pass.qrDataUrl
      });

      const needed = targetCount - pool.length;
      if (needed > 1 && navigator.onLine !== false) {
        try {
          const batchRes = await this.fetchWithTimeout('/api/guest-passes/issue-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenantId: this.tenantId,
              eventId: this.eventId,
              baseUrl: window.location.origin,
              count: Math.min(25, needed)
            })
          }, 4500);
          if (batchRes.ok) {
            const batchData = await batchRes.json();
            const list = Array.isArray(batchData)
              ? batchData
              : (Array.isArray(batchData?.passes) ? batchData.passes : (batchData?.id && batchData?.qrDataUrl ? [batchData] : null));
            if (list && list.length > 0) {
              for (const pass of list) {
                if (pass && pass.id && pass.qrDataUrl) pool.push(normalizePass(pass));
              }
              try { localStorage.setItem(key, JSON.stringify(pool)); } catch (e) {}
            }
          }
        } catch (e) {}
      }

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
        pool.push(normalizePass(pass));
        try { localStorage.setItem(key, JSON.stringify(pool)); } catch (e) { break; }
      }
    } catch (e) {
    } finally {
      this._replenishingPassPool = false;
    }
  }

  async ensureGuestPassReady() {
    try {
      if (!this.guestPass) {
        // Mode Lokal / offline: ambil instan (0ms) dari cadangan QR lokal terlebih dahulu bila tersedia
        if (this.isLocalDirectMode() || navigator.onLine === false) {
          const cachedPass = this.popGuestPassFromPool();
          if (cachedPass) {
            this.guestPass = cachedPass;
            return;
          }
        }
        if (navigator.onLine !== false) {
          const res = await this.fetchWithTimeout('/api/guest-passes/issue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenantId: this.tenantId,
              eventId: this.eventId,
              baseUrl: window.location.origin
            })
          }, 1800);
          if (res.ok) {
            this.guestPass = await res.json();
            return;
          }
        }
        // Fallback jika request online gagal/timeout: tetap pakai cadangan pool offline jika ada
        const fallbackPass = this.popGuestPassFromPool();
        if (fallbackPass) this.guestPass = fallbackPass;
      } else if (!this.guestPass.qrDataUrl && navigator.onLine !== false) {
        const token = this.guestPass.token || this.guestPass.token_plain;
        if (token) {
          const res = await this.fetchWithTimeout('/api/kiosk/qr/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, baseUrl: window.location.origin })
          }, 2200);
          if (res.ok) {
            const data = await res.json();
            if (data && data.pass) {
              this.guestPass = { ...this.guestPass, ...data.pass };
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to ensure guest pass QR:', err);
      if (!this.guestPass) {
        const fallbackPass = this.popGuestPassFromPool();
        if (fallbackPass) this.guestPass = fallbackPass;
      }
    }
  }

  renderGuestQrOnPreview() {
    const qrImg = document.getElementById('guestQrCodeImg');
    const qrFallback = document.getElementById('guestQrFallback');
    const qrHint = document.getElementById('kioskQrTapHint');
    const directLink = document.getElementById('guestGalleryDirectLink');
    const infoText = document.getElementById('guestPassInfoText');

    const token = this.guestPass ? (this.guestPass.token || this.guestPass.token_plain) : null;
    const galleryUrl = this.guestPass && this.guestPass.galleryUrl
      ? this.guestPass.galleryUrl
      : (token ? `/gallery/g/${token}` : null);

    if (this.guestPass && this.guestPass.qrDataUrl && qrImg) {
      qrImg.src = this.guestPass.qrDataUrl;
      qrImg.style.display = 'block';
      if (qrFallback) qrFallback.style.display = 'none';
      if (qrHint) qrHint.style.display = 'block';
    } else {
      if (qrImg) qrImg.style.display = 'none';
      if (qrFallback) {
        qrFallback.style.display = 'block';
        qrFallback.innerText = this.isLocalDirectMode()
          ? '🔌 Mode Lokal Aktif — Foto disimpan di laptop'
          : 'QR Siap';
      }
      if (qrHint) qrHint.style.display = 'none';
    }

    if (directLink && galleryUrl) {
      directLink.href = galleryUrl;
      directLink.style.display = 'inline-flex';
    }
    if (infoText && token) {
      infoText.innerHTML = `✨ Terhubung ke Galeri Digital • <strong>Foto + Live + Boomerang</strong>`;
    }
  }

  openQrZoomModal() {
    const qrImg = document.getElementById('guestQrCodeImg');
    const modal = document.getElementById('kioskQrZoomModal');
    const zoomImg = document.getElementById('kioskQrZoomImg');
    const zoomLink = document.getElementById('kioskQrZoomLink');
    const directLink = document.getElementById('guestGalleryDirectLink');
    if (!modal || !zoomImg || !qrImg || !qrImg.src || qrImg.style.display === 'none') return;

    zoomImg.src = qrImg.src;
    if (zoomLink) {
      const href = directLink && directLink.style.display !== 'none' ? directLink.getAttribute('href') : '';
      if (href && href !== '#') {
        zoomLink.href = href;
        zoomLink.style.display = 'inline-flex';
      } else {
        zoomLink.style.display = 'none';
      }
    }
    modal.style.display = 'flex';
  }

  closeQrZoomModal(event) {
    if (event && event.target && event.target.closest('.photo-modal-card') && !event.target.classList.contains('photo-modal-close') && event.target.tagName !== 'BUTTON') {
      return;
    }
    const modal = document.getElementById('kioskQrZoomModal');
    if (modal) modal.style.display = 'none';
  }

  returnToCameraFromPreview() {
    if (this.autoReturnTimerId) clearInterval(this.autoReturnTimerId);
    const tplSlotsCount = (this.selectedTemplate && this.selectedTemplate.slots && this.selectedTemplate.slots.length > 0)
      ? this.getSlotsUniquePoseCount(this.selectedTemplate.slots)
      : ((this.selectedMode === 'strip') ? 3 : 1);
    if (tplSlotsCount > this.totalPosesRequired) {
      this.totalPosesRequired = tplSlotsCount;
    }
    while (this.posesCaptured.length < this.totalPosesRequired) {
      this.posesCaptured.push(null);
    }
    const nextEmpty = this.posesCaptured.findIndex(p => p === null);
    this.activePoseIndex = nextEmpty !== -1 ? nextEmpty : 0;
    this.showScreen('screenCapture');
    this.renderFilmstripDock();
  }

  async loadActiveGuestPassesForKiosk() {
    const sel = document.getElementById('kioskGuestPassQuickSelect');
    const badge = document.getElementById('kioskPassCountBadge');
    if (!sel || !navigator.onLine) return;
    try {
      const res = await this.fetchWithTimeout(`/api/kiosk/guest-passes?eventId=${encodeURIComponent(this.eventId)}`, {}, 2000);
      if (!res.ok) return;
      const passes = await res.json();
      this.cachedKioskPasses = passes;
      if (badge) badge.innerText = `${passes.length} Kartu Terdaftar`;
      sel.innerHTML = `<option value="">-- Pilih Kartu Tamu (Tamu #1, Tamu #2, dst) --</option>` +
        passes.map(p => `
          <option value="${p.token_plain}">Tamu #${p.guestNumber} (${p.session_count > 0 ? p.session_count + ' Sesi Tersimpan' : 'Belum Foto'})</option>
        `).join('');
    } catch (e) {}
  }

  selectGuestPassFromDropdown() {
    const sel = document.getElementById('kioskGuestPassQuickSelect');
    if (!sel || !sel.value) {
      alert('Pilih salah satu kartu tamu terlebih dahulu.');
      return;
    }
    this.resolveScannedToken(sel.value);
  }

  async resolveScannedToken(token) {
    if (!token) return;
    this.stopQrScannerLoop();
    const fbText = document.getElementById('qrScanFeedbackText');
    const fbDot = document.getElementById('qrScanDot');
    if (fbText) fbText.innerText = 'Memverifikasi kartu QR...';

    try {
      const res = await fetch('/api/kiosk/qr/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, baseUrl: window.location.origin })
      });
      const data = await res.json();
      if (res.ok && data.valid && data.pass) {
        const matched = (this.cachedKioskPasses || []).find(p => p.token_plain === data.pass.token_plain);
        this.guestPass = {
          ...(matched || {}),
          ...data.pass
        };
        const guestName = matched ? `Tamu #${matched.guestNumber}` : 'Tamu Spesial';

        if (fbText) fbText.innerText = `✅ Kartu Terhubung: Halo ${guestName}! Foto otomatis tersimpan di HP Anda.`;
        if (fbDot) fbDot.style.background = '#27ae60';

        setTimeout(() => {
          this.renderTemplateSelection('all');
          this.showScreen('screenTemplate');
        }, 800);
        return;
      } else {
        if (fbText) fbText.innerText = '❌ QR tidak dikenali. Silakan coba kartu lain.';
        setTimeout(() => { this.startQrScannerLoop(); }, 1500);
      }
    } catch (err) {
      if (fbText) fbText.innerText = 'Gagal memverifikasi kartu QR.';
      setTimeout(() => { this.startQrScannerLoop(); }, 1500);
    }
  }

  startQrScannerLoop() {
    this.stopQrScannerLoop();
    const fbText = document.getElementById('qrScanFeedbackText');
    const fbDot = document.getElementById('qrScanDot');
    if (fbText) fbText.innerText = 'Mendeteksi kartu QR di depan kamera...';
    if (fbDot) fbDot.style.background = 'var(--coral)';

    if (!('BarcodeDetector' in window)) {
      if (fbText) fbText.innerText = 'Browser ini belum mendukung auto-scan QR kamera — ketik/tempel kode di bawah.';
      if (fbDot) fbDot.style.background = '#e5a823';
      return;
    }

    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const video = document.getElementById('qrVideoFeed');
      let isDetecting = false;

      this.qrScannerInterval = setInterval(async () => {
        if (document.hidden || isDetecting || !video || video.readyState < 2) return;
        isDetecting = true;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length > 0) {
            const rawValue = codes[0].rawValue;
            if (rawValue) {
              this.resolveScannedToken(rawValue);
            }
          }
        } catch (e) {
        } finally {
          isDetecting = false;
        }
      }, 500);
    } catch (e) {}
  }

  stopQrScannerLoop() {
    if (this.qrScannerInterval) {
      clearInterval(this.qrScannerInterval);
      this.qrScannerInterval = null;
    }
  }

  selectMode(mode, element) {
    this.selectedMode = mode;
    this.totalPosesRequired = (mode === 'strip') ? 3 : 1;
    document.querySelectorAll('.mode-card').forEach(el => el.classList.remove('selected'));
    if (element) element.classList.add('selected');
  }

  proceedFromMode() {
    this.renderTemplateSelection();
    this.showScreen('screenTemplate');
  }

  async openTemplateChooserDirectly() {
    try {
      if (navigator.onLine !== false) {
        await Promise.race([this.fetchTemplates(), new Promise(r => setTimeout(r, 1200))]);
      }
    } catch (e) {}
    this.renderTemplateSelection('all');
    this.showScreen('screenTemplate');
  }

  // Feature Pill 1: Foto Langsung -> Fast Direct Camera Capture
  startDirectCapture() {
    this.posesCaptured = [null, null, null];
    this.liveClips = [];
    this.cachedPhotoImages = {};
    this.rawPosesSyncedForSession = null;
    this.activePoseIndex = 0;
    this.guestPass = null;
    this.sessionId = null;
    if (this.autoReturnTimerId) clearInterval(this.autoReturnTimerId);

    // Default to the first template (Classic Frame) and launch capture
    this.selectedTemplate = this.templates[0] || null;
    this.startCountdownSequence();
  }

  // Feature Pill 3: Cetak / Digital info modal
  openPrintInfoModal() {
    const modal = document.getElementById('infoPrintModal');
    if (modal) modal.style.display = 'flex';
  }

  // Feature Pill 4: Tips Pose Seru & Mudah modal
  openFunTipsModal() {
    const modal = document.getElementById('infoFunModal');
    if (modal) modal.style.display = 'flex';
  }

  closeInfoModals(event) {
    if (event && event.target && event.target.closest('.photo-modal-card') && !event.target.classList.contains('photo-modal-close') && event.target.tagName !== 'BUTTON') {
      return;
    }
    const printModal = document.getElementById('infoPrintModal');
    const funModal = document.getElementById('infoFunModal');
    if (printModal) printModal.style.display = 'none';
    if (funModal) funModal.style.display = 'none';
  }

  filterTemplates(category, element) {
    document.querySelectorAll('.filter-tab').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');
    this.renderTemplateSelection(category);
  }

  getSlotsUniquePoseCount(slots) {
    if (!Array.isArray(slots) || slots.length === 0) return 1;
    const poseNums = slots.map((s, idx) => Math.max(1, parseInt(s.pose_index, 10) || (idx + 1)));
    const uniquePoses = new Set(poseNums);
    const maxPoseIdx = Math.max(...poseNums);
    return Math.max(uniquePoses.size, maxPoseIdx);
  }

  resolveTemplatePosesCount(tpl) {
    const mode = tpl && tpl.shots_mode ? String(tpl.shots_mode).trim() : 'event';
    // 1. Jika template disetel eksplisit jumlah pose (1..10)
    const explicitNum = parseInt(mode, 10);
    if (!isNaN(explicitNum) && explicitNum >= 1 && explicitNum <= 10) {
      return explicitNum;
    }
    // 2. Jika template disetel mengikuti jumlah lubang foto frame ('slots') — pose duplikat dihitung 1x pose
    if (mode === 'slots') {
      if (tpl && Array.isArray(tpl.slots) && tpl.slots.length > 0) {
        return this.getSlotsUniquePoseCount(tpl.slots);
      }
    }
    // 3. Default ('event'): ikut pengaturan Event aktif (atau event_shots_count dari template)
    if (this.eventConfig && this.eventConfig.shotsCount) {
      const evCount = parseInt(this.eventConfig.shotsCount, 10);
      if (!isNaN(evCount) && evCount >= 1) return evCount;
    }
    if (tpl && tpl.event_shots_count) {
      const tplEvCount = parseInt(tpl.event_shots_count, 10);
      if (!isNaN(tplEvCount) && tplEvCount >= 1) return tplEvCount;
    }
    if (tpl && Array.isArray(tpl.slots) && tpl.slots.length > 0) {
      return this.getSlotsUniquePoseCount(tpl.slots);
    }
    return (tpl && tpl.orientation === 'strip') ? 3 : 1;
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

  setTemplateOrientFilter(orient) {
    this.templateOrientFilter = orient || 'all';
    document.querySelectorAll('#templateOrientFilterRow .preview-slot-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-orient') === this.templateOrientFilter);
    });
    this.renderTemplateSelection('all');
  }

  setCameraCaptureOrientation(mode = 'auto') {
    const clean = ['auto', 'portrait', 'landscape'].includes(mode) ? mode : 'auto';
    this.cameraCaptureOrientation = clean;
    try {
      localStorage.setItem('pb_camera_capture_orientation', clean);
    } catch (e) {}

    if (clean === 'portrait') {
      if (this.cameraAspectRatio !== '2/3' && this.cameraAspectRatio !== '3/4') {
        this.setCameraAspectRatio('2/3');
      }
    } else if (clean === 'landscape') {
      if (this.cameraAspectRatio === '2/3' || this.cameraAspectRatio === '3/4' || !this.cameraAspectRatio) {
        this.setCameraAspectRatio('3/2');
      }
    } else if (this.selectedTemplate) {
      this.applyCameraOrientationForTemplate(this.selectedTemplate);
    }

    this.updateCameraCaptureOrientationUI();
  }

  updateCameraCaptureOrientationUI() {
    const mode = this.cameraCaptureOrientation || 'auto';
    document.querySelectorAll('#templateCameraOrientRow .preview-slot-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-cam-orient') === mode);
    });

    const isPortraitRatio = (this.cameraAspectRatio === '2/3' || this.cameraAspectRatio === '3/4');
    const isPort = mode === 'portrait' || (mode === 'auto' && isPortraitRatio);
    const btnP = document.getElementById('btnCaptureOrientPortrait');
    const btnL = document.getElementById('btnCaptureOrientLandscape');
    if (btnP) {
      btnP.style.background = isPort ? 'var(--coral)' : 'transparent';
      btnP.style.color = '#ffffff';
    }
    if (btnL) {
      btnL.style.background = !isPort ? 'var(--coral)' : 'transparent';
      btnL.style.color = '#ffffff';
    }
  }

  applyCameraOrientationForTemplate(tpl) {
    const pref = this.cameraCaptureOrientation || 'auto';
    if (pref === 'landscape') {
      if (this.cameraAspectRatio === '2/3' || this.cameraAspectRatio === '3/4' || !this.cameraAspectRatio) {
        this.setCameraAspectRatio('3/2');
      } else {
        this.applyCameraTransform();
      }
      this.updateCameraCaptureOrientationUI();
      return;
    }
    if (pref === 'portrait') {
      if (this.cameraAspectRatio !== '2/3' && this.cameraAspectRatio !== '3/4') {
        this.setCameraAspectRatio('2/3');
      } else {
        this.applyCameraTransform();
      }
      this.updateCameraCaptureOrientationUI();
      return;
    }

    if (!tpl) return;
    const isLandTpl = this.isTemplateLandscape(tpl);
    const slots = Array.isArray(tpl.slots) ? tpl.slots : [];
    const primarySlot = slots[0];
    const slotIsPortrait = primarySlot && primarySlot.height > primarySlot.width * 1.08;

    if (isLandTpl) {
      // Pilih bingkai Lanskap -> kamera & viewport lanskap
      if (this.cameraAspectRatio === '2/3' || this.cameraAspectRatio === '3/4' || !this.cameraAspectRatio) {
        this.setCameraAspectRatio('3/2');
      } else {
        this.applyCameraTransform();
      }
    } else if (tpl.orientation !== 'strip' && slotIsPortrait) {
      // Single Frame Potret dengan slot tegak
      if (this.cameraAspectRatio === '16/9' || this.cameraAspectRatio === '3/2' || this.cameraAspectRatio === '4/3') {
        this.setCameraAspectRatio('2/3');
      } else {
        this.applyCameraTransform();
      }
    } else if (this.cameraAspectRatio === '2/3' || this.cameraAspectRatio === '3/4') {
      // Strip 2x6 biasanya punya slot foto mendatar (3:2 / 4:3)
      this.setCameraAspectRatio('3/2');
    } else {
      this.applyCameraTransform();
    }
    this.updateCameraCaptureOrientationUI();
  }

  applyPreviewOrientationLayout(tplWidth, tplHeight) {
    const isLand = tplWidth > tplHeight;
    const studioGrid = document.getElementById('previewStudioGrid');
    const stage = document.getElementById('previewCanvasStage');
    const finalCanvas = document.getElementById('finalCanvas');
    if (studioGrid) studioGrid.classList.toggle('is-landscape', isLand);
    if (stage) stage.classList.toggle('is-landscape', isLand);
    if (finalCanvas) {
      finalCanvas.classList.toggle('is-landscape', isLand);
      if (tplWidth > 0 && tplHeight > 0) {
        finalCanvas.style.aspectRatio = `${tplWidth} / ${tplHeight}`;
      }
    }
  }

  renderTemplateSelection(filter = 'all') {
    const container = document.getElementById('templateListContainer');
    container.innerHTML = '';

    let filtered = this.templates;
    if (filter === 'wedding') {
      filtered = this.templates.filter(t => t.category === 'wedding' || t.orientation === 'strip');
    } else if (filter === 'birthday') {
      filtered = this.templates.filter(t => t.category === 'birthday' || t.category === 'event');
    } else if (filter === 'event') {
      filtered = this.templates.filter(t => t.category === 'event' || t.category === 'retro');
    } else if (filter === 'strip') {
      filtered = this.templates.filter(t => t.orientation === 'strip');
    } else if (filter === 'portrait') {
      filtered = this.templates.filter(t => t.orientation !== 'strip');
    } else if (filter === 'retro') {
      filtered = this.templates.filter(t => t.category === 'retro' || t.orientation === 'strip');
    }

    const orientFilter = this.templateOrientFilter || 'all';
    if (orientFilter === 'portrait') {
      filtered = filtered.filter(t => !this.isTemplateLandscape(t));
    } else if (orientFilter === 'landscape') {
      filtered = filtered.filter(t => this.isTemplateLandscape(t));
    }

    const displayTemplates = filtered.length > 0 ? filtered : (orientFilter === 'all' ? this.templates : []);

    if (displayTemplates.length === 0) {
      const lbl = orientFilter === 'landscape' ? 'Lanskap' : 'Potret';
      container.innerHTML = `<div style="padding: 32px; text-align: center; color: var(--text-muted); font-weight: 700;">Belum ada template ${lbl} di event ini.</div>`;
      return;
    }

    displayTemplates.forEach((tpl, idx) => {
      const poseCount = this.resolveTemplatePosesCount(tpl);
      const formatBadge = this.getTemplateFormatLabel(tpl);
      const card = document.createElement('div');
      card.className = `template-retro-card ${idx === 0 ? 'selected' : ''}`;
      card.onclick = () => {
        document.querySelectorAll('.template-retro-card').forEach(el => el.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedTemplate = tpl;
        this.selectedMode = tpl.orientation === 'strip' ? 'strip' : 'single';
        this.totalPosesRequired = this.resolveTemplatePosesCount(tpl);
        this.applyCameraOrientationForTemplate(tpl);
      };
      card.innerHTML = `
        <div class="template-check-badge">✓</div>
        <div style="height: 180px; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; background: #FFFBF5; border-radius: 18px; border: 2px dashed #EAD8C7; overflow: hidden; padding: 8px;">
          <img src="${tpl.image_storage_key}" style="max-height: 100%; max-width: 100%; object-fit: contain;">
        </div>
        <div style="display: flex; gap: 4px; justify-content: center; flex-wrap: wrap; margin-bottom: 6px;">
          <span class="badge-pill ${tpl.orientation === 'strip' ? 'badge-coral' : 'badge-active'}" style="font-size: 11px;">
            📸 ${poseCount}x Pose
          </span>
          <span class="badge-pill" style="font-size: 11px; background: rgba(212,167,84,0.18); color: #7a581a; border: 1px solid rgba(212,167,84,0.4);">
            ${formatBadge}
          </span>
        </div>
        <h4 style="font-size: 16px; font-weight: 700; color: #7B482E; margin-top: 4px; font-family: var(--font-heading);">${tpl.name}</h4>
      `;
      container.appendChild(card);
    });

    this.selectedTemplate = displayTemplates[0];
    this.selectedMode = this.selectedTemplate.orientation === 'strip' ? 'strip' : 'single';
    this.totalPosesRequired = this.resolveTemplatePosesCount(this.selectedTemplate);
  }

  // Camera 3-Button Control Bar Handlers (Gambar 2 Screen 3)
  handleShutterClick() {
    if (this.isCapturingSnap) return;

    // 1. Jika preview foto barusan sedang tampil:
    // Tutup preview hasil foto dan masuk ke tampilan Live Camera pose berikutnya TANPA langsung hitung mundur,
    // supaya para tamu bisa melihat kamera live dan menyusun posisi/gaya terlebih dahulu!
    const holdOverlay = document.getElementById('postCapturePreviewOverlay');
    if (holdOverlay && holdOverlay.style.display !== 'none') {
      this.finishPostCaptureHold();
      return;
    }

    // 2. Jika sedang countdown (3, 2, 1), klik shutter = instant snap
    if (this.isCountingDown) {
      this.triggerManualSnap();
      return;
    }

    // 3. Jika standby di live camera, klik shutter / live photo / volume down = mulai countdown untuk pose aktif
    let target = this.activePoseIndex;
    if (target === null || target === undefined || target >= this.totalPosesRequired) {
      target = this.posesCaptured.findIndex(p => p === null);
      if (target === -1) target = 0;
    }
    this.startCountdown(target);
  }

  handleCameraViewportClick(event) {
    if (event && event.target && event.target.closest && event.target.closest('button')) {
      return; // Jangan override tombol retake atau lanjut di dalam overlay
    }
    this.handleShutterClick();
  }

  setupKeyboardRemoteListeners() {
    const fireRemoteShutter = (sourceLabel) => {
      const screenCapture = document.getElementById('screenCapture');
      const isCaptureActive = screenCapture && screenCapture.classList.contains('active');
      if (!isCaptureActive) return false;

      // Jangan trigger bila modal sedang terbuka
      const photoModal = document.getElementById('photoPreviewModal');
      if (photoModal && photoModal.style.display === 'flex') return false;
      const pinModal = document.getElementById('operatorPinModal');
      if (pinModal && pinModal.style.display === 'flex') return false;

      // Debounce 350ms untuk mencegah double trigger dari keydown + keyup / mouse click remote bluetooth
      const now = Date.now();
      if (this._lastRemoteTriggerTime && (now - this._lastRemoteTriggerTime < 350)) {
        return true;
      }
      this._lastRemoteTriggerTime = now;

      console.log('📸 [Remote Shutter Triggered]:', sourceLabel);
      this.showToast('📸 Sinyal Shutter Diterima!', '⚡', 900);
      this.handleShutterClick();
      return true;
    };

    const keyTrigger = (e) => {
      const screenCapture = document.getElementById('screenCapture');
      const isCaptureActive = screenCapture && screenCapture.classList.contains('active');
      if (!isCaptureActive) return;

      // Abaikan jika user sedang mengetik di input/textarea
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        return;
      }

      // Abaikan shortcut browser (Cmd+R, Ctrl+F5, F11, F12, Escape, dll)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const keyName = (e.key || '').toLowerCase();
      const codeName = (e.code || '').toLowerCase();
      const keyCode = e.keyCode || e.which;

      if (keyName === 'escape' || keyName === 'f5' || keyName === 'f11' || keyName === 'f12' || keyName === 'tab') {
        return;
      }

      // 1. Tombol Perkecil Volume & Perbesar Volume (AudioVolumeDown / AudioVolumeUp / 174 / 175 / 182 / 183)
      const isVolumeKey = keyName.includes('volume') ||
                          codeName.includes('volume') ||
                          keyCode === 174 || keyCode === 175 || keyCode === 182 || keyCode === 183;

      // 2. Tombol Enter / Return / Spasi (dikirim oleh remote Bluetooth seperti ADYSS-A7 & J09)
      const isEnterOrSpace = keyName === 'enter' || codeName === 'enter' || keyCode === 13 ||
                             keyName === ' ' || keyName === 'space' || codeName === 'space' || keyCode === 32;

      // 3. Tombol Arrow / PageUp / PageDown / F13-F15 (dikirim oleh ring remote Bluetooth / presenter clicker)
      const isNavRemoteKey = keyName.startsWith('arrow') || codeName.startsWith('arrow') ||
                             keyName === 'pageup' || keyName === 'pagedown' ||
                             keyName === 'f13' || keyName === 'f14' || keyName === 'f15' ||
                             (keyCode >= 33 && keyCode <= 40);

      // 4. Tombol Media / Camera shutter hardware
      const isMediaShutter = keyName.includes('media') ||
                             codeName.includes('media') ||
                             keyName === 'camera' ||
                             codeName === 'camera' ||
                             (keyCode >= 176 && keyCode <= 179);

      if (isVolumeKey || isEnterOrSpace || isNavRemoteKey || isMediaShutter) {
        e.preventDefault();
        e.stopPropagation();
        fireRemoteShutter({ key: e.key, code: e.code, keyCode });
      }
    };

    window.addEventListener('keydown', keyTrigger, { capture: true });
    window.addEventListener('keyup', keyTrigger, { capture: true });

    // Dukung juga remote Bluetooth tipe Mouse/Ring (seperti J09) yang mengirim klik mouse di area bebas screenCapture
    const screenCaptureEl = document.getElementById('screenCapture');
    if (screenCaptureEl && !screenCaptureEl._hasRemoteMouseBound) {
      screenCaptureEl._hasRemoteMouseBound = true;
      screenCaptureEl.addEventListener('click', (e) => {
        if (!screenCaptureEl.classList.contains('active')) return;
        const t = e.target;
        if (!t || !t.closest) return;
        // Abaikan jika klik pada tombol kontrol atas, dock foto bawah, atau tombol spesifik
        if (
          t.closest('button') ||
          t.closest('a') ||
          t.closest('#kioskGlobalControls') ||
          t.closest('#kioskOfflineBadge') ||
          t.closest('#filmstripDock') ||
          t.closest('.camera-retro-frame') // sudah ditangani oleh handleCameraViewportClick
        ) {
          return;
        }
        fireRemoteShutter('screenCapture-background-click');
      });
    }

    // Dukung MediaSession hardware remote actions
    if ('mediaSession' in navigator) {
      ['play', 'pause', 'previoustrack', 'nexttrack'].forEach((action) => {
        try {
          navigator.mediaSession.setActionHandler(action, () => {
            fireRemoteShutter(`mediaSession:${action}`);
          });
        } catch (err) {}
      });
    }
  }

  handleQuickRetake() {
    let target = this.posesCaptured.map((p, idx) => p !== null ? idx : -1).filter(idx => idx !== -1).pop();
    if (target === undefined || target === -1) {
      target = 0;
    }
    this.retakeSinglePose(target);
  }

  toggleThumbnailsDock() {
    const dock = document.getElementById('filmstripDock');
    if (dock) {
      dock.scrollIntoView({ behavior: 'smooth' });
      dock.classList.toggle('dock-highlight');
      setTimeout(() => dock.classList.remove('dock-highlight'), 1200);
    }
  }

  getUvcResolutionDims(resMode, deviceLabel = '') {
    const isIpadOs = (navigator.userAgent.includes('Macintosh') && (navigator.maxTouchPoints > 1)) || /iPad|CriOS/i.test(navigator.userAgent || '');
    const isMobileDevice = /Android|iPhone|iPod/i.test(navigator.userAgent || '') || isIpadOs;
    // Jangan biarkan setelan global 1080p dari laptop memaksa iPad membuka 1080p kecuali user menekan tombol resolusi di iPad
    const mode = resMode || (isMobileDevice ? (localStorage.getItem('pb_ipad_uvc_resolution') || 'auto_canon') : (this.cameraConfig?.uvcResolution || localStorage.getItem('pb_uvc_resolution') || 'auto_canon'));
    const isUvc03OrCaptureCard = /uvc03|1de1:f113|display capture|usb video|hdmi|capture/i.test(deviceLabel || '');
    const isOsmoOrActionCam = /osmo|action|dji|gopro|insta360/i.test(deviceLabel || '');

    if (mode === '480p') {
      return { width: 640, height: 480, label: '480p' };
    }
    if (mode === '720p') {
      return { width: 1280, height: 720, label: '720p' };
    }
    if (mode === '1080p') {
      return { width: 1920, height: 1080, label: '1080p' };
    }
    // Mode 'auto_canon':
    // 1. Jika DJI Osmo Action 4 / Action cam UVC: gunakan 720p (1280x720 @ 30fps) sebagai default paling stabil di kabel USB-C iPad
    if (isOsmoOrActionCam) {
      return { width: 1280, height: 720, label: '720p' };
    }
    // 2. Jika menggunakan Display capture-UVC03 (1de1:f113) / Capture Card HDMI + Canon 1300D,
    // gunakan 640x480 sebagai default agar TIDAK muncul layar hitam "HDMI resolution is smaller than UVC capture"
    if (isUvc03OrCaptureCard) {
      return { width: 640, height: 480, label: '480p' };
    }
    return { width: 1280, height: 720, label: '720p' };
  }

  updateUvcResolutionButtonsUI(activeLabel) {
    const map = {
      '480p': document.getElementById('btnUvcRes480'),
      '720p': document.getElementById('btnUvcRes720'),
      '1080p': document.getElementById('btnUvcRes1080')
    };
    Object.entries(map).forEach(([key, btn]) => {
      if (!btn) return;
      if (key === activeLabel) {
        btn.style.background = 'var(--coral)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'var(--coral)';
      } else {
        btn.style.background = '#fff';
        btn.style.color = 'var(--caramel-brown)';
        btn.style.borderColor = 'var(--border-soft)';
      }
    });
  }

  async checkCanonUsbBridgeStatus() {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch('http://127.0.0.1:19898/status', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(tid);
      if (res.ok) {
        const data = await res.json();
        if (data && data.active) {
          this.canonUsbBridgeInfo = data;
          return data;
        }
      }
    } catch (e) {}
    this.canonUsbBridgeInfo = null;
    return null;
  }

  startCanonUsbAutoDetector() {
    if (this.canonAutoDetectInterval) clearInterval(this.canonAutoDetectInterval);
    this.canonAutoDetectInterval = setInterval(async () => {
      if (document.hidden) return;
      const info = await this.checkCanonUsbBridgeStatus();
      if (info && info.active && !this.canonUsbStreamActive && !this.__mafazaPreferWebCamera) {
        // Otomatis aktifkan kamera USB (Canon / Sony / Nikon / PTP) begitu terdeteksi aktif
        await this.onQuickCameraSelectChange('canon_usb_direct');
      }
    }, 2500);
  }

  async onNativeCameraInventoryChanged() {
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
      const devs = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devs.filter(d => d && d.kind === 'videoinput');
      const activeTrack = this.mediaStream?.getVideoTracks?.()[0];
      const activeId = this.canonUsbStreamActive ? 'canon_usb_direct' : (activeTrack?.getSettings?.()?.deviceId || '');
      this.populateQuickCameraSelect(videoInputs, activeId);
      if (this.canonUsbStreamActive || this.__mafazaPreferWebCamera) return;
      const extRegex = /osmo|action|dji|gopro|insta360|uvc|usb|hdmi|capture|canon|sony|nikon|fuji|elgato/i;
      const extCam = videoInputs.find(d => extRegex.test(d.label || ''));
      const curLabel = activeTrack?.label || '';
      const onExt = extRegex.test(curLabel);
      if (!this.isMediaStreamLive() || this.isVirtualFallbackStream || (extCam && !onExt)) {
        await this.startCamera(null, true);
      }
    } catch (e) {}
  }

  async startCanonUsbDirectStream(bridgeInfo) {
    if (this.canonUsbLoopTimer) {
      clearTimeout(this.canonUsbLoopTimer);
      this.canonUsbLoopTimer = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    if (bridgeInfo) {
      this.syncCanonHardwareControlsUI(bridgeInfo);
    }

    const w = (bridgeInfo && bridgeInfo.width) || 1056;
    const h = (bridgeInfo && bridgeInfo.height) || 704;
    if (!this.canonUsbCanvas) {
      this.canonUsbCanvas = document.createElement('canvas');
      this.canonUsbCanvas.id = 'canonUsbDirectCanvas';
    }
    this.canonUsbCanvas.width = w;
    this.canonUsbCanvas.height = h;
    const ctx = this.canonUsbCanvas.getContext('2d');

    // Fill warm dark background initially before first JPEG frame arrives
    ctx.fillStyle = '#1A120E';
    ctx.fillRect(0, 0, w, h);

    // Mount canvas directly inside #cameraRetroFrame so Android WebView & Desktop render Live View directly
    // without relying on <video> captureStream() or showing any default Play triangle icon
    const retroFrame = document.getElementById('cameraRetroFrame');
    if (retroFrame) {
      if (this.canonUsbCanvas.parentElement !== retroFrame) {
        this.canonUsbCanvas.style.position = 'absolute';
        this.canonUsbCanvas.style.inset = '0';
        this.canonUsbCanvas.style.width = '100%';
        this.canonUsbCanvas.style.height = '100%';
        this.canonUsbCanvas.style.pointerEvents = 'none';
        this.canonUsbCanvas.style.zIndex = '2';
        retroFrame.insertBefore(this.canonUsbCanvas, retroFrame.firstChild);
      }
      this.canonUsbCanvas.style.display = 'block';
    }

    this.canonUsbStreamActive = true;
    let frameFailCount = 0;
    const drawNextFrame = async () => {
      if (!this.canonUsbStreamActive) return;
      try {
        const res = await fetch(`http://127.0.0.1:19898/frame.jpg?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('Frame unavailable');
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        if (!this.canonUsbStreamActive) {
          bmp.close();
          return;
        }
        frameFailCount = 0;
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        this.canonUsbLoopTimer = setTimeout(drawNextFrame, 42);
      } catch (err) {
        if (!this.canonUsbStreamActive) return;
        frameFailCount++;
        if (frameFailCount === 15 || frameFailCount % 30 === 0) {
          ctx.fillStyle = '#1A120E';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = '#FFF9F2';
          ctx.font = 'bold 26px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Menyambung ulang ke Canon EOS...', w / 2, h / 2 - 14);
          ctx.fillStyle = '#F5B895';
          ctx.font = '18px sans-serif';
          ctx.fillText('Pastikan kamera ON & EOS Webcam Utility tertutup', w / 2, h / 2 + 22);
        }
        this.canonUsbLoopTimer = setTimeout(drawNextFrame, 220);
      }
    };

    drawNextFrame();
    try {
      this.mediaStream = this.canonUsbCanvas.captureStream(24);
    } catch (e) {}
    const transparentGif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const video = document.getElementById('videoFeed');
    const qrVideo = document.getElementById('qrVideoFeed');
    if (video) {
      video.setAttribute('poster', transparentGif);
      if (this.mediaStream) video.srcObject = this.mediaStream;
    }
    if (qrVideo) {
      qrVideo.setAttribute('poster', transparentGif);
      if (this.mediaStream) qrVideo.srcObject = this.mediaStream;
    }
    this.applyCameraTransform();
    this.applyCameraImageAdjustToLiveVideo();
  }

  toggleCameraSettingsDrawer(forceState = null) {
    const drawer = document.getElementById('kioskCameraSettingsDrawer');
    if (!drawer) return;
    const isHidden = drawer.style.display === 'none' || !drawer.style.display;
    const nextShow = forceState !== null ? Boolean(forceState) : isHidden;
    drawer.style.display = nextShow ? 'flex' : 'none';
    if (nextShow) {
      this.loadSavedCameraImageAdjust();
      this.refreshAudioFlashOutputDevices();
      this.checkCanonUsbBridgeStatus().then(info => {
        if (info) this.syncCanonHardwareControlsUI(info);
      });
    }
  }

  syncCanonHardwareControlsUI(info) {
    if (!info) return;
    const isoEl = document.getElementById('canonSelectIso');
    const tvEl = document.getElementById('canonSelectTv');
    const avEl = document.getElementById('canonSelectAv');
    const wbEl = document.getElementById('canonSelectWb');
    const hintEl = document.getElementById('canonHwStatusHint');

    if (isoEl && info.iso !== undefined) {
      const valStr = String(info.iso);
      if (Array.from(isoEl.options).some(o => o.value === valStr)) {
        isoEl.value = valStr;
      }
    }
    if (tvEl && info.tv !== undefined && info.tv > 0) {
      const valStr = String(info.tv);
      if (Array.from(tvEl.options).some(o => o.value === valStr)) {
        tvEl.value = valStr;
      }
    }
    if (avEl && info.av !== undefined && info.av > 0) {
      const valStr = String(info.av);
      if (Array.from(avEl.options).some(o => o.value === valStr)) {
        avEl.value = valStr;
      }
    }
    if (wbEl && info.wb !== undefined) {
      const valStr = String(info.wb);
      if (Array.from(wbEl.options).some(o => o.value === valStr)) {
        wbEl.value = valStr;
      }
    }
    if (hintEl && info.active) {
      const modeNames = { 0: 'P (Program)', 1: 'Tv', 2: 'Av', 3: 'M (Manual)', 4: 'Bulb' };
      const modeLabel = modeNames[info.aeMode] || `Mode #${info.aeMode ?? 0}`;
      hintEl.innerHTML = `✅ <strong>${info.camera || 'Canon EOS 1300D'}</strong> Terhubung (${modeLabel})`;
      hintEl.style.color = '#2ECC71';
    }
  }

  async setCanonHardwareProperty(propName, value) {
    const hintEl = document.getElementById('canonHwStatusHint');
    if (hintEl) {
      hintEl.innerText = `⏳ Mengirim pengaturan ${propName.toUpperCase()} ke kamera Canon...`;
      hintEl.style.color = 'var(--coral)';
    }
    try {
      const res = await fetch(`http://127.0.0.1:19898/control?${encodeURIComponent(propName)}=${encodeURIComponent(value)}&t=${Date.now()}`, {
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        this.syncCanonHardwareControlsUI(data);
        if (data && data.cmdError === 0) {
          this.showToast(`Setelan ${propName.toUpperCase()} kamera berhasil diubah! ✨`, '📷', 1600);
        } else if (hintEl) {
          hintEl.innerText = `⚠️ Pastikan roda mode kamera di posisi M / Av / P agar ${propName.toUpperCase()} bisa diubah.`;
          hintEl.style.color = '#D97706';
        }
      }
    } catch (err) {
      if (hintEl) {
        hintEl.innerText = '⚠️ Koneksi Canon USB Bridge belum merespons.';
        hintEl.style.color = 'var(--coral)';
      }
    }
  }

  async triggerCanonAutoFocus() {
    this.showToast('🎯 Mengunci Fokus Otomatis (Auto Focus)...', '🔍', 1600);
    try {
      const res = await fetch(`http://127.0.0.1:19898/control?af=1&t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        this.syncCanonHardwareControlsUI(data);
      }
    } catch (err) {}
  }

  async stepCanonFocus(stepCode) {
    try {
      const res = await fetch(`http://127.0.0.1:19898/control?focus=${encodeURIComponent(stepCode)}&t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        this.syncCanonHardwareControlsUI(data);
      }
    } catch (err) {}
  }

  loadSavedCameraImageAdjust() {
    if (!this.cameraImageAdjust) {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem('pb_camera_image_adjust') || 'null');
      } catch (e) {}
      this.cameraImageAdjust = {
        brightness: Number(saved?.brightness) || 100,
        contrast: Number(saved?.contrast) || 100,
        saturation: Number(saved?.saturation) || 100
      };
    }
    const b = this.cameraImageAdjust.brightness;
    const c = this.cameraImageAdjust.contrast;
    const s = this.cameraImageAdjust.saturation;
    const rngB = document.getElementById('rngCamBrightness');
    const rngC = document.getElementById('rngCamContrast');
    const rngS = document.getElementById('rngCamSaturation');
    const lblB = document.getElementById('lblCamBrightness');
    const lblC = document.getElementById('lblCamContrast');
    const lblS = document.getElementById('lblCamSaturation');
    if (rngB) rngB.value = b;
    if (rngC) rngC.value = c;
    if (rngS) rngS.value = s;
    if (lblB) lblB.innerText = `${b}%`;
    if (lblC) lblC.innerText = `${c}%`;
    if (lblS) lblS.innerText = `${s}%`;
  }

  getDefaultEventPhotoFilter() {
    const raw = (this.eventConfig && this.eventConfig.defaultPhotoFilter) || 'normal';
    return window.MafazaPhotoFilters ? window.MafazaPhotoFilters.normalizeFilterKey(raw) : raw;
  }

  syncDefaultEventPhotoFilter(forceReset = false) {
    if (!forceReset && this._sessionFilterManuallyChosen) return;
    this.activePhotoFilter = this.getDefaultEventPhotoFilter();
    this.activePhotoFilterIntensity = 1.0;
    if (typeof this.syncFilterControlsUI === 'function') {
      this.syncFilterControlsUI();
    }
  }

  getCameraCssFilterString() {
    this.loadSavedCameraImageAdjust();
    const { brightness, contrast, saturation } = this.cameraImageAdjust;
    if (brightness === 100 && contrast === 100 && saturation === 100) {
      return '';
    }
    return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
  }

  getLiveViewfinderCssFilterString() {
    const hw = this.getCameraCssFilterString();
    const liveArtEnabled = Boolean(this.eventConfig && this.eventConfig.livePhotoFilter);
    const artKey = liveArtEnabled ? (this.activePhotoFilter || this.getDefaultEventPhotoFilter()) : 'normal';
    if (liveArtEnabled && artKey !== 'normal' && window.MafazaPhotoFilters) {
      const combined = window.MafazaPhotoFilters.getScaledCssFilter(artKey, this.activePhotoFilterIntensity || 1.0, hw);
      return combined !== 'none' ? combined : '';
    }
    return hw;
  }

  updateCameraImageAdjust(key, val) {
    this.loadSavedCameraImageAdjust();
    const num = Math.max(40, Math.min(250, Number(val) || 100));
    this.cameraImageAdjust[key] = num;
    try {
      localStorage.setItem('pb_camera_image_adjust', JSON.stringify(this.cameraImageAdjust));
    } catch (e) {}
    this.loadSavedCameraImageAdjust();
    this.applyCameraImageAdjustToLiveVideo();
  }

  resetCameraImageAdjust() {
    this.cameraImageAdjust = { brightness: 100, contrast: 100, saturation: 100 };
    try {
      localStorage.setItem('pb_camera_image_adjust', JSON.stringify(this.cameraImageAdjust));
    } catch (e) {}
    this.loadSavedCameraImageAdjust();
    this.applyCameraImageAdjustToLiveVideo();
    this.showToast('Kecerahan & warna dikembalikan ke 100% ✨', '🔄', 1500);
  }

  applyCameraImageAdjustToLiveVideo() {
    const video = document.getElementById('videoFeed');
    const f = this.getLiveViewfinderCssFilterString();
    [video, this.canonUsbCanvas].forEach(el => {
      if (!el) return;
      if (f) {
        el.style.filter = f;
      } else {
        el.style.removeProperty('filter');
      }
    });
  }

  async onQuickCameraSelectChange(deviceId) {
    if (!deviceId) return;
    const isAndroidApk = Boolean(typeof window !== 'undefined' && window.MafazaAndroidBridge);
    this.userExplicitPreferredDeviceId = deviceId;
    this.__mafazaPreferWebCamera = (deviceId !== 'canon_usb_direct');
    if (!this.cameraConfig) this.cameraConfig = {};
    if (!isAndroidApk || deviceId !== 'canon_usb_direct') {
      this.cameraConfig.preferredVideoDeviceId = deviceId;
      try {
        localStorage.setItem('pb_preferred_video_device_id', deviceId);
      } catch (e) {}
      try {
        await fetch('/api/camera/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferredVideoDeviceId: deviceId })
        });
      } catch (e) {}
    }
    await this.startCamera(null, true);
  }

  async forceReconnectCamera() {
    this.showToast('🔄 Menyegarkan koneksi kamera UVC / Eksternal...', '📹', 2200);
    if (this.mediaStream) {
      try {
        this.mediaStream.getTracks().forEach(t => t.stop());
      } catch (e) {}
      this.mediaStream = null;
    }
    this.isVirtualFallbackStream = false;
    await new Promise(r => setTimeout(r, 350));
    await this.startCamera(null, true);
  }

  recreateFreshVideoFeedElement() {
    const oldVideo = document.getElementById('videoFeed');
    const frame = document.getElementById('cameraRetroFrame');
    if (!oldVideo || !frame) return oldVideo;

    try {
      oldVideo.pause();
      oldVideo.srcObject = null;
    } catch (e) {}

    const newVideo = document.createElement('video');
    newVideo.id = 'videoFeed';
    newVideo.autoplay = true;
    newVideo.muted = true;
    newVideo.defaultMuted = true;
    newVideo.playsInline = true;
    newVideo.setAttribute('autoplay', '');
    newVideo.setAttribute('playsinline', '');
    newVideo.setAttribute('webkit-playsinline', '');
    newVideo.setAttribute('muted', '');
    newVideo.style.cssText = 'width: 100%; height: 100%; object-fit: contain; transform: scaleX(-1) scale(1); transform-origin: center center; display: block; background: #000;';

    frame.insertBefore(newVideo, oldVideo);
    oldVideo.remove();
    return newVideo;
  }

  updateLiveCameraBadgeUI(customLabel = null) {
    const badge = document.getElementById('liveCameraNameBadge');
    if (!badge) return;
    if (customLabel) {
      badge.innerText = customLabel;
      return;
    }
    if (this.canonUsbStreamActive) {
      const camName = this.canonUsbBridgeInfo?.camera || 'USB DSLR';
      badge.innerText = `LIVE • ${camName}`;
      return;
    }
    if (this.isVirtualFallbackStream) {
      badge.innerText = 'LIVE • Simulator';
      return;
    }
    const video = document.getElementById('videoFeed');
    const vw = video?.videoWidth || 0;
    const vh = video?.videoHeight || 0;
    const track = this.mediaStream?.getVideoTracks?.()[0];
    const rawLabel = (track?.label || '').trim();
    const shortLabel = rawLabel ? rawLabel.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*/gi, '').slice(0, 18) : 'Kamera';
    if (vw > 0 && vh > 0) {
      badge.innerText = `LIVE • ${shortLabel} (${vw}×${vh})`;
    } else if (rawLabel) {
      badge.innerText = `LIVE • ${shortLabel}`;
    } else {
      badge.innerText = 'LIVE';
    }
  }

  populateQuickCameraSelect(videoInputs, activeDeviceId) {
    const sel = document.getElementById('kioskQuickCameraSelect');
    if (!sel) return;
    let optsHtml = '';
    const isAndroidApk = Boolean(typeof window !== 'undefined' && window.MafazaAndroidBridge);
    const isIpadOs = (navigator.userAgent.includes('Macintosh') && (navigator.maxTouchPoints > 1)) || /iPad/i.test(navigator.userAgent || '');
    const isMobileDevice = /Android|iPhone|iPod/i.test(navigator.userAgent || '') || isIpadOs;

    if (!isMobileDevice || isAndroidApk) {
      const isCanonActive = this.canonUsbBridgeInfo && this.canonUsbBridgeInfo.active;
      const camTitle = isCanonActive ? (this.canonUsbBridgeInfo.camera || 'Kamera USB (PTP)') : 'Kamera USB (Sony / Canon / DSLR)';
      const statusIcon = isCanonActive ? '🟢' : '🔌';
      const isCanonSel = activeDeviceId === 'canon_usb_direct' ? 'selected' : '';
      optsHtml += `<option value="canon_usb_direct" ${isCanonSel}>${statusIcon} ${camTitle}</option>`;
    }

    if (Array.isArray(videoInputs)) {
      optsHtml += videoInputs.map((d, i) => {
        const label = d.label || `Kamera #${i + 1}`;
        const selected = (d.deviceId === activeDeviceId && activeDeviceId !== 'canon_usb_direct') ? 'selected' : '';
        return `<option value="${d.deviceId}" ${selected}>📹 ${label}</option>`;
      }).join('');
    }
    sel.innerHTML = optsHtml;
  }

  async setUvcResolution(resMode) {
    try {
      localStorage.setItem('pb_uvc_resolution', resMode);
      localStorage.setItem('pb_ipad_uvc_resolution', resMode);
    } catch (e) {}
    if (this.cameraConfig) {
      this.cameraConfig.uvcResolution = resMode;
    }
    try {
      await fetch('/api/camera/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uvcResolution: resMode })
      });
    } catch (e) {}
    await this.startCamera(resMode, true);
  }

  checkVideoFeedHealth(videoEl) {
    if (!videoEl || !videoEl.srcObject) {
      return { healthy: false, reason: 'no_src' };
    }
    const track = this.mediaStream?.getVideoTracks?.()[0];
    if (!track || track.readyState !== 'live' || track.enabled === false) {
      return { healthy: false, reason: 'track_not_live' };
    }
    if (!videoEl.videoWidth || !videoEl.videoHeight || videoEl.readyState < 2) {
      return { healthy: false, reason: 'zero_dimensions' };
    }
    try {
      if (!this._healthCheckCanvas) {
        this._healthCheckCanvas = document.createElement('canvas');
        this._healthCheckCanvas.width = 32;
        this._healthCheckCanvas.height = 32;
      }
      const ctx = this._healthCheckCanvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, 32, 32);
      ctx.drawImage(videoEl, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      let maxLuma = 0;
      for (let i = 0; i < data.length; i += 16) {
        const luma = Math.max(data[i], data[i + 1], data[i + 2]);
        if (luma > maxLuma) maxLuma = luma;
        if (maxLuma > 3) break;
      }
      if (maxLuma <= 2) {
        return { healthy: false, reason: 'black_buffer' };
      }
    } catch (e) {}
    return { healthy: true, reason: 'ok' };
  }

  startCameraDebugOverlay() {
    if (this._debugOverlayTimer) return;
    const wrap = document.createElement('div');
    wrap.id = 'cameraDebugOverlay';
    wrap.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;max-width:52vw;background:rgba(0,0,0,0.88);color:#7CFC9A;font:11px/1.4 monospace;padding:8px 10px;border-radius:10px;pointer-events:auto;border:1px solid rgba(124,252,154,0.4);';
    const textEl = document.createElement('div');
    textEl.style.cssText = 'white-space:pre-wrap;margin-bottom:6px;';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';

    const testModes = [
      { label: '1. Bare', fn: () => this.debugTestUvcConstraint('bare') },
      { label: '2. 720p Max', fn: () => this.debugTestUvcConstraint('720p_max') },
      { label: '3. 720p Exact', fn: () => this.debugTestUvcConstraint('720p_exact') },
      { label: '4. 480p Max', fn: () => this.debugTestUvcConstraint('480p_max') }
    ];
    testModes.forEach(m => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.label;
      b.style.cssText = 'padding:4px 7px;font:bold 10.5px monospace;background:#1e293b;color:#fff;border:1px solid #7CFC9A;border-radius:6px;cursor:pointer;';
      b.onclick = (e) => {
        e.stopPropagation();
        m.fn();
      };
      btnRow.appendChild(b);
    });

    wrap.appendChild(textEl);
    wrap.appendChild(btnRow);
    document.body.appendChild(wrap);

    this._debugOverlayTimer = setInterval(() => {
      try {
        const v = document.getElementById('videoFeed');
        const track = this.mediaStream?.getVideoTracks?.()[0];
        const s = track?.getSettings?.() || {};
        const health = v ? this.checkVideoFeedHealth(v) : { reason: 'no_video_el' };
        const lines = [
          'DEBUG KAMERA (' + (this._lastDebugConstraintLabel || 'auto') + ')',
          'Layar: ' + this.currentScreen + ' | countdown: ' + !!this.isCountingDown,
          'Track: ' + (track ? (track.label || '(tanpa nama)') : 'TIDAK ADA'),
          'Track state: ' + (track ? track.readyState : '-') + ' | muted: ' + (track ? track.muted : '-') + ' | enabled: ' + (track ? track.enabled : '-'),
          'Setting: ' + (s.width || '?') + 'x' + (s.height || '?') + ' @' + (s.frameRate ? Math.round(s.frameRate) : '?') + 'fps',
          'Video el: ' + (v ? (v.videoWidth + 'x' + v.videoHeight + ' | readyState ' + v.readyState + ' | paused ' + v.paused) : 'TIDAK ADA'),
          'Health: ' + health.reason + ' | Recovery: ' + JSON.stringify(Object.keys(this._uvcRecoveryDone || {}))
        ];
        textEl.textContent = lines.join('\n');
      } catch (e) {
        textEl.textContent = 'DEBUG error: ' + e.message;
      }
    }, 800);
  }

  async debugTestUvcConstraint(modeName) {
    try {
      this._lastDebugConstraintLabel = modeName;
      if (this._uvcHealthTimer) clearTimeout(this._uvcHealthTimer);
      const oldTrack = this.mediaStream?.getVideoTracks?.()[0];
      let targetId = this.userExplicitPreferredDeviceId || oldTrack?.getSettings?.()?.deviceId || '';
      if (!targetId && navigator.mediaDevices?.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const vIn = devs.filter(d => d.kind === 'videoinput');
        const ext = vIn.find(d => /osmo|action|dji|gopro|insta360|uvc|usb|capture|hdmi/i.test(d.label || ''));
        if (ext) targetId = ext.deviceId;
      }
      if (this.mediaStream) {
        try { this.mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        this.mediaStream = null;
      }
      const qrVideo = document.getElementById('qrVideoFeed');
      if (qrVideo) {
        try { qrVideo.pause(); qrVideo.srcObject = null; } catch (e) {}
      }
      await new Promise(r => setTimeout(r, 600));

      let videoConstraint = targetId ? { deviceId: { exact: targetId } } : true;
      if (modeName === '720p_max') {
        videoConstraint = {
          ...(targetId ? { deviceId: { exact: targetId } } : {}),
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 }
        };
      } else if (modeName === '720p_exact') {
        videoConstraint = {
          ...(targetId ? { deviceId: { exact: targetId } } : {}),
          width: { exact: 1280 },
          height: { exact: 720 }
        };
      } else if (modeName === '480p_max') {
        videoConstraint = {
          ...(targetId ? { deviceId: { exact: targetId } } : {}),
          width: { ideal: 640, max: 640 },
          height: { ideal: 480, max: 480 }
        };
      }

      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
      this.mediaStream = stream;
      const freshVid = this.recreateFreshVideoFeedElement() || document.getElementById('videoFeed');
      if (freshVid) {
        freshVid.muted = true;
        freshVid.playsInline = true;
        freshVid.srcObject = stream;
        freshVid.onloadedmetadata = () => {
          freshVid.play().catch(() => {});
          this.applyCameraTransform();
          this.updateLiveCameraBadgeUI();
        };
        freshVid.play().catch(() => {});
      }
      this.applyCameraTransform();
      this.updateLiveCameraBadgeUI();
    } catch (err) {
      this._lastDebugConstraintLabel = modeName + ' ERR: ' + (err.name || err.message);
    }
  }

  scheduleUvcStreamHealthVerification() {
    if (this._uvcHealthTimer) clearTimeout(this._uvcHealthTimer);

    this._uvcHealthTimer = setTimeout(async () => {
      if (this.canonUsbStreamActive || this.isVirtualFallbackStream) return;
      if (this.currentScreen !== 'screenCapture' && this.currentScreen !== 'screenQR') return;

      // Hentikan watchdog jika tamu sudah mulai hitung mundur / foto, agar kamera tidak dimatikan-nyalakan saat memotret (penyebab terasa berat)
      const shouldAbortWatchdog = () => (
        this.isCountingDown ||
        this.canonUsbStreamActive ||
        (this.currentScreen !== 'screenCapture' && this.currentScreen !== 'screenQR')
      );

      // PENTING: Beri waktu penuh hingga 3.5 detik (14 x 250ms) tanpa mematikan stream!
      // Kamera DJI Osmo Action 4 membutuhkan ~2 detik untuk inisialisasi perangkat keras UVC setelah getUserMedia dipanggil.
      for (let i = 0; i < 14; i++) {
        if (shouldAbortWatchdog()) return;
        const videoEl = document.getElementById(this.currentScreen === 'screenQR' ? 'qrVideoFeed' : 'videoFeed');
        const status = this.checkVideoFeedHealth(videoEl);
        if (status.healthy) {
          this.updateLiveCameraBadgeUI();
          return;
        }
        try {
          if (videoEl && videoEl.paused) {
            const p = videoEl.play();
            if (p && typeof p.then === 'function') p.catch(() => {});
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 250));
      }

      const currentVideoEl = document.getElementById(this.currentScreen === 'screenQR' ? 'qrVideoFeed' : 'videoFeed');
      if (this.checkVideoFeedHealth(currentVideoEl).healthy) {
        this.updateLiveCameraBadgeUI();
        return;
      }
      if (shouldAbortWatchdog()) return;

      // Batasi pemulihan berat (restart kamera) maksimal 1x per kamera per halaman, agar tidak berulang-ulang membuat iPad berat
      const watchdogTrack = this.mediaStream?.getVideoTracks?.()[0];
      const watchdogKey = watchdogTrack?.label || 'default';
      this._uvcRecoveryDone = this._uvcRecoveryDone || {};
      if (this._uvcRecoveryDone[watchdogKey]) {
        console.warn('⚠️ [UVC Watchdog] Pemulihan sudah pernah dicoba untuk kamera ini, dilewati agar tidak berat:', watchdogKey);
        return;
      }
      this._uvcRecoveryDone[watchdogKey] = true;

      // Langkah Pemulihan 1: Buat elemen <video id="videoFeed"> baru saat #screenCapture sudah visible (mengatasi bug layer WebKit iPadOS)
      console.warn('⚠️ [UVC Watchdog] Stream masih gelap setelah 3.5 detik, membuat elemen <video> segar di viewport...');
      try {
        const freshVideo = this.currentScreen === 'screenQR'
          ? document.getElementById('qrVideoFeed') : this.recreateFreshVideoFeedElement();
        if (freshVideo && this.mediaStream) {
          freshVideo.srcObject = this.mediaStream;
          freshVideo.onloadedmetadata = () => {
            setTimeout(() => {
              freshVideo.play().catch(() => {});
              this.applyCameraTransform();
              this.updateLiveCameraBadgeUI();
            }, 80);
          };
          const p = freshVideo.play();
          if (p && typeof p.then === 'function') await p.catch(() => {});
        }
      } catch (e) {}

      await new Promise(r => setTimeout(r, 1200));
      if (shouldAbortWatchdog()) return;
      if (this.checkVideoFeedHealth(document.getElementById(this.currentScreen === 'screenQR' ? 'qrVideoFeed' : 'videoFeed')).healthy) {
        console.log('✅ [UVC Watchdog] Video pulih setelah pembuatan ulang elemen <video>!');
        this.updateLiveCameraBadgeUI();
        return;
      }

      // Langkah Pemulihan 2: Uji tepat 2 profil UVC alternatif dengan waktu tunggu 3 detik per profil (TANPA pernah mencoba 480p pada DJI Osmo Action 4)
      if (this._isRecoveringUvc) return;
      this._isRecoveringUvc = true;
      try {
        const track = this.mediaStream?.getVideoTracks?.()[0];
        const activeId = this.userExplicitPreferredDeviceId || track?.getSettings?.()?.deviceId || '';
        const activeLabel = track?.label || '';
        const isActionCam = /osmo|action|dji|gopro|insta360/i.test(activeLabel);
        console.warn('🔄 [UVC Watchdog] Mencoba profil UVC alternatif untuk:', activeLabel || activeId);

        const candidateConstraints = [];
        if (activeId) {
          // Kandidat 1: Paksa 720p (dengan max: 1280x720 agar WebKit iPadOS benar-benar berpindah dari 1080p ke 720p!)
          candidateConstraints.push({
            deviceId: { exact: activeId },
            width: { ideal: 1280, max: 1280 },
            height: { ideal: 720, max: 720 }
          });
          // Kandidat 2: Bare deviceId (tanpa constraint resolusi/fps sama sekali)
          candidateConstraints.push({
            deviceId: { exact: activeId }
          });
          if (!isActionCam) {
            // Kandidat khusus Capture Card HDMI (bukan Action Cam): 480p
            candidateConstraints.push({
              deviceId: { exact: activeId },
              width: { ideal: 640, max: 640 },
              height: { ideal: 480, max: 480 }
            });
          }
        }

        for (const videoConstraint of candidateConstraints) {
          if (shouldAbortWatchdog()) return;
          if (this.mediaStream) {
            try {
              this.mediaStream.getTracks().forEach(t => t.stop());
            } catch (e) {}
            this.mediaStream = null;
          }
          // Beri jeda 650ms agar UVCDriverKit di iPadOS & DJI Osmo Action 4 mereset pipa USB UVC sepenuhnya
          await new Promise(r => setTimeout(r, 650));

          try {
            const nextStream = await navigator.mediaDevices.getUserMedia({
              video: videoConstraint,
              audio: false
            });
            this.mediaStream = nextStream;
            this.isVirtualFallbackStream = false;

            const freshVid = this.recreateFreshVideoFeedElement() || document.getElementById('videoFeed');
            const qrVideo = document.getElementById('qrVideoFeed');
            const targetVid = (this.currentScreen === 'screenQR') ? qrVideo : freshVid;
            const unusedVid = (this.currentScreen === 'screenQR') ? freshVid : qrVideo;
            if (unusedVid && unusedVid.srcObject) {
              try { unusedVid.pause(); unusedVid.srcObject = null; } catch (e) {}
            }
            if (targetVid) {
              targetVid.muted = true;
              targetVid.playsInline = true;
              targetVid.srcObject = nextStream;
              targetVid.onloadedmetadata = () => {
                setTimeout(() => {
                  targetVid.play().catch(() => {});
                  this.applyCameraTransform();
                  this.updateLiveCameraBadgeUI();
                }, 80);
              };
              const pr = targetVid.play();
              if (pr && typeof pr.then === 'function') pr.catch(() => {});
            }
            this.applyCameraTransform();
            this.updateLiveCameraBadgeUI();

            // Tunggu hingga 3 detik penuh agar kamera UVC sempat mengirim frame pertama
            for (let w = 0; w < 12; w++) {
              await new Promise(r => setTimeout(r, 250));
              if (this.checkVideoFeedHealth(targetVid).healthy) {
                console.log('✅ [UVC Watchdog] Gambar kamera UVC berhasil tampil dengan constraint:', videoConstraint);
                this.updateLiveCameraBadgeUI();
                this._isRecoveringUvc = false;
                return;
              }
            }
          } catch (tryErr) {
            console.warn('Profil UVC kandidat dilewati:', tryErr);
          }
        }
      } finally {
        this._isRecoveringUvc = false;
      }
    }, 400);
  }

  // Deteksi otomatis layar peringatan hitam "HDMI resolution is smaller than UVC capture" pada UVC03 (1de1:f113)
  scheduleUvcWarningScreenCheck() {
    if (this.uvcCheckTimerId) clearTimeout(this.uvcCheckTimerId);
    this.uvcCheckTimerId = setTimeout(async () => {
      try {
        const video = document.getElementById('videoFeed');
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        // Kamera action seperti DJI Osmo Action 4 bukan capture card HDMI bermasalah, lewati pengecekan
        const trackLabel = this.mediaStream?.getVideoTracks?.()[0]?.label || '';
        if (/osmo|action|dji|gopro|insta360/i.test(trackLabel)) return;
        // Jika resolusi saat ini <= 480p, periksa apakah frame adalah layar peringatan hitam-putih UVC03
        if (video.videoHeight <= 480) return;

        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 120;
        const ctx = c.getContext('2d');
        ctx.drawImage(video, 0, 0, c.width, c.height);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;

        let borderTotal = 0;
        let borderPureBlack = 0;
        let centerWhitePixels = 0;
        let colorPixels = 0;
        const totalPixels = c.width * c.height;

        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const idx = (y * c.width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            if (Math.abs(r - g) + Math.abs(g - b) > 18) {
              colorPixels++;
            }

            const isBorder = (y < 14 || y > c.height - 14 || x < 18 || x > c.width - 18);
            if (isBorder) {
              borderTotal++;
              if (r < 12 && g < 12 && b < 12) borderPureBlack++;
            } else if (r > 180 && g > 180 && b > 180) {
              centerWhitePixels++;
            }
          }
        }

        const isPureBlackBorder = borderTotal > 0 && (borderPureBlack / borderTotal) > 0.96;
        const isGrayscaleFrame = (colorPixels / totalPixels) < 0.015;
        const hasWhiteWarningText = centerWhitePixels > 45 && centerWhitePixels < (totalPixels * 0.35);

        if (isPureBlackBorder && isGrayscaleFrame && hasWhiteWarningText) {
          console.warn('⚠️ Terdeteksi layar "HDMI resolution is smaller than UVC capture" pada Capture Card! Otomatis menurunkan resolusi UVC ke 480p...');
          await this.setUvcResolution('480p');
        }
      } catch (e) {}
    }, 900);
  }

  async startCamera(overrideResMode = null, forceRestart = false) {
    // Jika stream kamera fisik sudah aktif dan sehat, jangan dimatikan-nyalakan ulang kecuali diminta eksplisit
    if (!overrideResMode && !forceRestart && this.isMediaStreamLive() && !this.isVirtualFallbackStream) {
      const video = document.getElementById('videoFeed');
      const qrVideo = document.getElementById('qrVideoFeed');
      const activeVideo = this.currentScreen === 'screenQR' ? qrVideo : video;
      const inactiveVideo = this.currentScreen === 'screenQR' ? video : qrVideo;
      if (inactiveVideo && inactiveVideo.srcObject) {
        inactiveVideo.pause();
        inactiveVideo.srcObject = null;
      }
      if (activeVideo) {
        if (activeVideo.srcObject !== this.mediaStream) activeVideo.srcObject = this.mediaStream;
        const p = activeVideo.play();
        if (p && typeof p.then === 'function') p.catch(() => {});
      }
      this.applyCameraTransform();
      this.updateLiveCameraBadgeUI();
      return;
    }

    const video = document.getElementById('videoFeed');
    const qrVideo = document.getElementById('qrVideoFeed');
    this.canonUsbStreamActive = false;
    if (this.canonUsbCanvas) {
      this.canonUsbCanvas.style.display = 'none';
    }
    this.isVirtualFallbackStream = false;
    if (this.canonUsbLoopTimer) {
      clearTimeout(this.canonUsbLoopTimer);
      this.canonUsbLoopTimer = null;
    }

    try {
      await this.fetchCameraConfig();
      // Deteksi iPad (Safari di iPadOS mengirim userAgent 'Macintosh' dengan maxTouchPoints > 1)
      const isAndroidApk = Boolean(typeof window !== 'undefined' && window.MafazaAndroidBridge);
      const isIpadOs = (navigator.userAgent.includes('Macintosh') && (navigator.maxTouchPoints > 1)) || /iPad/i.test(navigator.userAgent || '');
      const isMobileDevice = /Android|iPhone|iPod/i.test(navigator.userAgent || '') || isIpadOs;

      const localPrefId = localStorage.getItem('pb_preferred_video_device_id') || '';
      const globalPrefId = (isMobileDevice || isAndroidApk) ? '' : (this.cameraConfig?.preferredVideoDeviceId || '');
      const effectiveLocalPref = (localPrefId === 'canon_usb_direct' && (isMobileDevice || isAndroidApk)) ? '' : localPrefId;
      const savedPrefId = this.userExplicitPreferredDeviceId || effectiveLocalPref || globalPrefId;

      const canonBridge = isMobileDevice ? null : await this.checkCanonUsbBridgeStatus();

      // Jika Canon/Sony USB Bridge aktif dan user tidak memilih kamera WebRTC/bawaan
      if (canonBridge && canonBridge.active && !this.__mafazaPreferWebCamera && (!savedPrefId || savedPrefId === 'canon_usb_direct')) {
        let videoInputs = [];
        try {
          if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            const devs = await navigator.mediaDevices.enumerateDevices();
            videoInputs = devs.filter(d => d.kind === 'videoinput');
          }
        } catch (e) {}
        this.populateQuickCameraSelect(videoInputs, 'canon_usb_direct');
        await this.startCanonUsbDirectStream(canonBridge);
        this.updateLiveCameraBadgeUI();
        return;
      }

      // Di desktop (Mac/Windows), jika user spesifik memilih canon_usb_direct, tunggu bridge desktop aktif
      if (localPrefId === 'canon_usb_direct' && !isMobileDevice && !isAndroidApk) {
        let videoInputs = [];
        try {
          if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            const devs = await navigator.mediaDevices.enumerateDevices();
            videoInputs = devs.filter(d => d.kind === 'videoinput');
          }
        } catch (e) {}
        this.populateQuickCameraSelect(videoInputs, 'canon_usb_direct');
        if (window.pbNotify) {
          window.pbNotify.info('Menghubungkan ke Canon USB Bridge (Port 19898)... Pastikan aplikasi Pasang-dan-Jalankan-Canon-USB-Bridge.bat sudah berjalan dan kamera Canon sudah ON.', { title: 'Canon USB Bridge', duration: 3500 });
        }
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
        }
        if (this.canonWaitTimer) clearTimeout(this.canonWaitTimer);
        this.canonWaitTimer = setTimeout(() => this.startCamera(), 1800);
        return;
      }

      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
          // Beri jeda 300ms agar driver UVC di iPadOS / macOS benar-benar melepas handle lama
          await new Promise(r => setTimeout(r, 300));
        }

        const resMode = overrideResMode || (isMobileDevice ? (localStorage.getItem('pb_ipad_uvc_resolution') || 'auto_canon') : (this.cameraConfig?.uvcResolution || localStorage.getItem('pb_uvc_resolution') || 'auto_canon'));
        let chosenDevice = null;
        const actionCamRegex = /osmo|action|dji|gopro|insta360/i;
        const cameraFilterRegex = /osmo|action|dji|gopro|insta360|canon|eos|obs|virtual|uvc03|1de1:f113|display capture|sony|ilce|a7|imaging edge|cam link|elgato|capture|usb video|uvc|hdmi|external|fhd|usb2|video stream|webcam/i;

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter(d => d.kind === 'videoinput');

          // 1. Jika user memilih manual lewat dropdown selama sesi ini, prioritaskan pilihan user
          if (this.userExplicitPreferredDeviceId) {
            chosenDevice = videoInputs.find(d => d.deviceId === this.userExplicitPreferredDeviceId) || null;
          }
          // 2. Prioritaskan kamera eksternal UVC (seperti DJI Osmo Action 4) dibanding kamera depan bawaan iPad
          if (!chosenDevice) {
            chosenDevice = videoInputs.find(d => actionCamRegex.test(d.label || '')) ||
                           videoInputs.find(d => cameraFilterRegex.test(d.label || '')) ||
                           null;
          }
          // 3. Fallback ke savedPrefId jika ada
          if (!chosenDevice && savedPrefId) {
            chosenDevice = videoInputs.find(d => d.deviceId === savedPrefId) || null;
          }
        } catch (enumErr) {}

        const captureCardRegex = /uvc03|1de1:f113|display capture|usb video|hdmi|capture/i;
        const isChosenActionCam = actionCamRegex.test(chosenDevice?.label || '');
        const isChosenCaptureCard = captureCardRegex.test(chosenDevice?.label || '');
        const dims = this.getUvcResolutionDims(resMode, chosenDevice?.label || '');
        this.updateUvcResolutionButtonsUI(dims.label);

        const buildVideoConstraints = (targetId, resolutionDims, isActionCam = false) => {
          const c = {};
          if (targetId) {
            c.deviceId = { exact: targetId };
          } else if (!isActionCam && !isIpadOs) {
            c.facingMode = 'user';
          }
          if (resolutionDims && resolutionDims.width) {
            c.width = { ideal: resolutionDims.width };
          }
          if (resolutionDims && resolutionDims.height) {
            c.height = { ideal: resolutionDims.height };
          }
          // PENTING: Pada iPadOS WebKit, ideal: 1280 diabaikan kecuali diberi max: 1280!
          if (resolutionDims && resolutionDims.label === '720p') {
            c.width.max = 1280;
            c.height.max = 720;
          } else if (resolutionDims && resolutionDims.label === '480p') {
            c.width.max = 640;
            c.height.max = 480;
          }
          return c;
        };

        const playMediaToVideoElements = (stream) => {
          // Buat elemen <video id="videoFeed"> segar jika sedang di #screenCapture agar WebKit iPadOS membuat layer hardware baru
          const freshMainVideo = (this.currentScreen === 'screenCapture')
            ? (this.recreateFreshVideoFeedElement() || document.getElementById('videoFeed'))
            : document.getElementById('videoFeed');

          // PENTING: Jangan pernah menempelkan stream UVC ke #qrVideoFeed yang sedang display:none saat berada di #screenCapture!
          const targetVid = (this.currentScreen === 'screenQR') ? qrVideo : freshMainVideo;
          const inactiveVid = (this.currentScreen === 'screenQR') ? freshMainVideo : qrVideo;
          if (inactiveVid && inactiveVid.srcObject) {
            try {
              inactiveVid.pause();
              inactiveVid.srcObject = null;
            } catch (e) {}
          }

          [targetVid].forEach(vidEl => {
            if (!vidEl) return;
            vidEl.muted = true;
            vidEl.defaultMuted = true;
            vidEl.playsInline = true;
            vidEl.setAttribute('playsinline', '');
            vidEl.setAttribute('webkit-playsinline', '');
            vidEl.setAttribute('autoplay', '');
            vidEl.srcObject = stream;

            const tryPlay = () => {
              const p = vidEl.play();
              if (p && typeof p.then === 'function') {
                p.catch(err => {
                  console.warn('Video play attempt on iPadOS / Safari:', err);
                });
              }
            };

            tryPlay();
            vidEl.onloadedmetadata = () => {
              // Kickstart Trick WebKit iPadOS: panggil play() dengan jeda 80ms setelah metadata UVC siap
              setTimeout(() => {
                tryPlay();
                this.applyCameraTransform();
                this.applyCameraImageAdjustToLiveVideo();
                this.updateLiveCameraBadgeUI();
              }, 80);
            };
            vidEl.onloadeddata = () => {
              this.applyCameraTransform();
              this.updateLiveCameraBadgeUI();
            };
            vidEl.oncanplay = () => {
              tryPlay();
              this.updateLiveCameraBadgeUI();
            };
          });
        };

        let stream = null;
        const targetDevId = chosenDevice?.deviceId || null;

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: buildVideoConstraints(targetDevId, dims, isChosenActionCam),
            audio: false
          });
        } catch (primErr) {
          console.warn('Percobaan awal getUserMedia gagal, mencoba fallback:', primErr);
          if (targetDevId) {
            try {
              stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: targetDevId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
                audio: false
              });
            } catch (secErr) {
              stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { ideal: targetDevId } },
                audio: false
              });
            }
          } else {
            stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false
            });
          }
        }

        this.mediaStream = stream;
        this.isVirtualFallbackStream = false;

        // Periksa hasil enumerateDevices SETELAH izin terbuka:
        // HANYA lakukan switch jika stream saat ini BUKAN kamera eksternal yang diinginkan!
        try {
          const postDevices = await navigator.mediaDevices.enumerateDevices();
          const postVideoInputs = postDevices.filter(d => d.kind === 'videoinput');

          let extDevice = null;
          if (this.userExplicitPreferredDeviceId) {
            extDevice = postVideoInputs.find(d => d.deviceId === this.userExplicitPreferredDeviceId) || null;
          }
          if (!extDevice) {
            extDevice = postVideoInputs.find(d => actionCamRegex.test(d.label || '')) ||
                        postVideoInputs.find(d => cameraFilterRegex.test(d.label || '')) ||
                        null;
          }
          if (!extDevice && savedPrefId) {
            extDevice = postVideoInputs.find(d => d.deviceId === savedPrefId) || null;
          }

          const currentTrack = this.mediaStream.getVideoTracks()[0];
          const currentDeviceId = currentTrack?.getSettings?.()?.deviceId || '';
          const currentLabel = currentTrack?.label || '';
          const postDims = this.getUvcResolutionDims(resMode, extDevice?.label || currentLabel);
          this.updateUvcResolutionButtonsUI(postDims.label);

          // Cek apakah kamera yang sedang terbuka SUDAH merupakan extDevice (atau sudah Osmo Action 4)
          const isAlreadyOnExtDevice = Boolean(
            !extDevice ||
            (targetDevId && targetDevId === extDevice.deviceId) ||
            (currentDeviceId && currentDeviceId === extDevice.deviceId) ||
            (currentLabel && extDevice.label && currentLabel.toLowerCase() === extDevice.label.toLowerCase()) ||
            (!this.userExplicitPreferredDeviceId && actionCamRegex.test(currentLabel))
          );

          // PENTING: Jangan pernah mematikan & menyalakan ulang stream di iPadOS / Action Cam jika perangkatnya sudah benar!
          if (!isAlreadyOnExtDevice && extDevice && extDevice.deviceId) {
            console.log('🔄 Beralih dari kamera bawaan ke kamera eksternal:', extDevice.label);
            if (this.mediaStream) {
              this.mediaStream.getTracks().forEach(t => t.stop());
              this.mediaStream = null;
            }
            // Beri jeda 500ms agar AVFoundation/UVCDriverKit di iPadOS siap membuka stream UVC baru
            await new Promise(r => setTimeout(r, 500));

            const isExtAction = actionCamRegex.test(extDevice.label || '');
            let extStream = null;
            try {
              extStream = await navigator.mediaDevices.getUserMedia({
                video: buildVideoConstraints(extDevice.deviceId, postDims, isExtAction),
                audio: false
              });
            } catch (switchErr) {
              console.warn('Switch ke exact deviceId gagal, mencoba ideal deviceId:', switchErr);
              extStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { ideal: extDevice.deviceId } },
                audio: false
              });
            }
            this.mediaStream = extStream;
          }

          const finalTrack = this.mediaStream.getVideoTracks()[0];
          const finalDevId = finalTrack?.getSettings?.()?.deviceId || extDevice?.deviceId || '';
          this.populateQuickCameraSelect(postVideoInputs, finalDevId);
        } catch (reEnumErr) {}

        playMediaToVideoElements(this.mediaStream);
        this.applyCameraTransform();
        this.updateLiveCameraBadgeUI();
        this.scheduleUvcWarningScreenCheck();
        if (this.currentScreen === 'screenCapture' || this.currentScreen === 'screenQR') {
          this.scheduleUvcStreamHealthVerification();
        }
        return;
      }
    } catch (err) {
      console.warn('Preferred camera constraint failed, retrying default camera with video.play support:', err);
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
          }
          await new Promise(r => setTimeout(r, 350));
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
          });
          this.isVirtualFallbackStream = false;
          this.updateUvcResolutionButtonsUI('720p');
          const video = document.getElementById('videoFeed');
          const qrVideo = document.getElementById('qrVideoFeed');
          const activeVideo = this.currentScreen === 'screenQR' ? qrVideo : video;
          const inactiveVideo = this.currentScreen === 'screenQR' ? video : qrVideo;
          if (inactiveVideo && inactiveVideo.srcObject) {
            inactiveVideo.pause();
            inactiveVideo.srcObject = null;
          }
          if (activeVideo) {
            activeVideo.muted = true;
            activeVideo.playsInline = true;
            activeVideo.srcObject = this.mediaStream;
            activeVideo.play().catch(() => {});
          }
          this.applyCameraTransform();
          this.updateLiveCameraBadgeUI();
          return;
        }
      } catch (fallbackErr) {
        console.warn('Physical camera not available, falling back to virtual simulator:', fallbackErr);
      }
    }

    this.setupVirtualCameraFallback();
  }

  setupVirtualCameraFallback() {
    this.isVirtualFallbackStream = true;
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    let angle = 0;
    const drawSimulatedFrame = () => {
      if (!this.isVirtualFallbackStream) return;
      angle += 0.04;
      // Warm dark wood & amber booth lighting
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, '#26150E');
      grad.addColorStop(0.5, '#3D2317');
      grad.addColorStop(1, '#573322');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Warm retro golden bokeh circles
      ctx.fillStyle = 'rgba(212, 167, 84, 0.15)';
      ctx.beginPath();
      ctx.arc(220, 160 + Math.sin(angle) * 15, 90, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(230, 120, 107, 0.18)';
      ctx.beginPath();
      ctx.arc(1060, 520 + Math.cos(angle) * 20, 110, 0, Math.PI * 2);
      ctx.fill();

      // Stylized smiling guest avatar (Warm Retro aesthetic)
      const headY = 360 + Math.sin(angle) * 12;
      ctx.fillStyle = '#FCE2D1'; // Skin
      ctx.beginPath();
      ctx.arc(640, headY, 150, 0, Math.PI * 2);
      ctx.fill();

      // Hair
      ctx.fillStyle = '#2A170F';
      ctx.beginPath();
      ctx.arc(640, headY - 40, 155, Math.PI * 0.9, Math.PI * 2.1);
      ctx.fill();

      // Cheerful Eyes
      ctx.strokeStyle = '#26150E';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(580, headY - 10, 24, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(700, headY - 10, 24, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();

      // Warm Coral Blush
      ctx.fillStyle = 'rgba(230, 120, 107, 0.45)';
      ctx.beginPath();
      ctx.arc(550, headY + 25, 25, 0, Math.PI * 2);
      ctx.arc(730, headY + 25, 25, 0, Math.PI * 2);
      ctx.fill();

      // Big Happy Smile
      ctx.strokeStyle = '#E6786B';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(640, headY + 20, 50, 0.2, Math.PI - 0.2);
      ctx.stroke();

      // Retro Sparkles & Heart
      ctx.fillStyle = '#D4A754';
      ctx.font = '36px sans-serif';
      ctx.fillText('✨', 480, headY - 80 + Math.cos(angle * 1.5) * 15);
      ctx.fillStyle = '#E6786B';
      ctx.fillText('♡', 790, headY - 100 + Math.sin(angle * 1.5) * 15);

      // Label overlay in warm serif
      ctx.fillStyle = '#F9E9D7';
      ctx.font = 'bold 28px "Fraunces", serif';
      ctx.textAlign = 'center';
      ctx.fillText('📷 LIVE CAMERA (Warm Playful Retro Mode)', 640, 640);
      ctx.textAlign = 'start';

      if (!this._simLoopStopped) {
        this._simRafId = requestAnimationFrame(drawSimulatedFrame);
      }
    };
    this._simLoopStopped = false;
    drawSimulatedFrame();

    const stream = canvas.captureStream(30);
    const video = document.getElementById('videoFeed');
    const qrVideo = document.getElementById('qrVideoFeed');
    if (video) video.srcObject = stream;
    if (qrVideo) qrVideo.srcObject = stream;
    this.mediaStream = stream;
    this.updateLiveCameraBadgeUI();
  }

  clearAllTimers() {
    if (this.countdownTimerId) {
      clearInterval(this.countdownTimerId);
      this.countdownTimerId = null;
    }
    if (this.interPoseTimerId) {
      clearTimeout(this.interPoseTimerId);
      this.interPoseTimerId = null;
    }
    if (this.postCaptureHoldTimerId) {
      clearInterval(this.postCaptureHoldTimerId);
      this.postCaptureHoldTimerId = null;
    }
    if (this.reviewAutoAdvanceTimerId) {
      clearInterval(this.reviewAutoAdvanceTimerId);
      this.reviewAutoAdvanceTimerId = null;
    }
    this.isCountingDown = false;
    const countdownBox = document.getElementById('countdownBox');
    if (countdownBox) countdownBox.style.display = 'none';
    const holdOverlay = document.getElementById('postCapturePreviewOverlay');
    if (holdOverlay) holdOverlay.style.display = 'none';
  }

  async startCountdownSequence() {
    this.clearAllTimers();
    this.totalPosesRequired = this.resolveTemplatePosesCount(this.selectedTemplate);
    this.applyCameraOrientationForTemplate(this.selectedTemplate);

    this.posesCaptured = new Array(this.totalPosesRequired).fill(null);
    this.activePoseIndex = 0;
    this.isCountingDown = false;
    this.showScreen('screenCapture');
    this.renderFilmstripDock();

    const poseIndicatorText = document.getElementById('poseIndicatorText');
    const smileHintText = document.getElementById('smileHintText');
    if (poseIndicatorText) {
      poseIndicatorText.innerText = `Foto 1/${this.totalPosesRequired}`;
    }
    if (smileHintText) {
      smileHintText.innerText = 'Sentuh kamera atau tombol merah untuk mulai foto Pose 1 😊';
    }

    const countdownBox = document.getElementById('countdownBox');
    if (countdownBox) countdownBox.style.display = 'none';
    const holdOverlay = document.getElementById('postCapturePreviewOverlay');
    if (holdOverlay) holdOverlay.style.display = 'none';

    this.showToast('Kamera siap! Klik tombol merah atau layar kamera untuk mulai 😊', '📸', 2200);
    // TIDAK LANGSUNG MENGHITUNG OTOMATIS: Menunggu klik tombol merah atau layar live photo
  }

  scheduleCountdownForPose(poseIndex, delayMs = 600) {
    this.clearAllTimers();
    this.activePoseIndex = poseIndex;
    this.isCountingDown = false;
    const poseIndicatorText = document.getElementById('poseIndicatorText');
    const smileHintText = document.getElementById('smileHintText');
    if (poseIndicatorText) {
      poseIndicatorText.innerText = `Foto ${poseIndex + 1}/${this.totalPosesRequired}`;
    }
    if (smileHintText) {
      smileHintText.innerText = `Sentuh kamera atau tombol merah untuk mulai Pose ${poseIndex + 1} 😊`;
    }
    this.renderFilmstripDock();

    const countdownBox = document.getElementById('countdownBox');
    if (countdownBox) countdownBox.style.display = 'none';
    const holdOverlay = document.getElementById('postCapturePreviewOverlay');
    if (holdOverlay) holdOverlay.style.display = 'none';

    this.showToast(`Kamera siap untuk Pose ${poseIndex + 1}! Klik untuk mulai 😊`, '📸', 1800);
    // TIDAK LANGSUNG MENGHITUNG OTOMATIS: Menunggu klik tombol merah atau layar live photo
  }

  startCountdown(poseIndex) {
    this.clearAllTimers();
    this.isCountingDown = true;
    this.activePoseIndex = poseIndex;
    this.renderFilmstripDock();

    const poseIndicatorText = document.getElementById('poseIndicatorText');
    const smileHintText = document.getElementById('smileHintText');
    if (poseIndicatorText) {
      poseIndicatorText.innerText = `Foto ${poseIndex + 1}/${this.totalPosesRequired}`;
    }
    if (smileHintText) {
      smileHintText.innerText = 'Tersenyumlah ke kamera! 😊';
    }

    const countdownBox = document.getElementById('countdownBox');
    const countdownNum = document.getElementById('countdownNum');
    const countdownLabel = document.getElementById('countdownLabel');
    const svgProgress = document.getElementById('countdownSvgProgress');

    const cfgCountdown = parseInt(this.eventConfig && this.eventConfig.countdownSeconds, 10);
    const maxCount = (Number.isFinite(cfgCountdown) && cfgCountdown >= 1 && cfgCountdown <= 10) ? cfgCountdown : 3;
    let count = maxCount;
    const fullCircumference = 427.25;

    const updateDisplay = (val) => {
      if (countdownNum) {
        countdownNum.innerText = val > 0 ? val : '📸';
        countdownNum.classList.remove('pop');
        void countdownNum.offsetWidth; // Force CSS reflow for pop animation
        countdownNum.classList.add('pop');
      }
      if (countdownLabel) {
        if (val === maxCount && maxCount >= 3) countdownLabel.innerText = 'SIAP';
        else if (val === 1) countdownLabel.innerText = 'TAHAN';
        else if (val > 1) countdownLabel.innerText = 'SENYUM';
        else countdownLabel.innerText = 'CHEESE!';
      }
      if (svgProgress) {
        const offset = fullCircumference * (1 - (val / maxCount));
        svgProgress.style.strokeDashoffset = offset;
      }
    };

    if (countdownBox) countdownBox.style.display = 'flex';
    updateDisplay(count);
    this.playBeep(540, 0.15);

    // Start authentic iPhone Live Photo video recording during countdown
    this.startPoseLiveRecording(poseIndex);

    this.countdownTimerId = setInterval(() => {
      count--;
      if (count > 0) {
        updateDisplay(count);
        this.playBeep(540, 0.15);
      } else {
        clearInterval(this.countdownTimerId);
        this.countdownTimerId = null;
        this.isCountingDown = false;
        updateDisplay(0);
        this.executeSnapForPose(poseIndex, countdownBox);
      }
    }, 1000);
  }

  executeSnapForPose(poseIndex, countdownBox = null, fromCountdown = true) {
    if (this.isCapturingSnap) return;
    this.isCapturingSnap = true;
    this.isCountingDown = false;
    const hideCountdown = () => {
      if (countdownBox) countdownBox.style.display = 'none';
    };

    const isWebcamOnly = Boolean(this.cameraConfig && this.cameraConfig.cameraMode === 'webcam_only');
    const hasAndroidNativeBridge = Boolean(typeof window !== 'undefined' && window.MafazaAndroidBridge);
    const hasLocalCanonBridge = Boolean(this.canonUsbStreamActive || (this.canonUsbBridgeInfo && this.canonUsbBridgeInfo.active));
    const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
    const isLocalServerHost = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    const shouldWaitHardwareShutter = !isWebcamOnly && (hasAndroidNativeBridge || hasLocalCanonBridge || (isLocalServerHost && !this.isLocalDirectMode()));

    if (shouldWaitHardwareShutter) {
      if (hasLocalCanonBridge && !hasAndroidNativeBridge) {
        // Canon EOS 1300D via USB Bridge butuh ~250ms untuk mirror drop sebelum rana fisik berbunyi;
        // selaraskan bunyi cekrik & kilatan layar dengan momen rana fisik kamera
        setTimeout(() => {
          this.triggerAudioJackFlash();
          this.playShutterSound();
          this.triggerShutterFlash();
        }, 240);
      } else {
        this.triggerAudioJackFlash();
        this.playShutterSound();
        this.triggerShutterFlash();
      }
      Promise.resolve(this.triggerHardwareCameraAndFlash(poseIndex))
        .then((gotHardwarePhoto) => {
          if (!gotHardwarePhoto && !this.posesCaptured[poseIndex]) {
            this.captureFrame(poseIndex);
          }
          setTimeout(() => {
            this.stopPoseLiveRecording(poseIndex);
          }, 350);
          hideCountdown();
          this.handlePostCapture(poseIndex);
        })
        .catch(() => {
          if (!this.posesCaptured[poseIndex]) {
            this.captureFrame(poseIndex);
          }
          hideCountdown();
          this.handlePostCapture(poseIndex);
        })
        .finally(() => {
          this.isCapturingSnap = false;
        });
      return;
    }

    // Canon via Capture Card / EOS Webcam Utility / Browser camera:
    // Tangkap frame video SEKETIKA pada detik ke-0 tanpa menunggu /api/camera/trigger-capture di server VPS
    this.triggerAudioJackFlash();
    this.playShutterSound();
    this.triggerShutterFlash();
    const lead = Math.max(0, Math.min(200, this.audioFlashLeadMs || 0));
    const finalizeImmediateSnap = () => {
      try {
        this.captureFrame(poseIndex);
        setTimeout(() => {
          this.stopPoseLiveRecording(poseIndex);
        }, 350);
        if (fromCountdown && countdownBox) {
          setTimeout(() => {
            hideCountdown();
            this.handlePostCapture(poseIndex);
          }, 250);
        } else {
          hideCountdown();
          this.handlePostCapture(poseIndex);
        }
      } finally {
        this.isCapturingSnap = false;
      }
    };

    if (lead > 0) {
      setTimeout(finalizeImmediateSnap, lead);
    } else {
      finalizeImmediateSnap();
    }
  }

  triggerManualSnap() {
    if (this.isCapturingSnap) return;
    let targetIndex = this.activePoseIndex;
    if (targetIndex === null || targetIndex === undefined || targetIndex >= this.totalPosesRequired) {
      targetIndex = this.posesCaptured.findIndex(p => p === null);
      if (targetIndex === -1) targetIndex = 0;
    }

    this.clearAllTimers();
    const countdownBox = document.getElementById('countdownBox');
    this.executeSnapForPose(targetIndex, countdownBox, false);
  }

  async triggerHardwareCameraAndFlash(poseIndex) {
    if (this.cameraConfig && this.cameraConfig.cameraMode === 'webcam_only') {
      return false;
    }

    let data = null;
    const hasLocalCanonBridge = Boolean(this.canonUsbStreamActive || (this.canonUsbBridgeInfo && this.canonUsbBridgeInfo.active));
    const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
    const isLocalServerHost = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

    // 1. Tembak langsung ke Canon USB Bridge lokal di 127.0.0.1:19898 hanya jika bridge memang aktif
    if (hasLocalCanonBridge) {
      try {
        const localRes = await this.fetchWithTimeout('http://127.0.0.1:19898/capture', {
          method: 'POST',
          mode: 'cors',
          cache: 'no-store'
        }, 4800);
        if (localRes.ok) {
          data = await localRes.json();
        }
      } catch (localErr) {
        // Local bridge timeout atau putus
      }
    }

    // 2. Hanya panggil server /api/camera/trigger-capture bila web dibuka dari localhost/studio sendiri (bukan VPS remote)
    if (!data && !hasLocalCanonBridge && isLocalServerHost && !this.isLocalDirectMode()) {
      try {
        const res = await this.fetchWithTimeout('/api/camera/trigger-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poseIndex, timeoutMs: 3800 })
        }, 4200);
        if (res.ok) {
          data = await res.json();
        }
      } catch (e) {}
    }

    if (data && data.imageUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const timeout = setTimeout(() => {
          if (!this.posesCaptured[poseIndex]) {
            this.captureFrame(poseIndex);
          }
          resolve(false);
        }, 4000);

        img.onload = () => {
          clearTimeout(timeout);
          try {
            const rawW = img.naturalWidth || 1920;
            const rawH = img.naturalHeight || 1280;
            const maxDim = 2160;
            const dsScale = Math.max(rawW, rawH) > maxDim ? (maxDim / Math.max(rawW, rawH)) : 1;
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(rawW * dsScale));
            c.height = Math.max(1, Math.round(rawH * dsScale));
            const ctx = c.getContext('2d');
            const camCss = this.getCameraCssFilterString();
            let filterInput = img;
            if (dsScale < 1 && camCss && window.MafazaPhotoFilters) {
              const preCanvas = document.createElement('canvas');
              preCanvas.width = c.width;
              preCanvas.height = c.height;
              const preCtx = preCanvas.getContext('2d');
              if (preCtx) {
                preCtx.drawImage(img, 0, 0, c.width, c.height);
                filterInput = preCanvas;
              }
            }
            const drawSource = (camCss && window.MafazaPhotoFilters)
              ? (window.MafazaPhotoFilters.renderStyledCanvas(filterInput, 'normal', { extraCssFilter: camCss, skipCache: true }) || filterInput)
              : img;
            const zoom = Math.max(0.5, Math.min(3.0, this.cameraZoom || 1.0));
            const panX = Math.max(-1, Math.min(1, this.cameraPanX || 0));
            const panY = Math.max(-1, Math.min(1, this.cameraPanY || 0));
            const iw = drawSource.naturalWidth || drawSource.width || c.width;
            const ih = drawSource.naturalHeight || drawSource.height || c.height;
            if (zoom < 1.0) {
              ctx.fillStyle = '#000000';
              ctx.fillRect(0, 0, c.width, c.height);
              const dw = c.width * zoom;
              const dh = c.height * zoom;
              const dx = (c.width - dw) / 2 + (panX * (c.width - dw) / 2);
              const dy = (c.height - dh) / 2 - (panY * (c.height - dh) / 2);
              ctx.drawImage(drawSource, 0, 0, iw, ih, dx, dy, dw, dh);
            } else {
              const cropW = iw / zoom;
              const cropH = ih / zoom;
              const maxOffX = (iw - cropW) / 2;
              const maxOffY = (ih - cropH) / 2;
              const cropX = Math.max(0, Math.min(iw - cropW, maxOffX - (panX * maxOffX)));
              const cropY = Math.max(0, Math.min(ih - cropH, maxOffY + (panY * maxOffY)));
              ctx.drawImage(drawSource, cropX, cropY, cropW, cropH, 0, 0, c.width, c.height);
            }
            const flashDataUrl = c.toDataURL('image/jpeg', 0.88);
            this.posesCaptured[poseIndex] = flashDataUrl;
            this.renderFilmstripDock();

            const holdOverlay = document.getElementById('postCapturePreviewOverlay');
            const holdImg = document.getElementById('postCapturePreviewImg');
            if (holdOverlay && holdOverlay.style.display !== 'none' && holdImg && this.lastCapturedPoseIndex === poseIndex) {
              holdImg.src = flashDataUrl;
            }
          } catch (err) {
            console.warn('Canvas render error for flash photo:', err);
            if (!this.posesCaptured[poseIndex]) {
              this.captureFrame(poseIndex);
            }
          }
          resolve(true);
        };
        img.onerror = () => {
          clearTimeout(timeout);
          if (!this.posesCaptured[poseIndex]) {
            this.captureFrame(poseIndex);
          }
          resolve(false);
        };
        const cb = `_cb=${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const url = data.imageUrl.includes('?') ? `${data.imageUrl}&${cb}` : `${data.imageUrl}?${cb}`;
        img.src = url;
      });
    }

    if (!this.posesCaptured[poseIndex]) {
      this.captureFrame(poseIndex);
    }
    return false;
  }

  triggerShutterFlash() {
    const flash = document.getElementById('flashOverlay');
    if (flash) {
      flash.classList.add('active');
      setTimeout(() => flash.classList.remove('active'), 240);
    }

    // Support Android / Mobile Hardware LED Torch Flash if available on the video track
    try {
      if (this.mediaStream) {
        const track = this.mediaStream.getVideoTracks()[0];
        if (track && typeof track.getCapabilities === 'function') {
          const caps = track.getCapabilities();
          if (caps && caps.torch) {
            track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
            setTimeout(() => {
              track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }, 350);
          }
        }
      }
    } catch (e) {}
  }

  adjustCameraZoom(delta) {
    const nextZoom = Math.max(0.5, Math.min(3.0, Math.round(((this.cameraZoom || 1.0) + delta) * 10) / 10));
    if (Math.abs(nextZoom - 1.0) < 0.05) {
      this.cameraPanX = 0;
      this.cameraPanY = 0;
    }
    this.setCameraZoom(nextZoom);
  }

  panCamera(deltaX, deltaY) {
    this.cameraPanX = Math.max(-1, Math.min(1, Math.round(((this.cameraPanX || 0) + deltaX) * 100) / 100));
    this.cameraPanY = Math.max(-1, Math.min(1, Math.round(((this.cameraPanY || 0) + deltaY) * 100) / 100));
    this.applyCameraTransform();
  }

  resetCameraZoom() {
    this.cameraPanX = 0;
    this.cameraPanY = 0;
    this.setCameraZoom(1.0);
  }

  setCameraZoom(zoomLevel) {
    this.cameraZoom = Math.max(0.5, Math.min(3.0, Math.round(zoomLevel * 10) / 10));
    try {
      localStorage.setItem('pb_camera_zoom', this.cameraZoom);
    } catch (e) {}
    this.applyCameraTransform();
  }

  setCameraFitMode(mode) {
    this.cameraFitMode = mode;
    try {
      localStorage.setItem('pb_camera_fit_mode', mode);
    } catch (e) {}
    this.applyCameraTransform();
    this.updateCameraFitButtonsUI();
    const msg = mode === 'contain' ? '🖼️ Mode Bebas Gepeng (Proporsional Utuh) Aktif' : '📺 Mode Layar Penuh (Cover) Aktif';
    if (window.pbNotify) {
      window.pbNotify.info(msg, { duration: 2000 });
    }
  }

  updateCameraFitButtonsUI() {
    const btnContain = document.getElementById('btnFitModeContain');
    const btnCover = document.getElementById('btnFitModeCover');
    const mode = this.cameraFitMode || 'cover';
    if (btnContain) {
      btnContain.style.background = mode === 'contain' ? 'var(--coral)' : '#fff';
      btnContain.style.color = mode === 'contain' ? '#fff' : 'var(--caramel-brown)';
      btnContain.style.borderColor = mode === 'contain' ? 'var(--coral)' : 'var(--border-soft)';
    }
    if (btnCover) {
      btnCover.style.background = mode === 'cover' ? 'var(--coral)' : '#fff';
      btnCover.style.color = mode === 'cover' ? '#fff' : 'var(--caramel-brown)';
      btnCover.style.borderColor = mode === 'cover' ? 'var(--coral)' : 'var(--border-soft)';
    }
  }

  applyCameraTransform() {
    const zoom = Math.max(0.5, Math.min(3.0, this.cameraZoom || 1.0));
    const panX = Math.max(-1, Math.min(1, this.cameraPanX || 0));
    const panY = Math.max(-1, Math.min(1, this.cameraPanY || 0));
    
    let tx = 0;
    let ty = 0;
    if (zoom > 1.0) {
      const maxTranslatePct = ((zoom - 1) / (2 * zoom)) * 100;
      tx = (panX * maxTranslatePct).toFixed(2);
      ty = (-panY * maxTranslatePct).toFixed(2);
    } else if (zoom < 1.0) {
      tx = (panX * 25).toFixed(2);
      ty = (-panY * 25).toFixed(2);
    }

    const video = document.getElementById('videoFeed');
    const fitMode = this.cameraFitMode || 'cover';
    const rot = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    const frame = document.getElementById('cameraRetroFrame');
    if (frame) {
      frame.style.aspectRatio = (this.cameraAspectRatio || '16/9').replace('/', ' / ');
    }

    let rotScale = 1.0;
    const activeSrcEl = (this.canonUsbStreamActive && this.canonUsbCanvas && this.canonUsbCanvas.width > 0) ? this.canonUsbCanvas : video;
    if ((rot === 90 || rot === 270) && frame && frame.clientWidth > 0 && frame.clientHeight > 0) {
      const W = frame.clientWidth;
      const H = frame.clientHeight;
      const sw = (activeSrcEl && (activeSrcEl.naturalWidth || activeSrcEl.videoWidth || activeSrcEl.width)) || 1056;
      const sh = (activeSrcEl && (activeSrcEl.naturalHeight || activeSrcEl.videoHeight || activeSrcEl.height)) || 704;
      const s0 = Math.min(W / Math.max(1, sw), H / Math.max(1, sh));
      const pw = sw * s0;
      const ph = sh * s0;
      if (ph > 0 && pw > 0) {
        rotScale = (fitMode === 'cover') ? Math.max(W / ph, H / pw) : Math.min(W / ph, H / pw);
      }
    }

    const totalScale = (zoom * rotScale).toFixed(3);
    const transformStr = rot
      ? `scaleX(-1) rotate(${rot}deg) scale(${totalScale}) translate(${tx}%, ${ty}%)`
      : `scaleX(-1) scale(${totalScale}) translate(${tx}%, ${ty}%)`;
    const cssFilter = this.getLiveViewfinderCssFilterString();
    // When rotated 90/270 degrees, keep base element uncropped ('contain') so CSS scale(rotScale) handles full cover cleanly
    const appliedObjectFit = (rot === 90 || rot === 270) ? 'contain' : fitMode;
    [video, this.canonUsbCanvas].forEach(el => {
      if (!el) return;
      el.style.objectFit = appliedObjectFit;
      el.style.transform = transformStr;
      if (cssFilter) {
        el.style.filter = cssFilter;
      } else {
        el.style.removeProperty('filter');
      }
    });
    const label = document.getElementById('cameraZoomLabel');
    if (label) {
      label.innerText = `🔍 ${zoom.toFixed(1)}x`;
    }
    const quickBadge = document.getElementById('cameraControlsQuickZoomBadge');
    if (quickBadge) {
      quickBadge.innerText = `${zoom.toFixed(1)}x`;
    }
    this.updateCameraFitButtonsUI();
    this.updateCameraAspectRatioButtonsUI();
    if (typeof this.updateCameraCaptureOrientationUI === 'function') {
      this.updateCameraCaptureOrientationUI();
    }
    this.updateCameraRotationButtonsUI();
  }

  setCameraRotation(deg) {
    const val = ((parseInt(deg, 10) || 0) % 360 + 360) % 360;
    const clean = [0, 90, 180, 270].includes(val) ? val : 0;
    this.cameraRotation = clean;
    try {
      localStorage.setItem('pb_camera_rotation', String(clean));
    } catch (e) {}
    this.applyCameraTransform();
    if (window.pbNotify) {
      window.pbNotify.info(`🔁 Rotasi Kamera: ${clean}°`, { duration: 1500 });
    }
  }

  cycleCameraRotation() {
    const order = [0, 90, 270, 180];
    const idx = order.indexOf(this.cameraRotation || 0);
    const next = order[(idx + 1) % order.length];
    this.setCameraRotation(next);
  }

  updateCameraRotationButtonsUI() {
    const cur = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    [0, 90, 180, 270].forEach(d => {
      const btn = document.getElementById(`btnRotate${d}`);
      if (btn) {
        const active = (d === cur);
        btn.style.background = active ? 'var(--coral)' : '#ffffff';
        btn.style.color = active ? '#ffffff' : 'var(--caramel-brown)';
        btn.style.borderColor = active ? 'var(--coral)' : 'var(--border-soft)';
      }
    });
    const badge = document.getElementById('retroFrameRotateBadge');
    if (badge) {
      badge.innerText = `${cur}°`;
    }
  }

  setCameraAspectRatio(ratio) {
    const validRatios = ['16/9', '3/2', '4/3', '2/3', '3/4'];
    if (!validRatios.includes(ratio)) ratio = '16/9';
    this.cameraAspectRatio = ratio;
    try {
      localStorage.setItem('pb_camera_aspect_ratio', ratio);
    } catch (e) {}

    const frame = document.getElementById('cameraRetroFrame');
    if (frame) {
      frame.style.aspectRatio = ratio.replace('/', ' / ');
    }
    this.updateCameraAspectRatioButtonsUI();
    if (typeof this.updateCameraCaptureOrientationUI === 'function') {
      this.updateCameraCaptureOrientationUI();
    }
    requestAnimationFrame(() => this.applyCameraTransform());
    if (window.pbNotify) {
      window.pbNotify.info(`📐 Rasio Bingkai Kamera: ${ratio}`, { duration: 1600 });
    }
  }

  cycleCameraAspectRatio() {
    const order = ['16/9', '3/2', '4/3', '2/3', '3/4'];
    const idx = order.indexOf(this.cameraAspectRatio || '16/9');
    const next = order[(idx + 1) % order.length];
    this.cameraCaptureOrientation = (next === '2/3' || next === '3/4') ? 'portrait' : 'landscape';
    try { localStorage.setItem('pb_camera_capture_orientation', this.cameraCaptureOrientation); } catch (e) {}
    this.setCameraAspectRatio(next);
  }

  updateCameraAspectRatioButtonsUI() {
    const current = this.cameraAspectRatio || '16/9';
    ['16/9', '3/2', '4/3', '2/3', '3/4'].forEach(r => {
      const btnId = 'btnRatio' + r.replace('/', '_');
      const btn = document.getElementById(btnId);
      if (btn) {
        const isActive = (r === current);
        btn.style.background = isActive ? 'var(--coral)' : '#ffffff';
        btn.style.color = isActive ? '#ffffff' : 'var(--caramel-brown)';
        btn.style.borderColor = isActive ? 'var(--coral)' : 'var(--border-soft)';
      }
    });
    const badge = document.getElementById('retroFrameRatioBadge');
    if (badge) {
      badge.innerText = current;
    }
  }

  toggleCameraZoomControls(forceState = null) {
    const panel = document.getElementById('cameraZoomControls');
    const btn = document.getElementById('btnToggleCameraControls');
    if (!panel) return;
    const isHidden = panel.style.display === 'none' || !panel.style.display;
    const nextShow = forceState !== null ? Boolean(forceState) : isHidden;
    panel.style.display = nextShow ? 'flex' : 'none';
    if (btn) {
      btn.style.background = nextShow ? 'var(--coral)' : 'rgba(255, 251, 245, 0.96)';
      btn.style.color = nextShow ? '#ffffff' : 'var(--caramel-brown)';
      btn.style.borderColor = nextShow ? 'var(--coral)' : 'var(--border-soft)';
    }
  }

  captureFrame(poseIndex) {
    const video = document.getElementById('videoFeed');
    const canvas = document.createElement('canvas');
    let targetWidth = 1280;
    let targetHeight = 720;
    if (this.cameraAspectRatio === '3/2') {
      targetWidth = 1200;
      targetHeight = 800;
    } else if (this.cameraAspectRatio === '4/3') {
      targetWidth = 1200;
      targetHeight = 900;
    } else if (this.cameraAspectRatio === '2/3') {
      targetWidth = 800;
      targetHeight = 1200;
    } else if (this.cameraAspectRatio === '3/4') {
      targetWidth = 900;
      targetHeight = 1200;
    }
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    // Jangan di-mirror pada hasil tangkapan agar tulisan/teks terbaca normal (tidak terbalik) saat dicetak
    const useCanonCanvas = Boolean(this.canonUsbStreamActive && this.canonUsbCanvas && this.canonUsbCanvas.width > 0);
    const sourceEl = useCanonCanvas ? this.canonUsbCanvas : video;
    const rot = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    if (sourceEl) {
      let drawSource = sourceEl;
      let vw = (useCanonCanvas ? this.canonUsbCanvas.width : video.videoWidth) || canvas.width;
      let vh = (useCanonCanvas ? this.canonUsbCanvas.height : video.videoHeight) || canvas.height;
      if (rot !== 0 && vw > 0 && vh > 0) {
        const swap = (rot === 90 || rot === 270);
        const rotBuf = document.createElement('canvas');
        rotBuf.width = swap ? vh : vw;
        rotBuf.height = swap ? vw : vh;
        const rCtx = rotBuf.getContext('2d');
        if (rCtx) {
          rCtx.translate(rotBuf.width / 2, rotBuf.height / 2);
          rCtx.rotate((rot * Math.PI) / 180);
          rCtx.drawImage(sourceEl, -vw / 2, -vh / 2, vw, vh);
          drawSource = rotBuf;
          vw = rotBuf.width;
          vh = rotBuf.height;
        }
      }

      ctx.filter = this.getCameraCssFilterString() || 'none';
      const zoom = Math.max(0.5, Math.min(3.0, this.cameraZoom || 1.0));
      const panX = Math.max(-1, Math.min(1, this.cameraPanX || 0));
      const panY = Math.max(-1, Math.min(1, this.cameraPanY || 0));

      // Aspect-cover base source rectangle matching canvas target ratio without stretching
      const targetAspect = canvas.width / canvas.height;
      const srcAspect = vw / Math.max(1, vh);
      let baseSrcW = vw;
      let baseSrcH = vh;
      if (srcAspect > targetAspect) {
        baseSrcW = vh * targetAspect;
      } else if (srcAspect < targetAspect) {
        baseSrcH = vw / targetAspect;
      }

      if (zoom < 1.0) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const dw = canvas.width * zoom;
        const dh = canvas.height * zoom;
        const dx = (canvas.width - dw) / 2 + (panX * (canvas.width - dw) / 2);
        const dy = (canvas.height - dh) / 2 - (panY * (canvas.height - dh) / 2);
        const sx = (vw - baseSrcW) / 2;
        const sy = (vh - baseSrcH) / 2;
        ctx.drawImage(drawSource, sx, sy, baseSrcW, baseSrcH, dx, dy, dw, dh);
      } else {
        const cropW = baseSrcW / zoom;
        const cropH = baseSrcH / zoom;
        const maxOffX = (vw - cropW) / 2;
        const maxOffY = (vh - cropH) / 2;
        const cropX = Math.max(0, Math.min(vw - cropW, maxOffX - (panX * maxOffX)));
        const cropY = Math.max(0, Math.min(vh - cropH, maxOffY + (panY * maxOffY)));
        ctx.drawImage(drawSource, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
      }
      ctx.filter = 'none';
    }

    const photoDataUrl = canvas.toDataURL('image/jpeg', 0.88);
    this.posesCaptured[poseIndex] = photoDataUrl;
    if (!this.__captureFrameRotatedFlags) this.__captureFrameRotatedFlags = {};
    this.__captureFrameRotatedFlags[poseIndex] = true;
    this.rawPosesSyncedForSession = null;
    this.renderFilmstripDock();
  }

  startPoseLiveRecording(poseIndex) {
    let recStream = this.mediaStream;
    let isCanvasClone = false;
    if (!recStream && this.canonUsbStreamActive) {
      const usbCanvas = document.getElementById('canonUsbDirectCanvas') || document.getElementById('canonUsbLiveCanvas');
      if (usbCanvas && typeof usbCanvas.captureStream === 'function' && usbCanvas.width > 0) {
        try {
          recStream = usbCanvas.captureStream(15);
          isCanvasClone = true;
        } catch (e) {}
      }
    }
    if (!recStream) return;
    try {
      if (this.activeLiveRecorder && this.activeLiveRecorder.state !== 'inactive') {
        try { this.activeLiveRecorder.stop(); } catch(e){}
      }
      this.activeLiveChunks = [];
      const mimeTypes = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
      const mime = mimeTypes.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
      
      const recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : {});
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.activeLiveChunks.push(e.data);
      };
      this._liveTempStream = isCanvasClone ? recStream : null;
      this.activeLiveRecorder = recorder;
      recorder.start(100);
    } catch (e) {
      console.warn('Live photo recording init error:', e);
    }
  }

  stopPoseLiveRecording(poseIndex) {
    if (this.activeLiveRecorder && this.activeLiveRecorder.state !== 'inactive') {
      const rec = this.activeLiveRecorder;
      const chunks = this.activeLiveChunks;
      const tempStream = this._liveTempStream;
      this._liveTempStream = null;
      rec.onstop = () => {
        const mime = rec.mimeType || 'video/webm';
        const blob = new Blob(chunks, { type: mime });
        this.liveClips[poseIndex] = blob;
        if (tempStream) {
          try { tempStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        }
      };
      try {
        rec.stop();
      } catch(e){}
      this.activeLiveRecorder = null;
    }
  }

  async applyRotationToCapturedPose(poseIndex) {
    const rot = [0, 90, 180, 270].includes(this.cameraRotation) ? this.cameraRotation : 0;
    const src = this.posesCaptured[poseIndex];
    if (!rot || !src) return;
    if (this.__captureFrameRotatedFlags && this.__captureFrameRotatedFlags[poseIndex]) {
      delete this.__captureFrameRotatedFlags[poseIndex];
      return;
    }
    const img = new Image();
    img.src = src;
    await new Promise(res => { img.onload = res; img.onerror = res; });
    if (!img.naturalWidth || !img.naturalHeight) return;
    // Smart EXIF guard: if rotated 90/270 for portrait tripod mount and DSLR EXIF Auto-Rotate
    // already made the still photo upright portrait (height > width), avoid double-rotating sideways.
    if ((rot === 90 || rot === 270) && img.naturalHeight > img.naturalWidth) return;

    const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = maxSide > 2160 ? (2160 / maxSide) : 1;
    const drawW = Math.max(1, Math.round(img.naturalWidth * scale));
    const drawH = Math.max(1, Math.round(img.naturalHeight * scale));
    const swap = (rot === 90 || rot === 270);
    const c = document.createElement('canvas');
    c.width = swap ? drawH : drawW;
    c.height = swap ? drawW : drawH;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);

    this.posesCaptured[poseIndex] = c.toDataURL('image/jpeg', 0.88);
    if (this.cachedPhotoImages) delete this.cachedPhotoImages[poseIndex];
    this.rawPosesSyncedForSession = null;
    this.renderFilmstripDock();
    const holdImg = document.getElementById('postCapturePreviewImg');
    if (holdImg && this.lastCapturedPoseIndex === poseIndex) {
      holdImg.src = this.posesCaptured[poseIndex];
    }
  }

  async handlePostCapture(justCapturedIndex) {
    const nextEmptyIndex = this.posesCaptured.findIndex(p => p === null);
    this.lastCapturedPoseIndex = justCapturedIndex;
    this.pendingNextPoseIndex = nextEmptyIndex;

    await this.applyRotationToCapturedPose(justCapturedIndex);

    const capturedSrc = this.posesCaptured[justCapturedIndex];
    const holdOverlay = document.getElementById('postCapturePreviewOverlay');
    const holdImg = document.getElementById('postCapturePreviewImg');
    const holdBadge = document.getElementById('postCaptureBadgeText');
    const holdTimerText = document.getElementById('postCaptureTimerText');
    const holdBtnNext = document.getElementById('postCaptureBtnNext');
    const poseIndicatorText = document.getElementById('poseIndicatorText');
    const smileHintText = document.getElementById('smileHintText');

    // Tampilkan hasil foto barusan secara penuh di layar kamera
    if (holdOverlay && holdImg && capturedSrc) {
      const liveArt = (this.eventConfig && this.eventConfig.livePhotoFilter && this.activePhotoFilter !== 'normal' && window.MafazaPhotoFilters)
        ? window.MafazaPhotoFilters.getScaledCssFilter(this.activePhotoFilter, this.activePhotoFilterIntensity || 1.0)
        : 'none';
      if (liveArt && liveArt !== 'none') {
        holdImg.style.filter = liveArt;
      } else {
        holdImg.style.removeProperty('filter');
      }
      holdImg.src = capturedSrc;
      holdOverlay.style.display = 'flex';
    }
    if (holdBadge) {
      holdBadge.innerText = `✅ Hasil Foto Pose ${justCapturedIndex + 1} dari ${this.totalPosesRequired}`;
    }
    if (poseIndicatorText) {
      poseIndicatorText.innerText = `✨ Hasil Pose ${justCapturedIndex + 1}/${this.totalPosesRequired}`;
    }

    if (this.postCaptureHoldTimerId) {
      clearInterval(this.postCaptureHoldTimerId);
      this.postCaptureHoldTimerId = null;
    }

    if (nextEmptyIndex !== -1) {
      let holdSecs = 2;
      if (holdTimerText) {
        holdTimerText.innerText = `⏳ Membuka kamera live Pose ${nextEmptyIndex + 1} dalam ${holdSecs} dtk...`;
      }
      if (holdBtnNext) {
        holdBtnNext.innerText = `Lanjut ke Pose ${nextEmptyIndex + 1} ➔`;
      }
      if (smileHintText) {
        smileHintText.innerText = `Lihat hasil Pose ${justCapturedIndex + 1} • Bersiap masuk ke Pose ${nextEmptyIndex + 1} 😊`;
      }

      // Setelah melihat hasil foto selama 2 detik, otomatis masuk ke Live Camera pose berikutnya
      // TANPA langsung menghitung mundur, agar tamu leluasa menyusun posisi mereka dulu!
      this.postCaptureHoldTimerId = setInterval(() => {
        holdSecs--;
        if (holdSecs > 0) {
          if (holdTimerText) {
            holdTimerText.innerText = `⏳ Membuka kamera live Pose ${nextEmptyIndex + 1} dalam ${holdSecs} dtk...`;
          }
        } else {
          clearInterval(this.postCaptureHoldTimerId);
          this.postCaptureHoldTimerId = null;
          this.finishPostCaptureHold();
        }
      }, 1000);
    } else {
      let holdSecs = 2;
      if (holdTimerText) {
        holdTimerText.innerText = `🎉 Semua Pose Selesai!`;
      }
      if (holdBtnNext) {
        holdBtnNext.innerText = `Selesai & Lihat Hasil ➔`;
      }
      if (smileHintText) {
        smileHintText.innerText = `Semua pose telah diambil! 🎉`;
      }
      this.postCaptureHoldTimerId = setInterval(() => {
        holdSecs--;
        if (holdSecs <= 0) {
          clearInterval(this.postCaptureHoldTimerId);
          this.postCaptureHoldTimerId = null;
          this.finishPostCaptureHold();
        }
      }, 1000);
    }
  }

  finishPostCaptureHold() {
    if (this.postCaptureHoldTimerId) {
      clearInterval(this.postCaptureHoldTimerId);
      this.postCaptureHoldTimerId = null;
    }
    const holdOverlay = document.getElementById('postCapturePreviewOverlay');
    if (holdOverlay) holdOverlay.style.display = 'none';

    const nextEmptyIndex = this.posesCaptured.findIndex(p => p === null);
    if (nextEmptyIndex !== -1) {
      this.activePoseIndex = nextEmptyIndex;
      this.isCountingDown = false;
      const poseIndicatorText = document.getElementById('poseIndicatorText');
      const smileHintText = document.getElementById('smileHintText');
      if (poseIndicatorText) {
        poseIndicatorText.innerText = `📷 Pose ${nextEmptyIndex + 1} dari ${this.totalPosesRequired}`;
      }
      if (smileHintText) {
        smileHintText.innerText = `Silakan susun posisi untuk Pose ${nextEmptyIndex + 1}, lalu klik tombol merah / remote saat siap! 😊`;
      }
      this.showToast(`📸 Silakan atur gaya Pose ${nextEmptyIndex + 1}! Klik tombol merah / layar / remote saat siap.`, '✨', 2600);
      this.renderFilmstripDock();
      // TIDAK ADA AUTO-COUNTDOWN: Menunggu tamu selesai menyusun posisi lalu klik shutter / remote
    } else {
      // Semua pose selesai -> Masuk mode review atau lanjut preview
      this.activePoseIndex = null;
      this.showToast('🎉 Semua pose selesai! Kamu bisa foto ulang atau lanjut ke Preview.', '🎉', 3000);
      const poseIndicatorText = document.getElementById('poseIndicatorText');
      const smileHintText = document.getElementById('smileHintText');
      if (poseIndicatorText) {
        poseIndicatorText.innerText = `🎉 Foto Selesai (${this.totalPosesRequired}/${this.totalPosesRequired})`;
      }
      if (smileHintText) {
        smileHintText.innerText = 'Suka hasilnya? Klik Lanjut ke Preview atau pilih foto ulang.';
      }
      this.renderFilmstripDock();

      let autoAdvanceSecs = 25;
      this.reviewAutoAdvanceTimerId = setInterval(() => {
        autoAdvanceSecs--;
        if (autoAdvanceSecs <= 0) {
          clearInterval(this.reviewAutoAdvanceTimerId);
          this.reviewAutoAdvanceTimerId = null;
          this.proceedToPreviewScreen();
        }
      }, 1000);
    }
  }

  retakeFromHoldOverlay() {
    const idx = (this.lastCapturedPoseIndex !== undefined && this.lastCapturedPoseIndex !== null)
      ? this.lastCapturedPoseIndex
      : 0;
    this.retakeSinglePose(idx);
  }

  skipHoldOverlay() {
    // Langsung tutup preview hasil foto & kembali ke tampilan Live Camera pose berikutnya
    // TANPA langsung hitung mundur agar tamu bisa menyusun posisi mereka terlebih dahulu
    this.finishPostCaptureHold();
  }

  renderFilmstripDock() {
    const container = document.getElementById('poseThumbnails');
    const countDisplay = document.getElementById('capturedCountText');
    const btnProceed = document.getElementById('btnProceedToPreview');
    const btnRetakeAll = document.getElementById('btnRetakeAll');

    const filledCount = this.posesCaptured.filter(p => p !== null).length;
    if (countDisplay) {
      countDisplay.innerText = `${filledCount}/${this.totalPosesRequired}`;
    }

    const allFilled = filledCount === this.totalPosesRequired && this.totalPosesRequired > 0;
    if (btnProceed) {
      btnProceed.style.display = allFilled ? 'inline-flex' : 'none';
    }
    if (btnRetakeAll) {
      btnRetakeAll.style.display = filledCount > 0 ? 'inline-flex' : 'none';
    }

    if (!container) return;
    container.innerHTML = '';

    for (let i = 0; i < this.totalPosesRequired; i++) {
      const photoSrc = this.posesCaptured[i];
      const card = document.createElement('div');
      card.className = 'dock-slot-card';

      if (photoSrc) {
        // Captured state
        card.classList.add('dock-slot-captured');
        card.onclick = () => this.openPhotoModal(i);
        card.innerHTML = `
          <div class="dock-slot-badge">Pose ${i + 1} ✓</div>
          <img src="${photoSrc}" alt="Pose ${i + 1}">
          <div class="dock-slot-overlay-btns">
            <button class="btn-slot-retake" onclick="event.stopPropagation(); kiosk.retakeSinglePose(${i})" title="Foto ulang pose ini">
              🔄 Foto Ulang
            </button>
            <button class="btn-slot-delete" onclick="event.stopPropagation(); kiosk.deleteSinglePose(${i})" title="Hapus foto ini">
              🗑️
            </button>
          </div>
        `;
      } else if (i === this.activePoseIndex && this.isCountingDown) {
        // Active countdown state
        card.classList.add('dock-slot-active');
        card.innerHTML = `
          <span style="font-size: 24px;">📷</span>
          <span style="font-size: 11px; font-weight: 700;">Pose ${i + 1}</span>
          <span style="font-size: 10px; opacity: 0.85;">Sedang Difoto...</span>
        `;
      } else {
        // Empty / waiting state
        card.classList.add('dock-slot-empty');
        card.onclick = () => this.retakeSinglePose(i);
        card.innerHTML = `
          <span style="font-size: 20px;">➕</span>
          <span style="font-size: 12px; font-weight: 700;">Pose ${i + 1}</span>
          <span style="font-size: 10px; color: var(--coral); font-weight: 600;">Klik untuk Foto</span>
        `;
      }
      container.appendChild(card);
    }
  }

  retakeSinglePose(poseIndex) {
    this.clearAllTimers();
    this.posesCaptured[poseIndex] = null;
    if (this.liveClips) this.liveClips[poseIndex] = null;
    this.showToast(`🔄 Bersiap Foto Ulang Pose ${poseIndex + 1}!`, '📸', 1800);
    this.renderFilmstripDock();
    this.scheduleCountdownForPose(poseIndex, 900);
  }

  deleteSinglePose(poseIndex) {
    this.clearAllTimers();
    this.posesCaptured[poseIndex] = null;
    if (this.liveClips) this.liveClips[poseIndex] = null;
    this.activePoseIndex = poseIndex;
    this.showToast(`🗑️ Foto Pose ${poseIndex + 1} telah dihapus. Klik slot untuk foto ulang.`, 'ℹ️', 2200);
    const smileHintText = document.getElementById('smileHintText');
    if (smileHintText) {
      smileHintText.innerText = `Pose ${poseIndex + 1} kosong. Klik slot untuk mengambil foto.`;
    }
    this.renderFilmstripDock();
  }

  retakeAllPoses() {
    this.clearAllTimers();
    this.posesCaptured = new Array(this.totalPosesRequired).fill(null);
    this.liveClips = new Array(this.totalPosesRequired).fill(null);
    this.showToast('🔄 Foto Ulang Semua Pose! Bersiap untuk Pose 1...', '📸', 1800);
    this.renderFilmstripDock();
    this.scheduleCountdownForPose(0, 900);
  }

  proceedToPreviewScreen() {
    this.clearAllTimers();
    // Safety check: fill any empty slots with any available captured photo
    const validPhoto = this.posesCaptured.find(p => p !== null);
    if (!validPhoto) {
      alert('Ambil setidaknya 1 foto terlebih dahulu!');
      return;
    }
    for (let i = 0; i < this.totalPosesRequired; i++) {
      if (!this.posesCaptured[i]) {
        this.posesCaptured[i] = validPhoto;
      }
    }
    this.processAndRenderFinal();
  }

  openPhotoModal(poseIndex) {
    this.modalSelectedPoseIndex = poseIndex;
    const photoSrc = this.posesCaptured[poseIndex];
    if (!photoSrc) return;

    const modal = document.getElementById('photoPreviewModal');
    const img = document.getElementById('photoModalImg');
    const title = document.getElementById('photoModalTitle');

    if (title) title.innerText = `Foto Pose ${poseIndex + 1} dari ${this.totalPosesRequired}`;
    if (img) img.src = photoSrc;
    if (modal) modal.style.display = 'flex';
  }

  closePhotoModal() {
    const modal = document.getElementById('photoPreviewModal');
    if (modal) modal.style.display = 'none';
    this.modalSelectedPoseIndex = null;
  }

  retakePoseFromModal() {
    const idx = this.modalSelectedPoseIndex;
    this.closePhotoModal();
    if (idx !== null && idx !== undefined) {
      this.retakeSinglePose(idx);
    }
  }

  deletePoseFromModal() {
    const idx = this.modalSelectedPoseIndex;
    this.closePhotoModal();
    if (idx !== null && idx !== undefined) {
      this.deleteSinglePose(idx);
    }
  }

  showToast(text, icon = '✨', durationMs = 2000) {
    const toast = document.getElementById('captureToast');
    const toastIcon = document.getElementById('captureToastIcon');
    const toastText = document.getElementById('captureToastText');

    if (!toast) return;
    if (toastIcon) toastIcon.innerText = icon;
    if (toastText) toastText.innerText = text;

    toast.style.display = 'flex';
    if (this.toastTimerId) clearTimeout(this.toastTimerId);
    this.toastTimerId = setTimeout(() => {
      toast.style.display = 'none';
    }, durationMs);
  }

  // Renders the final photo by replacing the green chroma slots with captured photos
  async processAndRenderFinal() {
    this.clearAllTimers();
    this.showScreen('screenProcessing');
    const isLocalMode = this.isLocalDirectMode();

    // 1. Ensure Guest Pass & QR Data URL exist BEFORE creating the session (termasuk dari cadangan lokal saat Mode Lokal / sinyal lemah)
    try {
      await Promise.race([this.ensureGuestPassReady(), new Promise(r => setTimeout(r, 2200))]);
    } catch (e) {}

    // 2. Create session in backend (skip blocking network wait when Mode Lokal is active)
    if (!this.sessionId) {
      if (!isLocalMode && navigator.onLine !== false) {
        try {
          const sessRes = await this.fetchWithTimeout('/api/kiosk/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenantId: this.tenantId,
              eventId: this.eventId,
              deviceId: this.deviceId,
              guestPassId: this.guestPass ? this.guestPass.id : null,
              mode: this.selectedMode,
              templateId: this.selectedTemplate ? this.selectedTemplate.id : null
            })
          }, 2500);
          if (sessRes.ok) {
            const sessData = await sessRes.json();
            this.sessionId = sessData.sessionId;
          }
        } catch (e) {}
      }

      // Fallback: Mode Lokal / offline / sinyal lambat -> langsung buat session ID lokal seketika
      if (!this.sessionId) {
        this.sessionId = (isLocalMode ? 'sess_local_' : 'sess_off_') + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        console.log('⚡ Menggunakan sesi lokal:', this.sessionId);
      }
    }

    try {
      if (!isLocalMode && navigator.onLine !== false) {
        await Promise.race([this.fetchTemplates(), new Promise(r => setTimeout(r, 1200))]);
      }
    } catch (e) {}

    await this.loadAndKeySelectedTemplate(false);

    // Gunakan filter bawaan event sebelum render & Auto-Print bila tamu belum memilih manual
    if (!this._sessionFilterManuallyChosen) {
      this.activePhotoFilter = this.getDefaultEventPhotoFilter();
      this.activePhotoFilterIntensity = 1.0;
    }
    this.syncFilterControlsUI();
    const firstValidPose = (this.posesCaptured || []).find(p => p && typeof p === 'string');
    if (firstValidPose && window.MafazaPhotoFilters) {
      window.MafazaPhotoFilters.updateFilterPillThumbnails('#previewFiltersRow', firstValidPose).catch(() => {});
    }

    // Render composited final canvas
    await this.renderFinalCanvas();

    // Setup interactive touch / drag panning on finalCanvas
    this.setupCanvasInteractivePan();

    // Render slot selector tabs & photo thumbnails tray
    this.renderPreviewSlotTabs();
    this.renderPreviewPhotoTray();

    // Render QR Code & Direct Gallery Link on Preview Card
    this.renderGuestQrOnPreview();

    const banner = document.getElementById('printStatusBanner');
    if (banner) banner.style.display = 'none';

    // Bawaan (default) cetak foto adalah 1 lembar
    const printSelect = document.getElementById('printCopiesSelect');
    if (printSelect) printSelect.value = '1';

    // Initial sync of composite photo to backend
    this.syncFinalPhotoToBackend();

    this.showScreen('screenPreview');
    this.startAutoReturnTimer(45);

    // If Auto-Print is enabled, automatically trigger direct print once on entering preview
    if ((this.autoPrintEnabled || (this.eventConfig && this.eventConfig.autoPrint)) && this.autoPrintedForSession !== this.sessionId) {
      this.autoPrintedForSession = this.sessionId;
      setTimeout(() => {
        this.printCurrentSession(true);
      }, 700);
    }
  }

  async loadAndKeySelectedTemplate(forceResetSlots = false) {
    if (!this.selectedTemplate) {
      this.selectedTemplate = (this.templates && this.templates[0]) || null;
    }
    if (!this.selectedTemplate) return;

    const frameNameLabel = document.getElementById('previewCurrentFrameName');
    if (frameNameLabel) {
      frameNameLabel.innerText = `Frame: ${this.selectedTemplate.name || 'Pilihan'}`;
    }

    // Load template image
    const templateImg = new Image();
    templateImg.crossOrigin = 'anonymous';
    templateImg.src = this.selectedTemplate.image_storage_key;
    await new Promise((resolve) => {
      templateImg.onload = resolve;
      templateImg.onerror = resolve;
    });

    const finalCanvas = document.getElementById('finalCanvas');
    const tplWidth = templateImg.naturalWidth || this.selectedTemplate.width || ((this.selectedMode === 'strip') ? 600 : 1200);
    const tplHeight = templateImg.naturalHeight || this.selectedTemplate.height || 1800;
    if (finalCanvas) {
      finalCanvas.width = tplWidth;
      finalCanvas.height = tplHeight;
    }
    this.applyPreviewOrientationLayout(tplWidth, tplHeight);

    const dbW = this.selectedTemplate.width || tplWidth;
    const dbH = this.selectedTemplate.height || tplHeight;
    const rawSlots = Array.isArray(this.selectedTemplate.slots) ? this.selectedTemplate.slots : [];
    const isSvgTemplate = String(this.selectedTemplate.image_storage_key || '').toLowerCase().includes('.svg');
    const fitsNaturalImage = rawSlots.length > 0 && rawSlots.every(s =>
      (Number(s.x) || 0) >= -4 &&
      (Number(s.y) || 0) >= -4 &&
      ((Number(s.x) || 0) + (Number(s.width) || 0)) <= tplWidth + 4 &&
      ((Number(s.y) || 0) + (Number(s.height) || 0)) <= tplHeight + 4
    );
    // Admin Editor defines raster slot coordinates directly in natural PNG pixels (not preset dbW/dbH),
    // so keep 1:1 unless scaling an SVG or slots stored in a larger preset coordinate space.
    const shouldScale = (dbW > 0 && dbH > 0) && (dbW !== tplWidth || dbH !== tplHeight) && (isSvgTemplate || !fitsNaturalImage);
    const scaleX = shouldScale ? (tplWidth / dbW) : 1;
    const scaleY = shouldScale ? (tplHeight / dbH) : 1;

    let slots = rawSlots.length > 0
      ? rawSlots.map(s => ({
          ...s,
          x: Math.round(s.x * scaleX),
          y: Math.round(s.y * scaleY),
          width: Math.round(s.width * scaleX),
          height: Math.round(s.height * scaleY)
        }))
      : (this.selectedTemplate.orientation === 'strip'
        ? [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ]
        : [{ id: 'slot_1', pose_index: 1, x: Math.round(tplWidth * 0.06), y: Math.round(tplHeight * 0.06), width: Math.round(tplWidth * 0.88), height: Math.round(tplHeight * 0.78) }]);

    // Prepare frame overlay with green chroma keying inside slot regions
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = tplWidth;
    frameCanvas.height = tplHeight;
    const fCtx = frameCanvas.getContext('2d');
    fCtx.drawImage(templateImg, 0, 0, tplWidth, tplHeight);

    const useChromaKey = Boolean(this.selectedTemplate && (
      this.selectedTemplate.chroma_key === true ||
      this.selectedTemplate.chroma_key === 1 ||
      /^\/assets\/templates\/.*\.svg$/i.test(this.selectedTemplate.image_storage_key || '')
    ));

    try {
      const frameImgData = fCtx.getImageData(0, 0, tplWidth, tplHeight);
      const data = frameImgData.data;

      // Chroma predicate (hanya dipakai jika opsi Chroma Key Hijau diaktifkan manual di Admin atau template .svg sistem)
      function isGreen(r, g, b, a) {
        if (a < 50) return false;
        if (g >= 150 && r <= 100 && b <= 100) return true;
        if (g >= 135 && (g - r) >= 28 && (g - b) >= 32) return true;
        if (g >= 115 && (g - r) >= 35 && (g - b) >= 35) return true;
        return false;
      }

      // Guard for single-slot templates whose stored slot didn't cover the actual green rectangle (only when Chroma Key is enabled)
      if (useChromaKey && slots.length === 1) {
        let minGX = tplWidth, maxGX = -1, minGY = tplHeight, maxGY = -1, greenCount = 0;
        const step = 6;
        for (let y = 0; y < tplHeight; y += step) {
          for (let x = 0; x < tplWidth; x += step) {
            const idx = (y * tplWidth + x) * 4;
            if (isGreen(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) {
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
          if (gW > slots[0].width * 1.15 || gH > slots[0].height * 1.15) {
            slots = [{ id: slots[0].id || 'slot_1', pose_index: 1, x: minGX, y: minGY, width: gW, height: gH }];
          }
        }
      }

      // Process slot regions: hapus hijau HANYA jika useChromaKey aktif; kalau tidak, biarkan warna hijau frame aman
      const pad = 2;
      for (const slot of slots) {
        const sx0 = Math.max(0, Math.floor(slot.x));
        const ex0 = Math.min(tplWidth, Math.ceil(slot.x + slot.width));
        const sy0 = Math.max(0, Math.floor(slot.y));
        const ey0 = Math.min(tplHeight, Math.ceil(slot.y + slot.height));

        let sampled = 0, transCount = 0, greenCount = 0;
        for (let y = sy0; y < ey0; y += 4) {
          for (let x = sx0; x < ex0; x += 4) {
            const idx = (y * tplWidth + x) * 4;
            sampled++;
            if (data[idx + 3] < 50) transCount++;
            else if (useChromaKey && isGreen(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) greenCount++;
          }
        }

        if (useChromaKey) {
          const startX = Math.max(0, Math.floor(slot.x - pad));
          const endX = Math.min(tplWidth, Math.ceil(slot.x + slot.width + pad));
          const startY = Math.max(0, Math.floor(slot.y - pad));
          const endY = Math.min(tplHeight, Math.ceil(slot.y + slot.height + pad));

          for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
              const idx = (y * tplWidth + x) * 4;
              if (isGreen(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) {
                data[idx + 3] = 0; // Transparent!
              }
            }
          }
        }

        if (sampled > 0 && (transCount / sampled) < 0.05 && (!useChromaKey || (greenCount / sampled) < 0.05)) {
          const cx = Math.min(tplWidth - 1, Math.max(0, Math.floor(slot.x + slot.width / 2)));
          const cy = Math.min(tplHeight - 1, Math.max(0, Math.floor(slot.y + slot.height / 2)));
          const cIdx = (cy * tplWidth + cx) * 4;
          const bgR = data[cIdx], bgG = data[cIdx + 1], bgB = data[cIdx + 2];
          let matchCount = 0;
          for (let y = sy0; y < ey0; y += 4) {
            for (let x = sx0; x < ex0; x += 4) {
              const idx = (y * tplWidth + x) * 4;
              const diff = Math.abs(data[idx] - bgR) + Math.abs(data[idx + 1] - bgG) + Math.abs(data[idx + 2] - bgB);
              if (diff <= 45) matchCount++;
            }
          }
          if ((matchCount / sampled) >= 0.35) {
            for (let y = sy0; y < ey0; y++) {
              for (let x = sx0; x < ex0; x++) {
                const idx = (y * tplWidth + x) * 4;
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

      fCtx.putImageData(frameImgData, 0, 0);
    } catch (e) {
      console.warn('Frame chroma key processing error:', e);
    }

    this.selectedTemplate.slots = slots;

    const validPhotoIndices = this.posesCaptured
      .map((p, idx) => (p !== null ? idx : -1))
      .filter(idx => idx !== -1);
    const fallbackCount = Math.max(1, validPhotoIndices.length);

    // Initialize slot assignments if empty, slot count changed, or forced reset
    if (forceResetSlots || !this.slotAssignments || this.slotAssignments.length !== slots.length) {
      this.slotAssignments = slots.map((s, idx) => {
        const pIdx = ((s.pose_index || (idx + 1)) - 1);
        if (pIdx >= 0 && pIdx < this.posesCaptured.length && this.posesCaptured[pIdx] !== null) {
          return pIdx;
        }
        return validPhotoIndices[idx % fallbackCount] ?? 0;
      });
    }

    // Initialize transforms (pan & zoom) for each slot
    if (forceResetSlots || !this.slotTransforms || this.slotTransforms.length !== slots.length) {
      this.slotTransforms = slots.map(() => ({ panX: 0, panY: 0, zoom: 1.0 }));
    }
    this.selectedPreviewSlotIndex = 0;
    this.cachedPhotoImages = {};
    this.cachedKeyedFrame = frameCanvas;
  }

  async openChangeFrameModal() {
    const modal = document.getElementById('changeFrameModal');
    const grid = document.getElementById('changeFrameGrid');
    if (!modal || !grid) return;

    modal.style.display = 'flex';
    await this.fetchTemplates();

    const currentId = this.selectedTemplate ? this.selectedTemplate.id : null;
    const eventTemplates = (this.templates || []).filter(t => !t.event_id || t.event_id === this.eventId);
    const listToRender = eventTemplates.length > 0 ? eventTemplates : (this.templates || []);

    grid.innerHTML = listToRender.map((tpl) => {
      const isSelected = tpl.id === currentId;
      const fmtBadge = this.getTemplateFormatLabel(tpl);
      return `
        <div class="template-retro-card ${isSelected ? 'selected' : ''}" style="padding: 12px; cursor: pointer;" onclick="kiosk.applyFrameInPreview('${tpl.id}')">
          <div class="template-check-badge">✓</div>
          <div style="height: 155px; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; background: #FFFBF5; border-radius: 14px; border: 1.5px dashed #EAD8C7; overflow: hidden; padding: 6px;">
            <img src="${tpl.image_storage_key}" alt="${tpl.name}" style="max-height: 100%; max-width: 100%; object-fit: contain;">
          </div>
          <span class="badge-pill ${isSelected ? 'badge-coral' : 'badge-active'}" style="font-size: 10.5px; margin-bottom: 4px; padding: 3px 10px;">
            ${isSelected ? `✓ Dipakai (${fmtBadge})` : fmtBadge}
          </span>
          <h4 style="font-size: 14px; font-weight: 700; color: #7B482E; margin-top: 2px; font-family: var(--font-heading); line-height: 1.25;">${tpl.name}</h4>
        </div>
      `;
    }).join('');

    modal.style.display = 'flex';
  }

  closeChangeFrameModal(event) {
    if (event && event.target && event.target.closest('.photo-modal-card') && !event.target.classList.contains('photo-modal-close') && event.target.tagName !== 'BUTTON') {
      return;
    }
    const modal = document.getElementById('changeFrameModal');
    if (modal) modal.style.display = 'none';
  }

  async applyFrameInPreview(templateId) {
    const newTpl = (this.templates || []).find(t => t.id === templateId);
    if (!newTpl) return;

    this.selectedTemplate = newTpl;
    this.selectedMode = newTpl.orientation === 'strip' ? 'strip' : 'single';
    this.closeChangeFrameModal();

    await this.loadAndKeySelectedTemplate(true);
    await this.renderFinalCanvas();

    const badge = document.getElementById('activeSlotBadge');
    const targetName = document.getElementById('targetSlotName');
    if (badge) badge.innerText = 'Slot #1 Aktif';
    if (targetName) targetName.innerText = 'Slot #1';

    this.renderPreviewSlotTabs();
    this.renderPreviewPhotoTray();
    this.showToast(`🖼️ Frame berhasil diganti ke "${newTpl.name}"!`, '✨', 2200);
    this.syncFinalPhotoToBackend({ forceRegenerateBoomerang: true });
  }

  getPhotoFilterString(filterKey) {
    if (window.MafazaPhotoFilters) {
      return window.MafazaPhotoFilters.getScaledCssFilter(filterKey, this.activePhotoFilterIntensity || 1.0);
    }
    const filters = {
      normal: 'none',
      glowing: 'brightness(105%) contrast(102%) saturate(106%)',
      korean: 'brightness(108%) contrast(95%) saturate(103%)',
      warm_retro: 'sepia(22%) contrast(106%) brightness(102%) saturate(110%)',
      vivid: 'contrast(111%) saturate(126%) brightness(102%)',
      bw: 'grayscale(100%) contrast(114%) brightness(105%)',
      cinematic: 'contrast(112%) saturate(92%) brightness(100%) sepia(10%)'
    };
    return filters[filterKey] || 'none';
  }

  getPhotoFilterLabel(filterKey) {
    if (window.MafazaPhotoFilters) {
      return window.MafazaPhotoFilters.getLabel(filterKey, false);
    }
    const labels = {
      normal: '🌿 Normal',
      glowing: '✨ Glowing',
      korean: '🌸 Korean Soft',
      warm_retro: '🧡 Warm Retro',
      vivid: '🎨 Vivid Pop',
      bw: '🖤 B&W Estetik',
      cinematic: '🎬 Cinematic'
    };
    return labels[filterKey] || '🌿 Normal';
  }

  syncFilterControlsUI() {
    const activeKey = this.activePhotoFilter || 'normal';
    const pct = Math.round((typeof this.activePhotoFilterIntensity === 'number' ? this.activePhotoFilterIntensity : 1.0) * 100);
    const pills = document.querySelectorAll('#previewFiltersRow .preview-filter-pill');
    pills.forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-filter') === activeKey);
    });
    const badge = document.getElementById('activeFilterNameBadge');
    if (badge) {
      badge.innerText = activeKey !== 'normal' && pct < 100
        ? `${this.getPhotoFilterLabel(activeKey)} (${pct}%)`
        : this.getPhotoFilterLabel(activeKey);
    }
    const intRow = document.getElementById('kioskFilterIntensityRow');
    const intRange = document.getElementById('kioskFilterIntensityRange');
    const intLabel = document.getElementById('kioskFilterIntensityLabel');
    if (intRow) intRow.style.display = activeKey !== 'normal' ? 'flex' : 'none';
    if (intRange) intRange.value = String(pct);
    if (intLabel) intLabel.innerText = `${pct}%`;
  }

  async setPhotoFilter(filterKey) {
    this.activePhotoFilter = window.MafazaPhotoFilters
      ? window.MafazaPhotoFilters.normalizeFilterKey(filterKey)
      : (filterKey || 'normal');
    this._sessionFilterManuallyChosen = true;
    this.syncFilterControlsUI();
    await this.renderFinalCanvas();

    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = setTimeout(() => {
      const validPoses = (this.posesCaptured || []).filter(p => p !== null);
      this.syncFinalPhotoToBackend({ forceRegenerateBoomerang: validPoses.length >= 2 });
    }, 650);
  }

  async setPhotoFilterIntensity(percentVal) {
    const pct = Math.max(30, Math.min(100, parseInt(percentVal, 10) || 100));
    this.activePhotoFilterIntensity = pct / 100;
    this._sessionFilterManuallyChosen = true;
    this.syncFilterControlsUI();
    await this.renderFinalCanvas();

    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = setTimeout(() => {
      const validPoses = (this.posesCaptured || []).filter(p => p !== null);
      this.syncFinalPhotoToBackend({ forceRegenerateBoomerang: validPoses.length >= 2 });
    }, 750);
  }

  async renderFinalCanvas() {
    const finalCanvas = document.getElementById('finalCanvas');
    if (!finalCanvas || !this.selectedTemplate) return;
    const ctx = finalCanvas.getContext('2d');

    const slots = this.selectedTemplate.slots || [
      { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
      { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
      { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
    ];

    const tplWidth = finalCanvas.width;
    const tplHeight = finalCanvas.height;

    // 1. Solid canvas background (clean white)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tplWidth, tplHeight);

    // 2. LAYER BAWAH: Draw captured photos with pan & zoom into each slot
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const photoIdx = (this.slotAssignments && this.slotAssignments[i] !== undefined)
        ? this.slotAssignments[i]
        : (i % this.posesCaptured.length);
      const photoSrc = this.posesCaptured[photoIdx] || this.posesCaptured[0];

      if (photoSrc) {
        let pImg = this.cachedPhotoImages[photoIdx];
        if (!pImg) {
          pImg = new Image();
          pImg.src = photoSrc;
          await new Promise(res => { pImg.onload = res; pImg.onerror = res; });
          this.cachedPhotoImages[photoIdx] = pImg;
        }

        ctx.save();
        const bleed = 4;
        const clipX = slot.x - bleed;
        const clipY = slot.y - bleed;
        const clipW = slot.width + (bleed * 2);
        const clipH = slot.height + (bleed * 2);

        ctx.beginPath();
        ctx.rect(clipX, clipY, clipW, clipH);
        ctx.clip();

        const transform = (this.slotTransforms && this.slotTransforms[i]) || { panX: 0, panY: 0, zoom: 1.0 };
        const zoom = Math.max(0.35, Math.min(3.5, transform.zoom || 1.0));

        // Base cover scale: gambar otomatis mengisi slot secara proporsional
        const baseScale = Math.max(clipW / pImg.width, clipH / pImg.height);
        const finalScale = baseScale * zoom;

        const drawW = pImg.width * finalScale;
        const drawH = pImg.height * finalScale;

        // Batas pan fleksibel: tetap bebas digeser meski foto diperkecil (< 1.0x) atau pas ukuran slot
        const maxPanX = Math.max(Math.abs(drawW - clipW) / 2, Math.round(clipW * 0.45));
        const maxPanY = Math.max(Math.abs(drawH - clipH) / 2, Math.round(clipH * 0.45));

        transform.panX = Math.max(-maxPanX, Math.min(maxPanX, transform.panX || 0));
        transform.panY = Math.max(-maxPanY, Math.min(maxPanY, transform.panY || 0));

        const slotCenterX = clipX + (clipW / 2);
        const slotCenterY = clipY + (clipH / 2);

        // Jika slot di-mirror horizontal, balikkan arah panX secara internal agar arah geser jari tetap sesuai layar
        const effectivePanX = this.mirrorAllSlots ? -transform.panX : transform.panX;
        const drawX = slotCenterX - (drawW / 2) + effectivePanX;
        const drawY = slotCenterY - (drawH / 2) + transform.panY;

        if (this.mirrorAllSlots) {
          ctx.translate(slotCenterX * 2, 0);
          ctx.scale(-1, 1);
        }
        if (window.MafazaPhotoFilters) {
          window.MafazaPhotoFilters.drawFilteredImage(ctx, pImg, drawX, drawY, drawW, drawH, this.activePhotoFilter, {
            intensity: this.activePhotoFilterIntensity || 1.0,
            cacheKey: `${this.sessionId || 'k'}_pose_${photoIdx}`
          });
        } else {
          const filterStr = this.getPhotoFilterString(this.activePhotoFilter);
          if (filterStr && filterStr !== 'none') ctx.filter = filterStr;
          ctx.drawImage(pImg, drawX, drawY, drawW, drawH);
        }
        ctx.restore();
      }
    }

    // 3. LAYER ATAS: Draw frame overlay
    if (this.cachedKeyedFrame) {
      ctx.drawImage(this.cachedKeyedFrame, 0, 0, tplWidth, tplHeight);
    }

    this.updatePreviewSlotZoomBadge();
  }

  updatePreviewSlotZoomBadge() {
    const label = document.getElementById('previewSlotZoomLabel');
    if (!label) return;
    const idx = typeof this.selectedPreviewSlotIndex === 'number' ? this.selectedPreviewSlotIndex : 0;
    const tr = (this.slotTransforms && this.slotTransforms[idx]) || { zoom: 1.0 };
    const z = Math.max(0.35, Math.min(3.5, tr.zoom || 1.0));
    label.innerText = `🔍 ${z.toFixed(1)}x`;
  }

  setupCanvasInteractivePan() {
    const canvas = document.getElementById('finalCanvas');
    if (!canvas || this.canvasListenersAttached) return;
    this.canvasListenersAttached = true;
    canvas.style.touchAction = 'none';

    // Deteksi slot mana yang disentuh / diklik (prioritaskan area tepat di dalam slot dulu)
    const findSlotAt = (canvasX, canvasY) => {
      const slots = (this.selectedTemplate && this.selectedTemplate.slots && this.selectedTemplate.slots.length > 0)
        ? this.selectedTemplate.slots
        : [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ];

      if (slots.length === 1) return 0; // Frame 1-foto: seluruh area frame mengontrol slot 0

      const exactIdx = slots.findIndex(s =>
        canvasX >= s.x &&
        canvasX <= (s.x + s.width) &&
        canvasY >= s.y &&
        canvasY <= (s.y + s.height)
      );
      if (exactIdx !== -1) return exactIdx;

      const margin = Math.max(24, Math.round(canvas.width * 0.03));
      const idx = slots.findIndex(s =>
        canvasX >= (s.x - margin) &&
        canvasX <= (s.x + s.width + margin) &&
        canvasY >= (s.y - margin) &&
        canvasY <= (s.y + s.height + margin)
      );

      if (idx !== -1) return idx;
      return (typeof this.selectedPreviewSlotIndex === 'number' && this.selectedPreviewSlotIndex < slots.length)
        ? this.selectedPreviewSlotIndex
        : 0;
    };

    const getCanvasCoords = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
        scaleX,
        scaleY
      };
    };

    // State gesture
    this.isDraggingPhoto = false;
    this.isPinching = false;
    this.dragState = {
      lastClientX: 0,
      lastClientY: 0,
      scaleX: 1,
      scaleY: 1
    };
    this.pinchState = {
      initialDist: 0,
      initialZoom: 1.0,
      initialPanX: 0,
      initialPanY: 0,
      midX: 0,
      midY: 0,
      scaleX: 1,
      scaleY: 1
    };

    // 1. MOUSE DRAG & CLICK (Desktop / Laptop)
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const coords = getCanvasCoords(e.clientX, e.clientY);
      const slotIdx = findSlotAt(coords.x, coords.y);
      this.selectPreviewSlot(slotIdx);

      const idx = this.selectedPreviewSlotIndex;
      if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };

      this.isDraggingPhoto = true;
      this.dragState = {
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        scaleX: coords.scaleX,
        scaleY: coords.scaleY
      };
      canvas.style.cursor = 'grabbing';
      this.resetAutoReturnTimer();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDraggingPhoto || typeof this.selectedPreviewSlotIndex !== 'number') return;
      const idx = this.selectedPreviewSlotIndex;
      if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };

      const dx = (e.clientX - this.dragState.lastClientX) * this.dragState.scaleX;
      const dy = (e.clientY - this.dragState.lastClientY) * this.dragState.scaleY;

      this.dragState.lastClientX = e.clientX;
      this.dragState.lastClientY = e.clientY;

      this.slotTransforms[idx].panX = (this.slotTransforms[idx].panX || 0) + dx;
      this.slotTransforms[idx].panY = (this.slotTransforms[idx].panY || 0) + dy;
      this.syncDuplicateSlotTransforms(idx);

      this.renderFinalCanvas();
    });

    const stopMouseDrag = () => {
      if (this.isDraggingPhoto) {
        this.isDraggingPhoto = false;
        canvas.style.cursor = 'grab';
        this.resetAutoReturnTimer();
        this.debounceSyncSession();
      }
    };
    window.addEventListener('mouseup', stopMouseDrag);

    // 2. MOUSE WHEEL ZOOM (Trackpad / Scroll Wheel)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (typeof this.selectedPreviewSlotIndex !== 'number') return;
      const idx = this.selectedPreviewSlotIndex;
      if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };

      const deltaZoom = e.deltaY < 0 ? 0.08 : -0.08;
      this.slotTransforms[idx].zoom = Math.max(0.35, Math.min(3.5, (this.slotTransforms[idx].zoom || 1.0) + deltaZoom));
      this.syncDuplicateSlotTransforms(idx);
      this.renderFinalCanvas();
      this.resetAutoReturnTimer();
      this.debounceSyncSession();
    }, { passive: false });

    // 3. MULTI-TOUCH GESTURES (Tablet, HP, Touchscreen Monitor)
    canvas.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length === 0) return;
      e.preventDefault(); // Mencegah scrolling browser saat sentuh frame

      const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
      const slotIdx = findSlotAt(coords.x, coords.y);
      this.selectPreviewSlot(slotIdx);

      const idx = this.selectedPreviewSlotIndex;
      if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };

      if (e.touches.length === 1) {
        // Sentuhan 1 jari: Geser posisi foto (Pan / Drag)
        this.isDraggingPhoto = true;
        this.isPinching = false;
        this.dragState = {
          lastClientX: e.touches[0].clientX,
          lastClientY: e.touches[0].clientY,
          scaleX: coords.scaleX,
          scaleY: coords.scaleY
        };
      } else if (e.touches.length >= 2) {
        // Sentuhan 2 jari: Pinch to Zoom (Perbesar / Perkecil) & Geser Simultan
        this.isDraggingPhoto = false;
        this.isPinching = true;
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        this.pinchState = {
          initialDist: Math.max(15, dist),
          initialZoom: this.slotTransforms[idx].zoom || 1.0,
          initialPanX: this.slotTransforms[idx].panX || 0,
          initialPanY: this.slotTransforms[idx].panY || 0,
          midX,
          midY,
          scaleX: coords.scaleX,
          scaleY: coords.scaleY
        };
      }
      this.resetAutoReturnTimer();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!e.touches || e.touches.length === 0) return;
      if (this.isDraggingPhoto || this.isPinching) {
        e.preventDefault();
      }

      const idx = this.selectedPreviewSlotIndex;
      if (typeof idx !== 'number' || !this.slotTransforms[idx]) return;

      if (this.isPinching && e.touches.length >= 2) {
        // Eksekusi Pinch to Zoom & Pan
        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const scaleRatio = currentDist / this.pinchState.initialDist;
        this.slotTransforms[idx].zoom = Math.max(0.35, Math.min(3.5, this.pinchState.initialZoom * scaleRatio));

        const currentMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const currentMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const deltaMidX = (currentMidX - this.pinchState.midX) * this.pinchState.scaleX;
        const deltaMidY = (currentMidY - this.pinchState.midY) * this.pinchState.scaleY;

        this.slotTransforms[idx].panX = this.pinchState.initialPanX + deltaMidX;
        this.slotTransforms[idx].panY = this.pinchState.initialPanY + deltaMidY;
        this.syncDuplicateSlotTransforms(idx);

        this.renderFinalCanvas();
      } else if (this.isDraggingPhoto && e.touches.length === 1) {
        // Eksekusi Geser 1 Jari (Pan)
        const dx = (e.touches[0].clientX - this.dragState.lastClientX) * this.dragState.scaleX;
        const dy = (e.touches[0].clientY - this.dragState.lastClientY) * this.dragState.scaleY;

        this.dragState.lastClientX = e.touches[0].clientX;
        this.dragState.lastClientY = e.touches[0].clientY;

        this.slotTransforms[idx].panX = (this.slotTransforms[idx].panX || 0) + dx;
        this.slotTransforms[idx].panY = (this.slotTransforms[idx].panY || 0) + dy;
        this.syncDuplicateSlotTransforms(idx);

        this.renderFinalCanvas();
      }
    }, { passive: false });

    const stopTouch = (e) => {
      if (e && e.touches && e.touches.length === 1 && this.isPinching) {
        this.isPinching = false;
        this.isDraggingPhoto = true;
        const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
        this.dragState = {
          lastClientX: e.touches[0].clientX,
          lastClientY: e.touches[0].clientY,
          scaleX: coords.scaleX,
          scaleY: coords.scaleY
        };
        return;
      }

      if (this.isDraggingPhoto || this.isPinching) {
        this.isDraggingPhoto = false;
        this.isPinching = false;
        this.resetAutoReturnTimer();
        this.debounceSyncSession();
      }
    };

    window.addEventListener('touchend', stopTouch);
    window.addEventListener('touchcancel', stopTouch);

    // 4. POINTER EVENTS MULTI-TOUCH PINCH & DRAG (Stylus / Pen; touch sudah ditangani touchstart/touchmove)
    const activePointers = new Map();
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch') return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}

      const coords = getCanvasCoords(e.clientX, e.clientY);
      const slotIdx = findSlotAt(coords.x, coords.y);
      this.selectPreviewSlot(slotIdx);

      const idx = this.selectedPreviewSlotIndex;
      if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };

      if (activePointers.size === 1) {
        this.isDraggingPhoto = true;
        this.isPinching = false;
        this.dragState = {
          lastClientX: e.clientX,
          lastClientY: e.clientY,
          scaleX: coords.scaleX,
          scaleY: coords.scaleY
        };
      } else if (activePointers.size >= 2) {
        const pts = Array.from(activePointers.values());
        this.isDraggingPhoto = false;
        this.isPinching = true;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        this.pinchState = {
          initialDist: Math.max(15, dist),
          initialZoom: this.slotTransforms[idx].zoom || 1.0,
          initialPanX: this.slotTransforms[idx].panX || 0,
          initialPanY: this.slotTransforms[idx].panY || 0,
          midX,
          midY,
          scaleX: coords.scaleX,
          scaleY: coords.scaleY
        };
      }
      this.resetAutoReturnTimer();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || !activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const idx = this.selectedPreviewSlotIndex;
      if (typeof idx !== 'number' || !this.slotTransforms[idx]) return;

      if (activePointers.size >= 2 && this.isPinching) {
        const pts = Array.from(activePointers.values());
        const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const scaleRatio = currentDist / this.pinchState.initialDist;
        this.slotTransforms[idx].zoom = Math.max(0.35, Math.min(3.5, this.pinchState.initialZoom * scaleRatio));

        const currentMidX = (pts[0].x + pts[1].x) / 2;
        const currentMidY = (pts[0].y + pts[1].y) / 2;
        const deltaMidX = (currentMidX - this.pinchState.midX) * this.pinchState.scaleX;
        const deltaMidY = (currentMidY - this.pinchState.midY) * this.pinchState.scaleY;

        this.slotTransforms[idx].panX = this.pinchState.initialPanX + deltaMidX;
        this.slotTransforms[idx].panY = this.pinchState.initialPanY + deltaMidY;
        this.syncDuplicateSlotTransforms(idx);
        this.renderFinalCanvas();
      } else if (activePointers.size === 1 && this.isDraggingPhoto) {
        const dx = (e.clientX - this.dragState.lastClientX) * this.dragState.scaleX;
        const dy = (e.clientY - this.dragState.lastClientY) * this.dragState.scaleY;
        this.dragState.lastClientX = e.clientX;
        this.dragState.lastClientY = e.clientY;
        this.slotTransforms[idx].panX = (this.slotTransforms[idx].panX || 0) + dx;
        this.slotTransforms[idx].panY = (this.slotTransforms[idx].panY || 0) + dy;
        this.syncDuplicateSlotTransforms(idx);
        this.renderFinalCanvas();
      }
    });

    const endPointer = (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch') return;
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        if (this.isDraggingPhoto || this.isPinching) {
          this.isDraggingPhoto = false;
          this.isPinching = false;
          this.resetAutoReturnTimer();
          this.debounceSyncSession();
        }
      } else if (activePointers.size === 1) {
        const remaining = Array.from(activePointers.values())[0];
        const coords = getCanvasCoords(remaining.x, remaining.y);
        this.isPinching = false;
        this.isDraggingPhoto = true;
        this.dragState = {
          lastClientX: remaining.x,
          lastClientY: remaining.y,
          scaleX: coords.scaleX,
          scaleY: coords.scaleY
        };
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
  }

  selectPreviewSlot(slotIdx) {
    this.selectedPreviewSlotIndex = slotIdx;
    const badge = document.getElementById('activeSlotBadge');
    const targetName = document.getElementById('targetSlotName');
    if (badge) badge.innerText = `Slot #${slotIdx + 1} Aktif`;
    if (targetName) targetName.innerText = `Slot #${slotIdx + 1}`;

    this.renderPreviewSlotTabs();
    this.renderPreviewPhotoTray();
    this.updatePreviewSlotZoomBadge();
    this.resetAutoReturnTimer();
  }

  renderPreviewSlotTabs() {
    const container = document.getElementById('previewSlotButtons');
    if (!container || !this.selectedTemplate) return;
    const slots = this.selectedTemplate.slots || [];
    container.innerHTML = slots.map((s, idx) => {
      const isActive = (idx === this.selectedPreviewSlotIndex);
      return `
        <button type="button" class="preview-slot-tab ${isActive ? 'active' : ''}" onclick="kiosk.selectPreviewSlot(${idx})">
          Slot #${idx + 1}
        </button>
      `;
    }).join('');
  }

  renderPreviewPhotoTray() {
    const grid = document.getElementById('capturedPhotosGrid');
    if (!grid) return;
    const validPhotos = this.posesCaptured.filter(p => p !== null);

    grid.innerHTML = validPhotos.map((photoSrc, pIdx) => {
      const usedInSlots = [];
      if (this.slotAssignments) {
        this.slotAssignments.forEach((assignedPhotoIdx, slotIdx) => {
          if (assignedPhotoIdx === pIdx) usedInSlots.push(slotIdx + 1);
        });
      }

      const isAssignedToActive = (this.slotAssignments && this.slotAssignments[this.selectedPreviewSlotIndex] === pIdx);

      return `
        <div class="preview-photo-card ${isAssignedToActive ? 'active-in-slot' : ''}" onclick="kiosk.assignPhotoToActiveSlot(${pIdx})">
          <div style="height: 85px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #1e293b;">
            <img src="${photoSrc}" style="width: 100%; height: 100%; object-fit: cover;">
          </div>
          <div style="padding: 4px 6px; background: var(--cream-card); display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 11px; font-weight: 700; color: var(--caramel-brown);">Foto ${pIdx + 1}</span>
            ${isAssignedToActive ? `
              <span style="font-size: 9.5px; background: var(--coral); color: white; padding: 1px 5px; border-radius: 4px; font-weight: 700;">✓ Aktif</span>
            ` : usedInSlots.length > 0 ? `
              <span style="font-size: 9.5px; background: var(--border-soft); color: var(--caramel-brown); padding: 1px 4px; border-radius: 4px;">Slot ${usedInSlots.join(',')}</span>
            ` : `
              <span style="font-size: 9.5px; color: var(--text-muted);">Pilih ➔</span>
            `}
          </div>
        </div>
      `;
    }).join('');
  }

  getSlotPoseIndex(slotIdx) {
    const slots = (this.selectedTemplate && Array.isArray(this.selectedTemplate.slots)) ? this.selectedTemplate.slots : [];
    const slot = slots[slotIdx];
    return slot ? (parseInt(slot.pose_index, 10) || (slotIdx + 1)) : (slotIdx + 1);
  }

  getSyncedSlotIndices(slotIdx) {
    const slots = (this.selectedTemplate && Array.isArray(this.selectedTemplate.slots)) ? this.selectedTemplate.slots : [];
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

  assignPhotoToActiveSlot(photoIdx) {
    if (typeof this.selectedPreviewSlotIndex !== 'number') return;
    const slotIdx = this.selectedPreviewSlotIndex;
    this.syncDuplicateSlotPhoto(slotIdx, photoIdx);

    this.renderFinalCanvas();
    this.renderPreviewPhotoTray();
    this.showToast(`✨ Foto ${photoIdx + 1} dipasang di Slot #${slotIdx + 1}!`, '📸', 1500);
    this.resetAutoReturnTimer();
    this.debounceSyncSession();
  }

  panActiveSlot(deltaX, deltaY) {
    if (typeof this.selectedPreviewSlotIndex !== 'number') return;
    const idx = this.selectedPreviewSlotIndex;
    if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };
    this.slotTransforms[idx].panX += deltaX;
    this.slotTransforms[idx].panY += deltaY;
    this.syncDuplicateSlotTransforms(idx);
    this.renderFinalCanvas();
    this.resetAutoReturnTimer();
    this.debounceSyncSession();
  }

  zoomActiveSlot(deltaZoom) {
    if (typeof this.selectedPreviewSlotIndex !== 'number') return;
    const idx = this.selectedPreviewSlotIndex;
    if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };
    this.slotTransforms[idx].zoom = Math.max(0.35, Math.min(3.5, Number(((this.slotTransforms[idx].zoom || 1.0) + deltaZoom).toFixed(2))));
    this.syncDuplicateSlotTransforms(idx);
    this.renderFinalCanvas();
    this.resetAutoReturnTimer();
    this.debounceSyncSession();
  }

  resetActiveSlotTransform() {
    if (typeof this.selectedPreviewSlotIndex !== 'number') return;
    const idx = this.selectedPreviewSlotIndex;
    this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };
    this.syncDuplicateSlotTransforms(idx);
    this.renderFinalCanvas();
    this.resetAutoReturnTimer();
    this.debounceSyncSession();
  }

  toggleMirrorAllSlots() {
    this.mirrorAllSlots = !this.mirrorAllSlots;
    this.renderFinalCanvas();
    this.showToast(
      this.mirrorAllSlots ? '↔️ Mode Mirror Diaktifkan' : '↔️ Mode Normal (Teks Tidak Terbalik)',
      '✨',
      1800
    );
    this.resetAutoReturnTimer();
    this.debounceSyncSession();
  }

  resetAutoReturnTimer(seconds = 45) {
    if (this.autoReturnTimerId) {
      clearInterval(this.autoReturnTimerId);
      this.autoReturnTimerId = null;
    }
  }

  debounceSyncSession() {
    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = setTimeout(() => {
      this.syncFinalPhotoToBackend();
    }, 800);
  }

  async dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  async generateBoomerangBlob(poses) {
    if (!poses || poses.length < 1) return null;
    try {
      const imgElements = await Promise.all(poses.map(src => {
        return new Promise(resolve => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = src;
        });
      }));
      const validImgs = imgElements.filter(img => img !== null);
      if (validImgs.length < 1) return null;

      const finalCanvas = document.getElementById('finalCanvas');
      const canvas = document.createElement('canvas');
      const tplWidth = finalCanvas ? finalCanvas.width : (validImgs[0].naturalWidth || 1200);
      const tplHeight = finalCanvas ? finalCanvas.height : (validImgs[0].naturalHeight || 1800);
      canvas.width = tplWidth;
      canvas.height = tplHeight;
      const ctx = canvas.getContext('2d');

      const slots = (this.selectedTemplate && this.selectedTemplate.slots && this.selectedTemplate.slots.length > 0)
        ? this.selectedTemplate.slots
        : [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ];

      // Ping-pong sequence of pose offsets / subtle motions
      const steps = [];
      const numPoses = validImgs.length;
      if (numPoses >= 2) {
        for (let i = 0; i < numPoses; i++) steps.push(i);
        for (let i = numPoses - 2; i > 0; i--) steps.push(i);
      } else {
        steps.push(0, 0, 0, 0);
      }

      const mimeTypes = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
      const mime = mimeTypes.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || 'video/webm';

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };

      const totalLoops = 3;
      const totalFrames = steps.length * totalLoops;

      return await new Promise((resolve) => {
        recorder.onstop = () => {
          resolve({ blob: new Blob(chunks, { type: mime }), ext: mime.includes('mp4') ? 'mp4' : 'webm' });
        };
        recorder.start();

        let frameIdx = 0;
        const interval = setInterval(() => {
          if (frameIdx >= totalFrames) {
            clearInterval(interval);
            recorder.stop();
            return;
          }

          const stepOffset = steps[frameIdx % steps.length];

          // 1. Solid canvas background
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, tplWidth, tplHeight);

          // 2. Render each slot with framed photo animation
          for (let sIdx = 0; sIdx < slots.length; sIdx++) {
            const slot = slots[sIdx];
            const slotPoseIdx = (slot.pose_index && parseInt(slot.pose_index, 10) > 0)
              ? ((parseInt(slot.pose_index, 10) - 1) % validImgs.length)
              : (sIdx % validImgs.length);
            const basePhotoIdx = (this.slotAssignments && this.slotAssignments[sIdx] !== undefined)
              ? this.slotAssignments[sIdx]
              : slotPoseIdx;
            
            const activePhotoIdx = (basePhotoIdx + stepOffset) % validImgs.length;
            const pImg = validImgs[activePhotoIdx] || validImgs[0];

            if (pImg) {
              ctx.save();
              const bleed = 4;
              const clipX = slot.x - bleed;
              const clipY = slot.y - bleed;
              const clipW = slot.width + (bleed * 2);
              const clipH = slot.height + (bleed * 2);

              ctx.beginPath();
              ctx.rect(clipX, clipY, clipW, clipH);
              ctx.clip();

              const transform = (this.slotTransforms && this.slotTransforms[sIdx]) || { panX: 0, panY: 0, zoom: 1.0 };
              const zoom = Math.max(0.35, Math.min(3.5, transform.zoom || 1.0));

              const baseScale = Math.max(clipW / pImg.width, clipH / pImg.height);
              const finalScale = baseScale * zoom;

              const drawW = pImg.width * finalScale;
              const drawH = pImg.height * finalScale;

              const slotCenterX = clipX + (clipW / 2);
              const slotCenterY = clipY + (clipH / 2);

              const drawX = slotCenterX - (drawW / 2) + (transform.panX || 0);
              const drawY = slotCenterY - (drawH / 2) + (transform.panY || 0);

              if (window.MafazaPhotoFilters) {
                window.MafazaPhotoFilters.drawFilteredImage(ctx, pImg, drawX, drawY, drawW, drawH, this.activePhotoFilter, {
                  intensity: this.activePhotoFilterIntensity || 1.0,
                  cacheKey: `${this.sessionId || 'k'}_bm_${activePhotoIdx}`
                });
              } else {
                ctx.drawImage(pImg, drawX, drawY, drawW, drawH);
              }
              ctx.restore();
            }
          }

          // 3. LAYER ATAS: Draw frame overlay on top of every single frame
          if (this.cachedKeyedFrame) {
            ctx.drawImage(this.cachedKeyedFrame, 0, 0, tplWidth, tplHeight);
          }

          frameIdx++;
        }, 240);
      });
    } catch (e) {
      console.warn('Could not generate framed boomerang blob:', e);
      return null;
    }
  }

  async syncFinalPhotoToBackend(options = {}) {
    const finalCanvas = document.getElementById('finalCanvas');
    if (!finalCanvas || !this.sessionId) return;

    const needSyncRaw = (this.rawPosesSyncedForSession !== this.sessionId);
    const needSyncBoomerang = needSyncRaw || !!options.forceRegenerateBoomerang;

    // Convert raw pose photos to blobs only on first sync for this session (cap <= 2160px HD so VPS RAM stays light)
    const rawBlobs = [];
    let bmResult = null;
    if (needSyncRaw && this.posesCaptured && this.posesCaptured.length > 0) {
      for (let i = 0; i < this.posesCaptured.length; i++) {
        let poseData = this.posesCaptured[i];
        if (poseData && poseData.startsWith('data:')) {
          try {
            if (typeof this.downscaleDataUrlIfLarge === 'function') {
              poseData = await this.downscaleDataUrlIfLarge(poseData, 2160);
            }
            const b = await this.dataUrlToBlob(poseData);
            rawBlobs.push({ blob: b, poseIndex: i + 1 });
          } catch (e) {}
        }
      }
    }

    if (needSyncBoomerang && this.posesCaptured && this.posesCaptured.length > 0) {
      // Generate Boomerang clip if we have at least 2 poses
      const validPoses = this.posesCaptured.filter(p => p !== null && p.startsWith('data:'));
      if (validPoses.length >= 2) {
        try {
          bmResult = await this.generateBoomerangBlob(validPoses);
        } catch (e) {}
      }
    }

    finalCanvas.toBlob(async (blob) => {
      const formData = new FormData();
      formData.append('finalImage', blob, `final_${Date.now()}.jpg`);
      formData.append('printRequested', 'false');
      if (this.guestPass && this.guestPass.id) {
        formData.append('guestPassId', this.guestPass.id);
      }
      if (this.selectedTemplate && this.selectedTemplate.id) {
        formData.append('templateId', this.selectedTemplate.id);
      }

      if (needSyncRaw) {
        rawBlobs.forEach(item => {
          formData.append('captures', item.blob, `pose_${item.poseIndex}_${Date.now()}.jpg`);
        });

        // Upload live video clips for each pose (iPhone Live Photo style)
        if (this.liveClips && this.liveClips.length > 0) {
          this.liveClips.forEach((clipBlob, idx) => {
            if (clipBlob) {
              const ext = (clipBlob.type && clipBlob.type.includes('mp4')) ? 'mp4' : 'webm';
              formData.append('liveClips', clipBlob, `live_pose_${idx + 1}_${Date.now()}.${ext}`);
            }
          });
        }

        if (this.liveClips && this.liveClips[0]) {
          const firstClip = this.liveClips[0];
          const ext = (firstClip.type && firstClip.type.includes('mp4')) ? 'mp4' : 'webm';
          formData.append('livePhoto', firstClip, `livephoto_${Date.now()}.${ext}`);
        }
      }

      if (needSyncBoomerang && bmResult && bmResult.blob) {
        formData.append('boomerang', bmResult.blob, `boomerang_${Date.now()}.${bmResult.ext}`);
      }

      if (!navigator.onLine || this.isLocalDirectMode()) {
        this.saveOfflineSessionBackup(blob, {
          captures: rawBlobs,
          boomerangBlob: bmResult ? bmResult.blob : null,
          boomerangExt: bmResult ? bmResult.ext : 'mp4',
          printRequested: false,
          printCopies: 1
        });
        return;
      }

      try {
        const res = await this.fetchWithTimeout(`/api/kiosk/sessions/${this.sessionId}/complete`, {
          method: 'POST',
          body: formData
        }, 35000);
        if (res.ok && needSyncRaw) {
          this.rawPosesSyncedForSession = this.sessionId;
        }
      } catch (e) {
        console.warn('Error syncing session, saving offline:', e);
        this.saveOfflineSessionBackup(blob, {
          captures: rawBlobs,
          boomerangBlob: bmResult ? bmResult.blob : null,
          boomerangExt: bmResult ? bmResult.ext : 'mp4',
          printRequested: false,
          printCopies: 1
        });
      }
    }, 'image/jpeg', 0.88);
  }

  saveOfflineSessionBackup(finalImageBlob, opts = {}) {
    if (!window.pbOfflineStore) return;
    const rawOptsCaptures = Array.isArray(opts.captures) ? opts.captures : [];
    const captures = rawOptsCaptures.length > 0
      ? rawOptsCaptures
      : (this.posesCaptured || [])
          .map((p, idx) => (p ? { poseIndex: idx + 1, blob: p } : null))
          .filter(Boolean);
    window.pbOfflineStore.saveSession({
      id: this.sessionId,
      tenantId: this.tenantId,
      eventId: this.eventId,
      deviceId: this.deviceId,
      guestPassId: this.guestPass ? this.guestPass.id : null,
      guestPassToken: this.guestPass ? (this.guestPass.token || this.guestPass.token_plain || null) : null,
      guestPassGalleryUrl: this.guestPass ? (this.guestPass.galleryUrl || null) : null,
      guestPassQrDataUrl: this.guestPass ? (this.guestPass.qrDataUrl || null) : null,
      templateId: this.selectedTemplate ? this.selectedTemplate.id : null,
      templateName: this.selectedTemplate ? this.selectedTemplate.name : null,
      mode: this.selectedMode,
      finalImageBlob,
      captures,
      liveClips: this.liveClips,
      boomerangBlob: opts.boomerangBlob || null,
      boomerangExt: opts.boomerangExt || 'mp4',
      printRequested: Boolean(opts.printRequested),
      printCopies: parseInt(opts.printCopies, 10) || 1,
      printPaperSize: opts.printPaperSize || null,
      paperConfirmed: Boolean(opts.paperConfirmed),
      preservePrintFlags: opts.preservePrintFlags !== undefined ? Boolean(opts.preservePrintFlags) : !opts.printRequested
    }).catch(err => console.warn('Offline session save error:', err));
  }

  syncPrintOptionsModalLabels() {
    const isLocal = this.isLocalDirectMode();
    const sub = document.getElementById('kioskPrintModalSubtitle');
    const confirmBtn = document.getElementById('kioskPrintModalConfirmBtn');
    const notice5r = document.getElementById('kioskPrint5rNoticeText');
    const readyRow = document.getElementById('kioskPaperReadyRow');
    if (sub) {
      sub.innerText = isLocal
        ? 'Mode Lokal Aktif: langsung cetak ke printer laptop tanpa kirim ke server'
        : 'Pilih jumlah lembar & ukuran kertas sebelum dikirim ke antrean server';
    }
    if (confirmBtn) {
      confirmBtn.innerText = isLocal
        ? '⚡ Cetak Langsung di Laptop (Tanpa Server)'
        : '🚀 Kirim Cetak ke Antrean Server';
    }
    if (notice5r) {
      notice5r.innerHTML = isLocal
        ? '<strong>⚠️ Kertas 5R (Mode Lokal):</strong> Pastikan kertas <strong>5R (13×18 cm)</strong> sudah terpasang di printer yang tercolok ke laptop ini sebelum mencetak.'
        : '<strong>⚠️ Konfirmasi Kertas 5R:</strong> Laptop Stasiun Printer akan menampilkan popup pengingat ganti kertas 5R sebelum mencetak ke Epson.';
    }
    if (readyRow) {
      readyRow.style.display = isLocal ? 'none' : 'flex';
    }
  }

  openPrintOptionsModal() {
    const modal = document.getElementById('kioskPrintOptionsModal');
    if (!modal) {
      this.printCurrentSession(false);
      return;
    }
    const sel = document.getElementById('printCopiesSelect');
    const curCopies = parseInt(sel?.value || '1', 10) || 1;
    this.setModalPrintCopies(curCopies);

    const tpl = this.selectedTemplate;
    const is5rTpl = Boolean(tpl && (
      String(tpl.paper_format || '').toUpperCase() === '5R' ||
      /5r|5x7|1500x2100|2100x1500/i.test(`${tpl.name || ''} ${tpl.orientation || ''} ${tpl.width || ''}x${tpl.height || ''}`)
    ));
    this.setModalPrintPaper(is5rTpl ? '5R' : '4R');

    const readyCheck = document.getElementById('kioskPaperAlreadyReadyCheck');
    if (readyCheck) readyCheck.checked = false;
    this.syncPrintOptionsModalLabels();
    modal.style.display = 'flex';
  }

  closePrintOptionsModal(event) {
    if (event && event.target && event.target.closest('.photo-modal-card') && !event.target.classList.contains('photo-modal-close')) {
      return;
    }
    const modal = document.getElementById('kioskPrintOptionsModal');
    if (modal) modal.style.display = 'none';
  }

  setModalPrintCopies(qty) {
    const val = Math.max(1, Math.min(10, parseInt(qty, 10) || 1));
    this.modalPrintCopies = val;
    const qtyEl = document.getElementById('kioskPrintModalQty');
    if (qtyEl) qtyEl.innerText = String(val);
    const sel = document.getElementById('printCopiesSelect');
    if (sel && Array.from(sel.options).some(o => Number(o.value) === val)) {
      sel.value = String(val);
    }
    document.querySelectorAll('.kiosk-qty-chip').forEach(btn => {
      const active = Number(btn.dataset.qty) === val;
      btn.style.background = active ? 'var(--coral)' : '';
      btn.style.color = active ? '#fff' : '';
      btn.style.borderColor = active ? 'var(--coral)' : '';
    });
  }

  adjustModalPrintCopies(delta) {
    this.setModalPrintCopies((this.modalPrintCopies || 1) + delta);
  }

  setModalPrintPaper(size) {
    this.modalPrintPaper = size === '5R' ? '5R' : '4R';
    const opt4 = document.getElementById('kioskPaperOpt4R');
    const opt5 = document.getElementById('kioskPaperOpt5R');
    const notice5r = document.getElementById('kioskPrint5rNotice');
    if (opt4) {
      const a = this.modalPrintPaper === '4R';
      opt4.style.borderColor = a ? 'var(--coral)' : 'var(--border-soft)';
      opt4.style.background = a ? 'rgba(230,120,107,0.12)' : '#fff';
    }
    if (opt5) {
      const a = this.modalPrintPaper === '5R';
      opt5.style.borderColor = a ? '#D4A754' : 'var(--border-soft)';
      opt5.style.background = a ? '#FFF8E6' : '#fff';
    }
    if (notice5r) {
      notice5r.style.display = this.modalPrintPaper === '5R' ? 'block' : 'none';
    }
  }

  resolveSelectedServerPaperSize() {
    if (this.modalPrintPaper === '5R') return '5x7';
    if (this.selectedMode === 'strip') return '2x6';
    return '4x6';
  }

  confirmSendServerPrint() {
    const copies = this.modalPrintCopies || parseInt(document.getElementById('printCopiesSelect')?.value || '1', 10) || 1;
    const paperSize = this.resolveSelectedServerPaperSize();
    const paperConfirmed = this.modalPrintPaper === '5R'
      ? Boolean(document.getElementById('kioskPaperAlreadyReadyCheck')?.checked)
      : true;
    const modal = document.getElementById('kioskPrintOptionsModal');
    if (modal) modal.style.display = 'none';
    this.printCurrentSession(false, { copies, paperSize, paperLabel: this.modalPrintPaper, paperConfirmed });
  }

  printFromModalViaDevice() {
    const copies = this.modalPrintCopies || 1;
    const paperSize = this.resolveSelectedServerPaperSize();
    const paperWidthIn = paperSize === '5x7' ? 5 : 4;
    const paperHeightIn = paperSize === '5x7' ? 7 : 6;
    const modal = document.getElementById('kioskPrintOptionsModal');
    if (modal) modal.style.display = 'none';
    this.printViaChromeDialog({ copies, paperSize, paperWidthIn, paperHeightIn, borderless: true });
  }

  async resolvePrintableQrImage() {
    const domImg = document.getElementById('guestQrCodeImg');
    if (domImg && domImg.src && domImg.complete && domImg.naturalWidth > 0) {
      return domImg;
    }
    const qrSrc = (this.guestPass && this.guestPass.qrDataUrl) || (domImg && domImg.src) || '';
    if (!qrSrc || !qrSrc.startsWith('data:')) return null;
    try {
      const loaded = new Image();
      loaded.src = qrSrc;
      await Promise.race([
        new Promise((res) => { loaded.onload = res; loaded.onerror = res; }),
        new Promise((res) => setTimeout(res, 600))
      ]);
      return loaded.naturalWidth > 0 ? loaded : null;
    } catch (e) {
      return null;
    }
  }

  async buildPrintableDataUrl(paperSize = '4x6', includeQr = true) {
    const finalCanvas = document.getElementById('finalCanvas');
    if (!finalCanvas) return null;

    const tpl = this.selectedTemplate || null;
    const rawQrCoords = (tpl && Array.isArray(tpl.qr_coords) && tpl.qr_coords.length > 0) ? tpl.qr_coords : null;
    const qrPos = (tpl && tpl.qr_position) || 'bottom-right';
    const qrEnabled = Boolean(rawQrCoords) || (qrPos !== 'none');

    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = finalCanvas.width;
    baseCanvas.height = finalCanvas.height;
    const bCtx = baseCanvas.getContext('2d');
    bCtx.drawImage(finalCanvas, 0, 0);

    if (includeQr && qrEnabled) {
      if (!this.guestPass) {
        try { await this.ensureGuestPassReady(); } catch (e) {}
      }
      if (this.guestPass) {
        try {
          const qrImg = await this.resolvePrintableQrImage();
          if (qrImg) {
            const tplSize = (tpl && tpl.width && tpl.height) ? { width: tpl.width, height: tpl.height } : null;
            this.drawQrOnCanvas(bCtx, baseCanvas.width, baseCanvas.height, qrImg, rawQrCoords || qrPos, tplSize);
          }
        } catch (e) {}
      }
    }

    // Untuk strip 2×6 pada kertas 4R, susun 2 strip berdampingan agar tidak ter-crop saat dicetak lokal
    if (paperSize === '2x6' && baseCanvas.width > 0 && baseCanvas.width * 1.8 <= baseCanvas.height) {
      const sheet = document.createElement('canvas');
      sheet.width = baseCanvas.width * 2;
      sheet.height = baseCanvas.height;
      const sCtx = sheet.getContext('2d');
      sCtx.fillStyle = '#ffffff';
      sCtx.fillRect(0, 0, sheet.width, sheet.height);
      sCtx.drawImage(baseCanvas, 0, 0);
      sCtx.drawImage(baseCanvas, baseCanvas.width, 0);
      return sheet.toDataURL('image/png');
    }

    return baseCanvas.toDataURL('image/png');
  }

  async printLocallyWithoutServer({ blob, copies, paperSize, paperLabel, btn, banner }) {
    const qty = Math.max(1, parseInt(copies, 10) || 1);
    const paperWidthIn = paperSize === '5x7' ? 5 : 4;
    const paperHeightIn = paperSize === '5x7' ? 7 : 6;
    const finalCanvas = document.getElementById('finalCanvas');
    const isLandscape = finalCanvas ? (finalCanvas.width > finalCanvas.height) : false;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '⚡ Mencetak Langsung di Laptop...';
    }
    if (banner) {
      banner.style.display = 'block';
      banner.innerText = `⚡ Mode Lokal: Mencetak ${qty}× ${paperLabel} langsung ke printer laptop...`;
    }

    const imageDataUrl = await this.buildPrintableDataUrl(paperSize, true);
    let savedSettings = {};
    let savedProfile = this.cachedPrinterProfile || {};
    try { savedSettings = JSON.parse(localStorage.getItem('pb_printer_settings') || '{}'); } catch (e) {}
    try {
      if (!savedProfile || !savedProfile.settings) {
        savedProfile = JSON.parse(localStorage.getItem('pb_printer_profile_cache') || '{}');
      }
    } catch (e) {}
    const profSettings = savedProfile.settings || {};

    let printedViaLocalAgent = false;
    let agentPrinterName = savedSettings.model || this.activePrinterName || 'Printer Laptop';
    if (imageDataUrl) {
      try {
        const res = await this.fetchWithTimeout('http://127.0.0.1:19899/print', {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageDataUrl,
            copies: qty,
            paperSize,
            paperWidthIn,
            paperHeightIn,
            orientation: isLandscape ? 'landscape' : 'portrait',
            printerName: savedSettings.model || savedProfile.name || '',
            driverName: savedProfile.driverName || savedSettings.model || '',
            mediaType: savedSettings.mediaType || savedProfile.mediaType || 'photographic-glossy',
            borderless: savedSettings.borderless !== undefined ? Boolean(savedSettings.borderless) : (profSettings.borderless !== false),
            highDpi: savedSettings.highDpi !== undefined ? Boolean(savedSettings.highDpi) : (profSettings.highDpi !== false)
          })
        }, 2500);
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok) {
            printedViaLocalAgent = true;
            if (data.printerName) agentPrinterName = data.printerName;
          }
        }
      } catch (e) {
        // Print Agent lokal tidak berjalan pada port 19899; lanjut dialog cetak browser seketika
      }
    }

    if (!printedViaLocalAgent) {
      this.printViaChromeDialog({
        copies: qty,
        paperSize,
        paperWidthIn,
        paperHeightIn,
        borderless: true,
        orientation: isLandscape ? 'landscape' : 'portrait'
      });
    }

    // Simpan foto digital secara lokal (printRequested: false agar tidak mencetak dobel saat sync nanti)
    if (blob) {
      this.saveOfflineSessionBackup(blob, { printRequested: false, printCopies: qty });
    }

    if (btn) btn.innerHTML = printedViaLocalAgent ? `✅ ${qty}× ${paperLabel} Dicetak Langsung!` : `✅ Dialog Cetak ${qty}× ${paperLabel} Dibuka`;
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = printedViaLocalAgent
        ? `🔌 <strong>Mode Lokal:</strong> <strong>${qty} lembar (${paperLabel})</strong> langsung dicetak ke <strong>${agentPrinterName}</strong> tanpa kirim ke server!`
        : `🔌 <strong>Mode Lokal:</strong> Cetak langsung <strong>${qty} lembar (${paperLabel})</strong> dipicu dari browser laptop (tanpa kirim ke server).`;
    }
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '🖨️ Cetak Foto Sekarang';
      }
    }, 2800);
  }

  async printCurrentSession(isAuto = false, opts = null) {
    const copies = String((opts && opts.copies) || document.getElementById('printCopiesSelect')?.value || 1);
    const chosenPaperSize = (opts && opts.paperSize) || (this.selectedTemplate?.paper_format === '5R' ? '5x7' : (this.selectedMode === 'strip' ? '2x6' : '4x6'));
    const chosenPaperLabel = (opts && opts.paperLabel) || (chosenPaperSize === '5x7' ? '5R' : '4R');
    const paperConfirmed = opts ? !!opts.paperConfirmed : (chosenPaperLabel !== '5R');
    const finalCanvas = document.getElementById('finalCanvas');
    const btn = document.getElementById('btnPrintSession');
    const banner = document.getElementById('printStatusBanner');
    const isLocalMode = this.isLocalDirectMode();

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = isLocalMode
        ? '⚡ Mencetak Langsung di Laptop...'
        : (isAuto ? '⚡ Mencetak Otomatis...' : '⏳ Mengirim ke Antrean Server...');
    }
    if (banner) {
      banner.style.display = 'block';
      banner.innerText = isLocalMode
        ? `🔌 Mode Lokal: Menyiapkan cetak ${chosenPaperLabel} (${copies} lbr) di laptop...`
        : `⏳ Mengirim pesanan ${chosenPaperLabel} (${copies} lbr) ke Server...`;
    }

    finalCanvas.toBlob(async (blob) => {
      // 1. Jika Mode Lokal aktif -> langsung cetak di laptop tanpa menunggu / mengirim ke server!
      if (isLocalMode) {
        await this.printLocallyWithoutServer({
          blob,
          copies,
          paperSize: chosenPaperSize,
          paperLabel: chosenPaperLabel,
          btn,
          banner
        });
        return;
      }

      // 2. Jika Offline total (Mode Pesawat / Jaringan Terputus):
      if (!navigator.onLine) {
        this.saveOfflineSessionBackup(blob, {
          printRequested: true,
          printCopies: parseInt(copies, 10) || 1,
          printPaperSize: chosenPaperSize,
          paperConfirmed: Boolean(paperConfirmed)
        });

        if (btn) btn.innerHTML = `✅ ${copies} Lembar Disimpan Offline`;
        if (banner) {
          banner.style.display = 'block';
          banner.innerHTML = `⚡ <strong>Mode Offline:</strong> Foto disimpan lokal (${chosenPaperLabel} × ${copies}) &amp; akan dicetak saat terhubung kembali.`;
        }
        setTimeout(() => {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🖨️ Cetak Foto Sekarang';
          }
        }, 3000);
        return;
      }

      // 3. Jika Online & Mode Server (Kirim ke Server -> Laptop Stasiun Printer / Print Agent / Admin Progres):
      const formData = new FormData();
      formData.append('finalImage', blob, `print_${Date.now()}.jpg`);
      formData.append('printRequested', 'true');
      formData.append('printCopies', copies);
      formData.append('printPaperSize', chosenPaperSize);
      if (paperConfirmed) formData.append('paperConfirmed', 'true');
      if (this.guestPass && this.guestPass.id) {
        formData.append('guestPassId', this.guestPass.id);
      }
      if (this.selectedTemplate && this.selectedTemplate.id) {
        formData.append('templateId', this.selectedTemplate.id);
      }

      try {
        const res = await this.fetchWithTimeout(`/api/kiosk/sessions/${this.sessionId}/complete`, {
          method: 'POST',
          body: formData
        }, 35000);
        if (res.ok) {
          const data = await res.json();
          const job = data.printJob || {};
          const pName = job.printerName || this.activePrinterName || 'Printer Studio';
          const dispatchedToOs = !!job.dispatchedToOs;
          const awaitingAgent = !!job.awaitingAgent;
          const requiresPaperConfirm = !!job.requiresPaperConfirm;
          const pLabel = job.paperLabel || chosenPaperLabel;

          if (btn) btn.innerHTML = requiresPaperConfirm ? `⏳ Tunggu Kertas 5R (${copies}×)` : `✅ ${copies}× ${pLabel} Terkirim!`;
          if (banner) {
            banner.style.display = 'block';
            if (requiresPaperConfirm) {
              banner.innerHTML = `📄 <strong>Antrean 5R (${copies} lembar) terkirim ke Server!</strong><br>Menunggu konfirmasi kertas 5R di Laptop Printer / Admin.`;
            } else if (dispatchedToOs || awaitingAgent) {
              banner.innerHTML = `✅ <strong>${copies} lembar (${pLabel})</strong> langsung dicetak otomatis di <strong>${pName}</strong>!`;
            } else {
              banner.innerHTML = `✅ <strong>Pesanan ${pLabel} (${copies} lembar) terkirim ke Server!</strong> Siap diterima Laptop Printer / Admin Progres Print.`;
            }
          }

          setTimeout(() => {
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = '🖨️ Cetak Foto Sekarang';
            }
          }, 3200);
        } else {
          throw new Error('Server response not ok');
        }
      } catch (e) {
        console.warn('Print fetch failed, switching to offline fallback:', e);
        this.saveOfflineSessionBackup(blob, {
          printRequested: true,
          printCopies: parseInt(copies, 10) || 1,
          printPaperSize: chosenPaperSize,
          paperConfirmed: Boolean(paperConfirmed)
        });

        if (btn) btn.innerHTML = `⚠️ Gagal Kirim, Disimpan Lokal`;
        if (banner) {
          banner.style.display = 'block';
          banner.innerHTML = `⚡ <strong>Koneksi terganggu:</strong> Antrean cetak <strong>${copies} lbr (${chosenPaperLabel})</strong> disimpan lokal di perangkat.`;
        }
        setTimeout(() => {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🖨️ Cetak Foto Sekarang';
          }
        }, 3000);
      }
    }, 'image/jpeg', 0.88);
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

  drawQrOnCanvas(ctx, w, h, qrImg, positionOrList = 'bottom-right', tplSize = null) {
    if (!qrImg || positionOrList === 'none') return;

    if (Array.isArray(positionOrList) && positionOrList.length > 0) {
      const refW = (tplSize && tplSize.width) || w;
      const refH = (tplSize && tplSize.height) || h;
      const sx = w / Math.max(1, refW);
      const sy = h / Math.max(1, refH);
      for (const item of positionOrList) {
        const sizePx = Math.max(60, Math.round((Number(item.size) || 150) * Math.min(sx, sy)));
        this.drawQrCardAt(
          ctx,
          (Number(item.x) || 0) * sx,
          (Number(item.y) || 0) * sy,
          w,
          h,
          qrImg,
          sizePx
        );
      }
      return;
    }

    const isStrip = (w <= 700);
    const qrSize = isStrip ? 100 : 140;
    const pad = Math.max(4, Math.round(qrSize * 0.05));
    const cardSize = qrSize + pad * 2;
    const marginX = isStrip ? 18 : 32;
    const marginY = isStrip ? 18 : 32;

    if (positionOrList === 'dual-bottom-right') {
      const halfW = Math.round(w / 2);
      const qSize = Math.round(Math.min(w, h) * 0.115);
      this.drawQrCardAt(ctx, halfW - qSize - marginX, h - qSize - marginY, w, h, qrImg, qSize);
      this.drawQrCardAt(ctx, w - qSize - marginX, h - qSize - marginY, w, h, qrImg, qSize);
      return;
    }

    let sx = 0, sy = 0;
    switch (positionOrList) {
      case 'bottom-left': sx = marginX; sy = h - cardSize - marginY; break;
      case 'top-right': sx = w - cardSize - marginX; sy = marginY; break;
      case 'top-left': sx = marginX; sy = marginY; break;
      case 'bottom-right':
      default: sx = w - cardSize - marginX; sy = h - cardSize - marginY; break;
    }
    this.drawQrCardAt(ctx, sx, sy, w, h, qrImg, qrSize);
  }

  async printViaChromeDialog(job = null) {
    const finalCanvas = document.getElementById('finalCanvas');
    if (!finalCanvas) return;
    this.resetAutoReturnTimer(60);

    const paperSize = (job && job.paperSize) || (this.selectedMode === 'strip' ? '2x6' : '4x6');
    const dataUrl = await this.buildPrintableDataUrl(paperSize, !job || !job.sheetUrl);
    if (!dataUrl) return;

    const copies = (job && job.copies) ? parseInt(job.copies, 10) : parseInt(document.getElementById('printCopiesSelect')?.value || '1', 10);
    window.pbPrintViaBrowser({ imageUrl: dataUrl, copies, job });
  }

  startAutoReturnTimer(seconds = 20) {
    // Dinonaktifkan: halaman tetap di layar hasil agar customer leluasa scan QR dan simpan foto ke HP
    if (this.autoReturnTimerId) {
      clearInterval(this.autoReturnTimerId);
      this.autoReturnTimerId = null;
    }
  }

  async downscaleDataUrlIfLarge(dataUrl, maxDim = 2160) {
    if (!dataUrl || typeof Image === 'undefined' || typeof document === 'undefined') return dataUrl;
    try {
      const img = new Image();
      img.src = dataUrl;
      await new Promise((res) => { img.onload = res; img.onerror = res; });
      const iw = img.naturalWidth || 0;
      const ih = img.naturalHeight || 0;
      const maxSide = Math.max(iw, ih);
      if (!maxSide || maxSide <= maxDim) return dataUrl;
      const scale = maxDim / maxSide;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(iw * scale));
      c.height = Math.max(1, Math.round(ih * scale));
      const ctx = c.getContext('2d');
      if (!ctx) return dataUrl;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/jpeg', 0.88);
      c.width = 0; c.height = 0;
      return out || dataUrl;
    } catch (e) {
      return dataUrl;
    }
  }

  finishSession() {
    this.clearAllTimers();
    this.isCountingDown = false;
    this.isCapturingSnap = false;
    if (this.autoReturnTimerId) clearInterval(this.autoReturnTimerId);

    // Clear temporary data to protect guest privacy
    this._simLoopStopped = true;
    if (this._simRafId) { cancelAnimationFrame(this._simRafId); this._simRafId = null; }
    if (this.activeLiveRecorder && this.activeLiveRecorder.state !== 'inactive') {
      try { this.activeLiveRecorder.stop(); } catch (e) {}
    }
    this.posesCaptured = [];
    this.liveClips = [];
    this.rawPosesSyncedForSession = null;
    this.slotAssignments = [];
    this.slotTransforms = [];
    this.selectedPreviewSlotIndex = 0;
    this.cachedPhotoImages = {};
    this.cachedKeyedFrame = null;
    this.activePoseIndex = 0;
    this.guestPass = null;
    this.sessionId = null;
    this._sessionFilterManuallyChosen = false;
    this.activePhotoFilter = this.getDefaultEventPhotoFilter ? this.getDefaultEventPhotoFilter() : 'normal';
    this.activePhotoFilterIntensity = 1.0;
    if (window.MafazaPhotoFilters) window.MafazaPhotoFilters.clearCache();
    this.syncFilterControlsUI();

    const thumbs = document.getElementById('poseThumbnails');
    if (thumbs) thumbs.innerHTML = '';
    const grid = document.getElementById('capturedPhotosGrid');
    if (grid) grid.innerHTML = '';
    const slotTabs = document.getElementById('previewSlotButtons');
    if (slotTabs) slotTabs.innerHTML = '';
    const qrImg = document.getElementById('guestQrCodeImg');
    if (qrImg) {
      qrImg.src = '';
      qrImg.style.display = 'none';
    }
    const qrFallback = document.getElementById('guestQrFallback');
    if (qrFallback) {
      qrFallback.innerText = '⏳ Memuat QR...';
      qrFallback.style.display = 'block';
    }
    const qrHint = document.getElementById('kioskQrTapHint');
    if (qrHint) qrHint.style.display = 'none';
    const directLink = document.getElementById('guestGalleryDirectLink');
    if (directLink) directLink.style.display = 'none';

    this.showScreen('screenWelcome');
  }
}

// Global kiosk instance
let kiosk = null;
window.addEventListener('DOMContentLoaded', () => {
  kiosk = new KioskEngine();
  window.kiosk = kiosk;
});

// Operator PIN Lock modal functions
function promptOperatorUnlock() {
  const modal = document.getElementById('operatorPinModal');
  modal.style.display = 'flex';
  const input = document.getElementById('operatorPinInput');
  input.value = '';
  input.focus();
}

function closeOperatorPinModal() {
  document.getElementById('operatorPinModal').style.display = 'none';
}

async function verifyOperatorPin() {
  const input = document.getElementById('operatorPinInput');
  const pin = String((input && input.value) || '').trim();
  if (!pin) {
    alert('Masukkan PIN Operator terlebih dahulu!');
    return;
  }

  try {
    const eventId = (window.kiosk && window.kiosk.eventId) || localStorage.getItem('pb_active_event_id') || '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch('/api/kiosk/verify-operator-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, pin }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.valid) {
      window.location.href = '/admin?tab=photos';
      return;
    }
    alert(data.error || 'PIN Operator salah!');
  } catch (e) {
    // Fallback offline jika server tidak terjangkau
    const localPin = (window.kiosk && window.kiosk.eventConfig && window.kiosk.eventConfig.pinLock) || '1234';
    if (pin === String(localPin)) {
      window.location.href = '/admin?tab=photos';
    } else {
      alert('PIN Operator salah! (Default PIN: 1234)');
    }
  }
}
