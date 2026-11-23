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
