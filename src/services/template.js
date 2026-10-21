import crypto from 'node:crypto';
import { db } from '../db/database.js';

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

  db.prepare(`
    INSERT INTO templates (id, tenant_id, event_id, name, status, width, height, dpi, orientation, current_version_id)
    VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)
  `).run(
    templateId,
    tenantId,
    data.eventId || null,
    data.name,
    data.width || 1200,
    data.height || 1800,
    data.dpi || 300,
    data.orientation || 'portrait',
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

export function updateTemplateSlots(templateId, tenantId, slots, layers = null) {
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

  db.prepare(`
    UPDATE templates SET current_version_id = ? WHERE id = ?
  `).run(newVersionId, templateId);

  return getTemplateById(templateId, tenantId);
}
