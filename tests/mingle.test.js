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
  assert.doesNotMatch(mingleJs, /scope=include_global/, 'mingle must only load templates belonging to the active event');
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
    assert.match(mingleJs, /Math\.abs\(drawW - clipW\) \/ 2/);
    assert.match(kioskJs, /Math\.abs\(drawW - clipW\) \/ 2/);
    assert.match(mingleJs, /Math\.max\(0\.35, Math\.min\(3\.5/);
    assert.match(kioskJs, /Math\.max\(0\.35, Math\.min\(3\.5/);
    assert.match(kioskJs, /fitsNaturalImage/);
    assert.match(kioskJs, /e\.pointerType === 'touch'/);
    assert.match(kioskJs, /clipW \* 0\.45/);
    assert.match(mingleJs, /clipW \* 0\.45/);
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

test('Print sheet & client print orientation match portrait vs landscape frames cleanly without borders', async () => {
  const sheet = await import('../src/services/sheet.js');
  const os = await import('node:os');
  const root = process.cwd();

  const tmpPort = path.join(os.default.tmpdir(), `test_port_${Date.now()}.png`);
  const tmpLand = path.join(os.default.tmpdir(), `test_land_${Date.now()}.png`);
  fs.writeFileSync(tmpPort, sheet.encodePng({
    width: 1200,
    height: 1800,
    channels: 4,
    data: Buffer.alloc(1200 * 1800 * 4, 210)
  }));
  fs.writeFileSync(tmpLand, sheet.encodePng({
    width: 1800,
    height: 1200,
    channels: 4,
    data: Buffer.alloc(1800 * 1200 * 4, 190)
  }));

  try {
    assert.equal(sheet.detectImageOrientation(tmpPort), 'portrait');
    assert.equal(sheet.detectImageOrientation(tmpLand), 'landscape');

    const sheetPort = sheet.buildPrintSheetFile(tmpPort, { paperSize: '4x6', safeMargin: 100, borderless: true }, `t_p_${Date.now()}`);
    const sheetLand = sheet.buildPrintSheetFile(tmpLand, { paperSize: '4x6', safeMargin: 100, borderless: true }, `t_l_${Date.now()}`);

    const decPort = sheet.decodePng(fs.readFileSync(sheetPort));
    const decLand = sheet.decodePng(fs.readFileSync(sheetLand));
    assert.equal(decPort.width, 1200);
    assert.equal(decPort.height, 1800);
    assert.equal(decLand.width, 1800);
    assert.equal(decLand.height, 1200);

    try { fs.unlinkSync(sheetPort); } catch (e) {}
    try { fs.unlinkSync(sheetLand); } catch (e) {}

    const printClientJs = fs.readFileSync(path.join(root, 'public/js/print-client.js'), 'utf8');
    const printServiceJs = fs.readFileSync(path.join(root, 'src/services/print.js'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'print-agent/mafaza-print-agent.mjs'), 'utf8');
    const mingleHtml = fs.readFileSync(path.join(root, 'public/mingle.html'), 'utf8');
    const mingleJs = fs.readFileSync(path.join(root, 'public/js/mingle.js'), 'utf8');

    assert.match(printClientJs, /resolvePageDimensions/);
    assert.match(printClientJs, /naturalWidth > naturalHeight/);
    assert.match(printServiceJs, /detectImageOrientation/);
    assert.match(printServiceJs, /orientation-requested=4/);
    assert.match(agentJs, /orientation-requested=4/);
    assert.match(agentJs, /DefaultPageSettings\.Landscape = \$true \} else \{ \$doc\.DefaultPageSettings\.Landscape = \$false \}/);
    assert.match(mingleHtml, /pbPrintPortal/);
    assert.match(mingleHtml, /print-client\.js/);
    assert.match(mingleJs, /pbPrintViaBrowser/);
  } finally {
    try { fs.unlinkSync(tmpPort); } catch (e) {}
    try { fs.unlinkSync(tmpLand); } catch (e) {}
  }
});

test('Server print queue dispatches 4R immediately and holds 5R for Admin paper confirmation', async () => {
  const printService = await import('../src/services/print.js');
  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';
  const sessId = 'sess_5r_confirm_' + Date.now();
  const assetId = 'asset_5r_' + Date.now();
  const root = process.cwd();

  db.prepare(`
    INSERT INTO photo_sessions (id, tenant_id, event_id, device_id, mode, status)
    VALUES (?, ?, ?, NULL, 'mingle', 'completed')
  `).run(sessId, tenantId, eventId);

  db.prepare(`
    INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, status)
    VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', '/uploads/test_print_nonexistent.png', 'ready')
  `).run(assetId, tenantId, eventId, sessId);

  try {
    // 1. 4R immediately queues for printing without paper confirmation
    const job4r = printService.createPrintJob(tenantId, eventId, null, sessId, assetId, 2, { paperSize: '4x6' });
    assert.equal(job4r.state, 'queued');
    assert.equal(job4r.requiresPaperConfirm, false);
    assert.equal(job4r.paperLabel, '4R');
    assert.equal(job4r.paperWidthIn, 4);
    assert.equal(job4r.paperHeightIn, 6);

    // 2. 5R (unconfirmed) waits in awaiting_paper state and is NOT claimed by agent yet
    const job5r = printService.createPrintJob(tenantId, eventId, null, sessId, assetId, 1, { paperSize: '5x7' });
    assert.equal(job5r.state, 'awaiting_paper');
    assert.equal(job5r.requiresPaperConfirm, true);
    assert.equal(job5r.paperLabel, '5R');
    assert.equal(job5r.paperWidthIn, 5);
    assert.equal(job5r.paperHeightIn, 7);

    const rowBefore = db.prepare('SELECT state FROM print_jobs WHERE id = ?').get(job5r.printJobId);
    assert.equal(rowBefore.state, 'awaiting_paper');

    // Confirming 5R paper moves job to queued for Print Agent / OS
    const confirmed = printService.confirmPrintJobPaper(job5r.printJobId, tenantId, 'user_operator_01');
    assert.equal(confirmed.success, true);
    assert.equal(confirmed.state, 'queued');
    const rowAfter = db.prepare('SELECT state FROM print_jobs WHERE id = ?').get(job5r.printJobId);
    assert.equal(rowAfter.state, 'queued');

    // 3. 5R pre-confirmed (1-laptop setup checkbox) queues directly
    const job5rPre = printService.createPrintJob(tenantId, eventId, null, sessId, assetId, 1, { paperSize: '5x7', paperConfirmed: true });
    assert.equal(job5rPre.state, 'queued');
    assert.equal(job5rPre.requiresPaperConfirm, false);

    // Verify UI & route wiring
    const kioskHtml = fs.readFileSync(path.join(root, 'public/kiosk.html'), 'utf8');
    const kioskJs = fs.readFileSync(path.join(root, 'public/js/kiosk.js'), 'utf8');
    const mingleHtml = fs.readFileSync(path.join(root, 'public/mingle.html'), 'utf8');
    const mingleJs = fs.readFileSync(path.join(root, 'public/js/mingle.js'), 'utf8');
    const adminHtml = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
    const adminJs = fs.readFileSync(path.join(root, 'public/js/admin.js'), 'utf8');
    const apiJs = fs.readFileSync(path.join(root, 'src/routes/api.js'), 'utf8');

    assert.match(kioskHtml, /kioskPrintOptionsModal/);
    assert.match(kioskJs, /openPrintOptionsModal/);
    assert.match(mingleHtml, /minglePrintOptionsModal/);
    assert.match(mingleJs, /openPrintOptionsModal/);
    assert.match(adminHtml, /adminPaperConfirmModal/);
    assert.match(adminHtml, /adminBrowserStationToggle/);
    assert.match(adminJs, /confirmAdminPaper5R/);
    assert.match(adminJs, /pollGlobalPrintStation/);
    assert.match(apiJs, /\/print-jobs\/:id\/confirm-paper/);
    assert.match(apiJs, /resolveValidDeviceId/);
  } finally {
    db.prepare('DELETE FROM print_jobs WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM media_assets WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
  }
});

test('Audit security & parity fixes: no guest QR cross-leak, reprint baseUrl, auth-guarded print-agent, no admin query bypass, operator PIN verify, APK sync', async () => {
  const printService = await import('../src/services/print.js');
  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 10000);
  const otherPassId = 'gp_other_' + suffix;
  const ownPassId = 'gp_own_' + suffix;
  const sessNoPassId = 'sess_nopass_' + suffix;
  const sessOwnPassId = 'sess_ownpass_' + suffix;
  const assetNoPassId = 'asset_nopass_' + suffix;
  const assetOwnPassId = 'asset_ownpass_' + suffix;
  const ownToken = 'own_tok_' + suffix;

  db.prepare(`
    INSERT INTO guest_passes (id, tenant_id, event_id, opaque_token_hash, token_plain, status, issued_via, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', 'test', datetime('now', '+1 day'))
  `).run(otherPassId, tenantId, eventId, 'hash_other_' + suffix, 'other_tok_' + suffix);

  db.prepare(`
    INSERT INTO guest_passes (id, tenant_id, event_id, opaque_token_hash, token_plain, status, issued_via, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', 'test', datetime('now', '+1 day'))
  `).run(ownPassId, tenantId, eventId, 'hash_own_' + suffix, ownToken);

  db.prepare(`
    INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, device_id, mode, status)
    VALUES (?, ?, ?, NULL, NULL, 'kiosk', 'completed')
  `).run(sessNoPassId, tenantId, eventId);

  db.prepare(`
    INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, device_id, mode, status)
    VALUES (?, ?, ?, ?, NULL, 'kiosk', 'completed')
  `).run(sessOwnPassId, tenantId, eventId, ownPassId);

  db.prepare(`
    INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, status)
    VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', '/uploads/test_no_qr.png', 'ready')
  `).run(assetNoPassId, tenantId, eventId, sessNoPassId);

  db.prepare(`
    INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, status)
    VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', '/uploads/test_own_qr.png', 'ready')
  `).run(assetOwnPassId, tenantId, eventId, sessOwnPassId);

  try {
    // 1a. Session without guest_pass_id must NOT fall back to another guest's guest_pass in the same event
    const noPassJob = printService.createPrintJob(tenantId, eventId, null, sessNoPassId, assetNoPassId, 1, {
      paperSize: '4x6',
      baseUrl: 'https://mafaza.example.com'
    });
    const noPassRow = db.prepare('SELECT options_json FROM print_jobs WHERE id = ?').get(noPassJob.printJobId);
    const noPassOpts = JSON.parse(noPassRow.options_json);
    assert.equal(noPassOpts.qrUrl, null, 'session without guest_pass_id must keep qrUrl null');

    // 1b. Session WITH guest_pass_id keeps its own QR and reprintJob() preserves/rewrites baseUrl cleanly
    const ownPassJob = printService.createPrintJob(tenantId, eventId, null, sessOwnPassId, assetOwnPassId, 1, {
      paperSize: '4x6',
      baseUrl: 'https://old.studio.test',
      qrPosition: 'bottom-right'
    });
    const ownRow = db.prepare('SELECT options_json FROM print_jobs WHERE id = ?').get(ownPassJob.printJobId);
    const ownOpts = JSON.parse(ownRow.options_json);
    assert.equal(ownOpts.qrUrl, `https://old.studio.test/gallery/g/${ownToken}`);

    const reprinted = printService.reprintJob(ownPassJob.printJobId, tenantId, 'user_operator_01', 1, {
      baseUrl: 'https://new.custom.domain'
    });
    const repRow = db.prepare('SELECT options_json FROM print_jobs WHERE id = ?').get(reprinted.printJobId);
    const repOpts = JSON.parse(repRow.options_json);
    assert.equal(repOpts.qrUrl, `https://new.custom.domain/gallery/g/${ownToken}`);
    assert.equal(repOpts.qrPosition, 'bottom-right');

    // 2. Print agent secret download must require authMiddleware & derive tenant from req.user
    const root = process.cwd();
    const apiJs = fs.readFileSync(path.join(root, 'src/routes/api.js'), 'utf8');
    const serverJs = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
    const kioskJs = fs.readFileSync(path.join(root, 'public/js/kiosk.js'), 'utf8');
    const guardJs = fs.readFileSync(path.join(root, 'android-kiosk/assets/usb-capture-guard.js'), 'utf8');
    const mainJava = fs.readFileSync(path.join(root, 'android-kiosk/src/com/mafaza/photobooth/kiosk/MainActivity.java'), 'utf8');
    const deploySh = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');

    assert.match(apiJs, /apiRouter\.get\('\/print-agent\/download\/:os',\s*authMiddleware\(\)/);
    assert.match(apiJs, /\/print-jobs\/:id\/reprint[\s\S]*reprintJob\([\s\S]*baseUrl/);
    assert.match(apiJs, /\/printers\/test-print[\s\S]*createPrintJob\([\s\S]*baseUrl/);

    // 3. No /admin?password= bypass; server-side timing-safe operator PIN verification & .env preservation
    assert.doesNotMatch(serverJs, /req\.query\.password|req\.query\.pass/);
    assert.match(apiJs, /apiRouter\.post\('\/kiosk\/verify-operator-pin'/);
    assert.match(apiJs, /timingSafeEqual/);
    assert.match(kioskJs, /\/api\/kiosk\/verify-operator-pin/);
    assert.doesNotMatch(kioskJs, /val === '0000'/);
    assert.match(deploySh, /OPERATOR_PIN/);

    // 4. Android APK guard syncs cameraRotation + live CSS filter, awaits rotation before hold preview, and MainActivity handles 4R/5R/A4
    assert.match(kioskJs, /async handlePostCapture\s*\(/);
    assert.match(kioskJs, /await this\.applyRotationToCapturedPose\(justCapturedIndex\)/);
    assert.match(guardJs, /getCameraCssFilterString/);
    assert.match(guardJs, /__captureFrameRotatedFlags/);
    assert.match(mainJava, /NA_INDEX_4X6/);
    assert.match(mainJava, /MAFAZA_5R_5X7/);
    assert.match(mainJava, /Margins\.NO_MARGINS/);
  } finally {
    db.prepare('DELETE FROM print_jobs WHERE photo_session_id IN (?, ?)').run(sessNoPassId, sessOwnPassId);
    db.prepare('DELETE FROM media_assets WHERE photo_session_id IN (?, ?)').run(sessNoPassId, sessOwnPassId);
    db.prepare('DELETE FROM photo_sessions WHERE id IN (?, ?)').run(sessNoPassId, sessOwnPassId);
    db.prepare('DELETE FROM guest_passes WHERE id IN (?, ?)').run(otherPassId, ownPassId);
  }
});

test('Service Worker never intercepts or caches local USB bridge photo/status requests', async () => {
  const vm = await import('node:vm');
  const swSrc = fs.readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
  const listeners = {};
  let cacheMatchCalls = 0;
  const ctx = vm.createContext({
    URL,
    self: {
      location: { origin: 'https://mafaza.galipatsistem.com' },
      addEventListener(name, fn) { listeners[name] = fn; },
      skipWaiting() {},
      clients: { claim() {} }
    },
    caches: {
      async match() { cacheMatchCalls++; return null; },
      async open() { return { async put() {}, async add() {} }; },
      async keys() { return []; }
    },
    fetch: async () => ({ ok: true, clone() { return this; } }),
    Promise, setTimeout, console
  });
  vm.runInContext(swSrc, ctx);
  assert.equal(typeof listeners.fetch, 'function');

  for (const url of [
    'http://127.0.0.1:19898/physical_capture.jpg?seq=1',
    'http://127.0.0.1:19898/captured_pose.jpg?id=1',
    'http://127.0.0.1:19898/status',
    'http://127.0.0.1:19898/control?mingle=1'
  ]) {
    let intercepted = false;
    listeners.fetch({
      request: { method: 'GET', url, mode: 'cors', destination: '' },
      respondWith() { intercepted = true; }
    });
    assert.equal(intercepted, false, `SW must not intercept or cache ${url}`);
  }
  assert.equal(cacheMatchCalls, 0);
});

test('MingleBoothEngine arms baselinePhysicalSeq before accepting captures and busts bridge cache', async () => {
  const vm = await import('node:vm');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const trimmed = mingleSrc.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');

  let bridgeSeq = 47; // Simulate stale seq left over from last night in APK memory
  const fetchedUrls = [];
  const docEl = () => ({
    style: {}, value: '', innerText: '', innerHTML: '', src: '', width: 0, height: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    toDataURL: () => 'data:image/jpeg;base64,bmV3',
    getContext: () => ({ drawImage() {}, fillRect() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {}, translate() {}, rotate() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} })
  });
  const elements = new Map();
  const intervals = [];
  const winListeners = {};
  const ctx = vm.createContext({
    URL, URLSearchParams, AbortController, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    Blob: class {},
    FileReader: class {
      readAsDataURL() { this.result = 'data:image/jpeg;base64,bmV3'; this.onloadend?.(); }
    },
    Image: class { set src(v) { this.naturalWidth = 100; this.naturalHeight = 100; queueMicrotask(() => this.onload?.()); } },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { onLine: true, mediaDevices: null },
    document: {
      body: docEl(),
      getElementById(id) { if (!elements.has(id)) elements.set(id, docEl()); return elements.get(id); },
      querySelectorAll: () => [],
      createElement: () => docEl()
    },
    window: {
      location: { search: '' },
      addEventListener(ev, fn) { winListeners[ev] = fn; }
    },
    fetch: async (url) => {
      fetchedUrls.push(String(url));
      if (String(url).includes('/status')) {
        return {
          ok: true,
          json: async () => ({
            active: true,
            physicalCaptureSeq: bridgeSeq,
            physicalPhotoUrl: `http://127.0.0.1:19898/physical_capture.jpg?seq=${bridgeSeq}`
          })
        };
      }
      if (String(url).includes('/control')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (String(url).includes('/physical_capture.jpg')) {
        return { ok: true, blob: async () => ({ size: 4096 }) };
      }
      return { ok: false, json: async () => ({}) };
    },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(), console
  });
  vm.runInContext(trimmed, ctx);

  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(engine, {
    tenantId: 't1', eventId: 'e1', deviceId: 'd1',
    templates: [{ id: 'tpl_1', name: 'Test', image_storage_key: '/a.png', width: 1200, height: 1800, shots_mode: '2', slots: [{ x: 0, y: 0, width: 100, height: 100, pose_index: 1 }, { x: 100, y: 0, width: 100, height: 100, pose_index: 2 }] }],
    allTemplates: [], activeTargetShots: 2, currentScreen: 'screenMingleSelect',
    capturedPhotos: [], slotAssignments: [], slotTransforms: [],
    usbStatus: null, baselinePhysicalSeq: 0, _lastAcceptedPhysicalSeq: 0, _physicalReadyArmed: false,
    isProcessingCapture: false
  });
  engine.setupLifecycleListeners();

  // Even before selecting a frame or arming, a spurious physical shutter event MUST NOT capture old seq 47
  winListeners['mafaza:physical-shutter']({ detail: { seq: 47, url: 'http://127.0.0.1:19898/physical_capture.jpg?seq=47' } });
  assert.equal(engine.capturedPhotos.length, 0);

  // Entering selectFrame while usbStatus was null arms baseline to 47 BEFORE enabling capture acceptance
  await engine.selectFrame('tpl_1');
  assert.equal(engine.baselinePhysicalSeq, 47);
  assert.equal(engine._physicalReadyArmed, true);
  assert.equal(engine.capturedPhotos.length, 0, 'Stale seq=47 from last night must NOT auto-capture on selectFrame');

  // Now simulate a genuinely NEW shot seq=48
  winListeners['mafaza:physical-shutter']({ detail: { seq: 48, url: 'http://127.0.0.1:19898/physical_capture.jpg?seq=48' } });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(engine.capturedPhotos.length, 1, 'New seq=48 shot IS captured');
  const photoFetch = fetchedUrls.find(u => u.includes('physical_capture.jpg?seq=48'));
  assert.ok(photoFetch && photoFetch.includes('&_cb='), 'Fetched bridge photo URL includes unique _cb cache-buster');
});

test('Offline QR pool holds 20 passes, is untouched while online, and auto-refills to 20 on WiFi reconnect', async () => {
  const vm = await import('node:vm');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const trimmed = mingleSrc.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');

  let onlineFlag = true;
  let seqId = 1;
  const storageMap = new Map();
  const winListeners = {};
  const docEl = () => ({
    style: {}, value: '', innerText: '', textContent: '', innerHTML: '', src: '', href: '', width: 100, height: 100,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    toBlob: (cb) => cb({ size: 256, type: 'image/jpeg' }),
    getContext: () => ({ drawImage() {}, fillRect() {} })
  });
  const elements = new Map();
  const ctx = vm.createContext({
    URL, URLSearchParams, AbortController, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    Blob: class {},
    FormData: class { append() {} },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v))
    },
    navigator: { get onLine() { return onlineFlag; }, mediaDevices: null },
    document: {
      body: docEl(),
      getElementById(id) { if (!elements.has(id)) elements.set(id, docEl()); return elements.get(id); },
      querySelectorAll: () => [],
      createElement: () => docEl()
    },
    window: {
      location: { origin: 'https://mafaza.galipatsistem.com', search: '' },
      addEventListener(ev, fn) { winListeners[ev] = fn; }
    },
    pbOfflineStore: {
      async saveSession() {},
      async getPendingCount() { return 0; },
      subscribe() {}
    },
    fetch: async (url) => {
      if (String(url).includes('/api/guest-passes/issue')) {
        const idNum = seqId++;
        return {
          ok: true,
          json: async () => ({
            id: `gp_${idNum}`,
            token: `tok_${idNum}`,
            token_plain: `tok_${idNum}`,
            galleryUrl: `/gallery/g/tok_${idNum}`,
            fullQrUrl: `https://mafaza.galipatsistem.com/gallery/g/tok_${idNum}`,
            qrDataUrl: `data:image/png;base64,QR_${idNum}`
          })
        };
      }
      if (String(url).includes('/api/kiosk/sessions')) {
        return { ok: true, json: async () => ({ sessionId: `sess_${seqId++}`, success: true }) };
      }
      return { ok: true, blob: async () => ({ size: 128 }), json: async () => ({ success: true }) };
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(), console
  });
  vm.runInContext(trimmed, ctx);

  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(engine, {
    tenantId: 't1', eventId: 'e_pool', deviceId: 'd1',
    templates: [], allTemplates: [], capturedPhotos: ['data:image/jpeg;base64,QQ=='],
    filesOnlyMode: true, currentScreen: 'screenMingleResult',
    baselinePhysicalSeq: 0, _lastAcceptedPhysicalSeq: 0, _physicalReadyArmed: false,
    _activeSessionToken: 1
  });
  engine.setupLifecycleListeners();

  // 1. Pre-fill pool up to 20 passes at the tent
  await engine.replenishGuestPassPool(20);
  const poolKey = engine.getGuestPassPoolKey();
  assert.equal(JSON.parse(storageMap.get(poolKey)).length, 20);

  // 2. Customer served NEAR tent WITH WiFi -> fetches fresh pass from server, MUST NOT consume the 20 offline pool
  engine.guestPass = null;
  engine.sessionId = null;
  await engine.issuePassCreateAndSync();
  assert.equal(JSON.parse(storageMap.get(poolKey)).length, 20, 'Online session does not drain the 20-pass offline pool');

  // 3. Roaming AWAY from WiFi (offline) -> 10 offline customers consume 10 pooled passes (leaving 10)
  onlineFlag = false;
  const offlineTokens = [];
  for (let i = 0; i < 10; i++) {
    engine.guestPass = null;
    engine.sessionId = null;
    await engine.issuePassCreateAndSync();
    assert.ok(engine.guestPass && engine.guestPass.token, `Offline customer #${i + 1} receives QR immediately`);
    offlineTokens.push(engine.guestPass.token);
  }
  assert.equal(new Set(offlineTokens).size, 10, 'Every offline customer receives a unique QR token');
  assert.equal(JSON.parse(storageMap.get(poolKey)).length, 10);

  // 4. Returning to tent (WiFi reconnects) -> window online event refills pool back to 20
  onlineFlag = true;
  winListeners.online();
  await new Promise(r => setTimeout(r, 950));
  assert.equal(JSON.parse(storageMap.get(poolKey)).length, 20, 'Pool refills automatically back to 20 when WiFi returns');
});

test('Offline gallery UI renders unsent sessions and /complete auto-issues QR + preserves 5R offline paper size', async () => {
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  const kioskHtml = fs.readFileSync(path.join(process.cwd(), 'public/kiosk.html'), 'utf8');
  const offlineStoreSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/offline-store.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(process.cwd(), 'src/routes/api.js'), 'utf8');

  assert.match(mingleHtml, /id="btnMingleOfflineGallery"[^>]*pbOfflineStore\.openLocalGallery/);
  assert.match(mingleHtml, /id="btnMingleWelcomeOfflineGallery"[^>]*pbOfflineStore\.openLocalGallery/);
  assert.match(kioskHtml, /id="btnKioskOfflineGallery"[^>]*pbOfflineStore\.openLocalGallery/);
  assert.match(offlineStoreSrc, /printPaperSize/);
  assert.match(offlineStoreSrc, /openLocalGallery\s*\(/);
  assert.match(offlineStoreSrc, /_showSessionDetail\s*\(/);
  assert.match(offlineStoreSrc, /pb_offline_synced_history_v1/);

  // Exercise /api/kiosk/sessions/:id/complete directly for (a) printRequested=false offline upload auto-creating QR and (b) 5R printPaperSize preservation
  const express = (await import('express')).default;
  const http = await import('node:http');
  const { apiRouter } = await import('../src/routes/api.js');
  const app = express();
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  const createdSessionIds = [];
  const createdPassIds = [];
  const createdJobIds = [];

  try {
    const fd1 = new FormData();
    fd1.append('tenantId', 'tenant_studiokeren_01');
    fd1.append('eventId', 'event_wedding_dimas_sarah');
    fd1.append('mode', 'files_only');
    fd1.append('printRequested', 'false');
    fd1.append('captures', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'pose1.jpg');
    const sess1 = `sess_off_test_no_print_${Date.now()}`;
    createdSessionIds.push(sess1);
    const r1 = await fetch(`http://127.0.0.1:${port}/api/kiosk/sessions/${sess1}/complete`, { method: 'POST', body: fd1 });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.ok(j1.guestPassId, 'Auto-creates guestPassId even when printRequested is false');
    assert.match(j1.guestPass.galleryUrl, /^\/gallery\/g\//);
    createdPassIds.push(j1.guestPassId);

    const fd2 = new FormData();
    fd2.append('tenantId', 'tenant_studiokeren_01');
    fd2.append('eventId', 'event_wedding_dimas_sarah');
    fd2.append('mode', 'single');
    fd2.append('printRequested', 'true');
    fd2.append('printCopies', '2');
    fd2.append('printPaperSize', '5x7');
    fd2.append('finalImage', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'final.jpg');
    const sess2 = `sess_off_test_5r_${Date.now()}`;
    createdSessionIds.push(sess2);
    const r2 = await fetch(`http://127.0.0.1:${port}/api/kiosk/sessions/${sess2}/complete`, { method: 'POST', body: fd2 });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.printJob.paperSize, '5x7', 'Synced offline print preserves 5R (5x7) paperSize');
    assert.equal(j2.printJob.copies, 2);
    createdPassIds.push(j2.guestPassId);
    createdJobIds.push(j2.printJob.printJobId);
    assert.match(apiSrc, /if \(!session\.guest_pass_id && hasSessionMedia\)/);
  } finally {
    srv.close();
    for (const jid of createdJobIds) db.prepare('DELETE FROM print_jobs WHERE id = ?').run(jid);
    for (const sid of createdSessionIds) {
      const assets = db.prepare('SELECT file_path FROM media_assets WHERE photo_session_id = ?').all(sid);
      for (const a of assets) {
        if (a && a.file_path) {
          const p = path.join(process.cwd(), 'public', a.file_path);
          try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
        }
      }
      db.prepare('DELETE FROM media_assets WHERE photo_session_id = ?').run(sid);
      db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sid);
    }
    for (const pid of createdPassIds) {
      if (pid) db.prepare('DELETE FROM guest_passes WHERE id = ?').run(pid);
    }
  }
});

test('Mingle supports Arah Foto Kamera (Ikut Frame / Potret / Lanskap) matching Kiosk behavior', async () => {
  const vm = await import('node:vm');
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const trimmed = mingleSrc.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');

  assert.match(mingleHtml, /id="mingleCameraOrientRow"/);
  assert.match(mingleHtml, /data-cam-orient="auto"[^>]*setCameraCaptureOrientation\('auto'\)/);
  assert.match(mingleHtml, /data-cam-orient="portrait"[^>]*setCameraCaptureOrientation\('portrait'\)/);
  assert.match(mingleHtml, /data-cam-orient="landscape"[^>]*setCameraCaptureOrientation\('landscape'\)/);
  assert.match(mingleHtml, /id="btnMingleCaptureOrientPortrait"/);
  assert.match(mingleHtml, /id="btnMingleCaptureOrientLandscape"/);

  const storageMap = new Map();
  const canvases = [];
  const docEl = () => ({
    style: {}, width: 0, height: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,Q1JPUA=='
  });
  const elements = new Map();
  const ctx = vm.createContext({
    URL, URLSearchParams, AbortController, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    Image: class { set src(v) { this.naturalWidth = 1920; this.naturalHeight = 1080; queueMicrotask(() => this.onload?.()); } },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v))
    },
    navigator: { onLine: true, mediaDevices: null },
    document: {
      body: docEl(),
      getElementById(id) { if (!elements.has(id)) elements.set(id, docEl()); return elements.get(id); },
      querySelectorAll: () => [],
      createElement: (tag) => { const el = docEl(); if (tag === 'canvas') canvases.push(el); return el; }
    },
    window: { location: { search: '' }, addEventListener() {} },
    setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => fn(), console
  });
  vm.runInContext(trimmed, ctx);

  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(engine, {
    cameraCaptureOrientation: 'auto',
    filesOnlyMode: false,
    selectedTemplate: { orientation: 'portrait', width: 1200, height: 1800, slots: [{ width: 900, height: 1400 }] }
  });

  // 1. Auto follows portrait slot template -> portrait (crops 1920x1080 to 720x1080)
  assert.equal(engine.getEffectiveCaptureOrientation(), 'portrait');
  await engine.enforceCaptureOrientationDataUrl('data:image/jpeg;base64,RAW');
  assert.equal(canvases[0].width, 720);
  assert.equal(canvases[0].height, 1080);

  // 2. Explicit landscape overrides portrait template -> landscape
  engine.setCameraCaptureOrientation('landscape');
  assert.equal(storageMap.get('pb_camera_capture_orientation'), 'landscape');
  assert.equal(engine.getEffectiveCaptureOrientation(), 'landscape');
  assert.equal(elements.get('mingleViewfinder').style.aspectRatio, '3 / 2');

  // 3. Explicit portrait overrides landscape template -> portrait
  engine.selectedTemplate = { orientation: 'landscape', width: 1800, height: 1200, slots: [{ width: 1600, height: 1000 }] };
  engine.setCameraCaptureOrientation('portrait');
  assert.equal(engine.getEffectiveCaptureOrientation(), 'portrait');
  assert.equal(elements.get('mingleViewfinder').style.aspectRatio, '2 / 3');
});

test('Mingle Ready screen places captured thumbnails in right column below Jumlah Cekrek with zoom lightbox', async () => {
  const vm = await import('node:vm');
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const trimmed = mingleSrc.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');

  const controlsIdx = mingleHtml.indexOf('class="mingle-card mingle-ready-controls-card"');
  const shotsIdx = mingleHtml.indexOf('id="mingleReadyShotsSelect"');
  const stripIdx = mingleHtml.indexOf('id="mingleReadyStripWrap"');
  const bannerIdx = mingleHtml.indexOf('class="mingle-shutter-banner"');
  assert.ok(controlsIdx !== -1 && shotsIdx > controlsIdx && stripIdx > shotsIdx && bannerIdx > stripIdx,
    'mingleReadyStripWrap is placed in right controls column directly below Jumlah Cekrek');
  assert.match(mingleHtml, /id="mingleReadyStripWrap"/);
  assert.match(mingleHtml, /id="btnMingleScreenCapture"[^>]*>\s*📸 Jepret dari Layar\s*<\/button>/);
  const qrIdx = mingleHtml.indexOf('class="mingle-qr-box"');
  const resSlotIdx = mingleHtml.indexOf('id="mingleResultSlotBar"');
  assert.ok(qrIdx !== -1 && resSlotIdx > qrIdx, 'mingleResultSlotBar is placed below QR box in right column');
  assert.match(mingleHtml, /id="minglePhotoZoomModal"/);

  const elements = new Map();
  const docEl = () => ({ style: {}, value: '', innerText: '', innerHTML: '', src: '', classList: { toggle() {} } });
  const ctx = vm.createContext({
    URL, URLSearchParams, AbortController, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { onLine: true, mediaDevices: null },
    document: {
      body: docEl(),
      getElementById(id) { if (!elements.has(id)) elements.set(id, docEl()); return elements.get(id); },
      querySelectorAll: () => [],
      createElement: () => docEl()
    },
    window: { location: { search: '' }, addEventListener() {} },
    setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => fn(), console
  });
  vm.runInContext(trimmed, ctx);

  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(engine, {
    capturedPhotos: ['data:image/jpeg;base64,ONE', 'data:image/jpeg;base64,TWO'],
    activeTargetShots: 3,
    syncedCaptureCount: 0
  });
  engine.updateReadyCaptureUI();
  assert.match(elements.get('mingleCapturedStrip').innerHTML, /mingle\.openCapturedPhotoPreview\(0\)/);
  assert.match(elements.get('mingleCapturedStrip').innerHTML, /event\.stopPropagation\(\); mingle\.deleteCapturedPhoto\(0\)/);

  engine.openCapturedPhotoPreview(0);
  assert.equal(elements.get('minglePhotoZoomModal').style.display, 'flex');
  assert.equal(elements.get('minglePhotoZoomImg').src, 'data:image/jpeg;base64,ONE');

  engine.stepCapturedPhotoPreview(1);
  assert.equal(elements.get('minglePhotoZoomImg').src, 'data:image/jpeg;base64,TWO');

  engine.deletePreviewedPhoto();
  assert.equal(engine.capturedPhotos.length, 1);
  assert.equal(elements.get('minglePhotoZoomImg').src, 'data:image/jpeg;base64,ONE');
});

test('Gallery hides fake Boomerang/Live Photo modes on single still session and aligns Boomerang by pose_index', () => {
  const galleryHtml = fs.readFileSync(path.join(process.cwd(), 'public/gallery.html'), 'utf8');
  const kioskSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/kiosk.js'), 'utf8');

  // Honest mode gates in gallery
  assert.match(galleryHtml, /const hasRealBoomerang = poseImages\.length >= 2 \|\| Boolean\(boomerangAsset && boomerangAsset\.filePath\)/);
  assert.match(galleryHtml, /const hasRealLivePhoto = Boolean\(mainLiveVideoSrc \|\| liveClips\.length > 0\)/);
  assert.match(galleryHtml, /const showModeToggle = hasRealBoomerang \|\| hasRealLivePhoto/);
  assert.match(galleryHtml, /\$\{clipSrc \? `[\s\S]*?apple-live-badge-mini/);
  assert.match(galleryHtml, /object-fit: contain;/);

  // Asynchronous slotVideos initialization & pose_index alignment
  assert.match(galleryHtml, /function ensureSlotVideosLoaded\s*\(/);
  assert.match(galleryHtml, /const basePoseIdx = \(slot\.pose_index && parseInt\(slot\.pose_index, 10\) > 0\)/);
  assert.match(galleryHtml, /if \(mode === 'boomerang' && boomerangAsset && boomerangAsset\.filePath\)/);

  // Kiosk USB LiveView canvas fallback recording & pose_index alignment
  assert.match(kioskSrc, /canonUsbLiveCanvas[\s\S]*captureStream/);
  assert.match(kioskSrc, /const slotPoseIdx = \(slot\.pose_index && parseInt\(slot\.pose_index, 10\) > 0\)/);
});

test('Shared print-safe photo filter engine, Kiosk/Mingle parity, offline print preservation & Admin event defaults work end-to-end', async () => {
  const vm = (await import('node:vm')).default;
  const eventService = await import('../src/services/event.js');

  const filtersSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/photo-filters.js'), 'utf8');
  const offlineSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/offline-store.js'), 'utf8');
  const kioskHtml = fs.readFileSync(path.join(process.cwd(), 'public/kiosk.html'), 'utf8');
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(process.cwd(), 'public/admin.html'), 'utf8');
  const kioskSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/kiosk.js'), 'utf8');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const adminSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/admin.js'), 'utf8');
  const swSrc = fs.readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');

  // 1. Execute MafazaPhotoFilters in VM and verify all 7 print-calibrated presets & intensity scaling
  const fCtx = vm.createContext({ Math, Number, String, Array, Map, RegExp, module: { exports: {} }, console });
  vm.runInContext(filtersSrc, fCtx);
  const filters = fCtx.MafazaPhotoFilters;
  assert.deepEqual(Array.from(filters.PRESET_ORDER), ['normal', 'glowing', 'korean', 'warm_retro', 'vivid', 'bw', 'cinematic']);
  assert.equal(filters.getScaledCssFilter('normal', 1.0), 'none');
  assert.equal(filters.getScaledCssFilter('bw', 1.0), 'brightness(105%) contrast(114%) saturate(0%) grayscale(100%)');
  assert.equal(filters.getScaledCssFilter('bw', 0.5), 'brightness(102%) contrast(107%) saturate(50%) grayscale(50%)');
  assert.ok(filters.getPreset('glowing').glowAlpha > 0, 'Glowing includes real diffusion bloom');
  assert.ok(Array.isArray(filters.getPreset('bw').shadowLiftRgb), 'B&W lifts pure black shadows for Epson paper');

  // 2. Verify pixel-level Canvas fallback (Safari/older WebKit) mutates pixels accurately
  const mockCanvasData = new Uint8ClampedArray([100, 150, 200, 255]);
  let createdCanvasCtx = null;
  const mockDoc = {
    createElement() {
      return {
        width: 1,
        height: 1,
        getContext() {
          createdCanvasCtx = {
            imageSmoothingEnabled: true,
            filter: 123, // non-string forces pixel fallback path
            fillStyle: '',
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
            save() {},
            restore() {},
            fillRect() {},
            drawImage() {},
            getImageData: () => ({ data: mockCanvasData }),
            putImageData(imgData) { createdCanvasCtx._out = Array.from(imgData.data); }
          };
          return createdCanvasCtx;
        }
      };
    }
  };
  const pCtx = vm.createContext({ Math, Number, String, Array, Map, RegExp, document: mockDoc, module: { exports: {} }, console });
  vm.runInContext(filtersSrc, pCtx);
  const pFilters = pCtx.MafazaPhotoFilters;
  assert.equal(pFilters.supportsCanvasFilter(), false);
  pFilters.renderStyledCanvas({ naturalWidth: 10, naturalHeight: 10, src: 'mem://1' }, 'bw', { intensity: 1.0, skipCache: true });
  assert.ok(createdCanvasCtx && createdCanvasCtx._out, 'Pixel fallback wrote graded pixels when ctx.filter is unsupported');
  assert.equal(createdCanvasCtx._out[0], createdCanvasCtx._out[1], 'B&W pixel fallback produces monochrome R==G');
  assert.equal(createdCanvasCtx._out[1], createdCanvasCtx._out[2], 'B&W pixel fallback produces monochrome G==B');

  // 3. Verify offline-store preserves printRequested & captures across filter re-saves
  const storedRecords = new Map();
  const mockIdb = {
    open() {
      const req = {};
      setTimeout(() => {
        const dbObj = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx = { oncomplete: null };
            const objStore = {
              get(id) {
                const r = {};
                setTimeout(() => { r.result = storedRecords.get(id) || null; if (r.onsuccess) r.onsuccess(); }, 0);
                return r;
              },
              getAll() {
                const r = {};
                setTimeout(() => { r.result = Array.from(storedRecords.values()); if (r.onsuccess) r.onsuccess(); }, 0);
                return r;
              },
              put(rec) {
                const r = {};
                storedRecords.set(rec.id, rec);
                setTimeout(() => { if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); }, 0);
                return r;
              }
            };
            tx.objectStore = () => objStore;
            return tx;
          }
        };
        req.result = dbObj;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
  const oCtx = vm.createContext({
    indexedDB: mockIdb,
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { onLine: false },
    Blob: globalThis.Blob,
    FileReader: class { readAsDataURL() { setTimeout(() => { this.result = 'data:image/jpeg;base64,QQ=='; if (this.onloadend) this.onloadend(); }, 0); } },
    atob: globalThis.atob,
    Uint8Array, Promise, Math, Date, JSON, Array, Number, String, Boolean, setTimeout, setInterval: () => 1, console
  });
  vm.runInContext(offlineSrc, oCtx);
  const store = oCtx.window.pbOfflineStore;

  await store.saveSession({
    id: 'sess_filter_offline_1',
    finalImageBlob: 'data:image/jpeg;base64,FINAL1',
    captures: [{ poseIndex: 1, blob: 'data:image/jpeg;base64,RAW1' }],
    printRequested: true,
    printCopies: 3,
    printPaperSize: '5x7',
    paperConfirmed: true
  });
  // Now simulate filter change while offline (printRequested: false, captures: [])
  await store.saveSession({
    id: 'sess_filter_offline_1',
    finalImageBlob: 'data:image/jpeg;base64,FINAL_FILTERED',
    captures: [],
    printRequested: false,
    preservePrintFlags: true
  });
  const savedAfterFilter = storedRecords.get('sess_filter_offline_1');
  assert.equal(savedAfterFilter.finalImage, 'data:image/jpeg;base64,FINAL_FILTERED');
  assert.equal(savedAfterFilter.printRequested, true, 'Offline print queue preserved on filter change');
  assert.equal(savedAfterFilter.printCopies, 3);
  assert.equal(savedAfterFilter.printPaperSize, '5x7');
  assert.equal(savedAfterFilter.paperConfirmed, true);
  assert.equal(savedAfterFilter.captures.length, 1, 'Existing raw captures preserved when filter update passes []');
  await new Promise(r => setTimeout(r, 20));

  // 4. Verify Kiosk, Mingle, Admin & SW integration wiring
  assert.match(kioskHtml, /<script src="\/js\/photo-filters\.js/);
  assert.match(mingleHtml, /<script src="\/js\/photo-filters\.js/);
  assert.match(kioskHtml, /id="kioskFilterIntensityRange"/);
  assert.match(mingleHtml, /data-filter="cinematic"/, 'Mingle has all 7 filter presets matching Kiosk');
  assert.match(mingleHtml, /id="mingleFilterIntensityRange"/);
  assert.match(swSrc, /'\/js\/photo-filters\.js'/);

  assert.match(mingleSrc, /querySelectorAll\('#mingleFilterRow \.mingle-filter-btn'\)/, 'Mingle filter active class scoped so slot tabs stay highlighted');
  assert.match(kioskSrc, /forceRegenerateBoomerang: validPoses\.length >= 2/, 'Kiosk regenerates Boomerang when photo filter changes');
  assert.match(kioskSrc, /window\.MafazaPhotoFilters\.drawFilteredImage\([\s\S]*bm_/, 'Kiosk Boomerang applies active photo filter');
  assert.match(kioskSrc, /getCameraCssFilterString\(\)[\s\S]*renderStyledCanvas/, 'Kiosk DSLR hardware capture applies camera adjust settings');

  // 5. Verify Event Config persists defaultPhotoFilter + livePhotoFilter
  assert.match(adminHtml, /id="cfgDefaultPhotoFilter"/);
  assert.match(adminHtml, /id="cfgLivePhotoFilter"/);
  assert.match(adminSrc, /cfgDefaultPhotoFilter/);
  const createdEv = eventService.createEvent('tenant_studiokeren_01', {
    name: 'Filter Default Test',
    defaultPhotoFilter: 'korean',
    livePhotoFilter: true
  });
  try {
    assert.equal(createdEv.config.defaultPhotoFilter, 'korean');
    assert.equal(createdEv.config.livePhotoFilter, true);
  } finally {
    const { db } = await import('../src/db/database.js');
    db.prepare('DELETE FROM events WHERE id = ?').run(createdEv.id);
  }
});

test('Mode Lokal clearly shows active banner, disables auto-sync until turned off, and uploads in 2-pose batches', async () => {
  const vm = (await import('node:vm')).default;
  const offlineSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/offline-store.js'), 'utf8');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const kioskSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/kiosk.js'), 'utf8');

  // Verify Mingle & Kiosk badge/timeout wiring + single-screen APK layout & clean result stage
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  assert.match(mingleHtml, /body\.mingle-on-result \.mingle-shell\s*\{[\s\S]*height:\s*100dvh/);
  assert.match(mingleHtml, /\.mingle-canvas-stage\s*\{[\s\S]*background:\s*#EFE4D6/);
  assert.doesNotMatch(mingleHtml, /\.mingle-canvas-stage\s*\{[\s\S]*#221D1A/);
  assert.match(mingleSrc, /classList\.toggle\('mingle-on-result', id === 'screenMingleResult'\)/);
  assert.match(mingleSrc, /(Tahan Upload|Mode Lokal) \(\$\{count\}\) · 📂 Galeri/);
  assert.match(mingleSrc, /30000/);
  assert.match(kioskSrc, /35000/);

  const lsState = new Map([['pb_kiosk_local_mode', 'true']]);
  const storedRecords = new Map([[
    'sess_local_3poses',
    {
      id: 'sess_local_3poses',
      tenantId: 'tenant_studiokeren_01',
      eventId: 'event_wedding_dimas_sarah',
      finalImage: 'data:image/jpeg;base64,QQ==',
      captures: [
        { poseIndex: 1, dataUrl: 'data:image/jpeg;base64,QQ==' },
        { poseIndex: 2, dataUrl: 'data:image/jpeg;base64,QQ==' },
        { poseIndex: 3, dataUrl: 'data:image/jpeg;base64,QQ==' }
      ],
      printRequested: true,
      printCopies: 2,
      printPaperSize: '5x7',
      paperConfirmed: true,
      synced: false,
      createdAt: Date.now()
    }
  ]]);

  const uploadBatches = [];
  class MockFormData {
    constructor() { this.fields = []; }
    append(k, v, name) { this.fields.push({ k, v, name }); }
  }

  const mockIdb = {
    open() {
      const req = {};
      setTimeout(() => {
        const dbObj = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx = { oncomplete: null };
            const objStore = {
              get(id) {
                const r = {};
                setTimeout(() => { r.result = storedRecords.get(id) || null; if (r.onsuccess) r.onsuccess(); }, 0);
                return r;
              },
              getAll() {
                const r = {};
                setTimeout(() => { r.result = Array.from(storedRecords.values()); if (r.onsuccess) r.onsuccess(); }, 0);
                return r;
              },
              put(rec) {
                const r = {};
                storedRecords.set(rec.id, rec);
                setTimeout(() => { if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); }, 0);
                return r;
              },
              delete(id) {
                const r = {};
                storedRecords.delete(id);
                setTimeout(() => { if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); }, 0);
                return r;
              }
            };
            tx.objectStore = () => objStore;
            return tx;
          }
        };
        req.result = dbObj;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };

  const oCtx = vm.createContext({
    indexedDB: mockIdb,
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => null },
    localStorage: {
      getItem: (k) => (lsState.has(k) ? lsState.get(k) : null),
      setItem: (k, v) => lsState.set(k, String(v))
    },
    navigator: { onLine: true },
    FormData: MockFormData,
    fetch: async (url, opts) => {
      uploadBatches.push({ url, fields: opts.body.fields });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    Blob: globalThis.Blob,
    AbortController: globalThis.AbortController,
    atob: globalThis.atob,
    Uint8Array, Promise, Math, Date, JSON, Array, Number, String, Boolean,
    setTimeout, clearTimeout, setInterval: () => 1, console
  });
  vm.runInContext(offlineSrc, oCtx);
  const store = oCtx.window.pbOfflineStore;

  assert.equal(store.isLocalDirectMode(), true);
  // While Mode Lokal is ON, automatic background sync must NOT upload
  await store.syncAllPending();
  assert.equal(uploadBatches.length, 0);
  assert.equal(storedRecords.size, 1);

  // Turning off Mode Lokal immediately syncs the queued session in 2 batches (2 poses + 1 pose)
  await store.disableLocalModeAndSync();
  assert.equal(lsState.get('pb_kiosk_local_mode'), 'false');
  assert.equal(store.isLocalDirectMode(), false);
  assert.equal(storedRecords.size, 0, 'Queued session synced & cleared after disabling Mode Lokal');
  assert.equal(uploadBatches.length, 2, '3 captures uploaded in 2 batches (2 + 1)');
  const b0 = uploadBatches[0].fields;
  const b1 = uploadBatches[1].fields;
  assert.equal(b0.find(f => f.k === 'captureStartIndex')?.v, '0');
  assert.equal(b0.find(f => f.k === 'printRequested')?.v, 'false', 'Print only dispatched on final batch');
  assert.equal(b0.filter(f => f.k === 'captures').length, 2);
  assert.equal(b1.find(f => f.k === 'captureStartIndex')?.v, '2');
  assert.equal(b1.find(f => f.k === 'printRequested')?.v, 'true');
  assert.equal(b1.filter(f => f.k === 'captures').length, 1);
  await new Promise(r => setTimeout(r, 20));
});

test('VPS optimization: issue-batch QR endpoint, single-request client pool refill, DSLR 2160px downscale, tmp cleanup, and sql.js debounce', async () => {
  const os = await import('node:os');
  const vm = await import('node:vm');
  const express = (await import('express')).default;
  const { createSqlJsDatabase } = await import('../src/db/database.js');
  const { cleanupOldPrintSheets } = await import('../src/services/sheet.js');
  const { apiRouter } = await import('../src/routes/api.js');

  // 1. Test /api/guest-passes/issue-batch returns clamped batch & creates passes in 1 DB transaction
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  const createdIds = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/guest-passes/issue-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'tenant_studiokeren_01',
        eventId: 'event_wedding_dimas_sarah',
        baseUrl: 'https://mafaza.galipatsistem.com',
        count: 5
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.count, 5);
    assert.equal(data.passes.length, 5);
    data.passes.forEach(p => {
      createdIds.push(p.id);
      assert.ok(p.token && p.qrDataUrl && p.qrDataUrl.startsWith('data:image/png;base64,'));
    });
    assert.equal(new Set(data.passes.map(p => p.token)).size, 5);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    if (createdIds.length > 0) {
      db.prepare(`DELETE FROM guest_passes WHERE id IN (${createdIds.map(() => '?').join(',')})`).run(...createdIds);
    }
  }

  // 2. Test Mingle client replenishGuestPassPool(20) uses 1 batch request & enforces 2160px cap on 6000x4000 DSLR photos
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const trimmed = mingleSrc.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');
  const storageMap = new Map();
  const fetchCalls = [];
  const canvases = [];
  const docEl = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    addEventListener() {},
    width: 0,
    height: 0,
    toDataURL: () => 'data:image/jpeg;base64,RESIZED',
    getContext: () => ({ drawImage() {}, fillRect() {} })
  });
  class MockImage {
    set src(val) {
      this._src = val;
      this.naturalWidth = 6000;
      this.naturalHeight = 4000;
      setTimeout(() => { if (this.onload) this.onload(); }, 0);
    }
  }
  const ctx = vm.createContext({
    Image: MockImage,
    URL, URLSearchParams, AbortController, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    Blob: class {}, FormData: class { append() {} },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v))
    },
    navigator: { onLine: true, mediaDevices: null },
    document: {
      body: docEl(),
      getElementById: () => docEl(),
      querySelectorAll: () => [],
      createElement: (tag) => { const el = docEl(); if (tag === 'canvas') canvases.push(el); return el; }
    },
    window: { location: { origin: 'https://mafaza.galipatsistem.com', search: '' }, addEventListener() {} },
    fetch: async (url, opts) => {
      fetchCalls.push(String(url));
      if (String(url).includes('/api/guest-passes/issue-batch')) {
        const body = JSON.parse(opts.body);
        const passes = Array.from({ length: body.count }, (_, idx) => ({
          id: `bgp_${idx}`,
          token: `btok_${idx}`,
          token_plain: `btok_${idx}`,
          galleryUrl: `/gallery/g/btok_${idx}`,
          fullQrUrl: `https://mafaza.galipatsistem.com/gallery/g/btok_${idx}`,
          qrDataUrl: `data:image/png;base64,QR_${idx}`
        }));
        return { ok: true, json: async () => ({ passes, count: passes.length }) };
      }
      return { ok: false, json: async () => ({}) };
    },
    setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(), console
  });
  vm.runInContext(trimmed, ctx);
  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(engine, {
    tenantId: 't_opt', eventId: 'e_opt', cameraCaptureOrientation: 'landscape', filesOnlyMode: true
  });

  await engine.replenishGuestPassPool(20);
  assert.equal(fetchCalls.length, 1, 'Pool of 20 passes fetched in 1 single batch HTTP request');
  assert.match(fetchCalls[0], /\/api\/guest-passes\/issue-batch/);
  assert.equal(JSON.parse(storageMap.get(engine.getGuestPassPoolKey())).length, 20);

  await engine.enforceCaptureOrientationDataUrl('data:image/jpeg;base64,DSLR_24MP');
  assert.equal(canvases[0].width, 2160, '24MP 6000x4000 DSLR landscape scaled cleanly to 2160px');
  assert.equal(canvases[0].height, 1440);

  engine.cameraCaptureOrientation = 'portrait';
  await engine.enforceCaptureOrientationDataUrl('data:image/jpeg;base64,DSLR_24MP');
  assert.equal(canvases[1].width, 1440, '24MP 6000x4000 cropped & scaled to portrait 1440x2160');
  assert.equal(canvases[1].height, 2160);

  // 3. Test cleanupOldPrintSheets deletes stale sheet_*.png and keeps fresh ones
  const tmpDir = os.tmpdir();
  const stalePath = path.join(tmpDir, `mafaza_sheet_test_stale_${Date.now()}.png`);
  const freshPath = path.join(tmpDir, `mafaza_sheet_test_fresh_${Date.now()}.png`);
  fs.writeFileSync(stalePath, 'stale');
  fs.writeFileSync(freshPath, 'fresh');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stalePath, twoHoursAgo, twoHoursAgo);
  try {
    const cleanRes = cleanupOldPrintSheets(3600 * 1000, true);
    assert.ok(cleanRes.removedCount >= 1);
    assert.equal(fs.existsSync(stalePath), false, 'Stale print sheet PNG removed');
    assert.equal(fs.existsSync(freshPath), true, 'Fresh print sheet PNG kept');
  } finally {
    try { fs.unlinkSync(stalePath); } catch (e) {}
    try { fs.unlinkSync(freshPath); } catch (e) {}
  }

  // 4. Test sql.js debounced persistence batches rapid .run() calls cleanly
  const testDbPath = path.join(tmpDir, `mafaza_wasm_debounce_${Date.now()}.db`);
  try {
    const wasmDb = await createSqlJsDatabase(testDbPath, { debounceMs: 60, maxWaitMs: 300, registerShutdownHooks: false });
    wasmDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);');
    const beforeRunMtime = fs.statSync(testDbPath).mtimeMs;
    const stmt = wasmDb.prepare('INSERT INTO items (name) VALUES (?)');
    for (let i = 0; i < 10; i++) stmt.run(`item_${i}`);
    // Immediately available in RAM without waiting for debounce
    assert.equal(wasmDb.prepare('SELECT COUNT(*) as c FROM items').get().c, 10);
    // Explicit flush writes cleanly to disk
    wasmDb.flush();
    assert.ok(fs.statSync(testDbPath).mtimeMs >= beforeRunMtime);
    assert.ok(fs.statSync(testDbPath).size > 0);
  } finally {
    try { fs.unlinkSync(testDbPath); } catch (e) {}
  }
});

test('Package 1 & 2 fixes: expired cleanup, pass expiry, Gallery ZIP, 4x4 paper preset, and client print/state safety', async () => {
  const vm = await import('node:vm');
  const express = (await import('express')).default;
  const eventService = await import('../src/services/event.js');
  const qrService = await import('../src/services/qr.js');
  const { resolvePaper } = await import('../src/services/sheet.js');
  const { apiRouter } = await import('../src/routes/api.js');

  // 1. Test cleanupExpiredEventPhotos handles real DB schema (file_path, photo_session_id, audit_logs) cleanly
  const tenantId = 'tenant_studiokeren_01';
  const expiredEv = eventService.createEvent(tenantId, {
    name: 'Expired Audit Event',
    eventDate: '2020-01-01',
    autoDeleteAt: '2021-01-01T00:00:00.000Z'
  });
  const uploadsDir = path.join(process.cwd(), 'public/uploads');
  const dummyPhotoName = `test_expired_${Date.now()}.jpg`;
  const dummyPhotoPath = path.join(uploadsDir, dummyPhotoName);
  fs.writeFileSync(dummyPhotoPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  const expPass = await qrService.createGuestPass(tenantId, expiredEv.id, 'booth');
  const expSessId = `sess_exp_${Date.now()}`;
  const expAssetId = `asset_exp_${Date.now()}`;
  const expCapId = `cap_exp_${Date.now()}`;
  db.prepare(`INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, mode, status) VALUES (?, ?, ?, ?, 'single', 'completed')`)
    .run(expSessId, tenantId, expiredEv.id, expPass.id);
  db.prepare(`INSERT INTO captures (id, photo_session_id, pose_index, image_url) VALUES (?, ?, 1, ?)`)
    .run(expCapId, expSessId, `/uploads/${dummyPhotoName}`);
  db.prepare(`INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes) VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', ?, 128)`)
    .run(expAssetId, tenantId, expiredEv.id, expSessId, `/uploads/${dummyPhotoName}`);

  const cleanStats = eventService.cleanupExpiredEventPhotos();
  assert.ok(cleanStats.affectedEventsCount >= 1);
  assert.equal(fs.existsSync(dummyPhotoPath), false, 'Expired event photo unlinked from disk');
  assert.equal(db.prepare('SELECT id FROM photo_sessions WHERE id = ?').get(expSessId), undefined);
  assert.equal(db.prepare('SELECT id FROM captures WHERE id = ?').get(expCapId), undefined);

  // Clean up test event & pass
  db.prepare('DELETE FROM guest_passes WHERE id = ?').run(expPass.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(expiredEv.id);

  // 2. Test resolveGuestPass enforces expires_at
  const expiredPass = await qrService.createGuestPass(tenantId, 'event_wedding_dimas_sarah', 'booth');
  db.prepare("UPDATE guest_passes SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(expiredPass.id);
  assert.equal(qrService.resolveGuestPass(expiredPass.token_plain), null, 'Expired guest pass is rejected');
  db.prepare('DELETE FROM guest_passes WHERE id = ?').run(expiredPass.id);

  // 3. Test Gallery ZIP endpoints (/api/gallery/g/:token/zip and /api/gallery/s/:sessionId/zip)
  const zipPass = await qrService.createGuestPass(tenantId, 'event_wedding_dimas_sarah', 'booth');
  const zipSessId = `sess_zip_${Date.now()}`;
  const zipAssetId = `asset_zip_${Date.now()}`;
  const zipImgName = `test_zip_${Date.now()}.jpg`;
  const zipImgPath = path.join(uploadsDir, zipImgName);
  fs.writeFileSync(zipImgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  db.prepare(`INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, mode, status) VALUES (?, ?, 'event_wedding_dimas_sarah', ?, 'single', 'completed')`)
    .run(zipSessId, tenantId, zipPass.id);
  db.prepare(`INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes) VALUES (?, ?, 'event_wedding_dimas_sarah', ?, 'final_photo', 'print_hires', ?, 16)`)
    .run(zipAssetId, tenantId, zipSessId, `/uploads/${zipImgName}`);

  const app = express();
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  try {
    const rPassZip = await fetch(`http://127.0.0.1:${port}/api/gallery/g/${zipPass.token_plain}/zip`);
    assert.equal(rPassZip.status, 200);
    assert.match(rPassZip.headers.get('content-type') || '', /application\/zip/);
    const buf1 = Buffer.from(await rPassZip.arrayBuffer());
    assert.equal(buf1.subarray(0, 4).toString('hex'), '504b0304', 'Pass ZIP starts with PK header');

    const rSessZip = await fetch(`http://127.0.0.1:${port}/api/gallery/s/${zipSessId}/zip`);
    assert.equal(rSessZip.status, 200);
    const buf2 = Buffer.from(await rSessZip.arrayBuffer());
    assert.equal(buf2.subarray(0, 4).toString('hex'), '504b0304', 'Session ZIP starts with PK header');
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    try { fs.unlinkSync(zipImgPath); } catch (e) {}
    db.prepare('DELETE FROM media_assets WHERE id = ?').run(zipAssetId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(zipSessId);
    db.prepare('DELETE FROM guest_passes WHERE id = ?').run(zipPass.id);
  }

  // 4. Test 4x4 paper preset exists in sheet.js & Android 5R print routing in print-client.js
  assert.deepEqual(resolvePaper('4x4').widthIn, 4);
  assert.deepEqual(resolvePaper('4x4').heightIn, 4);

  const printClientSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/print-client.js'), 'utf8');
  const calls = [];
  const pCtx = vm.createContext({
    window: {
      focus() {}, print() { calls.push('window.print'); },
      addEventListener() {}, removeEventListener() {},
      MafazaAndroidBridge: {
        printPageWithOptions(paper, land) { calls.push({ paper, land }); }
      }
    },
    document: {
      head: { appendChild() {} },
      body: { classList: { add() {}, remove() {} }, appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ style: {}, innerHTML: '', textContent: '', classList: { add() {}, remove() {} } })
    },
    Image: class {
      set src(v) {
        this.naturalWidth = 2100;
        this.naturalHeight = 1500;
        setTimeout(() => this.onload?.(), 0);
      }
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { onLine: false },
    fetch: async () => ({ ok: true }),
    requestAnimationFrame: (fn) => fn(),
    AbortController, Promise, Math, Date, JSON, Array, Number, String, Boolean, setTimeout, clearTimeout
  });
  vm.runInContext(printClientSrc, pCtx);
  await pCtx.window.pbPrintViaBrowser({
    imageUrl: 'data:image/jpeg;base64,QQ==',
    copies: 1,
    job: { paperWidthIn: 5, paperHeightIn: 7 }
  });
  assert.deepEqual(calls[0], { paper: '5x7', land: true }, 'Android APK receives 5R landscape paper options');
});

test('Mingle finish print-order flow persists paper & copies offline -> server /complete -> Admin /photos/recent & quick-print prefill', async () => {
  const vm = await import('node:vm');
  const express = (await import('express')).default;
  const { apiRouter } = await import('../src/routes/api.js');
  const { createToken } = await import('../src/services/auth.js');

  // 1. Offline store supports requestedPrintPaper & requestedPrintCopies + updateOfflineSessionPrintOrder
  const offlineStoreSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/offline-store.js'), 'utf8');
  assert.match(offlineStoreSrc, /updateOfflineSessionPrintOrder\s*\(/);
  assert.match(offlineStoreSrc, /fd\.append\('requestedPrintCopies'/);
  assert.match(offlineStoreSrc, /fd\.append\('requestedPrintPaper'/);

  // 2. Backend /complete saves requested_print_paper & requested_print_copies WITHOUT premature print job, and /photos/recent exposes them
  const app = express();
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  const sessId = `sess_mgl_order_${Date.now()}`;
  let createdPassId = null;

  try {
    const fd = new FormData();
    fd.append('tenantId', 'tenant_studiokeren_01');
    fd.append('eventId', 'event_wedding_dimas_sarah');
    fd.append('mode', 'single');
    fd.append('printRequested', 'false');
    fd.append('requestedPrintPaper', '5R');
    fd.append('requestedPrintCopies', '3');
    fd.append('finalImage', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'final.jpg');

    const compRes = await fetch(`http://127.0.0.1:${port}/api/kiosk/sessions/${sessId}/complete`, { method: 'POST', body: fd });
    assert.equal(compRes.status, 200);
    const compJson = await compRes.json();
    assert.equal(compJson.printJob, null, 'Recording print order note must NOT auto-dispatch premature print job');
    assert.equal(compJson.requestedPrintPaper, '5x7');
    assert.equal(compJson.requestedPrintCopies, 3);
    createdPassId = compJson.guestPassId;

    const row = db.prepare('SELECT requested_print_paper, requested_print_copies FROM photo_sessions WHERE id = ?').get(sessId);
    assert.equal(row.requested_print_paper, '5x7');
    assert.equal(row.requested_print_copies, 3);

    const token = createToken({ id: 'user_admin_test', tenantId: 'tenant_studiokeren_01', role: 'admin', name: 'Tester' });
    const recentRes = await fetch(`http://127.0.0.1:${port}/api/photos/recent`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(recentRes.status, 200);
    const recentList = await recentRes.json();
    const matched = recentList.find(p => p.session_id === sessId);
    assert.ok(matched, 'Synced session appears in GET /api/photos/recent');
    assert.equal(matched.print_job_id, null);
    assert.equal(matched.requested_print_paper, '5x7');
    assert.equal(matched.requested_print_copies, 3);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    const assets = db.prepare('SELECT file_path FROM media_assets WHERE photo_session_id = ?').all(sessId);
    for (const a of assets) {
      if (a && a.file_path) {
        try { fs.unlinkSync(path.join(process.cwd(), 'public', a.file_path)); } catch (e) {}
      }
    }
    db.prepare('DELETE FROM media_assets WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
    if (createdPassId) db.prepare('DELETE FROM guest_passes WHERE id = ?').run(createdPassId);
  }

  // 3. Mingle UI: nextGuest opens #mingleFinishPrintOrderModal when no print dispatched yet, and Admin card displays requested print order
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  const mingleJs = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(process.cwd(), 'public/js/admin.js'), 'utf8');

  assert.match(mingleHtml, /id="mingleFinishPrintOrderModal"/);
  assert.match(mingleHtml, /onclick="mingle\.confirmFinishWithPrintOrder\(\)"/);
  assert.match(mingleHtml, /onclick="mingle\.confirmFinishDigitalOnly\(\)"/);
  assert.match(adminJs, /function getPhotoRequestedPrintOrder\(/);
  assert.match(adminJs, /📝 Pesanan Cetak/);
  assert.match(adminJs, /const defaultCopies = reqOrder \? reqOrder\.copies/);

  const orderModalEl = { style: { display: 'none' } };
  const btnSaveOrderEl = { innerText: '' };
  const finishQtyEl = { innerText: '1' };
  const offlineOrderCalls = [];
  const ctx = vm.createContext({
    window: {
      location: { origin: 'http://localhost', search: '' },
      addEventListener() {},
      pbOfflineStore: {
        async updateOfflineSessionPrintOrder(id, data) { offlineOrderCalls.push({ id, data }); return { id, ...data }; }
      }
    },
    document: {
      getElementById: (id) => {
        if (id === 'mingleFinishPrintOrderModal') return orderModalEl;
        if (id === 'mingleFinishSaveOrderBtn') return btnSaveOrderEl;
        if (id === 'mingleFinishOrderQty') return finishQtyEl;
        return null;
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { onLine: false },
    URLSearchParams, FormData, Promise, Math, Date, JSON, Array, Number, String, Boolean, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {}, console
  });
  vm.runInContext(mingleJs.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n'), ctx);
  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(engine, {
    capturedPhotos: ['data:image/jpeg;base64,QQ=='],
    filesOnlyMode: false,
    selectedTemplate: { id: 'tpl_1', name: 'Frame 5R', paper_format: '5R', orientation: 'landscape' },
    sessionId: 'sess_mgl_off_modal_1',
    _currentSyncSnap: { sessionId: 'sess_mgl_off_modal_1', photos: ['data:image/jpeg;base64,QQ=='], filesOnlyMode: false },
    _sessionPrintDispatched: false,
    _finishPrintOrderResolved: false,
    isLocalDirectMode: () => false,
    resetSessionCaptureState: () => { engine.capturedPhotos = []; engine.sessionId = null; },
    showToast: () => {},
    showScreen: () => {},
    stopLiveViewLoop: () => {},
    stopWebcam: () => {},
    setUsbMingleListen: () => {}
  });

  engine.nextGuest();
  assert.equal(orderModalEl.style.display, 'flex', 'nextGuest prompts print order modal when unprinted');
  assert.equal(engine.finishOrderPaper, '5R', 'Auto-detects 5R template in finish order modal');
  engine.adjustFinishOrderCopies(1);
  assert.match(btnSaveOrderEl.innerText, /5R · 2×/);

  await engine.confirmFinishWithPrintOrder();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(orderModalEl.style.display, 'none');
  assert.equal(offlineOrderCalls.length, 1);
  assert.equal(offlineOrderCalls[0].id, 'sess_mgl_off_modal_1');
  assert.equal(offlineOrderCalls[0].data.requestedPrintPaper, '5x7');
  assert.equal(offlineOrderCalls[0].data.requestedPrintCopies, 2);
});

test('Split Local Print vs Local Storage per-device isolation, Admin 313354 / session unlock, and Mingle framed gallery viewer', async () => {
  const vm = await import('node:vm');
  const express = (await import('express')).default;
  const { apiRouter } = await import('../src/routes/api.js');
  const { createToken } = await import('../src/services/auth.js');

  const adminJs = fs.readFileSync(path.join(process.cwd(), 'public/js/admin.js'), 'utf8');
  const kioskJs = fs.readFileSync(path.join(process.cwd(), 'public/js/kiosk.js'), 'utf8');
  const mingleJs = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const offlineJs = fs.readFileSync(path.join(process.cwd(), 'public/js/offline-store.js'), 'utf8');
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');

  // 1. Per-device isolation: admin.js does NOT persist localPrintMode onto shared event config
  assert.doesNotMatch(adminJs, /body:\s*JSON\.stringify\(\{\s*localPrintMode:/);
  assert.doesNotMatch(offlineJs, /window\.__pbEventLocalMode/);
  assert.match(adminJs, /function setDeviceLocalPrintMode\(/);

  // 2. Kiosk & Mingle cleanly split Cetak Lokal (pb_kiosk_local_print) from Tahan Upload (pb_kiosk_local_mode)
  const ls = new Map([['pb_kiosk_local_print', 'true']]);
  const baseCtxObj = {
    URL, URLSearchParams, AbortController, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
    navigator: { onLine: true, mediaDevices: null },
    document: { head: { appendChild() {} }, body: { classList: { toggle() {} } }, getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) },
    window: { location: { origin: 'http://localhost', search: '' }, addEventListener() {} },
    setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => fn(), console
  };
  const mCtx = vm.createContext({ ...baseCtxObj });
  vm.runInContext(mingleJs.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n'), mCtx);
  const mEng = vm.runInContext('Object.create(MingleBoothEngine.prototype)', mCtx);
  mEng.eventConfig = { localPrintMode: true }; // even if legacy field exists, device stays isolated!
  assert.equal(mEng.isLocalPrintMode(), true, 'pb_kiosk_local_print enables local device printing');
  assert.equal(mEng.isLocalStorageMode(), false, 'Cetak Lokal does NOT hold gallery uploads or QR from server');
  assert.equal(mEng.isLocalDirectMode(), false, 'Other devices or Cetak Lokal do not trigger offline storage hold');

  ls.set('pb_kiosk_local_print', 'false');
  assert.equal(mEng.isLocalPrintMode(), false, 'Server eventConfig.localPrintMode cannot infect another device');
  assert.equal(mEng.isLocalStorageMode(), false);

  const kCtx = vm.createContext({ ...baseCtxObj });
  vm.runInContext(kioskJs.replace(/\n\/\/ Global kiosk instance[\s\S]*$/, '\n'), kCtx);
  const kEng = vm.runInContext('Object.create(KioskEngine.prototype)', kCtx);
  kEng.eventConfig = { localPrintMode: true };
  ls.set('pb_kiosk_local_print', 'true');
  assert.equal(kEng.isLocalPrintMode(), true);
  assert.equal(kEng.isLocalStorageMode(), false);

  // 3. Both Mingle and Kiosk have Hasil Foto gallery viewer buttons + shared event-gallery-viewer.js
  const kioskHtml = fs.readFileSync(path.join(process.cwd(), 'public/kiosk.html'), 'utf8');
  const galleryViewerJs = fs.readFileSync(path.join(process.cwd(), 'public/js/event-gallery-viewer.js'), 'utf8');
  assert.match(mingleHtml, /id="btnMingleEventPhotos"[^>]*openEventPhotosModal\(\)/);
  assert.match(mingleHtml, /id="btnMingleWelcomeEventPhotos"[^>]*openEventPhotosModal\(\)/);
  assert.match(kioskHtml, /id="btnKioskEventPhotos"[^>]*openEventPhotosModal\(\)/);
  assert.match(mingleHtml, /src="\/js\/event-gallery-viewer\.js/);
  assert.match(kioskHtml, /src="\/js\/event-gallery-viewer\.js/);
  assert.match(galleryViewerJs, /pbEventPhotosModal/);
  assert.match(mingleJs, /MafazaEventGalleryViewer\.open\(/);
  assert.match(kioskJs, /MafazaEventGalleryViewer\.open\(/);

  // 4. Express endpoints: /kiosk/admin-session, /kiosk/verify-operator-pin (accepts 313354 + authed cookie), /kiosk/gallery/recent
  const app = express();
  app.use((req, res, next) => {
    req.cookies = {};
    const h = req.headers.cookie;
    if (h) {
      h.split(';').forEach(c => {
        const idx = c.indexOf('=');
        if (idx !== -1) {
          const k = c.substring(0, idx).trim();
          const v = c.substring(idx + 1).trim();
          try { req.cookies[k] = decodeURIComponent(v); } catch (e) { req.cookies[k] = v; }
        }
      });
    }
    next();
  });
  app.use(express.json());
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  const sessId = `sess_mgl_gallery_${Date.now()}`;
  const assetId = `asset_mgl_gallery_${Date.now()}`;
  let passId = null;

  try {
    const anonSess = await fetch(`http://127.0.0.1:${port}/api/kiosk/admin-session`);
    assert.equal(anonSess.status, 200);
    assert.equal((await anonSess.json()).authenticated, false);

    const adminJwt = createToken({ userId: 'u_admin', tenantId: 'tenant_studiokeren_01', role: 'super_admin' });
    const authedSess = await fetch(`http://127.0.0.1:${port}/api/kiosk/admin-session`, {
      headers: { Cookie: `pb_admin_auth=${encodeURIComponent(adminJwt)}` }
    });
    assert.equal(authedSess.status, 200);
    assert.equal((await authedSess.json()).authenticated, true);

    // Wrong PIN rejected
    const badPin = await fetch(`http://127.0.0.1:${port}/api/kiosk/verify-operator-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000' })
    });
    assert.equal(badPin.status, 401);

    // Admin password 313354 accepted and issues auth cookie
    const goodAdminPass = await fetch(`http://127.0.0.1:${port}/api/kiosk/verify-operator-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '313354' })
    });
    assert.equal(goodAdminPass.status, 200);
    assert.equal((await goodAdminPass.json()).valid, true);
    assert.match(goodAdminPass.headers.get('set-cookie') || '', /pb_admin_auth=/);

    // Mingle gallery recent works without Admin login and returns framed photo + QR link
    const fd = new FormData();
    fd.append('tenantId', 'tenant_studiokeren_01');
    fd.append('eventId', 'event_wedding_dimas_sarah');
    fd.append('mode', 'single');
    fd.append('printRequested', 'false');
    fd.append('requestedPrintPaper', '5R');
    fd.append('requestedPrintCopies', '2');
    fd.append('finalImage', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'framed.jpg');
    const cRes = await fetch(`http://127.0.0.1:${port}/api/kiosk/sessions/${sessId}/complete`, { method: 'POST', body: fd });
    assert.equal(cRes.status, 200);
    passId = (await cRes.json()).guestPassId;

    const gRes = await fetch(`http://127.0.0.1:${port}/api/kiosk/gallery/recent?eventId=event_wedding_dimas_sarah`);
    assert.equal(gRes.status, 200);
    const gList = await gRes.json();
    const found = gList.find(x => x.session_id === sessId);
    assert.ok(found, 'Kiosk/Mingle recent framed gallery returns newly synced framed photo');
    assert.match(found.galleryUrl || '', /^\/gallery\/g\//);
    assert.equal(found.requested_print_paper, '5x7');
    assert.equal(found.requested_print_copies, 2);

    // Shared scannable QR popup endpoint returns QR PNG data URL without Admin login
    const qrRes = await fetch(`http://127.0.0.1:${port}/api/kiosk/gallery/qr?sessionId=${encodeURIComponent(sessId)}`);
    assert.equal(qrRes.status, 200);
    const qrJson = await qrRes.json();
    assert.match(qrJson.qrDataUrl || '', /^data:image\/png;base64,/);
    assert.equal(qrJson.galleryUrl, found.galleryUrl);
    assert.match(galleryViewerJs, /pbEventPhotoQrModal[\s\S]*z-index:\s*10065/);
    assert.match(galleryViewerJs, /pbEventPhotoZoomQrBtn[\s\S]*Tampilkan QR/);
    assert.match(galleryViewerJs, /\/api\/kiosk\/gallery\/qr/);
    // Canon reconnect status uses un-mirrored HTML overlay rather than fillText on mirrored canvas
    assert.match(kioskJs, /id\s*=\s*'canonUsbReconnectOverlay'/);
    assert.doesNotMatch(kioskJs, /ctx\.fillText\(['"]Menyambung ulang ke Canon/);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    const assets = db.prepare('SELECT file_path FROM media_assets WHERE photo_session_id = ?').all(sessId);
    for (const a of assets) {
      if (a && a.file_path) {
        try { fs.unlinkSync(path.join(process.cwd(), 'public', a.file_path)); } catch (e) {}
      }
    }
    db.prepare('DELETE FROM media_assets WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
    if (passId) db.prepare('DELETE FROM guest_passes WHERE id = ?').run(passId);
  }
});

test('Windows All-in-One Suite bundles Kiosk, Print Agent, Canon Bridge, and AutoStart securely', async () => {
  const zlib = await import('node:zlib');
  const express = (await import('express')).default;
  const { apiRouter } = await import('../src/routes/api.js');
  const { createToken } = await import('../src/services/auth.js');
  const appBuilder = await import('../src/services/appBuilder.js');

  const root = process.cwd();
  const adminHtml = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(root, 'public/js/admin.js'), 'utf8');
  assert.match(adminHtml, /id="btnDownloadWindowsAllInOne"[^>]*href="\/api\/apps\/download\/windows-suite"/);
  assert.match(adminJs, /btnDownloadWindowsAllInOne[\s\S]*\/api\/apps\/download\/windows-suite/);

  const app = express();
  app.use((req, res, next) => { req.cookies = {}; next(); });
  app.use(express.json());
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;

  try {
    const unauth = await fetch(`http://127.0.0.1:${port}/api/apps/download/windows-suite`);
    assert.equal(unauth.status, 401, 'All-in-One Windows suite embeds secret agentKey so requires Admin auth');

    const adminJwt = createToken({ userId: 'u_admin', tenantId: 'tenant_studiokeren_01', role: 'super_admin' });
    const target = 'https://mafaza.galipatsistem.com';
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/download/windows-suite?serverUrl=${encodeURIComponent(target)}&token=${encodeURIComponent(adminJwt)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/zip/);
    assert.match(res.headers.get('content-disposition') || '', /Mafaza-Photobooth-AllInOne-Windows\.zip/);

    const zipBuf = Buffer.from(await res.arrayBuffer());
    assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, 'Valid ZIP local file header signature');

    // Parse entries directly from the ZIP stream
    const files = new Map();
    let off = 0;
    while (off + 30 <= zipBuf.length && zipBuf.readUInt32LE(off) === 0x04034b50) {
      const method = zipBuf.readUInt16LE(off + 8);
      const compSize = zipBuf.readUInt32LE(off + 18);
      const nameLen = zipBuf.readUInt16LE(off + 26);
      const extraLen = zipBuf.readUInt16LE(off + 28);
      const name = zipBuf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
      const dataStart = off + 30 + nameLen + extraLen;
      const raw = zipBuf.subarray(dataStart, dataStart + compSize);
      const content = method === 8 ? zlib.inflateRawSync(raw) : raw;
      files.set(name, content.toString('utf8'));
      off = dataStart + compSize;
    }

    for (const reqFile of [
      'PASANG-SEMUANYA-SEKALI-KLIK.bat',
      'Jalankan-Ulang-Semua-Layanan.bat',
      'Pasang-AutoBuka-Layar-Kiosk-Saat-Boot.bat',
      'Matikan-AutoStart.bat',
      'Mafaza-AutoStart-Services.vbs',
      'PANDUAN-INSTALASI-WINDOWS.txt',
      'kiosk/Photobooth-Kiosk-Aplikasi.vbs',
      'kiosk/Photobooth-Mingle-Aplikasi.vbs',
      'kiosk/Photobooth-Admin-Studio.bat',
      'kiosk/Photobooth-Kiosk-FullScreen.bat',
      'print-agent/mafaza-print-agent.mjs',
      'print-agent/Mafaza-Print-Agent.bat',
      'print-agent/config.json',
      'canon-bridge/MafazaCanonBridge.cs',
      'canon-bridge/Run-Bridge-Silent.bat'
    ]) {
      assert.ok(files.has(reqFile), `ZIP includes ${reqFile}`);
    }

    const cfg = JSON.parse(files.get('print-agent/config.json'));
    assert.equal(cfg.server, target);
    assert.ok(cfg.key && cfg.key.length > 8, 'Embedded agentKey populated for silent Print Agent');
    const installBat = files.get('PASANG-SEMUANYA-SEKALI-KLIK.bat');
    assert.match(installBat, /C:\\MafazaPhotobooth/);
    assert.match(installBat, /Mafaza-AutoStart-Services\.vbs/);
    assert.match(installBat, /:err_not_extracted/);
    assert.match(installBat, /:end_pause[\s\S]*\bpause\s*$/);
    assert.doesNotMatch(installBat, /(?:^|\n)\s*(?:if|else)\b[^\n]*\(\s*(?:\r?\n|$)/i, 'PASANG-SEMUANYA-SEKALI-KLIK.bat uses flat goto labels without multi-line cmd.exe if(...) parse hazards');
    assert.match(files.get('kiosk/Photobooth-Kiosk-FullScreen.bat'), /https:\/\/mafaza\.galipatsistem\.com/);
    assert.equal(typeof appBuilder.buildWindowsAllInOneZip, 'function');
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('All-in-One Windows Print Agent stays safe in camera-only mode without claiming remote jobs or using PDF virtual printer', async () => {
  const express = (await import('express')).default;
  const { apiRouter } = await import('../src/routes/api.js');
  const printService = await import('../src/services/print.js');
  const agent = await import('../print-agent/mafaza-print-agent.mjs');

  const virtualPdf = { id: 'Microsoft Print to PDF', name: 'Microsoft Print to PDF', driverName: 'Microsoft Print To PDF', status: 'idle', isDefault: true };
  const virtualXps = { id: 'Microsoft XPS Document Writer', name: 'Microsoft XPS Document Writer', status: 'idle', isDefault: false };
  const offlineEpson = { id: 'Epson L8050 Series', name: 'Epson L8050 Series', status: 'offline', isDefault: false };
  const onlineEpson = { id: 'Epson L8050 Series', name: 'Epson L8050 Series', status: 'idle', isDefault: false };

  assert.equal(agent.isVirtualPrinter(virtualPdf), true);
  assert.equal(agent.isVirtualPrinter(virtualXps), true);
  assert.equal(agent.isVirtualPrinter(onlineEpson), false);

  assert.equal(agent.getReadyPhysicalPrinters([virtualPdf, virtualXps]).length, 0);
  assert.equal(agent.getReadyPhysicalPrinters([virtualPdf, offlineEpson]).length, 0);
  assert.equal(agent.getReadyPhysicalPrinters([virtualPdf, onlineEpson]).length, 1);
  assert.equal(agent.resolvePrinter([virtualPdf, virtualXps], {}), null, 'Never falls back to Microsoft Print to PDF when no physical printer exists');
  assert.equal(agent.resolvePrinter([virtualPdf, onlineEpson], {})?.name, 'Epson L8050 Series');

  const canonCs = fs.readFileSync(path.join(process.cwd(), 'canon-bridge/windows/MafazaCanonBridge.cs'), 'utf8');
  assert.match(canonCs, /List<string>\s+candidates\s*=\s*new\s+List<string>\(\)/, 'Canon Bridge retries across all discovered EDSDK.dll candidates');

  const app = express();
  app.use((req, res, next) => { req.cookies = {}; next(); });
  app.use(express.json());
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';
  const agentKey = printService.getOrCreateAgentKey(tenantId);
  const ts = Date.now();
  const sessId = `sess_cam_iso_${ts}`;
  const assetId = `asset_cam_iso_${ts}`;
  const jobId = `job_cam_only_${ts}`;

  try {
    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, mode, status)
      VALUES (?, ?, ?, 'single', 'completed')
    `).run(sessId, tenantId, eventId);
    db.prepare(`
      INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, status)
      VALUES (?, ?, ?, ?, 'final_photo', 'framed', 'uploads/test_cam_iso.jpg', 'ready')
    `).run(assetId, tenantId, eventId, sessId);
    db.prepare(`
      INSERT INTO print_jobs (id, tenant_id, event_id, photo_session_id, media_asset_id, copies, state, options_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 'queued', '{"printerName":"Epson L8050 Series"}', datetime('now'), datetime('now'))
    `).run(jobId, tenantId, eventId, sessId, assetId);

    // Camera-only poll FIRST (no physical printer connected -> canClaim: false)
    const camFirst = await fetch(`http://127.0.0.1:${port}/api/print-agent/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
      body: JSON.stringify({ host: 'LAPTOP-KAMERA', platform: 'win32', printers: [], canClaim: false })
    });
    assert.equal(camFirst.status, 200);
    assert.equal((await camFirst.json()).jobs.length, 0, 'Camera-only laptop with no physical printer must NOT claim remote jobs');
    assert.equal(printService.getAgentStatus(tenantId).online, false, 'Camera-only laptop without physical printer is standby (not reported as ready printer agent)');

    // Tenda laptop with Epson L8050 Series connected (canClaim: true) claims the job cleanly
    const tendaPoll = await fetch(`http://127.0.0.1:${port}/api/print-agent/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
      body: JSON.stringify({ host: 'LAPTOP-TENDA', platform: 'win32', printers: [onlineEpson], canClaim: true })
    });
    assert.equal(tendaPoll.status, 200);
    const tendaJson = await tendaPoll.json();
    assert.ok(tendaJson.jobs.some(j => j.id === jobId), 'Tenda laptop with ready Epson printer claims the queued print job');

    // Reset job back to queued and verify camera-only poll afterward neither steals jobs nor clobbers Tenda status
    db.prepare("UPDATE print_jobs SET state = 'queued' WHERE id = ?").run(jobId);
    const camSecond = await fetch(`http://127.0.0.1:${port}/api/print-agent/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
      body: JSON.stringify({ host: 'LAPTOP-KAMERA', platform: 'win32', printers: [], canClaim: false })
    });
    assert.equal(camSecond.status, 200);
    assert.equal((await camSecond.json()).jobs.length, 0);

    const status = printService.getAgentStatus(tenantId);
    assert.equal(status.online, true);
    assert.equal(status.host, 'LAPTOP-TENDA', 'Camera-only poll does not overwrite active Tenda printer host');
    assert.equal(status.printers[0]?.name, 'Epson L8050 Series');
  } finally {
    db.prepare('DELETE FROM print_jobs WHERE id = ?').run(jobId);
    db.prepare('DELETE FROM media_assets WHERE id = ?').run(assetId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('Mingle result photo picker stays intact across session reset and lets operator pick from 2+ captured photos', async () => {
  const vm = await import('node:vm');
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const trimmed = mingleSrc.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');

  assert.match(mingleHtml, /id="mingleResultSlotBar"/);
  assert.match(mingleHtml, /id="mingleResultSlotHint"/);
  assert.match(mingleHtml, /id="mingleResultSlotTabs"/);
  assert.match(mingleHtml, /id="mingleResultPhotoPicker"/);
  assert.match(mingleHtml, /\/js\/mingle\.js\?v=4\.1/);

  const createEl = (id) => ({
    id,
    style: { display: 'none' },
    _innerHTML: '',
    innerText: '',
    src: '',
    removeAttribute(attr) { if (attr === 'src') this.src = ''; }
  });

  const elements = new Map([
    ['mingleResultSlotBar', createEl('mingleResultSlotBar')],
    ['mingleResultSlotHint', createEl('mingleResultSlotHint')],
    ['mingleResultSlotTabs', createEl('mingleResultSlotTabs')],
    ['mingleResultPhotoPicker', createEl('mingleResultPhotoPicker')],
    ['mingleCapturedStrip', createEl('mingleCapturedStrip')],
    ['mingleReadyStripRow', createEl('mingleReadyStripRow')],
    ['mingleFilesStrip', createEl('mingleFilesStrip')],
    ['mingleQrTapHint', createEl('mingleQrTapHint')],
    ['mingleQrImg', createEl('mingleQrImg')]
  ]);

  // Simulate DOM tree removal if parent slotBar.innerHTML is mistakenly cleared
  const slotBarEl = elements.get('mingleResultSlotBar');
  Object.defineProperty(slotBarEl, 'innerHTML', {
    get() { return this._innerHTML; },
    set(val) {
      this._innerHTML = val;
      if (val === '') {
        elements.delete('mingleResultSlotHint');
        elements.delete('mingleResultSlotTabs');
        elements.delete('mingleResultPhotoPicker');
      } else {
        if (/id="mingleResultSlotHint"/.test(val)) elements.set('mingleResultSlotHint', createEl('mingleResultSlotHint'));
        if (/id="mingleResultSlotTabs"/.test(val)) elements.set('mingleResultSlotTabs', createEl('mingleResultSlotTabs'));
        if (/id="mingleResultPhotoPicker"/.test(val)) elements.set('mingleResultPhotoPicker', createEl('mingleResultPhotoPicker'));
      }
    }
  });

  const ctx = vm.createContext({
    window: { location: { origin: 'http://localhost', search: '' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { onLine: true, mediaDevices: {} },
    URL,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval, console
  });
  vm.runInContext(trimmed, ctx);

  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  let renderCanvasCalls = 0;
  let syncFinalCalls = 0;
  Object.assign(engine, {
    capturedPhotos: [],
    activeSlots: [{ x: 0, y: 0, width: 1800, height: 1200, pose_index: 1 }],
    slotAssignments: [],
    slotTransforms: [],
    selectedSlotIdx: 0,
    filesOnlyMode: false,
    renderResultCanvas: async () => { renderCanvasCalls++; },
    syncFinalImageOnly: async () => { syncFinalCalls++; }
  });

  // 1. resetSessionCaptureState must NOT destroy child picker elements
  engine.resetSessionCaptureState();
  assert.equal(slotBarEl.style.display, 'none');
  assert.ok(elements.get('mingleResultSlotTabs'), 'resetSessionCaptureState must preserve #mingleResultSlotTabs');
  assert.ok(elements.get('mingleResultPhotoPicker'), 'resetSessionCaptureState must preserve #mingleResultPhotoPicker');

  // 2. Taking 2 photos on a 1-slot frame displays BOTH photos in the Result picker
  engine.capturedPhotos = ['data:image/jpeg;base64,ONE', 'data:image/jpeg;base64,TWO'];
  engine.slotAssignments = [0];
  engine.renderResultSlotBar();

  assert.equal(slotBarEl.style.display, 'flex', 'Slot picker bar must be visible when capturedPhotos > 1');
  assert.match(elements.get('mingleResultSlotHint').innerText, /Slot #1.*2 foto/);
  assert.match(elements.get('mingleResultSlotTabs').innerHTML, /Slot #1 \(Foto #1\)/);
  assert.match(elements.get('mingleResultPhotoPicker').innerHTML, /assignPhotoToActiveSlot\(0\)/);
  assert.match(elements.get('mingleResultPhotoPicker').innerHTML, /assignPhotoToActiveSlot\(1\)/);

  // 3. Clicking photo #2 switches slot assignment, redraws canvas & re-syncs gallery output
  await engine.assignPhotoToActiveSlot(1);
  assert.equal(engine.slotAssignments[0], 1);
  assert.equal(renderCanvasCalls, 1);
  assert.equal(syncFinalCalls, 1);
  assert.match(elements.get('mingleResultSlotTabs').innerHTML, /Slot #1 \(Foto #2\)/);
  assert.match(
    elements.get('mingleResultPhotoPicker').innerHTML,
    /mingle-thumb-item active"\s+onclick="mingle\.assignPhotoToActiveSlot\(1\)"/
  );
});

test('Printed sheets always stamp configured QR codes across Editor save, Browser sheet, Reprint, Kiosk & Mingle local print', async () => {
  const express = (await import('express')).default;
  const { apiRouter } = await import('../src/routes/api.js');
  const { createToken } = await import('../src/services/auth.js');
  const printService = await import('../src/services/print.js');
  const sheet = await import('../src/services/sheet.js');
  const vm = await import('node:vm');

  const tenantId = 'tenant_studiokeren_01';
  const eventId = 'event_wedding_dimas_sarah';
  const ts = Date.now();

  // 1. Admin template save: non-empty qrCoords prevents contradictory qr_position='none'
  const tpl = templateService.createTemplate(tenantId, {
    name: `QR Save Test ${ts}`,
    eventId,
    boothMode: 'both',
    formatPreset: 'portrait',
    width: 1024,
    height: 1536,
    qrPosition: 'none',
    qrCoords: [
      { id: 'qr_1', x: 20, y: 1380, size: 110 },
      { id: 'qr_2', x: 530, y: 1380, size: 110 }
    ]
  });
  assert.equal(tpl.qr_position, 'bottom-right', 'Non-empty qrCoords prevents qr_position=none');
  assert.equal(tpl.qr_coords.length, 2);

  // Switch back to 'none' cleanly when qrCoords updated with empty + non-none
  const updatedContradictory = templateService.updateTemplateSlots(
    tpl.id, tenantId, [], null, 'none', 1024, 1536, '1', 'both', 'portrait', '4R',
    [{ id: 'qr_1', x: 24, y: 1390, size: 115 }, { id: 'qr_2', x: 534, y: 1390, size: 115 }]
  );
  assert.equal(updatedContradictory.qr_position, 'bottom-right');
  assert.equal(updatedContradictory.qr_coords.length, 2);

  // 2. Test GET /api/photos/:assetId/sheet & reprintJob live template refresh
  const uploadsDir = path.join(process.cwd(), 'public/uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const fakeImgFile = `test_qr_sheet_${ts}.png`;
  const fakeImgRel = `/uploads/${fakeImgFile}`;
  const fakeImgAbs = path.join(uploadsDir, fakeImgFile);
  // Solid warm beige background so any black/white QR card stands out clearly
  const bgBuf = Buffer.alloc(1024 * 1536 * 4);
  for (let i = 0; i < bgBuf.length; i += 4) {
    bgBuf[i] = 200; bgBuf[i + 1] = 175; bgBuf[i + 2] = 140; bgBuf[i + 3] = 255;
  }
  fs.writeFileSync(fakeImgAbs, sheet.encodePng({ width: 1024, height: 1536, channels: 4, data: bgBuf }));

  const sessId = `sess_qr_print_${ts}`;
  const assetId = `asset_qr_print_${ts}`;
  let initialJobId = null;
  let reprintedJobId = null;

  const app = express();
  app.use((req, res, next) => { req.cookies = {}; next(); });
  app.use(express.json());
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  const adminToken = createToken({ userId: 'user_business_owner_01', email: 'owner@studiokeren.id', role: 'super_admin', tenantId });

  try {
    // Initially start with template QR disabled to simulate first print BEFORE QR was added
    templateService.updateTemplateSlots(tpl.id, tenantId, [], null, 'none', 1024, 1536, '1', 'both', 'portrait', '4R', []);

    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, template_id, mode, status)
      VALUES (?, ?, ?, NULL, ?, 'multi', 'completed')
    `).run(sessId, tenantId, eventId, tpl.id);
    db.prepare(`
      INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, status)
      VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', ?, 'ready')
    `).run(assetId, tenantId, eventId, sessId, fakeImgRel);

    // First job created BEFORE template had QR -> old options had qrPosition='none'
    const firstJob = printService.createPrintJob(tenantId, eventId, null, sessId, assetId, 1, { paperSize: '4x6' });
    initialJobId = firstJob.printJobId;

    // Operator enables 2 QRs on Template in Admin
    templateService.updateTemplateSlots(
      tpl.id, tenantId, [], null, 'bottom-right', 1024, 1536, '1', 'both', 'portrait', '4R',
      [{ id: 'qr_1', x: 24, y: 1390, size: 115 }, { id: 'qr_2', x: 534, y: 1390, size: 115 }]
    );

    // 2a. GET /api/photos/:assetId/sheet stamps BOTH QRs onto the PNG sheet cleanly & auto-issues pass
    const sheetRes = await fetch(`http://127.0.0.1:${port}/api/photos/${assetId}/sheet?paperSize=4x6`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(sheetRes.status, 200);
    const sheetBuf = Buffer.from(await sheetRes.arrayBuffer());
    const decodedSheet = sheet.decodePng(sheetBuf);
    assert.equal(decodedSheet.width, 1200);
    assert.equal(decodedSheet.height, 1800);

    // Check both QR positions inside safe-margin 90% sheet (~60 + 24*1.054=85..195 & ~60 + 534*1.054=622..732, Y ~72 + 1390*1.054=1537..1650)
    const countBlackWhitePixels = (x0, y0, x1, y1) => {
      let black = 0, white = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * decodedSheet.width + x) * decodedSheet.channels;
          const r = decodedSheet.data[i], g = decodedSheet.data[i + 1], b = decodedSheet.data[i + 2];
          if (r < 20 && g < 20 && b < 20) black++;
          else if (r > 240 && g > 240 && b > 240) white++;
        }
      }
      return { black, white };
    };
    const leftQrStats = countBlackWhitePixels(75, 1525, 220, 1675);
    const rightQrStats = countBlackWhitePixels(610, 1525, 760, 1675);
    assert.ok(leftQrStats.black > 200 && leftQrStats.white > 200, `Left QR #1 must be stamped on browser sheet (${JSON.stringify(leftQrStats)})`);
    assert.ok(rightQrStats.black > 200 && rightQrStats.white > 200, `Right QR #2 must be stamped on browser sheet (${JSON.stringify(rightQrStats)})`);

    // 2b. reprintJob refreshes live template QR settings & picks up qrUrl even after template update
    const rep = printService.reprintJob(initialJobId, tenantId, 'user_business_owner_01', 1, {
      baseUrl: `http://127.0.0.1:${port}`
    });
    reprintedJobId = rep.printJobId;
    const repRow = db.prepare('SELECT options_json FROM print_jobs WHERE id = ?').get(reprintedJobId);
    const repOpts = JSON.parse(repRow.options_json);
    assert.equal(repOpts.qrPosition, 'bottom-right', 'reprintJob uses refreshed live template qr_position');
    assert.equal(repOpts.qrCoords.length, 2, 'reprintJob uses refreshed live template 2 qr_coords');
    assert.ok(repOpts.qrUrl && repOpts.qrUrl.includes('/gallery/g/'), 'reprintJob guarantees valid qrUrl');

    // 3. Static checks across Admin, Kiosk, Mingle & print-client
    const adminJs = fs.readFileSync(path.join(process.cwd(), 'public/js/admin.js'), 'utf8');
    const kioskJs = fs.readFileSync(path.join(process.cwd(), 'public/js/kiosk.js'), 'utf8');
    const printClientJs = fs.readFileSync(path.join(process.cwd(), 'public/js/print-client.js'), 'utf8');
    const mingleJs = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');

    assert.doesNotMatch(kioskJs, /readyRow\.style\.display = isLocal \?/, 'No undefined isLocal ReferenceError in kiosk modal');
    assert.match(adminJs, /\/api\/photos\/\$\{encodeURIComponent\((?:photo|activeModalPhoto)\.asset_id\)\}\/sheet/);
    assert.match(printClientJs, /includes\('\?'\)/, 'print-client appends &t= cleanly when sheetUrl has query params');

    // 4. Mingle buildPrintableDataUrl waits for in-flight guest pass sync before stamping QR
    const trimmedMingle = mingleJs.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');
    const fakeQrImg = { complete: true, naturalWidth: 260, src: 'data:image/png;base64,FAKEQR' };
    const mainCanvas = { width: 1024, height: 1536 };
    const outCanvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, fillRect() {} }), toDataURL: () => 'data:image/png;base64,OUT' };
    const domMap = new Map([
      ['mingleFinalCanvas', mainCanvas],
      ['mingleQrImg', { src: '', style: {}, complete: false, naturalWidth: 0 }],
      ['mingleQrPlaceholder', { style: {} }],
      ['mingleQrTapHint', { style: {} }],
      ['mingleGalleryLink', { style: {}, href: '' }]
    ]);
    const mCtx = vm.createContext({
      URL, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
      Image: class { set src(v) { this.naturalWidth = 260; this.complete = true; if (this.onload) this.onload(); } },
      window: { location: { origin: 'http://localhost', search: '' }, addEventListener: () => {} },
      document: {
        getElementById: (id) => domMap.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => outCanvas,
        addEventListener: () => {}
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { onLine: true, mediaDevices: {} },
      fetch: async () => ({ ok: true, json: async () => ({ id: 'gp_fast', token: 'tok_fast', qrDataUrl: 'data:image/png;base64,QRFAST' }) }),
      setTimeout, clearTimeout, setInterval, clearInterval, console
    });
    vm.runInContext(trimmedMingle, mCtx);
    const mEngine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', mCtx);
    const drawnCalls = [];
    Object.assign(mEngine, {
      tenantId, eventId, guestPass: null,
      selectedTemplate: { id: tpl.id, width: 1024, height: 1536, qr_position: 'bottom-right', qr_coords: [{ id: 'qr_1', x: 20, y: 1380, size: 110 }, { id: 'qr_2', x: 530, y: 1380, size: 110 }] },
      _activeSyncPromise: new Promise(r => setTimeout(() => { mEngine.guestPass = { id: 'gp_late', token: 'tok_late', qrDataUrl: 'data:image/png;base64,QRLATE' }; r(); }, 40)),
      resolveMinglePrintableQrImage: async () => (mEngine.guestPass ? fakeQrImg : null),
      drawQrCardAt: (ctx, x, y, w, h, img, size) => drawnCalls.push({ x, y, size })
    });
    await mEngine.buildPrintableDataUrl();
    assert.equal(drawnCalls.length, 2, 'Mingle buildPrintableDataUrl awaits sync and draws both QR cards');
  } finally {
    const sessRow = db.prepare('SELECT guest_pass_id FROM photo_sessions WHERE id = ?').get(sessId);
    if (initialJobId) db.prepare('DELETE FROM print_jobs WHERE id = ?').run(initialJobId);
    if (reprintedJobId) db.prepare('DELETE FROM print_jobs WHERE id = ?').run(reprintedJobId);
    db.prepare('DELETE FROM media_assets WHERE id = ?').run(assetId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
    if (sessRow && sessRow.guest_pass_id) db.prepare('DELETE FROM guest_passes WHERE id = ?').run(sessRow.guest_pass_id);
    db.prepare('DELETE FROM template_versions WHERE template_id = ?').run(tpl.id);
    db.prepare('DELETE FROM templates WHERE id = ?').run(tpl.id);
    try { fs.unlinkSync(fakeImgAbs); } catch (e) {}
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('Mingle 3x Pose pauses for review/retake of pose #3 before entering Result screen, while 1x auto-advances', async () => {
  const vm = await import('node:vm');
  const mingleSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');
  const trimmed = mingleSrc.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');

  const createEl = (id) => ({ id, style: {}, innerText: '', innerHTML: '' });
  const dom = new Map([
    ['mingleShotsProgressPill', createEl('mingleShotsProgressPill')],
    ['btnMingleFinishSession', createEl('btnMingleFinishSession')],
    ['mingleReadyStripWrap', createEl('mingleReadyStripWrap')],
    ['mingleCapturedStrip', createEl('mingleCapturedStrip')],
    ['mingleStripCountLabel', createEl('mingleStripCountLabel')],
    ['mingleWaitDesc', createEl('mingleWaitDesc')]
  ]);

  const ctx = vm.createContext({
    URL, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    window: { location: { origin: 'http://localhost', search: '' }, addEventListener: () => {} },
    document: { getElementById: (id) => dom.get(id) || null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { onLine: true, mediaDevices: {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval, console
  });
  vm.runInContext(trimmed, ctx);

  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  let finishCalls = 0;
  let overlayStates = [];
  let viewfinderSynced = 0;
  const toasts = [];
  Object.assign(engine, {
    capturedPhotos: [],
    syncedCaptureCount: 0,
    activeTargetShots: 3,
    currentScreen: 'screenMingleReady',
    finishCaptureSession: async () => { finishCalls++; },
    setProcessingOverlay: (v) => { overlayStates.push(Boolean(v)); },
    syncViewfinderForReadyScreen: () => { viewfinderSynced++; },
    showToast: (msg) => { toasts.push(msg); }
  });

  // 1. Capture 3 poses in 3x Pose mode -> must NOT auto-enter finishCaptureSession()
  await engine.finalizeCapturedDataUrl('data:image/jpeg;base64,POSE1');
  await engine.finalizeCapturedDataUrl('data:image/jpeg;base64,POSE2');
  await engine.finalizeCapturedDataUrl('data:image/jpeg;base64,POSE3_BAD');

  assert.equal(finishCalls, 0, '3x Pose must pause on Ready screen after shot #3 instead of auto-entering Result');
  assert.equal(engine.capturedPhotos.length, 3);
  assert.equal(dom.get('btnMingleFinishSession').style.display, 'block');
  assert.match(dom.get('btnMingleFinishSession').innerText, /3\/3/);
  assert.match(dom.get('mingleShotsProgressPill').innerText, /3 \/ 3 Foto Siap/);
  assert.ok(viewfinderSynced >= 3);

  // 2. Delete bad pose #3 and re-capture new pose #3 -> stays at 3/3 ready to confirm
  engine.deleteCapturedPhoto(2);
  assert.equal(engine.capturedPhotos.length, 2);
  assert.match(dom.get('mingleShotsProgressPill').innerText, /2 \/ 3 Foto/);

  await engine.finalizeCapturedDataUrl('data:image/jpeg;base64,POSE3_GOOD');
  assert.equal(finishCalls, 0, 'After retaking pose #3, still waits for operator confirmation button');
  assert.equal(engine.capturedPhotos.length, 3);
  assert.equal(engine.capturedPhotos[2], 'data:image/jpeg;base64,POSE3_GOOD');

  // 3. 1x Langsung Jadi still transitions directly after 1 shot
  engine.capturedPhotos = [];
  engine.activeTargetShots = 1;
  await engine.finalizeCapturedDataUrl('data:image/jpeg;base64,SINGLE');
  assert.equal(finishCalls, 1, '1x single-shot mode finishes automatically after 1 photo');
});

test('Offline uploadSession automatically falls back to lightweight single-file uploads when multi-file batch hits Failed to fetch', async () => {
  const vm = await import('node:vm');
  const offlineSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/offline-store.js'), 'utf8');
  const requests = [];

  class FakeFormData {
    constructor() { this.fields = []; }
    append(k, v, name) { this.fields.push({ k, v, name }); }
  }

  const tinyJpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const mockIdb = {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          transaction() {
            return {
              objectStore() {
                return {
                  getAll() {
                    const r = {};
                    setTimeout(() => { r.result = []; if (r.onsuccess) r.onsuccess(); }, 0);
                    return r;
                  }
                };
              }
            };
          }
        };
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
  const oCtx = vm.createContext({
    indexedDB: mockIdb,
    window: { addEventListener: () => {} },
    document: { addEventListener: () => {}, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { onLine: true },
    FormData: FakeFormData,
    Blob: globalThis.Blob,
    AbortController: globalThis.AbortController,
    atob: globalThis.atob,
    Uint8Array, Promise, Math, Date, JSON, Array, Number, String, Boolean,
    setTimeout, clearTimeout, setInterval: () => 1, console,
    fetch: async (url, opts) => {
      const capFields = opts.body.fields.filter(f => f.k === 'captures');
      const finalFields = opts.body.fields.filter(f => f.k === 'finalImage');
      // Simulate Cloudflare/proxy dropping combined multi-photo batch (>1 file in a POST) with TypeError: Failed to fetch
      if (capFields.length > 1 || (capFields.length >= 1 && finalFields.length >= 1)) {
        throw new TypeError('Failed to fetch');
      }
      requests.push({
        url,
        startIdx: opts.body.fields.find(f => f.k === 'captureStartIndex')?.v ?? null,
        hasFinal: finalFields.length > 0,
        capCount: capFields.length,
        printRequested: opts.body.fields.find(f => f.k === 'printRequested')?.v
      });
      return { ok: true, status: 200, json: async () => ({ success: true, printJob: { printJobId: 'pj_fb' } }) };
    }
  });
  vm.runInContext(offlineSrc, oCtx);
  const store = oCtx.window.pbOfflineStore;

  const result = await store.uploadSession({
    id: 'sess_fallback_test',
    tenantId: 't1',
    eventId: 'e1',
    mode: 'multi',
    finalImage: tinyJpg,
    captures: [
      { poseIndex: 1, dataUrl: tinyJpg },
      { poseIndex: 2, dataUrl: tinyJpg },
      { poseIndex: 3, dataUrl: tinyJpg }
    ],
    printRequested: true,
    printCopies: 1,
    printPaperSize: '4x6'
  });

  assert.equal(result.success, true);
  assert.equal(requests.length, 4, 'Falls back cleanly: 1 finalImage + 3 separate single-pose uploads');
  assert.equal(requests[0].hasFinal, true);
  assert.equal(requests[0].capCount, 0);
  assert.equal(requests[0].printRequested, 'false');
  assert.equal(requests[1].startIdx, '0');
  assert.equal(requests[2].startIdx, '1');
  assert.equal(requests[3].startIdx, '2');
  assert.equal(requests[3].printRequested, 'true', 'printRequested fires only on final fallback request');
});

test('Admin Galeri Khusus API lists multi-pose sessions numerically and supports local & server custom-frame 4R/5R print with new template QR', async () => {
  const express = (await import('express')).default;
  const { apiRouter } = await import('../src/routes/api.js');
  const { createToken } = await import('../src/services/auth.js');
  const sheet = await import('../src/services/sheet.js');

  const tenantId = 'tenant_studiokeren_01';
  const otherTenantId = 'tenant_other_sg_' + Date.now();
  const eventId = 'event_wedding_dimas_sarah';
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 10000);
  const sessId = 'sess_sg_test_' + suffix;
  const raw1Id = 'asset_sg_raw1_' + suffix;
  const raw2Id = 'asset_sg_raw2_' + suffix;
  const raw10Id = 'asset_sg_raw10_' + suffix;

  const tplNew = templateService.createTemplate(tenantId, {
    name: 'SG Custom Frame 5R ' + suffix,
    eventId,
    boothMode: 'both',
    formatPreset: 'portrait_5r',
    qrPosition: 'bottom-right',
    qrCoords: [{ x: 120, y: 1700, size: 220 }]
  });

  // Create dummy PNG for test uploads
  const sampleBuf = sheet.encodePng({
    width: 120,
    height: 180,
    channels: 4,
    data: Buffer.alloc(120 * 180 * 4, 240)
  });

  db.prepare(`
    INSERT INTO photo_sessions (id, tenant_id, event_id, device_id, mode, status, started_at, ended_at)
    VALUES (?, ?, ?, NULL, 'mingle', 'completed', datetime('now'), datetime('now'))
  `).run(sessId, tenantId, eventId);

  db.prepare(`
    INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, status)
    VALUES
      (?, ?, ?, ?, 'raw_capture', 'pose_1', '/uploads/sg_pose1.png', 'ready'),
      (?, ?, ?, ?, 'raw_capture', 'pose_2', '/uploads/sg_pose2.png', 'ready'),
      (?, ?, ?, ?, 'raw_capture', 'pose_10', '/uploads/sg_pose10.png', 'ready')
  `).run(raw1Id, tenantId, eventId, sessId, raw2Id, tenantId, eventId, sessId, raw10Id, tenantId, eventId, sessId);

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  const adminToken = createToken({ userId: 'u_sg_admin', tenantId, role: 'super_admin' });
  const otherToken = createToken({ userId: 'u_sg_other', tenantId: otherTenantId, role: 'super_admin' });
  const createdFileNames = [];

  try {
    // 1. Unauthenticated must fail with 401
    const unauthRes = await fetch(`${baseUrl}/api/photos/sessions/special-gallery`);
    assert.equal(unauthRes.status, 401);

    // 2. Authenticated tenant receives session with numerically sorted poses [1, 2, 10]
    const listRes = await fetch(`${baseUrl}/api/photos/sessions/special-gallery?sessionId=${encodeURIComponent(sessId)}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(listRes.status, 200);
    const sessions = await listRes.json();
    const targetSess = sessions.find(s => s.sessionId === sessId);
    assert.ok(targetSess, 'Special gallery lists target multi-pose session');
    assert.equal(targetSess.poseCount, 3);
    assert.deepEqual(targetSess.poses.map(p => p.poseNumber), [1, 2, 10], 'Poses sort numerically instead of lexicographically');

    // 3. Tenant isolation check
    const otherRes = await fetch(`${baseUrl}/api/photos/sessions/special-gallery?sessionId=${encodeURIComponent(sessId)}`, {
      headers: { Authorization: `Bearer ${otherToken}` }
    });
    assert.equal(otherRes.status, 200);
    const otherSessions = await otherRes.json();
    assert.equal(otherSessions.some(s => s.sessionId === sessId), false, 'Other tenant cannot read sessions');

    // 4. Local print with custom 5R template -> returns sheetUrl with templateId and stamps new frame QR on 5R sheet
    const localForm = new FormData();
    localForm.append('finalImage', new Blob([sampleBuf], { type: 'image/png' }), 'custom_local.png');
    localForm.append('templateId', tplNew.id);
    localForm.append('paperSize', '5R');
    localForm.append('copies', '3');
    localForm.append('printMode', 'local');

    const localRes = await fetch(`${baseUrl}/api/photos/sessions/${encodeURIComponent(sessId)}/custom-print`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: localForm
    });
    const localData = await localRes.json();
    assert.equal(localRes.status, 200, `local custom-print failed: ${JSON.stringify(localData)}`);
    assert.equal(localData.success, true);
    assert.equal(localData.mode, 'local');
    assert.equal(localData.paperSize, '5x7');
    assert.equal(localData.paperWidthIn, 5);
    assert.equal(localData.paperHeightIn, 7);
    assert.equal(localData.copies, 3);
    assert.match(localData.sheetUrl, new RegExp(`templateId=${tplNew.id}`));
    if (localData.finalImageUrl) createdFileNames.push(path.basename(localData.finalImageUrl));

    // Fetch generated local print sheet & verify 5R dims (1500x2100) + dark QR pixels stamped at custom QR coords
    const sheetRes = await fetch(`${baseUrl}${localData.sheetUrl}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(sheetRes.status, 200);
    const sheetBuf = Buffer.from(await sheetRes.arrayBuffer());
    const decSheet = sheet.decodePng(sheetBuf);
    assert.equal(decSheet.width, 1500);
    assert.equal(decSheet.height, 2100);
    let darkQrPixels = 0;
    for (let y = 1710; y < 1910; y += 4) {
      for (let x = 130; x < 330; x += 4) {
        const idx = (y * decSheet.width + x) * decSheet.channels;
        if (decSheet.data[idx] < 60 && decSheet.data[idx + 1] < 60 && decSheet.data[idx + 2] < 60) {
          darkQrPixels++;
        }
      }
    }
    assert.ok(darkQrPixels > 25, 'Custom template QR coordinates are stamped onto local 5R sheet');

    // 5. Server print 4R with copies=2 -> queues immediately with new template QR options
    const server4rForm = new FormData();
    server4rForm.append('finalImage', new Blob([sampleBuf], { type: 'image/png' }), 'custom_4r.png');
    server4rForm.append('templateId', tplNew.id);
    server4rForm.append('paperSize', '4R');
    server4rForm.append('copies', '2');
    server4rForm.append('printMode', 'server');

    const srv4rRes = await fetch(`${baseUrl}/api/photos/sessions/${encodeURIComponent(sessId)}/custom-print`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: server4rForm
    });
    const srv4rData = await srv4rRes.json();
    assert.equal(srv4rRes.status, 200);
    assert.equal(srv4rData.mode, 'server');
    assert.equal(srv4rData.printJob.paperLabel, '4R');
    assert.equal(srv4rData.printJob.copies, 2);
    assert.equal(srv4rData.printJob.state, 'queued');
    if (srv4rData.finalImageUrl) createdFileNames.push(path.basename(srv4rData.finalImageUrl));

    // 6. Server print 5R without paperConfirmed -> awaits paper confirmation
    const server5rForm = new FormData();
    server5rForm.append('finalImage', new Blob([sampleBuf], { type: 'image/png' }), 'custom_5r.png');
    server5rForm.append('templateId', tplNew.id);
    server5rForm.append('paperSize', '5R');
    server5rForm.append('copies', '1');
    server5rForm.append('paperConfirmed', 'false');
    server5rForm.append('printMode', 'server');

    const srv5rRes = await fetch(`${baseUrl}/api/photos/sessions/${encodeURIComponent(sessId)}/custom-print`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: server5rForm
    });
    const srv5rData = await srv5rRes.json();
    assert.equal(srv5rRes.status, 200);
    assert.equal(srv5rData.printJob.paperLabel, '5R');
    assert.equal(srv5rData.printJob.state, 'awaiting_paper');
    assert.equal(srv5rData.printJob.requiresPaperConfirm, true);
    if (srv5rData.finalImageUrl) createdFileNames.push(path.basename(srv5rData.finalImageUrl));

    // Original raw poses remain preserved in session
    const remainingRaw = db.prepare("SELECT COUNT(*) as c FROM media_assets WHERE photo_session_id = ? AND type = 'raw_capture'").get(sessId);
    assert.equal(remainingRaw.c, 3);

    // 7. Static wiring verification in Admin HTML & JS
    const adminHtml = fs.readFileSync(path.join(process.cwd(), 'public/admin.html'), 'utf8');
    const adminJs = fs.readFileSync(path.join(process.cwd(), 'public/js/admin.js'), 'utf8');
    assert.match(adminHtml, /id="btnOpenSpecialGallery"/);
    assert.match(adminHtml, /id="specialGalleryModal"/);
    assert.match(adminHtml, /id="modalBtnOpenSpecialGallery"/);
    assert.match(adminHtml, /id="sgBtnPaper4R"/);
    assert.match(adminHtml, /id="sgBtnPaper5R"/);
    assert.match(adminHtml, /id="btnSpecialPrintLocal"/);
    assert.match(adminHtml, /id="btnSpecialPrintServer"/);
    assert.match(adminHtml, /id="specialGalleryZoomSlider"/);
    assert.match(adminHtml, /<option value="event" selected>Frame Event Ini<\/option>/);
    assert.match(adminHtml, /\/js\/photo-filters\.js/);
    assert.match(adminJs, /function openSpecialGalleryModal/);
    assert.match(adminJs, /async function executeSpecialGalleryPrint/);
    assert.match(adminJs, /function assignPoseToActiveSpecialSlot/);
    assert.match(adminJs, /function selectSpecialGalleryTemplate/);
    assert.match(adminJs, /function setSpecialGalleryZoomPercent/);
    assert.match(adminJs, /addEventListener\('touchstart'/);
    assert.match(adminJs, /addEventListener\('wheel'/);
  } finally {
    await new Promise(resolve => srv.close(resolve));
    const sessRow = db.prepare('SELECT guest_pass_id FROM photo_sessions WHERE id = ?').get(sessId);
    db.prepare('DELETE FROM print_jobs WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM media_assets WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
    if (sessRow && sessRow.guest_pass_id) {
      db.prepare('DELETE FROM guest_passes WHERE id = ?').run(sessRow.guest_pass_id);
    }
    db.prepare('DELETE FROM templates WHERE id = ?').run(tplNew.id);
    for (const fname of createdFileNames) {
      try { fs.unlinkSync(path.join(process.cwd(), 'public/uploads', fname)); } catch (e) {}
    }
  }
});

test('Mingle Live Mirror defaults OFF (normal), toggles scaleX(-1) on live viewfinder only, and preserves un-mirrored capture', async () => {
  const vm = await import('node:vm');
  const root = process.cwd();
  const mingleHtml = fs.readFileSync(path.join(root, 'public/mingle.html'), 'utf8');
  const mingleJs = fs.readFileSync(path.join(root, 'public/js/mingle.js'), 'utf8');

  assert.match(mingleHtml, /id="btnMingleMirrorLive"/);
  assert.match(mingleHtml, /toggleLiveMirror\(\)/);

  const trimmed = mingleJs.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');
  const lsStore = new Map();
  const makeEl = (extra = {}) => ({
    style: {},
    innerText: '',
    classList: {
      set: new Set(),
      toggle(cls, force) {
        if (force) this.set.add(cls);
        else this.set.delete(cls);
      },
      contains(cls) { return this.set.has(cls); }
    },
    ...extra
  });
  const videoEl = makeEl({ videoWidth: 1280, videoHeight: 720 });
  const liveCanvasEl = makeEl();
  const btnEl = makeEl();
  const vfEl = makeEl({ clientWidth: 800, clientHeight: 450 });
  const dom = new Map([
    ['mingleVideoFeed', videoEl],
    ['mingleLiveCanvas', liveCanvasEl],
    ['btnMingleMirrorLive', btnEl],
    ['mingleViewfinder', vfEl]
  ]);

  let captureScaled = false;
  const ctx = vm.createContext({
    URL, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    window: { location: { origin: 'http://localhost', search: '' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => dom.get(id) || null,
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          translate: () => {},
          rotate: () => {},
          scale: () => { captureScaled = true; },
          drawImage: () => {}
        }),
        toDataURL: () => 'data:image/jpeg;base64,RAW_NORMAL'
      }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: {
      getItem: (k) => lsStore.get(k) ?? null,
      setItem: (k, v) => lsStore.set(k, String(v)),
      removeItem: (k) => lsStore.delete(k)
    },
    navigator: { onLine: true, mediaDevices: {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval, console
  });
  vm.runInContext(trimmed, ctx);

  const engine = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(engine, {
    cameraRotation: 0,
    liveMirror: false,
    eventConfig: {},
    activeFilter: 'normal',
    usbStatus: null,
    isProcessingCapture: false,
    playShutterSound: () => {},
    setProcessingOverlay: () => {},
    showToast: () => {},
    getFilterCss: () => 'none',
    enforceCaptureOrientationDataUrl: async (u) => u,
    finalizeCapturedDataUrl: async (u) => { engine._lastCaptured = u; }
  });

  // 1. Default OFF: no mirror on live video or live canvas
  engine.updateLiveMirrorUI();
  engine.applyMingleVideoTransform();
  assert.equal(btnEl.innerText, '🪞 Mirror: OFF');
  assert.equal(videoEl.style.transform, '');
  assert.equal(liveCanvasEl.style.transform, '');

  // 2. Toggle ON: applies scaleX(-1) ONLY to live viewfinder elements + persists
  engine.toggleLiveMirror();
  assert.equal(engine.liveMirror, true);
  assert.equal(lsStore.get('pb_mingle_live_mirror'), 'true');
  assert.equal(btnEl.innerText, '🪞 Mirror: ON');
  assert.equal(videoEl.style.transform, 'scaleX(-1)');
  assert.equal(liveCanvasEl.style.transform, 'scaleX(-1)');

  // 3. Rotate + Mirror combines cleanly (scaleX(-1) rotate(90deg) scale(...))
  engine.cameraRotation = 90;
  engine.applyMingleVideoTransform();
  assert.match(videoEl.style.transform, /^scaleX\(-1\) rotate\(90deg\)/);

  // 4. Captured still via triggerBackupCapture never flips pixels horizontally
  engine.cameraRotation = 0;
  await engine.triggerBackupCapture();
  assert.equal(captureScaled, false, 'Captured image must stay un-mirrored so text is never flipped');
  assert.equal(engine._lastCaptured, 'data:image/jpeg;base64,RAW_NORMAL');
});

test('Kiosk Capture Full Layar Live expands viewport and restores normal mode via Minimize', async () => {
  const vm = await import('node:vm');
  const kioskHtml = fs.readFileSync(path.join(process.cwd(), 'public/kiosk.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(process.cwd(), 'public/css/styles.css'), 'utf8');
  const kioskJs = fs.readFileSync(path.join(process.cwd(), 'public/js/kiosk.js'), 'utf8');

  // 1. Markup & CSS checks
  assert.match(kioskHtml, /id="kioskGlobalControls"[\s\S]*id="btnKioskAdminLink"[\s\S]*id="btnCaptureBackWelcome"[^>]*goBackToWelcomeFromCapture\(\)/);
  assert.match(stylesCss, /body\.kiosk-on-capture #kioskGlobalControls[\s\S]*flex-direction:\s*column\s*!important/);
  assert.match(stylesCss, /body\.kiosk-on-capture #btnKioskAdminLink\s*\{\s*order:\s*1;\s*\}[\s\S]*body\.kiosk-on-capture #btnCaptureBackWelcome\s*\{\s*order:\s*2;\s*\}/);
  assert.match(kioskHtml, /id="btnLiveFullscreenExpand"[^>]*onclick="event\.stopPropagation\(\); kiosk\.toggleLiveViewFullscreen\(true\);"/);
  assert.match(kioskHtml, /id="btnLiveFullscreenMinimize"[^>]*onclick="event\.stopPropagation\(\); kiosk\.toggleLiveViewFullscreen\(false\);"/);
  assert.match(kioskHtml, /id="liveFullscreenDoneBar"/);
  assert.match(stylesCss, /body\.kiosk-live-fullscreen #screenCapture\.active #cameraRetroFrame[\s\S]*100vw[\s\S]*100dvh/);
  assert.match(stylesCss, /\.live-fs-minimize-btn[\s\S]*bottom:\s*max\(16px, env\(safe-area-inset-bottom\)\)[\s\S]*right:\s*max\(16px, env\(safe-area-inset-right\)\)/);
  assert.match(stylesCss, /body\.kiosk-live-fullscreen #kioskGlobalControls[\s\S]*display:\s*none\s*!important/);
  assert.match(stylesCss, /body\.kiosk-live-fullscreen #screenCapture\.active \.live-fs-minimize-btn[\s\S]*display:\s*inline-flex\s*!important/);

  // 2. VM runtime behavior checks
  const trimmed = kioskJs.replace(/\n\/\/ Global kiosk instance[\s\S]*$/, '\n');
  const lsStore = new Map();
  const bodyClasses = new Set();
  const makeEl = (id) => ({
    id,
    style: { removeProperty: () => {} },
    innerText: '',
    innerHTML: '',
    appendChild: () => {},
    clientWidth: 1280,
    clientHeight: 720,
    classList: {
      toggle: (cls, force) => {
        if (force === true) bodyClasses.add(cls);
        else if (force === false) bodyClasses.delete(cls);
      },
      add: (cls) => bodyClasses.add(cls),
      remove: (cls) => bodyClasses.delete(cls),
      contains: (cls) => bodyClasses.has(cls)
    },
    closest: (sel) => (sel === 'button' && (id === 'btnLiveFullscreenExpand' || id === 'btnLiveFullscreenMinimize') ? makeEl(id) : null)
  });

  const ids = [
    'cameraRetroFrame', 'videoFeed', 'btnLiveFullscreenExpand', 'btnLiveFullscreenMinimize',
    'liveFullscreenDoneBar', 'liveFullscreenDoneText', 'postCapturePreviewOverlay',
    'cameraZoomControls', 'btnToggleCameraControls', 'kioskCameraSettingsDrawer',
    'poseThumbnails', 'capturedCountText', 'btnProceedToPreview', 'btnRetakeAll',
    'screenCapture', 'screenPreview', 'screenTemplate', 'screenWelcome'
  ];
  const dom = new Map(ids.map((id) => [id, makeEl(id)]));
  const ctx = vm.createContext({
    URL, URLSearchParams, AbortController, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    window: { __pbNotifyInitialized: true, location: { origin: 'http://localhost', search: '' }, addEventListener: () => {} },
    document: {
      body: makeEl('body'),
      head: { appendChild: () => {} },
      getElementById: (id) => dom.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => makeEl('dyn')
    },
    localStorage: {
      getItem: (k) => lsStore.get(k) ?? null,
      setItem: (k, v) => lsStore.set(k, String(v))
    },
    navigator: { onLine: true, mediaDevices: null },
    requestAnimationFrame: (fn) => fn(),
    setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout, console
  });
  vm.runInContext(trimmed, ctx);

  const eng = vm.runInContext('Object.create(KioskEngine.prototype)', ctx);
  let shutterCalled = 0;
  Object.assign(eng, {
    currentScreen: 'screenCapture',
    liveViewFullscreen: false,
    cameraZoom: 1.0,
    cameraPanX: 0,
    cameraPanY: 0,
    cameraFitMode: 'cover',
    cameraAspectRatio: '16/9',
    cameraRotation: 0,
    posesCaptured: [null, null, null],
    totalPosesRequired: 3,
    renderStepProgressBars: () => {},
    wakeUpVideoFeedOnVisibleScreen: () => {},
    getLiveViewfinderCssFilterString: () => '',
    updateCameraFitButtonsUI: () => {},
    updateCameraAspectRatioButtonsUI: () => {},
    updateCameraCaptureOrientationUI: () => {},
    updateCameraRotationButtonsUI: () => {},
    handleShutterClick: () => { shutterCalled++; }
  });

  // Normal mode initial state
  eng.syncLiveViewFullscreenUI();
  eng.applyCameraTransform();
  assert.equal(bodyClasses.has('kiosk-live-fullscreen'), false);
  assert.equal(dom.get('btnLiveFullscreenExpand').style.display, 'inline-flex');
  assert.equal(dom.get('btnLiveFullscreenMinimize').style.display, 'none');
  assert.equal(dom.get('cameraRetroFrame').style.aspectRatio, '16 / 9');

  // Expand to Full Layar Live
  eng.toggleLiveViewFullscreen(true);
  assert.equal(eng.liveViewFullscreen, true);
  assert.equal(lsStore.get('pb_kiosk_live_fullscreen'), 'true');
  assert.equal(bodyClasses.has('kiosk-live-fullscreen'), true);
  assert.equal(dom.get('btnLiveFullscreenExpand').style.display, 'none');
  assert.equal(dom.get('btnLiveFullscreenMinimize').style.display, 'inline-flex');
  assert.equal(dom.get('cameraRetroFrame').style.aspectRatio, 'auto');

  // Clicking Minimize or Expand button never triggers shutter snap
  eng.handleCameraViewportClick({ target: dom.get('btnLiveFullscreenMinimize') });
  assert.equal(shutterCalled, 0);

  // All poses finished in Full Live reveals done bar only when hold overlay is closed
  eng.posesCaptured = ['p1', 'p2', 'p3'];
  dom.get('postCapturePreviewOverlay').style.display = 'flex';
  eng.renderFilmstripDock();
  assert.equal(dom.get('liveFullscreenDoneBar').style.display, 'none');
  dom.get('postCapturePreviewOverlay').style.display = 'none';
  eng.renderFilmstripDock();
  assert.equal(dom.get('liveFullscreenDoneBar').style.display, 'flex');

  // Leaving screenCapture (e.g. moving to screenPreview) strips body fullscreen class automatically
  eng.showScreen('screenPreview');
  assert.equal(bodyClasses.has('kiosk-live-fullscreen'), false);

  // Returning & clicking Minimize restores normal mode cleanly
  eng.showScreen('screenCapture');
  assert.equal(bodyClasses.has('kiosk-live-fullscreen'), true);
  eng.toggleLiveViewFullscreen(false);
  assert.equal(eng.liveViewFullscreen, false);
  assert.equal(lsStore.get('pb_kiosk_live_fullscreen'), 'false');
  assert.equal(bodyClasses.has('kiosk-live-fullscreen'), false);
  assert.equal(dom.get('btnLiveFullscreenExpand').style.display, 'inline-flex');
  assert.equal(dom.get('btnLiveFullscreenMinimize').style.display, 'none');
  assert.equal(dom.get('cameraRetroFrame').style.aspectRatio, '16 / 9');
  assert.equal(dom.get('liveFullscreenDoneBar').style.display, 'none');

  // Back button from capture returns cleanly to screenWelcome and clears kiosk-on-capture
  eng.syncFilterControlsUI = () => {};
  eng.showScreen('screenCapture');
  assert.equal(bodyClasses.has('kiosk-on-capture'), true);
  eng.goBackToWelcomeFromCapture();
  assert.equal(eng.currentScreen, 'screenWelcome');
  assert.equal(bodyClasses.has('kiosk-on-capture'), false);
  assert.equal(eng.posesCaptured.length, 0);
});

test('Mingle Ready screen Full Layar Live expands viewfinder and restores normal mode via Minimize', async () => {
  const vm = await import('node:vm');
  const mingleHtml = fs.readFileSync(path.join(process.cwd(), 'public/mingle.html'), 'utf8');
  const mingleJs = fs.readFileSync(path.join(process.cwd(), 'public/js/mingle.js'), 'utf8');

  assert.match(mingleHtml, /id="btnMingleLiveFullscreenExpand"[^>]*toggleLiveViewFullscreen\(true\)/);
  assert.match(mingleHtml, /id="btnMingleLiveFullscreenMinimize"[^>]*toggleLiveViewFullscreen\(false\)/);
  assert.match(mingleHtml, /id="mingleLiveFsActionBar"/);
  assert.match(mingleHtml, /body\.mingle-live-fullscreen #screenMingleReady #mingleViewfinder[\s\S]*100vw[\s\S]*100dvh/);
  assert.match(mingleHtml, /\.mingle-live-fs-minimize-btn[\s\S]*bottom:\s*max\(16px, env\(safe-area-inset-bottom\)\)[\s\S]*right:\s*max\(16px, env\(safe-area-inset-right\)\)/);
  assert.match(mingleHtml, /body\.mingle-live-fullscreen #screenMingleReady \.mingle-live-fs-minimize-btn[\s\S]*display:\s*inline-flex\s*!important/);

  const trimmed = mingleJs.replace(/\nwindow\.mingle\s*=\s*new MingleBoothEngine\(\);\s*$/, '\n');
  const lsStore = new Map();
  const bodyClasses = new Set();
  const makeEl = (id, extra = {}) => ({
    id,
    style: {},
    innerText: '',
    innerHTML: '',
    clientWidth: 800,
    clientHeight: 450,
    classList: {
      toggle: (cls, force) => {
        if (force === true) bodyClasses.add(cls);
        else if (force === false) bodyClasses.delete(cls);
      },
      contains: (cls) => bodyClasses.has(cls)
    },
    ...extra
  });
  const dom = new Map([
    ['mingleVideoFeed', makeEl('mingleVideoFeed', { videoWidth: 1280, videoHeight: 720 })],
    ['mingleLiveCanvas', makeEl('mingleLiveCanvas')],
    ['mingleViewfinder', makeEl('mingleViewfinder')],
    ['btnMingleLiveFullscreenExpand', makeEl('btnMingleLiveFullscreenExpand')],
    ['btnMingleLiveFullscreenMinimize', makeEl('btnMingleLiveFullscreenMinimize')],
    ['mingleLiveFsActionBar', makeEl('mingleLiveFsActionBar')],
    ['btnMingleLiveFsFinish', makeEl('btnMingleLiveFsFinish')],
    ['btnMingleFinishSession', makeEl('btnMingleFinishSession')]
  ]);

  const ctx = vm.createContext({
    URL, Promise, Math, Date, JSON, Set, Array, Number, String, Boolean,
    window: { location: { origin: 'http://localhost', search: '' }, addEventListener: () => {} },
    document: {
      body: makeEl('body'),
      getElementById: (id) => dom.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => makeEl('dyn')
    },
    localStorage: {
      getItem: (k) => lsStore.get(k) ?? null,
      setItem: (k, v) => lsStore.set(k, String(v))
    },
    navigator: { onLine: true, mediaDevices: {} },
    requestAnimationFrame: (fn) => fn(),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval, console
  });
  vm.runInContext(trimmed, ctx);

  const eng = vm.runInContext('Object.create(MingleBoothEngine.prototype)', ctx);
  Object.assign(eng, {
    currentScreen: 'screenMingleReady',
    liveViewFullscreen: false,
    cameraRotation: 0,
    liveMirror: false,
    eventConfig: {},
    activeFilter: 'normal',
    capturedPhotos: [],
    activeTargetShots: 3,
    showToast: () => {},
    getFilterCss: () => 'none'
  });

  // Initial normal state
  eng.syncLiveViewFullscreenUI();
  assert.equal(bodyClasses.has('mingle-live-fullscreen'), false);
  assert.equal(dom.get('btnMingleLiveFullscreenExpand').style.display, 'inline-flex');
  assert.equal(dom.get('btnMingleLiveFullscreenMinimize').style.display, 'none');
  assert.equal(dom.get('mingleLiveFsActionBar').style.display, 'none');

  // Toggle ON -> expands Full Layar Live + hides expand + shows minimize & quick action bar
  eng.toggleLiveViewFullscreen(true);
  assert.equal(eng.liveViewFullscreen, true);
  assert.equal(lsStore.get('pb_mingle_live_fullscreen'), 'true');
  assert.equal(bodyClasses.has('mingle-live-fullscreen'), true);
  assert.equal(dom.get('btnMingleLiveFullscreenExpand').style.display, 'none');
  assert.equal(dom.get('btnMingleLiveFullscreenMinimize').style.display, 'inline-flex');
  assert.equal(dom.get('mingleLiveFsActionBar').style.display, 'inline-flex');
  assert.equal(dom.get('btnMingleLiveFsFinish').style.display, 'none');

  // Capturing 1+ photo reveals Selesai button in Full Live action bar
  eng.capturedPhotos = ['data:image/jpeg;base64,ONE'];
  eng.updateReadyCaptureUI();
  assert.equal(dom.get('btnMingleLiveFsFinish').style.display, 'inline-flex');

  // Leaving screenMingleReady (e.g. Result screen) strips mingle-live-fullscreen cleanly
  eng.showScreen('screenMingleResult');
  assert.equal(bodyClasses.has('mingle-live-fullscreen'), false);

  // Returning & Minimize restores normal layout cleanly
  eng.showScreen('screenMingleReady');
  assert.equal(bodyClasses.has('mingle-live-fullscreen'), true);
  eng.toggleLiveViewFullscreen(false);
  assert.equal(eng.liveViewFullscreen, false);
  assert.equal(lsStore.get('pb_mingle_live_fullscreen'), 'false');
  assert.equal(bodyClasses.has('mingle-live-fullscreen'), false);
  assert.equal(dom.get('btnMingleLiveFullscreenExpand').style.display, 'inline-flex');
  assert.equal(dom.get('btnMingleLiveFullscreenMinimize').style.display, 'none');
  assert.equal(dom.get('mingleLiveFsActionBar').style.display, 'none');
});
