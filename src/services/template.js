import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db/database.js';

function detectImageDimensions(storageKey) {
  if (!storageKey) return null;
  try {
    const cleanPath = storageKey.startsWith('/') ? storageKey.slice(1) : storageKey;
    const absPath = path.resolve(process.cwd(), 'public', cleanPath);
    if (!fs.existsSync(absPath)) return null;
    const buf = fs.readFileSync(absPath);
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch (e) {}
  return null;
}

export function getTemplates(tenantId, eventId = null, scope = null) {
  let query = `
    SELECT t.*, tv.slots_json, tv.layers_json, tv.image_storage_key,
           (SELECT name FROM events e WHERE e.id = t.event_id) as event_name
    FROM templates t 
    LEFT JOIN template_versions tv ON t.current_version_id = tv.id 
    WHERE t.tenant_id = ?
  `;
  const params = [tenantId];
  if (eventId) {
    if (scope === 'all') {
      // return all templates without event filter
    } else if (scope === 'include_global') {
      query += ' AND (t.event_id = ? OR t.event_id IS NULL)';
      params.push(eventId);
    } else {
      query += ' AND t.event_id = ?';
      params.push(eventId);
    }
  } else if (scope === 'global_only') {
    query += ' AND t.event_id IS NULL';
  }
  query += ' ORDER BY t.created_at DESC';

  return db.prepare(query).all(...params).map(t => ({
    ...t,
    slots: JSON.parse(t.slots_json || '[]'),
    layers: JSON.parse(t.layers_json || '[]')
  }));
}

export function getTemplateById(templateId, tenantId = null) {
  let query = `
    SELECT t.*, tv.slots_json, tv.layers_json, tv.image_storage_key, tv.version
    FROM templates t
    LEFT JOIN template_versions tv ON t.current_version_id = tv.id
    WHERE t.id = ?
  `;
  const params = [templateId];
  if (tenantId) {
    query += ' AND t.tenant_id = ?';
    params.push(tenantId);
  }
  const t = db.prepare(query).get(...params);
  if (!t) return null;

  return {
    ...t,
    slots: JSON.parse(t.slots_json || '[]'),
    layers: JSON.parse(t.layers_json || '[]')
  };
}

export function createTemplate(tenantId, data) {
  const templateId = 'tpl_' + crypto.randomBytes(8).toString('hex');
  const versionId = 'ver_' + crypto.randomBytes(8).toString('hex');
  const qrPosition = data.qrPosition || data.qr_position || 'bottom-right';

  const detected = detectImageDimensions(data.imageUrl);
  const finalWidth = parseInt(data.width) || (detected ? detected.width : 1200);
  const finalHeight = parseInt(data.height) || (detected ? detected.height : 1800);

  db.prepare(`
    INSERT INTO templates (id, tenant_id, event_id, name, status, width, height, dpi, orientation, qr_position, current_version_id)
    VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)
  `).run(
    templateId,
    tenantId,
    data.eventId || null,
    data.name,
    finalWidth,
    finalHeight,
    data.dpi || 300,
    data.orientation || 'portrait',
    qrPosition,
    versionId
  );

  db.prepare(`
    INSERT INTO template_versions (id, template_id, image_storage_key, slots_json, layers_json, version)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(
    versionId,
    templateId,
    data.imageUrl || '/assets/templates/single-green-template.svg',
    JSON.stringify(data.slots || []),
    JSON.stringify(data.layers || [])
  );

  return getTemplateById(templateId, tenantId);
}

export function updateTemplateSlots(templateId, tenantId, slots, layers = null, qrPosition = null, width = null, height = null) {
  const template = getTemplateById(templateId, tenantId);
  if (!template) throw new Error('Template tidak ditemukan');

  const newVersionId = 'ver_' + crypto.randomBytes(8).toString('hex');
  const nextVerNumber = (template.version || 1) + 1;

  db.prepare(`
    INSERT INTO template_versions (id, template_id, image_storage_key, slots_json, layers_json, version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    newVersionId,
    templateId,
    template.image_storage_key,
    JSON.stringify(slots),
    JSON.stringify(layers || template.layers),
    nextVerNumber
  );

  const updates = ['current_version_id = ?'];
  const params = [newVersionId];

  if (qrPosition) {
    updates.push('qr_position = ?');
    params.push(qrPosition);
  }

  let finalW = parseInt(width);
  let finalH = parseInt(height);
  if (!finalW || !finalH) {
    const detected = detectImageDimensions(template.image_storage_key);
    if (detected) {
      finalW = detected.width;
      finalH = detected.height;
    }
  }
  if (finalW && finalH) {
    updates.push('width = ?', 'height = ?');
    params.push(finalW, finalH);
  }

  params.push(templateId);
  db.prepare(`UPDATE templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  return getTemplateById(templateId, tenantId);
}

export function updateTemplateConfig(templateId, tenantId, updates = {}) {
  const template = getTemplateById(templateId, tenantId);
  if (!template) throw new Error('Template tidak ditemukan');

  const fields = [];
  const params = [];
  if (updates.name !== undefined) { fields.push('name = ?'); params.push(updates.name); }
  if (updates.eventId !== undefined) { fields.push('event_id = ?'); params.push(updates.eventId || null); }
  if (updates.qrPosition !== undefined || updates.qr_position !== undefined) {
    fields.push('qr_position = ?');
    params.push(updates.qrPosition || updates.qr_position || 'bottom-right');
  }
  if (updates.orientation !== undefined) { fields.push('orientation = ?'); params.push(updates.orientation); }

  if (fields.length > 0) {
    params.push(templateId, tenantId);
    db.prepare(`UPDATE templates SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
  }
  return getTemplateById(templateId, tenantId);
}
