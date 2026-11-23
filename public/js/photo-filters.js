/**
 * MAFAZA PHOTOBOOTH — PRINT-CALIBRATED PHOTO FILTER ENGINE
 * Shared across Kiosk (/kiosk), Mingle (/mingle), and Admin previews.
 * Features:
 *  - 7 print-safe presets calibrated to avoid shadow crush & blown skin highlights on Epson glossy/matte paper
 *  - Authentic soft-glow diffusion bloom for Glowing & Korean Soft presets
 *  - Intensity scaling (30% - 100%)
 *  - Runtime Canvas ctx.filter probe with automatic pure-pixel fallback for older WebKit / iPadOS
 *  - Per-photo offscreen cache for 60fps drag & pinch-to-zoom on Android tablets
 */
(function initMafazaPhotoFilters(global) {
  'use strict';

  const FILTER_PRESETS = {
    normal: {
      key: 'normal',
      label: 'Normal',
      shortLabel: '🌿 Normal',
      dotColor: '#94a3b8',
      css: 'none',
      brightness: 1.0,
      contrast: 1.0,
      saturate: 1.0,
      sepia: 0.0,
      grayscale: 0.0,
      warmth: 0,
      tint: null,
      shadowLiftRgb: null,
      glowAlpha: 0
    },
    glowing: {
      key: 'glowing',
      label: 'Glowing',
      shortLabel: '✨ Glowing',
      dotColor: '#fbbf24',
      css: 'brightness(105%) contrast(102%) saturate(106%)',
      brightness: 1.05,
      contrast: 1.02,
      saturate: 1.06,
      sepia: 0.04,
      grayscale: 0.0,
      warmth: 6,
      tint: 'rgba(255, 226, 198, 0.06)',
      shadowLiftRgb: [12, 10, 10],
      glowAlpha: 0.18
    },
    korean: {
      key: 'korean',
      label: 'Korean Soft',
      shortLabel: '🌸 Soft',
      dotColor: '#f472b6',
      css: 'brightness(108%) contrast(95%) saturate(103%)',
      brightness: 1.08,
      contrast: 0.95,
      saturate: 1.03,
      sepia: 0.0,
      grayscale: 0.0,
      warmth: -3,
      tint: 'rgba(255, 232, 242, 0.07)',
      shadowLiftRgb: [16, 14, 18],
      glowAlpha: 0.15
    },
    warm_retro: {
      key: 'warm_retro',
      label: 'Warm Retro',
      shortLabel: '🧡 Retro',
      dotColor: '#ea580c',
      css: 'sepia(22%) contrast(106%) brightness(102%) saturate(110%)',
      brightness: 1.02,
      contrast: 1.06,
      saturate: 1.10,
      sepia: 0.22,
      grayscale: 0.0,
      warmth: 14,
      tint: 'rgba(255, 198, 130, 0.06)',
      shadowLiftRgb: [22, 16, 12],
      glowAlpha: 0.05
    },
    vivid: {
      key: 'vivid',
      label: 'Vivid Pop',
      shortLabel: '🎨 Vivid',
      dotColor: '#06b6d4',
      css: 'contrast(111%) saturate(126%) brightness(102%)',
      brightness: 1.02,
      contrast: 1.11,
      saturate: 1.26,
      sepia: 0.0,
      grayscale: 0.0,
      warmth: 0,
      tint: null,
      shadowLiftRgb: [8, 8, 10],
      glowAlpha: 0
    },
    bw: {
      key: 'bw',
      label: 'B&W Estetik',
      shortLabel: '🖤 B&W',
      dotColor: '#1e293b',
      css: 'grayscale(100%) contrast(114%) brightness(105%)',
      brightness: 1.05,
      contrast: 1.14,
      saturate: 0.0,
      sepia: 0.0,
      grayscale: 1.0,
      warmth: 0,
      tint: null,
      shadowLiftRgb: [18, 18, 20],
      glowAlpha: 0
    },
    cinematic: {
      key: 'cinematic',
      label: 'Cinematic',
      shortLabel: '🎬 Cinematic',
      dotColor: '#854d0e',
      css: 'contrast(112%) saturate(92%) brightness(100%) sepia(10%)',
      brightness: 1.00,
      contrast: 1.12,
      saturate: 0.92,
      sepia: 0.10,
      grayscale: 0.0,
      warmth: 4,
      tint: 'rgba(22, 58, 72, 0.07)',
      shadowLiftRgb: [16, 20, 24],
      glowAlpha: 0
    }
  };

  const PRESET_ORDER = ['normal', 'glowing', 'korean', 'warm_retro', 'vivid', 'bw', 'cinematic'];

  function normalizeFilterKey(key) {
    const k = String(key || 'normal').trim().toLowerCase();
    return FILTER_PRESETS[k] ? k : 'normal';
  }

  function normalizeIntensity(intensity) {
    const num = Number(intensity);
    if (!Number.isFinite(num)) return 1.0;
    return Math.max(0.2, Math.min(1.0, num));
  }

  function getPreset(key) {
    return FILTER_PRESETS[normalizeFilterKey(key)];
  }

  function getLabel(key, short = false) {
    const p = getPreset(key);
    return short ? p.shortLabel : (p.key === 'normal' ? p.shortLabel : `${p.shortLabel.split(' ')[0]} ${p.label}`);
  }

  function getScaledCssFilter(key, intensity = 1.0, extraCssFilter = '') {
    const preset = getPreset(key);
    const t = normalizeIntensity(intensity);
    const parts = [];
    if (preset.key !== 'normal') {
      const br = 1 + (preset.brightness - 1) * t;
      const ct = 1 + (preset.contrast - 1) * t;
      const sat = 1 + (preset.saturate - 1) * t;
      const sep = preset.sepia * t;
      const gray = preset.grayscale * t;
      if (Math.abs(br - 1) > 0.005) parts.push(`brightness(${Math.round(br * 100)}%)`);
      if (Math.abs(ct - 1) > 0.005) parts.push(`contrast(${Math.round(ct * 100)}%)`);
      if (Math.abs(sat - 1) > 0.005) parts.push(`saturate(${Math.round(sat * 100)}%)`);
      if (sep > 0.005) parts.push(`sepia(${Math.round(sep * 100)}%)`);
      if (gray > 0.005) parts.push(`grayscale(${Math.round(gray * 100)}%)`);
    }
    const extra = String(extraCssFilter || '').trim();
    if (extra && extra !== 'none') parts.push(extra);
    return parts.length > 0 ? parts.join(' ') : 'none';
  }

  let _ctxFilterSupport = null;
  function supportsCanvasFilter() {
    if (_ctxFilterSupport !== null) return _ctxFilterSupport;
    if (typeof document === 'undefined') {
      _ctxFilterSupport = false;
      return false;
    }
    try {
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 4;
      const ctx = c.getContext('2d');
      if (!ctx || typeof ctx.filter !== 'string') {
        _ctxFilterSupport = false;
        return false;
      }
      ctx.filter = 'brightness(50%)';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 4, 4);
      const px = ctx.getImageData(1, 1, 1, 1).data;
      _ctxFilterSupport = px && px[0] > 40 && px[0] < 190;
    } catch (e) {
      _ctxFilterSupport = false;
    }
    return _ctxFilterSupport;
  }

  function applyPixelGrading(imageData, preset, t, extraAdjust = null) {
    const data = imageData.data;
    const br = (1 + (preset.brightness - 1) * t) * (extraAdjust ? extraAdjust.brightness : 1);
    const ct = (1 + (preset.contrast - 1) * t) * (extraAdjust ? extraAdjust.contrast : 1);
    const sat = (1 + (preset.saturate - 1) * t) * (extraAdjust ? extraAdjust.saturation : 1);
    const sep = preset.sepia * t;
    const gray = preset.grayscale * t;
    const warmth = (preset.warmth || 0) * t;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      // Brightness
      r *= br;
      g *= br;
      b *= br;

      // Contrast around mid-grey 128
      r = (r - 128) * ct + 128;
      g = (g - 128) * ct + 128;
      b = (b - 128) * ct + 128;

      // Grayscale blend
      if (gray > 0.001) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = r + (lum - r) * gray;
        g = g + (lum - g) * gray;
        b = b + (lum - b) * gray;
      }

      // Sepia blend
      if (sep > 0.001) {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        r = r + (sr - r) * sep;
        g = g + (sg - g) * sep;
        b = b + (sb - b) * sep;
      }

      // Saturation
      if (Math.abs(sat - 1) > 0.001 && gray < 0.999) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
      }

      // Subtle print-friendly warmth bias
      if (warmth !== 0) {
        r += warmth * 0.65;
        b -= warmth * 0.55;
      }

      data[i] = r < 0 ? 0 : (r > 255 ? 255 : (r + 0.5) | 0);
      data[i + 1] = g < 0 ? 0 : (g > 255 ? 255 : (g + 0.5) | 0);
      data[i + 2] = b < 0 ? 0 : (b > 255 ? 255 : (b + 0.5) | 0);
    }
  }

  function parseExtraCssAdjust(extraCssFilter) {
    const str = String(extraCssFilter || '');
    if (!str || str === 'none') return null;
    const readPct = (name) => {
      const m = str.match(new RegExp(`${name}\\((\\d+(?:\\.\\d+)?)%\\)`, 'i'));
      return m ? Math.max(0.2, Math.min(3.0, Number(m[1]) / 100)) : 1.0;
    };
    return {
      brightness: readPct('brightness'),
      contrast: readPct('contrast'),
      saturation: readPct('saturate')
    };
  }

  // LRU cache keyed by source tag + filter parameters so slot panning runs at 60fps
  const _filteredCache = new Map();
  const MAX_CACHE_ENTRIES = 18;

  function setCacheEntry(key, val) {
    if (_filteredCache.has(key)) {
      _filteredCache.delete(key);
    } else if (_filteredCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = _filteredCache.keys().next().value;
      _filteredCache.delete(oldestKey);
    }
    _filteredCache.set(key, val);
  }

  function clearCache() {
    _filteredCache.clear();
  }

  function renderStyledCanvas(img, filterKey, options = {}) {
    if (!img) return null;
    const srcW = img.naturalWidth || img.videoWidth || img.width || 0;
    const srcH = img.naturalHeight || img.videoHeight || img.height || 0;
    if (srcW <= 0 || srcH <= 0) return img;

    const key = normalizeFilterKey(filterKey);
    const t = normalizeIntensity(options.intensity !== undefined ? options.intensity : 1.0);
    const extraCss = String(options.extraCssFilter || '').trim();
    const maxDim = Number(options.maxDim) || 0;

    if (key === 'normal' && (!extraCss || extraCss === 'none') && maxDim === 0) {
      return img;
    }

    let outW = srcW;
    let outH = srcH;
    if (maxDim > 0 && (srcW > maxDim || srcH > maxDim)) {
      const sc = Math.min(maxDim / srcW, maxDim / srcH);
      outW = Math.max(1, Math.round(srcW * sc));
      outH = Math.max(1, Math.round(srcH * sc));
    }

    const srcTag = options.cacheKey || (typeof img.src === 'string' ? img.src.slice(0, 120) : '') || `${srcW}x${srcH}`;
    const fullCacheKey = `${srcTag}::${key}::${Math.round(t * 100)}::${extraCss}::${outW}x${outH}`;
    if (!options.skipCache && _filteredCache.has(fullCacheKey)) {
      return _filteredCache.get(fullCacheKey);
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return img;

    const preset = getPreset(key);
    const useNativeCtxFilter = supportsCanvasFilter();

    if (useNativeCtxFilter) {
      const cssStr = getScaledCssFilter(key, t, extraCss);
      ctx.save();
      ctx.filter = cssStr !== 'none' ? cssStr : 'none';
      ctx.drawImage(img, 0, 0, outW, outH);
      ctx.restore();
    } else {
      ctx.drawImage(img, 0, 0, outW, outH);
      const extraAdj = parseExtraCssAdjust(extraCss);
      if (key !== 'normal' || extraAdj) {
        try {
          const imgData = ctx.getImageData(0, 0, outW, outH);
          applyPixelGrading(imgData, preset, t, extraAdj);
          ctx.putImageData(imgData, 0, 0);
        } catch (e) {}
      }
    }

    // 1. Soft diffusion bloom (downsample-upsample trick works smoothly on every browser/tablet)
    const glowAlpha = (preset.glowAlpha || 0) * t;
    if (glowAlpha > 0.01 && outW >= 16 && outH >= 16) {
      try {
        const bloomScale = Math.min(1, 180 / Math.max(outW, outH));
        const bw = Math.max(8, Math.round(outW * bloomScale));
        const bh = Math.max(8, Math.round(outH * bloomScale));
        const bloomCanvas = document.createElement('canvas');
        bloomCanvas.width = bw;
        bloomCanvas.height = bh;
        const bCtx = bloomCanvas.getContext('2d');
        if (bCtx) {
          bCtx.imageSmoothingEnabled = true;
          bCtx.drawImage(canvas, 0, 0, bw, bh);
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = glowAlpha;
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(bloomCanvas, 0, 0, outW, outH);
          ctx.restore();
        }
      } catch (e) {}
    }

    // 2. Print-safe shadow lift (prevents solid #000000 ink crush on Epson glossy/matte paper)
    if (Array.isArray(preset.shadowLiftRgb) && t > 0.05) {
      const r = Math.round(preset.shadowLiftRgb[0] * t);
      const g = Math.round(preset.shadowLiftRgb[1] * t);
      const b = Math.round(preset.shadowLiftRgb[2] * t);
      ctx.save();
      ctx.globalCompositeOperation = 'lighten';
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, outW, outH);
      ctx.restore();
    }

    // 3. Subtle film/highlight tone wash
    if (preset.tint && t > 0.05) {
      ctx.save();
      ctx.globalAlpha = t;
      ctx.fillStyle = preset.tint;
      ctx.fillRect(0, 0, outW, outH);
      ctx.restore();
    }

    if (!options.skipCache) {
      setCacheEntry(fullCacheKey, canvas);
    }
    return canvas;
  }

  function drawFilteredImage(ctx, img, dx, dy, dw, dh, filterKey, options = {}) {
    if (!ctx || !img) return;
    const styled = renderStyledCanvas(img, filterKey, options);
    if (!styled) return;
    ctx.drawImage(styled, dx, dy, dw, dh);
  }

  // Generate lightweight square preview dataURLs for filter pill mini-thumbnails
  async function updateFilterPillThumbnails(containerSelector, sampleSrc, extraCssFilter = '') {
    if (!sampleSrc || typeof document === 'undefined') return;
    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : containerSelector;
    if (!container) return;

    const buttons = container.querySelectorAll('[data-filter]');
    if (!buttons || buttons.length === 0) return;

    const img = new Image();
    img.src = sampleSrc;
    await new Promise((res) => { img.onload = res; img.onerror = res; });
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;

    // Crop square center once at 64x64 for near-instant rendering of all 7 pills
    const size = 64;
    const baseThumb = document.createElement('canvas');
    baseThumb.width = size;
    baseThumb.height = size;
    const bCtx = baseThumb.getContext('2d');
    const crop = Math.min(iw, ih);
    const sx = Math.floor((iw - crop) / 2);
    const sy = Math.floor((ih - crop) / 2);
    bCtx.drawImage(img, sx, sy, crop, crop, 0, 0, size, size);

    buttons.forEach((btn) => {
      const fKey = normalizeFilterKey(btn.getAttribute('data-filter'));
      const rendered = renderStyledCanvas(baseThumb, fKey, {
        intensity: 1.0,
        extraCssFilter,
        skipCache: true
      });
      if (!rendered) return;
      const thumbUrl = rendered.toDataURL('image/jpeg', 0.82);

      let thumbEl = btn.querySelector('img.filter-pill-thumb');
      if (!thumbEl) {
        const dotEl = btn.querySelector('.filter-pill-dot');
        thumbEl = document.createElement('img');
        thumbEl.className = 'filter-pill-thumb';
        thumbEl.alt = fKey;
        if (dotEl && dotEl.parentNode) {
          dotEl.replaceWith(thumbEl);
        } else {
          btn.insertBefore(thumbEl, btn.firstChild);
        }
      }
      thumbEl.src = thumbUrl;
    });
  }

  async function renderFilteredDataUrl(dataUrl, filterKey, options = {}) {
    if (!dataUrl) return null;
    const key = normalizeFilterKey(filterKey);
    const t = normalizeIntensity(options.intensity !== undefined ? options.intensity : 1.0);
    const extraCss = String(options.extraCssFilter || '').trim();
    if (key === 'normal' && (!extraCss || extraCss === 'none')) {
      return dataUrl;
    }
    const img = new Image();
    img.src = dataUrl;
    await new Promise((res) => { img.onload = res; img.onerror = res; });
    const styled = renderStyledCanvas(img, key, {
      intensity: t,
      extraCssFilter: extraCss,
      maxDim: options.maxDim || 0,
      skipCache: true
    });
    if (!styled || typeof styled.toDataURL !== 'function') return dataUrl;
    return styled.toDataURL(options.mimeType || 'image/jpeg', options.quality || 0.90);
  }

  async function filterDataUrlToBlob(dataUrl, filterKey, options = {}) {
    const outUrl = await renderFilteredDataUrl(dataUrl, filterKey, options);
    const res = await fetch(outUrl || dataUrl);
    return await res.blob();
  }

  const api = {
    FILTER_PRESETS,
    PRESET_ORDER,
    normalizeFilterKey,
    normalizeIntensity,
    getPreset,
    getLabel,
    getScaledCssFilter,
    supportsCanvasFilter,
    renderStyledCanvas,
    drawFilteredImage,
    updateFilterPillThumbnails,
    renderFilteredDataUrl,
    filterDataUrlToBlob,
    clearCache
  };

  global.MafazaPhotoFilters = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
