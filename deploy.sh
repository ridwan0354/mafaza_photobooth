#!/usr/bin/env bash
# ==============================================================================
# SCRIPT DEPLOYMENT OTOMATIS: MAFAZA PHOTOBOOTH
# Domain : mafaza.galipatsistem.com
# Port   : 3005 (Terisolasi, aman & tidak bentrok port 3000)
# SSL    : Cloudflare Flexible
# ==============================================================================

set -e

DOMAIN="mafaza.galipatsistem.com"
APP_DIR="/var/www/mafaza_photobooth"
APP_PORT=3005
REPO_URL="https://github.com/ridwan0354/mafaza_photobooth.git"
PM2_NAME="mafaza-photobooth"

echo "=========================================================="
echo "🚀 MEMULAI DEPLOYMENT MAFAZA PHOTOBOOTH..."
echo "🌐 Domain       : $DOMAIN"
echo "⚙️  Port Internal: $APP_PORT"
echo "🔒 Mode SSL     : Cloudflare Flexible"
echo "📂 Lokasi App   : $APP_DIR"
echo "=========================================================="

# 1. Pastikan dijalankan sebagai root / sudo
if [ "$EUID" -ne 0 ]; then
  echo "❌ Mohon jalankan skrip ini dengan sudo / akses root:"
  echo "   curl -fsSL https://raw.githubusercontent.com/ridwan0354/mafaza_photobooth/main/deploy.sh | sudo bash"
  exit 1
fi

# 2. Cek & Pasang Git jika belum ada
if ! command -v git &> /dev/null; then
  echo "📦 Memasang Git..."
  apt-get update -y && apt-get install -y git
fi

# 3. Cek & Pasang Node.js (LTS v20) jika belum ada atau versi < 18
NODE_NEED_INSTALL=false
if ! command -v node &> /dev/null; then
  NODE_NEED_INSTALL=true
else
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -lt 18 ]; then
    NODE_NEED_INSTALL=true
  fi
fi

if [ "$NODE_NEED_INSTALL" = true ]; then
  echo "📦 Memasang Node.js v20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "✅ Node.js: $(node -v) | NPM: $(npm -v)"

# 4. Pasang PM2 jika belum ada
if ! command -v pm2 &> /dev/null; then
  echo "📦 Memasang PM2 process manager..."
  npm install -g pm2
fi

# 5. Clone atau Update Repository
if [ -d "$APP_DIR/.git" ]; then
  echo "🔄 Mengupdate aplikasi dari GitHub ($APP_DIR)..."
  cd "$APP_DIR"
  git reset --hard
  git pull origin main
else
  echo "📥 Mengkloning repositori ke $APP_DIR..."
  mkdir -p /var/www
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# 6. Install Dependency
echo "📦 Menginstall dependencies Node.js..."
npm install --omit=dev

# 7. Setup Environment Port
echo "PORT=$APP_PORT" > "$APP_DIR/.env"

# 8. Start / Restart Process via PM2
echo "⚡ Menjalankan server aplikasi via PM2..."
pm2 delete "$PM2_NAME" 2>/dev/null || true
PORT=$APP_PORT pm2 start src/server.js --name "$PM2_NAME"
pm2 save

sleep 2
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$APP_PORT/kiosk" || echo "000")
echo "🩺 Cek status internal port $APP_PORT: HTTP $HTTP_STATUS"
if [ "$HTTP_STATUS" != "200" ]; then
  echo "⚠️ Log aplikasi:"
  pm2 logs "$PM2_NAME" --lines 20 --nostream
fi

# 9. Konfigurasi Nginx Terisolasi (Aman untuk Cloudflare Flexible & Projek Lain)
echo "🌐 Menyiapkan konfigurasi Nginx untuk $DOMAIN..."
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"

cat > "$NGINX_CONF" << 'NGINX_EOF'
server {
    listen 80;
    listen [::]:80;
    server_name mafaza.galipatsistem.com;

    # Batas ukuran upload hingga 100MB (untuk foto & video sesi)
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
        proxy_cache_bypass $http_upgrade;

        proxy_read_timeout 300;
        proxy_connect_timeout 300;
    }
}
NGINX_EOF

# Aktifkan symlink Nginx jika belum ada
if [ ! -f "/etc/nginx/sites-enabled/$DOMAIN" ]; then
  ln -s "$NGINX_CONF" "/etc/nginx/sites-enabled/$DOMAIN"
fi

# 10. Validasi Sintaks Nginx Sebelum Reload (Perlindungan Projek Lain di VPS)
echo "🔍 Menguji konfigurasi Nginx..."
if nginx -t; then
  echo "✅ Sintaks Nginx valid! Me-reload Nginx..."
  systemctl reload nginx
  echo ""
  echo "=========================================================="
  echo "🎉 DEPLOYMENT SELESAI & BERJALAN DENGAN SUKSES!"
  echo "🌐 Website Kiosk  : https://mafaza.galipatsistem.com/kiosk"
  echo "📊 Dashboard Admin: https://mafaza.galipatsistem.com/admin"
  echo "📸 Galeri Utama   : https://mafaza.galipatsistem.com"
  echo "=========================================================="
else
  echo "⚠️ PERINGATAN: Sintaks Nginx mendeteksi isu. Nginx sengaja TIDAK direload agar projek lain tetap aman."
fi
