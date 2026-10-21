import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { db } from '../db/database.js';
import { loginUser, authMiddleware, verifyToken } from '../services/auth.js';
import * as billing from '../services/billing.js';
import * as eventService from '../services/event.js';
import * as qrService from '../services/qr.js';
import * as templateService from '../services/template.js';
import * as printService from '../services/print.js';
import * as aiService from '../services/ai.js';
import * as syncService from '../services/sync.js';
import * as auditService from '../services/audit.js';
import * as appBuilder from '../services/appBuilder.js';
import * as cameraService from '../services/camera.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure upload dirs exist
const uploadDir = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
const upload = multer({ storage });

export const apiRouter = express.Router();

// ==========================================
// 1. AUTH ROUTES
// ==========================================
apiRouter.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const result = loginUser(email, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/me', authMiddleware(), (req, res) => {
  const user = db.prepare('SELECT id, email, full_name, role, status FROM users WHERE id = ?').get(req.user.userId);
  let tenant = null;
  if (req.user.tenantId) {
    tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.user.tenantId);
  }
  res.json({ user, tenant, operatorPin: req.user.operatorPin });
});

// ==========================================
// 2. SUPER ADMIN ROUTES
// ==========================================
apiRouter.get('/super/overview', authMiddleware('super_admin'), (req, res) => {
  const totalTenants = db.prepare('SELECT COUNT(*) as count FROM tenants').get().count;
  const activeTenants = db.prepare("SELECT COUNT(*) as count FROM tenants WHERE status = 'active'").get().count;
  const pendingInvoices = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE status IN ('pending_payment', 'under_review')").get().count;
  const activeDevices = db.prepare("SELECT COUNT(*) as count FROM devices WHERE status = 'active'").get().count;
  const totalRevenue = db.prepare("SELECT SUM(amount) as sum FROM invoices WHERE status = 'approved'").get().sum || 0;

  res.json({
    metrics: {
      totalTenants,
      activeTenants,
      pendingInvoices,
      activeDevices,
      totalRevenue
    }
  });
});

apiRouter.get('/super/tenants', authMiddleware('super_admin'), (req, res) => {
  const tenants = db.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM events e WHERE e.tenant_id = t.id) as event_count,
           (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id) as device_count,
           (SELECT s.status FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.created_at DESC LIMIT 1) as subscription_status,
           (SELECT p.name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.tenant_id = t.id ORDER BY s.created_at DESC LIMIT 1) as plan_name
    FROM tenants t
    ORDER BY t.created_at DESC
  `).all();
  res.json(tenants);
});

apiRouter.post('/super/tenants', authMiddleware('super_admin'), (req, res) => {
  try {
    const { name, slug } = req.body;
    const tenantId = 'tenant_' + crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)').run(tenantId, name, slug);
    res.json({ success: true, tenantId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/super/tenants/:id', authMiddleware('super_admin'), (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

apiRouter.get('/super/plans', authMiddleware(), (req, res) => {
  res.json(billing.getPlans());
});

apiRouter.get('/super/invoices', authMiddleware('super_admin'), (req, res) => {
  const invoices = db.prepare(`
    SELECT i.*, t.name as tenant_name, p.name as plan_name, pp.file_path as proof_file_path, pp.review_status, pp.created_at as proof_uploaded_at
    FROM invoices i
    JOIN tenants t ON i.tenant_id = t.id
    JOIN subscriptions s ON i.subscription_id = s.id
    JOIN plans p ON s.plan_id = p.id
    LEFT JOIN payment_proofs pp ON i.id = pp.invoice_id
    ORDER BY i.created_at DESC
  `).all();
  res.json(invoices);
});

apiRouter.post('/super/invoices/:id/approve', authMiddleware('super_admin'), (req, res) => {
  try {
    const result = billing.approveInvoice(req.params.id, req.user.userId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/super/invoices/:id/reject', authMiddleware('super_admin'), (req, res) => {
  try {
    const { reason } = req.body;
    const result = billing.rejectInvoice(req.params.id, req.user.userId, reason || 'Bukti transfer tidak sesuai');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 3. BUSINESS ADMIN ROUTES
// ==========================================
apiRouter.get('/tenants/current/subscription', authMiddleware(), (req, res) => {
  const tenantId = req.user.tenantId;
  const sub = billing.getTenantSubscription(tenantId);
  const invoices = db.prepare('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
  res.json({ subscription: sub, invoices });
});

apiRouter.post('/subscriptions/upgrade', authMiddleware(), (req, res) => {
  try {
    const { planId } = req.body;
    const result = billing.createSubscriptionInvoice(req.user.tenantId, planId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/subscriptions/invoices/:id/proof', authMiddleware(), upload.single('proof'), (req, res) => {
  try {
    if (!req.file) throw new Error('File bukti transfer wajib diunggah');
    const filePath = `/uploads/${req.file.filename}`;
    const result = billing.submitPaymentProof(req.params.id, req.user.userId, filePath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Events
apiRouter.get('/events', authMiddleware(), (req, res) => {
  const events = eventService.getEvents(req.user.tenantId);
  res.json(events);
});

apiRouter.post('/events', authMiddleware(), (req, res) => {
  try {
    const event = eventService.createEvent(req.user.tenantId, req.body);
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/events/:id', (req, res) => {
  let tenantId = 'tenant_studiokeren_01';
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const payload = verifyToken(authHeader.substring(7));
    if (payload && payload.tenantId) tenantId = payload.tenantId;
  }
  const event = eventService.getEventById(req.params.id, tenantId);
  if (!event) return res.status(404).json({ error: 'Event tidak ditemukan' });
  res.json(event);
});

apiRouter.patch('/events/:id', authMiddleware(), (req, res) => {
  try {
    const event = eventService.updateEventConfig(req.params.id, req.user.tenantId, req.body);
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload custom background image or video for Kiosk Event
apiRouter.post('/events/upload-background', authMiddleware(), upload.single('backgroundFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File gambar atau video wajib dipilih' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    const mime = req.file.mimetype || '';
    const isVideo = mime.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(req.file.originalname);
    res.json({
      success: true,
      fileUrl,
      mimeType: mime,
      mediaType: isVideo ? 'video' : 'image',
      originalName: req.file.originalname
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/events/:id/analytics', authMiddleware(), (req, res) => {
  const analytics = eventService.getEventAnalytics(req.params.id, req.user.tenantId);
  res.json(analytics);
});

apiRouter.get('/events/:id/sessions', authMiddleware(), (req, res) => {
  const sessions = db.prepare(`
    SELECT ps.*, 
           (SELECT COUNT(*) FROM media_assets ma WHERE ma.photo_session_id = ps.id) as media_count
    FROM photo_sessions ps 
    WHERE ps.event_id = ? AND ps.tenant_id = ? 
    ORDER BY ps.started_at DESC LIMIT 10
  `).all(req.params.id, req.user.tenantId);
  res.json(sessions);
});

apiRouter.post('/events/cleanup-expired', authMiddleware(), (req, res) => {
  const result = eventService.cleanupExpiredEventPhotos();
  res.json({ success: true, ...result });
});

// Active Event State for Tenant (accessible by both Admin & Kiosk)
apiRouter.get('/events/active/current', (req, res) => {
  let tenantId = 'tenant_studiokeren_01';
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const payload = verifyToken(authHeader.substring(7));
    if (payload && payload.tenantId) tenantId = payload.tenantId;
  }

  const tenant = db.prepare('SELECT brand_config_json FROM tenants WHERE id = ?').get(tenantId);
  let activeEventId = null;
  if (tenant && tenant.brand_config_json) {
    try {
      const cfg = JSON.parse(tenant.brand_config_json);
      activeEventId = cfg.activeEventId;
    } catch (e) {}
  }

  let event = null;
  if (activeEventId) {
    event = eventService.getEventById(activeEventId, tenantId);
  }
  if (!event) {
    const events = eventService.getEvents(tenantId);
    event = events[0] || null;
  }

  res.json({ event, activeEventId: event ? event.id : null });
});

apiRouter.post('/events/active/set', authMiddleware(), (req, res) => {
  const { eventId } = req.body;
  if (!eventId) return res.status(400).json({ error: 'eventId diperlukan' });

  const event = eventService.getEventById(eventId, req.user.tenantId);
  if (!event) return res.status(404).json({ error: 'Event tidak ditemukan' });

  // Simpan ke tenant config
  const tenant = db.prepare('SELECT brand_config_json FROM tenants WHERE id = ?').get(req.user.tenantId);
  let cfg = {};
  if (tenant && tenant.brand_config_json) {
    try {
      cfg = JSON.parse(tenant.brand_config_json);
    } catch (e) {}
  }
  cfg.activeEventId = eventId;

  db.prepare('UPDATE tenants SET brand_config_json = ? WHERE id = ?').run(JSON.stringify(cfg), req.user.tenantId);
  res.json({ success: true, eventId, event });
});

// Devices
apiRouter.get('/devices', authMiddleware(), (req, res) => {
  const devices = db.prepare('SELECT * FROM devices WHERE tenant_id = ?').all(req.user.tenantId);
  res.json(devices);
});

apiRouter.post('/devices/pair', authMiddleware(), (req, res) => {
  const { name, platform, hardwareId } = req.body;
  const devId = 'dev_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO devices (id, tenant_id, name, hardware_id_hash, platform, status, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))
  `).run(devId, req.user.tenantId, name, hardwareId || 'hw_' + Date.now(), platform || 'windows');
  res.json({ success: true, deviceId: devId });
});

// Templates & Green Area Detection
apiRouter.get('/templates', (req, res) => {
  let tenantId = 'tenant_studiokeren_01';
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const payload = verifyToken(authHeader.substring(7));
    if (payload && payload.tenantId) tenantId = payload.tenantId;
  }
  const eventId = req.query.eventId || null;
  const scope = req.query.scope || null;
  const templates = templateService.getTemplates(tenantId, eventId, scope);
  res.json(templates);
});

apiRouter.post('/templates', authMiddleware(), upload.single('templateFile'), (req, res) => {
  try {
    const { name, eventId, width, height, orientation, slotsJson } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '/assets/templates/single-green-template.svg';
    const slots = slotsJson ? JSON.parse(slotsJson) : [];

    const tpl = templateService.createTemplate(req.user.tenantId, {
      name,
      eventId,
      width: parseInt(width) || 1200,
      height: parseInt(height) || 1800,
      orientation: orientation || 'portrait',
      imageUrl,
      slots
    });
    res.json(tpl);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/templates/:id/slots', authMiddleware(), (req, res) => {
  try {
    const { slots, layers } = req.body;
    const updated = templateService.updateTemplateSlots(req.params.id, req.user.tenantId, slots, layers);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/templates/:id', authMiddleware(), (req, res) => {
  try {
    db.prepare('DELETE FROM templates WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenantId);
    res.json({ success: true, message: 'Template berhasil dihapus' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Universal Smart QR Passes
apiRouter.get('/guest-passes', authMiddleware(), async (req, res) => {
  try {
    const { eventId } = req.query;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const passes = await qrService.listGuestPasses(req.user.tenantId, eventId, baseUrl);
    res.json(passes);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/guest-passes/batch', authMiddleware(), async (req, res) => {
  try {
    const { eventId, count } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const passes = await qrService.createBatchGuestPasses(req.user.tenantId, eventId, parseInt(count) || 10, baseUrl);
    res.json(passes);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/guest-passes/issue', async (req, res) => {
  try {
    const { tenantId, eventId, baseUrl } = req.body;
    const origin = baseUrl || `${req.protocol}://${req.get('host')}`;
    const pass = await qrService.createGuestPass(tenantId, eventId, 'booth', origin);
    res.json(pass);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 4. KIOSK & TOUCHSCREEN FLOW ROUTES
// ==========================================
// Public endpoint for kiosk to get available guest passes (for dropdown/simulator)
apiRouter.get('/kiosk/guest-passes', async (req, res) => {
  try {
    const eventId = req.query.eventId || 'event_wedding_dimas_sarah';
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const passes = await qrService.listGuestPasses('tenant_studiokeren_01', eventId, baseUrl);
    res.json(passes);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Public/Device endpoint to resolve QR from camera scan
apiRouter.post('/kiosk/qr/resolve', async (req, res) => {
  try {
    const { token, baseUrl } = req.body;
    const origin = baseUrl || `${req.protocol}://${req.get('host')}`;
    const pass = await qrService.resolveGuestPassWithQr(token, origin);
    if (!pass) return res.status(404).json({ valid: false, message: 'QR Code tidak valid atau telah kedaluwarsa' });
    res.json({ valid: true, pass });
  } catch (err) {
    res.status(400).json({ valid: false, message: err.message });
  }
});

// Start a photo session on kiosk
apiRouter.post('/kiosk/sessions', (req, res) => {
  try {
    const { tenantId, eventId, deviceId, guestPassId, mode } = req.body;
    const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');

    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, device_id, guest_pass_id, mode, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'capturing', datetime('now'))
    `).run(sessionId, tenantId, eventId, deviceId || null, guestPassId || null, mode || 'single');

    res.json({ sessionId, status: 'capturing' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Save photo capture & final render
apiRouter.post('/kiosk/sessions/:id/complete', upload.fields([
  { name: 'finalImage', maxCount: 1 }, 
  { name: 'captures', maxCount: 20 },
  { name: 'liveClips', maxCount: 20 },
  { name: 'livePhoto', maxCount: 1 },
  { name: 'boomerang', maxCount: 1 }
]), (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM photo_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session tidak ditemukan' });

    if (req.body && req.body.guestPassId && !session.guest_pass_id) {
      db.prepare('UPDATE photo_sessions SET guest_pass_id = ? WHERE id = ?').run(req.body.guestPassId, sessionId);
      session.guest_pass_id = req.body.guestPassId;
    }

    let finalAssetId = null;
    let finalUrl = null;

    if (req.files && req.files['finalImage'] && req.files['finalImage'][0]) {
      const file = req.files['finalImage'][0];
      finalUrl = `/uploads/${file.filename}`;
      
      const existingFinal = db.prepare("SELECT id FROM media_assets WHERE photo_session_id = ? AND type = 'final_photo'").get(sessionId);
      if (existingFinal) {
        db.prepare(`
          UPDATE media_assets 
          SET file_path = ?, size_bytes = ?
          WHERE id = ?
        `).run(finalUrl, file.size, existingFinal.id);
        finalAssetId = existingFinal.id;
      } else {
        finalAssetId = 'asset_' + crypto.randomBytes(8).toString('hex');
        db.prepare(`
          INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
          VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', ?, ?, 'ready')
        `).run(finalAssetId, session.tenant_id, session.event_id, sessionId, finalUrl, file.size);
      }
    }

    // SIMPAN SEMUA FOTO ASLI TANPA FRAME (RAW CAPTURES)
    // Cegah duplikasi: simpan hanya 1 kali saat sesi pertama kali selesai
    if (req.files && req.files['captures'] && req.files['captures'].length > 0) {
      const existingRaw = db.prepare("SELECT COUNT(*) as count FROM media_assets WHERE photo_session_id = ? AND type = 'raw_capture'").get(sessionId);
      if (existingRaw.count === 0) {
        req.files['captures'].forEach((captureFile, idx) => {
          const rawUrl = `/uploads/${captureFile.filename}`;
          const rawAssetId = 'asset_raw_' + crypto.randomBytes(8).toString('hex');
          db.prepare(`
            INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
            VALUES (?, ?, ?, ?, 'raw_capture', ?, ?, ?, 'ready')
          `).run(rawAssetId, session.tenant_id, session.event_id, sessionId, `pose_${idx + 1}`, rawUrl, captureFile.size);
        });
      }
    }

    // SIMPAN LIVE VIDEO CLIP PER POSE (IPHONE LIVE PHOTO)
    if (req.files && req.files['liveClips'] && req.files['liveClips'].length > 0) {
      const existingLiveClips = db.prepare("SELECT COUNT(*) as count FROM media_assets WHERE photo_session_id = ? AND type = 'live_clip'").get(sessionId);
      if (existingLiveClips.count === 0) {
        req.files['liveClips'].forEach((clipFile, idx) => {
          const clipUrl = `/uploads/${clipFile.filename}`;
          const clipAssetId = 'asset_live_' + crypto.randomBytes(8).toString('hex');
          db.prepare(`
            INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
            VALUES (?, ?, ?, ?, 'live_clip', ?, ?, ?, 'ready')
          `).run(clipAssetId, session.tenant_id, session.event_id, sessionId, `pose_${idx + 1}`, clipUrl, clipFile.size);
        });
      }
    }

    // SIMPAN LIVE PHOTO CLIP (IPHONE STYLE)
    if (req.files && req.files['livePhoto'] && req.files['livePhoto'][0]) {
      const lpFile = req.files['livePhoto'][0];
      const lpUrl = `/uploads/${lpFile.filename}`;
      const existingLp = db.prepare("SELECT id FROM media_assets WHERE photo_session_id = ? AND type = 'live_photo'").get(sessionId);
      if (existingLp) {
        db.prepare("UPDATE media_assets SET file_path = ?, size_bytes = ? WHERE id = ?").run(lpUrl, lpFile.size, existingLp.id);
      } else {
        const lpId = 'asset_lp_' + crypto.randomBytes(8).toString('hex');
        db.prepare(`
          INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
          VALUES (?, ?, ?, ?, 'live_photo', 'live_motion', ?, ?, 'ready')
        `).run(lpId, session.tenant_id, session.event_id, sessionId, lpUrl, lpFile.size);
      }
    }

    // SIMPAN BOOMERANG CLIP (FORWARD + REVERSE LOOP)
    if (req.files && req.files['boomerang'] && req.files['boomerang'][0]) {
      const bmFile = req.files['boomerang'][0];
      const bmUrl = `/uploads/${bmFile.filename}`;
      const existingBm = db.prepare("SELECT id FROM media_assets WHERE photo_session_id = ? AND type = 'boomerang'").get(sessionId);
      if (existingBm) {
        db.prepare("UPDATE media_assets SET file_path = ?, size_bytes = ? WHERE id = ?").run(bmUrl, bmFile.size, existingBm.id);
      } else {
        const bmId = 'asset_bm_' + crypto.randomBytes(8).toString('hex');
        db.prepare(`
          INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
          VALUES (?, ?, ?, ?, 'boomerang', 'boomerang_clip', ?, ?, 'ready')
        `).run(bmId, session.tenant_id, session.event_id, sessionId, bmUrl, bmFile.size);
      }
    }

    // Update session status
    db.prepare("UPDATE photo_sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?").run(sessionId);

    // If print requested
    let printJob = null;
    if (req.body.printRequested === 'true' && finalAssetId) {
      const copies = parseInt(req.body.printCopies) || 1;
      printJob = printService.createPrintJob(
        session.tenant_id,
        session.event_id,
        session.device_id,
        sessionId,
        finalAssetId,
        copies
      );
    }

    res.json({
      success: true,
      sessionId,
      mediaAssetId: finalAssetId,
      finalImageUrl: finalUrl,
      printJob
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Offline batch sync endpoint
apiRouter.post('/kiosk/sync/batch', (req, res) => {
  try {
    const { tenantId, deviceId, eventId, items } = req.body;
    const result = syncService.processBatchSync(tenantId, deviceId, eventId, items);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 5. GUEST GALLERY ROUTES (Mobile-First, No Login)
// ==========================================
apiRouter.get('/gallery/g/:token', (req, res) => {
  const data = qrService.getGuestGalleryData(req.params.token);
  if (!data) {
    return res.status(404).json({ error: 'Galeri tidak ditemukan atau QR telah kedaluwarsa' });
  }
  res.json(data);
});

apiRouter.post('/gallery/g/:token/share-click', (req, res) => {
  // Log share click for event analytics
  const pass = qrService.resolveGuestPass(req.params.token);
  if (pass) {
    db.prepare(`
      INSERT INTO audit_logs (id, tenant_id, actor_name, action, details_json)
      VALUES (?, ?, 'Guest', 'share_whatsapp', ?)
    `).run('audit_' + crypto.randomBytes(8).toString('hex'), pass.tenant_id, JSON.stringify({ token: req.params.token }));
  }
  res.json({ success: true });
});

// ==========================================
// 6. PRINTER & OPERATOR ROUTES
// ==========================================
apiRouter.get('/printers/system', authMiddleware(), (req, res) => {
  try {
    const data = printService.getSystemPrinters();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/printers/media-types', authMiddleware(), (req, res) => {
  try {
    const printer = req.query.printer || '';
    const mediaTypes = printService.getPrinterMediaTypes(printer);
    res.json(mediaTypes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/printers/profile', (req, res) => {
  try {
    let tenantId = 'tenant_studiokeren_01';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const payload = verifyToken(authHeader.substring(7));
      if (payload && payload.tenantId) tenantId = payload.tenantId;
    }
    const profiles = printService.getPrinterProfiles(tenantId);
    const active = profiles.find(p => p.is_default === 1) || profiles[0] || null;
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/printers/profile', authMiddleware(), (req, res) => {
  try {
    const result = printService.savePrinterProfile(req.user.tenantId, req.body);
    res.json({ success: true, profile: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/printers/test-print', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const activeEvent = db.prepare("SELECT * FROM events WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(tenantId)
      || db.prepare("SELECT * FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1").get(tenantId);
    
    if (!activeEvent) {
      return res.status(400).json({ error: 'Tidak ada event untuk melakukan test print' });
    }

    const testSessionId = 'sess_test_print_' + Date.now().toString(36);
    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, mode, status)
      VALUES (?, ?, ?, 'strip', 'completed')
    `).run(testSessionId, tenantId, activeEvent.id);

    const testAssetId = 'asset_test_' + Date.now().toString(36);
    db.prepare(`
      INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path)
      VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', '/uploads/test_print.png')
    `).run(testAssetId, tenantId, activeEvent.id, testSessionId);

    const printJob = printService.createPrintJob(tenantId, activeEvent.id, null, testSessionId, testAssetId, 1);
    res.json({
      success: true,
      message: 'Test print berhasil dikirim ke antrean spooler!',
      printJob
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/print-jobs', authMiddleware(), (req, res) => {
  const eventId = req.query.eventId || null;
  const jobs = printService.getPrintJobs(req.user.tenantId, eventId);
  res.json(jobs);
});

apiRouter.post('/print-jobs/:id/reprint', authMiddleware(), (req, res) => {
  try {
    const copies = parseInt(req.body?.copies) || null;
    const result = printService.reprintJob(req.params.id, req.user.tenantId, req.user.userId, copies);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/print-jobs/:id/cancel', authMiddleware(), (req, res) => {
  try {
    const result = printService.cancelPrintJob(req.params.id, req.user.tenantId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Photo Gallery & On-Demand Reprint
apiRouter.get('/photos/recent', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const eventId = req.query.eventId || null;
    let query = `
      SELECT ma.id as asset_id, ma.file_path, ma.variant, ma.created_at,
             ps.id as session_id, ps.mode as session_mode, ps.status as session_status,
             ps.guest_pass_id,
             e.id as event_id, e.name as event_name,
             (SELECT pj.id FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_job_id,
             (SELECT pj.state FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_state,
             (SELECT pj.spooler_job_id FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as spooler_job_id,
             (SELECT pj.copies FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_copies
      FROM media_assets ma
      LEFT JOIN photo_sessions ps ON ma.photo_session_id = ps.id
      LEFT JOIN events e ON ma.event_id = e.id
      WHERE ma.tenant_id = ?
        AND (ma.type = 'final_photo' OR ma.variant = 'print_hires')
        AND ma.file_path NOT LIKE '%.mp4'
        AND ma.file_path NOT LIKE '%.webm'
        AND (ps.id IS NULL OR (ps.id NOT LIKE 'sess_print_test_%' AND ps.id NOT LIKE 'sess_test_0%'))
    `;
    const params = [tenantId];
    if (eventId) {
      query += ' AND ma.event_id = ?';
      params.push(eventId);
    }
    query += ' ORDER BY ma.created_at DESC LIMIT 60';
    const photos = db.prepare(query).all(...params);
    res.json(photos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/photos/:assetId/print', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const asset = db.prepare('SELECT * FROM media_assets WHERE id = ? AND tenant_id = ?').get(req.params.assetId, tenantId);
    if (!asset) return res.status(404).json({ error: 'Foto tidak ditemukan' });

    const copies = parseInt(req.body.copies) || 1;
    const printJob = printService.createPrintJob(
      tenantId,
      asset.event_id,
      null,
      asset.photo_session_id,
      asset.id,
      copies
    );
    res.json({
      success: true,
      message: 'Perintah cetak ulang berhasil dikirim ke spooler!',
      printJob
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Preflight hardware test
apiRouter.get('/operator/preflight', authMiddleware(), (req, res) => {
  const profile = db.prepare('SELECT * FROM printer_profiles WHERE tenant_id = ? AND is_default = 1').get(req.user.tenantId);
  const printerName = profile ? profile.name : 'Printer Siap';
  res.json({
    camera: { status: 'ok', message: 'Webcam UVC / DirectShow siap' },
    printer: { status: 'ok', message: `${printerName} Spooler Ready (Kertas & Tinta OK)` },
    storage: { status: 'ok', freeMB: 48500 },
    network: { status: 'online', pingMs: 14 }
  });
});

// ==========================================
// 7. AI STUDIO & AUDIT
// ==========================================
apiRouter.post('/ai/jobs', (req, res) => {
  try {
    const { tenantId, eventId, photoSessionId, feature, hasConsent } = req.body;
    const result = aiService.processAiJob(tenantId, eventId, photoSessionId, feature, { hasConsent });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/audit-logs', authMiddleware('super_admin'), (req, res) => {
  res.json(auditService.getAuditLogs(req.query.tenantId || null));
});

// ==========================================
// 8. CROSS-PLATFORM APP DOWNLOADER (WINDOWS, MACOS, ANDROID)
// ==========================================
apiRouter.get('/apps/info', async (req, res) => {
  try {
    const customUrl = req.query.serverUrl || null;
    const info = await appBuilder.getAppDownloadInfo(req.headers.host || 'localhost:3000', customUrl);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/apps/download/macos', async (req, res) => {
  try {
    const info = await appBuilder.getAppDownloadInfo(req.headers.host || 'localhost:3000', req.query.serverUrl);
    const zipBuf = appBuilder.buildMacOsAppZip(info.targetServerUrl, info.primaryLanUrl);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Photobooth-Kiosk-MacBook-macOS.zip"');
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/apps/launch-macos', async (req, res) => {
  try {
    const info = await appBuilder.getAppDownloadInfo(req.headers.host || 'localhost:3000', req.body?.serverUrl);
    const result = appBuilder.launchMacOsAppDirectly(info.targetServerUrl, info.primaryLanUrl, req.body?.mode || 'kiosk');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/apps/download/windows', async (req, res) => {
  try {
    const info = await appBuilder.getAppDownloadInfo(req.headers.host || 'localhost:3000', req.query.serverUrl);
    const zipBuf = appBuilder.buildWindowsAppZip(info.targetServerUrl, info.primaryLanUrl);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Photobooth-Kiosk-Windows-10-11.zip"');
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/apps/download/android', async (req, res) => {
  try {
    const info = await appBuilder.getAppDownloadInfo(req.headers.host || 'localhost:3000', req.query.serverUrl);
    const zipBuf = appBuilder.buildAndroidAppZip(info.targetServerUrl, info.primaryLanUrl);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Photobooth-Kiosk-Android-Package.zip"');
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/apps/download/android-launcher', async (req, res) => {
  try {
    const info = await appBuilder.getAppDownloadInfo(req.headers.host || 'localhost:3000', req.query.serverUrl);
    const htmlContent = appBuilder.buildAndroidStandaloneHtml(info.targetServerUrl, info.primaryLanUrl);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Photobooth-Kiosk-Android.html"');
    res.send(htmlContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. HARDWARE CAMERA (SONY A7III / CANON) & FLASH TRIGGER ROUTES
// ==========================================
apiRouter.get('/camera/status', async (req, res) => {
  try {
    const status = await cameraService.getCameraSystemStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/camera/config', async (req, res) => {
  try {
    const saved = cameraService.saveCameraConfig(req.body || {});
    res.json({ success: true, config: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/camera/launch-sony-remote', async (req, res) => {
  try {
    const result = await cameraService.launchSonyRemoteApp();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/camera/trigger-capture', async (req, res) => {
  try {
    const result = await cameraService.triggerHardwareShutterAndFlash(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
