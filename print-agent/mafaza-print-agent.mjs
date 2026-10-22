#!/usr/bin/env node
/**
 * MAFAZA PRINT AGENT
 * ---------------------------------------------------------------------------
 * Program kecil yang berjalan di komputer studio (Windows / macOS) yang terhubung
 * ke printer. Ia mengambil perintah cetak dari website Mafaza (VPS) lalu mencetak
 * LANGSUNG ke printer sesuai pengaturan di menu Printer (ukuran kertas, jenis kertas,
 * borderless, kualitas, jumlah lembar) TANPA dialog / popup.
 *
 * Perintah cetak bisa dikirim dari perangkat apa pun: Windows, MacBook, Android, iPad.
 *
 * Tanpa dependensi tambahan. Butuh Node.js 18+.
 *   node mafaza-print-agent.mjs
 * Mode uji tanpa kertas:  PB_DRY_RUN=1 node mafaza-print-agent.mjs
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (e) {}
  return {
    server: String(process.env.PB_SERVER || cfg.server || '').replace(/\/+$/, ''),
    key: process.env.PB_KEY || cfg.key || '',
    intervalMs: Number(process.env.PB_INTERVAL_MS || cfg.intervalMs || 2000)
  };
}

const CONFIG = loadConfig();
const DRY_RUN = process.env.PB_DRY_RUN === '1';
const PLATFORM = os.platform();

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString('id-ID')}]`, ...args);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
// Deteksi printer
// ---------------------------------------------------------------------------
async function listPrinters() {
  const printers = [];
  try {
    if (PLATFORM === 'win32') {
      const ps = 'Get-CimInstance Win32_Printer | Select-Object Name, DriverName, Default, WorkOffline | ConvertTo-Json -Compress';
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
      const parsed = JSON.parse(stdout);
      for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!p || !p.Name) continue;
        printers.push({
          id: p.Name,
          name: p.Name,
          driverName: p.DriverName || p.Name,
          status: p.WorkOffline ? 'offline' : 'idle',
          isDefault: !!p.Default
        });
      }
    } else {
      const { stdout } = await run('lpstat', ['-l', '-p', '-d'], { timeout: 8000 });
      let current = null;
      let defaultId = null;
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        const def = line.match(/(?:system default destination|tujuan default sistem):\s*(\S+)/i);
        if (def) defaultId = def[1];
        const m = line.match(/^printer\s+(\S+)/);
        if (m) {
          if (current) printers.push(current);
          current = {
            id: m[1],
            name: m[1].replace(/_/g, ' '),
            driverName: m[1],
            status: /disabled|dimatikan/i.test(line) ? 'offline' : 'idle',
            isDefault: false
          };
        } else if (current) {
          const d = trimmed.match(/^(?:Deskripsi|Description):\s*(.*)$/i);
          if (d && d[1]) current.name = d[1].trim();
        }
      }
      if (current) printers.push(current);
      for (const p of printers) if (p.id === defaultId) p.isDefault = true;

      // Laporkan jenis kertas asli dari driver agar muncul apa adanya di dashboard
      for (const p of printers) {
        try {
          const opts = await readLpOptions(p.id);
          if (opts.MediaType) {
            p.mediaTypes = opts.MediaType.choices.map((c) => ({ id: c.key, label: c.label, isDefault: c.isDefault }));
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    log('Peringatan: gagal membaca daftar printer:', e.message);
  }
  return printers;
}

function resolvePrinter(printers, options) {
  const wantedName = norm(options.printerName);
  const wantedDriver = norm(options.driverName);
  const online = printers.filter((p) => p.status !== 'offline');
  const pool = online.length ? online : printers;

  const exact = pool.find((p) => norm(p.id) === wantedDriver || norm(p.name) === wantedName);
  if (exact) return exact;
  const fuzzy = pool.find((p) => {
    const id = norm(p.id);
    const nm = norm(p.name);
    return (wantedDriver && (id.includes(wantedDriver) || wantedDriver.includes(id))) ||
      (wantedName && (nm.includes(wantedName) || wantedName.includes(nm)));
  });
  if (fuzzy) return fuzzy;
  return pool.find((p) => p.isDefault) || pool[0] || null;
}

// ---------------------------------------------------------------------------
// macOS / Linux (CUPS)
// Opsi driver berbeda tiap printer (Epson memakai kode seperti EPKG.NMgn / MediaType 13),
// jadi agent membaca opsi + label asli dari driver (PPD) lalu mencocokkan pengaturan Mafaza.
// ---------------------------------------------------------------------------
async function readLpOptions(queue) {
  // Hasil: { OptionKey: { label, choices: [{ key, label, isDefault }] } }
  const map = {};

  try {
    const { stdout } = await run('lpoptions', ['-p', queue, '-l'], { timeout: 8000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([^/:\s]+)(?:\/([^:]*))?:\s*(.*)$/);
      if (!m) continue;
      map[m[1]] = {
        label: (m[2] || m[1]).trim(),
        choices: m[3].trim().split(/\s+/).filter(Boolean).map((c) => ({
          key: c.replace(/^\*/, ''),
          label: c.replace(/^\*/, ''),
          isDefault: c.startsWith('*')
        }))
      };
    }
  } catch (e) {}

  // Label manusiawi dari file PPD (jika tersedia)
  try {
    const ppd = fs.readFileSync(`/etc/cups/ppd/${queue}.ppd`, 'utf8');
    for (const line of ppd.split('\n')) {
      const c = line.match(/^\*([A-Za-z0-9_]+)\s+([^/:\s]+)\/([^:]*):/);
      if (c && map[c[1]]) {
        const choice = map[c[1]].choices.find((x) => x.key === c[2]);
        if (choice) choice.label = c[3].trim();
      }
    }
  } catch (e) {}

  return map;
}

const BORDERLESS_RE = /borderless|nmgn|fullbleed|full\s*bleed|\.fb\b|no\s*margin|tanpa\s*tepi/i;
const EXCLUDED_PAGE_RE = /manucdr|disc|id\s*card|envelope|roll/i;

function pickPageSize(option, options) {
  if (!option) return null;
  const w = options.paperWidthIn;
  const h = options.paperHeightIn;
  const wi = Math.round(w);
  const hi = Math.round(h);

  const matchers = [
    new RegExp(`(^|[^0-9])${wi}\\s*x\\s*${hi}(?![0-9.])`, 'i'),
    new RegExp(`^w${Math.round(w * 72)}h${Math.round(h * 72)}`, 'i')
  ];
  if (wi === 4 && hi === 6) matchers.push(/10\s*x\s*15\s*cm|100\s*x\s*150\s*mm|102\s*x\s*152\s*mm|4r\b/i);
  if (wi === 5 && hi === 7) matchers.push(/13\s*x\s*18\s*cm|127\s*x\s*178\s*mm/i);
  if (options.paperSize === 'A4') matchers.push(/^a4(\.|$)/i, /\ba4\b/i);

  const candidates = option.choices.filter((c) => {
    const text = `${c.key} ${c.label}`;
    return !EXCLUDED_PAGE_RE.test(text) && matchers.some((re) => re.test(text));
  });
  if (!candidates.length) return null;
  const wantBorderless = !!options.borderless;
  const best = candidates.find((c) => BORDERLESS_RE.test(`${c.key} ${c.label}`) === wantBorderless) || candidates[0];
  return best.key;
}

// Cocokkan jenis kertas pengaturan (mis. "epson-premium-glossy") dengan pilihan driver (mis. MediaType 13 "Epson Premium Glossy")
function pickMediaType(option, wanted) {
  if (!option || !wanted) return null;
  const direct = option.choices.find((c) => norm(c.key) === norm(wanted) || norm(c.label) === norm(wanted));
  if (direct) return direct.key;

  const words = String(wanted).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !['paper', 'kertas', 'auto', 'any'].includes(w));
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const c of option.choices) {
    const text = `${c.key} ${c.label}`.toLowerCase();
    const score = words.filter((w) => text.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 1 ? best.key : null;
}

function findOptionByLabel(lpOpts, re) {
  return Object.entries(lpOpts).find(([key, o]) => re.test(key) || re.test(o.label)) || null;
}

async function printUnix(file, job, printer) {
  const o = job.options;
  const queue = printer.id;
  const lpOpts = await readLpOptions(queue);
  const args = ['-d', queue, '-n', String(job.copies || 1), '-o', 'fit-to-page'];
  const notes = [];

  // 1) Ukuran kertas (+ varian tanpa tepi / borderless)
  const pageOpt = lpOpts.PageSize || lpOpts.media || null;
  const pageSize = pickPageSize(pageOpt, o);
  if (pageSize) {
    args.push('-o', `PageSize=${pageSize}`);
    notes.push(`kertas=${pageSize}`);
  } else {
    args.push('-o', `media=Custom.${o.paperWidthIn}x${o.paperHeightIn}in`);
    notes.push(`kertas=Custom ${o.paperWidthIn}x${o.paperHeightIn}in`);
  }

  // 2) Jenis kertas (glossy / matte / dll)
  if (o.mediaType && !/^(auto|any)$/i.test(o.mediaType)) {
    const mt = pickMediaType(lpOpts.MediaType, o.mediaType);
    if (mt) {
      args.push('-o', `MediaType=${mt}`);
      if (lpOpts.EPIJ_Medi) args.push('-o', `EPIJ_Medi=${mt}`);
      notes.push(`jenis=${mt}`);
    }
  }

  // 3) Borderless:
  if (o.borderless) {
    if (lpOpts.EPIJ_Bdls) args.push('-o', 'EPIJ_Bdls=1');
    if (lpOpts.EPIJ_exmg) args.push('-o', 'EPIJ_exmg=2');
    const found = findOptionByLabel(lpOpts, /borderless|tanpa\s*tepi/i);
    if (found && found[0] !== 'EPIJ_Bdls') {
      const on = found[1].choices.find((c) => /^(true|on|yes|1)$/i.test(c.key) || /^on$/i.test(c.label));
      if (on) args.push('-o', `${found[0]}=${on.key}`);
    }
    notes.push('borderless=on');
  }

  // 4) Kualitas tinggi
  if (o.highDpi) {
    if (lpOpts.EPIJ_Qual) {
      args.push('-o', 'EPIJ_Qual=306');
      notes.push('kualitas=Tinggi (306)');
    } else {
      const found = findOptionByLabel(lpOpts, /print\s*quality|^quality$|qual$/i);
      if (found) {
        const best = found[1].choices.find((c) => /high\s*quality|highest|best|photo|tinggi/i.test(c.label));
        if (best) {
          args.push('-o', `${found[0]}=${best.key}`);
          notes.push(`kualitas=${best.label}`);
        }
      } else if (lpOpts.Resolution) {
        const dpi = lpOpts.Resolution.choices
          .map((c) => ({ c, n: parseInt(c.key, 10) || 0 }))
          .sort((x, y) => y.n - x.n)[0];
        if (dpi && dpi.n) args.push('-o', `Resolution=${dpi.c.key}`);
      }
    }
    args.push('-o', 'print-quality=5');
  }

  args.push(file);
  log(`   lp ${args.join(' ')}`);

  // Di macOS, buka Print Center di background agar icon printer di pojok kanan atas Menu Bar langsung muncul
  if (PLATFORM === 'darwin') {
    run('open', ['-g', '-a', '/System/Applications/Utilities/Print Center.app']).catch(() => {});
  }

  if (DRY_RUN) return { spoolerId: 'DRY-RUN', notes };

  const { stdout } = await run('lp', args);
  const m = stdout.match(/(?:request id is|id permintaan adalah)\s+(\S+)/i);
  return { spoolerId: m ? m[1] : null, notes };
}

// ---------------------------------------------------------------------------
// Windows (System.Drawing.Printing)
// ---------------------------------------------------------------------------
const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($env:PB_FILE)
try {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  if ($env:PB_PRINTER) { $doc.PrinterSettings.PrinterName = $env:PB_PRINTER }
  if (-not $doc.PrinterSettings.IsValid) { throw "Printer tidak ditemukan: $($env:PB_PRINTER)" }
  $doc.PrinterSettings.Copies = [int16]$env:PB_COPIES
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $doc.OriginAtMargins = $false
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)

  $wIn = [double]$env:PB_W_IN
  $hIn = [double]$env:PB_H_IN
  $borderless = ($env:PB_BORDERLESS -eq '1')

  $matchingPapers = @()
  foreach ($ps in $doc.PrinterSettings.PaperSizes) {
    $okNormal = ([math]::Abs($ps.Width - $wIn * 100) -le 18) -and ([math]::Abs($ps.Height - $hIn * 100) -le 18)
    $okSwap   = ([math]::Abs($ps.Width - $hIn * 100) -le 18) -and ([math]::Abs($ps.Height - $wIn * 100) -le 18)
    $okName   = ($ps.PaperName -match '4\s*x\s*6|10\s*x\s*15|102\s*x\s*152|4r\b')
    if ($okNormal -or $okSwap -or ($wIn -eq 4 -and $okName)) { $matchingPapers += $ps }
  }

  $paper = $null
  if ($borderless -and $matchingPapers.Count -gt 0) {
    foreach ($ps in $matchingPapers) {
      if ($ps.PaperName -match 'borderless|tanpa\s*tepi|no\s*margin|bleed|nmgn') {
        $paper = $ps
        break
      }
    }
  }
  if (-not $paper -and $matchingPapers.Count -gt 0) { $paper = $matchingPapers[0] }
  if (-not $paper) { $paper = New-Object System.Drawing.Printing.PaperSize('MafazaCustom', [int]($wIn * 100), [int]($hIn * 100)) }
  $doc.DefaultPageSettings.PaperSize = $paper

  if ($img.Width -gt $img.Height) { $doc.DefaultPageSettings.Landscape = $true }

  if ($env:PB_HIGH -eq '1') {
    try {
      foreach ($r in $doc.PrinterSettings.PrinterResolutions) {
        if ($r.Kind -eq [System.Drawing.Printing.PrinterResolutionKind]::High) { $doc.DefaultPageSettings.PrinterResolution = $r; break }
      }
    } catch {}
  }

  $doc.add_PrintPage({
    param($sender, $e)
    $g = $e.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $pw = [double]$e.PageBounds.Width
    $ph = [double]$e.PageBounds.Height
    $hmx = [double]$e.PageSettings.HardMarginX
    $hmy = [double]$e.PageSettings.HardMarginY

    $srcRect = New-Object System.Drawing.Rectangle(0, 0, $img.Width, $img.Height)
    if ($borderless) {
      $bleed = 1.01
      $ratio = [Math]::Max(($pw * $bleed) / $img.Width, ($ph * $bleed) / $img.Height)
      $w = $img.Width * $ratio
      $h = $img.Height * $ratio
      $x = (($pw - $w) / 2.0) - $hmx
      $y = (($ph - $h) / 2.0) - $hmy
      $destRect = New-Object System.Drawing.RectangleF([single]$x, [single]$y, [single]$w, [single]$h)
      $g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    } else {
      $ratio = [Math]::Min(($pw * 0.96) / $img.Width, ($ph * 0.96) / $img.Height)
      $w = $img.Width * $ratio
      $h = $img.Height * $ratio
      $x = ($pw - $w) / 2.0
      $y = (($ph - $h) / 2.0)
      $destRect = New-Object System.Drawing.RectangleF([single]$x, [single]$y, [single]$w, [single]$h)
      $g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    }
    $e.HasMorePages = $false
  })
  $doc.Print()
  Write-Output 'WIN_SPOOL_OK'
} finally {
  $img.Dispose()
}
`;

async function printWindows(file, job, printer) {
  const o = job.options;
  const scriptPath = path.join(os.tmpdir(), 'mafaza_print_win.ps1');
  fs.writeFileSync(scriptPath, '\ufeff' + WIN_SCRIPT, 'utf8');
  log(`   PowerShell print -> ${printer.name} | ${o.paperWidthIn}x${o.paperHeightIn}in | borderless=${o.borderless} | copies=${job.copies}`);
  if (DRY_RUN) return { spoolerId: 'DRY-RUN', notes: [] };

  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    timeout: 90000,
    env: {
      ...process.env,
      PB_FILE: file,
      PB_PRINTER: printer.name,
      PB_COPIES: String(job.copies || 1),
      PB_W_IN: String(o.paperWidthIn),
      PB_H_IN: String(o.paperHeightIn),
      PB_BORDERLESS: o.borderless ? '1' : '0',
      PB_HIGH: o.highDpi ? '1' : '0'
    }
  });
  if (!/WIN_SPOOL_OK/.test(stdout)) throw new Error('Windows spooler tidak mengonfirmasi cetak');
  return { spoolerId: null, notes: [] };
}

// ---------------------------------------------------------------------------
// Komunikasi dengan server
// ---------------------------------------------------------------------------
async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${CONFIG.server}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-agent-key': CONFIG.key },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) throw new Error('Kunci Print Agent ditolak server. Unduh ulang aplikasi dari menu Printer.');
  if (!res.ok) throw new Error(`Server membalas ${res.status}`);
  return res;
}

async function downloadSheet(job) {
  const res = await api(`/api/print-jobs/${job.id}/sheet`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (res.headers.get('content-type') || '').includes('svg') ? 'svg' : 'png';
  const file = path.join(os.tmpdir(), `mafaza_agent_${job.id}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

let printersCache = [];
let lastPrinterScan = 0;
let printersNeedSend = true;
let busy = false;
let lastError = '';

async function handleJob(job) {
  const o = job.options || {};
  log(`🖨️  Job ${job.id} | ${job.copies} lembar | kertas ${o.paperSize || '-'} | printer "${o.printerName || '-'}"`);
  let file = null;
  try {
    file = await downloadSheet(job);
    const printer = resolvePrinter(printersCache, o);
    if (!printer) throw new Error('Tidak ada printer terpasang di komputer ini');
    log(`   Printer terpilih: ${printer.name}`);

    const result = PLATFORM === 'win32'
      ? await printWindows(file, job, printer)
      : await printUnix(file, job, printer);

    await api(`/api/print-agent/jobs/${job.id}/result`, { method: 'POST', body: { ok: true, spoolerId: result.spoolerId } });
    log(`   ✅ Terkirim ke printer ${result.notes && result.notes.length ? '(' + result.notes.join(', ') + ')' : ''}`);
  } catch (err) {
    const detail = (err.stderr ? String(err.stderr).trim() + ' ' : '') + err.message;
    log(`   ❌ Gagal: ${detail}`);
    try {
      await api(`/api/print-agent/jobs/${job.id}/result`, { method: 'POST', body: { ok: false, error: detail } });
    } catch (e) {}
  } finally {
    if (file) fs.unlink(file, () => {});
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() - lastPrinterScan > 30000) {
      printersCache = await listPrinters();
      lastPrinterScan = Date.now();
      printersNeedSend = true;
    }
    const printersPayload = printersNeedSend ? printersCache : undefined;
    const res = await api('/api/print-agent/poll', {
      method: 'POST',
      body: { host: os.hostname(), platform: PLATFORM, printers: printersPayload }
    });
    if (printersPayload) printersNeedSend = false;
    if (lastError) {
      log('🟢 Terhubung kembali ke server.');
      lastError = '';
    }
    const { jobs } = await res.json();
    for (const job of jobs || []) await handleJob(job);
  } catch (err) {
    if (err.message !== lastError) {
      log(`⚠️  ${err.message}`);
      lastError = err.message;
    }
  } finally {
    busy = false;
  }
}

async function main() {
  if (!CONFIG.server || !CONFIG.key) {
    console.error('Konfigurasi belum lengkap. Isi config.json (server & key) atau unduh Print Agent dari menu Printer di dashboard admin.');
    process.exit(1);
  }
  console.log('==============================================================');
  console.log(' MAFAZA PRINT AGENT');
  console.log(` Server  : ${CONFIG.server}`);
  console.log(` Sistem  : ${PLATFORM} (${os.hostname()})${DRY_RUN ? '  [MODE UJI - TANPA CETAK]' : ''}`);
  console.log(' Biarkan jendela ini tetap terbuka agar cetak otomatis berjalan.');
  console.log('==============================================================');
  printersCache = await listPrinters();
  lastPrinterScan = Date.now();
  log(`Printer terdeteksi: ${printersCache.length ? printersCache.map((p) => p.name + (p.isDefault ? ' (default)' : '')).join(', ') : 'tidak ada'}`);

  await tick();
  setInterval(tick, Math.max(1000, CONFIG.intervalMs));
}

main();
