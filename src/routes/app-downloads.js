import express from 'express';
import { fileURLToPath } from 'node:url';
import { getAndroidApkRelease } from '../services/appBuilder.js';

export const appDownloadRouter = express.Router();
const apkPath = fileURLToPath(new URL('../../public/Mafaza-Photobooth-Kiosk.apk', import.meta.url));

appDownloadRouter.get('/Mafaza-Photobooth-Kiosk.apk', (req, res, next) => {
  try {
    const release = getAndroidApkRelease();
    res.download(apkPath, release.filename, {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }, error => { if (error) next(error); });
  } catch (error) {
    next(error);
  }
});
