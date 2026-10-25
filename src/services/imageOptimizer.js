import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { decodeImage } from './sheet.js';

/**
 * Optimasi dan kompresi file foto (foto dengan frame maupun foto tanpa frame)
 * Target ukuran: ~350KB - 600KB (dari asalnya 3MB+) dengan kualitas visual tetap prima dan tajam.
 * Mendukung input PNG dan JPEG, mereduksi ke JPEG Quality 88 (sweet spot 300 DPI print & download cepat).
 * 
 * @param {string} absFilePath Path absolut file di disk
 * @param {object} options { quality = 88, maxDimension = 1920 }
 * @returns {object} { path: string, size: number, wasCompressed: boolean }
 */
export function optimizePhotoFile(absFilePath, options = {}) {
  const quality = options.quality || 88;
  const maxDim = options.maxDimension || 1920;

  if (!absFilePath || !fs.existsSync(absFilePath)) return null;

  try {
    const stats = fs.statSync(absFilePath);
    // Jika file sudah kecil (< 500KB) dan sudah berupa JPEG, lewati kompresi ulang
    if (stats.size < 500 * 1024 && /\.jpe?g$/i.test(absFilePath)) {
      return { path: absFilePath, size: stats.size, wasCompressed: false };
    }

    const buf = fs.readFileSync(absFilePath);
    const img = decodeImage(buf);
    if (!img || !img.width || !img.height) {
      return { path: absFilePath, size: stats.size, wasCompressed: false };
    }

    let { width, height, channels, data } = img;

    // Rescale jika resolusi sangat besar (mis. foto kamera DSLR 24MP 6000x4000)
    let targetW = width;
    let targetH = height;
    if (width > maxDim || height > maxDim) {
      const ratio = Math.min(maxDim / width, maxDim / height);
      targetW = Math.round(width * ratio);
      targetH = Math.round(height * ratio);
    }

    let rgbaData;
    if (targetW !== width || targetH !== height) {
      rgbaData = Buffer.alloc(targetW * targetH * 4);
      for (let y = 0; y < targetH; y++) {
        const sy = Math.floor((y / targetH) * height);
        const rowSrc = sy * width * channels;
        const rowDst = y * targetW * 4;
        for (let x = 0; x < targetW; x++) {
          const sx = Math.floor((x / targetW) * width);
          const srcIdx = rowSrc + sx * channels;
          const dstIdx = rowDst + x * 4;

          const a = channels === 4 ? data[srcIdx + 3] : 255;
          if (a === 255) {
            rgbaData[dstIdx] = data[srcIdx];
            rgbaData[dstIdx + 1] = data[srcIdx + 1];
            rgbaData[dstIdx + 2] = data[srcIdx + 2];
          } else if (a === 0) {
            rgbaData[dstIdx] = 255;
            rgbaData[dstIdx + 1] = 255;
            rgbaData[dstIdx + 2] = 255;
          } else {
            const invA = 255 - a;
            rgbaData[dstIdx] = Math.round((data[srcIdx] * a + 255 * invA) / 255);
            rgbaData[dstIdx + 1] = Math.round((data[srcIdx + 1] * a + 255 * invA) / 255);
            rgbaData[dstIdx + 2] = Math.round((data[srcIdx + 2] * a + 255 * invA) / 255);
          }
          rgbaData[dstIdx + 3] = 255;
        }
      }
    } else if (channels === 4) {
      rgbaData = Buffer.alloc(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 255) {
          rgbaData[i] = data[i];
          rgbaData[i + 1] = data[i + 1];
          rgbaData[i + 2] = data[i + 2];
        } else if (a === 0) {
          rgbaData[i] = 255;
          rgbaData[i + 1] = 255;
          rgbaData[i + 2] = 255;
        } else {
          const invA = 255 - a;
          rgbaData[i] = Math.round((data[i] * a + 255 * invA) / 255);
          rgbaData[i + 1] = Math.round((data[i + 1] * a + 255 * invA) / 255);
          rgbaData[i + 2] = Math.round((data[i + 2] * a + 255 * invA) / 255);
        }
        rgbaData[i + 3] = 255;
      }
    } else if (channels === 3) {
      rgbaData = Buffer.alloc(width * height * 4);
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        rgbaData[j] = data[i];
        rgbaData[j + 1] = data[i + 1];
        rgbaData[j + 2] = data[i + 2];
        rgbaData[j + 3] = 255;
      }
    } else {
      rgbaData = data;
    }

    const encoded = jpeg.encode({
      width: targetW,
      height: targetH,
      data: rgbaData
    }, quality);

    let outPath = absFilePath;
    if (/\.png$/i.test(absFilePath)) {
      outPath = absFilePath.replace(/\.png$/i, '.jpg');
      fs.writeFileSync(outPath, encoded.data);
      try {
        fs.unlinkSync(absFilePath);
      } catch (e) {}
    } else {
      fs.writeFileSync(absFilePath, encoded.data);
    }

    const newSize = encoded.data.length;
    return { path: outPath, size: newSize, wasCompressed: true };
  } catch (err) {
    console.warn('optimizePhotoFile warning:', err.message);
    return { path: absFilePath, size: fs.statSync(absFilePath).size, wasCompressed: false };
  }
}
