#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=========================================================="
echo "  MAFAZA PHOTOBOOTH - PEMASANG CANON USB BRIDGE (MACBOOK) "
echo "=========================================================="
echo ""

APP_DEST="$HOME/Library/Application Support/MafazaPhotobooth"
mkdir -p "$APP_DEST"

echo "[1/4] Menyalin CanonUSBBridge.app ke sistem..."
pkill -f "canon-usb-bridge" 2>/dev/null
rm -rf "$APP_DEST/CanonUSBBridge.app"
cp -R "$DIR/CanonUSBBridge.app" "$APP_DEST/"
chmod +x "$APP_DEST/CanonUSBBridge.app/Contents/MacOS/canon-usb-bridge"

echo "[2/4] Mengizinkan izin Local Network Chrome & Edge..."
defaults write com.google.Chrome LocalNetworkAccessAllowedForUrls -array-add "https://mafaza.galipatsistem.com" "http://localhost:3000" "http://127.0.0.1:3000" 2>/dev/null
defaults write com.microsoft.Edge LocalNetworkAccessAllowedForUrls -array-add "https://mafaza.galipatsistem.com" "http://localhost:3000" "http://127.0.0.1:3000" 2>/dev/null

echo "[3/4] Memasang Background Service (LaunchAgent)..."
PLIST="$HOME/Library/LaunchAgents/com.mafaza.canon-usb-bridge.plist"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mafaza.canon-usb-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_DEST/CanonUSBBridge.app/Contents/MacOS/canon-usb-bridge</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/canon-usb-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/canon-usb-bridge.log</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"
sleep 1

echo "[4/4] Memeriksa koneksi service..."
STATUS=$(curl -s http://127.0.0.1:19898/status)
echo "Status: $STATUS"
echo ""
echo "=========================================================="
echo "  ✅ BERHASIL TERPASANG!"
echo "  Canon USB Bridge aktif di latar belakang (port 19898)."
echo "  Colok kabel USB Canon EOS, nyalakan kamera,"
echo "  lalu buka Kiosk (/kiosk). Live View & Pengaturan ISO/Fokus"
echo "  akan langsung aktif otomatis!"
echo "=========================================================="
read -p "Tekan [Enter] untuk menutup..."
