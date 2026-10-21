import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../../photobooth.db');

export const db = new DatabaseSync(DB_PATH);

// Simple password hashing using SHA256 with salt for standalone zero-dep security
export function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_pb_salt_2026').digest('hex');
}

export function initDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);
  seedDatabase();
  console.log('✅ Database initialized and verified at:', DB_PATH);
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
