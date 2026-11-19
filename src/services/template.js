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

function normalizeBoothMode(val) {
  const mode = String(val || 'kiosk').trim().toLowerCase();
  if (mode === 'mingle' || mode === 'both') return mode;
  return 'kiosk';
}

const FORMAT_PRESETS = {
  strip: { orientation: 'strip', paperSize: '2x6', width: 600, height: 1800 },
  '2x6': { orientation: 'strip', paperSize: '2x6', width: 600, height: 1800 },
  portrait: { orientation: 'portrait', paperSize: '4R', width: 1200, height: 1800 },
  '4r_portrait': { orientation: 'portrait', paperSize: '4R', width: 1200, height: 1800 },
  portrait_4r: { orientation: 'portrait', paperSize: '4R', width: 1200, height: 1800 },
  landscape: { orientation: 'landscape', paperSize: '4R', width: 1800, height: 1200 },
  '4r_landscape': { orientation: 'landscape', paperSize: '4R', width: 1800, height: 1200 },
  landscape_4r: { orientation: 'landscape', paperSize: '4R', width: 1800, height: 1200 },
  portrait_5r: { orientation: 'portrait', paperSize: '5R', width: 1500, height: 2100 },
  '5r_portrait': { orientation: 'portrait', paperSize: '5R', width: 1500, height: 2100 },
  landscape_5r: { orientation: 'landscape', paperSize: '5R', width: 2100, height: 1500 },
  '5r_landscape': { orientation: 'landscape', paperSize: '5R', width: 2100, height: 1500 },
  square: { orientation: 'square', paperSize: '4x4', width: 1200, height: 1200 },
  '4x4': { orientation: 'square', paperSize: '4x4', width: 1200, height: 1200 }
};

function derivePaperSize(t) {
  if (t.paper_size) {
    const raw = String(t.paper_size).trim();
    if (raw === '4R' || raw === '5R' || raw === '2x6' || raw === '4x4') return raw;
  }
  const orient = String(t.orientation || '').toLowerCase();
  if (orient === 'strip') return '2x6';
  if (orient === 'square') return '4x4';
  const w = parseInt(t.width, 10) || 1200;
  const h = parseInt(t.height, 10) || 1800;
  const maxDim = Math.max(w, h);
  const minDim = Math.min(w, h);
  const ratio = maxDim / Math.max(1, minDim);
  if (ratio >= 1.34 && ratio <= 1.44) return '5R';
  if (maxDim >= 2000 && ratio < 1.46) return '5R';
  return '4R';
}

function resolveTemplateFormat(data = {}) {
  const key = String(data.formatPreset || data.orientation || '').trim().toLowerCase();
  const preset = FORMAT_PRESETS[key];
  let paperSize = data.paperSize || data.paper_size || (preset ? preset.paperSize : null);
  let orientation = preset ? preset.orientation : (key || 'portrait');
  if (orientation !== 'strip' && orientation !== 'square' && orientation !== 'landscape') {
    orientation = 'portrait';
  }
  if (!paperSize) {
    paperSize = orientation === 'strip' ? '2x6' : (orientation === 'square' ? '4x4' : '4R');
  }
  const defaultW = preset ? preset.width : (orientation === 'strip' ? 600 : (orientation === 'landscape' ? 1800 : 1200));
  const defaultH = preset ? preset.height : (orientation === 'landscape' ? 1200 : (orientation === 'square' ? 1200 : 1800));
  return { orientation, paperSize: String(paperSize).toUpperCase() === '5R' ? '5R' : (paperSize === '2x6' || paperSize === '4x4' ? paperSize : '4R'), defaultW, defaultH };
}

function normalizeQrCoords(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (e) { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, 4)
    .map((q, idx) => ({
      id: String(q.id || `qr_${idx + 1}`),
      x: Math.round(Number(q.x) || 0),
      y: Math.round(Number(q.y) || 0),
      size: Math.max(40, Math.min(600, Math.round(Number(q.size) || 150)))
    }));
}

export function getTemplates(tenantId, eventId = null, scope = null, booth = null) {
  let query = `
    SELECT t.*, tv.slots_json, tv.layers_json, tv.image_storage_key,
           (SELECT name FROM events e WHERE e.id = t.event_id) as event_name,
           (SELECT config_json FROM events e WHERE e.id = t.event_id) as event_config_json
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
  const normalizedBooth = String(booth || '').trim().toLowerCase();
  if (normalizedBooth === 'mingle') {
    query += " AND t.booth_mode IN ('mingle', 'both')";
  } else if (normalizedBooth === 'kiosk') {
    query += " AND (t.booth_mode IS NULL OR t.booth_mode IN ('kiosk', 'both'))";
  }
  query += ' ORDER BY t.created_at DESC';

  return db.prepare(query).all(...params).map(t => {
    let eventShotsCount = null;
    if (t.event_config_json) {
      try {
        const cfg = JSON.parse(t.event_config_json);
        if (cfg && cfg.shotsCount) eventShotsCount = parseInt(cfg.shotsCount, 10) || null;
      } catch (e) {}
    }

    return {
      ...t,
      shots_mode: t.shots_mode || 'event',
      booth_mode: normalizeBoothMode(t.booth_mode),
      paper_size: derivePaperSize(t),
      qr_coords: normalizeQrCoords(t.qr_coords_json),
      event_shots_count: eventShotsCount,
      slots: JSON.parse(t.slots_json || '[]'),
      layers: JSON.parse(t.layers_json || '[]')
    };
  });
}

export function getTemplateById(templateId, tenantId = null) {
  let query = `
    SELECT t.*, tv.slots_json, tv.layers_json, tv.image_storage_key, tv.version,
           (SELECT config_json FROM events e WHERE e.id = t.event_id) as event_config_json
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

  let eventShotsCount = null;
  if (t.event_config_json) {
    try {
      const cfg = JSON.parse(t.event_config_json);
      if (cfg && cfg.shotsCount) eventShotsCount = parseInt(cfg.shotsCount, 10) || null;
    } catch (e) {}
  }

  return {
    ...t,
    shots_mode: t.shots_mode || 'event',
    booth_mode: normalizeBoothMode(t.booth_mode),
    paper_size: derivePaperSize(t),
    qr_coords: normalizeQrCoords(t.qr_coords_json),
    event_shots_count: eventShotsCount,
    slots: JSON.parse(t.slots_json || '[]'),
    layers: JSON.parse(t.layers_json || '[]')
  };
}

export function createTemplate(tenantId, data) {
  const templateId = 'tpl_' + crypto.randomBytes(8).toString('hex');
  const versionId = 'ver_' + crypto.randomBytes(8).toString('hex');
  const rawQrPos = data.qrPosition || data.qr_position || 'bottom-right';
  const boothMode = normalizeBoothMode(data.boothMode || data.booth_mode);
  const shotsMode = data.shotsMode || data.shots_mode || (boothMode === 'mingle' ? '1' : 'event');

  const fmt = resolveTemplateFormat(data);
  const detected = detectImageDimensions(data.imageUrl);
  const finalWidth = (detected && detected.width) ? detected.width : (parseInt(data.width) || fmt.defaultW);
  const finalHeight = (detected && detected.height) ? detected.height : (parseInt(data.height) || fmt.defaultH);
  let finalOrientation = fmt.orientation;
  if (finalOrientation !== 'strip' && finalOrientation !== 'square') {
    finalOrientation = (finalWidth > finalHeight) ? 'landscape' : 'portrait';
  }
  const finalPaperSize = fmt.paperSize;

  let qrCoords = normalizeQrCoords(data.qrCoords || data.qr_coords);
  let qrPosition = rawQrPos;
  if (rawQrPos === 'dual-bottom-right' && qrCoords.length === 0) {
    const qSize = Math.round(Math.min(finalWidth, finalHeight) * 0.115);
    const pad = Math.round(qSize * 0.25);
    const halfW = Math.round(finalWidth / 2);
    qrCoords = [
      { id: 'qr_1', x: halfW - qSize - pad, y: finalHeight - qSize - pad, size: qSize },
      { id: 'qr_2', x: finalWidth - qSize - pad, y: finalHeight - qSize - pad, size: qSize }
    ];
    qrPosition = 'bottom-right';
  }

  db.prepare(`
    INSERT INTO templates (id, tenant_id, event_id, name, status, width, height, dpi, orientation, paper_size, qr_position, qr_coords_json, shots_mode, booth_mode, current_version_id)
    VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    templateId,
    tenantId,
    data.eventId || null,
    data.name,
    finalWidth,
    finalHeight,
    data.dpi || 300,
    finalOrientation,
    finalPaperSize,
    qrPosition,
    JSON.stringify(qrCoords),
    shotsMode,
    boothMode,
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

export function updateTemplateSlots(templateId, tenantId, slots, layers = null, qrPosition = null, width = null, height = null, shotsMode = null, boothMode = null, orientation = null, paperSize = null, qrCoords = null) {
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
  if (qrCoords !== null && qrCoords !== undefined) {
    updates.push('qr_coords_json = ?');
    params.push(JSON.stringify(normalizeQrCoords(qrCoords)));
  }
  if (shotsMode) {
    updates.push('shots_mode = ?');
    params.push(String(shotsMode));
  }
  if (boothMode) {
    updates.push('booth_mode = ?');
    params.push(normalizeBoothMode(boothMode));
  }
  if (orientation || paperSize) {
    const resolved = resolveTemplateFormat({ orientation: orientation || template.orientation, paperSize: paperSize || template.paper_size });
    updates.push('orientation = ?', 'paper_size = ?');
    params.push(resolved.orientation, resolved.paperSize);
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
  if (updates.qrCoords !== undefined || updates.qr_coords !== undefined) {
    fields.push('qr_coords_json = ?');
    params.push(JSON.stringify(normalizeQrCoords(updates.qrCoords || updates.qr_coords)));
  }
  if (updates.shotsMode !== undefined || updates.shots_mode !== undefined) {
    fields.push('shots_mode = ?');
    params.push(String(updates.shotsMode || updates.shots_mode || 'event'));
  }
  if (updates.boothMode !== undefined || updates.booth_mode !== undefined) {
    fields.push('booth_mode = ?');
    params.push(normalizeBoothMode(updates.boothMode || updates.booth_mode));
  }
  if (updates.orientation !== undefined || updates.paperSize !== undefined || updates.paper_size !== undefined) {
    const resolved = resolveTemplateFormat({
      orientation: updates.orientation || template.orientation,
      paperSize: updates.paperSize || updates.paper_size || template.paper_size
    });
    fields.push('orientation = ?', 'paper_size = ?');
    params.push(resolved.orientation, resolved.paperSize);
  }

  if (fields.length > 0) {
    params.push(templateId, tenantId);
    db.prepare(`UPDATE templates SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
  }
  return getTemplateById(templateId, tenantId);
}
