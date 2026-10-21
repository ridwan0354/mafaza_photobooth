import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db } from '../db/database.js';

export async function createGuestPass(tenantId, eventId, issuedVia = 'booth', baseUrl = '') {
  const tokenPlain = 'gst_' + crypto.randomBytes(16).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(tokenPlain).digest('hex');
  const passId = 'pass_' + crypto.randomBytes(8).toString('hex');

  // Verify event exists; if not, fallback to first active event for tenant
  let validEventId = eventId;
  const ev = db.prepare('SELECT id, tenant_id FROM events WHERE id = ?').get(validEventId);
  let validTenantId = tenantId || (ev ? ev.tenant_id : 'tenant_studiokeren_01');
  if (!ev) {
    const fallbackEv = db.prepare('SELECT id, tenant_id FROM events ORDER BY created_at DESC LIMIT 1').get();
    if (fallbackEv) {
      validEventId = fallbackEv.id;
      validTenantId = fallbackEv.tenant_id;
    }
  } else {
    validTenantId = ev.tenant_id;
  }

  db.prepare(`
    INSERT INTO guest_passes (id, tenant_id, event_id, opaque_token_hash, token_plain, status, issued_via, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now', '+7 days'))
  `).run(passId, validTenantId, validEventId, tokenHash, tokenPlain, issuedVia);

  // Universal URL: e.g. /gallery/g/:tokenPlain
  const galleryUrl = `/gallery/g/${tokenPlain}`;
  const fullQrUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}${galleryUrl}` : galleryUrl;
  const qrDataUrl = await QRCode.toDataURL(fullQrUrl, { margin: 1, width: 320 });

  return {
    id: passId,
    tenant_id: validTenantId,
    event_id: validEventId,
    token: tokenPlain,
    token_plain: tokenPlain,
    galleryUrl,
    fullQrUrl,
    qrDataUrl,
    status: 'active'
  };
}

export async function createBatchGuestPasses(tenantId, eventId, count = 10, baseUrl = '') {
  const results = [];
  for (let i = 0; i < count; i++) {
    const pass = await createGuestPass(tenantId, eventId, 'batch', baseUrl);
    results.push(pass);
  }
  return results;
}

export async function listGuestPasses(tenantId, eventId, baseUrl = '') {
  let query = `
    SELECT gp.*,
           COUNT(ps.id) as session_count,
           MAX(ps.started_at) as last_session_at
    FROM guest_passes gp
    LEFT JOIN photo_sessions ps ON ps.guest_pass_id = gp.id
    WHERE gp.tenant_id = ?
  `;
  const params = [tenantId];
  if (eventId) {
    query += ` AND gp.event_id = ? `;
    params.push(eventId);
  }
  query += ` GROUP BY gp.id ORDER BY gp.created_at ASC `;

  const passes = db.prepare(query).all(...params);

  const list = [];
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    const galleryUrl = `/gallery/g/${p.token_plain}`;
    const fullQrUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}${galleryUrl}` : galleryUrl;
    const qrDataUrl = await QRCode.toDataURL(fullQrUrl, { margin: 1, width: 280 });
    list.push({
      ...p,
      token: p.token_plain,
      guestNumber: i + 1,
      galleryUrl,
      fullQrUrl,
      qrDataUrl
    });
  }
  return list;
}

export function resolveGuestPass(token) {
  if (!token) return null;
  // Can resolve either by plain token or extracted from URL
  const cleanToken = token.includes('/gallery/g/') ? token.split('/gallery/g/')[1].split('?')[0] : token;
  const pass = db.prepare(`
    SELECT gp.*, e.name as event_name, e.status as event_status, t.name as tenant_name
    FROM guest_passes gp
    JOIN events e ON gp.event_id = e.id
    JOIN tenants t ON gp.tenant_id = t.id
    WHERE gp.token_plain = ? AND gp.status = 'active'
  `).get(cleanToken);

  return pass || null;
}

export async function resolveGuestPassWithQr(token, baseUrl = '') {
  const pass = resolveGuestPass(token);
  if (!pass) return null;
  const galleryUrl = `/gallery/g/${pass.token_plain}`;
  const fullQrUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}${galleryUrl}` : galleryUrl;
  const qrDataUrl = await QRCode.toDataURL(fullQrUrl, { margin: 1, width: 320 });
  return {
    ...pass,
    token: pass.token_plain,
    galleryUrl,
    fullQrUrl,
    qrDataUrl
  };
}

export function getGuestGalleryData(token) {
  const pass = resolveGuestPass(token);
  if (!pass) return null;

  // Retrieve all photo sessions associated with this guest pass (multi-session!)
  const sessions = db.prepare(`
    SELECT ps.*,
           (SELECT json_group_array(json_object('id', ma.id, 'type', ma.type, 'variant', ma.variant, 'filePath', ma.file_path, 'createdAt', ma.created_at))
            FROM (
              SELECT * FROM media_assets 
              WHERE photo_session_id = ps.id 
              GROUP BY type, variant
              ORDER BY CASE 
                WHEN type = 'final_photo' THEN 1 
                WHEN type = 'boomerang' THEN 2 
                WHEN type = 'live_clip' THEN 3
                WHEN type = 'live_photo' THEN 4 
                WHEN type = 'raw_capture' THEN 5 
                ELSE 6 
              END ASC, variant ASC
            ) ma) as media_json
    FROM photo_sessions ps
    WHERE ps.guest_pass_id = ?
    ORDER BY ps.started_at DESC
  `).all(pass.id).map(s => ({
    ...s,
    media: JSON.parse(s.media_json || '[]')
  }));

  return {
    guestPass: {
      id: pass.id,
      token: pass.token_plain,
      eventName: pass.event_name,
      tenantName: pass.tenant_name,
      expiresAt: pass.expires_at
    },
    sessions
  };
}
