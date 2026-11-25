import crypto from 'node:crypto';
import { execSync, execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/database.js';
import { resolvePaper, buildPrintSheetFile, detectImageOrientation } from './sheet.js';
import * as qrService from './qr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '../../public');

export function getSystemPrinters() {
  const detectedPrinters = [];
  let defaultPrinter = null;
  const platform = os.platform();

  if (platform === 'darwin' || platform === 'linux') {
    try {
      const out = execSync('lpstat -l -p -d', { encoding: 'utf8', timeout: 3500 });
      const lines = out.split('\n');
      let current = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (line.startsWith('tujuan default sistem:') || line.startsWith('system default destination:') || line.toLowerCase().includes('default')) {
          const parts = line.split(':');
          if (parts[1]) defaultPrinter = parts[1].trim();
        }
        const match = line.match(/^printer\s+([^\s]+)/);
        if (match) {
          if (current) detectedPrinters.push(current);
          const rawId = match[1];
          const cleanName = rawId.replace(/_/g, ' ');
          current = {
            id: rawId,
            name: cleanName,
            driverName: rawId,
            status: line.includes('idle') ? 'idle' : (line.includes('disabled') || line.includes('dimatikan') ? 'offline' : 'ready'),
            alerts: 'none',
            isDefault: false
          };
        } else if (current) {
          const descMatch = trimmed.match(/^(?:Deskripsi|Description):\s*(.*)$/i);
          if (descMatch && descMatch[1]) {
            current.name = descMatch[1].trim();
          }
          const alertMatch = trimmed.match(/^(?:Peringatan|Alerts):\s*(.*)$/i);
          if (alertMatch && alertMatch[1]) {
            const alertVal = alertMatch[1].trim().toLowerCase();
            current.alerts = alertVal;
            if (alertVal.includes('offline')) {
              current.status = 'offline';
            }
          }
        }
      }
      if (current) detectedPrinters.push(current);
    } catch (e) {
      console.warn('lpstat warning:', e.message);
    }
  } else if (platform === 'win32') {
    try {
      const psCmd = 'Get-CimInstance Win32_Printer | Select-Object Name, DriverName, Default, PrinterStatus, WorkOffline | ConvertTo-Json -Compress';
      const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8', timeout: 4500 });
      const parsed = JSON.parse(out);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        if (!p || !p.Name) continue;
        const isOffline = !!p.WorkOffline || p.PrinterStatus === 7;
        detectedPrinters.push({
          id: p.Name.replace(/\s+/g, '_'),
          name: p.Name,
          driverName: p.DriverName || p.Name,
          status: isOffline ? 'offline' : 'idle',
          alerts: isOffline ? 'offline-report' : 'none',
          isDefault: !!p.Default
        });
        if (p.Default) defaultPrinter = p.Name;
      }
    } catch (e) {
      console.warn('powershell printer warning:', e.message);
    }
  }

  // Mark default printer (prioritize exact ID or name match over substring match)
  if (defaultPrinter) {
    const exactFound = detectedPrinters.find(p => p.id === defaultPrinter || p.name === defaultPrinter);
    const fallbackFound = exactFound || detectedPrinters.find(p => defaultPrinter.includes(p.id));
    if (fallbackFound) fallbackFound.isDefault = true;
  }

  // Popular photobooth printer presets
  const photoboothPresets = [
    { id: 'epson_l8050', name: 'Epson L8050 Series (6-Color EcoTank)', model: 'Epson L8050', isPreset: true },
    { id: 'epson_l18050', name: 'Epson L18050 (A3+ 6-Color)', model: 'Epson L18050', isPreset: true },
    { id: 'epson_surelab_d500', name: 'Epson SureLab D500 (Commercial Minilab)', model: 'Epson SureLab D500', isPreset: true },
    { id: 'canon_selphy_cp1500', name: 'Canon SELPHY CP1500 / CP1300 (Dye-Sub)', model: 'Canon SELPHY CP1500', isPreset: true },
    { id: 'canon_ip2700', name: 'Canon iP2700 Series', model: 'Canon iP2700', isPreset: true },
    { id: 'dnp_ds620', name: 'DNP DS620 / RX1HS (High-Speed Minilab)', model: 'DNP DS620', isPreset: true },
    { id: 'hp_smart_tank', name: 'HP Smart Tank 580/590 Series', model: 'HP Smart Tank', isPreset: true },
    { id: 'simulator', name: 'Virtual Spooler (Simulator Uji Cetak)', model: 'Virtual Spooler', isPreset: true }
  ];

  return {
    platform,
    detectedPrinters,
    defaultPrinter,
    photoboothPresets
  };
}

export function resolveCupsQueueId(printerName, driverName) {
  const sys = getSystemPrinters();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nName = norm(printerName);
  const nDriver = norm(driverName || printerName);

  const candidates = (sys.detectedPrinters || []).filter(p => {
    const pid = norm(p.id);
    const pname = norm(p.name);
    return (
      (nDriver && (pid === nDriver || pid.includes(nDriver) || nDriver.includes(pid))) ||
      (nName && (pname === nName || pname.includes(nName) || nName.includes(pname) || pid === nName))
    );
  });

  // Sort candidates:
  // 1) Online printers (status !== 'offline') first
  // 2) System default printer (isDefault) first
  // 3) Exact ID or Name match first
  candidates.sort((a, b) => {
    const aOnline = a.status !== 'offline' ? 1 : 0;
    const bOnline = b.status !== 'offline' ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;

    const aDef = (a.isDefault || a.id === sys.defaultPrinter) ? 1 : 0;
    const bDef = (b.isDefault || b.id === sys.defaultPrinter) ? 1 : 0;
    if (aDef !== bDef) return bDef - aDef;

    const aExact = (a.id === driverName || a.name === printerName) ? 1 : 0;
    const bExact = (b.id === driverName || b.name === printerName) ? 1 : 0;
    return bExact - aExact;
  });

  if (candidates.length > 0) {
    return { cupsQueueId: candidates[0].id, printerObj: candidates[0], sys };
  }

  // Fallback to online system default printer if available
  const defaultObj = (sys.detectedPrinters || []).find(p => p.id === sys.defaultPrinter)
    || (sys.detectedPrinters || []).find(p => p.status !== 'offline');

  return {
    cupsQueueId: defaultObj ? defaultObj.id : (sys.defaultPrinter || null),
    printerObj: defaultObj || null,
    sys
  };
}

function readCupsMediaTypeLabelsFromPpd(cupsQueueId) {
  const labels = {};
  if (!cupsQueueId) return labels;
  try {
    const ppdPath = path.join('/etc/cups/ppd', `${cupsQueueId}.ppd`);
    if (!fs.existsSync(ppdPath)) return labels;
    const ppdText = fs.readFileSync(ppdPath, 'utf8');
    const re = /^\*MediaType\s+([^/\s:]+)\/([^:]+):/gm;
    let m;
    while ((m = re.exec(ppdText)) !== null) {
      labels[m[1].trim()] = m[2].trim();
    }
  } catch (e) {}
  return labels;
}

export function getPrinterMediaTypes(printerIdOrModel) {
  const platform = os.platform();
  const result = [];

  if ((platform === 'darwin' || platform === 'linux') && printerIdOrModel) {
    try {
      const { cupsQueueId } = resolveCupsQueueId(printerIdOrModel, printerIdOrModel);
      const rawPrinterId = String(cupsQueueId || printerIdOrModel.trim().replace(/[\s-]+/g, '_')).replace(/[^A-Za-z0-9_.-]/g, '');
      if (!rawPrinterId) return result;
      const out = execFileSync('lpoptions', ['-p', rawPrinterId, '-l'], { encoding: 'utf8', timeout: 2500 });
      const ppdLabels = readCupsMediaTypeLabelsFromPpd(rawPrinterId);
      const mediaLine = out.split('\n').find(l => l.startsWith('MediaType/'));
      if (mediaLine) {
        const optionsPart = mediaLine.split(':')[1];
        if (optionsPart) {
          const tokens = optionsPart.trim().split(/\s+/);
          const dictionary = {
            'any': 'Pilih Otomatis',
            'stationery': 'Kertas Biasa',
            'photographic-glossy': 'Kertas Foto Kilap',
            'com.hp-specialty-glossy': 'Specialty Paper, Glossy',
            'com.hp-matte-brochure': 'Specialty Paper, Matte',
            'stationery-lightweight': 'Kertas Ringan',
            'glossy': 'Kertas Foto Kilap (Glossy)',
            'matte': 'Kertas Foto Matte / Doff',
            'cardstock': 'Kertas Tebal / Cardstock',
            'labels': 'Kertas Stiker / Label',
            '0': 'Plain Paper (Kertas HVS Biasa)',
            '142': 'Letterhead (Kertas Biasa / Kop Surat)',
            '2': 'Epson Photo Quality Ink Jet',
            '12': 'Epson Matte',
            '92': 'Epson Ultra Glossy',
            '13': 'Epson Premium Glossy',
            '15': 'Epson Premium Semigloss',
            '145': 'Photo Paper Glossy',
            '75': 'Epson Photo Stickers'
          };
          for (const token of tokens) {
            const cleanToken = token.replace(/^\*/, '');
            const isDefault = token.startsWith('*');
            const label = ppdLabels[cleanToken]
              ? `${ppdLabels[cleanToken]} (Kode ${cleanToken})`
              : (dictionary[cleanToken] || cleanToken);
            result.push({ id: cleanToken, label, isDefault });
          }
        }
      }
    } catch (e) {}
  }

  if (result.length === 0) {
    const m = (printerIdOrModel || '').toLowerCase();
    if (m.includes('epson')) {
      return [
        { id: 'auto', label: 'Pilih Otomatis (Auto Detect)', isDefault: false },
        { id: 'epson-premium-glossy', label: 'Epson Premium Glossy Photo Paper (Kilap Premium)', isDefault: true },
        { id: 'epson-ultra-glossy', label: 'Epson Ultra Glossy Photo Paper', isDefault: false },
        { id: 'epson-photo-glossy', label: 'Epson Photo Paper Glossy (Standar Kilap)', isDefault: false },
        { id: 'epson-semigloss', label: 'Epson Premium Semigloss / Luster', isDefault: false },
        { id: 'epson-matte', label: 'Epson Matte Paper (Doff / Tidak Kilap)', isDefault: false },
        { id: 'epson-plain', label: 'Kertas Biasa (Plain Paper)', isDefault: false }
      ];
    } else if (m.includes('canon')) {
      return [
        { id: 'auto', label: 'Pilih Otomatis (Auto Detect)', isDefault: false },
        { id: 'canon-plus-glossy-2', label: 'Photo Paper Plus Glossy II (PP-201)', isDefault: true },
        { id: 'canon-everyday-glossy', label: 'Glossy Photo Paper "Everyday Use" (GP-501)', isDefault: false },
        { id: 'canon-pro-luster', label: 'Photo Paper Pro Luster (LU-101)', isDefault: false },
        { id: 'canon-matte', label: 'Matte Photo Paper (MP-101)', isDefault: false },
        { id: 'canon-photo-sticker', label: 'Photo Stickers (Kertas Stiker)', isDefault: false },
        { id: 'canon-plain', label: 'Kertas Biasa (Plain Paper)', isDefault: false }
      ];
    } else if (m.includes('hp')) {
      return [
        { id: 'any', label: 'Pilih Otomatis', isDefault: true },
        { id: 'photographic-glossy', label: 'Kertas Foto Kilap', isDefault: false },
        { id: 'com.hp-specialty-glossy', label: 'Specialty Paper, Glossy', isDefault: false },
        { id: 'com.hp-matte-brochure', label: 'Specialty Paper, Matte', isDefault: false },
        { id: 'stationery', label: 'Kertas Biasa', isDefault: false },
        { id: 'stationery-lightweight', label: 'Kertas Ringan', isDefault: false }
      ];
    } else if (m.includes('dnp') || m.includes('selphy') || m.includes('sublim')) {
      return [
        { id: 'dnp-glossy', label: 'Standard Glossy Dye-Sub Ribbon (Kilap Cepat)', isDefault: true },
        { id: 'dnp-luster', label: 'Luster / Semi-Gloss Dye-Sub Ribbon', isDefault: false },
        { id: 'dnp-matte', label: 'Matte Finish Dye-Sub Ribbon', isDefault: false }
      ];
    } else {
      return [
        { id: 'auto', label: 'Pilih Otomatis (Auto Detect)', isDefault: false },
        { id: 'glossy-photo', label: 'Kertas Foto Glossy / Kilap (210 - 260 gsm)', isDefault: true },
        { id: 'silky-luster', label: 'Kertas Foto Silky / Luster / Satin', isDefault: false },
        { id: 'matte-photo', label: 'Kertas Foto Matte / Doff', isDefault: false },
        { id: 'sticker-glossy', label: 'Kertas Stiker Foto Glossy', isDefault: false },
        { id: 'plain-paper', label: 'Kertas Biasa / HVS (70 - 80 gsm)', isDefault: false }
      ];
    }
  }

  return result;
}

const DEFAULT_PRINT_SETTINGS = {
  paperSize: '2x6',
  mode: 'manual',
  maxCopies: 2,
  borderless: true,
  highDpi: true,
  safeMargin: 90
};

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

export function normalizePrintSettings(input = {}) {
  const merged = { ...DEFAULT_PRINT_SETTINGS, ...(input || {}) };
  const rawMargin = parseInt(merged.safeMargin, 10);
  const safeMargin = Number.isFinite(rawMargin) ? Math.min(100, Math.max(80, rawMargin)) : 90;
  return {
    paperSize: String(merged.paperSize || DEFAULT_PRINT_SETTINGS.paperSize),
    mode: merged.mode === 'auto' ? 'auto' : 'manual',
    maxCopies: Math.min(10, Math.max(1, parseInt(merged.maxCopies, 10) || DEFAULT_PRINT_SETTINGS.maxCopies)),
    borderless: merged.borderless !== false && merged.borderless !== 'false',
    highDpi: merged.highDpi !== false && merged.highDpi !== 'false',
    safeMargin
  };
}

export function savePrinterProfile(tenantId, data) {
  const { name, model, driverName, paperSizes, mediaType, settings } = data;
  const existing = db.prepare('SELECT * FROM printer_profiles WHERE tenant_id = ? AND is_default = 1').get(tenantId);

  // Ukuran kertas utama diambil dari settings.paperSize, atau elemen pertama paperSizes (kompatibel versi lama)
  const normalized = normalizePrintSettings({
    ...(existing ? parseJson(existing.settings_json, {}) : {}),
    ...(settings || {}),
    ...(!settings?.paperSize && Array.isArray(paperSizes) && paperSizes[0] ? { paperSize: paperSizes[0] } : {})
  });
  const settingsJson = JSON.stringify(normalized);
  const paperSizesJson = JSON.stringify(paperSizes || [normalized.paperSize]);

  const finalName = name || model || 'Photobooth Printer';
  const finalModel = model || name || 'Photobooth Printer';
  const finalDriver = driverName || name || model || 'Standard Printer Driver';
  const finalMediaType = mediaType || 'photographic-glossy';

  if (existing) {
    db.prepare(`
      UPDATE printer_profiles
      SET name = ?, model = ?, driver_name = ?, paper_sizes_json = ?, media_type = ?, settings_json = ?
      WHERE id = ?
    `).run(
      finalName,
      finalModel,
      finalDriver,
      paperSizesJson,
      finalMediaType,
      settingsJson,
      existing.id
    );
    return { ...existing, name: finalName, model: finalModel, driver_name: finalDriver, paperSizes, media_type: finalMediaType, settings: normalized };
  } else {
    const id = 'printer_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
      INSERT INTO printer_profiles (id, tenant_id, name, model, driver_name, paper_sizes_json, media_type, is_default, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      id,
      tenantId,
      finalName,
      finalModel,
      finalDriver,
      paperSizesJson,
      finalMediaType,
      settingsJson
    );
    return { id, tenantId, name: finalName, model: finalModel, driver_name: finalDriver, paperSizes, media_type: finalMediaType, is_default: 1, settings: normalized };
  }
}

export function getPrinterProfiles(tenantId) {
  return db.prepare('SELECT * FROM printer_profiles WHERE tenant_id = ?').all(tenantId).map(p => {
    const paperSizes = parseJson(p.paper_sizes_json, []);
    const stored = parseJson(p.settings_json || '{}', {});
    return {
      ...p,
      paperSizes: Array.isArray(paperSizes) ? paperSizes : [],
      settings: normalizePrintSettings({
        ...(Array.isArray(paperSizes) && paperSizes[0] ? { paperSize: paperSizes[0] } : {}),
        ...stored
      })
    };
  });
}

export function getActivePrintProfile(tenantId) {
  const profiles = getPrinterProfiles(tenantId);
  return profiles.find(p => p.is_default === 1) || profiles[0] || null;
}

function is5rPaperSize(paperSize) {
  return /^(5r|5x7)$/i.test(String(paperSize || '').trim());
}

function formatPaperLabel(paperSize) {
  const key = String(paperSize || '').trim().toLowerCase();
  if (key === '5x7' || key === '5r') return '5R';
  if (key === '2x6') return '4R (Strip 2×6)';
  if (key === '4x6' || key === '4r') return '4R';
  if (key === '6x8') return '6×8';
  if (key === 'a4') return 'A4';
  return String(paperSize || '4R').toUpperCase();
}

// Opsi lengkap yang dipakai mencetak (disimpan di job agar cetak ulang tetap konsisten)
export function buildPrintOptions(tenantId, copies = 1, paperSizeOverride = null) {
  const profile = getActivePrintProfile(tenantId);
  const settings = normalizePrintSettings(profile?.settings || {});
  const chosenPaperSize = (paperSizeOverride && String(paperSizeOverride).trim())
    ? String(paperSizeOverride).trim()
    : settings.paperSize;
  const paper = resolvePaper(chosenPaperSize);
  const printerName = profile ? profile.name : 'Epson L8050 Series';
  return {
    printerName,
    driverName: profile ? (profile.driver_name || profile.name) : printerName,
    mediaType: profile ? (profile.media_type || 'photographic-glossy') : 'photographic-glossy',
    paperSize: chosenPaperSize,
    paperLabel: formatPaperLabel(chosenPaperSize),
    paperWidthIn: paper.widthIn,
    paperHeightIn: paper.heightIn,
    layout: paper.layout,
    borderless: settings.borderless,
    highDpi: settings.highDpi,
    safeMargin: settings.safeMargin,
    copies
  };
}

// ==========================================
// PRINT AGENT (aplikasi cetak otomatis di komputer studio)
// ==========================================
const AGENT_ONLINE_WINDOW_MS = 25000;
const AGENT_JOB_MAX_AGE_MIN = 15;
const agentSeen = new Map(); // tenantId -> { at, host, platform, printers }

export function getOrCreateAgentKey(tenantId) {
  const row = db.prepare('SELECT agent_key FROM tenants WHERE id = ?').get(tenantId);
  if (!row) throw new Error('Tenant tidak ditemukan');
  if (row.agent_key) return row.agent_key;
  const key = 'pa_' + crypto.randomBytes(18).toString('hex');
  db.prepare('UPDATE tenants SET agent_key = ? WHERE id = ?').run(key, tenantId);
  return key;
}

export function regenerateAgentKey(tenantId) {
  const key = 'pa_' + crypto.randomBytes(18).toString('hex');
  db.prepare('UPDATE tenants SET agent_key = ? WHERE id = ?').run(key, tenantId);
  agentSeen.delete(tenantId);
  return key;
}

export function findTenantByAgentKey(key) {
  if (!key || typeof key !== 'string') return null;
  const row = db.prepare('SELECT id FROM tenants WHERE agent_key = ?').get(key);
  return row ? row.id : null;
}

export function touchAgent(tenantId, info = {}) {
  const existing = agentSeen.get(tenantId);
  const incomingCanClaim = info.canClaim !== false;
  const existingFreshPrinter = !!existing && existing.canClaim !== false && (Date.now() - existing.at < AGENT_ONLINE_WINDOW_MS);
  // Jika ada laptop kamera-only yang tidak punya printer online ikut menyalakan layanan,
  // jangan timpa daftar printer & host milik laptop printer yang sedang aktif.
  if (!incomingCanClaim && existingFreshPrinter && existing.host && existing.host !== (info.host || '')) {
    return;
  }
  agentSeen.set(tenantId, {
    at: Date.now(),
    host: info.host || '',
    platform: info.platform || '',
    printers: info.printers ?? existing?.printers ?? [],
    canClaim: incomingCanClaim
  });
}

export function getAgentStatus(tenantId) {
  const seen = agentSeen.get(tenantId);
  const online = !!seen && seen.canClaim !== false && Date.now() - seen.at < AGENT_ONLINE_WINDOW_MS;
  return {
    online,
    host: seen?.host || null,
    platform: seen?.platform || null,
    printers: seen?.printers || [],
    lastSeenSecondsAgo: seen ? Math.round((Date.now() - seen.at) / 1000) : null
  };
}

export function isAgentOnline(tenantId) {
  return getAgentStatus(tenantId).online;
}

export function claimAgentJobs(tenantId) {
  // Pulihkan job 'processing' yang macet > 5 menit akibat agent putus/restart di tengah cetak
  try {
    db.prepare(`
      UPDATE print_jobs
      SET state = 'queued', updated_at = datetime('now')
      WHERE tenant_id = ? AND state = 'processing' AND updated_at <= datetime('now', '-5 minutes')
        AND created_at >= datetime('now', ?)
    `).run(tenantId, `-${AGENT_JOB_MAX_AGE_MIN} minutes`);
  } catch (e) {}

  const jobs = db.prepare(`
    SELECT id, copies, options_json FROM print_jobs
    WHERE tenant_id = ? AND state = 'queued' AND created_at >= datetime('now', ?)
    ORDER BY created_at ASC LIMIT 5
  `).all(tenantId, `-${AGENT_JOB_MAX_AGE_MIN} minutes`);

  const claimed = [];
  for (const job of jobs) {
    const res = db.prepare("UPDATE print_jobs SET state = 'processing', updated_at = datetime('now') WHERE id = ? AND state = 'queued'").run(job.id);
    if (res.changes > 0) {
      claimed.push({
        id: job.id,
        copies: job.copies || 1,
        options: parseJson(job.options_json || '{}', {})
      });
    }
  }
  return claimed;
}

export function finishAgentJob(tenantId, jobId, { ok, error, spoolerId }) {
  const job = db.prepare('SELECT id FROM print_jobs WHERE id = ? AND tenant_id = ?').get(jobId, tenantId);
  if (!job) throw new Error('Job tidak ditemukan');
  if (ok) {
    db.prepare("UPDATE print_jobs SET state = 'completed', spooler_job_id = COALESCE(?, spooler_job_id), error_message = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(spoolerId || null, jobId);
  } else {
    db.prepare("UPDATE print_jobs SET state = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?")
      .run(String(error || 'Gagal mencetak').slice(0, 300), jobId);
  }
  return { success: true };
}

// Tandai job sudah dicetak lewat dialog browser (fallback tanpa Print Agent)
export function markJobPrintedByBrowser(jobId, tenantId = null) {
  const job = tenantId
    ? db.prepare('SELECT id, state FROM print_jobs WHERE id = ? AND tenant_id = ?').get(jobId, tenantId)
    : db.prepare('SELECT id, state FROM print_jobs WHERE id = ?').get(jobId);
  if (!job) return false;
  if (job.state === 'queued' || job.state === 'processing') {
    db.prepare("UPDATE print_jobs SET state = 'completed', updated_at = datetime('now') WHERE id = ?").run(jobId);
  }
  return true;
}

  // Lokasi file lembar siap cetak untuk sebuah job (sudah termasuk susunan 2 strip per lembar)
export function getPrintSheetForJob(jobId) {
  const job = db.prepare(`
    SELECT pj.id, pj.options_json, ma.file_path
    FROM print_jobs pj JOIN media_assets ma ON pj.media_asset_id = ma.id
    WHERE pj.id = ?
  `).get(jobId);
  if (!job || !job.file_path) return null;
  const abs = path.join(publicDir, job.file_path.replace(/^\//, ''));
  if (!fs.existsSync(abs)) return null;
  const options = parseJson(job.options_json || '{}', {});
  return { path: buildPrintSheetFile(abs, options, job.id), options };
}

export function getPrintSheetForAsset(assetId, tenantId, extraOptions = {}) {
  const asset = db.prepare('SELECT * FROM media_assets WHERE id = ? AND tenant_id = ?').get(assetId, tenantId);
  if (!asset || !asset.file_path) return null;
  const abs = path.join(publicDir, asset.file_path.replace(/^\//, ''));
  if (!fs.existsSync(abs)) return null;

  const options = buildPrintOptions(tenantId, 1, extraOptions.paperSize || null);
  const qrCfg = resolveSessionPrintQrConfig(asset.photo_session_id, tenantId, asset.event_id, {
    ...extraOptions,
    autoIssuePass: true
  });
  options.qrUrl = qrCfg.qrUrl;
  options.qrPosition = qrCfg.qrPosition || 'bottom-right';
  if (qrCfg.qrCoords && qrCfg.qrCoords.length > 0) {
    options.qrCoords = qrCfg.qrCoords;
    options.qrTemplateWidth = qrCfg.qrTemplateWidth;
    options.qrTemplateHeight = qrCfg.qrTemplateHeight;
  }
  const sheetCacheKey = `asset_${assetId}_${String(options.paperSize || '4x6').replace(/[^a-z0-9]/gi, '')}${extraOptions.templateId ? `_tpl_${String(extraOptions.templateId).replace(/[^a-z0-9_-]/gi, '')}` : ''}`;
  const sheetPath = buildPrintSheetFile(abs, options, sheetCacheKey);
  return { path: sheetPath, options };
}

function resolveCupsDriverOptions(cupsQueueId, options) {
  const wi = Math.round(Number(options.paperWidthIn) || 4);
  const hi = Math.round(Number(options.paperHeightIn) || 6);
  const fallbackPage = wi === 5 && hi === 7 ? '5x7' : (String(options.paperSize || '').toUpperCase() === 'A4' ? 'A4' : '4x6');
  const res = {
    pageOptKey: 'media',
    pageChoice: fallbackPage,
    resolvedMediaType: (options.mediaType && options.mediaType !== 'auto' && options.mediaType !== 'any') ? options.mediaType : null,
    colorArgs: []
  };
  try {
    const out = execFileSync('lpoptions', ['-p', cupsQueueId, '-l'], { encoding: 'utf8', timeout: 2500 });
    const lines = out.split('\n');
    const pageLine = lines.find(l => /^(PageSize|media)\//i.test(l.trim()));
    if (pageLine) {
      res.pageOptKey = pageLine.split('/')[0].trim();
      const choices = (pageLine.split(':')[1] || '').trim().split(/\s+/).map(c => c.replace(/^\*/, ''));
      const matchers = [new RegExp(`(^|[^0-9])${wi}\\s*x\\s*${hi}(?![0-9.])`, 'i')];
      if (wi === 4 && hi === 6) matchers.push(/10\s*x\s*15|100\s*x\s*150|102\s*x\s*152|4r\b|kg\b/i);
      if (wi === 5 && hi === 7) matchers.push(/13\s*x\s*18|127\s*x\s*178|5\s*x\s*7|5r\b|2l\b/i);
      if (fallbackPage === 'A4') matchers.push(/^a4(\.|$)/i);
      const candidates = choices.filter(c => !/manucdr|disc|id\s*card|envelope|roll/i.test(c) && matchers.some(re => re.test(c)));
      if (candidates.length > 0) {
        const borderlessRe = /borderless|nmgn|fullbleed|\.fb\b/i;
        const wantBorderless = options.borderless !== false;
        res.pageChoice = candidates.find(c => borderlessRe.test(c) === wantBorderless) || candidates[0];
      }
    }

    // Petakan nama media generik (mis. "photographic-glossy" / "epson-premium-glossy") ke kode PPD Epson bila perlu
    const mediaLine = lines.find(l => l.startsWith('MediaType/'));
    if (mediaLine && res.resolvedMediaType) {
      const mChoices = (mediaLine.split(':')[1] || '').trim().split(/\s+/).map(c => c.replace(/^\*/, ''));
      if (!mChoices.includes(res.resolvedMediaType)) {
        const ppdLabels = readCupsMediaTypeLabelsFromPpd(cupsQueueId);
        const wantedWords = String(res.resolvedMediaType).toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !['paper', 'kertas', 'auto', 'any', 'photographic'].includes(w));
        let bestCode = null, bestScore = 0;
        for (const code of mChoices) {
          const text = `${code} ${ppdLabels[code] || ''}`.toLowerCase();
          const score = wantedWords.filter(w => text.includes(w)).length;
          if (score > bestScore) { bestScore = score; bestCode = code; }
        }
        if (bestCode) res.resolvedMediaType = bestCode;
      }
    }

    // Aktifkan sRGB / ColorSync Matching pada driver Epson CUPS agar abu-abu tetap netral & warna tidak kemerahan
    if (lines.some(l => l.startsWith('EPIJ_OSColMat/'))) res.colorArgs.push('-o', 'EPIJ_OSColMat=2');
    if (lines.some(l => l.startsWith('EPIJ_OSCMProf/'))) res.colorArgs.push('-o', 'EPIJ_OSCMProf=1');
    if (lines.some(l => l.startsWith('EPIJ_CMat/'))) res.colorArgs.push('-o', 'EPIJ_CMat=0');
  } catch (e) {}
  return res;
}

export function dispatchPrintJobToOs(printJobId, absFilePath, printFilePath, options, copies = 1, sheetOrientation = 'portrait') {
  const platform = os.platform();
  const printerName = options.printerName;
  const driverName = options.driverName;
  let dispatchedToOs = false;
  let resolvedQueueId = null;
  let resolvedPrinterName = printerName;

  if (!absFilePath || !printFilePath || process.env.PRINT_MODE === 'agent') {
    return { dispatchedToOs, resolvedQueueId, resolvedPrinterName };
  }

  if (platform === 'darwin' || platform === 'linux') {
    try {
      const { cupsQueueId, printerObj } = resolveCupsQueueId(printerName, driverName);
      if (cupsQueueId) {
        resolvedQueueId = cupsQueueId;
        if (printerObj && printerObj.name) {
          resolvedPrinterName = printerObj.name;
        }
        dispatchedToOs = true;
        const drv = resolveCupsDriverOptions(cupsQueueId, options);
        const lpArgs = [
          '-d', cupsQueueId,
          '-n', String(copies),
          '-o', `${drv.pageOptKey}=${drv.pageChoice}`,
          '-o', 'fit-to-page',
          '-o', sheetOrientation === 'landscape' ? 'orientation-requested=4' : 'orientation-requested=3'
        ];
        if (drv.resolvedMediaType) {
          lpArgs.push('-o', `MediaType=${drv.resolvedMediaType}`);
        }
        if (drv.colorArgs.length > 0) {
          lpArgs.push(...drv.colorArgs);
        }
        const isEpson = /epson|epij/i.test(`${cupsQueueId} ${driverName || ''} ${printerName || ''}`);
        if (options.borderless && isEpson) {
          lpArgs.push('-o', 'EPIJ_Bdls=1', '-o', 'EPIJ_exmg=0');
        }
        if (options.highDpi) {
          if (isEpson) lpArgs.push('-o', 'EPIJ_Qual=306', '-o', 'Resolution=720x720dpi', '-o', 'EPIJ_Mode=3', '-o', 'EPIJ_OPT_Bi_D=0');
          lpArgs.push('-o', 'print-quality=5');
        } else {
          if (isEpson) lpArgs.push('-o', 'EPIJ_Qual=303', '-o', 'Resolution=360x360dpi', '-o', 'EPIJ_OPT_Bi_D=1');
          lpArgs.push('-o', 'print-quality=3');
        }
        lpArgs.push(printFilePath);

        if (platform === 'darwin') {
          execFile('open', ['-g', '-a', '/System/Applications/Utilities/Print Center.app'], () => {});
        }

        db.prepare("UPDATE print_jobs SET state = 'processing', updated_at = datetime('now') WHERE id = ?").run(printJobId);
        execFile('lp', lpArgs, { timeout: 10000 }, (err, stdout) => {
          if (err) {
            console.warn('CUPS lp error:', err.message);
            try {
              db.prepare("UPDATE print_jobs SET state = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?")
                .run(String(err.message || 'Gagal kirim ke CUPS').slice(0, 280), printJobId);
            } catch (e) {}
            return;
          }
          if (stdout) {
            const m = stdout.trim().match(/(?:request id is|id permintaan adalah)\s+([^\s]+)/i)
              || stdout.trim().match(/([A-Za-z0-9_]+-\d+)/);
            const realCupsJobId = m ? (m[1] || m[2]) : null;
            if (realCupsJobId) {
              try {
                db.prepare('UPDATE print_jobs SET spooler_job_id = ? WHERE id = ?').run(realCupsJobId, printJobId);
              } catch (e) {}
            }
          }
          try {
            db.prepare("UPDATE print_jobs SET state = 'spooled', updated_at = datetime('now') WHERE id = ?").run(printJobId);
            setTimeout(() => {
              try {
                db.prepare("UPDATE print_jobs SET state = 'completed', updated_at = datetime('now') WHERE id = ? AND state = 'spooled'").run(printJobId);
              } catch (e) {}
            }, 2500);
          } catch (e) {}
        });
      }
    } catch (e) {
      console.warn('OS direct print error:', e.message);
    }
  } else if (platform === 'win32') {
    try {
      const { printerObj, sys } = resolveCupsQueueId(printerName, driverName);
      const targetWinPrinter = (printerObj && printerObj.name) ? printerObj.name : (sys.defaultPrinter || printerName);
      resolvedPrinterName = targetWinPrinter;
      resolvedQueueId = printerObj ? printerObj.id : targetWinPrinter;
      dispatchedToOs = true;

      db.prepare("UPDATE print_jobs SET state = 'processing', updated_at = datetime('now') WHERE id = ?").run(printJobId);

      const psScript = `
        Add-Type -AssemblyName System.Drawing;
        $img = [System.Drawing.Image]::FromFile($env:PB_FILE);
        $doc = New-Object System.Drawing.Printing.PrintDocument;
        $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController;
        if ($env:PB_PRINTER) { $doc.PrinterSettings.PrinterName = $env:PB_PRINTER };
        $doc.PrinterSettings.Copies = [int16]$env:PB_COPIES;
        $doc.OriginAtMargins = $false;
        $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0);
        $wIn = [double]$env:PB_PAPER_W; $hIn = [double]$env:PB_PAPER_H;
        $targetW = [int][Math]::Round($wIn * 100); $targetH = [int][Math]::Round($hIn * 100);
        $matching = @();
        foreach ($ps in $doc.PrinterSettings.PaperSizes) {
          $okNorm = ([Math]::Abs($ps.Width - $targetW) -le 18 -and [Math]::Abs($ps.Height - $targetH) -le 18);
          $okSwap = ([Math]::Abs($ps.Width - $targetH) -le 18 -and [Math]::Abs($ps.Height - $targetW) -le 18);
          $ok5r = ($wIn -eq 5 -and ($ps.PaperName -match '5\\s*x\\s*7|13\\s*x\\s*18|127\\s*x\\s*178|5r\\b|2l\\b'));
          $ok4r = ($wIn -eq 4 -and ($ps.PaperName -match '4\\s*x\\s*6|10\\s*x\\s*15|100\\s*x\\s*150|4r\\b|kg\\b'));
          if ($okNorm -or $okSwap -or $ok5r -or $ok4r) { $matching += $ps }
        }
        if ($matching.Count -gt 0) {
          $chosen = $matching | Where-Object { $_.PaperName -match 'borderless|tanpa\\s*tepi|full|nmgn' } | Select-Object -First 1;
          if (-not $chosen) { $chosen = $matching | Select-Object -First 1 };
          $doc.DefaultPageSettings.PaperSize = $chosen;
        }
        if ($img.Width -gt $img.Height) { $doc.DefaultPageSettings.Landscape = $true } else { $doc.DefaultPageSettings.Landscape = $false };
        $doc.add_PrintPage({
          param($sender, $e)
          $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
          $bounds = $e.PageBounds;
          $ratio = [Math]::Min($bounds.Width / $img.Width, $bounds.Height / $img.Height);
          $w = [int]($img.Width * $ratio);
          $h = [int]($img.Height * $ratio);
          $x = [int](($bounds.Width - $w) / 2);
          $y = [int](($bounds.Height - $h) / 2);
          $e.Graphics.DrawImage($img, $x, $y, $w, $h);
          $e.HasMorePages = $false;
        });
        $doc.Print();
        $img.Dispose();
        Write-Output "WIN_SPOOL_OK";
      `;

      execFile('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript], {
        timeout: 15000,
        env: {
          ...process.env,
          PB_FILE: printFilePath,
          PB_PRINTER: targetWinPrinter || '',
          PB_COPIES: String(Math.max(1, copies || 1)),
          PB_PAPER_W: String(options.paperWidthIn || 4),
          PB_PAPER_H: String(options.paperHeightIn || 6)
        }
      }, (err, stdout, stderr) => {
        if (err || !String(stdout || '').includes('WIN_SPOOL_OK')) {
          try {
            db.prepare("UPDATE print_jobs SET state = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?")
              .run(String(err?.message || stderr || 'Windows PrintDocument gagal').slice(0, 280), printJobId);
          } catch (e) {}
          return;
        }
        try {
          db.prepare("UPDATE print_jobs SET state = 'spooled', updated_at = datetime('now') WHERE id = ?").run(printJobId);
          setTimeout(() => {
            try {
              db.prepare("UPDATE print_jobs SET state = 'completed', updated_at = datetime('now') WHERE id = ? AND state = 'spooled'").run(printJobId);
            } catch (e) {}
          }, 2500);
        } catch (e) {}
      });
    } catch (e) {
      console.warn('Windows direct print error:', e.message);
    }
  }

  return { dispatchedToOs, resolvedQueueId, resolvedPrinterName };
}

function resolveSessionPrintQrConfig(photoSessionId, tenantId, fallbackEventId, extraOptions = {}) {
  let qrUrl = extraOptions.qrUrl || null;
  let qrPosition = extraOptions.qrPosition || null;
  let qrCoords = (Array.isArray(extraOptions.qrCoords) && extraOptions.qrCoords.length > 0) ? extraOptions.qrCoords : null;
  let qrTemplateWidth = Number(extraOptions.qrTemplateWidth) || null;
  let qrTemplateHeight = Number(extraOptions.qrTemplateHeight) || null;
  let overrideTemplate = null;
  let session = null;

  if (extraOptions.templateId) {
    overrideTemplate = db.prepare(`
      SELECT id, qr_position, qr_coords_json, width, height
      FROM templates
      WHERE id = ? AND (tenant_id = ? OR tenant_id = 'global')
    `).get(extraOptions.templateId, tenantId);
    if (overrideTemplate) {
      if (!qrPosition) qrPosition = overrideTemplate.qr_position || 'bottom-right';
      if ((!qrCoords || qrCoords.length === 0) && overrideTemplate.qr_coords_json) {
        const parsed = parseJson(overrideTemplate.qr_coords_json, []);
        if (Array.isArray(parsed) && parsed.length > 0) qrCoords = parsed;
      }
      if (!qrTemplateWidth) qrTemplateWidth = overrideTemplate.width || null;
      if (!qrTemplateHeight) qrTemplateHeight = overrideTemplate.height || null;
    }
  }

  if (photoSessionId) {
    session = db.prepare(`
      SELECT ps.id, ps.guest_pass_id, ps.template_id, ps.event_id,
             gp.token_plain,
             t.qr_position, t.qr_coords_json, t.width as tpl_width, t.height as tpl_height
      FROM photo_sessions ps
      LEFT JOIN guest_passes gp ON ps.guest_pass_id = gp.id
      LEFT JOIN templates t ON ps.template_id = t.id
      WHERE ps.id = ?
    `).get(photoSessionId);

    if (session) {
      if (!overrideTemplate) {
        if (!qrPosition) qrPosition = session.qr_position || 'bottom-right';
        if ((!qrCoords || qrCoords.length === 0) && session.qr_coords_json) {
          const parsed = parseJson(session.qr_coords_json, []);
          if (Array.isArray(parsed) && parsed.length > 0) qrCoords = parsed;
        }
        if (!qrTemplateWidth) qrTemplateWidth = session.tpl_width || null;
        if (!qrTemplateHeight) qrTemplateHeight = session.tpl_height || null;
      }
      if (!qrUrl) {
        let token = session.token_plain;
        if (!token && session.guest_pass_id) {
          const pass = db.prepare('SELECT token_plain FROM guest_passes WHERE id = ?').get(session.guest_pass_id);
          if (pass) token = pass.token_plain;
        }
        if (token) {
          const baseUrl = extraOptions.baseUrl || process.env.BASE_URL || 'https://mafaza.galipatsistem.com';
          qrUrl = `${baseUrl.replace(/\/+$/, '')}/gallery/g/${token}`;
        }
      }
    }
  }

  if (qrCoords && qrCoords.length > 0 && (!qrPosition || qrPosition === 'none')) {
    qrPosition = 'bottom-right';
  }
  const effectivePos = qrPosition || 'bottom-right';
  const qrEnabled = (Array.isArray(qrCoords) && qrCoords.length > 0) || effectivePos !== 'none';

  if (!qrUrl && qrEnabled && extraOptions.autoIssuePass) {
    try {
      const targetEventId = (session && session.event_id) || fallbackEventId || null;
      const autoPass = qrService.createGuestPassRecordSync(tenantId, targetEventId, 'print_auto');
      if (autoPass && autoPass.token_plain) {
        if (session && session.id) {
          db.prepare('UPDATE photo_sessions SET guest_pass_id = ? WHERE id = ?').run(autoPass.id, session.id);
        }
        const baseUrl = extraOptions.baseUrl || process.env.BASE_URL || 'https://mafaza.galipatsistem.com';
        qrUrl = `${baseUrl.replace(/\/+$/, '')}/gallery/g/${autoPass.token_plain}`;
      }
    } catch (e) {}
  }

  return { qrUrl, qrPosition: effectivePos, qrCoords, qrTemplateWidth, qrTemplateHeight };
}

export function createPrintJob(tenantId, eventId, deviceId, photoSessionId, mediaAssetId, copies = 1, extraOptions = {}) {
  const printJobId = 'pjob_' + crypto.randomBytes(8).toString('hex');
  const idempotencyKey = `print_${photoSessionId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // Ambil seluruh pengaturan cetak aktif (plus override ukuran kertas 4R/5R bila dipilih tamu/operator)
  const options = buildPrintOptions(tenantId, copies, extraOptions.paperSize || null);
  const safeCopies = Math.max(1, Math.min(options.maxCopies || 10, parseInt(copies, 10) || 1));
  if (extraOptions.mediaType) options.mediaType = extraOptions.mediaType;
  if (extraOptions.borderless !== undefined) options.borderless = Boolean(extraOptions.borderless);
  if (extraOptions.highDpi !== undefined) options.highDpi = Boolean(extraOptions.highDpi);
  if (extraOptions.safeMargin !== undefined) options.safeMargin = extraOptions.safeMargin;

  // Cari token galeri dan posisi QR template untuk ditempelkan khusus pada lembar cetak
  const { qrUrl, qrPosition, qrCoords, qrTemplateWidth, qrTemplateHeight } = resolveSessionPrintQrConfig(
    photoSessionId,
    tenantId,
    eventId,
    extraOptions
  );

  if (extraOptions.baseUrl) {
    options.baseUrl = extraOptions.baseUrl;
  }
  options.qrUrl = qrUrl;
  options.qrPosition = qrPosition || 'bottom-right';
  if (qrCoords && qrCoords.length > 0) {
    options.qrCoords = qrCoords;
    options.qrTemplateWidth = qrTemplateWidth;
    options.qrTemplateHeight = qrTemplateHeight;
  }

  const printerName = options.printerName;
  const driverName = options.driverName;
  const mediaType = options.mediaType;
  const spoolerJobId = 'EPSON_SPOOL_' + Math.floor(100000 + Math.random() * 900000);

  // Check if we have a real image file on disk and a non-simulator printer
  const asset = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(mediaAssetId);
  const isUnitTestSession = String(photoSessionId || '').startsWith('sess_print_test_') || String(photoSessionId || '').startsWith('sess_test_0');
  const isSimulator = /simulator|virtual/i.test(printerName) || /simulator|virtual/i.test(driverName);

  // 5R (13x18 cm) wajib menunggu konfirmasi pergantian kertas di Laptop Printer / Admin kecuali sudah dicentang siap
  const requiresPaperConfirm = is5rPaperSize(options.paperSize) && !extraOptions.paperConfirmed && !isUnitTestSession;
  options.requiresPaperConfirm = requiresPaperConfirm;
  const initialState = requiresPaperConfirm ? 'awaiting_paper' : 'queued';

  let absFilePath = null;
  if (asset && asset.file_path) {
    const candidate = path.join(publicDir, asset.file_path.replace(/^\//, ''));
    if (fs.existsSync(candidate)) {
      absFilePath = candidate;
    }
  }

  // File lembar siap cetak (mis. 2 strip 2x6 disusun berdampingan di kertas 4x6, portrait/landscape sesuai frame)
  const printFilePath = absFilePath ? buildPrintSheetFile(absFilePath, options, printJobId) : null;
  const sheetOrientation = detectImageOrientation(printFilePath || absFilePath);
  options.orientation = sheetOrientation;

  db.prepare(`
    INSERT INTO print_jobs (id, tenant_id, event_id, device_id, photo_session_id, media_asset_id, copies, state, spooler_job_id, idempotency_key, options_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    printJobId,
    tenantId,
    eventId,
    deviceId || null,
    photoSessionId,
    mediaAssetId,
    safeCopies,
    initialState,
    spoolerJobId,
    idempotencyKey,
    JSON.stringify(options)
  );

  let dispatchedToOs = false;
  let resolvedQueueId = null;
  let resolvedPrinterName = printerName;

  if (!requiresPaperConfirm && absFilePath && !isUnitTestSession && !isSimulator) {
    const disp = dispatchPrintJobToOs(printJobId, absFilePath, printFilePath, options, safeCopies, sheetOrientation);
    dispatchedToOs = disp.dispatchedToOs;
    resolvedQueueId = disp.resolvedQueueId;
    resolvedPrinterName = disp.resolvedPrinterName;
  }

  // Server ada di cloud (tanpa printer). Jika Print Agent aktif di komputer studio,
  // biarkan job berstatus 'queued' (atau 'awaiting_paper' untuk 5R) agar diproses agent setelah siap.
  const awaitingAgent = !requiresPaperConfirm && !dispatchedToOs && !!absFilePath && !isUnitTestSession && !isSimulator && isAgentOnline(tenantId);

  if (!requiresPaperConfirm && !dispatchedToOs && (isUnitTestSession || isSimulator)) {
    // Simulate print spooling progression asynchronously ONLY for unit tests / virtual simulator printers
    setTimeout(() => {
      try {
        db.prepare("UPDATE print_jobs SET state = 'processing' WHERE id = ?").run(printJobId);
        setTimeout(() => {
          try {
            db.prepare("UPDATE print_jobs SET state = 'spooled' WHERE id = ?").run(printJobId);
            setTimeout(() => {
              try {
                db.prepare("UPDATE print_jobs SET state = 'completed' WHERE id = ?").run(printJobId);
              } catch (e) {}
            }, 1500);
          } catch (e) {}
        }, 1500);
      } catch (e) {}
    }, 1000);
  }

  return {
    printJobId,
    spoolerJobId,
    printerName: resolvedPrinterName,
    cupsQueueId: resolvedQueueId,
    mediaType,
    dispatchedToOs,
    awaitingAgent,
    requiresPaperConfirm,
    paperSize: options.paperSize,
    paperLabel: options.paperLabel,
    paperWidthIn: options.paperWidthIn,
    paperHeightIn: options.paperHeightIn,
    layout: options.layout,
    orientation: sheetOrientation,
    borderless: options.borderless,
    sheetUrl: `/api/print-jobs/${printJobId}/sheet`,
    state: initialState,
    copies
  };
}

export function confirmPrintJobPaper(printJobId, tenantId, operatorId = null) {
  const job = db.prepare(`
    SELECT pj.*, ma.file_path
    FROM print_jobs pj
    LEFT JOIN media_assets ma ON pj.media_asset_id = ma.id
    WHERE pj.id = ? AND pj.tenant_id = ?
  `).get(printJobId, tenantId);
  if (!job) throw new Error('Job cetak tidak ditemukan');

  const options = parseJson(job.options_json || '{}', {});
  options.requiresPaperConfirm = false;
  options.paperConfirmedAt = new Date().toISOString();

  db.prepare("UPDATE print_jobs SET state = 'queued', options_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(options), printJobId);

  const isSimulator = /simulator|virtual/i.test(options.printerName || '') || /simulator|virtual/i.test(options.driverName || '');
  let absFilePath = null;
  if (job.file_path) {
    const candidate = path.join(publicDir, job.file_path.replace(/^\//, ''));
    if (fs.existsSync(candidate)) absFilePath = candidate;
  }

  let dispatchedToOs = false;
  if (absFilePath && !isSimulator) {
    const printFilePath = buildPrintSheetFile(absFilePath, options, printJobId);
    const sheetOrientation = options.orientation || detectImageOrientation(printFilePath || absFilePath);
    const disp = dispatchPrintJobToOs(printJobId, absFilePath, printFilePath, options, job.copies || 1, sheetOrientation);
    dispatchedToOs = disp.dispatchedToOs;
  }

  const awaitingAgent = !dispatchedToOs && !isSimulator && isAgentOnline(tenantId);

  if (operatorId) {
    try {
      db.prepare(`
        INSERT INTO audit_logs (id, tenant_id, user_id, actor_name, action, details_json)
        VALUES (?, ?, ?, 'Operator', 'confirm_paper_5r', ?)
      `).run(
        'audit_' + crypto.randomBytes(8).toString('hex'),
        tenantId,
        operatorId,
        JSON.stringify({ printJobId, paperSize: options.paperSize })
      );
    } catch (e) {}
  }

  return {
    success: true,
    printJobId,
    state: dispatchedToOs ? 'processing' : 'queued',
    dispatchedToOs,
    awaitingAgent,
    paperSize: options.paperSize,
    paperLabel: options.paperLabel || formatPaperLabel(options.paperSize),
    copies: job.copies || 1,
    sheetUrl: `/api/print-jobs/${printJobId}/sheet`
  };
}

export function getPrintJobs(tenantId, eventId = null) {
  let query = `
    SELECT pj.*, e.name as event_name, ma.file_path as media_url
    FROM print_jobs pj
    LEFT JOIN events e ON pj.event_id = e.id
    LEFT JOIN media_assets ma ON pj.media_asset_id = ma.id
    WHERE pj.tenant_id = ?
  `;
  const params = [tenantId];
  if (eventId) {
    query += ' AND pj.event_id = ?';
    params.push(eventId);
  }
  query += ' ORDER BY pj.created_at DESC LIMIT 50';

  return db.prepare(query).all(...params);
}

export function reprintJob(printJobId, tenantId, operatorId, copies = null, extraOptions = {}) {
  const original = db.prepare('SELECT * FROM print_jobs WHERE id = ? AND tenant_id = ?').get(printJobId, tenantId);
  if (!original) throw new Error('Job cetak tidak ditemukan');

  const origOpts = parseJson(original.options_json || '{}', {});
  const finalCopies = parseInt(copies) || original.copies || 1;
  const resolvedBaseUrl = extraOptions.baseUrl || origOpts.baseUrl || null;
  let resolvedQrUrl = null;
  if (origOpts.qrUrl) {
    if (resolvedBaseUrl) {
      try {
        const parsedOrig = new URL(origOpts.qrUrl);
        resolvedQrUrl = `${resolvedBaseUrl.replace(/\/+$/, '')}${parsedOrig.pathname}${parsedOrig.search}`;
      } catch (e) {
        resolvedQrUrl = origOpts.qrUrl;
      }
    } else {
      resolvedQrUrl = origOpts.qrUrl;
    }
  }

  const hasLiveSessionTemplate = original.photo_session_id
    ? Boolean(db.prepare(`
        SELECT t.id FROM photo_sessions ps
        JOIN templates t ON ps.template_id = t.id
        WHERE ps.id = ?
      `).get(original.photo_session_id))
    : false;

  const newJob = createPrintJob(
    tenantId,
    original.event_id,
    original.device_id,
    original.photo_session_id,
    original.media_asset_id,
    finalCopies,
    {
      paperSize: extraOptions.paperSize || origOpts.paperSize || null,
      paperConfirmed: !!extraOptions.paperConfirmed,
      baseUrl: resolvedBaseUrl,
      qrUrl: resolvedQrUrl,
      qrPosition: hasLiveSessionTemplate ? null : (origOpts.qrPosition || null),
      qrCoords: hasLiveSessionTemplate ? null : (Array.isArray(origOpts.qrCoords) && origOpts.qrCoords.length > 0 ? origOpts.qrCoords : null),
      autoIssuePass: true,
      mediaType: origOpts.mediaType || null,
      borderless: origOpts.borderless,
      highDpi: origOpts.highDpi,
      safeMargin: origOpts.safeMargin
    }
  );

  db.prepare(`
    INSERT INTO audit_logs (id, tenant_id, user_id, actor_name, action, details_json)
    VALUES (?, ?, ?, 'Operator', 'reprint_job', ?)
  `).run(
    'audit_' + crypto.randomBytes(8).toString('hex'),
    tenantId,
    operatorId,
    JSON.stringify({ originalJobId: printJobId, newJobId: newJob.printJobId })
  );

  return newJob;
}

export function cancelPrintJob(printJobId, tenantId) {
  db.prepare("UPDATE print_jobs SET state = 'cancelled' WHERE id = ? AND tenant_id = ?").run(printJobId, tenantId);
  return { success: true };
}
