import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/database.js';
import { optimizePhotoFile } from '../services/imageOptimizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicUploads = path.join(__dirname, '../../public/uploads');

console.log('🚀 Memulai kompresi foto existing di database & folder uploads...');
console.log(`📁 Lokasi folder uploads: ${publicUploads}`);

const assets = db.prepare(`
  SELECT id, type, variant, file_path, size_bytes 
  FROM media_assets 
  WHERE type IN ('final_photo', 'raw_capture')
`).all();

let totalOriginalBytes = 0;
let totalCompressedBytes = 0;
let optimizedCount = 0;

for (const asset of assets) {
  if (!asset.file_path) continue;
  const filename = path.basename(asset.file_path);
  const fullPath = path.join(publicUploads, filename);

  if (!fs.existsSync(fullPath)) continue;

  const originalSize = fs.statSync(fullPath).size;
  totalOriginalBytes += originalSize;

  // Optimasi ke kualitas 88%
  const res = optimizePhotoFile(fullPath, { quality: 88, maxDimension: 1920 });
  if (res && res.wasCompressed) {
    const newFilename = path.basename(res.path);
    const newUrl = `/uploads/${newFilename}`;
    totalCompressedBytes += res.size;
    optimizedCount++;

    // Update database jika file berubah
    db.prepare(`
      UPDATE media_assets 
      SET file_path = ?, size_bytes = ?
      WHERE id = ?
    `).run(newUrl, res.size, asset.id);

    console.log(`✅ [${asset.type}] ${filename} -> ${newFilename} (${(originalSize / 1024).toFixed(0)}KB -> ${(res.size / 1024).toFixed(0)}KB)`);
  } else {
    totalCompressedBytes += originalSize;
  }
}

const savedMB = ((totalOriginalBytes - totalCompressedBytes) / (1024 * 1024)).toFixed(2);
console.log('--------------------------------------------------');
console.log(`🎉 Selesai! Berhasil mengompres ${optimizedCount} foto.`);
console.log(`💾 Ruang penyimpanan dihemat: ${savedMB} MB.`);
console.log('--------------------------------------------------');
