// Bundled with the APK. Also protects kiosk pages served by an older server.
(function () {
  'use strict';
  if (!window.MafazaAndroidBridge || window.__mafazaUsbCaptureGuard) return;
  window.__mafazaUsbCaptureGuard = true;

  function requiresStill(kiosk) {
    return !kiosk.cameraConfig || kiosk.cameraConfig.cameraMode !== 'webcam_only';
  }

  function retryPose(kiosk, index) {
    kiosk.isCountingDown = false;
    kiosk.activePoseIndex = index;
    const countdown = document.getElementById('countdownBox');
    const overlay = document.getElementById('postCapturePreviewOverlay');
    const hint = document.getElementById('smileHintText');
    if (countdown) countdown.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    if (hint) hint.innerText = 'Foto belum berhasil. Periksa kamera lalu sentuh tombol foto untuk mencoba lagi.';
    if (typeof kiosk.stopPoseLiveRecording === 'function') kiosk.stopPoseLiveRecording(index);
    if (typeof kiosk.showToast === 'function') {
      kiosk.showToast(kiosk.lastHardwareCaptureError || 'Foto asli kamera belum diterima. Silakan ambil ulang.', '⚠️', 5500);
    }
  }

  function loadPhoto(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let settled = false;
      const timer = setTimeout(function () {
        settled = true;
        img.onload = img.onerror = null;
        reject(new Error('Unduhan foto ke layar terlalu lama. Silakan ambil ulang.'));
      }, timeoutMs || 15000);
      img.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!img.naturalWidth || !img.naturalHeight) reject(new Error('Foto kamera tidak dapat dibaca.'));
        else resolve(img);
      };
      img.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Foto asli kamera tidak dapat dimuat. Silakan ambil ulang.'));
      };
      img.src = url;
    });
  }

  function renderPhoto(kiosk, img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Layar tidak dapat memproses foto kamera.');
    const zoom = Math.max(0.5, Math.min(3, kiosk.cameraZoom || 1));
    const panX = Math.max(-1, Math.min(1, kiosk.cameraPanX || 0));
    const panY = Math.max(-1, Math.min(1, kiosk.cameraPanY || 0));
    const w = canvas.width;
    const h = canvas.height;
    if (zoom < 1) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      const dw = w * zoom;
      const dh = h * zoom;
      ctx.drawImage(img, 0, 0, w, h, (w - dw) / 2 * (1 + panX), (h - dh) / 2 * (1 - panY), dw, dh);
    } else {
      const cropW = w / zoom;
      const cropH = h / zoom;
      const x = Math.max(0, Math.min(w - cropW, (w - cropW) / 2 * (1 - panX)));
      const y = Math.max(0, Math.min(h - cropH, (h - cropH) / 2 * (1 + panY)));
      ctx.drawImage(img, x, y, cropW, cropH, 0, 0, w, h);
    }
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  function liveMessage(message) {
    const frame = document.getElementById('cameraRetroFrame');
    if (!frame) return;
    let hint = document.getElementById('mafazaLiveViewStatus');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'mafazaLiveViewStatus';
      hint.style.cssText = 'position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;padding:25px;text-align:center;color:white;pointer-events:none;background:rgba(0,0,0,.4)';
      frame.appendChild(hint);
    }
    hint.innerText = message || '';
    hint.style.display = message ? 'flex' : 'none';
  }

  function startNativeLiveView(kiosk, info) {
    if (kiosk.canonUsbLoopTimer) clearTimeout(kiosk.canonUsbLoopTimer);
    if (kiosk.mediaStream) kiosk.mediaStream.getTracks().forEach(function (track) { track.stop(); });
    kiosk.mediaStream = null;
    kiosk.canonUsbBridgeInfo = info;
    const canvas = kiosk.canonUsbCanvas || document.createElement('canvas');
    kiosk.canonUsbCanvas = canvas;
    canvas.id = 'canonUsbDirectCanvas';
    canvas.width = info.width || 1056;
    canvas.height = info.height || 704;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;display:block;object-fit:contain';
    const frame = document.getElementById('cameraRetroFrame');
    if (frame && canvas.parentElement !== frame) frame.insertBefore(canvas, frame.firstChild);
    const ctx = canvas.getContext('2d');
    if (!ctx) { liveMessage('Layar belum dapat menampilkan gambar kamera. Buka ulang aplikasi.'); return; }
    kiosk.canonUsbStreamActive = true;
    const generation = (kiosk.__mafazaLiveGeneration || 0) + 1;
    kiosk.__mafazaLiveGeneration = generation;
    kiosk.__mafazaNativeLiveLoop = true;
    let lastFrame = -1;
    let lastDisplayTime = 0;
    liveMessage('Menunggu gambar dari kamera…');

    const draw = async function () {
      if (generation !== kiosk.__mafazaLiveGeneration) return;
      if (!kiosk.canonUsbStreamActive || !requiresStill(kiosk)) {
        kiosk.__mafazaNativeLiveLoop = false;
        canvas.style.display = 'none';
        liveMessage('');
        return;
      }
      try {
        const status = JSON.parse(window.MafazaAndroidBridge.getCameraStatus());
        if (!status.active || !status.hasFrame) {
          liveMessage(kiosk.__mafazaCaptureBusy ? 'Mengambil foto…' : 'Gambar kamera belum diterima. Periksa PC Remote dan kabel USB-C.');
        } else if (status.frames !== lastFrame) {
          const dataUrl = window.MafazaAndroidBridge.getLiveViewFrame();
          if (!dataUrl) throw new Error('Gambar kamera belum siap.');
          const image = await loadPhoto(dataUrl, 2000);
          if (!kiosk.canonUsbStreamActive || generation !== kiosk.__mafazaLiveGeneration) return;
          if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
          }
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          lastFrame = status.frames;
          lastDisplayTime = Date.now();
          liveMessage('');
        } else if (Date.now() - lastDisplayTime > 5000 && !kiosk.__mafazaCaptureBusy) {
          liveMessage('Gambar kamera terhenti. Periksa koneksi USB lalu scan ulang kamera.');
        }
      } catch (error) {
        liveMessage('Gambar kamera belum dapat ditampilkan. Ketuk indikator USB untuk melihat diagnostik.');
        kiosk.lastLiveViewError = error.message;
      }
      if (generation === kiosk.__mafazaLiveGeneration) kiosk.canonUsbLoopTimer = setTimeout(draw, 65);
    };
    // Direct image decoding avoids dependence on createImageBitmap and HTTP loopback
    // permissions in Android WebView. captureStream is optional, for short live clips.
    try { kiosk.mediaStream = canvas.captureStream(15); } catch (error) {}
    const video = document.getElementById('videoFeed');
    if (video && kiosk.mediaStream) video.srcObject = kiosk.mediaStream;
    if (typeof kiosk.applyCameraTransform === 'function') kiosk.applyCameraTransform();
    if (typeof kiosk.applyCameraImageAdjustToLiveVideo === 'function') kiosk.applyCameraImageAdjustToLiveVideo();
    draw();
  }

  function install(kiosk) {
    if (!kiosk || kiosk.__mafazaStillCaptureInstalled) return;
    kiosk.__mafazaStillCaptureInstalled = true;
    const oldCaptureFrame = kiosk.captureFrame;
    const oldPostCapture = kiosk.handlePostCapture;
    const oldHardwareCapture = kiosk.triggerHardwareCameraAndFlash;
    const oldManualSnap = kiosk.triggerManualSnap;
    const oldCountdown = kiosk.startCountdown;
    const oldAudioFlash = kiosk.triggerAudioJackFlash;
    const oldLiveView = kiosk.startCanonUsbDirectStream;

    kiosk.startCanonUsbDirectStream = async function (info) {
      if (typeof window.MafazaAndroidBridge.getLiveViewFrame !== 'function') return oldLiveView.call(this, info);
      startNativeLiveView(this, info);
    };

    kiosk.captureFrame = function (index) {
      if (requiresStill(this)) return false;
      return oldCaptureFrame.call(this, index);
    };
    kiosk.handlePostCapture = function (index) {
      if (requiresStill(this) && (this.hardwareCaptureFailedPose === index || !this.posesCaptured[index])) {
        retryPose(this, index);
        return;
      }
      return oldPostCapture.call(this, index);
    };
    kiosk.triggerManualSnap = function () {
      if (this.__mafazaCaptureBusy || this.isCountingDown) return;
      return oldManualSnap.apply(this, arguments);
    };
    kiosk.startCountdown = function () {
      if (this.__mafazaCaptureBusy || this.isCountingDown) return;
      return oldCountdown.apply(this, arguments);
    };
    kiosk.triggerAudioJackFlash = function () {
      // The physical Sony/Canon shutter controls the flash on its hot shoe.
      if (requiresStill(this)) return;
      return oldAudioFlash.apply(this, arguments);
    };

    kiosk.triggerHardwareCameraAndFlash = async function (index) {
      if (!requiresStill(this)) return oldHardwareCapture.call(this, index);
      if (this.__mafazaCaptureBusy) return false;
      this.__mafazaCaptureBusy = true;
      this.hardwareCaptureFailedPose = index;
      this.lastHardwareCaptureError = '';
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, 45000);
      try {
        // Never reroute a failed tablet capture to a camera attached to the web server.
        const response = await fetch('http://127.0.0.1:19898/capture', {
          method: 'POST', cache: 'no-store', signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok || data.ok !== true || data.captureKind !== 'still' || !data.imageUrl) {
          throw new Error(data.error || 'Foto asli kamera belum diterima. Periksa kabel USB-C dan PC Remote.');
        }
        const photoUrl = new URL(data.imageUrl);
        if (photoUrl.origin !== 'http://127.0.0.1:19898' || photoUrl.pathname !== '/captured_pose.jpg') {
          throw new Error('Alamat foto kamera tidak valid.');
        }
        const img = await loadPhoto(photoUrl.href);
        this.posesCaptured[index] = renderPhoto(this, img);
        this.rawPosesSyncedForSession = null;
        this.hardwareCaptureFailedPose = null;
        this.renderFilmstripDock();
        return true;
      } catch (error) {
        this.hardwareCaptureFailedPose = index;
        this.lastHardwareCaptureError = error.name === 'AbortError'
          ? 'Kamera terlalu lama merespons. Periksa koneksi USB lalu coba lagi.'
          : (error.message || 'Foto kamera gagal. Silakan ambil ulang.');
        return false;
      } finally {
        clearTimeout(timer);
        this.__mafazaCaptureBusy = false;
      }
    };
  }

  install(window.kiosk);
  setInterval(function () {
    const kiosk = window.kiosk;
    install(kiosk);
    if (!kiosk || !requiresStill(kiosk) || typeof window.MafazaAndroidBridge.getCameraStatus !== 'function') return;
    try {
      const status = JSON.parse(window.MafazaAndroidBridge.getCameraStatus());
      if (status.active && (!kiosk.canonUsbStreamActive || !kiosk.__mafazaNativeLiveLoop)) {
        kiosk.canonUsbBridgeInfo = status;
        if (typeof kiosk.populateQuickCameraSelect === 'function') kiosk.populateQuickCameraSelect([], 'canon_usb_direct');
        startNativeLiveView(kiosk, status);
      } else if (!status.active && kiosk.currentScreen === 'screenCapture') {
        liveMessage(status.connectionError || 'Menunggu koneksi kamera USB. Ketuk indikator USB untuk melihat diagnostik.');
      }
    } catch (error) {}
  }, 500);
})();
