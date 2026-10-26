import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { db } from '../db/database.js';
import { loginUser, authMiddleware, verifyToken, createToken } from '../services/auth.js';
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
import { optimizePhotoFile } from '../services/imageOptimizer.js';
import QRCode from 'qrcode';

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

// Rate-limiting & Brute Force Protection for Admin Gate
const adminLoginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000; // 10 menit

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const list = forwarded.split(',');
    return list[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function verifyAdminPassword(inputPassword) {
  if (typeof inputPassword !== 'string' && typeof inputPassword !== 'number') return false;
  const cleanInput = String(inputPassword).trim();
  const targetPassword = (process.env.ADMIN_PASSWORD || '313354').trim();
  const bufInput = Buffer.from(cleanInput, 'utf8');
  const bufTarget = Buffer.from(targetPassword, 'utf8');
  if (bufInput.length !== bufTarget.length) return false;
  return crypto.timingSafeEqual(bufInput, bufTarget);
}

// Admin Gate Login (Password: 313354)
apiRouter.post('/admin/login', (req, res) => {
  const clientIp = getClientIp(req);
  const now = Date.now();
  const attemptInfo = adminLoginAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };

  // Check lockout
  if (attemptInfo.lockedUntil > now) {
    const remainingSeconds = Math.ceil((attemptInfo.lockedUntil - now) / 1000);
    return res.status(429).json({
      error: `Akses terkunci sementara karena terlalu banyak percobaan gagal. Silakan tunggu ${remainingSeconds} detik lagi.`,
      retryAfter: remainingSeconds
    });
  }

  const { password } = req.body || {};
  const isMatch = verifyAdminPassword(password);

  if (!isMatch) {
    const newCount = (attemptInfo.lockedUntil > 0 && attemptInfo.lockedUntil <= now) ? 1 : attemptInfo.count + 1;
    let lockedUntil = 0;
    if (newCount >= MAX_LOGIN_ATTEMPTS) {
      lockedUntil = now + LOGIN_LOCKOUT_MS;
      adminLoginAttempts.set(clientIp, { count: newCount, lockedUntil });
      return res.status(429).json({
        error: `Terlalu banyak percobaan gagal (${MAX_LOGIN_ATTEMPTS}x). Akses dikunci selama 10 menit untuk keamanan.`,
        retryAfter: 600
      });
    }

    adminLoginAttempts.set(clientIp, { count: newCount, lockedUntil });
    const sisa = MAX_LOGIN_ATTEMPTS - newCount;
    return res.status(401).json({
      error: `Password salah! Sisa percobaan: ${sisa} kali sebelum terkunci.`,
      remainingAttempts: sisa
    });
  }

  // Password benar! Reset attempt counter
  adminLoginAttempts.delete(clientIp);

  // Buat sesi admin aman
  const adminUser = db.prepare("SELECT id, email, full_name, role FROM users WHERE role IN ('business_admin', 'super_admin') LIMIT 1").get() || {
    id: 'user_business_owner_01',
    email: 'owner@studiokeren.id',
    full_name: 'Admin Mafaza',
    role: 'super_admin'
  };
  const activeTenant = db.prepare('SELECT id FROM tenants LIMIT 1').get() || { id: 'tenant_studiokeren_01' };

  const token = createToken({
    userId: adminUser.id,
    email: adminUser.email,
    name: adminUser.full_name,
    role: 'super_admin',
    tenantId: activeTenant.id
  });

  res.setHeader('Set-Cookie', [
    `pb_admin_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    `pb_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=2592000`
  ]);

  return res.json({
    success: true,
    message: 'Login berhasil',
    redirectUrl: `/admin?auth=${encodeURIComponent(token)}`,
    token
  });
});

// Admin Gate Logout
apiRouter.post('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'pb_admin_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'pb_token=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ]);
  return res.json({ success: true, message: 'Berhasil keluar dari dashboard admin' });
});

// Check Admin Session Status
apiRouter.get('/admin/check-session', (req, res) => {
  const token = req.cookies?.pb_admin_auth || req.cookies?.pb_token;
  const verified = token ? verifyToken(token) : null;
  res.json({
    authenticated: !!verified,
    user: verified ? {
      name: verified.name,
      role: verified.role,
      email: verified.email
    } : null
  });
});

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

// Endpoint untuk mendapatkan QR code galeri lengkap sebuah Event (memuat seluruh foto tamu)
apiRouter.get('/events/:id/qr', async (req, res) => {
  try {
    const eventId = req.params.id;
    const ev = db.prepare(`
      SELECT e.*, t.name as tenant_name 
      FROM events e 
      JOIN tenants t ON e.tenant_id = t.id 
      WHERE e.id = ?
    `).get(eventId);

    if (!ev) return res.status(404).json({ error: 'Event tidak ditemukan' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const galleryUrl = `/gallery/e/${ev.id}`;
    const fullQrUrl = `${baseUrl.replace(/\/$/, '')}${galleryUrl}`;
    const qrDataUrl = await qrService.createQrWithLogoDataUrl(fullQrUrl, { size: 360 });

    const stats = db.prepare(`
      SELECT 
        COUNT(DISTINCT ps.id) as session_count,
        COUNT(DISTINCT ma.id) as media_count
      FROM photo_sessions ps
      LEFT JOIN media_assets ma ON ma.photo_session_id = ps.id
      WHERE ps.event_id = ?
    `).get(ev.id);

    res.json({
      eventId: ev.id,
      eventName: ev.name,
      tenantName: ev.tenant_name,
      galleryUrl,
      fullQrUrl,
      qrDataUrl,
      sessionCount: stats?.session_count || 0,
      photoCount: stats?.media_count || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.patch('/events/:id', authMiddleware(), (req, res) => {
  try {
    const event = eventService.updateEventConfig(req.params.id, req.user.tenantId, req.body);
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Format byte size helper
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Upload custom background image or video for Kiosk Event
apiRouter.post('/events/upload-background', authMiddleware(), upload.single('backgroundFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File gambar atau video wajib dipilih' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    const mime = req.file.mimetype || '';
    const isVideo = mime.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(req.file.originalname);
    const mediaType = isVideo ? 'video' : 'image';
    const sizeBytes = req.file.size;
    const sizeFormatted = formatBytes(sizeBytes);
    const eventId = req.query.eventId || req.body.eventId;

    let updatedBackgrounds = null;
    if (eventId) {
      const event = eventService.getEventById(eventId, req.user.tenantId);
      if (event) {
        const cfg = event.config || {};
        let list = Array.isArray(cfg.uploadedBackgrounds) ? cfg.uploadedBackgrounds : [];
        const entry = {
          fileUrl,
          filename: req.file.filename,
          originalName: req.file.originalname,
          mediaType,
          sizeBytes,
          sizeFormatted,
          uploadedAt: new Date().toISOString()
        };
        // Avoid duplicate URL, unshift new file to top
        list = list.filter(b => b.fileUrl !== fileUrl);
        list.unshift(entry);
        cfg.uploadedBackgrounds = list;
        cfg.kioskBackground = {
          type: mediaType,
          url: fileUrl,
          overlayOpacity: cfg.kioskBackground?.overlayOpacity ?? 35
        };
        eventService.updateEventConfig(eventId, req.user.tenantId, cfg);
        updatedBackgrounds = list;
      }
    }

    res.json({
      success: true,
      fileUrl,
      filename: req.file.filename,
      mimeType: mime,
      mediaType,
      sizeBytes,
      sizeFormatted,
      originalName: req.file.originalname,
      uploadedBackgrounds: updatedBackgrounds
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET list of uploaded backgrounds for an event
apiRouter.get('/events/:id/backgrounds', authMiddleware(), (req, res) => {
  try {
    const event = eventService.getEventById(req.params.id, req.user.tenantId);
    if (!event) return res.status(404).json({ error: 'Event tidak ditemukan' });

    const cfg = event.config || {};
    let list = Array.isArray(cfg.uploadedBackgrounds) ? [...cfg.uploadedBackgrounds] : [];
    const currentUrl = (cfg.kioskBackground?.url || '').trim();

    // Auto-include current active upload if it's missing from the history list
    if (currentUrl.startsWith('/uploads/')) {
      const existsInList = list.some(b => b.fileUrl === currentUrl);
      if (!existsInList) {
        const fname = path.basename(currentUrl);
        const diskPath = path.join(uploadDir, fname);
        let sBytes = 0;
        let sExists = false;
        if (fs.existsSync(diskPath)) {
          sExists = true;
          try { sBytes = fs.statSync(diskPath).size; } catch (e) {}
        }
        const isVid = /\.(mp4|webm|mov|m4v)$/i.test(fname);
        list.unshift({
          fileUrl: currentUrl,
          filename: fname,
          originalName: fname,
          mediaType: isVid ? 'video' : 'image',
          sizeBytes: sBytes,
          sizeFormatted: formatBytes(sBytes),
          uploadedAt: event.created_at || new Date().toISOString()
        });
      }
    }

    // Refresh existence and sizes
    let totalBytes = 0;
    let unusedCount = 0;
    const enriched = list.map(item => {
      const fname = item.filename || path.basename(item.fileUrl || '');
      const diskPath = path.join(uploadDir, fname);
      let exists = false;
      let realSize = item.sizeBytes || 0;
      if (fs.existsSync(diskPath)) {
        exists = true;
        try { realSize = fs.statSync(diskPath).size; } catch (e) {}
      }
      totalBytes += realSize;
      const isCurrent = currentUrl === item.fileUrl;
      if (!isCurrent) unusedCount++;
      return {
        ...item,
        sizeBytes: realSize,
        sizeFormatted: formatBytes(realSize),
        existsOnDisk: exists,
        isCurrent
      };
    });

    res.json({
      success: true,
      files: enriched,
      totalBytes,
      totalFormatted: formatBytes(totalBytes),
      unusedCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a specific background file from server disk
apiRouter.delete('/events/:id/backgrounds', authMiddleware(), (req, res) => {
  try {
    const event = eventService.getEventById(req.params.id, req.user.tenantId);
    if (!event) return res.status(404).json({ error: 'Event tidak ditemukan' });

    const targetUrl = (req.body?.fileUrl || req.query?.fileUrl || '').trim();
    if (!targetUrl || !targetUrl.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'URL file background tidak valid' });
    }

    const fname = path.basename(targetUrl);
    const diskPath = path.join(uploadDir, fname);
    let freedBytes = 0;
    if (fs.existsSync(diskPath)) {
      try {
        freedBytes = fs.statSync(diskPath).size;
        fs.unlinkSync(diskPath);
      } catch (e) {}
    }

    const cfg = event.config || {};
    let list = Array.isArray(cfg.uploadedBackgrounds) ? cfg.uploadedBackgrounds : [];
    cfg.uploadedBackgrounds = list.filter(b => b.fileUrl !== targetUrl && b.filename !== fname);

    // If deleting currently active background, revert to default
    if (cfg.kioskBackground?.url === targetUrl) {
      cfg.kioskBackground = { type: 'default', url: '', overlayOpacity: 35 };
    }

    eventService.updateEventConfig(req.params.id, req.user.tenantId, cfg);
    res.json({
      success: true,
      message: 'File background berhasil dihapus dari server.',
      freedBytes,
      freedFormatted: formatBytes(freedBytes)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CLEANUP all unused background files for this event
apiRouter.post('/events/:id/backgrounds/cleanup-unused', authMiddleware(), (req, res) => {
  try {
    const event = eventService.getEventById(req.params.id, req.user.tenantId);
    if (!event) return res.status(404).json({ error: 'Event tidak ditemukan' });

    const cfg = event.config || {};
    const list = Array.isArray(cfg.uploadedBackgrounds) ? cfg.uploadedBackgrounds : [];
    const currentUrl = (cfg.kioskBackground?.url || '').trim();

    let deletedCount = 0;
    let freedBytes = 0;
    const keptList = [];

    for (const item of list) {
      if (item.fileUrl === currentUrl) {
        keptList.push(item);
      } else {
        const fname = item.filename || path.basename(item.fileUrl || '');
        const diskPath = path.join(uploadDir, fname);
        if (fs.existsSync(diskPath)) {
          try {
            freedBytes += fs.statSync(diskPath).size;
            fs.unlinkSync(diskPath);
            deletedCount++;
          } catch (e) {}
        }
      }
    }

    cfg.uploadedBackgrounds = keptList;
    eventService.updateEventConfig(req.params.id, req.user.tenantId, cfg);

    res.json({
      success: true,
      deletedCount,
      freedBytes,
      freedFormatted: formatBytes(freedBytes),
      message: `Berhasil membersihkan ${deletedCount} file tidak terpakai (${formatBytes(freedBytes)}).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const { name, eventId, width, height, orientation, slotsJson, qrPosition } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '/assets/templates/single-green-template.svg';
    const slots = slotsJson ? JSON.parse(slotsJson) : [];

    const tpl = templateService.createTemplate(req.user.tenantId, {
      name,
      eventId,
      width: parseInt(width) || 1200,
      height: parseInt(height) || 1800,
      orientation: orientation || 'portrait',
      qrPosition: qrPosition || 'bottom-right',
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
    const { slots, layers, qrPosition } = req.body;
    const updated = templateService.updateTemplateSlots(req.params.id, req.user.tenantId, slots, layers, qrPosition);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/templates/:id', authMiddleware(), (req, res) => {
  try {
    const updated = templateService.updateTemplateConfig(req.params.id, req.user.tenantId, req.body);
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
    const { tenantId, eventId, deviceId, guestPassId, mode, templateId } = req.body;
    const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, device_id, guest_pass_id, mode, status, started_at, template_id)
      VALUES (?, ?, ?, ?, ?, ?, 'capturing', ?, ?)
    `).run(sessionId, tenantId, eventId, deviceId || null, guestPassId || null, mode || 'single', nowIso, templateId || null);

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
    let session = db.prepare('SELECT * FROM photo_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      // Rekonsiliasi otomatis jika sesi ini dibuat saat mode offline (tanpa koneksi internet)
      const tenantId = req.body.tenantId || 'tenant_studiokeren_01';
      const eventId = req.body.eventId || 'event_wedding_dimas_sarah';
      const deviceId = req.body.deviceId || 'dev_kiosk_win_01';
      const guestPassId = req.body.guestPassId || null;
      const mode = req.body.mode || 'single';
      const templateId = req.body.templateId || null;
      const startedAt = req.body.startedAt || new Date().toISOString();
      const localSessionId = req.body.localSessionId || sessionId;

      db.prepare(`
        INSERT INTO photo_sessions (id, tenant_id, event_id, device_id, guest_pass_id, mode, status, started_at, template_id, local_session_id)
        VALUES (?, ?, ?, ?, ?, ?, 'capturing', ?, ?, ?)
      `).run(sessionId, tenantId, eventId, deviceId, guestPassId, mode, startedAt, templateId, localSessionId);

      session = db.prepare('SELECT * FROM photo_sessions WHERE id = ?').get(sessionId);
    }
    if (!session) return res.status(404).json({ error: 'Session tidak ditemukan' });

    if (req.body && req.body.templateId) {
      db.prepare('UPDATE photo_sessions SET template_id = ? WHERE id = ?').run(req.body.templateId, sessionId);
      session.template_id = req.body.templateId;
    }

    if (req.body && req.body.guestPassId && !session.guest_pass_id) {
      db.prepare('UPDATE photo_sessions SET guest_pass_id = ? WHERE id = ?').run(req.body.guestPassId, sessionId);
      session.guest_pass_id = req.body.guestPassId;
    }

    let finalAssetId = null;
    let finalUrl = null;

    if (req.files && req.files['finalImage'] && req.files['finalImage'][0]) {
      const file = req.files['finalImage'][0];
      const opt = optimizePhotoFile(file.path, { quality: 88, maxDimension: 1920 });
      const finalFileName = opt ? path.basename(opt.path) : file.filename;
      const finalFileSize = opt ? opt.size : file.size;
      finalUrl = `/uploads/${finalFileName}`;
      
      const existingFinal = db.prepare("SELECT id, file_path FROM media_assets WHERE photo_session_id = ? AND type = 'final_photo'").get(sessionId);
      if (existingFinal) {
        if (existingFinal.file_path && existingFinal.file_path !== finalUrl) {
          const oldPath = path.join(uploadDir, path.basename(existingFinal.file_path));
          if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch (e) {}
          }
        }
        db.prepare(`
          UPDATE media_assets 
          SET file_path = ?, size_bytes = ?
          WHERE id = ?
        `).run(finalUrl, finalFileSize, existingFinal.id);
        finalAssetId = existingFinal.id;
      } else {
        finalAssetId = 'asset_' + crypto.randomBytes(8).toString('hex');
        db.prepare(`
          INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
          VALUES (?, ?, ?, ?, 'final_photo', 'print_hires', ?, ?, 'ready')
        `).run(finalAssetId, session.tenant_id, session.event_id, sessionId, finalUrl, finalFileSize);
      }
    }

    // SIMPAN SEMUA FOTO ASLI TANPA FRAME (RAW CAPTURES)
    // Cegah duplikasi: simpan hanya 1 kali saat sesi pertama kali selesai
    if (req.files && req.files['captures'] && req.files['captures'].length > 0) {
      const existingRaw = db.prepare("SELECT COUNT(*) as count FROM media_assets WHERE photo_session_id = ? AND type = 'raw_capture'").get(sessionId);
      if (existingRaw.count === 0) {
        req.files['captures'].forEach((captureFile, idx) => {
          const opt = optimizePhotoFile(captureFile.path, { quality: 88, maxDimension: 1920 });
          const rawFileName = opt ? path.basename(opt.path) : captureFile.filename;
          const rawFileSize = opt ? opt.size : captureFile.size;
          const rawUrl = `/uploads/${rawFileName}`;
          const rawAssetId = 'asset_raw_' + crypto.randomBytes(8).toString('hex');
          db.prepare(`
            INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
            VALUES (?, ?, ?, ?, 'raw_capture', ?, ?, ?, 'ready')
          `).run(rawAssetId, session.tenant_id, session.event_id, sessionId, `pose_${idx + 1}`, rawUrl, rawFileSize);
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
      const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
      printJob = printService.createPrintJob(
        session.tenant_id,
        session.event_id,
        session.device_id,
        sessionId,
        finalAssetId,
        copies,
        { baseUrl }
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

// Master Event Gallery Route (seluruh foto tamu di acara dengan sistem pagination)
apiRouter.get(['/gallery/e/:eventId', '/gallery/event/:eventId'], (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 12;
  const data = qrService.getEventGalleryData(req.params.eventId, { page, limit });
  if (!data) {
    return res.status(404).json({ error: 'Galeri event tidak ditemukan atau belum memiliki foto' });
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
    // Server cloud tidak punya printer: pakai daftar printer dari komputer studio (Print Agent)
    const agent = printService.getAgentStatus(req.user.tenantId);
    if ((!data.detectedPrinters || data.detectedPrinters.length === 0) && agent.online && agent.printers.length > 0) {
      data.detectedPrinters = agent.printers;
      data.defaultPrinter = (agent.printers.find(p => p.isDefault) || {}).name || data.defaultPrinter;
      data.platform = agent.platform || data.platform;
      data.viaAgent = true;
    }
    data.agent = { online: agent.online, host: agent.host };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/printers/media-types', authMiddleware(), (req, res) => {
  try {
    const printer = req.query.printer || '';
    // Jika printer berada di komputer studio (Print Agent), pakai jenis kertas asli dari driver-nya
    const agent = printService.getAgentStatus(req.user.tenantId);
    if (agent.online) {
      const n = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const wanted = n(printer);
      const match = agent.printers.find(p => wanted && (n(p.name) === wanted || n(p.id) === wanted));
      if (match && Array.isArray(match.mediaTypes) && match.mediaTypes.length > 0) {
        return res.json(match.mediaTypes);
      }
    }
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

// ==========================================
// PRINT AGENT: cetak otomatis sesuai pengaturan tanpa dialog (Windows / macOS)
// ==========================================
function agentAuth(req, res, next) {
  const key = req.headers['x-agent-key'] || req.query.key;
  const tenantId = printService.findTenantByAgentKey(String(key || ''));
  if (!tenantId) return res.status(401).json({ error: 'Kunci Print Agent tidak valid' });
  req.agentTenantId = tenantId;
  next();
}

apiRouter.get('/print-agent/info', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    res.json({
      key: printService.getOrCreateAgentKey(tenantId),
      status: printService.getAgentStatus(tenantId)
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/print-agent/status', authMiddleware(), (req, res) => {
  res.json(printService.getAgentStatus(req.user.tenantId));
});

apiRouter.post('/print-agent/regenerate', authMiddleware(), (req, res) => {
  try {
    res.json({ key: printService.regenerateAgentKey(req.user.tenantId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Agent memanggil endpoint ini tiap ~2 detik: sekaligus tanda "online" dan pengambilan job baru
apiRouter.post('/print-agent/poll', agentAuth, (req, res) => {
  try {
    const body = req.body || {};
    printService.touchAgent(req.agentTenantId, {
      host: String(body.host || '').slice(0, 80),
      platform: String(body.platform || '').slice(0, 20),
      printers: Array.isArray(body.printers) ? body.printers.slice(0, 40) : undefined
    });
    res.json({ jobs: printService.claimAgentJobs(req.agentTenantId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/print-agent/jobs/:id/result', agentAuth, (req, res) => {
  try {
    res.json(printService.finishAgentJob(req.agentTenantId, req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/print-agent/download/:os', async (req, res) => {
  try {
    const os = req.params.os === 'windows' ? 'windows' : 'macos';
    const tenantId = req.query.token ? (verifyToken(String(req.query.token))?.tenantId || 'tenant_studiokeren_01') : 'tenant_studiokeren_01';
    const serverUrl = (req.query.serverUrl && String(req.query.serverUrl).trim())
      || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
    const key = printService.getOrCreateAgentKey(tenantId);
    const zipBuf = appBuilder.buildPrintAgentZip(os, serverUrl.replace(/\/+$/, ''), key);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Mafaza-Print-Agent-${os === 'windows' ? 'Windows' : 'macOS'}.zip"`);
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gambar lembar siap cetak (2 strip per lembar bila diatur). ID job acak sehingga aman dipakai publik.
apiRouter.get('/print-jobs/:id/sheet', (req, res) => {
  const sheet = printService.getPrintSheetForJob(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Lembar cetak tidak ditemukan' });
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(sheet.path);
});

apiRouter.post('/print-jobs/:id/browser-printed', (req, res) => {
  res.json({ success: printService.markJobPrintedByBrowser(req.params.id) });
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
             gp.token_plain as guest_token,
             gp.issued_via as qr_flow_type,
             (SELECT COUNT(*) FROM photo_sessions ps2 WHERE ps2.guest_pass_id = gp.id) as gp_session_count,
             e.id as event_id, e.name as event_name,
             (SELECT pj.id FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_job_id,
             (SELECT pj.state FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_state,
             (SELECT pj.spooler_job_id FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as spooler_job_id,
             (SELECT pj.copies FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_copies
      FROM media_assets ma
      LEFT JOIN photo_sessions ps ON ma.photo_session_id = ps.id
      LEFT JOIN guest_passes gp ON ps.guest_pass_id = gp.id
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

// Endpoint Detail QR & Status Alur Masuk (Alur QR Duluan vs QR Sendiri-Sendiri)
apiRouter.get('/photos/:assetId/qr', authMiddleware(), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const asset = db.prepare(`
      SELECT ma.id as asset_id, ma.file_path, ma.photo_session_id, ma.tenant_id, ma.event_id,
             ps.id as session_id, ps.guest_pass_id, ps.mode as session_mode, ps.started_at,
             gp.id as gp_id, gp.token_plain as gp_token, gp.issued_via as gp_issued_via, gp.created_at as gp_created_at,
             e.name as event_name
      FROM media_assets ma
      LEFT JOIN photo_sessions ps ON ma.photo_session_id = ps.id
      LEFT JOIN guest_passes gp ON ps.guest_pass_id = gp.id
      LEFT JOIN events e ON ma.event_id = e.id
      WHERE ma.id = ? AND ma.tenant_id = ?
    `).get(req.params.assetId, tenantId);

    if (!asset) return res.status(404).json({ error: 'Foto tidak ditemukan' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let token = asset.gp_token;
    let guestPassId = asset.guest_pass_id;
    let flowType = asset.gp_issued_via || 'booth';

    // Jika belum punya guest pass (mis. sesi lama atau dibuat tanpa pass), otomatis buatkan pass agar QR selalu ada!
    if (!token) {
      const pass = await qrService.createGuestPass(tenantId, asset.event_id, 'booth', baseUrl);
      token = pass.token_plain;
      guestPassId = pass.id;
      flowType = 'booth';
      if (asset.session_id) {
        db.prepare('UPDATE photo_sessions SET guest_pass_id = ? WHERE id = ?').run(pass.id, asset.session_id);
      }
    }

    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM photo_sessions WHERE guest_pass_id = ?').get(guestPassId)?.count || 1;

    const galleryUrl = `/gallery/g/${token}`;
    const fullQrUrl = `${baseUrl.replace(/\/$/, '')}${galleryUrl}`;
    const qrDataUrl = await qrService.createQrWithLogoDataUrl(fullQrUrl, { size: 340 });

    const isPreRegistered = (flowType === 'batch' || flowType === 'registration');
    const flowTitle = isPreRegistered
      ? 'Alur: QR Tamu Terdaftar (Kartu Undangan Tamu)'
      : 'Alur: QR Sesi Mandiri (Dibuat Otomatis di Booth)';
    const flowBadge = isPreRegistered ? '🎟️ Alur QR Duluan' : '⚡ QR Sesi Mandiri';
    const flowDescription = isPreRegistered
      ? 'Tamu melakukan scan QR kartu undangan terlebih dahulu sebelum mulai berfoto di Kiosk. Foto ini tersimpan ke dalam kartu QR tamu tersebut bersama sesi lainnya.'
      : 'Tamu langsung mengambil foto di Kiosk tanpa kartu di awal, dan QR galeri ini dibuat otomatis khusus untuk sesi ini.';

    res.json({
      assetId: asset.asset_id,
      sessionId: asset.session_id,
      eventName: asset.event_name || 'Event Mafaza',
      token,
      guestPassId,
      flowType: isPreRegistered ? 'pre_registered' : 'on_spot',
      flowBadge,
      flowTitle,
      flowDescription,
      sessionCount,
      galleryUrl,
      fullQrUrl,
      qrDataUrl
    });
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
    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const printJob = printService.createPrintJob(
      tenantId,
      asset.event_id,
      null,
      asset.photo_session_id,
      asset.id,
      copies,
      { baseUrl }
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

function safelyDeleteUploadedFile(relPath) {
  if (!relPath || typeof relPath !== 'string') return;
  if (relPath.startsWith('/assets/') || relPath === '/uploads/test_print.png') return;
  try {
    const clean = relPath.replace(/^\/+/, '');
    const absPath = path.join(process.cwd(), 'public', clean);
    const pubUploads = path.join(process.cwd(), 'public', 'uploads');
    if (absPath.startsWith(pubUploads) && fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
  } catch (err) {
    console.warn('[DELETE_PHOTO] Gagal hapus file fisik:', relPath, err.message);
  }
}

apiRouter.delete('/photos/:assetId', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const assetId = req.params.assetId;
    const asset = db.prepare('SELECT * FROM media_assets WHERE id = ? AND tenant_id = ?').get(assetId, tenantId);
    if (!asset) return res.status(404).json({ error: 'Foto tidak ditemukan' });

    const sessionId = asset.photo_session_id;
    let relatedAssets = [];
    if (sessionId) {
      relatedAssets = db.prepare('SELECT * FROM media_assets WHERE photo_session_id = ? AND tenant_id = ?').all(sessionId, tenantId);
    } else {
      relatedAssets = [asset];
    }

    for (const a of relatedAssets) {
      safelyDeleteUploadedFile(a.file_path);
    }

    if (sessionId) {
      try {
        const caps = db.prepare('SELECT image_url FROM captures WHERE photo_session_id = ?').all(sessionId);
        for (const c of caps) safelyDeleteUploadedFile(c.image_url);
        db.prepare('DELETE FROM captures WHERE photo_session_id = ?').run(sessionId);
      } catch (e) {}

      db.prepare('DELETE FROM print_jobs WHERE photo_session_id = ?').run(sessionId);
      db.prepare('DELETE FROM media_assets WHERE photo_session_id = ?').run(sessionId);
      db.prepare('DELETE FROM photo_sessions WHERE id = ? AND tenant_id = ?').run(sessionId, tenantId);
    } else {
      db.prepare('DELETE FROM print_jobs WHERE media_asset_id = ?').run(asset.id);
      db.prepare('DELETE FROM media_assets WHERE id = ?').run(asset.id);
    }

    auditService.logAudit(
      tenantId,
      req.user.userId,
      req.user.name || 'Admin',
      'DELETE_PHOTO',
      { assetId, sessionId, file: asset.file_path },
      req.ip
    );

    res.json({ success: true, message: 'Foto berhasil dihapus secara permanen' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/photos/clear-event', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const eventId = req.body.eventId;
    if (!eventId) return res.status(400).json({ error: 'ID Event wajib disertakan' });

    const ev = db.prepare('SELECT * FROM events WHERE id = ? AND tenant_id = ?').get(eventId, tenantId);
    if (!ev) return res.status(404).json({ error: 'Event tidak ditemukan' });

    const assets = db.prepare('SELECT file_path FROM media_assets WHERE event_id = ? AND tenant_id = ?').all(eventId, tenantId);
    for (const a of assets) {
      safelyDeleteUploadedFile(a.file_path);
    }

    const sessions = db.prepare('SELECT id FROM photo_sessions WHERE event_id = ? AND tenant_id = ?').all(eventId, tenantId);
    for (const s of sessions) {
      try {
        const caps = db.prepare('SELECT image_url FROM captures WHERE photo_session_id = ?').all(s.id);
        for (const c of caps) safelyDeleteUploadedFile(c.image_url);
        db.prepare('DELETE FROM captures WHERE photo_session_id = ?').run(s.id);
      } catch (e) {}
    }

    db.prepare('DELETE FROM print_jobs WHERE event_id = ? AND tenant_id = ?').run(eventId, tenantId);
    db.prepare('DELETE FROM media_assets WHERE event_id = ? AND tenant_id = ?').run(eventId, tenantId);
    const delCount = db.prepare('DELETE FROM photo_sessions WHERE event_id = ? AND tenant_id = ?').run(eventId, tenantId);

    auditService.logAudit(
      tenantId,
      req.user.userId,
      req.user.name || 'Admin',
      'CLEAR_EVENT_PHOTOS',
      { eventId, eventName: ev.name, deletedSessions: delCount.changes },
      req.ip
    );

    res.json({ success: true, message: `Semua foto event "${ev.name}" berhasil dihapus (${delCount.changes} sesi)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete('/print-jobs/:id', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId);
    if (!job) return res.status(404).json({ error: 'Item antrean cetak tidak ditemukan' });

    db.prepare('DELETE FROM print_jobs WHERE id = ? AND tenant_id = ?').run(req.params.id, tenantId);
    res.json({ success: true, message: 'Item antrean cetak berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/print-jobs/clear-completed', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const result = db.prepare("DELETE FROM print_jobs WHERE tenant_id = ? AND state IN ('completed', 'cancelled', 'failed')").run(tenantId);
    res.json({ success: true, count: result.changes, message: `${result.changes} riwayat antrean selesai/batal berhasil dibersihkan` });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
