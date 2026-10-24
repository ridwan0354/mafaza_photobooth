import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/**
 * Hasilkan file lembar siap cetak sesuai opsi job.
 * 1) Jika strip 2x6: otomatis susun 2 strip berdampingan di kertas 4x6 (1200x1800).
 * 2) Terapkan Auto Safe Margin kustom pengguna dengan ekstensi warna tepi agar teks & objek
 *    di pinggir tidak terpotong oleh hardware bleed printer Epson.
 * File asli digital di /uploads tetap 100% utuh tanpa margin.
 */
export function buildPrintSheetFile(srcPath, options = {}, cacheKey = 'sheet') {
  if (!srcPath || !/\.png$/i.test(srcPath) || !fs.existsSync(srcPath)) return srcPath;

  const paper = resolvePaper(options.paperSize);
  const is4x6Paper = Math.round(paper.widthIn) === 4 && Math.round(paper.heightIn) === 6;

  try {
    const buf = fs.readFileSync(srcPath);
    const img = decodePng(buf);
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
    const outPath = path.join(os.tmpdir(), `mafaza_sheet_${cacheKey}_m${marginKey}.png`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= fs.statSync(srcPath).mtimeMs) {
      return outPath;
    }

    let baseImg = img;

    // Jika format photo strip: susun 2 strip berdampingan terlebih dahulu
    if (shouldTwoUp) {
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
