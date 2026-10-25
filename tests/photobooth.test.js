import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

import { initDatabase, db } from '../src/db/database.js';
import * as billing from '../src/services/billing.js';
import * as eventService from '../src/services/event.js';
import * as qrService from '../src/services/qr.js';
import * as templateService from '../src/services/template.js';
import * as printService from '../src/services/print.js';
import * as aiService from '../src/services/ai.js';
import * as syncService from '../src/services/sync.js';
import { createToken, verifyToken, authMiddleware } from '../src/services/auth.js';
import { optimizePhotoFile } from '../src/services/imageOptimizer.js';
import { encodePng, decodeImage, buildPrintSheetFile } from '../src/services/sheet.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('PHOTOBOOTH SAAS FULL SYSTEM - COMPREHENSIVE TEST SUITE', async (t) => {
  // Ensure DB initialized
  initDatabase();

  await t.test('1. Multi-Tenant Data Isolation & RBAC', () => {
    const tenants = db.prepare('SELECT * FROM tenants').all();
    assert.ok(tenants.length >= 1, 'Should have at least 1 tenant seeded');

    const tenantA = tenants[0];
    const eventsTenantA = eventService.getEvents(tenantA.id);
    assert.ok(eventsTenantA.length >= 1, 'Tenant A should have its own events');

    // Attempting to query non-existent tenant yields empty list
    const fakeTenantEvents = eventService.getEvents('tenant_fake_9999');
    assert.strictEqual(fakeTenantEvents.length, 0, 'Inaccessible tenant should return 0 events');
  });

  await t.test('2. Manual Bank Transfer Billing & Idempotent Approval', () => {
    const tenantId = 'tenant_studiokeren_01';
    const invoice = billing.createSubscriptionInvoice(tenantId, 'plan_monthly');
    assert.ok(invoice.invoiceId, 'Invoice ID should be generated');
    assert.ok(invoice.uniqueReference.startsWith('INV-'), 'Unique reference number generated');
    assert.strictEqual(invoice.status, 'pending_payment');

    // Submit payment proof
    const proof = billing.submitPaymentProof(invoice.invoiceId, 'user_business_owner_01', '/uploads/sample_proof.png');
    assert.strictEqual(proof.status, 'submitted');

    // Super Admin approves
    const approval = billing.approveInvoice(invoice.invoiceId, 'user_super_admin_01');
    assert.ok(approval.success, 'Approval should succeed');

    // Idempotent test: approving again should be safe and return already approved
    const reApproval = billing.approveInvoice(invoice.invoiceId, 'user_super_admin_01');
    assert.ok(reApproval.success, 'Re-approval should be idempotent');
  });

  await t.test('3. Smart Template Green-Area Slots & Versioning', () => {
    const tenantId = 'tenant_studiokeren_01';
    const tpl = templateService.createTemplate(tenantId, {
      name: 'Test Strip 3-Slots',
      width: 600,
      height: 1800,
      orientation: 'strip',
      imageUrl: '/assets/templates/strip-green-template.svg',
      slots: [
        { id: 's1', pose_index: 1, x: 50, y: 130, width: 500, height: 420 },
        { id: 's2', pose_index: 2, x: 50, y: 580, width: 500, height: 420 },
        { id: 's3', pose_index: 3, x: 50, y: 1030, width: 500, height: 420 }
      ]
    });

    assert.ok(tpl.id, 'Template should have ID');
    assert.strictEqual(tpl.slots.length, 3, 'Template should contain 3 photo slots');

    // Update slots (e.g. after admin adjusts in canvas)
    const updated = templateService.updateTemplateSlots(tpl.id, tenantId, [
      { id: 's1_adj', pose_index: 1, x: 60, y: 140, width: 480, height: 400 }
    ]);
    assert.strictEqual(updated.slots.length, 1, 'Updated template version reflects changes');
    assert.strictEqual(updated.version, 2, 'Version should increment');

    // Clean up test template so it does not clutter user UI
    db.prepare('DELETE FROM templates WHERE id = ?').run(tpl.id);
  });

  await t.test('4. Universal Smart QR: Resolution, Association & Multi-Session', async () => {
    const tenantId = 'tenant_studiokeren_01';
    const eventId = 'event_wedding_dimas_sarah';

    const guestPass = await qrService.createGuestPass(tenantId, eventId, 'booth');
    assert.ok(guestPass.token.startsWith('gst_'), 'Token should have gst_ prefix');
    assert.ok(guestPass.qrDataUrl, 'QR Data URL must be generated');

    // Booth camera resolves QR
    const resolved = qrService.resolveGuestPass(guestPass.token);
    assert.ok(resolved, 'Guest pass should be resolvable by camera');
    assert.strictEqual(resolved.event_id, eventId);

    // Multi-session test: attach 2 distinct photo sessions to the same QR
    const sess1Id = 'sess_test_01_' + Date.now();
    const sess2Id = 'sess_test_02_' + Date.now();

    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, mode, status)
      VALUES (?, ?, ?, ?, 'strip', 'completed')
    `).run(sess1Id, tenantId, eventId, guestPass.id);

    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, guest_pass_id, mode, status)
      VALUES (?, ?, ?, ?, 'single', 'completed')
    `).run(sess2Id, tenantId, eventId, guestPass.id);

    // Guest opens mobile gallery with their token
    const gallery = qrService.getGuestGalleryData(guestPass.token);
    assert.ok(gallery, 'Gallery data should load');
    assert.strictEqual(gallery.sessions.length, 2, 'Multi-session must retain both sessions');
  });

  await t.test('5. Epson Print Spooler Pipeline & Operator Reprint', () => {
    const tenantId = 'tenant_studiokeren_01';
    const eventId = 'event_wedding_dimas_sarah';

    // Insert valid photo session first to respect foreign key constraint
    const sessId = 'sess_print_test_' + Date.now();
    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, mode, status)
      VALUES (?, ?, ?, 'strip', 'completed')
    `).run(sessId, tenantId, eventId);

    // Seed media asset for this session
    const assetId = 'asset_test_' + Date.now();
    db.prepare(`
      INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path)
      VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', '/uploads/test.png')
    `).run(assetId, tenantId, eventId, sessId);

    const printJob = printService.createPrintJob(tenantId, eventId, 'dev_kiosk_win_01', sessId, assetId, 2);
    assert.ok(printJob.printJobId, 'Print job should be queued');
    assert.ok(printJob.spoolerJobId.startsWith('EPSON_SPOOL_'), 'Epson spooler ID assigned');
    assert.strictEqual(printJob.copies, 2);

    // Operator reprints
    const reprinted = printService.reprintJob(printJob.printJobId, tenantId, 'user_operator_01');
    assert.ok(reprinted.printJobId, 'Reprint job created with audit trail');

    // Clean up test print job & media asset so they don't clutter UI
    db.prepare('DELETE FROM print_jobs WHERE photo_session_id = ?').run(sessId);
    db.prepare('DELETE FROM media_assets WHERE id = ?').run(assetId);
    db.prepare('DELETE FROM photo_sessions WHERE id = ?').run(sessId);
  });

  await t.test('6. Offline Sync Engine & Idempotency Key Deduplication', () => {
    const tenantId = 'tenant_studiokeren_01';
    const deviceId = 'dev_kiosk_win_01';
    const eventId = 'event_wedding_dimas_sarah';
    const idempotencyKey = 'offline_sync_' + crypto.randomBytes(8).toString('hex');

    const job1 = syncService.queueSyncJob(tenantId, deviceId, eventId, 'upload_session', { test: 123 }, idempotencyKey);
    assert.strictEqual(job1.state, 'completed');

    // Duplicate sync attempt with same key must not create duplicates
    const job2 = syncService.queueSyncJob(tenantId, deviceId, eventId, 'upload_session', { test: 123 }, idempotencyKey);
    assert.strictEqual(job2.jobId, job1.jobId, 'Deduplicated to existing job ID');
  });

  await t.test('7. AI Studio Consent Enforcement', () => {
    const tenantId = 'tenant_studiokeren_01';
    const eventId = 'event_wedding_dimas_sarah';

    const sessId = 'sess_ai_test_' + Date.now();
    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, mode, status)
      VALUES (?, ?, ?, 'single', 'completed')
    `).run(sessId, tenantId, eventId);

    // Face swap without consent MUST throw an error
    assert.throws(() => {
      aiService.processAiJob(tenantId, eventId, sessId, 'face_swap', { hasConsent: false });
    }, /Persetujuan/);

    // Face swap with consent succeeds and tracks cost/model
    const result = aiService.processAiJob(tenantId, eventId, sessId, 'face_swap', { hasConsent: true });
    assert.strictEqual(result.status, 'success');
    assert.ok(result.latencyMs > 0);
  });

  await t.test('8. High-Quality Photo Compression for Framed and Unframed Photos', () => {
    const tmpPng = path.join(os.tmpdir(), `test_raw_framed_${Date.now()}.png`);
    // Create a 1200x1800 4R photo with varied color data (simulating a photo)
    const w = 1200, h = 1800;
    const testBuf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < testBuf.length; i += 4) {
      testBuf[i] = (i * 17 + (i % 73)) % 256;      // R
      testBuf[i + 1] = (i * 31 + (i % 101)) % 256; // G
      testBuf[i + 2] = (i * 53 + (i % 149)) % 256; // B
      testBuf[i + 3] = 255;                        // A
    }
    const pngBuf = encodePng({ width: w, height: h, channels: 4, data: testBuf });
    fs.writeFileSync(tmpPng, pngBuf);

    const originalSize = fs.statSync(tmpPng).size;
    assert.ok(originalSize > 500000, 'Original uncompressed image should be large');

    // Run photo optimization (quality 88)
    const optResult = optimizePhotoFile(tmpPng, { quality: 88, maxDimension: 1920 });
    assert.ok(optResult, 'Optimization should return result');
    assert.strictEqual(optResult.wasCompressed, true, 'Image must be compressed');
    assert.ok(optResult.path.endsWith('.jpg'), 'Result should be JPEG format');
    assert.strictEqual(fs.existsSync(tmpPng), false, 'Original PNG must be cleaned up');
    assert.ok(fs.existsSync(optResult.path), 'Optimized JPEG must exist');
    assert.ok(optResult.size < originalSize * 0.5, 'Compressed file should be drastically smaller than PNG');

    // Verify it decodes cleanly and preserves 1200x1800 resolution for printing
    const decoded = decodeImage(fs.readFileSync(optResult.path));
    assert.strictEqual(decoded.width, 1200);
    assert.strictEqual(decoded.height, 1800);
    assert.strictEqual(decoded.channels, 4);

    // Verify print engine can build print sheet from the compressed JPEG
    const sheetPath = buildPrintSheetFile(optResult.path, { paperSize: '4x6', autoSafeMargin: true }, 'test_compressed_job');
    assert.ok(sheetPath && fs.existsSync(sheetPath), 'Print sheet file must be generated from compressed JPEG');

    // Clean up temp files
    try { fs.unlinkSync(optResult.path); } catch (e) {}
    try { fs.unlinkSync(sheetPath); } catch (e) {}
  });

  await t.test('9. Admin Security Gate & Password Verification (313354)', () => {
    // 1. Password verification constant-time check
    const expectedPassword = '313354';
    const verifyPass = (input) => {
      if (typeof input !== 'string') return false;
      const bufA = Buffer.from(input, 'utf8');
      const bufB = Buffer.from(expectedPassword, 'utf8');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    };

    assert.strictEqual(verifyPass('313354'), true, 'Correct password 313354 must match');
    assert.strictEqual(verifyPass('123456'), false, 'Wrong password must fail');
    assert.strictEqual(verifyPass('31335'), false, 'Partial password must fail');
    assert.strictEqual(verifyPass(''), false, 'Empty password must fail');

    // 2. Token creation and verification
    const token = createToken({
      userId: 'user_business_owner_01',
      role: 'business_admin',
      tenantId: 'tenant_studiokeren_01'
    });
    assert.ok(token && typeof token === 'string', 'Token must be generated');

    const verified = verifyToken(token);
    assert.ok(verified, 'Token must be verified successfully');
    assert.strictEqual(verified.userId, 'user_business_owner_01');
    assert.strictEqual(verified.tenantId, 'tenant_studiokeren_01');

    // 3. authMiddleware blocks unauthenticated requests with 401
    const mw = authMiddleware();
    let statusSet = null;
    let jsonSent = null;
    let nextCalled = false;

    const fakeReqNoAuth = { headers: {}, cookies: {}, query: {} };
    const fakeRes = {
      status: (code) => { statusSet = code; return fakeRes; },
      json: (data) => { jsonSent = data; return fakeRes; }
    };
    const fakeNext = () => { nextCalled = true; };

    mw(fakeReqNoAuth, fakeRes, fakeNext);
    assert.strictEqual(nextCalled, false, 'Middleware must not call next when unauthenticated');
    assert.strictEqual(statusSet, 401, 'Middleware must return 401 Unauthorized');
    assert.ok(jsonSent.error.includes('Unauthorized'), 'Response must explain authentication requirement');

    // 4. authMiddleware succeeds when valid cookie is provided
    statusSet = null;
    jsonSent = null;
    nextCalled = false;
    const fakeReqWithAuth = {
      headers: {},
      cookies: { pb_admin_auth: token },
      query: {}
    };

    mw(fakeReqWithAuth, fakeRes, fakeNext);
    assert.strictEqual(nextCalled, true, 'Middleware must call next when valid cookie is supplied');
    assert.strictEqual(statusSet, null, 'No error status should be set');
    assert.strictEqual(fakeReqWithAuth.user.tenantId, 'tenant_studiokeren_01');
  });
});
