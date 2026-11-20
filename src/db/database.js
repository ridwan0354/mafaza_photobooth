import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../../photobooth.db');

// Universal SQLite driver: uses built-in node:sqlite on Node >= 22.5, or pure-WASM sql.js on Node 18/20
async function createDatabase(dbPath) {
  try {
    const nodeSqlite = await import('node:sqlite');
    if (nodeSqlite && nodeSqlite.DatabaseSync) {
      return new nodeSqlite.DatabaseSync(dbPath);
    }
  } catch (e) {}

  // Fallback for Node 18 / Node 20 (Zero native C++ dependencies via WebAssembly sql.js)
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const fileBuffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const wasmDb = fileBuffer && fileBuffer.length > 0 ? new SQL.Database(fileBuffer) : new SQL.Database();

  const saveToDisk = () => {
    try {
      const data = wasmDb.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (err) {
      console.error('SQLite WASM disk sync error:', err.message);
    }
  };

  const normalizeParams = (params) => {
    if (!params || params.length === 0) return [];
    if (params.length === 1 && Array.isArray(params[0])) {
      return params[0].map(p => (p === undefined ? null : p));
    }
    return params.map(p => (p === undefined ? null : p));
  };

  return {
    exec(sql) {
      wasmDb.exec(sql);
      saveToDisk();
    },
    prepare(sql) {
      return {
        get(...params) {
          const stmt = wasmDb.prepare(sql);
          try {
            const bound = normalizeParams(params);
            if (bound.length > 0) stmt.bind(bound);
            if (stmt.step()) {
              return stmt.getAsObject();
            }
            return undefined;
          } finally {
            stmt.free();
          }
        },
        all(...params) {
          const stmt = wasmDb.prepare(sql);
          const rows = [];
          try {
            const bound = normalizeParams(params);
            if (bound.length > 0) stmt.bind(bound);
            while (stmt.step()) {
              rows.push(stmt.getAsObject());
            }
            return rows;
          } finally {
            stmt.free();
          }
        },
        run(...params) {
          const bound = normalizeParams(params);
          wasmDb.run(sql, bound);
          const changes = wasmDb.getRowsModified();
          saveToDisk();
          return { changes };
        }
      };
    }
  };
}

export const db = await createDatabase(DB_PATH);

// Simple password hashing using SHA256 with salt for standalone zero-dep security
export function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_pb_salt_2026').digest('hex');
}

export function initDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);
  runMigrations();
  seedDatabase();
  console.log('✅ Database initialized and verified at:', DB_PATH);
}

// Menambah kolom baru pada database lama (aman dijalankan berulang kali, data tidak hilang)
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function runMigrations() {
  // Seluruh pengaturan cetak (ukuran kertas, borderless, kualitas, mode, maks cetak)
  ensureColumn('printer_profiles', 'settings_json', "TEXT DEFAULT '{}'");
  // Snapshot pengaturan yang dipakai saat job dibuat, dibaca oleh Print Agent
  ensureColumn('print_jobs', 'options_json', "TEXT DEFAULT '{}'");
  // Kunci rahasia Print Agent (aplikasi cetak otomatis di komputer studio)
  ensureColumn('tenants', 'agent_key', 'TEXT');
  // Template ID yang digunakan saat sesi foto di Kiosk
  ensureColumn('photo_sessions', 'template_id', 'TEXT');
  // Posisi QR Galeri pada hasil cetak (bottom-right, bottom-left, top-right, top-left, none)
  ensureColumn('templates', 'qr_position', "TEXT DEFAULT 'bottom-right'");
  // Mode jumlah pose/cekrek per template ('event' = ikut pengaturan event, 'slots' = sesuai lubang hijau, atau angka '1'..'10')
  ensureColumn('templates', 'shots_mode', "TEXT DEFAULT 'event'");
  // Target jenis booth untuk template ('kiosk', 'mingle', 'both')
  ensureColumn('templates', 'booth_mode', "TEXT DEFAULT 'kiosk'");
  // Ukuran cetak fisik template ('4R', '5R', '2x6', '4x4')
  ensureColumn('templates', 'paper_size', "TEXT DEFAULT '4R'");
  // Koordinat kustom 1 atau 2 QR pada hasil cetak [{id, x, y, size}]
  ensureColumn('templates', 'qr_coords_json', "TEXT DEFAULT '[]'");
  // Apakah frame menghapus warna hijau otomatis (chroma key) saat render hasil — default 0 (manual/transparan)
  ensureColumn('templates', 'chroma_key', 'INTEGER DEFAULT 0');

  ensureStarterLandscapeTemplates();
}

function ensureStarterLandscapeTemplates() {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    const already = db.prepare("SELECT id FROM app_migrations WHERE id = 'seed_polaroid_2up_landscape_v1'").get();
    if (already) return;
    const tenant = db.prepare("SELECT id FROM tenants WHERE id = 'tenant_studiokeren_01'").get();
    if (!tenant) return;

    const starters = [
      {
        id: 'tpl_polaroid_2up_4r_land',
        verId: 'ver_polaroid_2up_4r_1',
        name: 'Polaroid Minimalis 2-Up (4R Lanskap · Potong Tengah)',
        width: 1800,
        height: 1200,
        paperSize: '4R',
        img: '/assets/templates/polaroid-marble-2up-4r-landscape.svg',
        slots: [
          { id: 'slot_1', pose_index: 1, x: 90, y: 80, width: 720, height: 825 },
          { id: 'slot_2', pose_index: 2, x: 990, y: 80, width: 720, height: 825 }
        ],
        qrCoords: [
          { id: 'qr_1', x: 675, y: 975, size: 135 },
          { id: 'qr_2', x: 1575, y: 975, size: 135 }
        ]
      },
      {
        id: 'tpl_polaroid_2up_5r_land',
        verId: 'ver_polaroid_2up_5r_1',
        name: 'Polaroid Minimalis 2-Up (5R Lanskap · Potong Tengah)',
        width: 2100,
        height: 1500,
        paperSize: '5R',
        img: '/assets/templates/polaroid-marble-2up-5r-landscape.svg',
        slots: [
          { id: 'slot_1', pose_index: 1, x: 110, y: 96, width: 830, height: 1035 },
          { id: 'slot_2', pose_index: 2, x: 1160, y: 96, width: 830, height: 1035 }
        ],
        qrCoords: [
          { id: 'qr_1', x: 785, y: 1215, size: 160 },
          { id: 'qr_2', x: 1835, y: 1215, size: 160 }
        ]
      }
    ];

    const insertTpl = db.prepare(`
      INSERT OR IGNORE INTO templates (id, tenant_id, event_id, name, status, width, height, dpi, orientation, paper_size, qr_position, qr_coords_json, shots_mode, booth_mode, current_version_id)
      VALUES (?, ?, NULL, ?, 'published', ?, ?, 300, 'landscape', ?, 'bottom-right', ?, '1', 'both', ?)
    `);
    const insertVer = db.prepare(`
      INSERT OR IGNORE INTO template_versions (id, template_id, image_storage_key, slots_json, layers_json, version)
      VALUES (?, ?, ?, ?, '[]', 1)
    `);

    for (const s of starters) {
      insertTpl.run(s.id, tenant.id, s.name, s.width, s.height, s.paperSize, JSON.stringify(s.qrCoords), s.verId);
      insertVer.run(s.verId, s.id, s.img, JSON.stringify(s.slots));
    }
    db.prepare("INSERT OR IGNORE INTO app_migrations (id) VALUES ('seed_polaroid_2up_landscape_v1')").run();
  } catch (e) {
    console.warn('ensureStarterLandscapeTemplates skipped:', e.message);
  }
}

function seedDatabase() {
  // Check if users already seeded
  const check = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (check.count > 0) {
    return;
  }

  console.log('🌱 Seeding initial platform data (Super Admin, Business Owner, Operator, Plans, Events)...');

  // 1. Users
  const superAdminId = 'user_super_admin_01';
  const businessAdminId = 'user_business_owner_01';
  const operatorId = 'user_operator_01';

  const insertUser = db.prepare(`
    INSERT INTO users (id, email, password_hash, full_name, role, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertUser.run(superAdminId, 'admin@photobooth.saas', hashPassword('admin123'), 'Super Administrator', 'super_admin', 'active');
  insertUser.run(businessAdminId, 'owner@studiokeren.id', hashPassword('owner123'), 'Owner Mafaza', 'business_admin', 'active');
  insertUser.run(operatorId, 'operator@studiokeren.id', hashPassword('operator123'), 'Operator Mafaza', 'operator', 'active');

  // 2. Tenant
  const tenantId = 'tenant_studiokeren_01';
  db.prepare(`
    INSERT INTO tenants (id, name, slug, brand_config_json, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    tenantId,
    'Mafaza',
    'mafaza',
    JSON.stringify({
      primaryColor: '#D4A754',
      secondaryColor: '#7B482E',
      brandName: 'Mafaza',
      tagline: 'Setiap Momen Punya Cerita • By Galipat Story',
      logoUrl: '/assets/logo-mafaza.jpg'
    }),
    'active'
  );

  // 3. Memberships
  const insertMember = db.prepare(`
    INSERT INTO memberships (id, tenant_id, user_id, role, operator_pin, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertMember.run('mem_01', tenantId, businessAdminId, 'business_admin', '0000', 'active');
  insertMember.run('mem_02', tenantId, operatorId, 'operator', '1234', 'active');

  // 4. Plans
  const insertPlan = db.prepare(`
    INSERT INTO plans (id, name, billing_type, price, currency, entitlements_json, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertPlan.run(
    'plan_monthly',
    'Paket Bisnis Bulanan',
    'monthly',
    450000,
    'IDR',
    JSON.stringify({ maxDevices: 3, maxEvents: 10, aiCredits: 500, storageGB: 50, allModes: true }),
    1
  );
  insertPlan.run(
    'plan_yearly',
    'Paket Bisnis Tahunan (Hemat 2 Bulan)',
    'yearly',
    4500000,
    'IDR',
    JSON.stringify({ maxDevices: 5, maxEvents: 100, aiCredits: 6000, storageGB: 500, allModes: true }),
    1
  );
  insertPlan.run(
    'plan_per_event',
    'Paket Bayar Per Event',
    'per_event',
    150000,
    'IDR',
    JSON.stringify({ maxDevices: 1, maxEvents: 1, aiCredits: 100, storageGB: 10, allModes: true }),
    1
  );

  // 5. Subscription & Invoices
  const subId = 'sub_studiokeren_01';
  db.prepare(`
    INSERT INTO subscriptions (id, tenant_id, plan_id, status, starts_at, ends_at, trial_until, grace_until)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now', '+30 days'), NULL, datetime('now', '+37 days'))
  `).run(subId, tenantId, 'plan_monthly', 'active');

  const invId = 'inv_202610_01';
  db.prepare(`
    INSERT INTO invoices (id, tenant_id, subscription_id, amount, unique_reference, bank_account, status, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+3 days'))
  `).run(
    invId,
    tenantId,
    subId,
    450382,
    'INV-202610-382',
    'BCA 8720192837 a/n PT Photobooth Indonesia',
    'approved'
  );

  // 6. Devices
  const deviceId = 'dev_kiosk_win_01';
  db.prepare(`
    INSERT INTO devices (id, tenant_id, name, hardware_id_hash, platform, status, last_seen_at, app_version, capabilities_json)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(
    deviceId,
    tenantId,
    'Kiosk Booth A (Touchscreen Pavilion)',
    'hw_win_pc_touch_9921',
    'windows',
    'active',
    '2.0.0',
    JSON.stringify({ camera: true, printer: true, ai: true, touchscreen: true, epsonSpooler: true })
  );

  // 7. Events
  const eventId = 'event_wedding_dimas_sarah';
  db.prepare(`
    INSERT INTO events (id, tenant_id, name, starts_at, ends_at, status, timezone, config_version, config_json)
    VALUES (?, ?, ?, datetime('now', '-2 hours'), datetime('now', '+8 hours'), ?, ?, ?, ?)
  `).run(
    eventId,
    tenantId,
    'Wedding Dimas & Sarah',
    'active',
    'Asia/Jakarta',
    1,
    JSON.stringify({
      countdownSeconds: 3,
      enabledModes: ['single', 'strip', 'collage', 'gif', 'boomerang'],
      soundEffects: true,
      flashScreen: true,
      maxCopiesPerSession: 2,
      qrRequirement: 'optional', // 'required', 'optional', 'disabled'
      idleTimeoutSeconds: 30,
      pinLock: '1234',
      themeTokens: {
        welcomeTitle: 'Selamat Datang di Photobooth!',
        welcomeSubtitle: 'Pernikahan Dimas & Sarah • 19 Oktober 2026',
        bgGradient: 'from-pink-500 via-purple-500 to-indigo-500',
        ctaText: 'Mulai Foto Sekarang'
      }
    })
  );

  // 8. Templates with Green Area photo slots!
  const templateStripId = 'tpl_strip_pastel';
  db.prepare(`
    INSERT INTO templates (id, tenant_id, event_id, name, status, width, height, dpi, orientation, current_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(templateStripId, tenantId, eventId, 'Classic Photo Strip 3-Pose (2x6)', 'published', 600, 1800, 300, 'strip', 'ver_tpl_strip_01');

  // Template version with detected photo slots (Replacing green area with pose 1, 2, 3)
  db.prepare(`
    INSERT INTO template_versions (id, template_id, image_storage_key, slots_json, layers_json, version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'ver_tpl_strip_01',
    templateStripId,
    '/assets/templates/strip-green-template.svg',
    JSON.stringify([
      { id: 'slot_1', pose_index: 1, x: 50, y: 120, width: 500, height: 420, rotation: 0, shape: 'rect' },
      { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: 500, height: 420, rotation: 0, shape: 'rect' },
      { id: 'slot_3', pose_index: 3, x: 50, y: 1040, width: 500, height: 420, rotation: 0, shape: 'rect' }
    ]),
    JSON.stringify([
      { type: 'header', text: 'Dimas & Sarah', font: 'Playfair Display', y: 60 },
      { type: 'footer', text: '19.10.2026', font: 'Inter', y: 1720 }
    ]),
    1
  );

  // Template 4x6 Single
  const templateSingleId = 'tpl_single_gold';
  db.prepare(`
    INSERT INTO templates (id, tenant_id, event_id, name, status, width, height, dpi, orientation, current_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(templateSingleId, tenantId, eventId, 'Elegant Single Portrait (4x6)', 'published', 1200, 1800, 300, 'portrait', 'ver_tpl_single_01');

  db.prepare(`
    INSERT INTO template_versions (id, template_id, image_storage_key, slots_json, layers_json, version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'ver_tpl_single_01',
    templateSingleId,
    '/assets/templates/single-green-template.svg',
    JSON.stringify([
      { id: 'slot_single', pose_index: 1, x: 100, y: 180, width: 1000, height: 1350, rotation: 0, shape: 'rect' }
    ]),
    JSON.stringify([]),
    1
  );

  // 9. Sample Guest Pass (Universal Smart QR)
  const sampleGuestToken = 'gst_' + crypto.randomBytes(16).toString('hex');
  const guestPassId = 'pass_sample_guest_01';
  db.prepare(`
    INSERT INTO guest_passes (id, tenant_id, event_id, opaque_token_hash, token_plain, status, issued_via, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))
  `).run(
    guestPassId,
    tenantId,
    eventId,
    crypto.createHash('sha256').update(sampleGuestToken).digest('hex'),
    sampleGuestToken,
    'active',
    'batch'
  );

  // 10. Printer Profile
  db.prepare(`
    INSERT INTO printer_profiles (id, tenant_id, name, model, driver_name, paper_sizes_json, media_type, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'printer_epson_01',
    tenantId,
    'Epson L8050 / SureLab D500 Photo Printer',
    'Epson L8050',
    'EPSON L8050 Series',
    JSON.stringify(['2x6', '4x6', '5x7', 'A4']),
    'photographic-glossy',
    1
  );

  // 11. Audit log
  db.prepare(`
    INSERT INTO audit_logs (id, tenant_id, user_id, actor_name, action, details_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'audit_init_01',
    tenantId,
    superAdminId,
    'System Initializer',
    'seed_platform',
    JSON.stringify({ message: 'Platform seeded with default tenants and wedding event' }),
    '127.0.0.1'
  );

  console.log('✅ Seed completed successfully! Sample Guest Token for testing:', sampleGuestToken);
}
