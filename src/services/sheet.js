import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import jpeg from 'jpeg-js';
import QRCode from 'qrcode';

/**
 * Zero-dependency PNG sheet composer.
 * Dipakai untuk menyusun "2 strip per lembar" (Photo Strip 2x6 di kertas 4x6)
 * sehingga hasil cetak otomatis pas dan siap potong, tanpa pengaturan manual di dialog printer.
 */

// Peta ukuran kertas pengaturan -> ukuran fisik kertas (inch) & tata letak
export const PAPER_PRESETS = {
  '2x6': { widthIn: 4, heightIn: 6, layout: '2up', label: 'Photo Strip 2×6 inch (2 strip per lembar kertas 4R / 102×152 mm)' },
  '4x6': { widthIn: 4, heightIn: 6, layout: 'single', label: 'Photo 4R (102×152 mm / 4×6 inch Postcard)' },
  '4r': { widthIn: 4, heightIn: 6, layout: 'single', label: 'Photo 4R (102×152 mm / 4×6 inch Postcard)' },
  '5x7': { widthIn: 5, heightIn: 7, layout: 'single', label: 'Photo 5R (127×178 mm / 5×7 inch)' },
  '5r': { widthIn: 5, heightIn: 7, layout: 'single', label: 'Photo 5R (127×178 mm / 5×7 inch)' },
  '4x4': { widthIn: 4, heightIn: 4, layout: 'single', label: 'Square 4×4 inch (102×102 mm)' },
  '6x8': { widthIn: 6, heightIn: 8, layout: 'single', label: 'Kertas 6×8' },
  'A4': { widthIn: 8.27, heightIn: 11.69, layout: 'single', label: 'Kertas A4' }
};

export function resolvePaper(paperSize) {
  const key = String(paperSize || '').trim();
  return PAPER_PRESETS[key] || PAPER_PRESETS[key.toLowerCase()] || PAPER_PRESETS['2x6'];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode PNG 8-bit RGB / RGBA non-interlaced. Return null jika format tidak didukung.
export function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf || buf.length < 33 || !buf.subarray(0, 8).equals(sig)) return null;

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) return null;

  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowIn + x];
      const a = x >= channels ? out[rowOut + x - channels] : 0;
      const b = y > 0 ? out[rowOut - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[rowOut - stride + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: return null;
      }
      out[rowOut + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// Decode PNG atau JPEG ke format { width, height, channels, data } secara universal
export function decodeImage(buf) {
  if (!buf || buf.length < 4) return null;
  // PNG signature: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return decodePng(buf);
  }
  // JPEG signature: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    try {
      const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 192 });
      return {
        width: decoded.width,
        height: decoded.height,
        channels: 4,
        data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
      };
    } catch (e) {
      return null;
    }
  }
  return null;
}

export function encodePng({ width, height, channels, data }) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Standar profil warna sRGB (Perceptual) agar warna cetak konsisten dengan layar & tidak kemerahan
  const srgb = Buffer.from([0]);

  // 300 DPI standard print metadata (11811 pixels per meter)
  // Memastikan macOS Preview, Windows & driver printer membaca ukuran fisik tepat 4x6 in (102x152 mm) tanpa terpotong
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(11811, 0);
  phys.writeUInt32BE(11811, 4);
  phys[8] = 1;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('sRGB', srgb),
    chunk('pHYs', phys),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Sebuah strip photobooth bentuknya tinggi (rasio tinggi/lebar sekitar 3:1)
export function isStripShaped(width, height) {
  const ratio = height / width;
  return ratio >= 2.4 && ratio <= 3.6;
}

export function detectImageOrientation(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 'portrait';
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (w > 0 && h > 0) return (!isStripShaped(w, h) && w > h) ? 'landscape' : 'portrait';
    }
    const decoded = decodeImage(buf);
    if (decoded && decoded.width > 0 && decoded.height > 0) {
      return (!isStripShaped(decoded.width, decoded.height) && decoded.width > decoded.height) ? 'landscape' : 'portrait';
    }
  } catch (e) {}
  return 'portrait';
}

/**
 * Susun 2 strip berdampingan pada satu lembar (lebar = 2x lebar strip).
 * Dengan strip 600x1800 hasilnya 1200x1800 = rasio kertas 4x6 persis.
 * Jika bukan PNG strip yang didukung, kembalikan buffer asli apa adanya.
 */
export function composeTwoUp(pngBuffer) {
  try {
    const img = decodePng(pngBuffer);
    if (!img || !isStripShaped(img.width, img.height)) return pngBuffer;

    const { width, height, channels, data } = img;
    const outW = width * 2;
    const outStride = outW * channels;
    const inStride = width * channels;
    const out = Buffer.alloc(outStride * height);
    for (let y = 0; y < height; y++) {
      const src = data.subarray(y * inStride, (y + 1) * inStride);
      src.copy(out, y * outStride);
      src.copy(out, y * outStride + inStride);
    }
    return encodePng({ width: outW, height, channels, data: out });
  } catch (e) {
    return pngBuffer;
  }
}

/**
 * Terapkan Auto Safe Margin dengan edge clamping (ekstensi warna tepi).
 * Gambar utama diskalakan (mis. 90%) ke tengah kanvas lembar cetak 300 DPI.
 * Pembagian vertikal 40% atas & 60% bawah mengimbangi toleransi roller keluar (trailing edge)
 * printer Epson di bagian bawah kertas sehingga kaki karakter & teks atas sama-sama aman.
 * Area pinggir (bleed zone) diisi dengan warna tepi asli gambar (clamp).
 */
export function applySafeMargin(img, targetW = 1200, targetH = 1800, scale = 0.90) {
  const { width: srcW, height: srcH, channels, data: srcData } = img;
  const clampedScale = Math.max(0.75, Math.min(1.0, scale));
  const maxInnerW = Math.round(targetW * clampedScale);
  const maxInnerH = Math.round(targetH * clampedScale);

  // Pertahankan rasio aspek asli foto agar tidak terdistorsi saat rasio kertas berbeda (mis. 4R dicetak di 5R)
  const srcAspect = srcW / Math.max(1, srcH);
  const boxAspect = maxInnerW / Math.max(1, maxInnerH);
  let innerW = maxInnerW;
  let innerH = maxInnerH;
  if (Math.abs(srcAspect - boxAspect) > 0.015) {
    if (srcAspect > boxAspect) {
      innerW = maxInnerW;
      innerH = Math.max(1, Math.round(maxInnerW / srcAspect));
    } else {
      innerH = maxInnerH;
      innerW = Math.max(1, Math.round(maxInnerH * srcAspect));
    }
  }

  const offX = Math.floor((targetW - innerW) / 2);
  const totalYPad = targetH - innerH;
  const offY = Math.floor(totalYPad * 0.40);
  const outData = Buffer.alloc(targetW * targetH * channels);

  for (let y = 0; y < targetH; y++) {
    const sy = y < offY ? 0 : (y >= offY + innerH ? srcH - 1 : ((y - offY) / innerH) * srcH);
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = sy - y0;
    const row0Offset = y0 * srcW * channels;
    const row1Offset = y1 * srcW * channels;
    const outRowOffset = y * targetW * channels;

    for (let x = 0; x < targetW; x++) {
      const sx = x < offX ? 0 : (x >= offX + innerW ? srcW - 1 : ((x - offX) / innerW) * srcW);
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = sx - x0;

      const x0Idx0 = row0Offset + x0 * channels;
      const x1Idx0 = row0Offset + x1 * channels;
      const x0Idx1 = row1Offset + x0 * channels;
      const x1Idx1 = row1Offset + x1 * channels;
      const outIdx = outRowOffset + x * channels;

      for (let c = 0; c < channels; c++) {
        const top = srcData[x0Idx0 + c] * (1 - wx) + srcData[x1Idx0 + c] * wx;
        const bot = srcData[x0Idx1 + c] * (1 - wx) + srcData[x1Idx1 + c] * wx;
        outData[outIdx + c] = ((top * (1 - wy) + bot * wy) + 0.5) | 0;
      }
    }
  }

  return { width: targetW, height: targetH, channels, data: outData };
}

// Cache in-memory logo Mafaza agar decoding hanya terjadi 1x
let cachedMafazaLogo = null;

export function getMafazaLogoImage() {
  if (cachedMafazaLogo) return cachedMafazaLogo;
  try {
    const candidates = [
      path.resolve(process.cwd(), 'public/assets/logo-mafaza.jpg'),
      new URL('../../public/assets/logo-mafaza.jpg', import.meta.url).pathname,
      path.resolve(process.cwd(), 'public/assets/icons/logo-mafaza.png')
    ];
    for (const logoPath of candidates) {
      if (fs.existsSync(logoPath)) {
        const buf = fs.readFileSync(logoPath);
        const decoded = decodeImage(buf);
        if (decoded && decoded.width && decoded.height) {
          cachedMafazaLogo = decoded;
          return cachedMafazaLogo;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to load Mafaza logo image:', err);
  }
  return null;
}

function isInsideRoundedBox(cx, cy, w, h, radius) {
  if (cx < radius && cy < radius) {
    const dx = radius - cx, dy = radius - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  if (cx >= w - radius && cy < radius) {
    const dx = cx - (w - radius - 1), dy = radius - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  if (cx < radius && cy >= h - radius) {
    const dx = radius - cx, dy = cy - (h - radius - 1);
    return dx * dx + dy * dy <= radius * radius;
  }
  if (cx >= w - radius && cy >= h - radius) {
    const dx = cx - (w - radius - 1), dy = cy - (h - radius - 1);
    return dx * dx + dy * dy <= radius * radius;
  }
  return true;
}

function stampSingleQrCard(outData, imgW, imgH, channels, qr, logoImg, startX, startY, targetSizePx) {
  const modCount = qr.modules.size;
  const marginMods = 1;
  const totalMods = modCount + marginMods * 2;
  const modulePx = Math.max(2, Math.floor((targetSizePx * 0.88) / totalMods));
  const qrInnerSize = totalMods * modulePx;
  const cardPad = Math.max(4, Math.round(modulePx * 1.8));
  const cardW = qrInnerSize + cardPad * 2;
  const cardH = qrInnerSize + cardPad * 2;

  const clampedX = Math.max(0, Math.min(imgW - cardW, Math.round(startX)));
  const clampedY = Math.max(0, Math.min(imgH - cardH, Math.round(startY)));

  // 1. Kartu putih lembut dengan sudut membulat
  const radius = Math.min(10, Math.round(cardPad * 1.2));
  for (let cy = 0; cy < cardH; cy++) {
    const py = clampedY + cy;
    if (py < 0 || py >= imgH) continue;
    for (let cx = 0; cx < cardW; cx++) {
      const px = clampedX + cx;
      if (px < 0 || px >= imgW || !isInsideRoundedBox(cx, cy, cardW, cardH, radius)) continue;
      const idx = (py * imgW + px) * channels;
      outData[idx + 0] = 255;
      outData[idx + 1] = 255;
      outData[idx + 2] = 255;
      if (channels === 4) outData[idx + 3] = 255;
    }
  }

  // 2. Modul hitam QR
  const qrOffsetX = clampedX + cardPad;
  const qrOffsetY = clampedY + cardPad;
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (qr.modules.get(r, c) === 1) {
        const modX0 = qrOffsetX + (c + marginMods) * modulePx;
        const modY0 = qrOffsetY + (r + marginMods) * modulePx;
        for (let my = 0; my < modulePx; my++) {
          const py = modY0 + my;
          if (py < 0 || py >= imgH) continue;
          for (let mx = 0; mx < modulePx; mx++) {
            const px = modX0 + mx;
            if (px < 0 || px >= imgW) continue;
            const idx = (py * imgW + px) * channels;
            outData[idx + 0] = 0;
            outData[idx + 1] = 0;
            outData[idx + 2] = 0;
            if (channels === 4) outData[idx + 3] = 255;
          }
        }
      }
    }
  }

  // 3. Logo Mafaza di tengah matriks QR
  if (logoImg) {
    const qrMatrixPx = modCount * modulePx;
    const qrStartX = qrOffsetX + marginMods * modulePx;
    const qrStartY = qrOffsetY + marginMods * modulePx;

    const logoBoxSize = Math.round(qrMatrixPx * 0.22);
    const logoX = qrStartX + Math.floor((qrMatrixPx - logoBoxSize) / 2);
    const logoY = qrStartY + Math.floor((qrMatrixPx - logoBoxSize) / 2);

    const badgePad = Math.max(3, Math.round(modulePx * 1.2));
    const badgeX = logoX - badgePad;
    const badgeY = logoY - badgePad;
    const badgeW = logoBoxSize + badgePad * 2;
    const badgeH = logoBoxSize + badgePad * 2;
    const bRadius = Math.min(8, Math.round(badgeW * 0.18));

    for (let cy = 0; cy < badgeH; cy++) {
      const py = badgeY + cy;
      if (py < 0 || py >= imgH) continue;
      for (let cx = 0; cx < badgeW; cx++) {
        const px = badgeX + cx;
        if (px < 0 || px >= imgW || !isInsideRoundedBox(cx, cy, badgeW, badgeH, bRadius)) continue;
        const idx = (py * imgW + px) * channels;
        outData[idx + 0] = 255;
        outData[idx + 1] = 255;
        outData[idx + 2] = 255;
        if (channels === 4) outData[idx + 3] = 255;
      }
    }

    const srcW = logoImg.width, srcH = logoImg.height;
    const lRadius = Math.max(2, bRadius - badgePad);
    for (let ly = 0; ly < logoBoxSize; ly++) {
      const py = logoY + ly;
      if (py < 0 || py >= imgH) continue;
      const sy = Math.floor((ly / logoBoxSize) * srcH);
      const srcRow = sy * srcW * 4;
      for (let lx = 0; lx < logoBoxSize; lx++) {
        const px = logoX + lx;
        if (px < 0 || px >= imgW || !isInsideRoundedBox(lx, ly, logoBoxSize, logoBoxSize, lRadius)) continue;
        const sx = Math.floor((lx / logoBoxSize) * srcW);
        const srcIdx = srcRow + sx * 4;
        const targetIdx = (py * imgW + px) * channels;
        outData[targetIdx + 0] = logoImg.data[srcIdx + 0];
        outData[targetIdx + 1] = logoImg.data[srcIdx + 1];
        outData[targetIdx + 2] = logoImg.data[srcIdx + 2];
        if (channels === 4) outData[targetIdx + 3] = 255;
      }
    }
  }
}

/**
 * Tempelkan 1 atau lebih QR Code Galeri Tamu khusus pada lembar cetak (printed sheet)
 * dengan logo Mafaza di tengahnya. File digital asli di gallery tetap bersih tanpa QR.
 * @param {object} img - Decoded image { width, height, channels, data }
 * @param {string} qrUrl - URL galeri tamu lengkap (https://.../gallery/g/:token)
 * @param {string|Array} positionOrList - 'bottom-right'|'bottom-left'|'top-right'|'top-left'|'dual-bottom-right'|'none' atau array [{x, y, size}]
 * @param {boolean} isStrip - Apakah gambar berbentuk strip photobooth
 * @param {object|null} tplSize - Dimensi referensi template { width, height } untuk penskalaan koordinat kustom
 */
export function overlayQrCodeOnImage(img, qrUrl, positionOrList = 'bottom-right', isStrip = false, tplSize = null) {
  if (!img || !qrUrl || positionOrList === 'none') return img;

  try {
    const qr = QRCode.create(qrUrl, { errorCorrectionLevel: 'H' });
    const outData = Buffer.from(img.data);
    const { width: imgW, height: imgH, channels } = img;
    const logoImg = getMafazaLogoImage();

    if (Array.isArray(positionOrList) && positionOrList.length > 0) {
      const refW = (tplSize && tplSize.width) || imgW;
      const refH = (tplSize && tplSize.height) || imgH;
      const sx = imgW / Math.max(1, refW);
      const sy = imgH / Math.max(1, refH);
      for (const item of positionOrList) {
        const sizePx = Math.max(60, Math.round((Number(item.size) || 150) * Math.min(sx, sy)));
        stampSingleQrCard(
          outData, imgW, imgH, channels, qr, logoImg,
          Math.round((Number(item.x) || 0) * sx),
          Math.round((Number(item.y) || 0) * sy),
          sizePx
        );
      }
      return { width: imgW, height: imgH, channels, data: outData };
    }

    const defaultSize = isStrip ? 148 : 195;
    const padX = isStrip ? 20 : 32;
    const padY = isStrip ? 20 : 32;

    if (positionOrList === 'dual-bottom-right') {
      const halfW = Math.round(imgW / 2);
      const qSize = Math.round(Math.min(imgW, imgH) * 0.125);
      stampSingleQrCard(outData, imgW, imgH, channels, qr, logoImg, halfW - qSize - padX, imgH - qSize - padY, qSize);
      stampSingleQrCard(outData, imgW, imgH, channels, qr, logoImg, imgW - qSize - padX, imgH - qSize - padY, qSize);
      return { width: imgW, height: imgH, channels, data: outData };
    }

    let startX = 0, startY = 0;
    switch (positionOrList) {
      case 'bottom-left':
        startX = padX;
        startY = imgH - defaultSize - padY;
        break;
      case 'top-right':
        startX = imgW - defaultSize - padX;
        startY = padY;
        break;
      case 'top-left':
        startX = padX;
        startY = padY;
        break;
      case 'bottom-right':
      default:
        startX = imgW - defaultSize - padX;
        startY = imgH - defaultSize - padY;
        break;
    }

    stampSingleQrCard(outData, imgW, imgH, channels, qr, logoImg, startX, startY, defaultSize);
    return { width: imgW, height: imgH, channels, data: outData };
  } catch (err) {
    console.warn('overlayQrCodeOnImage failed:', err);
    return img;
  }
}

/**
 * Hasilkan file lembar siap cetak sesuai opsi job.
 * 1) Jika strip 2x6: otomatis susun 2 strip berdampingan di kertas 4x6 (1200x1800).
 * 2) Terapkan Auto Safe Margin kustom pengguna dengan ekstensi warna tepi agar teks & objek
 *    di pinggir tidak terpotong oleh hardware bleed printer Epson.
 * 3) Stempel QR Galeri Tamu sesuai konfigurasi posisi template (kanan bawah, kiri bawah, dll).
 * File asli digital di /uploads tetap 100% utuh tanpa margin dan tanpa watermark QR.
 */
let lastPrintSheetCleanupAt = 0;

/**
 * Hapus file cache sheet sementara (mafaza_sheet_*.png) di /tmp yang lebih tua dari maxAgeMs
 * agar RAM/tmpfs atau disk VPS tidak menumpuk dari job cetak lama.
 */
export function cleanupOldPrintSheets(maxAgeMs = 3600 * 1000, force = false) {
  const now = Date.now();
  if (!force && now - lastPrintSheetCleanupAt < 10 * 60 * 1000) {
    return { removedCount: 0, scannedCount: 0, skipped: true };
  }
  lastPrintSheetCleanupAt = now;
  let removedCount = 0;
  let scannedCount = 0;
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    for (const name of files) {
      if (!/^mafaza_sheet_.*\.png$/i.test(name)) continue;
      scannedCount++;
      const fullPath = path.join(tmpDir, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.isFile() && now - st.mtimeMs >= maxAgeMs) {
          fs.unlinkSync(fullPath);
          removedCount++;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return { removedCount, scannedCount, skipped: false };
}

export function buildPrintSheetFile(srcPath, options = {}, cacheKey = 'sheet') {
  if (!srcPath || !/\.(png|jpe?g)$/i.test(srcPath) || !fs.existsSync(srcPath)) return srcPath;
  cleanupOldPrintSheets();

  const paper = resolvePaper(options.paperSize);
  const is4x6Paper = Math.round(paper.widthIn) === 4 && Math.round(paper.heightIn) === 6;

  try {
    const buf = fs.readFileSync(srcPath);
    const img = decodeImage(buf);
    if (!img) return srcPath;

    const isStrip = isStripShaped(img.width, img.height);
    const shouldTwoUp = isStrip && (paper.layout === '2up' || is4x6Paper);

    let targetW = Math.round((paper.widthIn || 4) * 300);
    let targetH = Math.round((paper.heightIn || 6) * 300);
    const isLandscapeImg = !isStrip && img.width > img.height;
    if (isLandscapeImg && targetW < targetH) {
      const tmp = targetW;
      targetW = targetH;
      targetH = tmp;
    }
    const isBorderless = options.borderless !== false;

    // Skala margin kustom dari pengaturan printer (default 90%)
    const rawMargin = typeof options.safeMargin === 'number' ? options.safeMargin : parseInt(options.safeMargin, 10);
    const scale = (Number.isFinite(rawMargin) && rawMargin >= 75 && rawMargin <= 100)
      ? rawMargin / 100
      : 0.90;

    const marginKey = Math.round(scale * 100);
    const hasCustomQr = Array.isArray(options.qrCoords) && options.qrCoords.length > 0;
    const qrEnabled = hasCustomQr || (options.qrPosition && options.qrPosition !== 'none');
    const qrPayloadSpec = hasCustomQr ? options.qrCoords : options.qrPosition;
    const qrSpecHash = hasCustomQr
      ? crypto.createHash('md5').update(JSON.stringify(options.qrCoords)).digest('hex').slice(0, 6)
      : (options.qrPosition || 'bottom-right');
    const qrKey = qrEnabled && options.qrUrl
      ? `_qr_${qrSpecHash}_${crypto.createHash('md5').update(options.qrUrl).digest('hex').slice(0, 8)}`
      : '';
    const orientKey = isLandscapeImg ? '_ls' : '';
    const outPath = path.join(os.tmpdir(), `mafaza_sheet_${cacheKey}_m${marginKey}${orientKey}${qrKey}.png`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= fs.statSync(srcPath).mtimeMs) {
      return outPath;
    }

    let baseImg = img;

    // Stempel 1 atau 2 QR code jika dikonfigurasi (ditempelkan pada tiap strip sebelum disusun 2up agar kedua strip ada QR-nya)
    if (options.qrUrl && qrEnabled) {
      const tplSize = (options.qrTemplateWidth && options.qrTemplateHeight)
        ? { width: options.qrTemplateWidth, height: options.qrTemplateHeight }
        : null;
      baseImg = overlayQrCodeOnImage(baseImg, options.qrUrl, qrPayloadSpec, isStrip, tplSize);
    }

    // Jika format photo strip: susun 2 strip berdampingan terlebih dahulu
    if (shouldTwoUp) {
      const { width, height, channels, data } = baseImg;
      const outW = width * 2;
      const outStride = outW * channels;
      const inStride = width * channels;
      const out = Buffer.alloc(outStride * height);
      for (let y = 0; y < height; y++) {
        const src = data.subarray(y * inStride, (y + 1) * inStride);
        src.copy(out, y * outStride);
        src.copy(out, y * outStride + inStride);
      }
      baseImg = { width: outW, height, channels, data: out };
    }

    // Terapkan Auto Safe Margin dengan edge-clamping agar teks & objek di tepi tidak terpotong hardware bleed printer
    let finalImg = baseImg;
    if (isBorderless) {
      if (scale >= 0.999 && baseImg.width === targetW && baseImg.height === targetH) {
        finalImg = baseImg;
      } else {
        finalImg = applySafeMargin(baseImg, targetW, targetH, scale);
      }
    } else if (baseImg.width !== targetW || baseImg.height !== targetH) {
      finalImg = applySafeMargin(baseImg, targetW, targetH, 1.0);
    }

    const composed = encodePng(finalImg);
    if (img) img.data = null;
    baseImg = null;
    finalImg = null;
    fs.writeFileSync(outPath, composed);
    return outPath;
  } catch (e) {
    console.warn('buildPrintSheetFile error:', e);
    return srcPath;
  }
}
