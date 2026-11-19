// Bundled with the APK. Cooperates seamlessly across Built-in cameras, WebRTC UVC/HDMI cameras, and USB PTP DSLRs.
(function () {
  'use strict';
  if (!window.MafazaAndroidBridge || window.__mafazaUsbCaptureGuard) return;
  window.__mafazaUsbCaptureGuard = true;

  function readNativeStatus() {
    try {
      if (typeof window.MafazaAndroidBridge.getCameraStatus !== 'function') return null;
      return JSON.parse(window.MafazaAndroidBridge.getCameraStatus());
    } catch (error) {
      return null;
    }
  }

  function requiresStill(kiosk, status) {
    if (!kiosk) return false;
    if (kiosk.cameraConfig && kiosk.cameraConfig.cameraMode === 'webcam_only') return false;
    if (kiosk.__mafazaPreferWebCamera) return false;
    const st = status || readNativeStatus();
    if (!st) return Boolean(kiosk.canonUsbStreamActive);
    return Boolean(st.active || st.usbAttached || st.connectionError || kiosk.canonUsbStreamActive);
  }

  function refreshCameraDropdown(kiosk, selectedId) {
    if (!kiosk || typeof kiosk.populateQuickCameraSelect !== 'function') return;
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
        navigator.mediaDevices.enumerateDevices().then(function (devs) {
          const videoInputs = (devs || []).filter(function (d) { return d && d.kind === 'videoinput'; });
          kiosk.populateQuickCameraSelect(videoInputs, selectedId);
        }).catch(function () {});
      } else {
        kiosk.populateQuickCameraSelect([], selectedId);
      }
    } catch (e) {}
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

  function renderPhoto(kiosk, img, poseIndex) {
    const rawRot = [0, 90, 180, 270].includes(kiosk.cameraRotation) ? kiosk.cameraRotation : 0;
    const effectiveRot = ((rawRot === 90 || rawRot === 270) && img.naturalHeight > img.naturalWidth) ? 0 : rawRot;

    let srcDrawable = img;
    let w = img.naturalWidth;
    let h = img.naturalHeight;

    if (effectiveRot !== 0) {
      const swap = (effectiveRot === 90 || effectiveRot === 270);
      const rotCanvas = document.createElement('canvas');
      rotCanvas.width = swap ? h : w;
      rotCanvas.height = swap ? w : h;
      const rCtx = rotCanvas.getContext('2d');
      if (rCtx && typeof rCtx.translate === 'function' && typeof rCtx.rotate === 'function') {
        rCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
        rCtx.rotate((effectiveRot * Math.PI) / 180);
        rCtx.drawImage(img, -w / 2, -h / 2, w, h);
        srcDrawable = rotCanvas;
        w = rotCanvas.width;
        h = rotCanvas.height;
        if (poseIndex !== undefined && poseIndex !== null) {
          kiosk.__captureFrameRotatedFlags = kiosk.__captureFrameRotatedFlags || {};
          kiosk.__captureFrameRotatedFlags[poseIndex] = true;
        }
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Layar tidak dapat memproses foto kamera.');

    try {
      const cssFilter = (typeof kiosk.getCameraCssFilterString === 'function') ? kiosk.getCameraCssFilterString() : '';
      if (cssFilter && 'filter' in ctx) ctx.filter = cssFilter;
    } catch (e) {}

    const zoom = Math.max(0.5, Math.min(3, kiosk.cameraZoom || 1));
    const panX = Math.max(-1, Math.min(1, kiosk.cameraPanX || 0));
    const panY = Math.max(-1, Math.min(1, kiosk.cameraPanY || 0));
    if (zoom < 1) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      const dw = w * zoom;
      const dh = h * zoom;
      ctx.drawImage(srcDrawable, 0, 0, w, h, (w - dw) / 2 * (1 + panX), (h - dh) / 2 * (1 - panY), dw, dh);
    } else {
      const cropW = w / zoom;
      const cropH = h / zoom;
      const x = Math.max(0, Math.min(w - cropW, (w - cropW) / 2 * (1 - panX)));
      const y = Math.max(0, Math.min(h - cropH, (h - cropH) / 2 * (1 + panY)));
      ctx.drawImage(srcDrawable, x, y, cropW, cropH, 0, 0, w, h);
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

  function updateUsbFallbackActions(kiosk, show) {
    const frame = document.getElementById('cameraRetroFrame');
    if (!frame) return;
    let bar = document.getElementById('mafazaLiveViewActions');
    if (!show) {
      if (bar) bar.style.display = 'none';
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mafazaLiveViewActions';
      bar.style.cssText = 'position:absolute;left:0;right:0;bottom:24px;z-index:4;display:flex;justify-content:center;gap:10px;pointer-events:auto;';

      const rescanBtn = document.createElement('button');
      rescanBtn.type = 'button';
      rescanBtn.innerText = '🔄 Scan Ulang USB';
      rescanBtn.style.cssText = 'padding:8px 14px;border-radius:999px;border:1.5px solid #fff;background:#e6786b;color:#fff;font-size:12px;font-weight:800;cursor:pointer;';
      rescanBtn.onclick = function (e) {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        if (window.kiosk) window.kiosk.__mafazaPreferWebCamera = false;
        if (window.MafazaAndroidBridge && typeof window.MafazaAndroidBridge.rescanCanonUsb === 'function') {
          window.MafazaAndroidBridge.rescanCanonUsb();
        }
      };

      const builtinBtn = document.createElement('button');
      builtinBtn.type = 'button';
      builtinBtn.innerText = '📱 Pakai Kamera Bawaan';
      builtinBtn.style.cssText = 'padding:8px 14px;border-radius:999px;border:1.5px solid #fff;background:rgba(28,22,18,0.88);color:#fff;font-size:12px;font-weight:800;cursor:pointer;';
      builtinBtn.onclick = function (e) {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        const k = window.kiosk;
        if (!k) return;
        k.__mafazaPreferWebCamera = true;
        k.canonUsbStreamActive = false;
        k.__mafazaNativeLiveLoop = false;
        k.__mafazaLiveGeneration = (k.__mafazaLiveGeneration || 0) + 1;
        if (k.canonUsbCanvas) k.canonUsbCanvas.style.display = 'none';
        liveMessage('');
        updateUsbFallbackActions(k, false);
        if (typeof k.startCamera === 'function') k.startCamera(null, true);
      };

      bar.appendChild(rescanBtn);
      bar.appendChild(builtinBtn);
      frame.appendChild(bar);
    }
    bar.style.display = 'flex';
  }

  function stopNativeLiveView(kiosk) {
    if (!kiosk) return;
    if (kiosk.canonUsbLoopTimer) {
      clearTimeout(kiosk.canonUsbLoopTimer);
      kiosk.canonUsbLoopTimer = null;
    }
    kiosk.canonUsbStreamActive = false;
    kiosk.__mafazaNativeLiveLoop = false;
    kiosk.__mafazaLiveGeneration = (kiosk.__mafazaLiveGeneration || 0) + 1;
    if (kiosk.canonUsbCanvas) kiosk.canonUsbCanvas.style.display = 'none';
    liveMessage('');
    updateUsbFallbackActions(kiosk, false);
  }

  function startNativeLiveView(kiosk, info) {
    if (kiosk.canonUsbLoopTimer) clearTimeout(kiosk.canonUsbLoopTimer);
    if (kiosk.mediaStream) kiosk.mediaStream.getTracks().forEach(function (track) { track.stop(); });
    kiosk.mediaStream = null;
    kiosk.canonUsbBridgeInfo = info;
    updateUsbFallbackActions(kiosk, false);
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

    if (info && info.supportsLiveView === false) {
      liveMessage('📷 ' + (info.camera || 'Kamera USB PTP') + ' terhubung (Mode Shutter USB). Sentuh Foto untuk memotret.');
      return;
    }

    liveMessage('Menunggu gambar dari kamera…');

    const draw = async function () {
      if (generation !== kiosk.__mafazaLiveGeneration) return;
      const status = readNativeStatus();
      if (!kiosk.canonUsbStreamActive || !requiresStill(kiosk, status)) {
        kiosk.__mafazaNativeLiveLoop = false;
        canvas.style.display = 'none';
        liveMessage('');
        updateUsbFallbackActions(kiosk, false);
        return;
      }
      try {
        if (!status || !status.active || !status.hasFrame) {
          liveMessage(kiosk.__mafazaCaptureBusy ? 'Mengambil foto…' : 'Gambar kamera belum diterima. Periksa PC Remote dan kabel USB-C.');
          updateUsbFallbackActions(kiosk, Boolean(status && !status.active));
        } else if (status.frames !== lastFrame) {
          const dataUrl = window.MafazaAndroidBridge.getLiveViewFrame();
          if (!dataUrl) throw new Error('Gambar kamera belum siap.');
          const image = await loadPhoto(dataUrl, 2000);
          if (!kiosk.canonUsbStreamActive || generation !== kiosk.__mafazaLiveGeneration) return;
          if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            if (typeof kiosk.applyCameraTransform === 'function') kiosk.applyCameraTransform();
          }
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          lastFrame = status.frames;
          lastDisplayTime = Date.now();
          liveMessage('');
          updateUsbFallbackActions(kiosk, false);
        } else if (Date.now() - lastDisplayTime > 5000 && !kiosk.__mafazaCaptureBusy) {
          liveMessage('Gambar kamera terhenti. Periksa koneksi USB lalu scan ulang kamera.');
          updateUsbFallbackActions(kiosk, true);
        }
      } catch (error) {
        liveMessage('Gambar kamera belum dapat ditampilkan. Ketuk indikator USB untuk melihat diagnostik.');
        kiosk.lastLiveViewError = error.message;
      }
      if (generation === kiosk.__mafazaLiveGeneration) kiosk.canonUsbLoopTimer = setTimeout(draw, 65);
    };
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
    const oldQuickSelect = kiosk.onQuickCameraSelectChange;

    kiosk.startCanonUsbDirectStream = async function (info) {
      if (typeof window.MafazaAndroidBridge.getLiveViewFrame !== 'function') return oldLiveView.call(this, info);
      startNativeLiveView(this, info);
    };

    if (typeof oldQuickSelect === 'function') {
      kiosk.onQuickCameraSelectChange = async function (deviceId) {
        if (deviceId && deviceId !== 'canon_usb_direct') {
          this.__mafazaPreferWebCamera = true;
          stopNativeLiveView(this);
        } else if (deviceId === 'canon_usb_direct') {
          this.__mafazaPreferWebCamera = false;
          if (typeof window.MafazaAndroidBridge.rescanCanonUsb === 'function') {
            window.MafazaAndroidBridge.rescanCanonUsb();
          }
        }
        return oldQuickSelect.call(this, deviceId);
      };
    }

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
      // Physical USB DSLR controls its own hotshoe flash; built-in/UVC camera still fires audio jack flash.
      if (requiresStill(this)) return;
      return oldAudioFlash.apply(this, arguments);
    };

    kiosk.triggerHardwareCameraAndFlash = async function (index) {
      if (!requiresStill(this)) return false;
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
        this.posesCaptured[index] = renderPhoto(this, img, index);
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

  let lastUsbAttached = false;
  let lastUsbActive = false;
  let lastUvcAttached = false;

  install(window.kiosk);
  setInterval(function () {
    const kiosk = window.kiosk;
    install(kiosk);
    if (!kiosk || typeof window.MafazaAndroidBridge.getCameraStatus !== 'function') return;
    try {
      const status = JSON.parse(window.MafazaAndroidBridge.getCameraStatus());
      const usbAttached = Boolean(status.usbAttached);
      const usbActive = Boolean(status.active);
      const uvcAttached = Boolean(status.usbUvcAttached);

      // A newly plugged or reconnected USB camera always takes over automatically unless explicitly overridden later.
      if ((usbAttached && !lastUsbAttached) || (usbActive && !lastUsbActive)) {
        kiosk.__mafazaPreferWebCamera = false;
      }
      lastUsbAttached = usbAttached;
      lastUsbActive = usbActive;

      if (uvcAttached !== lastUvcAttached) {
        lastUvcAttached = uvcAttached;
        if (!usbActive && !usbAttached && typeof kiosk.onNativeCameraInventoryChanged === 'function') {
          kiosk.onNativeCameraInventoryChanged();
        }
      }

      if (kiosk.cameraConfig && kiosk.cameraConfig.cameraMode === 'webcam_only') {
        updateUsbFallbackActions(kiosk, false);
        return;
      }

      if (kiosk.__mafazaPreferWebCamera) {
        updateUsbFallbackActions(kiosk, false);
        return;
      }

      if (status.active && (!kiosk.canonUsbStreamActive || !kiosk.__mafazaNativeLiveLoop)) {
        kiosk.canonUsbBridgeInfo = status;
        refreshCameraDropdown(kiosk, 'canon_usb_direct');
        startNativeLiveView(kiosk, status);
      } else if (!status.active && !status.usbAttached && !status.connectionError) {
        // No USB PTP camera is connected: use built-in / WebRTC UVC camera cleanly without blocking overlay.
        const wasUsbStream = Boolean(kiosk.canonUsbStreamActive);
        if (wasUsbStream) {
          stopNativeLiveView(kiosk);
          kiosk.canonUsbBridgeInfo = null;
          if ((kiosk.currentScreen === 'screenCapture' || kiosk.currentScreen === 'screenQR') && typeof kiosk.startCamera === 'function') {
            kiosk.startCamera(null, true);
          }
        } else if (kiosk.currentScreen === 'screenCapture') {
          liveMessage('');
          updateUsbFallbackActions(kiosk, false);
        }
      } else if (!status.active && kiosk.currentScreen === 'screenCapture' && (status.usbAttached || status.connectionError)) {
        liveMessage(status.connectionError || ('Menghubungkan ' + (status.camera || 'kamera USB') + '… Ketuk indikator USB untuk diagnostik.'));
        updateUsbFallbackActions(kiosk, Boolean(status.connectionError || status.usbAttached));
      }
    } catch (error) {}
  }, 500);
})();
