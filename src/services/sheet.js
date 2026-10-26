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
  '5x7': { widthIn: 5, heightIn: 7, layout: 'single', label: 'Kertas 5×7' },
  '6x8': { widthIn: 6, heightIn: 8, layout: 'single', label: 'Kertas 6×8' },
  'A4': { widthIn: 8.27, heightIn: 11.69, layout: 'single', label: 'Kertas A4' }
};

export function resolvePaper(paperSize) {
  return PAPER_PRESETS[paperSize] || PAPER_PRESETS['2x6'];
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
      const decoded = jpeg.decode(buf, { useTArray: true });
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

  // 300 DPI standard print metadata (11811 pixels per meter)
  // Memastikan macOS Preview, Windows & driver printer membaca ukuran fisik tepat 4x6 in (102x152 mm) tanpa terpotong
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(11811, 0);
  phys.writeUInt32BE(11811, 4);
  phys[8] = 1;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
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
  const innerW = Math.round(targetW * clampedScale);
  const innerH = Math.round(targetH * clampedScale);
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

/**
 * Tempelkan QR Code Galeri Tamu khusus pada lembar cetak (printed sheet) dengan logo Mafaza di tengahnya.
 * File digital asli di gallery tetap bersih tanpa watermark QR.
 * @param {object} img - Decoded image { width, height, channels, data }
 * @param {string} qrUrl - URL galeri tamu lengkap (https://.../gallery/g/:token)
 * @param {string} position - 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'none'
 * @param {boolean} isStrip - Apakah gambar berbentuk strip photobooth
 */
export function overlayQrCodeOnImage(img, qrUrl, position = 'bottom-right', isStrip = false) {
  if (!img || !qrUrl || position === 'none') return img;

  try {
    // Error correction H (High 30% tolerance) memastikan QR tetap terbaca cepat dengan logo di tengahnya
    const qr = QRCode.create(qrUrl, { errorCorrectionLevel: 'H' });
    const modCount = qr.modules.size;
    const marginMods = 1; // 1 modul quiet zone di sekitar matriks
    const totalMods = modCount + marginMods * 2;

    // Ukuran target: ~130-140px untuk photo strip (lebar 600px), ~170-190px untuk single photo (lebar 1200px)
    const modulePx = isStrip
      ? Math.max(2, Math.floor(130 / totalMods))
      : Math.max(3, Math.floor(175 / totalMods));

    const qrInnerSize = totalMods * modulePx;
    // Padding kartu putih di sekeliling QR
    const cardPad = Math.max(5, Math.round(modulePx * 1.8));
    const cardW = qrInnerSize + cardPad * 2;
    const cardH = qrInnerSize + cardPad * 2;

    const padX = isStrip ? 20 : 32;
    const padY = isStrip ? 20 : 32;

    let startX = 0;
    let startY = 0;

    switch (position) {
      case 'bottom-left':
        startX = padX;
        startY = img.height - cardH - padY;
        break;
      case 'top-right':
        startX = img.width - cardW - padX;
        startY = padY;
        break;
      case 'top-left':
        startX = padX;
        startY = padY;
        break;
      case 'bottom-right':
      default:
        startX = img.width - cardW - padX;
        startY = img.height - cardH - padY;
        break;
    }

    startX = Math.max(0, Math.min(img.width - cardW, startX));
    startY = Math.max(0, Math.min(img.height - cardH, startY));

    // Salin buffer agar data gambar asli tidak termodifikasi
    const outData = Buffer.from(img.data);
    const { width: imgW, height: imgH, channels } = img;

    // 1. Gambar kartu putih bersih dengan sudut melengkung lembut
    const radius = Math.min(10, Math.round(cardPad * 1.2));
    for (let cy = 0; cy < cardH; cy++) {
      const py = startY + cy;
      if (py < 0 || py >= imgH) continue;
      for (let cx = 0; cx < cardW; cx++) {
        const px = startX + cx;
        if (px < 0 || px >= imgW) continue;

        let isCorner = false;
        if (cx < radius && cy < radius) {
          const dx = radius - cx, dy = radius - cy;
          if (dx * dx + dy * dy > radius * radius) isCorner = true;
        } else if (cx >= cardW - radius && cy < radius) {
          const dx = cx - (cardW - radius - 1), dy = radius - cy;
          if (dx * dx + dy * dy > radius * radius) isCorner = true;
        } else if (cx < radius && cy >= cardH - radius) {
          const dx = radius - cx, dy = cy - (cardH - radius - 1);
          if (dx * dx + dy * dy > radius * radius) isCorner = true;
        } else if (cx >= cardW - radius && cy >= cardH - radius) {
          const dx = cx - (cardW - radius - 1), dy = cy - (cardH - radius - 1);
          if (dx * dx + dy * dy > radius * radius) isCorner = true;
        }
        if (isCorner) continue;

        const idx = (py * imgW + px) * channels;
        outData[idx + 0] = 255;
        outData[idx + 1] = 255;
        outData[idx + 2] = 255;
        if (channels === 4) outData[idx + 3] = 255;
      }
    }

    // 2. Gambar modul hitam QR
    const qrOffsetX = startX + cardPad;
    const qrOffsetY = startY + cardPad;

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

    // 3. Gambar logo Mafaza di tengah-tengah matriks QR
    const logoImg = getMafazaLogoImage();
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

      // Kartu badge putih di sekeliling logo agar modul QR tidak bertabrakan dengan logo
      for (let cy = 0; cy < badgeH; cy++) {
        const py = badgeY + cy;
        if (py < 0 || py >= imgH) continue;
        for (let cx = 0; cx < badgeW; cx++) {
          const px = badgeX + cx;
          if (px < 0 || px >= imgW) continue;

          let isCorner = false;
          if (cx < bRadius && cy < bRadius) {
            const dx = bRadius - cx, dy = bRadius - cy;
            if (dx * dx + dy * dy > bRadius * bRadius) isCorner = true;
          } else if (cx >= badgeW - bRadius && cy < bRadius) {
            const dx = cx - (badgeW - bRadius - 1), dy = bRadius - cy;
            if (dx * dx + dy * dy > bRadius * bRadius) isCorner = true;
          } else if (cx < bRadius && cy >= badgeH - bRadius) {
            const dx = bRadius - cx, dy = cy - (badgeH - bRadius - 1);
            if (dx * dx + dy * dy > bRadius * bRadius) isCorner = true;
          } else if (cx >= badgeW - bRadius && cy >= badgeH - bRadius) {
            const dx = cx - (badgeW - bRadius - 1), dy = cy - (badgeH - bRadius - 1);
            if (dx * dx + dy * dy > bRadius * bRadius) isCorner = true;
          }
          if (isCorner) continue;

          const idx = (py * imgW + px) * channels;
          outData[idx + 0] = 255;
          outData[idx + 1] = 255;
          outData[idx + 2] = 255;
          if (channels === 4) outData[idx + 3] = 255;
        }
      }

      // Stamp logo Mafaza di dalam [logoX, logoY, logoBoxSize, logoBoxSize]
      const srcW = logoImg.width, srcH = logoImg.height;
      const lRadius = Math.max(2, bRadius - badgePad);

      for (let ly = 0; ly < logoBoxSize; ly++) {
        const py = logoY + ly;
        if (py < 0 || py >= imgH) continue;
        const sy = Math.floor((ly / logoBoxSize) * srcH);
        const srcRow = sy * srcW * 4;

        for (let lx = 0; lx < logoBoxSize; lx++) {
          const px = logoX + lx;
          if (px < 0 || px >= imgW) continue;

          let isCorner = false;
          if (lx < lRadius && ly < lRadius) {
            const dx = lRadius - lx, dy = lRadius - ly;
            if (dx * dx + dy * dy > lRadius * lRadius) isCorner = true;
          } else if (lx >= logoBoxSize - lRadius && ly < lRadius) {
            const dx = lx - (logoBoxSize - lRadius - 1), dy = lRadius - ly;
            if (dx * dx + dy * dy > lRadius * lRadius) isCorner = true;
          } else if (lx < lRadius && ly >= logoBoxSize - lRadius) {
            const dx = lRadius - lx, dy = ly - (logoBoxSize - lRadius - 1);
            if (dx * dx + dy * dy > lRadius * lRadius) isCorner = true;
          } else if (lx >= logoBoxSize - lRadius && ly >= logoBoxSize - lRadius) {
            const dx = lx - (logoBoxSize - lRadius - 1), dy = ly - (logoBoxSize - lRadius - 1);
            if (dx * dx + dy * dy > lRadius * lRadius) isCorner = true;
          }
          if (isCorner) continue;

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
export function buildPrintSheetFile(srcPath, options = {}, cacheKey = 'sheet') {
  if (!srcPath || !/\.(png|jpe?g)$/i.test(srcPath) || !fs.existsSync(srcPath)) return srcPath;

  const paper = resolvePaper(options.paperSize);
  const is4x6Paper = Math.round(paper.widthIn) === 4 && Math.round(paper.heightIn) === 6;

  try {
    const buf = fs.readFileSync(srcPath);
    const img = decodeImage(buf);
    if (!img) return srcPath;

    const isStrip = isStripShaped(img.width, img.height);
    const shouldTwoUp = isStrip && (paper.layout === '2up' || is4x6Paper);

    const targetW = Math.round((paper.widthIn || 4) * 300);
    const targetH = Math.round((paper.heightIn || 6) * 300);
    const isBorderless = options.borderless !== false;

    // Skala margin kustom dari pengaturan printer (default 90%)
    const rawMargin = typeof options.safeMargin === 'number' ? options.safeMargin : parseInt(options.safeMargin, 10);
    const scale = (Number.isFinite(rawMargin) && rawMargin >= 75 && rawMargin <= 100)
      ? rawMargin / 100
      : 0.90;

    const marginKey = Math.round(scale * 100);
    const qrKey = options.qrPosition && options.qrPosition !== 'none' && options.qrUrl
      ? `_qr_${options.qrPosition}_${crypto.createHash('md5').update(options.qrUrl).digest('hex').slice(0, 8)}`
      : '';
    const outPath = path.join(os.tmpdir(), `mafaza_sheet_${cacheKey}_m${marginKey}${qrKey}.png`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= fs.statSync(srcPath).mtimeMs) {
      return outPath;
    }

    let baseImg = img;

    // Stempel QR code jika dikonfigurasi (ditempelkan pada tiap strip sebelum disusun 2up agar kedua strip ada QR-nya)
    if (options.qrUrl && options.qrPosition && options.qrPosition !== 'none') {
      baseImg = overlayQrCodeOnImage(baseImg, options.qrUrl, options.qrPosition, isStrip);
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
      finalImg = applySafeMargin(baseImg, targetW, targetH, scale);
    } else if (baseImg.width !== targetW || baseImg.height !== targetH) {
      finalImg = applySafeMargin(baseImg, targetW, targetH, 1.0);
    }

    const composed = encodePng(finalImg);
    fs.writeFileSync(outPath, composed);
    return outPath;
  } catch (e) {
    console.warn('buildPrintSheetFile error:', e);
    return srcPath;
  }
}
