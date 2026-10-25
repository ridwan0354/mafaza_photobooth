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
    this.countdownTimerId = null;
    this.interPoseTimerId = null;
    this.reviewAutoAdvanceTimerId = null;
    this.modalSelectedPoseIndex = null;
    this.toastTimerId = null;

    // Interactive Photo Selection & Panning State in Preview
    this.slotAssignments = [];
    this.slotTransforms = [];
    this.selectedPreviewSlotIndex = 0;
    this.cachedPhotoImages = {};
    this.cachedKeyedFrame = null;
    this.isDraggingPhoto = false;
    this.dragStart = null;
    this.canvasListenersAttached = false;
    this.syncDebounceTimer = null;

    this.init();
  }

  async init() {
    console.log('🎬 Initializing Photobooth Kiosk Engine...');
    this.activePrinterName = 'Printer Foto';
    this.autoPrintEnabled = localStorage.getItem('pb_kiosk_auto_print') === 'true';
    const autoToggle = document.getElementById('autoPrintToggle');
    if (autoToggle) autoToggle.checked = this.autoPrintEnabled;

    await this.fetchEventConfig();
    await this.fetchCameraConfig();
    await this.fetchPrinterProfile();
    await this.fetchTemplates();
    this.setupAudio();
    this.setupFullScreenSupport();
    this.setupVirtualCameraFallback();

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

  async fetchCameraConfig() {
    try {
      const res = await fetch('/api/camera/status');
      if (res.ok) {
        const data = await res.json();
        this.cameraSystemStatus = data;
        this.cameraConfig = data.config || { cameraMode: 'sony_canon_flash', cameraBrand: 'sony_a7iii' };
      }
    } catch (e) {
      this.cameraConfig = { cameraMode: 'sony_canon_flash', cameraBrand: 'sony_a7iii' };
    }
  }

  async fetchPrinterProfile() {
    try {
      const res = await fetch('/api/printers/profile');
      if (res.ok) {
        const profile = await res.json();
        if (profile && profile.name) {
          this.activePrinterName = profile.name;
          const shortName = profile.name.replace(/\s*series.*$/i, '').slice(0, 18);
          const badge = document.getElementById('printerReadyBadge');
          if (badge) badge.innerText = `● ${shortName} Ready`;

          // Ikuti pengaturan dari menu Printer admin: maksimal lembar & mode cetak otomatis
          const st = profile.settings || {};
          const select = document.getElementById('printCopiesSelect');
          const maxCopies = parseInt(st.maxCopies, 10);
          if (select && maxCopies >= 1) {
            const prev = parseInt(select.value, 10) || 1;
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
      }
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
          const activeRes = await fetch('/api/events/active/current');
          if (activeRes.ok) {
            const activeData = await activeRes.json();
            if (activeData.activeEventId) {
              this.eventId = activeData.activeEventId;
              localStorage.setItem('pb_active_event_id', this.eventId);
            }
          }
        } catch (err) {}
      }

      const res = await fetch(`/api/events/${this.eventId}`);
      if (res.ok) {
        this.eventData = await res.json();
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
        this.renderStepProgressBars();
      }
    } catch (e) {}
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
          htmlParts.push(`
            <div class="step-item completed">
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
      navigator.serviceWorker.register('/sw-kiosk.js').catch(() => {});
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

  async fetchTemplates() {
    try {
      const res = await fetch(`/api/templates?eventId=${this.eventId}`);
      if (res.ok) {
        this.templates = await res.json();
      }
    } catch (e) {
      console.warn('Failed to load templates from server, using local defaults');
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
  }

  // State 1 -> State 2: Welcome to QR Scan or Directly to Frame Selection
  async startSession() {
    this.posesCaptured = [null, null, null];
    this.activePoseIndex = 0;
    this.guestPass = null;
    this.sessionId = null;
    if (this.autoReturnTimerId) clearInterval(this.autoReturnTimerId);

    // Refresh event config so changes in Admin take effect immediately
    await this.fetchEventConfig();

    // Jika event diatur Tidak Pakai Pindai QR, langsung masuk ke Pilih Frame (No. 1)
    if (this.isQrScanDisabled()) {
      this.stopQrScannerLoop();
      this.startCamera().catch(err => console.warn('Camera background init:', err));
      this.renderTemplateSelection('all');
      this.showScreen('screenTemplate');
      return;
    }

    // Jika wajib QR, sembunyikan tombol Lewati
    const skipBtn = document.getElementById('btnSkipQr');
    if (skipBtn) {
      skipBtn.style.display = (this.eventConfig && this.eventConfig.qrRequirement === 'required') ? 'none' : '';
    }

    // Buka Layar Pindai QR Tamu
    this.showScreen('screenQR');
    this.startCamera().catch(err => console.warn('Camera background init:', err));
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

  async ensureGuestPassReady() {
    try {
      if (!this.guestPass) {
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
      } else if (!this.guestPass.qrDataUrl) {
        const token = this.guestPass.token || this.guestPass.token_plain;
        if (token) {
          const res = await fetch('/api/kiosk/qr/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, baseUrl: window.location.origin })
          });
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
    }
  }

  renderGuestQrOnPreview() {
    const qrImg = document.getElementById('guestQrCodeImg');
    const qrFallback = document.getElementById('guestQrFallback');
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
    } else if (qrFallback) {
      qrFallback.innerText = 'QR Siap';
    }

    if (directLink && galleryUrl) {
      directLink.href = galleryUrl;
      directLink.style.display = 'inline-flex';
    }
    if (infoText && token) {
      infoText.innerHTML = `✨ Terhubung ke Galeri Digital • <strong>Foto + Live + Boomerang</strong>`;
    }
  }

  returnToCameraFromPreview() {
    if (this.autoReturnTimerId) clearInterval(this.autoReturnTimerId);
    this.showScreen('screenCapture');
    this.renderFilmstripDock();
  }

  async loadActiveGuestPassesForKiosk() {
    const sel = document.getElementById('kioskGuestPassQuickSelect');
    const badge = document.getElementById('kioskPassCountBadge');
    if (!sel) return;
    try {
      const res = await fetch(`/api/kiosk/guest-passes?eventId=${encodeURIComponent(this.eventId)}`);
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
      return;
    }

    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const video = document.getElementById('qrVideoFeed');
      let isDetecting = false;

      this.qrScannerInterval = setInterval(async () => {
        if (isDetecting || !video || video.readyState < 2) return;
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

  openTemplateChooserDirectly() {
    this.renderTemplateSelection('all');
    this.showScreen('screenTemplate');
  }

  // Feature Pill 1: Foto Langsung -> Fast Direct Camera Capture
  startDirectCapture() {
    this.posesCaptured = [null, null, null];
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

    const displayTemplates = filtered.length > 0 ? filtered : this.templates;

    displayTemplates.forEach((tpl, idx) => {
      const card = document.createElement('div');
      card.className = `template-retro-card ${idx === 0 ? 'selected' : ''}`;
      card.onclick = () => {
        document.querySelectorAll('.template-retro-card').forEach(el => el.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedTemplate = tpl;
        this.selectedMode = tpl.orientation === 'strip' ? 'strip' : 'single';
        this.totalPosesRequired = (this.selectedMode === 'strip') ? 3 : 1;
      };
      card.innerHTML = `
        <div class="template-check-badge">✓</div>
        <div style="height: 180px; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; background: #FFFBF5; border-radius: 18px; border: 2px dashed #EAD8C7; overflow: hidden; padding: 8px;">
          <img src="${tpl.image_storage_key}" style="max-height: 100%; max-width: 100%; object-fit: contain;">
        </div>
        <span class="badge-pill ${tpl.orientation === 'strip' ? 'badge-coral' : 'badge-active'}" style="font-size: 11px; margin-bottom: 6px;">
          ${tpl.orientation === 'strip' ? '3 Pose Strip' : '1 Pose Single'}
        </span>
        <h4 style="font-size: 16px; font-weight: 700; color: #7B482E; margin-top: 4px; font-family: var(--font-heading);">${tpl.name}</h4>
      `;
      container.appendChild(card);
    });

    this.selectedTemplate = displayTemplates[0];
    this.selectedMode = this.selectedTemplate.orientation === 'strip' ? 'strip' : 'single';
    this.totalPosesRequired = (this.selectedMode === 'strip') ? 3 : 1;
  }

  // Camera 3-Button Control Bar Handlers (Gambar 2 Screen 3)
  handleShutterClick() {
    if (this.isCountingDown) {
      this.triggerManualSnap();
    } else {
      let target = this.activePoseIndex;
      if (target === null || target === undefined || target >= this.totalPosesRequired) {
        target = this.posesCaptured.findIndex(p => p === null);
        if (target === -1) target = 0;
      }
      this.startCountdown(target);
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

  async startCamera() {
    const video = document.getElementById('videoFeed');
    const qrVideo = document.getElementById('qrVideoFeed');

    try {
      await this.fetchCameraConfig();
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        let videoConstraints = {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'user'
        };

        // Check if admin selected a preferred video input or if Sony / Canon / Capture Card is connected
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter(d => d.kind === 'videoinput');
          const preferredId = this.cameraConfig?.preferredVideoDeviceId;
          let chosenDevice = preferredId ? videoInputs.find(d => d.deviceId === preferredId) : null;

          if (!chosenDevice) {
            chosenDevice = videoInputs.find(d =>
              /sony|ilce|a7|imaging edge|canon|eos|cam link|elgato|capture|usb video/i.test(d.label || '')
            );
          }

          if (chosenDevice && chosenDevice.deviceId) {
            videoConstraints = {
              deviceId: { exact: chosenDevice.deviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 }
            };
          }
        } catch (enumErr) {}

        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false
        });

        // On iPadOS 17+ / Android, device labels are only exposed AFTER getUserMedia permission is granted.
        // Re-check if an external USB-C Capture Card / Sony / Canon camera is plugged into the iPad/Android!
        try {
          const postDevices = await navigator.mediaDevices.enumerateDevices();
          const postVideoInputs = postDevices.filter(d => d.kind === 'videoinput');
          const preferredId = this.cameraConfig?.preferredVideoDeviceId;
          let extDevice = preferredId ? postVideoInputs.find(d => d.deviceId === preferredId) : null;
          if (!extDevice) {
            extDevice = postVideoInputs.find(d =>
              /sony|ilce|a7|imaging edge|canon|eos|cam link|elgato|capture|usb video|uvc|hdmi/i.test(d.label || '')
            );
          }
          const currentTrack = this.mediaStream.getVideoTracks()[0];
          const currentDeviceId = currentTrack?.getSettings?.()?.deviceId;
          if (extDevice && extDevice.deviceId && extDevice.deviceId !== currentDeviceId) {
            const extStream = await navigator.mediaDevices.getUserMedia({
              video: {
                deviceId: { exact: extDevice.deviceId },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
              },
              audio: false
            });
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = extStream;
          }
        } catch (reEnumErr) {}

        if (video) video.srcObject = this.mediaStream;
        if (qrVideo) qrVideo.srcObject = this.mediaStream;
        return;
      }
    } catch (err) {
      console.warn('Preferred camera constraint failed, retrying default camera:', err);
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
          });
          if (video) video.srcObject = this.mediaStream;
          if (qrVideo) qrVideo.srcObject = this.mediaStream;
          return;
        }
      } catch (fallbackErr) {
        console.warn('Physical camera not available, falling back to virtual simulator:', fallbackErr);
      }
    }

    this.setupVirtualCameraFallback();
  }

  setupVirtualCameraFallback() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    let angle = 0;
    const drawSimulatedFrame = () => {
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

      requestAnimationFrame(drawSimulatedFrame);
    };
    drawSimulatedFrame();

    const stream = canvas.captureStream(30);
    const video = document.getElementById('videoFeed');
    const qrVideo = document.getElementById('qrVideoFeed');
    if (video) video.srcObject = stream;
    if (qrVideo) qrVideo.srcObject = stream;
    this.mediaStream = stream;
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
    if (this.eventConfig && this.eventConfig.shotsCount) {
      this.totalPosesRequired = parseInt(this.eventConfig.shotsCount);
    } else if (this.selectedTemplate && this.selectedTemplate.slots && this.selectedTemplate.slots.length > 0) {
      this.totalPosesRequired = Math.max(...this.selectedTemplate.slots.map(s => s.pose_index));
    } else {
      this.totalPosesRequired = (this.selectedMode === 'strip') ? 3 : 1;
    }

    this.posesCaptured = new Array(this.totalPosesRequired).fill(null);
    this.activePoseIndex = 0;
    this.showScreen('screenCapture');
    this.renderFilmstripDock();

    this.showToast('Siap untuk Pose 1! Tersenyumlah 😊', '📸', 1800);
    this.interPoseTimerId = setTimeout(() => {
      this.startCountdown(0);
    }, 1200);
  }

  scheduleCountdownForPose(poseIndex, delayMs = 600) {
    this.clearAllTimers();
    this.activePoseIndex = poseIndex;
    const poseIndicatorText = document.getElementById('poseIndicatorText');
    const smileHintText = document.getElementById('smileHintText');
    if (poseIndicatorText) {
      poseIndicatorText.innerText = `Foto ${poseIndex + 1}/${this.totalPosesRequired}`;
    }
    if (smileHintText) {
      smileHintText.innerText = 'Tersenyumlah ke kamera! 😊';
    }
    this.renderFilmstripDock();

    this.interPoseTimerId = setTimeout(() => {
      this.startCountdown(poseIndex);
    }, delayMs);
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

    let count = 3;
    const maxCount = 3;
    const fullCircumference = 427.25;

    const updateDisplay = (val) => {
      if (countdownNum) {
        countdownNum.innerText = val > 0 ? val : '📸';
        countdownNum.classList.remove('pop');
        void countdownNum.offsetWidth; // Force CSS reflow for pop animation
        countdownNum.classList.add('pop');
      }
      if (countdownLabel) {
        if (val === 3) countdownLabel.innerText = 'SIAP';
        else if (val === 2) countdownLabel.innerText = 'SENYUM';
        else if (val === 1) countdownLabel.innerText = 'TAHAN';
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
        updateDisplay(0);
        this.playShutterSound();
        this.triggerShutterFlash();
        this.captureFrame(poseIndex);
        this.triggerHardwareCameraAndFlash(poseIndex);

        // Stop live recording ~350ms after the snap so the flash moment is included
        setTimeout(() => {
          this.stopPoseLiveRecording(poseIndex);
        }, 350);

        setTimeout(() => {
          if (countdownBox) countdownBox.style.display = 'none';
          this.isCountingDown = false;
          this.handlePostCapture(poseIndex);
        }, 400);
      }
    }, 1000);
  }

  triggerManualSnap() {
    let targetIndex = this.activePoseIndex;
    if (targetIndex === null || targetIndex === undefined || targetIndex >= this.totalPosesRequired) {
      targetIndex = this.posesCaptured.findIndex(p => p === null);
      if (targetIndex === -1) targetIndex = 0;
    }

    this.clearAllTimers();
    this.playShutterSound();
    this.triggerShutterFlash();
    this.captureFrame(targetIndex);
    this.triggerHardwareCameraAndFlash(targetIndex);
    setTimeout(() => {
      this.stopPoseLiveRecording(targetIndex);
    }, 350);
    this.handlePostCapture(targetIndex);
  }

  async triggerHardwareCameraAndFlash(poseIndex) {
    if (this.cameraConfig && this.cameraConfig.cameraMode === 'webcam_only') {
      return;
    }

    // Also capture a secondary HDMI frame at ~160ms in case external flash illuminates the HDMI live feed
    setTimeout(() => {
      if (this.posesCaptured[poseIndex] && !this.posesCaptured[poseIndex].startsWith('/uploads/')) {
        // Only update from video if USB high-res file hasn't replaced it yet
      }
    }, 160);

    try {
      const res = await fetch('/api/camera/trigger-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poseIndex, timeoutMs: 2800 })
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.imageUrl) {
        // Convert downloaded Sony A7III / Canon Flash JPEG into DataURL so canvas compositor & preview use the real flash photo!
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || 1920;
          c.height = img.naturalHeight || 1280;
          const ctx = c.getContext('2d');
          // Mirror to match live view orientation
          ctx.translate(c.width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const flashDataUrl = c.toDataURL('image/jpeg', 0.88);
          this.posesCaptured[poseIndex] = flashDataUrl;
          this.renderFilmstripDock();

          // If the post-capture hold overlay is currently showing this pose, update it live with the flash photo!
          const holdOverlay = document.getElementById('postCapturePreviewOverlay');
          const holdImg = document.getElementById('postCapturePreviewImg');
          if (holdOverlay && holdOverlay.style.display !== 'none' && holdImg && this.lastCapturedPoseIndex === poseIndex) {
            holdImg.src = flashDataUrl;
          }
        };
        img.src = data.imageUrl + '?t=' + Date.now();
      }
    } catch (err) {
      console.warn('Hardware camera flash trigger skipped:', err);
    }
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

  captureFrame(poseIndex) {
    const video = document.getElementById('videoFeed');
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    // Mirror image for natural photo look
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    if (video) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    const photoDataUrl = canvas.toDataURL('image/jpeg', 0.88);
    this.posesCaptured[poseIndex] = photoDataUrl;
    this.renderFilmstripDock();
  }

  startPoseLiveRecording(poseIndex) {
    if (!this.mediaStream) return;
    try {
      if (this.activeLiveRecorder && this.activeLiveRecorder.state !== 'inactive') {
        try { this.activeLiveRecorder.stop(); } catch(e){}
      }
      this.activeLiveChunks = [];
      const mimeTypes = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
      const mime = mimeTypes.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
      
      const recorder = new MediaRecorder(this.mediaStream, mime ? { mimeType: mime } : {});
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.activeLiveChunks.push(e.data);
      };
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
      rec.onstop = () => {
        const mime = rec.mimeType || 'video/webm';
        const blob = new Blob(chunks, { type: mime });
        this.liveClips[poseIndex] = blob;
      };
      try {
        rec.stop();
      } catch(e){}
      this.activeLiveRecorder = null;
    }
  }

  handlePostCapture(justCapturedIndex) {
    const nextEmptyIndex = this.posesCaptured.findIndex(p => p === null);
    this.lastCapturedPoseIndex = justCapturedIndex;
    this.pendingNextPoseIndex = nextEmptyIndex;

    const capturedSrc = this.posesCaptured[justCapturedIndex];
    const holdOverlay = document.getElementById('postCapturePreviewOverlay');
    const holdImg = document.getElementById('postCapturePreviewImg');
    const holdBadge = document.getElementById('postCaptureBadgeText');
    const holdTimerText = document.getElementById('postCaptureTimerText');
    const holdBtnNext = document.getElementById('postCaptureBtnNext');
    const poseIndicatorText = document.getElementById('poseIndicatorText');
    const smileHintText = document.getElementById('smileHintText');

    // Tampilkan hasil foto barusan secara penuh di layar kamera selama 2 detik
    if (holdOverlay && holdImg && capturedSrc) {
      holdImg.src = capturedSrc;
      holdOverlay.style.display = 'flex';
    }
    if (holdBadge) {
      holdBadge.innerText = `✅ Hasil Foto Pose ${justCapturedIndex + 1} dari ${this.totalPosesRequired}`;
    }
    if (poseIndicatorText) {
      poseIndicatorText.innerText = `✨ Hasil Pose ${justCapturedIndex + 1}/${this.totalPosesRequired}`;
    }

    let holdSecs = 2;
    const updateHoldText = (secs) => {
      if (nextEmptyIndex !== -1) {
        if (holdTimerText) {
          holdTimerText.innerText = `⏱️ Lanjut ke Pose ${nextEmptyIndex + 1} dalam ${secs} detik...`;
        }
        if (holdBtnNext) {
          holdBtnNext.innerText = `Lanjut ke Pose ${nextEmptyIndex + 1} ➔`;
        }
        if (smileHintText) {
          smileHintText.innerText = `Lihat hasil Pose ${justCapturedIndex + 1} • Bersiap Pose ${nextEmptyIndex + 1} 😊`;
        }
      } else {
        if (holdTimerText) {
          holdTimerText.innerText = `🎉 Semua Pose Selesai! Melanjutkan dalam ${secs} detik...`;
        }
        if (holdBtnNext) {
          holdBtnNext.innerText = `Selesai & Lihat Hasil ➔`;
        }
        if (smileHintText) {
          smileHintText.innerText = `Semua pose telah diambil! 🎉`;
        }
      }
    };

    updateHoldText(holdSecs);

    if (this.postCaptureHoldTimerId) {
      clearInterval(this.postCaptureHoldTimerId);
    }

    this.postCaptureHoldTimerId = setInterval(() => {
      holdSecs--;
      if (holdSecs > 0) {
        updateHoldText(holdSecs);
      } else {
        clearInterval(this.postCaptureHoldTimerId);
        this.postCaptureHoldTimerId = null;
        this.finishPostCaptureHold();
      }
    }, 1000);
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
      const poseIndicatorText = document.getElementById('poseIndicatorText');
      const smileHintText = document.getElementById('smileHintText');
      if (poseIndicatorText) {
        poseIndicatorText.innerText = `📷 Pose ${nextEmptyIndex + 1} dari ${this.totalPosesRequired}`;
      }
      if (smileHintText) {
        smileHintText.innerText = `Bersiap gaya untuk Pose ${nextEmptyIndex + 1}! 😊`;
      }
      this.showToast(`📸 Bersiap untuk Pose ${nextEmptyIndex + 1}!`, '✨', 1000);
      this.interPoseTimerId = setTimeout(() => {
        this.startCountdown(nextEmptyIndex);
      }, 900);
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

    // 1. Ensure Guest Pass & QR Data URL exist BEFORE creating the session so guest_pass_id is always linked
    await this.ensureGuestPassReady();

    // 2. Create session in backend (if not already created for this run)
    if (!this.sessionId) {
      try {
        const sessRes = await fetch('/api/kiosk/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId: this.tenantId,
            eventId: this.eventId,
            deviceId: this.deviceId,
            guestPassId: this.guestPass ? this.guestPass.id : null,
            mode: this.selectedMode
          })
        });
        if (sessRes.ok) {
          const sessData = await sessRes.json();
          this.sessionId = sessData.sessionId;
        }
      } catch (e) {}
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
    finalCanvas.width = tplWidth;
    finalCanvas.height = tplHeight;

    const slots = this.selectedTemplate.slots || [
      { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
      { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
      { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
    ];

    // Initialize slot assignments if empty or reset
    if (!this.slotAssignments || this.slotAssignments.length !== slots.length) {
      this.slotAssignments = slots.map((s, idx) => {
        const pIdx = (s.pose_index - 1);
        return (pIdx >= 0 && pIdx < this.posesCaptured.length) ? pIdx : (idx % Math.max(1, this.posesCaptured.length));
      });
    }

    // Initialize transforms (pan & zoom) for each slot
    if (!this.slotTransforms || this.slotTransforms.length !== slots.length) {
      this.slotTransforms = slots.map(() => ({ panX: 0, panY: 0, zoom: 1.0 }));
    }
    this.selectedPreviewSlotIndex = 0;
    this.cachedPhotoImages = {};

    // Prepare frame overlay with green chroma keying inside slot regions
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = tplWidth;
    frameCanvas.height = tplHeight;
    const fCtx = frameCanvas.getContext('2d');
    fCtx.drawImage(templateImg, 0, 0, tplWidth, tplHeight);

    try {
      const frameImgData = fCtx.getImageData(0, 0, tplWidth, tplHeight);
      const data = frameImgData.data;

      // Chroma predicate: pure green (#00FF00), Canva lime green (#7ED957), and shades
      function isGreen(r, g, b, a) {
        if (a < 50) return false;
        if (g >= 150 && r <= 100 && b <= 100) return true;
        if (g >= 135 && (g - r) >= 28 && (g - b) >= 32) return true;
        if (g >= 115 && (g - r) >= 35 && (g - b) >= 35) return true;
        return false;
      }

      // Key out green pixels within slot regions so photos show through
      const pad = 12;
      for (const slot of slots) {
        const startX = Math.max(0, Math.floor(slot.x - pad));
        const endX = Math.min(tplWidth, Math.ceil(slot.x + slot.width + pad));
        const startY = Math.max(0, Math.floor(slot.y - pad));
        const endY = Math.min(tplHeight, Math.ceil(slot.y + slot.height + pad));

        for (let y = startY; y < endY; y++) {
          for (let x = startX; x < endX; x++) {
            const idx = (y * tplWidth + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];

            if (isGreen(r, g, b, a)) {
              data[idx + 3] = 0; // Transparent!
            }
          }
        }
      }

      fCtx.putImageData(frameImgData, 0, 0);
    } catch (e) {
      console.warn('Frame chroma key processing error:', e);
    }
    this.cachedKeyedFrame = frameCanvas;

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
        const zoom = Math.max(1.0, Math.min(3.5, transform.zoom || 1.0));

        // Base cover scale: gambar otomatis mengisi slot secara proporsional
        const baseScale = Math.max(clipW / pImg.width, clipH / pImg.height);
        const finalScale = baseScale * zoom;

        const drawW = pImg.width * finalScale;
        const drawH = pImg.height * finalScale;

        // Batas pan dinamis: memungkinkan geser bebas dalam batas slot yang terisi penuh
        const maxPanX = Math.max((drawW - clipW) / 2, clipW * 0.35);
        const maxPanY = Math.max((drawH - clipH) / 2, clipH * 0.35);

        transform.panX = Math.max(-maxPanX, Math.min(maxPanX, transform.panX || 0));
        transform.panY = Math.max(-maxPanY, Math.min(maxPanY, transform.panY || 0));

        const slotCenterX = clipX + (clipW / 2);
        const slotCenterY = clipY + (clipH / 2);

        const drawX = slotCenterX - (drawW / 2) + transform.panX;
        const drawY = slotCenterY - (drawH / 2) + transform.panY;

        ctx.drawImage(pImg, drawX, drawY, drawW, drawH);
        ctx.restore();
      }
    }

    // 3. LAYER ATAS: Draw frame overlay
    if (this.cachedKeyedFrame) {
      ctx.drawImage(this.cachedKeyedFrame, 0, 0, tplWidth, tplHeight);
    }
  }

  setupCanvasInteractivePan() {
    const canvas = document.getElementById('finalCanvas');
    if (!canvas || this.canvasListenersAttached) return;
    this.canvasListenersAttached = true;

    // Deteksi slot mana yang disentuh / diklik dengan toleransi sentuhan
    const findSlotAt = (canvasX, canvasY) => {
      const slots = (this.selectedTemplate && this.selectedTemplate.slots && this.selectedTemplate.slots.length > 0)
        ? this.selectedTemplate.slots
        : [
            { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
            { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
            { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
          ];

      if (slots.length === 1) return 0; // Frame 1-foto: seluruh area frame mengontrol slot 0

      const margin = 28; // Toleransi area sentuh jari (28px)
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
      this.slotTransforms[idx].zoom = Math.max(1.0, Math.min(3.5, (this.slotTransforms[idx].zoom || 1.0) + deltaZoom));
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
        this.slotTransforms[idx].zoom = Math.max(1.0, Math.min(3.5, this.pinchState.initialZoom * scaleRatio));

        const currentMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const currentMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const deltaMidX = (currentMidX - this.pinchState.midX) * this.pinchState.scaleX;
        const deltaMidY = (currentMidY - this.pinchState.midY) * this.pinchState.scaleY;

        this.slotTransforms[idx].panX = this.pinchState.initialPanX + deltaMidX;
        this.slotTransforms[idx].panY = this.pinchState.initialPanY + deltaMidY;

        this.renderFinalCanvas();
      } else if (this.isDraggingPhoto && e.touches.length === 1) {
        // Eksekusi Geser 1 Jari (Pan)
        const dx = (e.touches[0].clientX - this.dragState.lastClientX) * this.dragState.scaleX;
        const dy = (e.touches[0].clientY - this.dragState.lastClientY) * this.dragState.scaleY;

        this.dragState.lastClientX = e.touches[0].clientX;
        this.dragState.lastClientY = e.touches[0].clientY;

        this.slotTransforms[idx].panX = (this.slotTransforms[idx].panX || 0) + dx;
        this.slotTransforms[idx].panY = (this.slotTransforms[idx].panY || 0) + dy;

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
  }

  selectPreviewSlot(slotIdx) {
    this.selectedPreviewSlotIndex = slotIdx;
    const badge = document.getElementById('activeSlotBadge');
    const targetName = document.getElementById('targetSlotName');
    if (badge) badge.innerText = `Slot #${slotIdx + 1} Aktif`;
    if (targetName) targetName.innerText = `Slot #${slotIdx + 1}`;

    this.renderPreviewSlotTabs();
    this.renderPreviewPhotoTray();
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

  assignPhotoToActiveSlot(photoIdx) {
    if (typeof this.selectedPreviewSlotIndex !== 'number') return;
    const slotIdx = this.selectedPreviewSlotIndex;
    this.slotAssignments[slotIdx] = photoIdx;

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
    this.renderFinalCanvas();
    this.resetAutoReturnTimer();
    this.debounceSyncSession();
  }

  zoomActiveSlot(deltaZoom) {
    if (typeof this.selectedPreviewSlotIndex !== 'number') return;
    const idx = this.selectedPreviewSlotIndex;
    if (!this.slotTransforms[idx]) this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };
    this.slotTransforms[idx].zoom = Math.max(1.0, Math.min(3.5, (this.slotTransforms[idx].zoom || 1.0) + deltaZoom));
    this.renderFinalCanvas();
    this.resetAutoReturnTimer();
    this.debounceSyncSession();
  }

  resetActiveSlotTransform() {
    if (typeof this.selectedPreviewSlotIndex !== 'number') return;
    const idx = this.selectedPreviewSlotIndex;
    this.slotTransforms[idx] = { panX: 0, panY: 0, zoom: 1.0 };
    this.renderFinalCanvas();
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
            const basePhotoIdx = (this.slotAssignments && this.slotAssignments[sIdx] !== undefined)
              ? this.slotAssignments[sIdx]
              : (sIdx % validImgs.length);
            
            // In boomerang mode: animate pose index cycling or subtle dynamic zoom
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
              // Subtle pulse zoom (+0.04) on odd frames for organic vitality
              const pulse = (frameIdx % 2 === 1) ? 1.02 : 1.0;
              const zoom = Math.max(1.0, Math.min(3.5, (transform.zoom || 1.0) * pulse));

              const baseScale = Math.max(clipW / pImg.width, clipH / pImg.height);
              const finalScale = baseScale * zoom;

              const drawW = pImg.width * finalScale;
              const drawH = pImg.height * finalScale;

              const slotCenterX = clipX + (clipW / 2);
              const slotCenterY = clipY + (clipH / 2);

              const drawX = slotCenterX - (drawW / 2) + (transform.panX || 0);
              const drawY = slotCenterY - (drawH / 2) + (transform.panY || 0);

              ctx.drawImage(pImg, drawX, drawY, drawW, drawH);
              ctx.restore();
            }
          }

          // 3. LAYER ATAS: Draw frame overlay on top of every single frame
          if (this.cachedKeyedFrame) {
            ctx.drawImage(this.cachedKeyedFrame, 0, 0, tplWidth, tplHeight);
          }

          frameIdx++;
        }, 130);
      });
    } catch (e) {
      console.warn('Could not generate framed boomerang blob:', e);
      return null;
    }
  }

  async syncFinalPhotoToBackend() {
    const finalCanvas = document.getElementById('finalCanvas');
    if (!finalCanvas || !this.sessionId) return;

    const needSyncRaw = (this.rawPosesSyncedForSession !== this.sessionId);

    // Convert raw pose photos to blobs only on first sync for this session
    const rawBlobs = [];
    let bmResult = null;
    if (needSyncRaw && this.posesCaptured && this.posesCaptured.length > 0) {
      for (let i = 0; i < this.posesCaptured.length; i++) {
        const poseData = this.posesCaptured[i];
        if (poseData && poseData.startsWith('data:')) {
          try {
            const b = await this.dataUrlToBlob(poseData);
            rawBlobs.push({ blob: b, poseIndex: i + 1 });
          } catch (e) {}
        }
      }

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

        if (bmResult && bmResult.blob) {
          formData.append('boomerang', bmResult.blob, `boomerang_${Date.now()}.${bmResult.ext}`);
          formData.append('livePhoto', bmResult.blob, `livephoto_${Date.now()}.${bmResult.ext}`);
        }
      }

      try {
        const res = await fetch(`/api/kiosk/sessions/${this.sessionId}/complete`, {
          method: 'POST',
          body: formData
        });
        if (res.ok && needSyncRaw) {
          this.rawPosesSyncedForSession = this.sessionId;
        }
      } catch (e) {
        console.warn('Error syncing session:', e);
      }
    }, 'image/jpeg', 0.88);
  }

  async printCurrentSession(isAuto = false) {
    const copies = document.getElementById('printCopiesSelect').value;
    const finalCanvas = document.getElementById('finalCanvas');
    const btn = document.getElementById('btnPrintSession');
    const banner = document.getElementById('printStatusBanner');

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = isAuto ? '⚡ Mencetak Otomatis...' : '⏳ Mengirim ke Printer...';
    }
    if (banner) {
      banner.style.display = 'block';
      banner.innerText = `⏳ Mengirim ${copies} lembar ke ${this.activePrinterName || 'Printer'}...`;
    }

    finalCanvas.toBlob(async (blob) => {
      const formData = new FormData();
      formData.append('finalImage', blob, `print_${Date.now()}.jpg`);
      formData.append('printRequested', 'true');
      formData.append('printCopies', copies);
      if (this.guestPass && this.guestPass.id) {
        formData.append('guestPassId', this.guestPass.id);
      }

      try {
        const res = await fetch(`/api/kiosk/sessions/${this.sessionId}/complete`, {
          method: 'POST',
          body: formData
        });
        if (res.ok) {
          const data = await res.json();
          const pName = (data.printJob && data.printJob.printerName) || this.activePrinterName || 'Printer';
          const dispatchedToOs = !!(data.printJob && data.printJob.dispatchedToOs);
          const isAndroid = /Android/i.test(navigator.userAgent);

          const awaitingAgent = !!(data.printJob && data.printJob.awaitingAgent);

          if (btn) btn.innerHTML = `✅ ${copies} Lembar Dicetak!`;
          if (banner) {
            banner.style.display = 'block';
            banner.innerHTML = (dispatchedToOs || awaitingAgent)
              ? `✅ <strong>${copies} lembar</strong> langsung dikirim otomatis ke <strong>${pName}</strong>!`
              : `✅ <strong>${copies} lembar</strong> siap dicetak! Membuka layanan cetak perangkat...`;
          }

          // Print Agent / printer lokal: sudah dicetak otomatis sesuai pengaturan (tanpa popup).
          // Cadangan: dialog cetak browser dengan ukuran kertas sesuai pengaturan.
          if (!dispatchedToOs && !awaitingAgent) {
            setTimeout(() => this.printViaChromeDialog(data.printJob), 250);
          }
          setTimeout(() => {
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = '🖨️ Cetak Foto Sekarang';
            }
          }, 3000);
        } else {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🖨️ Cetak Foto Sekarang';
          }
          if (banner) {
            banner.style.display = 'block';
            banner.innerText = '⚠️ Gagal mengirim ke antrean printer.';
          }
        }
      } catch (e) {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '🖨️ Cetak Foto Sekarang';
        }
        if (banner) {
          banner.style.display = 'block';
          banner.innerText = '⚠️ Gagal menghubungi server cetak.';
        }
      }
    }, 'image/jpeg', 0.88);
  }

  printViaChromeDialog(job = null) {
    const finalCanvas = document.getElementById('finalCanvas');
    if (!finalCanvas) return;
    this.resetAutoReturnTimer(60);

    const dataUrl = finalCanvas.toDataURL('image/png');
    const copies = parseInt(document.getElementById('printCopiesSelect')?.value || '1', 10);
    window.pbPrintViaBrowser({ imageUrl: dataUrl, copies, job });
  }

  startAutoReturnTimer(seconds = 20) {
    // Dinonaktifkan: halaman tetap di layar hasil agar customer leluasa scan QR dan simpan foto ke HP
    if (this.autoReturnTimerId) {
      clearInterval(this.autoReturnTimerId);
      this.autoReturnTimerId = null;
    }
  }

  finishSession() {
    this.clearAllTimers();
    if (this.autoReturnTimerId) clearInterval(this.autoReturnTimerId);

    // Clear temporary data to protect guest privacy
    this.posesCaptured = [];
    this.slotAssignments = [];
    this.slotTransforms = [];
    this.selectedPreviewSlotIndex = 0;
    this.cachedPhotoImages = {};
    this.cachedKeyedFrame = null;
    this.activePoseIndex = 0;
    this.guestPass = null;
    this.sessionId = null;
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

function verifyOperatorPin() {
  const pin = document.getElementById('operatorPinInput').value;
  if (pin === '1234' || pin === '0000') {
    window.location.href = '/admin?tab=photos';
  } else {
    alert('PIN Operator salah! (Default PIN: 1234)');
  }
}
