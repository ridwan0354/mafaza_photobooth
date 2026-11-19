import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, db } from '../src/db/database.js';
import * as templateService from '../src/services/template.js';

initDatabase();

test('Mingle templates filter cleanly between kiosk, mingle, and both booth modes', () => {
  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';

  const mingleTpl = templateService.createTemplate(tenantId, {
    name: 'Mingle Test 1x Only',
    eventId,
    boothMode: 'mingle',
    orientation: 'portrait'
  });
  const kioskTpl = templateService.createTemplate(tenantId, {
    name: 'Kiosk Test Only',
    eventId,
    boothMode: 'kiosk',
    orientation: 'strip'
  });
  const bothTpl = templateService.createTemplate(tenantId, {
    name: 'Shared Kiosk + Mingle Test',
    eventId,
    boothMode: 'both',
    orientation: 'portrait'
  });

  try {
    assert.equal(mingleTpl.booth_mode, 'mingle');
    assert.equal(mingleTpl.shots_mode, '1');
    assert.equal(kioskTpl.booth_mode, 'kiosk');
    assert.equal(bothTpl.booth_mode, 'both');

    const mingleList = templateService.getTemplates(tenantId, eventId, 'include_global', 'mingle');
    assert.ok(mingleList.some(t => t.id === mingleTpl.id), 'mingle booth query includes mingle templates');
    assert.ok(mingleList.some(t => t.id === bothTpl.id), 'mingle booth query includes shared templates');
    assert.ok(!mingleList.some(t => t.id === kioskTpl.id), 'mingle booth query excludes kiosk-only templates');

    const kioskList = templateService.getTemplates(tenantId, eventId, 'include_global', 'kiosk');
    assert.ok(kioskList.some(t => t.id === kioskTpl.id), 'kiosk booth query includes kiosk templates');
    assert.ok(kioskList.some(t => t.id === bothTpl.id), 'kiosk booth query includes shared templates');
    assert.ok(!kioskList.some(t => t.id === mingleTpl.id), 'kiosk booth query excludes mingle-only templates');
  } finally {
    db.prepare('DELETE FROM templates WHERE id IN (?, ?, ?)').run(mingleTpl.id, kioskTpl.id, bothTpl.id);
  }
});

test('Mingle page assets and Express /mingle route are wired', () => {
  const root = process.cwd();
  const serverSrc = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  const mingleHtml = fs.readFileSync(path.join(root, 'public/mingle.html'), 'utf8');
  const mingleJs = fs.readFileSync(path.join(root, 'public/js/mingle.js'), 'utf8');

  assert.match(serverSrc, /app\.get\('\/mingle'/);
  assert.match(mingleHtml, /screenMingleSelect/);
  assert.match(mingleHtml, /screenMingleReady/);
  assert.match(mingleHtml, /screenMingleResult/);
  assert.match(mingleJs, /mafaza:physical-shutter/);
  assert.match(mingleJs, /booth=mingle/);
});

test('Templates support 4R & 5R Portrait and Landscape presets and print sheet preserves landscape orientation', async () => {
  const sheet = await import('../src/services/sheet.js');
  const os = await import('node:os');
  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';

  const tpl4RLand = templateService.createTemplate(tenantId, {
    name: '4R Lanskap Test',
    eventId,
    boothMode: 'mingle',
    formatPreset: 'landscape'
  });
  const tpl5RPort = templateService.createTemplate(tenantId, {
    name: '5R Potret Test',
    eventId,
    boothMode: 'both',
    formatPreset: 'portrait_5r'
  });
  const tpl5RLand = templateService.createTemplate(tenantId, {
    name: '5R Lanskap Test',
    eventId,
    boothMode: 'kiosk',
    formatPreset: 'landscape_5r'
  });

  try {
    assert.equal(tpl4RLand.orientation, 'landscape');
    assert.equal(tpl4RLand.paper_size, '4R');
    assert.equal(tpl4RLand.width, 1800);
    assert.equal(tpl4RLand.height, 1200);

    assert.equal(tpl5RPort.orientation, 'portrait');
    assert.equal(tpl5RPort.paper_size, '5R');
    assert.equal(tpl5RPort.width, 1500);
    assert.equal(tpl5RPort.height, 2100);

    assert.equal(tpl5RLand.orientation, 'landscape');
    assert.equal(tpl5RLand.paper_size, '5R');
    assert.equal(tpl5RLand.width, 2100);
    assert.equal(tpl5RLand.height, 1500);

    const pngBuf = sheet.encodePng({
      width: 180,
      height: 120,
      channels: 4,
      data: Buffer.alloc(180 * 120 * 4, 200)
    });
    const tmpIn = path.join(os.default.tmpdir(), `test_land_4r_${Date.now()}.png`);
    fs.writeFileSync(tmpIn, pngBuf);
    const sheetOut = sheet.buildPrintSheetFile(tmpIn, { paperSize: '5R', safeMargin: 90, borderless: true }, `test_land_${Date.now()}`);
    const decodedOut = sheet.decodePng(fs.readFileSync(sheetOut));
    assert.equal(decodedOut.width, 2100);
    assert.equal(decodedOut.height, 1500);
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    try { fs.unlinkSync(sheetOut); } catch (e) {}
  } finally {
    db.prepare('DELETE FROM templates WHERE id IN (?, ?, ?)').run(tpl4RLand.id, tpl5RPort.id, tpl5RLand.id);
  }
});

test('Dual draggable QR print coordinates work for 4R/5R Landscape 2-Up split templates', async () => {
  const sheet = await import('../src/services/sheet.js');
  const os = await import('node:os');
  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';

  const qrCoords = [
    { id: 'qr_1', x: 680, y: 970, size: 135 },
    { id: 'qr_2', x: 1580, y: 970, size: 135 }
  ];
  const tpl = templateService.createTemplate(tenantId, {
    name: 'Dual QR 2-Up Test',
    eventId,
    boothMode: 'both',
    formatPreset: 'landscape',
    qrPosition: 'bottom-right',
    qrCoords
  });

  try {
    assert.equal(tpl.qr_coords.length, 2);
    assert.equal(tpl.qr_coords[0].x, 680);
    assert.equal(tpl.qr_coords[1].x, 1580);

    const updated = templateService.updateTemplateSlots(
      tpl.id, tenantId, [], null, 'bottom-right', 1800, 1200, '1', 'both', 'landscape', '4R',
      [{ id: 'qr_1', x: 700, y: 980, size: 145 }, { id: 'qr_2', x: 1600, y: 980, size: 145 }]
    );
    assert.equal(updated.qr_coords.length, 2);
    assert.equal(updated.qr_coords[0].size, 145);

    const pngBuf = sheet.encodePng({
      width: 1800,
      height: 1200,
      channels: 4,
      data: Buffer.alloc(1800 * 1200 * 4, 235)
    });
    const tmpIn = path.join(os.default.tmpdir(), `test_dual_qr_${Date.now()}.png`);
    fs.writeFileSync(tmpIn, pngBuf);
    const outPath = sheet.buildPrintSheetFile(tmpIn, {
      paperSize: '4R',
      safeMargin: 90,
      borderless: true,
      qrUrl: 'https://mafaza.galipatsistem.com/gallery/g/TESTDUALQR',
      qrPosition: 'bottom-right',
      qrCoords: updated.qr_coords,
      qrTemplateWidth: 1800,
      qrTemplateHeight: 1200
    }, `test_dual_${Date.now()}`);

    const decoded = sheet.decodePng(fs.readFileSync(outPath));
    assert.equal(decoded.width, 1800);
    assert.equal(decoded.height, 1200);
    // Verify SVG 2-Up polaroid assets exist
    const svg4R = fs.readFileSync(path.join(process.cwd(), 'public/assets/templates/polaroid-marble-2up-4r-landscape.svg'), 'utf8');
    const svg5R = fs.readFileSync(path.join(process.cwd(), 'public/assets/templates/polaroid-marble-2up-5r-landscape.svg'), 'utf8');
    assert.match(svg4R, /viewBox="0 0 1800 1200"/);
    assert.match(svg5R, /viewBox="0 0 2100 1500"/);

    try { fs.unlinkSync(tmpIn); } catch (e) {}
    try { fs.unlinkSync(outPath); } catch (e) {}
  } finally {
    db.prepare('DELETE FROM templates WHERE id = ?').run(tpl.id);
  }
});

test('Mingle supports unlimited / multi-shot digital-files mode and numeric pose_10+ ordering', async () => {
  const qrService = await import('../src/services/qr.js');
  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';

  const tpl = templateService.createTemplate(tenantId, {
    name: 'Mingle Multi Unlimited Test',
    eventId,
    boothMode: 'mingle',
    shotsMode: 'unlimited',
    formatPreset: 'landscape'
  });

  const pass = await qrService.createGuestPass(tenantId, eventId, 'booth');
  const sessId = 'sess_mingle_files_' + Date.now();
  try {
    assert.equal(tpl.shots_mode, 'unlimited');
    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, mode, status, started_at)
      VALUES (?, ?, ?, ?, 'files_only', 'completed', datetime('now'))
    `).run(sessId, tenantId, eventId, pass.id);

    for (let i = 1; i <= 11; i++) {
      db.prepare(`
        INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, status)
        VALUES (?, ?, ?, ?, 'raw_capture', ?, ?, 'ready')
      `).run(`asset_m_${sessId}_${i}`, tenantId, eventId, sessId, `pose_${i}`, `/uploads/f_${i}.jpg`);
    }

    const gallery = qrService.getGuestGalleryData(pass.token);
    const rawVars = gallery.sessions[0].media.filter(m => m.type === 'raw_capture').map(m => m.variant);
    assert.equal(rawVars.length, 11);
    assert.equal(rawVars[0], 'pose_1');
    assert.equal(rawVars[9], 'pose_10');
    assert.equal(rawVars[10], 'pose_11');

    const root = process.cwd();
    const mingleHtml = fs.readFileSync(path.join(root, 'public/mingle.html'), 'utf8');
    const mingleJs = fs.readFileSync(path.join(root, 'public/js/mingle.js'), 'utf8');
    const kioskJs = fs.readFileSync(path.join(root, 'public/js/kiosk.js'), 'utf8');
    const kioskHtml = fs.readFileSync(path.join(root, 'public/kiosk.html'), 'utf8');
    assert.match(mingleHtml, /startFilesOnlyMode/);
    assert.match(mingleHtml, /addMorePhotos/);
    assert.match(mingleHtml, /btnMingleRotate/);
    assert.match(kioskHtml, /btnCycleCamRotate/);
    assert.match(kioskHtml, /btnRotate90/);
    assert.match(mingleJs, /captureStartIndex/);
    assert.match(mingleJs, /finishCaptureSession/);
    assert.match(mingleJs, /this\.canonLiveViewInMingle = true/);
    assert.match(mingleJs, /MafazaAndroidBridge\.getLiveViewFrame/);
    assert.match(mingleJs, /rotateDataUrlIfNeeded/);
    assert.match(kioskJs, /setCameraRotation/);
    assert.match(kioskJs, /applyRotationToCapturedPose/);
    assert.match(mingleJs, /Math\.max\(0, \(drawW - clipW\) \/ 2\)/);
    assert.match(kioskJs, /Math\.max\(0, \(drawW - clipW\) \/ 2\)/);
    assert.match(kioskJs, /fitsNaturalImage/);
    assert.match(kioskJs, /e\.pointerType === 'touch'/);
    assert.doesNotMatch(kioskJs, /clipW \* 0\.35/);
    assert.doesNotMatch(mingleJs, /clipW \* 0\.35/);
    assert.match(mingleHtml, /mingle-top-live/);
    assert.match(mingleHtml, /mingleChangeFrameModal/);
    assert.match(mingleHtml, /mingleQrZoomModal/);
    assert.match(mingleJs, /fullscreen/);
    assert.match(mingleJs, /slotTransforms/);
    assert.match(mingleJs, /findResultSlotAt/);
    assert.match(mingleJs, /openChangeFrameModal/);
    assert.match(mingleJs, /openQrZoomModal/);
    assert.match(kioskHtml, /kioskQrZoomModal/);
    assert.match(kioskJs, /openQrZoomModal/);
  } finally {
    db.prepare('DELETE FROM media_assets WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
    db.prepare('DELETE FROM guest_passes WHERE id = ?').run(pass.id);
    db.prepare('DELETE FROM templates WHERE id = ?').run(tpl.id);
  }
});
