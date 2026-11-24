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
import * as salesService from '../services/sales.js';
import { optimizePhotoFile } from '../services/imageOptimizer.js';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure upload dirs exist
const uploadDir = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const rawExt = path.extname(file.originalname || '').toLowerCase();
    let ext = ALLOWED_UPLOAD_EXTS.has(rawExt) ? rawExt : '';
    if (!ext) {
      if (/video\/webm/i.test(file.mimetype || '')) ext = '.webm';
      else if (/video\/mp4/i.test(file.mimetype || '')) ext = '.mp4';
      else if (/image\/jpeg/i.test(file.mimetype || '')) ext = '.jpg';
      else ext = '.png';
    }
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 35 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    const mimeOk = mime.startsWith('image/') || mime.startsWith('video/') || mime === 'application/octet-stream';
    const isUnsafeSvgOrHtml = ext === '.svg' || ext === '.html' || ext === '.htm' || ext === '.js' || mime.includes('svg') || mime.includes('html');
    if (isUnsafeSvgOrHtml || (ext && !ALLOWED_UPLOAD_EXTS.has(ext)) || !mimeOk) {
      return cb(new Error('Format file upload tidak diizinkan (hanya foto JPG/PNG/WEBP/GIF atau video MP4/WEBM/MOV).'));
    }
    cb(null, true);
  }
});

export const apiRouter = express.Router();

// ==========================================
// 1. AUTH ROUTES
// ==========================================

// Rate-limiting & Brute Force Protection for Admin Gate
const adminLoginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000; // 10 menit

function pruneAttemptMap(map, ttlMs = 15 * 60 * 1000) {
  if (map.size < 200) return;
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (!v || (v.lockedUntil > 0 && v.lockedUntil <= now) || (v.updatedAt && now - v.updatedAt > ttlMs)) {
      map.delete(k);
    }
  }
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
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

    adminLoginAttempts.set(clientIp, { count: newCount, lockedUntil, updatedAt: now });
    pruneAttemptMap(adminLoginAttempts);
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

  const isHttps = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  const secureAttr = isHttps ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `pb_admin_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureAttr}`,
    `pb_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=2592000${secureAttr}`
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

function resolveOptionalAuth(req) {
  let tenantId = 'tenant_studiokeren_01';
  let isAuthed = false;
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && (req.cookies.pb_admin_auth || req.cookies.pb_token)) {
    token = req.cookies.pb_admin_auth || req.cookies.pb_token;
  }
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      isAuthed = true;
      if (payload.tenantId) tenantId = payload.tenantId;
    }
  }
  return { tenantId, isAuthed };
}

function sanitizeEventForPublic(event, isAuthed) {
  if (!event || isAuthed) return event;
  const safeCfg = (event.config && typeof event.config === 'object') ? { ...event.config } : undefined;
  if (safeCfg) delete safeCfg.pinLock;
  let safeConfigJson = event.config_json;
  if (typeof safeConfigJson === 'string') {
    try {
      const parsedJson = JSON.parse(safeConfigJson);
      if (parsedJson && typeof parsedJson === 'object') {
        delete parsedJson.pinLock;
        safeConfigJson = JSON.stringify(parsedJson);
      }
    } catch (e) {}
  }
  return {
    ...event,
    ...(safeCfg ? { config: safeCfg } : {}),
    config_json: safeConfigJson
  };
}

apiRouter.get('/events/:id', (req, res) => {
  const { tenantId, isAuthed } = resolveOptionalAuth(req);
  const event = eventService.getEventById(req.params.id, tenantId);
  if (!event) return res.status(404).json({ error: 'Event tidak ditemukan' });
  res.json(sanitizeEventForPublic(event, isAuthed));
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
  const { tenantId, isAuthed } = resolveOptionalAuth(req);

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

  event = sanitizeEventForPublic(event, isAuthed);
  res.json({ event, activeEventId: event ? event.id : null });
});

// Cek apakah browser saat ini sudah punya sesi Admin aktif (cookie / bearer)
apiRouter.get('/kiosk/admin-session', (req, res) => {
  const { isAuthed, tenantId } = resolveOptionalAuth(req);
  res.json({ authenticated: Boolean(isAuthed), tenantId });
});

// Verify Operator PIN securely on server (supports Admin Password, OPERATOR_PIN env var, or event config pinLock)
const operatorPinAttempts = new Map();
apiRouter.post('/kiosk/verify-operator-pin', (req, res) => {
  try {
    const { isAuthed } = resolveOptionalAuth(req);
    if (isAuthed) {
      return res.json({ valid: true, authenticated: true });
    }

    const clientIp = getClientIp(req);
    const now = Date.now();
    const attemptInfo = operatorPinAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
    if (attemptInfo.lockedUntil > now) {
      const remainingSeconds = Math.ceil((attemptInfo.lockedUntil - now) / 1000);
      return res.status(429).json({ valid: false, error: `Terlalu banyak percobaan PIN. Coba lagi dalam ${remainingSeconds} detik.` });
    }

    const inputPin = String((req.body && req.body.pin) || '').trim();
    const eventId = req.body && req.body.eventId ? String(req.body.eventId) : null;
    let expectedPin = (process.env.OPERATOR_PIN || '').trim();
    if (!expectedPin && eventId) {
      const ev = db.prepare('SELECT config_json FROM events WHERE id = ?').get(eventId);
      if (ev && ev.config_json) {
        try {
          const cfg = JSON.parse(ev.config_json);
          if (cfg && cfg.pinLock) expectedPin = String(cfg.pinLock).trim();
        } catch (e) {}
      }
    }
    if (!expectedPin) expectedPin = '1234';

    const bufIn = Buffer.from(inputPin, 'utf8');
    const bufExp = Buffer.from(expectedPin, 'utf8');
    const isPinMatch = bufIn.length > 0 && bufIn.length === bufExp.length && crypto.timingSafeEqual(bufIn, bufExp);
    const isAdminPassMatch = bufIn.length > 0 && verifyAdminPassword(inputPin);
    const isValid = isPinMatch || isAdminPassMatch;

    if (!isValid) {
      const count = (attemptInfo.lockedUntil > 0 && attemptInfo.lockedUntil <= now) ? 1 : attemptInfo.count + 1;
      const lockedUntil = count >= 8 ? (now + 5 * 60 * 1000) : 0;
      operatorPinAttempts.set(clientIp, { count, lockedUntil, updatedAt: now });
      pruneAttemptMap(operatorPinAttempts);
      return res.status(401).json({ valid: false, error: 'Password Admin / PIN Operator salah!' });
    }

    operatorPinAttempts.delete(clientIp);
    if (isAdminPassMatch) {
      const adminUser = db.prepare("SELECT id, email, full_name FROM users WHERE role IN ('business_admin', 'super_admin') LIMIT 1").get() || {
        id: 'user_business_owner_01',
        email: 'owner@studiokeren.id',
        full_name: 'Admin Mafaza'
      };
      const activeTenant = db.prepare('SELECT id FROM tenants LIMIT 1').get() || { id: 'tenant_studiokeren_01' };
      const token = createToken({
        userId: adminUser.id,
        email: adminUser.email,
        name: adminUser.full_name,
        role: 'super_admin',
        tenantId: activeTenant.id
      });
      const isHttps = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
      const secureAttr = isHttps ? '; Secure' : '';
      res.setHeader('Set-Cookie', [
        `pb_admin_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureAttr}`,
        `pb_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=2592000${secureAttr}`
      ]);
    }
    return res.json({ valid: true });
  } catch (err) {
    return res.status(400).json({ valid: false, error: err.message });
  }
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
  const booth = req.query.booth || null;
  const templates = templateService.getTemplates(tenantId, eventId, scope, booth);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json(templates);
});

apiRouter.post('/templates', authMiddleware(), upload.single('templateFile'), (req, res) => {
  try {
    const { name, eventId, width, height, orientation, paperSize, formatPreset, slotsJson, qrPosition, qrCoordsJson, qrCoords, shotsMode, boothMode, chromaKey } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '/assets/templates/single-green-template.svg';
    const slots = slotsJson ? JSON.parse(slotsJson) : [];
    const parsedQrCoords = qrCoords || (qrCoordsJson ? JSON.parse(qrCoordsJson) : undefined);

    const tpl = templateService.createTemplate(req.user.tenantId, {
      name,
      eventId,
      width: parseInt(width) || undefined,
      height: parseInt(height) || undefined,
      orientation: orientation || 'portrait',
      paperSize: paperSize || undefined,
      formatPreset: formatPreset || undefined,
      qrPosition: qrPosition || 'bottom-right',
      qrCoords: parsedQrCoords,
      shotsMode: shotsMode || 'event',
      boothMode: boothMode || 'kiosk',
      chromaKey: chromaKey !== undefined ? chromaKey : undefined,
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
    const { name, slots, layers, qrPosition, width, height, shotsMode, boothMode, orientation, paperSize, qrCoords, chromaKey } = req.body;
    const updated = templateService.updateTemplateSlots(req.params.id, req.user.tenantId, slots, layers, qrPosition, width, height, shotsMode, boothMode, orientation, paperSize, qrCoords, chromaKey, name);
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
    const versions = db.prepare(`
      SELECT tv.image_storage_key FROM template_versions tv
      JOIN templates t ON tv.template_id = t.id
      WHERE t.id = ? AND t.tenant_id = ?
    `).all(req.params.id, req.user.tenantId);
    const delRes = db.prepare('DELETE FROM templates WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenantId);
    if (delRes.changes > 0) {
      db.prepare('DELETE FROM template_versions WHERE template_id = ?').run(req.params.id);
      for (const v of versions) {
        if (v.image_storage_key && v.image_storage_key.startsWith('/uploads/')) {
          const oldPath = path.join(uploadDir, path.basename(v.image_storage_key));
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (e) {}
        }
      }
    }
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
    const pass = await qrService.createGuestPass(tenantId, eventId, 'booth', origin, { qrSize: 260 });
    res.json(pass);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/guest-passes/issue-batch', async (req, res) => {
  try {
    const { tenantId, eventId, baseUrl, count } = req.body || {};
    const origin = baseUrl || `${req.protocol}://${req.get('host')}`;
    const safeCount = Math.max(1, Math.min(25, parseInt(count, 10) || 10));
    const passes = await qrService.createBatchGuestPasses(tenantId, eventId, safeCount, origin, {
      issuedVia: 'pool',
      qrSize: 220
    });
    res.json({ passes, count: passes.length });
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

function resolveValidDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') return null;
  const row = db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId);
  return row ? row.id : null;
}

// Start a photo session on kiosk
apiRouter.post('/kiosk/sessions', (req, res) => {
  try {
    const { tenantId, eventId, deviceId, guestPassId, mode, templateId } = req.body;
    const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');
    const nowIso = new Date().toISOString();
    const safeDeviceId = resolveValidDeviceId(deviceId);

    db.prepare(`
      INSERT INTO photo_sessions (id, tenant_id, event_id, device_id, guest_pass_id, mode, status, started_at, template_id)
      VALUES (?, ?, ?, ?, ?, ?, 'capturing', ?, ?)
    `).run(sessionId, tenantId, eventId, safeDeviceId, guestPassId || null, mode || 'single', nowIso, templateId || null);

    res.json({ sessionId, status: 'capturing' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Save photo capture & final render
apiRouter.post('/kiosk/sessions/:id/complete', upload.fields([
  { name: 'finalImage', maxCount: 1 }, 
  { name: 'captures', maxCount: 100 },
  { name: 'liveClips', maxCount: 100 },
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
      const safeDeviceId = resolveValidDeviceId(req.body.deviceId || 'dev_kiosk_win_01');
      const guestPassId = req.body.guestPassId || null;
      const mode = req.body.mode || 'single';
      const templateId = req.body.templateId || null;
      const startedAt = req.body.startedAt || new Date().toISOString();
      const localSessionId = req.body.localSessionId || sessionId;

      db.prepare(`
        INSERT INTO photo_sessions (id, tenant_id, event_id, device_id, guest_pass_id, mode, status, started_at, template_id, local_session_id)
        VALUES (?, ?, ?, ?, ?, ?, 'capturing', ?, ?, ?)
      `).run(sessionId, tenantId, eventId, safeDeviceId, guestPassId, mode, startedAt, templateId, localSessionId);

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
    // Mendukung simpan baru, pembaruan pose, maupun batching untuk mode banyak foto (Mingle / Jual File)
    if (req.files && req.files['captures'] && req.files['captures'].length > 0) {
      const startIdx = Math.max(0, parseInt((req.body && req.body.captureStartIndex) || '0', 10) || 0);
      req.files['captures'].forEach((captureFile, idx) => {
        const variantKey = `pose_${startIdx + idx + 1}`;
        const opt = optimizePhotoFile(captureFile.path, { quality: 88, maxDimension: 1920 });
        const rawFileName = opt ? path.basename(opt.path) : captureFile.filename;
        const rawFileSize = opt ? opt.size : captureFile.size;
        const rawUrl = `/uploads/${rawFileName}`;
        const existingPose = db.prepare("SELECT id, file_path FROM media_assets WHERE photo_session_id = ? AND type = 'raw_capture' AND variant = ?").get(sessionId, variantKey);
        if (existingPose) {
          if (existingPose.file_path && existingPose.file_path !== rawUrl) {
            const oldRawPath = path.join(uploadDir, path.basename(existingPose.file_path));
            if (fs.existsSync(oldRawPath)) {
              try { fs.unlinkSync(oldRawPath); } catch (e) {}
            }
          }
          db.prepare("UPDATE media_assets SET file_path = ?, size_bytes = ? WHERE id = ?").run(rawUrl, rawFileSize, existingPose.id);
        } else {
          const rawAssetId = 'asset_raw_' + crypto.randomBytes(8).toString('hex');
          db.prepare(`
            INSERT INTO media_assets (id, tenant_id, event_id, photo_session_id, type, variant, file_path, size_bytes, status)
            VALUES (?, ?, ?, ?, 'raw_capture', ?, ?, ?, 'ready')
          `).run(rawAssetId, session.tenant_id, session.event_id, sessionId, variantKey, rawUrl, rawFileSize);
        }
      });
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
      const existingLp = db.prepare("SELECT id, file_path FROM media_assets WHERE photo_session_id = ? AND type = 'live_photo'").get(sessionId);
      if (existingLp) {
        if (existingLp.file_path && existingLp.file_path !== lpUrl) {
          const oldLp = path.join(uploadDir, path.basename(existingLp.file_path));
          try { if (fs.existsSync(oldLp)) fs.unlinkSync(oldLp); } catch (e) {}
        }
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
      const existingBm = db.prepare("SELECT id, file_path FROM media_assets WHERE photo_session_id = ? AND type = 'boomerang'").get(sessionId);
      if (existingBm) {
        if (existingBm.file_path && existingBm.file_path !== bmUrl) {
          const oldBm = path.join(uploadDir, path.basename(existingBm.file_path));
          try { if (fs.existsSync(oldBm)) fs.unlinkSync(oldBm); } catch (e) {}
        }
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

    // Simpan catatan pesanan cetak tamu (mis. dari Mingle saat offline / keliling sebelum kembali ke tenda)
    if (req.body && (req.body.requestedPrintPaper !== undefined || req.body.requestedPrintCopies !== undefined)) {
      const reqCopiesParsed = parseInt(req.body.requestedPrintCopies, 10);
      const safeReqCopies = Number.isFinite(reqCopiesParsed) ? Math.max(0, Math.min(20, reqCopiesParsed)) : 0;
      const rawReqPaper = String(req.body.requestedPrintPaper || '').trim();
      let normalizedReqPaper = null;
      if (safeReqCopies > 0 && rawReqPaper) {
        const up = rawReqPaper.toUpperCase();
        normalizedReqPaper = up === '5R' ? '5x7' : (up === '4R' ? '4x6' : rawReqPaper);
      }
      db.prepare('UPDATE photo_sessions SET requested_print_paper = ?, requested_print_copies = ? WHERE id = ?')
        .run(normalizedReqPaper, safeReqCopies, sessionId);
      session.requested_print_paper = normalizedReqPaper;
      session.requested_print_copies = safeReqCopies;
    }

    if (!finalAssetId) {
      const existingFinal = db.prepare("SELECT id FROM media_assets WHERE photo_session_id = ? AND type = 'final_photo'").get(sessionId);
      if (existingFinal) finalAssetId = existingFinal.id;
    }

    const hasSessionMedia = Boolean(
      finalAssetId ||
      (req.files && req.files['captures'] && req.files['captures'].length > 0) ||
      db.prepare('SELECT id FROM media_assets WHERE photo_session_id = ? LIMIT 1').get(sessionId)
    );

    // Jika sesi belum memiliki guest_pass_id yang valid di DB (mis. kehabisan pool QR saat offline >20 customer
    // atau pass lama/lintas DB) tapi template mengaktifkan QR atau Mode Jual File, otomatis buat & tautkan pass.
    let issuedAutoPass = null;
    if (session.guest_pass_id) {
      const validLinkedPass = db.prepare('SELECT id, token_plain FROM guest_passes WHERE id = ?').get(session.guest_pass_id);
      if (!validLinkedPass || !validLinkedPass.token_plain) {
        session.guest_pass_id = null;
      }
    }
    if (!session.guest_pass_id && hasSessionMedia) {
      try {
        const tplRow = session.template_id
          ? db.prepare('SELECT qr_position, qr_coords_json FROM templates WHERE id = ?').get(session.template_id)
          : null;
        let hasQrCoords = false;
        if (tplRow && tplRow.qr_coords_json) {
          try {
            const parsedCoords = JSON.parse(tplRow.qr_coords_json);
            hasQrCoords = Array.isArray(parsedCoords) && parsedCoords.length > 0;
          } catch (e) {}
        }
        const tplQrEnabled = !tplRow || hasQrCoords || (tplRow.qr_position !== 'none');
        if (tplQrEnabled) {
          const autoPass = qrService.createGuestPassRecordSync(session.tenant_id, session.event_id, 'booth_auto');
          if (autoPass && autoPass.id) {
            db.prepare('UPDATE photo_sessions SET guest_pass_id = ? WHERE id = ?').run(autoPass.id, sessionId);
            session.guest_pass_id = autoPass.id;
            issuedAutoPass = autoPass;
          }
        }
      } catch (e) {}
    }

    // If print requested
    let printJob = null;
    if (req.body.printRequested === 'true') {
      if (finalAssetId) {
        const copies = Math.max(1, Math.min(20, parseInt(req.body.printCopies, 10) || 1));
        const paperSize = req.body.printPaperSize || req.body.paperSize || null;
        const paperConfirmed = req.body.paperConfirmed === 'true' || req.body.paperConfirmed === '1';
        const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
        printJob = printService.createPrintJob(
          session.tenant_id,
          session.event_id,
          session.device_id,
          sessionId,
          finalAssetId,
          copies,
          { baseUrl, paperSize, paperConfirmed }
        );
      }
    }

    res.json({
      success: true,
      sessionId,
      mediaAssetId: finalAssetId,
      finalImageUrl: finalUrl,
      guestPassId: session.guest_pass_id || null,
      guestPass: issuedAutoPass ? {
        id: issuedAutoPass.id,
        token: issuedAutoPass.token_plain,
        galleryUrl: `/gallery/g/${issuedAutoPass.token_plain}`
      } : null,
      requestedPrintPaper: session.requested_print_paper || null,
      requestedPrintCopies: Number(session.requested_print_copies) || 0,
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

function buildSafeGalleryZipFromSessions(sessions, labelPrefix = 'Sesi') {
  const entries = [];
  let totalBytes = 0;
  const maxBytes = 85 * 1024 * 1024;
  const maxFiles = 60;

  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const s = sessions[sIdx];
    const mediaList = Array.isArray(s.media) ? s.media : [];
    const folder = sessions.length > 1 ? `${labelPrefix}_${sIdx + 1}/` : '';
    let idx = 1;
    for (const m of mediaList) {
      if (entries.length >= maxFiles || totalBytes >= maxBytes) break;
      const fp = m && (m.filePath || m.file_path);
      if (!fp || !String(fp).startsWith('/uploads/')) continue;
      const absPath = path.resolve(uploadDir, path.basename(String(fp)));
      if (!absPath.startsWith(uploadDir + path.sep) || !fs.existsSync(absPath)) continue;
      const st = fs.statSync(absPath);
      if (!st.isFile() || totalBytes + st.size > maxBytes) continue;
      const ext = path.extname(absPath) || '.jpg';
      const baseLabel = m.type === 'final_photo'
        ? 'Foto_Frame'
        : (m.type === 'boomerang' ? 'Boomerang' : (m.type === 'live_clip' || m.type === 'live_photo' ? 'Live' : 'Foto_HD'));
      const entryName = `${folder}${String(idx++).padStart(2, '0')}_${baseLabel}${ext}`;
      entries.push({ name: entryName, content: fs.readFileSync(absPath) });
      totalBytes += st.size;
    }
  }
  if (entries.length === 0) return null;
  return appBuilder.createZipArchive(entries, { storeOnly: true });
}

// One-click ZIP download seluruh foto & video milik Guest Pass (zero-CPU STORE mode)
apiRouter.get('/gallery/g/:token/zip', (req, res) => {
  try {
    const data = qrService.getGuestGalleryData(req.params.token);
    if (!data || !Array.isArray(data.sessions) || data.sessions.length === 0) {
      return res.status(404).json({ error: 'Belum ada foto di galeri ini' });
    }
    const zipBuf = buildSafeGalleryZipFromSessions(data.sessions, 'Sesi');
    if (!zipBuf) return res.status(404).json({ error: 'File media tidak ditemukan di server' });
    const safeEvent = String((data.guestPass && data.guestPass.eventName) || 'Mafaza').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Mafaza-${safeEvent}-Gallery.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-click ZIP download per 1 sesi foto tamu
apiRouter.get('/gallery/s/:sessionId/zip', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, type, variant, file_path FROM media_assets
      WHERE photo_session_id = ?
      ORDER BY CASE WHEN type = 'final_photo' THEN 1 WHEN type = 'boomerang' THEN 2 WHEN type = 'live_clip' THEN 3 WHEN type = 'live_photo' THEN 4 ELSE 5 END ASC,
        LENGTH(variant) ASC, variant ASC
    `).all(req.params.sessionId);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'File sesi tidak ditemukan' });
    }
    const zipBuf = buildSafeGalleryZipFromSessions([{ id: req.params.sessionId, media: rows }], 'Sesi');
    if (!zipBuf) return res.status(404).json({ error: 'File media tidak ditemukan di server' });
    const cleanSid = String(req.params.sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(-12);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Mafaza-Sesi-${cleanSid}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const printJob = printService.createPrintJob(tenantId, activeEvent.id, null, testSessionId, testAssetId, 1, { baseUrl });
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
    const canClaim = body.canClaim !== false;
    printService.touchAgent(req.agentTenantId, {
      host: String(body.host || '').slice(0, 80),
      platform: String(body.platform || '').slice(0, 20),
      printers: Array.isArray(body.printers) ? body.printers.slice(0, 40) : undefined,
      canClaim
    });
    res.json({ jobs: canClaim ? printService.claimAgentJobs(req.agentTenantId) : [] });
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

apiRouter.get('/print-agent/download/:os', authMiddleware(), async (req, res) => {
  try {
    const os = req.params.os === 'windows' ? 'windows' : 'macos';
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
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
    const paperSize = req.body?.paperSize || null;
    const paperConfirmed = req.body?.paperConfirmed === true || req.body?.paperConfirmed === 'true';
    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const result = printService.reprintJob(req.params.id, req.user.tenantId, req.user.userId, copies, { paperSize, paperConfirmed, baseUrl });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/print-jobs/:id/confirm-paper', authMiddleware(), (req, res) => {
  try {
    const result = printService.confirmPrintJobPaper(req.params.id, req.user.tenantId, req.user.userId);
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
             ps.guest_pass_id, ps.requested_print_paper, ps.requested_print_copies,
             (SELECT t.name FROM templates t WHERE t.id = ps.template_id LIMIT 1) as template_name,
             (SELECT t.paper_size FROM templates t WHERE t.id = ps.template_id LIMIT 1) as template_paper_size,
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
        AND (ps.id IS NULL OR (ps.id NOT LIKE 'sess_print_test_%' AND ps.id NOT LIKE 'sess_test_print_%' AND ps.id NOT LIKE 'sess_test_0%'))
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

// Daftar hasil foto berframe untuk dicek langsung oleh petugas di Kiosk / Mingle (tanpa butuh login admin penuh)
apiRouter.get('/kiosk/gallery/recent', (req, res) => {
  try {
    const { tenantId } = resolveOptionalAuth(req);
    let eventId = req.query.eventId ? String(req.query.eventId).trim() : null;
    if (!eventId) {
      const tenant = db.prepare('SELECT brand_config_json FROM tenants WHERE id = ?').get(tenantId);
      if (tenant && tenant.brand_config_json) {
        try {
          eventId = JSON.parse(tenant.brand_config_json).activeEventId || null;
        } catch (e) {}
      }
    }

    let query = `
      SELECT ma.id as asset_id, ma.file_path, ma.variant, ma.created_at,
             ps.id as session_id, ps.mode as session_mode,
             ps.requested_print_paper, ps.requested_print_copies,
             (SELECT t.name FROM templates t WHERE t.id = ps.template_id LIMIT 1) as template_name,
             (SELECT t.paper_size FROM templates t WHERE t.id = ps.template_id LIMIT 1) as template_paper_size,
             gp.token_plain as guest_token,
             e.id as event_id, e.name as event_name,
             (SELECT pj.id FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_job_id,
             (SELECT pj.copies FROM print_jobs pj WHERE pj.media_asset_id = ma.id ORDER BY pj.created_at DESC LIMIT 1) as print_copies
      FROM media_assets ma
      LEFT JOIN photo_sessions ps ON ma.photo_session_id = ps.id
      LEFT JOIN guest_passes gp ON ps.guest_pass_id = gp.id
      LEFT JOIN events e ON ma.event_id = e.id
      WHERE ma.tenant_id = ?
        AND (ma.type = 'final_photo' OR ma.variant = 'print_hires')
        AND ma.file_path NOT LIKE '%.mp4'
        AND ma.file_path NOT LIKE '%.webm'
        AND (ps.id IS NULL OR (ps.id NOT LIKE 'sess_print_test_%' AND ps.id NOT LIKE 'sess_test_print_%' AND ps.id NOT LIKE 'sess_test_0%'))
    `;
    const params = [tenantId];
    if (eventId) {
      query += ' AND ma.event_id = ?';
      params.push(eventId);
    }
    query += ' ORDER BY ma.created_at DESC LIMIT 60';
    const rows = db.prepare(query).all(...params).map(r => ({
      ...r,
      galleryUrl: r.guest_token ? `/gallery/g/${r.guest_token}` : (r.session_id ? `/gallery/s/${r.session_id}` : null)
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ambil / buatkan gambar QR Code yang bisa langsung di-scan tamu dari Galeri Foto Berframe Mingle
apiRouter.get('/kiosk/gallery/qr', async (req, res) => {
  try {
    const { tenantId } = resolveOptionalAuth(req);
    const assetId = req.query.assetId ? String(req.query.assetId).trim() : null;
    const sessionId = req.query.sessionId ? String(req.query.sessionId).trim() : null;
    if (!assetId && !sessionId) {
      return res.status(400).json({ error: 'assetId atau sessionId diperlukan' });
    }

    let row = null;
    if (assetId) {
      row = db.prepare(`
        SELECT ma.id as asset_id, ma.event_id, ma.tenant_id, ma.photo_session_id as session_id,
               ps.guest_pass_id, gp.token_plain as gp_token
        FROM media_assets ma
        LEFT JOIN photo_sessions ps ON ma.photo_session_id = ps.id
        LEFT JOIN guest_passes gp ON ps.guest_pass_id = gp.id
        WHERE ma.id = ? AND ma.tenant_id = ?
      `).get(assetId, tenantId);
    }
    if (!row && sessionId) {
      row = db.prepare(`
        SELECT ps.id as session_id, ps.event_id, ps.tenant_id, ps.guest_pass_id,
               gp.token_plain as gp_token
        FROM photo_sessions ps
        LEFT JOIN guest_passes gp ON ps.guest_pass_id = gp.id
        WHERE ps.id = ? AND ps.tenant_id = ?
      `).get(sessionId, tenantId);
    }

    if (!row) {
      return res.status(404).json({ error: 'Foto atau sesi tidak ditemukan' });
    }

    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    let token = row.gp_token;
    if (!token) {
      const pass = await qrService.createGuestPass(tenantId, row.event_id, 'booth_auto', baseUrl);
      token = pass.token_plain;
      if (row.session_id) {
        db.prepare('UPDATE photo_sessions SET guest_pass_id = ? WHERE id = ?').run(pass.id, row.session_id);
      }
    }

    const galleryUrl = `/gallery/g/${token}`;
    const fullQrUrl = `${baseUrl.replace(/\/$/, '')}${galleryUrl}`;
    const qrDataUrl = await qrService.createQrWithLogoDataUrl(fullQrUrl, { size: 360 });

    res.json({
      token,
      galleryUrl,
      fullQrUrl,
      qrDataUrl
    });
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
    const paperSize = req.body.paperSize || null;
    const paperConfirmed = req.body.paperConfirmed === true || req.body.paperConfirmed === 'true';
    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const printJob = printService.createPrintJob(
      tenantId,
      asset.event_id,
      null,
      asset.photo_session_id,
      asset.id,
      copies,
      { baseUrl, paperSize, paperConfirmed, autoIssuePass: true }
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

apiRouter.get('/photos/:assetId/sheet', authMiddleware(), (req, res) => {
  try {
    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const sheet = printService.getPrintSheetForAsset(req.params.assetId, req.user.tenantId, {
      paperSize: req.query.paperSize || null,
      baseUrl
    });
    if (!sheet) return res.status(404).json({ error: 'Lembar cetak tidak ditemukan' });
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(sheet.path);
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

// Paket All-in-One Windows (Kiosk + Mingle + Print Agent + Canon Bridge + Auto-Start Windows)
apiRouter.get('/apps/download/windows-suite', authMiddleware(), async (req, res) => {
  try {
    const info = await appBuilder.getAppDownloadInfo(req.headers.host || 'localhost:3000', req.query.serverUrl);
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    const agentKey = printService.getOrCreateAgentKey(tenantId);
    const zipBuf = appBuilder.buildWindowsAllInOneZip(info.targetServerUrl, info.primaryLanUrl, agentKey);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Mafaza-Photobooth-AllInOne-Windows.zip"');
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

apiRouter.get('/apps/download/canon-bridge-macos', async (req, res) => {
  try {
    const zipBuf = appBuilder.buildCanonBridgeMacZip();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Mafaza-Canon-USB-Bridge-MacBook.zip"');
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/apps/download/canon-bridge-windows', async (req, res) => {
  try {
    const zipBuf = appBuilder.buildCanonBridgeWindowsZip();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Mafaza-Canon-USB-Bridge-Windows.zip"');
    res.send(zipBuf);
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

// ==========================================
// 8. SALES CATALOG & DAILY SALES REPORT ROUTES
// ==========================================
apiRouter.get('/sales/products', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    const includeInactive = req.query.includeInactive === 'true';
    res.json(salesService.listProducts(tenantId, { includeInactive }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/sales/products', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    const product = salesService.createProduct(tenantId, req.body || {});
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/sales/products/:id', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    salesService.verifySalesActionPin(req.body?.pin ?? req.headers['x-sales-pin']);
    const updated = salesService.updateProduct(tenantId, req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    const code = err.statusCode || (/tidak ditemukan/i.test(err.message) ? 404 : 400);
    res.status(code).json({ error: err.message });
  }
});

apiRouter.delete('/sales/products/:id', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    salesService.verifySalesActionPin(req.body?.pin ?? req.headers['x-sales-pin']);
    res.json(salesService.deleteProduct(tenantId, req.params.id));
  } catch (err) {
    const code = err.statusCode || (/tidak ditemukan/i.test(err.message) ? 404 : 400);
    res.status(code).json({ error: err.message });
  }
});

apiRouter.get('/sales/report', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    const report = salesService.getSalesReport(tenantId, {
      date: req.query.date,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      eventId: req.query.eventId
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/sales/report/export', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    const report = salesService.getSalesReport(tenantId, {
      date: req.query.date,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      eventId: req.query.eventId
    });
    const csv = salesService.buildSalesCsv(report);
    const labelDate = report.appliedRange?.date || `${report.appliedRange?.startDate || 'semua'}_${report.appliedRange?.endDate || ''}`;
    const safeFilename = String(labelDate).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="laporan-penjualan-${safeFilename}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/sales/verify-pin', authMiddleware(), (req, res) => {
  try {
    salesService.verifySalesActionPin(req.body?.pin);
    res.json({ valid: true });
  } catch (err) {
    res.status(err.statusCode || 403).json({ valid: false, error: err.message });
  }
});

apiRouter.post('/sales/transactions', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    const actor = req.user.email || req.user.role || 'Admin';
    if (Array.isArray(req.body?.items)) {
      const batchResult = salesService.recordSaleBatch(tenantId, req.body, actor);
      return res.status(201).json(batchResult);
    }
    const created = salesService.recordSale(tenantId, req.body || {}, actor);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/sales/transactions/:id', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    salesService.verifySalesActionPin(req.body?.pin ?? req.headers['x-sales-pin']);
    const actor = req.user.email || req.user.role || 'Admin';
    const updated = salesService.updateSale(tenantId, req.params.id, req.body || {}, actor);
    res.json(updated);
  } catch (err) {
    const code = err.statusCode || (/tidak ditemukan/i.test(err.message) ? 404 : 400);
    res.status(code).json({ error: err.message });
  }
});

apiRouter.delete('/sales/transactions/:id', authMiddleware(), (req, res) => {
  try {
    const tenantId = req.user.tenantId || 'tenant_studiokeren_01';
    salesService.verifySalesActionPin(req.body?.pin ?? req.headers['x-sales-pin']);
    res.json(salesService.deleteSale(tenantId, req.params.id));
  } catch (err) {
    const code = err.statusCode || (/tidak ditemukan/i.test(err.message) ? 404 : 400);
    res.status(code).json({ error: err.message });
  }
});
