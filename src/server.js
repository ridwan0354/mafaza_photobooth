import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

import { initDatabase, db } from './db/database.js';
import { apiRouter } from './routes/api.js';
import { cleanupExpiredEventPhotos } from './services/event.js';
import { verifyToken, createToken } from './services/auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize DB schema & seeds
initDatabase();

// Jalankan auto-cleanup foto event berumur > 1 tahun saat server mulai & tiap 24 jam
try {
  const cleanResult = cleanupExpiredEventPhotos();
  if (cleanResult.affectedEventsCount > 0) {
    console.log(`🧹 Auto-cleanup: Foto dari ${cleanResult.affectedEventsCount} event (> 1 tahun) telah dibersihkan.`);
  }
} catch (e) {}
setInterval(cleanupExpiredEventPhotos, 24 * 3600 * 1000);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Zero-dependency cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach(c => {
      const idx = c.indexOf('=');
      if (idx !== -1) {
        const key = c.substring(0, idx).trim();
        const val = c.substring(idx + 1).trim();
        try { req.cookies[key] = decodeURIComponent(val); } catch (e) { req.cookies[key] = val; }
      }
    });
  }
  next();
});

const publicDir = path.join(__dirname, '../public');

// Protected Admin Dashboard Route (Gate Password: 313354)
// Ditempatkan SEBELUM express.static agar /admin.html tidak bisa diakses langsung tanpa autentikasi
app.get(['/admin', '/admin.html'], (req, res) => {
  let token = req.cookies?.pb_admin_auth || req.cookies?.pb_token || req.query?.auth || req.query?.token;

  // Direct password fallback via query (?password=313354 atau ?pass=313354)
  const targetPass = (process.env.ADMIN_PASSWORD || '313354').trim();
  const queryPass = (req.query?.password || req.query?.pass || '').trim();
  if (!token && queryPass && queryPass === targetPass) {
    const adminUser = db.prepare("SELECT id, email, full_name, role FROM users WHERE role IN ('business_admin', 'super_admin') LIMIT 1").get();
    const activeTenant = db.prepare('SELECT id FROM tenants LIMIT 1').get() || { id: 'tenant_studiokeren_01' };
    token = createToken({
      userId: adminUser?.id || 'user_business_owner_01',
      email: adminUser?.email || 'owner@studiokeren.id',
      name: adminUser?.full_name || 'Admin Mafaza',
      role: 'super_admin',
      tenantId: activeTenant.id
    });
  }

  const verified = token ? verifyToken(token) : null;
  if (!verified) {
    return res.sendFile(path.join(publicDir, 'admin-login.html'));
  }

  // Refresh cookies on response so future requests without query param are seamlessly authenticated
  res.setHeader('Set-Cookie', [
    `pb_admin_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    `pb_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=2592000`
  ]);

  res.sendFile(path.join(publicDir, 'admin.html'));
});

// Admin Login page route
app.get('/admin/login', (req, res) => {
  const token = req.cookies?.pb_admin_auth || req.cookies?.pb_token || req.query?.auth || req.query?.token;
  const verified = token ? verifyToken(token) : null;
  if (verified) {
    return res.redirect('/admin');
  }
  res.sendFile(path.join(publicDir, 'admin-login.html'));
});

// Static files (admin.html sudah dilindungi di atas)
app.use(express.static(publicDir));

// Prevent 404 console error for favicon.ico
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Attach API Router
app.use('/api', apiRouter);

// WebSocket for real-time print status & kiosk telemetry
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', message: 'Photobooth Realtime Server Connected' }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      // Broadcast to other clients if needed (e.g. operator monitoring kiosk)
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    } catch (e) {}
  });
});

// Broadcast helper
export function broadcastEvent(eventType, payload) {
  const msg = JSON.stringify({ type: eventType, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

// Serve Frontend SPA / HTML pages
app.get('/super', (req, res) => {
  res.sendFile(path.join(publicDir, 'super.html'));
});

app.get('/operator', (req, res) => {
  res.sendFile(path.join(publicDir, 'operator.html'));
});

app.get('/kiosk', (req, res) => {
  res.sendFile(path.join(publicDir, 'kiosk.html'));
});

app.get('/gallery/g/:token', (req, res) => {
  res.sendFile(path.join(publicDir, 'gallery.html'));
});

app.get(['/gallery/e/:eventId', '/gallery/event/:eventId'], (req, res) => {
  res.sendFile(path.join(publicDir, 'gallery.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(publicDir, 'gallery.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n=======================================================`);
  console.log(`🎉 PHOTOBOOTH SAAS FULL SYSTEM RUNNING ON LOCALHOST!`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`-------------------------------------------------------`);
  console.log(`• Beranda & Portal Switcher: http://localhost:${PORT}`);
  console.log(`• Super Admin Dashboard   : http://localhost:${PORT}/super`);
  console.log(`• Business Admin Dashboard: http://localhost:${PORT}/admin`);
  console.log(`• Operator & Hardware Pre : http://localhost:${PORT}/operator`);
  console.log(`• Kiosk Touchscreen Booth : http://localhost:${PORT}/kiosk`);
  console.log(`=======================================================\n`);
});
