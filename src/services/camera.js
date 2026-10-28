import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const captureDir = path.join(__dirname, '../../public/uploads/camera_captures');
if (!fs.existsSync(captureDir)) {
  fs.mkdirSync(captureDir, { recursive: true });
}

// Persistent camera settings file
const cameraConfigPath = path.join(__dirname, '../../camera-config.json');

const DEFAULT_CAMERA_CONFIG = {
  cameraMode: 'sony_canon_flash', // 'sony_canon_flash' | 'webcam_only'
  cameraBrand: 'sony_a7iii',      // 'sony_a7iii' | 'canon_eos' | 'nikon_dslr' | 'generic_uvc'
  triggerEngine: 'auto',          // 'auto' | 'sony_remote' | 'gphoto2' | 'digicamcontrol' | 'hotfolder'
  shutterKey: '1',                // '1' (AF+Shutter in Sony Remote), '2' (Shutter only), 'space'
  flashSyncDelayMs: 150,          // Wait ms before capturing frame if using HDMI capture card + flash
  watchFolders: [
    captureDir,
    path.join(os.homedir(), 'Pictures'),
    path.join(os.homedir(), 'Documents')
  ],
  preferredVideoDeviceId: '',
  preferredVideoLabel: 'Auto (Default Kamera / Capture Card)',
  uvcResolution: 'auto_canon',    // 'auto_canon' | '480p' | '720p' | '1080p'
  mirrorLiveView: true
};

export function getCameraConfig() {
  try {
    if (fs.existsSync(cameraConfigPath)) {
      const saved = JSON.parse(fs.readFileSync(cameraConfigPath, 'utf8'));
      return { ...DEFAULT_CAMERA_CONFIG, ...saved };
    }
  } catch (e) {}
  return { ...DEFAULT_CAMERA_CONFIG };
}

export function saveCameraConfig(newCfg) {
  const merged = { ...getCameraConfig(), ...newCfg };
  fs.writeFileSync(cameraConfigPath, JSON.stringify(merged, null, 2), 'utf8');

  // If on macOS and Sony Remote is installed, also sync SaveDir01 so Sony Remote saves directly into captureDir
  if (os.platform() === 'darwin') {
    exec(`defaults write com.sony.Remote "Setting/File/SaveDir01" "${captureDir}" 2>/dev/null || true`, () => {});
  }
  return merged;
}

/**
 * Scan connected USB cameras (Sony A7III, Canon EOS, Capture Cards) and installed Tethering Engines
 */
export async function getCameraSystemStatus() {
  const platform = os.platform();
  const config = getCameraConfig();
  const status = {
    platform,
    config,
    captureDir,
    sonyRemoteInstalled: false,
    sonyRemoteRunning: false,
    gphoto2Installed: false,
    digicamControlInstalled: false,
    eosUtilityInstalled: false,
    usbCamerasDetected: [],
    readyForHardwareFlash: false,
    recommendedSetupGuide: []
  };

  try {
    if (platform === 'darwin') {
      // 1. Check Sony Imaging Edge Remote on macOS
      const sonyRemotePath = '/Applications/Imaging Edge/Remote.app';
      status.sonyRemoteInstalled = fs.existsSync(sonyRemotePath);

      // Check if Remote is currently running
      try {
        const { stdout: psOut } = await execAsync('pgrep -x "Remote" || true');
        status.sonyRemoteRunning = Boolean(psOut && psOut.trim().length > 0);
      } catch (e) {}

      // Check Canon EOS Utility on macOS
      status.eosUtilityInstalled =
        fs.existsSync('/Applications/Canon Utilities/EOS Utility/EOS Utility.app') ||
        fs.existsSync('/Applications/EOS Utility/EOS Utility.app');

      // 2. Check gphoto2 on macOS
      for (const bin of ['/opt/homebrew/bin/gphoto2', '/usr/local/bin/gphoto2', 'gphoto2']) {
        try {
          const { stdout } = await execAsync(`which ${bin} 2>/dev/null || true`);
          if (stdout && stdout.trim() && !stdout.includes('not found')) {
            status.gphoto2Installed = true;
            status.gphoto2Bin = stdout.trim();
            break;
          }
        } catch (e) {}
      }

      // 3. Scan macOS USB & Camera devices for Sony / Canon / Capture Card
      try {
        const { stdout: camOut } = await execAsync('system_profiler SPCameraDataType SPUSBDataType 2>/dev/null | grep -iE "Sony|ILCE|A7|Canon|EOS|Nikon|Cam Link|Elgato|USB Video|FaceTime" || true');
        const lines = (camOut || '')
          .split('\n')
          .map(l => l.trim().replace(/:$/, ''))
          .filter(Boolean);
        status.usbCamerasDetected = [...new Set(lines)].slice(0, 8);
      } catch (e) {}

      status.readyForHardwareFlash = status.sonyRemoteInstalled || status.gphoto2Installed || status.eosUtilityInstalled;
    } else if (platform === 'win32') {
      const sonyWinPaths = [
        'C:\\Program Files\\Sony\\Imaging Edge Desktop\\Remote.exe',
        'C:\\Program Files (x86)\\Sony\\Imaging Edge\\Remote.exe'
      ];
      status.sonyRemoteInstalled = sonyWinPaths.some(p => fs.existsSync(p));

      const dccPaths = [
        'C:\\Program Files (x86)\\digiCamControl\\CameraControlCmd.exe',
        'C:\\Program Files\\digiCamControl\\CameraControlCmd.exe'
      ];
      const foundDcc = dccPaths.find(p => fs.existsSync(p));
      if (foundDcc) {
        status.digicamControlInstalled = true;
        status.dccBin = foundDcc;
      }

      status.readyForHardwareFlash = status.sonyRemoteInstalled || status.digicamControlInstalled;
    }
  } catch (err) {
    console.warn('getCameraSystemStatus warning:', err.message);
  }

  return status;
}

/**
 * Launch Sony Imaging Edge Remote (macOS / Windows) and set its output folder to captureDir
 */
export async function launchSonyRemoteApp() {
  const platform = os.platform();
  if (platform === 'darwin') {
    const appPath = '/Applications/Imaging Edge/Remote.app';
    if (!fs.existsSync(appPath)) {
      throw new Error('Aplikasi Sony Imaging Edge Remote (/Applications/Imaging Edge/Remote.app) tidak ditemukan di MacBook ini.');
    }
    // Set SaveDir01 to our captureDir so tethered photos land directly in our folder
    await execAsync(`defaults write com.sony.Remote "Setting/File/SaveDir01" "${captureDir}" 2>/dev/null || true`);
    await execAsync(`open -a "${appPath}"`);
    return {
      success: true,
      message: 'Sony Imaging Edge Remote berhasil dibuka! Pastikan kamera Sony A7III terhubung via kabel USB (PC Remote = ON) dan Flash/Trigger Godox terpasang di Hotshoe.'
    };
  } else if (platform === 'win32') {
    const winPath = 'C:\\Program Files\\Sony\\Imaging Edge Desktop\\Remote.exe';
    if (fs.existsSync(winPath)) {
      exec(`start "" "${winPath}"`);
      return {
        success: true,
        message: 'Sony Imaging Edge Remote berhasil dibuka di Windows!'
      };
    }
    throw new Error('Sony Imaging Edge Remote belum ditemukan di C:\\Program Files\\Sony\\Imaging Edge Desktop\\Remote.exe');
  }
  throw new Error('Platform tidak mendukung peluncuran otomatis Sony Remote.');
}

/**
 * Helper: Snapshot all existing JPG files and their mtimes across watched directories before triggering shutter
 */
function snapshotWatchedFiles(folders) {
  const map = new Map();
  for (const dir of folders) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        if (!/\.(jpg|jpeg)$/i.test(name)) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) map.set(full, st.mtimeMs);
        } catch (e) {}
      }
    } catch (e) {}
  }
  return map;
}

/**
 * Helper: Poll watched directories for any newly created or modified JPG file after shutter release
 */
async function waitForNewTetheredPhoto(folders, beforeMap, timeoutMs = 3600) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const dir of folders) {
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir);
        for (const name of entries) {
          if (!/\.(jpg|jpeg)$/i.test(name)) continue;
          if (name.startsWith('.')) continue;
          const full = path.join(dir, name);
          try {
            const st = fs.statSync(full);
            if (!st.isFile() || st.size < 15000) continue; // Ensure file finished writing (>15KB)
            const prevTime = beforeMap.get(full);
            if (prevTime === undefined || st.mtimeMs > prevTime + 50) {
              // Wait 120ms to ensure Sony Remote / EOS Utility finished flushing the JPEG to disk
              await new Promise(r => setTimeout(r, 120));
              const destName = `dslr_${Date.now()}_${ path.basename(full).replace(/[^a-zA-Z0-9._-]/g, '_') }`;
              const destFull = path.join(captureDir, destName);
              if (full !== destFull) {
                fs.copyFileSync(full, destFull);
              }
              return `/uploads/camera_captures/${destName}`;
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 130));
  }
  return null;
}

/**
 * Trigger physical camera shutter & Hotshoe Flash (Sony A7III / Canon EOS / Nikon)
 */
export async function triggerHardwareShutterAndFlash(options = {}) {
  const status = await getCameraSystemStatus();
  const cfg = status.config;
  const platform = status.platform;
  const watchFolders = Array.from(new Set([
    captureDir,
    ...(cfg.watchFolders || []),
    path.join(os.homedir(), 'Pictures'),
    path.join(os.homedir(), 'Documents')
  ]));

  const beforeSnapshot = snapshotWatchedFiles(watchFolders);

  // 1. Engine A: gphoto2 (macOS / Linux direct PTP USB Shutter + Flash)
  if (status.gphoto2Installed && (cfg.triggerEngine === 'auto' || cfg.triggerEngine === 'gphoto2')) {
    try {
      if (platform === 'darwin') {
        await execAsync('killall -9 PTPCamera ptpcamerad 2>/dev/null || true');
      }
      const filename = `gphoto_${Date.now()}.jpg`;
      const outPath = path.join(captureDir, filename);
      await execAsync(`"${status.gphoto2Bin}" --capture-image-and-download --filename "${outPath}" --force-overwrite`, { timeout: 6000 });
      if (fs.existsSync(outPath)) {
        return {
          success: true,
          flashTriggered: true,
          engine: 'gphoto2_usb_ptp',
          cameraBrand: cfg.cameraBrand,
          imageUrl: `/uploads/camera_captures/${filename}`,
          message: 'Shutter fisik & Flash Hotshoe berhasil ditembakkan via USB PTP (gphoto2)!'
        };
      }
    } catch (err) {
      console.warn('gphoto2 trigger fallback:', err.message);
    }
  }

  // 2. Engine B: digiCamControl CLI on Windows (Sony / Canon / Nikon USB Shutter + Flash)
  if (platform === 'win32' && status.digicamControlInstalled && (cfg.triggerEngine === 'auto' || cfg.triggerEngine === 'digicamcontrol')) {
    try {
      const filename = `dcc_${Date.now()}.jpg`;
      const outPath = path.join(captureDir, filename);
      await execAsync(`"${status.dccBin}" /filename "${outPath}" /capture`, { timeout: 6000 });
      if (fs.existsSync(outPath)) {
        return {
          success: true,
          flashTriggered: true,
          engine: 'digicamcontrol_usb',
          cameraBrand: cfg.cameraBrand,
          imageUrl: `/uploads/camera_captures/${filename}`,
          message: 'Shutter fisik & Flash Hotshoe berhasil ditembakkan via digiCamControl!'
        };
      }
    } catch (err) {
      console.warn('digiCamControl trigger fallback:', err.message);
    }
  }

  // 3. Engine C: Sony Imaging Edge Remote (macOS & Windows)
  // Sends Shutter Key ("1" or Space) to Sony Remote app -> Sony A7III fires mechanical shutter + Hotshoe Flash!
  if (status.sonyRemoteInstalled && (cfg.triggerEngine === 'auto' || cfg.triggerEngine === 'sony_remote')) {
    try {
      if (platform === 'darwin') {
        const keyToSend = cfg.shutterKey === '2' ? '2' : '1';
        // Trigger shutter in Sony Remote via AppleScript and return focus to browser
        const appleScript = `
          tell application "System Events"
            if exists (process "Remote") then
              set frontApp to name of first application process whose frontmost is true
              tell process "Remote"
                set frontmost to true
                delay 0.08
                keystroke "${keyToSend}"
              end tell
              delay 0.12
              tell process frontApp to set frontmost to true
              return "TRIGGERED"
            else
              return "NOT_RUNNING"
            end if
          end tell
        `;
        const { stdout } = await execAsync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { timeout: 4000 });
        if (stdout && stdout.trim().includes('TRIGGERED')) {
          const newPhotoUrl = await waitForNewTetheredPhoto(watchFolders, beforeSnapshot, options.timeoutMs || 3400);
          return {
            success: true,
            flashTriggered: true,
            engine: 'sony_imaging_edge_remote',
            cameraBrand: 'sony_a7iii',
            imageUrl: newPhotoUrl, // High-res JPEG from Sony A7III if downloaded, or null if using HDMI Live View
            message: newPhotoUrl
              ? '📸⚡ Shutter Sony A7III & Flash Hotshoe menyala! Foto Full-Frame berhasil ditarik via USB.'
              : '📸⚡ Sinyal Shutter & Flash dikirim ke Sony Imaging Edge Remote!'
          };
        }
      } else if (platform === 'win32') {
        const psScript = `
          $wshell = New-Object -ComObject wscript.shell;
          if ($wshell.AppActivate('Remote')) {
            Start-Sleep -Milliseconds 80;
            $wshell.SendKeys('1');
            Write-Output 'TRIGGERED';
          }
        `;
        const { stdout } = await execAsync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, { timeout: 4000 });
        if (stdout && stdout.includes('TRIGGERED')) {
          const newPhotoUrl = await waitForNewTetheredPhoto(watchFolders, beforeSnapshot, options.timeoutMs || 3400);
          return {
            success: true,
            flashTriggered: true,
            engine: 'sony_imaging_edge_remote_win',
            cameraBrand: 'sony_a7iii',
            imageUrl: newPhotoUrl,
            message: '📸⚡ Shutter Sony A7III & Flash Hotshoe berhasil ditembakkan!'
          };
        }
      }
    } catch (err) {
      console.warn('Sony Remote trigger warning:', err.message);
    }
  }

  // 4. Engine D: Sony Wi-Fi Direct API (Ctrl w/ Smartphone: 192.168.122.1)
  if (cfg.triggerEngine === 'auto' || cfg.triggerEngine === 'sony_wifi') {
    const sonyEndpoints = [
      'http://192.168.122.1:8080/sony/camera',
      'http://192.168.122.1:10000/sony/camera'
    ];
    for (const endpoint of sonyEndpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 450);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'actTakePicture', params: [], id: 1, version: '1.0' }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          const json = await res.json();
          const remotePicUrl = json?.result?.[0]?.[0];
          if (remotePicUrl) {
            const imgRes = await fetch(remotePicUrl);
            if (imgRes.ok) {
              const buf = Buffer.from(await imgRes.arrayBuffer());
              const filename = `sony_wifi_${Date.now()}.jpg`;
              const outPath = path.join(captureDir, filename);
              fs.writeFileSync(outPath, buf);
              return {
                success: true,
                flashTriggered: true,
                engine: 'sony_wifi_direct',
                cameraBrand: 'sony_a7iii',
                imageUrl: `/uploads/camera_captures/${filename}`,
                message: '📸⚡ Shutter Sony A7III & Flash Hotshoe menyala via Wi-Fi Direct!'
              };
            }
          }
        }
      } catch (e) {
        // Ignore if not connected to Sony Wi-Fi Direct AP
      }
    }
  }

  // 5. Engine E: Canon EOS Utility / Hot-Folder Check
  const hotPhotoUrl = await waitForNewTetheredPhoto(watchFolders, beforeSnapshot, 400);
  if (hotPhotoUrl) {
    return {
      success: true,
      flashTriggered: true,
      engine: 'hotfolder_tether',
      cameraBrand: cfg.cameraBrand,
      imageUrl: hotPhotoUrl,
      message: '📸⚡ Foto baru dari kamera DSLR/Mirrorless (Flash) terdeteksi di Hot-Folder!'
    };
  }

  return {
    success: false,
    flashTriggered: false,
    engine: 'webcam_fallback',
    cameraBrand: cfg.cameraBrand,
    imageUrl: null,
    message: status.sonyRemoteInstalled && !status.sonyRemoteRunning
      ? 'Aplikasi Sony Imaging Edge Remote belum dibuka. Buka aplikasi Remote & hubungkan USB Sony A7III agar Flash menyala.'
      : 'Kamera berjalan dalam mode Live Stream / Capture Card.'
  };
}
