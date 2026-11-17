import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const kioskSource = fs.readFileSync(new URL('../public/js/kiosk.js', import.meta.url), 'utf8');
const guardSource = fs.readFileSync(new URL('../android-kiosk/assets/usb-capture-guard.js', import.meta.url), 'utf8');

function fixture({ reply, networkError, imageError = false, webcam = false, hasLiveFrame = true, sessionError = '' } = {}) {
  const calls = { capture: 0, preview: 0, post: 0, server: 0, audio: 0, draw: 0, nativeFrame: 0 };
  const timeouts = new Map();
  const intervals = new Map();
  const elements = new Map();
  const images = [];
  const canvases = [];
  let nextTimer = 1;
  const element = () => ({ style: {}, innerText: '', appendChild(child) { elements.set(child.id, child); child.parentElement = this; }, insertBefore(child) { child.parentElement = this; } });
  for (const id of ['cameraRetroFrame', 'videoFeed', 'smileHintText', 'postCapturePreviewOverlay', 'countdownBox']) elements.set(id, element());
  const document = {
    getElementById: id => elements.get(id) || null,
    createElement(type) {
      if (type !== 'canvas') return element();
      const canvas = {
        ...element(), width: 0, height: 0,
        getContext: () => ({ drawImage() { calls.draw++; }, fillRect() {} }),
        toDataURL: () => 'data:image/jpeg;base64,c3RpbGwtcGhvdG8=',
        captureStream: () => ({ getTracks: () => [] }),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  class MockImage {
    constructor() { this.naturalWidth = 6000; this.naturalHeight = 4000; images.push(this); }
    set src(value) {
      this.url = value;
      queueMicrotask(() => {
        if (imageError === 'wait') return;
        if (imageError) this.onerror?.();
        else this.onload?.();
      });
    }
  }
  const window = {
    __pbNotifyInitialized: true, addEventListener() {},
    MafazaAndroidBridge: {
      getCameraStatus: () => JSON.stringify({ active: !sessionError, connectionError: sessionError, hasFrame: hasLiveFrame, frames: hasLiveFrame ? 1 : 0 }),
      getLiveViewFrame: () => { calls.nativeFrame++; return 'data:image/jpeg;base64,bGl2ZQ=='; },
    },
  };
  const context = vm.createContext({
    window, document, Image: MockImage, URL, URLSearchParams, AbortController,
    console: { log() {}, warn() {} },
    setInterval: (fn, ms) => { const id = nextTimer++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = nextTimer++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    fetch: async (url) => {
      assert.equal(url, 'http://127.0.0.1:19898/capture');
      calls.capture++;
      if (networkError) throw new Error('USB bridge unavailable');
      const data = typeof reply === 'function' ? await reply() : (reply || {
        ok: true, captureKind: 'still', imageUrl: 'http://127.0.0.1:19898/captured_pose.jpg?id=1',
      });
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(kioskSource, context);
  const k = vm.runInContext('Object.create(KioskEngine.prototype)', context);
  Object.assign(k, {
    cameraConfig: { cameraMode: webcam ? 'webcam_only' : 'sony_canon_flash' },
    posesCaptured: [null, null], activePoseIndex: 0, totalPosesRequired: 2,
    currentScreen: 'screenCapture',
    isCountingDown: false, cameraZoom: 1, rawPosesSyncedForSession: 'old-session',
    clearAllTimers() {}, playShutterSound() {}, triggerShutterFlash() {},
    stopPoseLiveRecording() {}, renderFilmstripDock() {},
    applyCameraTransform() {}, applyCameraImageAdjustToLiveVideo() {},
    captureFrame(index) { calls.preview++; this.posesCaptured[index] = 'preview'; },
    handlePostCapture() { calls.post++; },
    triggerHardwareCameraAndFlash() { calls.server++; return Promise.resolve(false); },
    triggerAudioJackFlash() { calls.audio++; },
    showToast(message) { this.lastToast = message; },
  });
  window.kiosk = k;
  vm.runInContext(guardSource, context);
  return { k, calls, timeouts, intervals, elements, images, canvases };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('Android: rejected native capture keeps the same pose without preview or server fallback', async () => {
  const f = fixture({ reply: { ok: false, error: 'Shutter Sony ditolak' } });
  f.k.triggerManualSnap();
  await flush();
  assert.equal(f.calls.capture, 1);
  assert.equal(f.calls.preview, 0);
  assert.equal(f.calls.post, 0);
  assert.equal(f.calls.server, 0);
  assert.equal(f.calls.audio, 0);
  assert.equal(f.k.posesCaptured[0], null);
  assert.equal(f.k.activePoseIndex, 0);
  assert.equal(f.k.lastToast, 'Shutter Sony ditolak');
});

test('Android: an unverified image URL cannot be accepted as a still photo', async () => {
  const f = fixture({ reply: { ok: true, imageUrl: 'http://127.0.0.1:19898/frame.jpg' } });
  f.k.triggerManualSnap(); await flush();
  assert.equal(f.k.posesCaptured[0], null);
  assert.equal(f.calls.preview + f.calls.post, 0);
});

test('Android: USB network error and undecodable JPEG cannot advance the pose', async () => {
  for (const options of [{ networkError: true }, { imageError: true }]) {
    const f = fixture(options);
    f.k.triggerManualSnap(); await flush();
    assert.equal(f.calls.preview + f.calls.post + f.calls.server, 0);
    assert.equal(f.k.posesCaptured[0], null);
    assert.equal(f.k.__mafazaCaptureBusy, false);
  }
});

test('Android: downloaded still preserves full resolution and invalidates previous sync state', async () => {
  const f = fixture();
  f.k.triggerManualSnap(); await flush();
  assert.equal(f.calls.preview, 0);
  assert.equal(f.calls.post, 1);
  assert.match(f.k.posesCaptured[0], /^data:image\/jpeg/);
  assert.equal(f.canvases[0].width, 6000);
  assert.equal(f.canvases[0].height, 4000);
  assert.equal(f.k.rawPosesSyncedForSession, null);
});

test('Android: an image timeout ignores late image callbacks', async () => {
  const f = fixture({ imageError: 'wait' });
  f.k.triggerManualSnap(); await flush();
  const timeout = [...f.timeouts.values()].find(t => t.ms === 15000);
  assert.ok(timeout);
  timeout.fn(); await flush();
  f.images[0].onload?.(); await flush();
  assert.equal(f.k.posesCaptured[0], null);
  assert.equal(f.calls.post + f.calls.preview, 0);
});

test('Android: failed retake preserves the previous photo without calling it a new success', async () => {
  const f = fixture({ reply: { ok: false, error: 'Unduhan gagal' } });
  f.k.posesCaptured[0] = 'previous-photo';
  f.k.triggerManualSnap(); await flush();
  assert.equal(f.k.posesCaptured[0], 'previous-photo');
  assert.equal(f.calls.post, 0);
  assert.equal(f.k.activePoseIndex, 0);
});

test('Android: repeated taps do not send duplicate shutter requests', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ reply: () => pending });
  f.k.triggerManualSnap();
  f.k.triggerManualSnap();
  assert.equal(f.calls.capture, 1);
  release({ ok: false, error: 'Coba ulang' }); await flush();
  assert.equal(f.calls.post, 0);
});

test('Android: explicit webcam mode retains webcam capture and audio behavior', () => {
  const f = fixture({ webcam: true });
  f.k.triggerManualSnap();
  assert.equal(f.calls.capture, 0);
  assert.equal(f.calls.preview, 1);
  assert.equal(f.calls.post, 1);
  assert.equal(f.calls.audio, 1);
});

test('Android live preview draws native JPEG without createImageBitmap or HTTP loopback', async () => {
  const f = fixture();
  await f.k.startCanonUsbDirectStream({ active: true }); await flush();
  assert.equal(f.calls.nativeFrame, 1);
  assert.equal(f.calls.draw, 1);
  assert.equal(f.calls.capture, 0);
  assert.equal(f.elements.get('mafazaLiveViewStatus').style.display, 'none');
});

test('Android live preview explains a session with no image instead of showing a silent black screen', async () => {
  const f = fixture({ hasLiveFrame: false });
  await f.k.startCanonUsbDirectStream({ active: true }); await flush();
  assert.equal(f.calls.draw, 0);
  assert.equal(f.calls.nativeFrame, 0);
  assert.match(f.elements.get('mafazaLiveViewStatus').innerText, /belum diterima/);
});

test('Android displays session-opening errors inside the preview area', () => {
  const f = fixture({ sessionError: 'Membuka sesi kamera gagal' });
  [...f.intervals.values()].find(timer => timer.ms === 500).fn();
  assert.equal(f.elements.get('mafazaLiveViewStatus').innerText, 'Membuka sesi kamera gagal');
  assert.equal(f.calls.draw, 0);
});
