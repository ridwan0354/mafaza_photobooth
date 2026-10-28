-- PHOTO BOOTH SAAS FULL SYSTEM - DATABASE SCHEMA (SQLite / Production Compatible)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator', -- 'super_admin', 'business_admin', 'operator'
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'suspended', 'inactive'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  brand_config_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'trial', 'suspended'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'operator', -- 'business_admin', 'operator'
  operator_pin TEXT DEFAULT '1234',
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_type TEXT NOT NULL, -- 'monthly', 'yearly', 'per_event'
  price INTEGER NOT NULL, -- in IDR
  currency TEXT NOT NULL DEFAULT 'IDR',
  entitlements_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'trial', 'grace_period', 'expired'
  starts_at DATETIME,
  ends_at DATETIME,
  trial_until DATETIME,
  grace_until DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  amount INTEGER NOT NULL,
  unique_reference TEXT UNIQUE NOT NULL, -- e.g. INV-202610-3829
  bank_account TEXT NOT NULL DEFAULT 'BCA 8720192837 a/n PT Photobooth Indonesia',
  status TEXT NOT NULL DEFAULT 'pending_payment', -- 'pending_payment', 'submitted', 'under_review', 'approved', 'rejected', 'expired'
  due_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_proofs (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  review_status TEXT NOT NULL DEFAULT 'submitted', -- 'submitted', 'approved', 'rejected'
  reviewer_id TEXT REFERENCES users(id),
  reviewed_at DATETIME,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hardware_id_hash TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'windows', -- 'windows', 'macos', 'simulator'
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'offline', 'disabled'
  last_seen_at DATETIME,
  app_version TEXT DEFAULT '2.0.0',
  capabilities_json TEXT DEFAULT '{"camera":true,"printer":true,"ai":true,"touchscreen":true}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'draft', 'active', 'completed', 'archived'
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  config_version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published', -- 'draft', 'published', 'archived'
  width INTEGER NOT NULL DEFAULT 1200, -- px
  height INTEGER NOT NULL DEFAULT 1800, -- px
  dpi INTEGER NOT NULL DEFAULT 300,
  orientation TEXT NOT NULL DEFAULT 'portrait', -- 'portrait', 'landscape', 'strip'
  qr_position TEXT NOT NULL DEFAULT 'bottom-right', -- 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'none'
  shots_mode TEXT NOT NULL DEFAULT 'event', -- 'event', 'slots', or '1'..'10'
  current_version_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  image_storage_key TEXT NOT NULL,
  slots_json TEXT NOT NULL DEFAULT '[]', -- Detected/Manual photo slots [{id, pose_index, x, y, width, height, rotation}]
  layers_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  published_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guest_passes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  opaque_token_hash TEXT NOT NULL,
  token_plain TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'revoked', 'expired'
  issued_via TEXT NOT NULL DEFAULT 'booth', -- 'booth', 'batch', 'registration'
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS photo_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id),
  guest_pass_id TEXT REFERENCES guest_passes(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'single', -- 'single', 'strip', 'collage', 'gif', 'boomerang', 'video', '360'
  status TEXT NOT NULL DEFAULT 'completed', -- 'capturing', 'processing', 'completed', 'abandoned'
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  local_session_id TEXT
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  photo_session_id TEXT NOT NULL REFERENCES photo_sessions(id) ON DELETE CASCADE,
  pose_index INTEGER NOT NULL DEFAULT 1,
  image_url TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  photo_session_id TEXT NOT NULL REFERENCES photo_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'final_photo', 'strip', 'gif', 'video', 'raw_capture'
  variant TEXT NOT NULL DEFAULT 'print_hires', -- 'thumbnail', 'display', 'print_hires'
  file_path TEXT NOT NULL,
  checksum TEXT,
  size_bytes INTEGER DEFAULT 0,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS printer_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Epson SureLab D500 / L8050',
  model TEXT NOT NULL DEFAULT 'Epson L8050',
  driver_name TEXT NOT NULL DEFAULT 'EPSON L8050 Series',
  paper_sizes_json TEXT NOT NULL DEFAULT '["4x6","2x6","5x7","A4"]',
  media_type TEXT NOT NULL DEFAULT 'photographic-glossy',
  is_default INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id),
  photo_session_id TEXT NOT NULL REFERENCES photo_sessions(id) ON DELETE CASCADE,
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id),
  copies INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'completed', -- 'queued', 'processing', 'spooled', 'completed', 'failed', 'cancelled'
  spooler_job_id TEXT,
  idempotency_key TEXT UNIQUE,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  job_type TEXT NOT NULL, -- 'upload_session', 'upload_media', 'sync_guest_pass'
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'completed', -- 'pending', 'processing', 'completed', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE NOT NULL,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL, -- 'login', 'approve_invoice', 'reject_invoice', 'create_event', 'reprint', 'detect_template'
  details_json TEXT DEFAULT '{}',
  ip_address TEXT DEFAULT '127.0.0.1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS privacy_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  photo_session_id TEXT REFERENCES photo_sessions(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL DEFAULT 'photo_and_ai',
  granted INTEGER NOT NULL DEFAULT 1,
  ip_address TEXT DEFAULT '127.0.0.1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  photo_session_id TEXT REFERENCES photo_sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  feature TEXT NOT NULL, -- 'bg_removal', 'beauty_smoothing', 'cartoon_filter', 'face_swap'
  latency_ms INTEGER DEFAULT 0,
  cost_est INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for lightning fast queries and tenant isolation
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_guest_passes_token ON guest_passes(token_plain);
CREATE INDEX IF NOT EXISTS idx_guest_passes_event ON guest_passes(event_id);
CREATE INDEX IF NOT EXISTS idx_sessions_event ON photo_sessions(event_id);
CREATE INDEX IF NOT EXISTS idx_sessions_guest_pass ON photo_sessions(guest_pass_id);
CREATE INDEX IF NOT EXISTS idx_media_session ON media_assets(photo_session_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_device ON print_jobs(device_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_state ON sync_jobs(state);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);
