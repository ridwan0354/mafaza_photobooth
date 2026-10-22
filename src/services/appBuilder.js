import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const icnsPath = path.join(__dirname, '../../public/assets/icons/AppIcon.icns');

// Precompute CRC32 table for pure-JS ZIP archive creation
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Creates a standard ZIP archive Buffer in memory with Unix permissions support
 * so macOS .app bundles and .command scripts retain +x executable bit after unzipping.
 */
function createZipArchive(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawData = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content || ''), 'utf8');

    const crc = crc32(rawData);
    const compressed = zlib.deflateRawSync(rawData);
    const useDeflate = compressed.length < rawData.length;
    const dataBuf = useDeflate ? compressed : rawData;
    const method = useDeflate ? 8 : 0;

    // Local file header (30 bytes + filename)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4);         // version needed (2.0)
    lh.writeUInt16LE(0x0800, 6);     // UTF-8 filename flag
    lh.writeUInt16LE(method, 8);     // compression method
    lh.writeUInt16LE(0x4000, 10);    // mod time
    lh.writeUInt16LE(0x5554, 12);    // mod date
    lh.writeUInt32LE(crc, 14);       // crc32
    lh.writeUInt32LE(dataBuf.length, 18); // compressed size
    lh.writeUInt32LE(rawData.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26); // file name length
    lh.writeUInt16LE(0, 28);         // extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, dataBuf);

    // Central directory header (46 bytes + filename)
    const ch = Buffer.alloc(46 + nameBuf.length);
    const mode = entry.executable ? 0o100755 : 0o100644;
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix (3), v2.0
    ch.writeUInt16LE(20, 6);         // version needed
    ch.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0x4000, 12);
    ch.writeUInt16LE(0x5554, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(dataBuf.length, 20);
    ch.writeUInt32LE(rawData.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);         // extra len
    ch.writeUInt16LE(0, 32);         // comment len
    ch.writeUInt16LE(0, 34);         // disk number
    ch.writeUInt16LE(0, 36);         // internal attrs
    ch.writeUInt32LE((mode << 16) >>> 0, 38); // external attrs (Unix mode)
    ch.writeUInt32LE(offset, 42);    // relative offset of local header
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + dataBuf.length;
  }

  const centralSize = centralHeaders.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

export function getLanAddresses(port = 3000) {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ interface: name, ip: net.address, url: `http://${net.address}:${port}` });
      }
    }
  }
  return ips;
}

export async function getAppDownloadInfo(reqHost = 'localhost:3000', customServerUrl = null) {
  const port = (reqHost.split(':')[1]) || 3000;
  const lanList = getLanAddresses(port);
  const primaryLan = lanList[0]?.url || `http://${reqHost}`;
  const localUrl = `http://localhost:${port}`;
  const targetUrl = (customServerUrl && customServerUrl.trim()) ? customServerUrl.trim().replace(/\/$/, '') : primaryLan;

  const androidKioskUrl = `${targetUrl}/kiosk?app=android&fullscreen=1`;
  let androidQrDataUrl = '';
  try {
    androidQrDataUrl = await QRCode.toDataURL(androidKioskUrl, {
      width: 280,
      margin: 2,
      color: { dark: '#381E11', light: '#FFF8EF' }
    });
  } catch (e) {}

  return {
    localUrl,
    primaryLanUrl: primaryLan,
    lanAddresses: lanList,
    targetServerUrl: targetUrl,
    androidKioskUrl,
    androidQrDataUrl,
    downloads: {
      macos: `/api/apps/download/macos?serverUrl=${encodeURIComponent(targetUrl)}`,
      windows: `/api/apps/download/windows?serverUrl=${encodeURIComponent(targetUrl)}`,
      androidZip: `/api/apps/download/android?serverUrl=${encodeURIComponent(targetUrl)}`,
      androidHtml: `/api/apps/download/android-launcher?serverUrl=${encodeURIComponent(targetUrl)}`
    }
  };
}

export function getMacAppBundleSources(serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000') {
  const cleanServer = serverUrl.replace(/\/$/, '');
  const cleanLan = lanUrl.replace(/\/$/, '');

  const infoPlistKiosk = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>PhotoboothKiosk</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.studiokeren.photobooth.kiosk</string>
  <key>CFBundleName</key>
  <string>Photobooth Kiosk</string>
  <key>CFBundleDisplayName</key>
  <string>Photobooth Kiosk</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.5</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>`;

  const macKioskScript = `#!/bin/bash
# =====================================================================
# PHOTOBOOTH KIOSK FULL-SCREEN LAUNCHER (macOS / MacBook)
# =====================================================================
LOCAL_URL="http://localhost:3000"
LAN_URL="${cleanLan}"
TARGET_URL="${cleanServer}"

if curl -s --head --max-time 2 "$LOCAL_URL/kiosk" > /dev/null; then
  FINAL_URL="$LOCAL_URL/kiosk?app=macos&fullscreen=1"
elif curl -s --head --max-time 2 "$TARGET_URL/kiosk" > /dev/null; then
  FINAL_URL="$TARGET_URL/kiosk?app=macos&fullscreen=1"
else
  FINAL_URL="$LAN_URL/kiosk?app=macos&fullscreen=1"
fi

PROFILE_DIR="$HOME/Library/Application Support/PhotoboothKioskApp"
mkdir -p "$PROFILE_DIR"

if [ -d "/Applications/Google Chrome.app" ]; then
  open -n -a "/Applications/Google Chrome.app" --args \\
    --kiosk "$FINAL_URL" \\
    --start-fullscreen \\
    --kiosk-printing \\
    --user-data-dir="$PROFILE_DIR" \\
    --autoplay-policy=no-user-gesture-required \\
    --disable-pinch \\
    --overscroll-history-navigation=0 \\
    --no-first-run \\
    --no-default-browser-check
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -n -a "/Applications/Microsoft Edge.app" --args \\
    --kiosk "$FINAL_URL" \\
    --start-fullscreen \\
    --kiosk-printing \\
    --user-data-dir="$PROFILE_DIR" \\
    --autoplay-policy=no-user-gesture-required \\
    --no-first-run
elif [ -d "/Applications/Brave Browser.app" ]; then
  open -n -a "/Applications/Brave Browser.app" --args \\
    --kiosk "$FINAL_URL" \\
    --start-fullscreen \\
    --kiosk-printing \\
    --user-data-dir="$PROFILE_DIR"
else
  open -a Safari "$FINAL_URL"
  sleep 1.5
  osascript -e 'tell application "Safari" to activate' -e 'tell application "System Events" to keystroke "f" using {control down, command down}' 2>/dev/null
fi
`;

  const infoPlistAdmin = infoPlistKiosk
    .replace('PhotoboothKiosk', 'PhotoboothAdmin')
    .replace('com.studiokeren.photobooth.kiosk', 'com.studiokeren.photobooth.admin')
    .replace(/Photobooth Kiosk/g, 'Photobooth Admin');

  const macAdminScript = macKioskScript
    .replace(/\/kiosk\?app=macos&fullscreen=1/g, '/admin?app=macos')
    .replace(/\/kiosk/g, '/admin')
    .replace('PhotoboothKioskApp', 'PhotoboothAdminApp')
    .replace(/--kiosk "\$FINAL_URL"/g, '--app="$FINAL_URL"')
    .replace('--start-fullscreen \\\n    ', '');

  return { infoPlistKiosk, macKioskScript, infoPlistAdmin, macAdminScript };
}

export function writeAndSignMacAppBundle(baseDir, serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000') {
  if (os.platform() !== 'darwin') return;
  try {
    const { infoPlistKiosk, macKioskScript, infoPlistAdmin, macAdminScript } = getMacAppBundleSources(serverUrl, lanUrl);
    const hasIcns = fs.existsSync(icnsPath);

    const bundles = [
      { appName: 'Photobooth Kiosk.app', execName: 'PhotoboothKiosk', plist: infoPlistKiosk, script: macKioskScript },
      { appName: 'Photobooth Admin.app', execName: 'PhotoboothAdmin', plist: infoPlistAdmin, script: macAdminScript }
    ];

    fs.mkdirSync(baseDir, { recursive: true });
    for (const b of bundles) {
      const appPath = path.join(baseDir, b.appName);
      const macosDir = path.join(appPath, 'Contents', 'MacOS');
      const resDir = path.join(appPath, 'Contents', 'Resources');
      fs.mkdirSync(macosDir, { recursive: true });
      fs.mkdirSync(resDir, { recursive: true });

      fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), b.plist, 'utf8');
      const execPath = path.join(macosDir, b.execName);
      fs.writeFileSync(execPath, b.script, { encoding: 'utf8', mode: 0o755 });
      fs.chmodSync(execPath, 0o755);

      if (hasIcns) {
        fs.copyFileSync(icnsPath, path.join(resDir, 'AppIcon.icns'));
      }

      try {
        execSync(`xattr -cr "${appPath}" 2>/dev/null || true`, { stdio: 'ignore' });
        execSync(`xattr -d -r com.apple.quarantine "${appPath}" 2>/dev/null || true`, { stdio: 'ignore' });
        execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'ignore' });
        execSync(`xattr -d -r com.apple.quarantine "${appPath}" 2>/dev/null || true`, { stdio: 'ignore' });
      } catch (e) {}
    }
  } catch (e) {
    console.warn('writeAndSignMacAppBundle warning:', e.message);
  }
}

export function scheduleMacDownloadsUnquarantine(serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000') {
  if (os.platform() !== 'darwin') return;
  const home = os.homedir();
  const downloadsDir = path.join(home, 'Downloads');
  const extractedDir = path.join(downloadsDir, 'Photobooth-Kiosk-MacBook-macOS');
  const desktopDir = path.join(home, 'Desktop');
  const appsDir = '/Applications';

  // Immediately install/update signed & unquarantined apps in Downloads, Desktop, and /Applications
  try {
    if (fs.existsSync(extractedDir)) {
      writeAndSignMacAppBundle(extractedDir, serverUrl, lanUrl);
      execSync(`xattr -cr "${extractedDir}"`, { stdio: 'ignore' });
    }
    writeAndSignMacAppBundle(desktopDir, serverUrl, lanUrl);
    writeAndSignMacAppBundle(appsDir, serverUrl, lanUrl);
  } catch (e) {}

  // Poll for 25 seconds to strip com.apple.quarantine from newly downloaded ZIP or extracted folders in ~/Downloads
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    if (ticks > 25) {
      clearInterval(timer);
      return;
    }
    try {
      execSync(`xattr -cr "${downloadsDir}"/Photobooth* 2>/dev/null || true`, { stdio: 'ignore' });
      if (fs.existsSync(extractedDir)) {
        writeAndSignMacAppBundle(extractedDir, serverUrl, lanUrl);
      }
    } catch (e) {}
  }, 1000);
}

export function launchMacOsAppDirectly(serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000', mode = 'kiosk') {
  if (os.platform() !== 'darwin') {
    throw new Error('Fitur peluncur langsung macOS hanya tersedia jika server berjalan di MacBook.');
  }
  const home = os.homedir();
  const appsDir = '/Applications';
  const desktopDir = path.join(home, 'Desktop');
  const extractedDir = path.join(home, 'Downloads', 'Photobooth-Kiosk-MacBook-macOS');

  writeAndSignMacAppBundle(appsDir, serverUrl, lanUrl);
  writeAndSignMacAppBundle(desktopDir, serverUrl, lanUrl);
  if (fs.existsSync(extractedDir)) {
    writeAndSignMacAppBundle(extractedDir, serverUrl, lanUrl);
  }

  const targetApp = mode === 'admin'
    ? path.join(appsDir, 'Photobooth Admin.app')
    : path.join(appsDir, 'Photobooth Kiosk.app');

  execFile('open', [targetApp], () => {});
  return {
    success: true,
    installedPaths: [
      path.join(appsDir, 'Photobooth Kiosk.app'),
      path.join(desktopDir, 'Photobooth Kiosk.app')
    ]
  };
}

export function buildMacOsAppZip(serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000') {
  const { infoPlistKiosk, macKioskScript, infoPlistAdmin, macAdminScript } = getMacAppBundleSources(serverUrl, lanUrl);
  const htmlLauncher = buildAndroidStandaloneHtml(serverUrl, lanUrl)
    .replace('Android Full-Screen App', 'MacBook Full-Screen App')
    .replace('Tablet &amp; HP Android', 'MacBook / iMac (macOS)');

  const readmeMac = `======================================================================
APLIKASI PHOTOBOOTH KIOSK FULL-SCREEN — EDISI MACBOOK / macOS
======================================================================

Isi Paket Aplikasi:
1. Photobooth Kiosk.app             -> Aplikasi Utama Kiosk Booth (Langsung Full-Screen & Silent Print)
2. Photobooth Admin.app             -> Aplikasi Dashboard Admin & Operator
3. Buka-Photobooth-Kiosk-Mac.html   -> Peluncur Langsung Bebas Gatekeeper (Klik 2x langsung jalan)
4. Buka-Kiosk-FullScreen.command    -> Peluncur Cepat alternatif

CARA MENJALANKAN:
1. Klik 2x pada "Photobooth Kiosk.app" (sudah otomatis dipasang juga di Desktop & folder Applications Anda!).
2. Atau klik 2x pada "Buka-Photobooth-Kiosk-Mac.html" untuk langsung membuka Kiosk Full-Screen di browser.
======================================================================
`;

  // Schedule automatic Gatekeeper quarantine removal on local Mac
  scheduleMacDownloadsUnquarantine(serverUrl, lanUrl);

  const entries = [
    { name: 'Photobooth Kiosk.app/Contents/Info.plist', content: infoPlistKiosk, executable: false },
    { name: 'Photobooth Kiosk.app/Contents/MacOS/PhotoboothKiosk', content: macKioskScript, executable: true },
    { name: 'Photobooth Admin.app/Contents/Info.plist', content: infoPlistAdmin, executable: false },
    { name: 'Photobooth Admin.app/Contents/MacOS/PhotoboothAdmin', content: macAdminScript, executable: true },
    { name: 'Buka-Photobooth-Kiosk-Mac.html', content: htmlLauncher, executable: false },
    { name: 'Buka-Kiosk-FullScreen.command', content: macKioskScript, executable: true },
    { name: 'PANDUAN-MACBOOK.txt', content: readmeMac, executable: false }
  ];

  if (fs.existsSync(icnsPath)) {
    const icnsBuf = fs.readFileSync(icnsPath);
    entries.push({ name: 'Photobooth Kiosk.app/Contents/Resources/AppIcon.icns', content: icnsBuf, executable: false });
    entries.push({ name: 'Photobooth Admin.app/Contents/Resources/AppIcon.icns', content: icnsBuf, executable: false });
  }

  return createZipArchive(entries);
}

export function buildWindowsAppZip(serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000') {
  const cleanServer = serverUrl.replace(/\/$/, '');
  const cleanLan = lanUrl.replace(/\/$/, '');

  const winKioskBat = `@echo off
title Photobooth Kiosk Full-Screen Launcher (Windows 10/11)
set "LOCAL_URL=http://localhost:3000/kiosk?app=windows&fullscreen=1"
set "SERVER_URL=${cleanServer}/kiosk?app=windows&fullscreen=1"
set "LAN_URL=${cleanLan}/kiosk?app=windows&fullscreen=1"

:: Cek apakah server berjalan di localhost komputer ini, jika tidak gunakan IP Server LAN
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/kiosk' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  set "FINAL_URL=%LOCAL_URL%"
) else (
  set "FINAL_URL=%SERVER_URL%"
)

set "PROFILE_DIR=%LOCALAPPDATA%\\PhotoboothKioskApp"
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

:: 1. Cek Google Chrome
if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" (
  start "" "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" --app="%FINAL_URL%" --start-fullscreen --kiosk-printing --user-data-dir="%PROFILE_DIR%" --autoplay-policy=no-user-gesture-required --disable-pinch --overscroll-history-navigation=0 --no-first-run
  exit
)
if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" (
  start "" "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" --app="%FINAL_URL%" --start-fullscreen --kiosk-printing --user-data-dir="%PROFILE_DIR%" --autoplay-policy=no-user-gesture-required --disable-pinch --overscroll-history-navigation=0 --no-first-run
  exit
)
if exist "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" (
  start "" "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" --app="%FINAL_URL%" --start-fullscreen --kiosk-printing --user-data-dir="%PROFILE_DIR%" --autoplay-policy=no-user-gesture-required --disable-pinch --overscroll-history-navigation=0 --no-first-run
  exit
)

:: 2. Gunakan Microsoft Edge (Bawaan Windows 10 & Windows 11)
if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" (
  start "" "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" --app="%FINAL_URL%" --start-fullscreen --kiosk-printing --user-data-dir="%PROFILE_DIR%" --autoplay-policy=no-user-gesture-required --no-first-run
  exit
)
if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" (
  start "" "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" --app="%FINAL_URL%" --start-fullscreen --kiosk-printing --user-data-dir="%PROFILE_DIR%" --autoplay-policy=no-user-gesture-required --no-first-run
  exit
)

start msedge.exe --app="%FINAL_URL%" --start-fullscreen --kiosk-printing
exit
`.replace(/\n/g, '\r\n');

  const winAdminBat = winKioskBat
    .replace(/\/kiosk\?app=windows&fullscreen=1/g, '/admin?app=windows')
    .replace(/PhotoboothKioskApp/g, 'PhotoboothAdminApp');

  const winSilentVbs = `Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run chr(34) & currentDir & "\\Photobooth-Kiosk-FullScreen.bat" & chr(34), 0
Set WshShell = Nothing
`.replace(/\n/g, '\r\n');

  const winInstallShortcutBat = `@echo off
title Pembuat Shortcut Desktop Photobooth Kiosk (Windows)
echo Membuat Shortcut "Photobooth Kiosk (Full Screen)" dan "Photobooth Admin" di Desktop Anda...

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $desk = [Environment]::GetFolderPath('Desktop'); $s1 = $ws.CreateShortcut($desk + '\\Photobooth Kiosk (Full Screen).lnk'); $s1.TargetPath = 'wscript.exe'; $s1.Arguments = '\"' + '%~dp0Photobooth-Kiosk-Aplikasi.vbs' + '\"'; $s1.WorkingDirectory = '%~dp0'; $s1.IconLocation = 'shell32.dll,300'; $s1.Description = 'Buka Aplikasi Photobooth Kiosk Full Screen'; $s1.Save(); $s2 = $ws.CreateShortcut($desk + '\\Photobooth Admin Studio.lnk'); $s2.TargetPath = '%~dp0Photobooth-Admin-Studio.bat'; $s2.WorkingDirectory = '%~dp0'; $s2.IconLocation = 'shell32.dll,21'; $s2.Save();"

echo.
echo [BERHASIL] Shortcut "Photobooth Kiosk (Full Screen)" sudah muncul di layar Desktop Windows Anda!
pause
`.replace(/\n/g, '\r\n');

  const winPrintBridgePs1 = `# =====================================================================
# WINDOWS NATIVE PHOTO PRINT BRIDGE (.NET System.Drawing.Printing)
# =====================================================================
param(
  [Parameter(Mandatory=$true)][string]$FilePath,
  [string]$PrinterName = "",
  [int]$Copies = 1
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($FilePath)
$doc = New-Object System.Drawing.Printing.PrintDocument
if ($PrinterName -ne "") { $doc.PrinterSettings.PrinterName = $PrinterName }
$doc.PrinterSettings.Copies = $Copies
$doc.OriginAtMargins = $false
if ($img.Width -gt $img.Height) { $doc.DefaultPageSettings.Landscape = $true }
$doc.add_PrintPage({
  param($sender, $e)
  $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $bounds = $e.PageBounds
  $ratio = [Math]::Min($bounds.Width / $img.Width, $bounds.Height / $img.Height)
  $w = [int]($img.Width * $ratio)
  $h = [int]($img.Height * $ratio)
  $x = [int](($bounds.Width - $w) / 2)
  $y = [int](($bounds.Height - $h) / 2)
  $e.Graphics.DrawImage($img, $x, $y, $w, $h)
  $e.HasMorePages = $false
})
$doc.Print()
$img.Dispose()
Write-Output "PRINTED_OK"
`.replace(/\n/g, '\r\n');

  const readmeWin = `======================================================================
APLIKASI PHOTOBOOTH KIOSK FULL-SCREEN — EDISI WINDOWS 10 / 11
======================================================================

Isi Paket Aplikasi:
1. Photobooth-Kiosk-Aplikasi.vbs      -> Klik 2x untuk buka Kiosk Full-Screen (Tanpa jendela hitam CMD)
2. Photobooth-Kiosk-FullScreen.bat    -> Peluncur Kiosk Full-Screen + Silent Print (--kiosk-printing)
3. Photobooth-Admin-Studio.bat        -> Peluncur Dashboard Admin Studio
4. Pasang-Shortcut-di-Desktop.bat     -> Klik 2x untuk otomatis memasang ikon aplikasi di Desktop Windows
5. Print-Bridge-Windows.ps1           -> Modul cetak foto resolusi tinggi via Windows Print Spooler

CARA PAKAI DI WINDOWS:
1. Ekstrak (Unzip) seluruh isi folder ini ke komputer/laptop Windows Anda.
2. Klik 2x "Pasang-Shortcut-di-Desktop.bat" agar ikon "Photobooth Kiosk (Full Screen)"
   muncul di layar Desktop Windows Anda.
3. Setiap kali dibuka, aplikasi otomatis tampil FULL-SCREEN penuh tanpa address bar
   dan mengaktifkan fitur cetak langsung (--kiosk-printing) ke printer default Windows
   (Epson, Canon, DNP, HP, dll).
======================================================================
`.replace(/\n/g, '\r\n');

  return createZipArchive([
    { name: 'Photobooth-Kiosk-Aplikasi.vbs', content: winSilentVbs, executable: false },
    { name: 'Photobooth-Kiosk-FullScreen.bat', content: winKioskBat, executable: true },
    { name: 'Photobooth-Admin-Studio.bat', content: winAdminBat, executable: true },
    { name: 'Pasang-Shortcut-di-Desktop.bat', content: winInstallShortcutBat, executable: true },
    { name: 'Print-Bridge-Windows.ps1', content: winPrintBridgePs1, executable: false },
    { name: 'PANDUAN-WINDOWS.txt', content: readmeWin, executable: false }
  ]);
}

export function buildAndroidStandaloneHtml(serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000') {
  const cleanServer = serverUrl.replace(/\/$/, '');
  const cleanLan = lanUrl.replace(/\/$/, '');
  const defaultTarget = cleanServer.includes('localhost') ? cleanLan : cleanServer;

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#381E11">
  <title>Mafaza Kiosk — Android Full-Screen App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    html, body { width: 100%; height: 100%; background: #381E11; color: #FFF8EF; overflow: hidden; }
    .launcher-screen {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; padding: 24px; text-align: center;
    }
    .card {
      background: #FFF8EF; color: #381E11; border-radius: 28px; padding: 32px 28px;
      max-width: 480px; width: 100%; border: 4px solid #E6786B;
      box-shadow: 0 20px 50px rgba(0,0,0,0.45);
    }
    h1 { font-size: 26px; font-weight: 900; margin-bottom: 8px; color: #381E11; }
    p { font-size: 14px; color: #7B482E; margin-bottom: 20px; line-height: 1.5; }
    label { display: block; text-align: left; font-size: 12.5px; font-weight: 800; color: #7B482E; margin-bottom: 6px; }
    input {
      width: 100%; padding: 13px 16px; border-radius: 14px; border: 2px solid #EAD8C7;
      font-size: 15px; font-weight: 700; color: #381E11; background: #fff; margin-bottom: 18px;
    }
    .btn {
      display: block; width: 100%; padding: 16px; border-radius: 999px; border: none;
      background: #E6786B; color: #fff; font-size: 17px; font-weight: 900; cursor: pointer;
      box-shadow: 0 8px 20px rgba(230, 120, 107, 0.4); margin-bottom: 10px;
    }
    .btn-sec {
      background: #5F8F8A; box-shadow: 0 6px 16px rgba(95, 143, 138, 0.35); font-size: 14px; padding: 12px;
    }
    #kioskFrame {
      display: none; width: 100vw; height: 100vh; border: none; position: fixed; inset: 0; z-index: 999; background: #FFF8EF;
    }
  </style>
</head>
<body>
  <div class="launcher-screen" id="launcherScreen">
    <div class="card">
      <div style="font-size: 52px; margin-bottom: 10px;">📸</div>
      <h1>MAFAZA KIOSK</h1>
      <p>Setiap Momen Punya Cerita • By Galipat Story (Full-Screen Android App)</p>
      
      <label>Alamat Server Photobooth (Wi-Fi LAN):</label>
      <input type="url" id="serverUrlInput" value="${defaultTarget}" placeholder="Contoh: http://192.168.1.10:3000">
      
      <button class="btn" onclick="launchFullScreenKiosk()">🚀 BUKA KIOSK FULL-SCREEN SEKARANG</button>
      <button class="btn btn-sec" onclick="openDirectRedirect()">🔗 Buka Langsung di Chrome (Install WebAPK)</button>
      
      <div style="margin-top: 14px; font-size: 12px; color: #7B482E; background: rgba(95,143,138,0.12); padding: 10px 12px; border-radius: 12px; text-align: left;">
        💡 <strong>Tips Android Full-Screen &amp; Print:</strong><br>
        • Pastikan Tablet Android terhubung ke Wi-Fi yang sama dengan Laptop/PC Server.<br>
        • Saat tombol Print ditekan di Android, foto otomatis dicetak oleh Printer Server <strong>ATAU</strong> langsung melalui layanan cetak Android (Mopria / Wi-Fi Direct / Bluetooth).
      </div>
    </div>
  </div>

  <iframe id="kioskFrame" allow="camera; microphone; fullscreen; clipboard-write"></iframe>

  <script>
    const saved = localStorage.getItem('pb_android_server_url');
    if (saved) document.getElementById('serverUrlInput').value = saved;

    function getCleanUrl() {
      const val = (document.getElementById('serverUrlInput').value || '').trim().replace(/\\/$/, '');
      localStorage.setItem('pb_android_server_url', val);
      return val;
    }

    async function launchFullScreenKiosk() {
      const baseUrl = getCleanUrl();
      if (!baseUrl) return alert('Masukkan URL Server terlebih dahulu');
      try {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      } catch (e) {}

      const frame = document.getElementById('kioskFrame');
      frame.src = baseUrl + '/kiosk?app=android&fullscreen=1';
      frame.style.display = 'block';
      document.getElementById('launcherScreen').style.display = 'none';
    }

    function openDirectRedirect() {
      const baseUrl = getCleanUrl();
      if (!baseUrl) return alert('Masukkan URL Server terlebih dahulu');
      window.location.href = baseUrl + '/kiosk?app=android&fullscreen=1';
    }
  </script>
</body>
</html>`;
}

export function buildAndroidAppZip(serverUrl = 'http://localhost:3000', lanUrl = 'http://localhost:3000') {
  const htmlContent = buildAndroidStandaloneHtml(serverUrl, lanUrl);
  const cleanLan = lanUrl.replace(/\/$/, '');

  const readmeAndroid = `======================================================================
APLIKASI PHOTOBOOTH KIOSK FULL-SCREEN — EDISI ANDROID (TABLET & HP)
======================================================================

Tersedia 2 Cara Mudah Memasang Aplikasi Full-Screen di Android:

CARA 1: INSTALL 1-KLIK WEBAPK FULL-SCREEN (PALING DIREKOMENDASIKAN)
1. Hubungkan Tablet / HP Android ke jaringan Wi-Fi (atau Hotspot) yang sama dengan
   komputer/laptop Server Photobooth.
2. Buka Google Chrome di Android, lalu scan QR Code yang ada di menu
   "Download Aplikasi" pada halaman Admin (atau buka: ${cleanLan}/kiosk?app=android&fullscreen=1).
3. Ketuk tombol "📲 Install Aplikasi Full-Screen" atau menu titik tiga Chrome (⋮)
   -> pilih "Tambahkan ke Layar Utama / Install Aplikasi (Add to Home Screen)".
4. Ikon "Photobooth Kiosk" akan muncul di layar utama Android Anda dan ketika dibuka
   akan langsung tampil 100% FULL-SCREEN tanpa bar alamat browser!

CARA 2: MENGGUNAKAN FILE PELUNCUR "Photobooth-Kiosk-Android.html"
1. Simpan file "Photobooth-Kiosk-Android.html" di dalam penyimpanan Tablet/HP Android.
2. Buka file tersebut menggunakan Chrome di Android.
3. Ketuk "BUKA KIOSK FULL-SCREEN SEKARANG".

CARA KERJA FITUR PRINT DI ANDROID:
1. Cetak Otomatis via Server (USB/Wi-Fi Printer di Laptop/PC):
   Saat tamu menekan tombol "Cetak Foto" di layar Android, perintah cetak otomatis
   dikirim melalui Wi-Fi ke printer yang terhubung di komputer Server.
2. Cetak Langsung dari Android (Mopria / Printer Wi-Fi / Bluetooth / USB OTG):
   Gunakan tombol "Cetak via Perangkat Ini (Android Print)" untuk membuka layanan
   cetak bawaan Android (HP Print Service, Epson iPrint, Canon Print, atau RawBT).
======================================================================
`;

  return createZipArchive([
    { name: 'Photobooth-Kiosk-Android.html', content: htmlContent, executable: false },
    { name: 'PANDUAN-ANDROID.txt', content: readmeAndroid, executable: false }
  ]);
}

/**
 * Paket "Mafaza Print Agent" untuk komputer studio (Windows / macOS).
 * Sudah berisi alamat server & kunci rahasia, tinggal ekstrak lalu klik 2x.
 */
export function buildPrintAgentZip(targetOs = 'macos', serverUrl = 'http://localhost:3000', agentKey = '') {
  const agentScript = fs.readFileSync(path.join(__dirname, '../../print-agent/mafaza-print-agent.mjs'), 'utf8');
  const configJson = JSON.stringify({ server: serverUrl, key: agentKey, intervalMs: 2000 }, null, 2);

  if (targetOs === 'windows') {
    const startBat = `@echo off
chcp 65001 >nul
title Mafaza Print Agent
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Mencoba memasang otomatis lewat winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Setelah instalasi selesai, TUTUP jendela ini lalu klik 2x file ini lagi.
  echo Jika gagal, pasang manual dari https://nodejs.org lalu ulangi.
  pause
  exit /b
)

:loop
node mafaza-print-agent.mjs
echo.
echo Print Agent berhenti. Memulai ulang dalam 5 detik... (tutup jendela ini untuk keluar)
timeout /t 5 >nul
goto loop
`.replace(/\n/g, '\r\n');

    const autostartBat = `@echo off
chcp 65001 >nul
set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
set "VBS=%STARTUP%\\Mafaza-Print-Agent.vbs"
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS%"
echo WshShell.CurrentDirectory = "%~dp0" >> "%VBS%"
echo WshShell.Run """%~dp0Mafaza-Print-Agent.bat""", 7, False >> "%VBS%"
echo.
echo Berhasil! Print Agent akan otomatis menyala setiap Windows dinyalakan.
pause
`.replace(/\n/g, '\r\n');

    const readme = `MAFAZA PRINT AGENT - WINDOWS
==============================
Fungsi: mencetak OTOMATIS ke printer (Epson L8050, Canon, HP, dll) sesuai pengaturan
di menu Printer dashboard admin - TANPA dialog/popup. Cetak bisa dikirim dari
Windows, MacBook, Android maupun iPad.

CARA PAKAI
1. Ekstrak (unzip) folder ini di komputer Windows yang tersambung ke printer.
2. Klik 2x  Mafaza-Print-Agent.bat   (biarkan jendelanya terbuka / minimize).
3. (Opsional) Klik 2x  Pasang-Autostart-Windows.bat  agar menyala otomatis saat PC hidup.
4. Buka dashboard admin > menu Printer. Status akan berubah menjadi "Print Agent Online".

CATATAN
- Printer harus sudah terpasang (driver) di Windows dan jadi printer yang dipilih di menu Printer.
- Jenis kertas (glossy / matte) mengikuti pengaturan bawaan driver printer di Windows
  (Printer Preferences). Atur sekali ke "Photo Paper / Glossy" lalu simpan sebagai default.
`.replace(/\n/g, '\r\n');

    const configPrinterBat = `@echo off
chcp 65001 >nul
title Pengaturan Kertas Foto Epson 4R
echo Membuka jendela pengaturan printer Epson Anda...
start "" rundll32.exe printui.dll,PrintUIEntry /e /n "EPSON L8050 Series" 2>nul
start "" rundll32.exe printui.dll,PrintUIEntry /e /n "Epson L8050 Series" 2>nul
start "" rundll32.exe printui.dll,PrintUIEntry /e /n "EPSON L8050 Series (6-Color EcoTank Photo Printer)" 2>nul
control printers 2>nul
echo.
echo ========================================================
echo PETUNJUK PENGATURAN KERTAS FOTO 4R (102x152mm):
echo Di jendela Epson yang baru terbuka:
echo 1. Ukuran Dokumen: Pilih '10 x 15 cm (4 x 6 in)'
echo 2. Beri Tanda Centang: 'Tanpa Tepi (Borderless)'
echo 3. Tipe Kertas: Pilih 'Epson Premium Glossy' atau 'Ultra Glossy'
echo 4. Kualitas: Pilih 'Tinggi (High)'
echo 5. Klik 'Terapkan (Apply)' lalu 'OK'
echo ========================================================
pause
`.replace(/\n/g, '\r\n');

    return createZipArchive([
      { name: 'Mafaza-Print-Agent.bat', content: startBat, executable: true },
      { name: 'Atur-Kertas-Printer-Epson.bat', content: configPrinterBat, executable: true },
      { name: 'Pasang-Autostart-Windows.bat', content: autostartBat, executable: true },
      { name: 'mafaza-print-agent.mjs', content: agentScript, executable: false },
      { name: 'config.json', content: configJson, executable: false },
      { name: 'BACA-SAYA.txt', content: readme, executable: false }
    ]);
  }

  const startCommand = `#!/bin/bash
cd "$(dirname "$0")"
xattr -dr com.apple.quarantine . 2>/dev/null

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Node.js belum terpasang. Halaman unduhan akan dibuka. Pasang Node.js (LTS) lalu buka kembali aplikasi ini." buttons {"OK"} default button 1' >/dev/null 2>&1
  open "https://nodejs.org"
  exit 1
fi

while true; do
  node mafaza-print-agent.mjs
  echo ""
  echo "Print Agent berhenti. Memulai ulang dalam 5 detik... (tutup jendela ini untuk keluar)"
  sleep 5
done
`;

  const autostartCommand = `#!/bin/bash
cd "$(dirname "$0")"
DIR="$(pwd)"
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js belum terpasang. Pasang dari https://nodejs.org lalu ulangi."
  exit 1
fi
PLIST="$HOME/Library/LaunchAgents/com.mafaza.printagent.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mafaza.printagent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/mafaza-print-agent.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/mafaza-print-agent.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/mafaza-print-agent.log</string>
</dict>
</plist>
PLISTEOF
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"
echo ""
echo "Berhasil! Print Agent akan otomatis menyala di latar belakang setiap Mac dinyalakan."
echo "Log: ~/Library/Logs/mafaza-print-agent.log"
`;

  const readmeMac = `MAFAZA PRINT AGENT - MACBOOK / macOS
=====================================
Fungsi: mencetak OTOMATIS ke printer (Epson L8050, Canon, HP, dll) sesuai pengaturan
di menu Printer dashboard admin - TANPA dialog/popup. Cetak bisa dikirim dari
Windows, MacBook, Android maupun iPad.

CARA PAKAI
1. Ekstrak (unzip) folder ini di MacBook yang tersambung ke printer.
2. Klik kanan  Mafaza-Print-Agent.command  > Open (pertama kali saja). Biarkan jendela Terminal terbuka.
3. (Opsional) Buka  Pasang-Autostart-Mac.command  agar menyala otomatis di latar belakang.
4. Buka dashboard admin > menu Printer. Status akan berubah menjadi "Print Agent Online".

CATATAN
- Printer harus sudah terpasang di System Settings > Printers & Scanners.
- Butuh Node.js (LTS) dari https://nodejs.org
`;

  return createZipArchive([
    { name: 'Mafaza-Print-Agent.command', content: startCommand, executable: true },
    { name: 'Pasang-Autostart-Mac.command', content: autostartCommand, executable: true },
    { name: 'mafaza-print-agent.mjs', content: agentScript, executable: false },
    { name: 'config.json', content: configJson, executable: false },
    { name: 'BACA-SAYA.txt', content: readmeMac, executable: false }
  ]);
}
