import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Duplex } from 'node:stream';
import express from 'express';
import { appDownloadRouter } from '../src/routes/app-downloads.js';
import { getAndroidApkRelease, getAppDownloadInfo } from '../src/services/appBuilder.js';

test('Android download serves the exact released APK with a versioned filename and no cache', { timeout: 5000 }, async () => {
  const app = express();
  app.use(appDownloadRouter);
  // Exercise the real HTTP response and file stream without opening a network port.
  const chunks = [];
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  try {
    const release = getAndroidApkRelease();
    const req = new http.IncomingMessage(socket);
    req.method = 'GET';
    req.url = release.downloadUrl;
    req.headers = { host: 'localhost' };
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    await new Promise((resolve, reject) => {
      res.once('finish', resolve);
      res.once('error', reject);
      app(req, res, reject);
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('content-type'), 'application/vnd.android.package-archive');
    assert.match(res.getHeader('cache-control'), /no-store/);
    assert.ok(res.getHeader('content-disposition').includes(release.filename));
    const wire = Buffer.concat(chunks);
    const apk = wire.subarray(wire.indexOf('\r\n\r\n') + 4);
    assert.equal(apk.length, release.sizeBytes);
    assert.equal(crypto.createHash('sha256').update(apk).digest('hex'), release.sha256);
    assert.equal(apk.readUInt32LE(0), 0x04034b50, 'download is an APK archive, not a page');
  } finally {
    socket.destroy();
  }
});

test('Admin download info targets the APK on the selected server', async () => {
  const info = await getAppDownloadInfo('localhost:3000', 'https://mafaza.galipatsistem.com');
  const release = getAndroidApkRelease();
  assert.equal(info.androidApk.version, '2.5.1');
  assert.equal(info.downloads.androidApk, release.downloadUrl);
  assert.equal(info.androidApkUrl, `https://mafaza.galipatsistem.com${release.downloadUrl}`);
  assert.ok(info.androidQrDataUrl.startsWith('data:image/png;base64,'));
  assert.ok(info.androidKioskUrl.endsWith('/kiosk?app=android&fullscreen=1'));
});
