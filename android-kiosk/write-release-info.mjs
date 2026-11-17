import fs from 'node:fs';
import crypto from 'node:crypto';

const manifest = fs.readFileSync(new URL('./AndroidManifest.xml', import.meta.url), 'utf8');
const version = manifest.match(/android:versionName="([^"]+)"/)[1];
const versionCode = Number(manifest.match(/android:versionCode="(\d+)"/)[1]);
const apk = fs.readFileSync(new URL('../public/Mafaza-Photobooth-Kiosk.apk', import.meta.url));
const release = {
  version,
  versionCode,
  filename: `Mafaza-Photobooth-Kiosk-v${version}.apk`,
  downloadUrl: `/Mafaza-Photobooth-Kiosk.apk?v=${encodeURIComponent(version)}`,
  sizeBytes: apk.length,
  sha256: crypto.createHash('sha256').update(apk).digest('hex'),
};
fs.writeFileSync(new URL('../public/android-kiosk-release.json', import.meta.url), JSON.stringify(release, null, 2) + '\n');
console.log(`Android download metadata updated: v${version}`);
