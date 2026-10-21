#!/bin/bash
# ============================================================
# INSTALLER OTOMATIS - GitHub Manager Bot (VPS Ubuntu/Debian/Docker)
# Support: systemd + fallback PM2 kalau systemctl gak ada
# ============================================================

set -e

REMOTE_URL=""
if [ "$1" = "--remote" ]; then
  REMOTE_URL="$2"
fi

APP_DIR="/opt/github-bot"

if [ -n "$REMOTE_URL" ]; then
  echo "📥 Mengunduh bot dari GitHub..."
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REMOTE_URL" "$APP_DIR"
fi

# ---- Minta token bot (visible) ----
if [ -z "$TG_TOKEN" ]; then
  echo ""
  echo "🔑 Token bot belum di-set"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if [ -e /dev/tty ]; then
    read -p "Masukkan token bot Telegram (dari @BotFather): " TG_TOKEN < /dev/tty
  else
    read -p "Masukkan token bot Telegram (dari @BotFather): " TG_TOKEN
  fi
fi

if [ -z "$TG_TOKEN" ]; then
  echo "❌ Token tidak boleh kosong!"
  exit 1
fi

echo "✅ Token diterima: ${TG_TOKEN:0:10}...${TG_TOKEN: -5}"

# ---- Cek & install git + Node.js 20 ----
if ! command -v git &>/dev/null; then
  echo "📦 Menginstall git..."
  apt-get update -y && apt-get install -y git || apk add git || yum install -y git
fi

if ! command -v node &>/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  echo "📦 Menginstall Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
  apt-get install -y nodejs || true
fi

if ! command -v node &>/dev/null; then
  echo "❌ Node.js gagal terinstall. Coba install manual."
  exit 1
fi

echo "✅ Node.js $(node -v)"

# ---- Install dependensi ----
echo "📦 Menginstall dependensi..."
cd "$APP_DIR"
npm install --omit=dev

SERVICE_NAME="github-bot"

# ---- Cek apakah ada systemd ----
if command -v systemctl &>/dev/null && [ -d /run/systemd/system ]; then
  echo "⚙️ Membuat service systemd..."
  cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=GitHub Manager Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=TG_TOKEN=${TG_TOKEN}
ExecStart=$(command -v node) ${APP_DIR}/index.js
Restart=always
RestartSec=5
User=$(logname 2>/dev/null || echo root)

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable ${SERVICE_NAME}
  systemctl restart ${SERVICE_NAME}

  sleep 2
  if systemctl is-active --quiet ${SERVICE_NAME}; then
    echo ""
    echo "=========================================="
    echo "✅ BOT BERHASIL DIJALANKAN (systemd)!"
    echo "  systemctl status ${SERVICE_NAME}"
    echo "  journalctl -u ${SERVICE_NAME} -f"
    echo "=========================================="
    exit 0
  fi
fi

# ---- Fallback: PM2 (untuk Docker / container tanpa systemd) ----
echo "⚠️ systemctl tidak ditemukan, pakai PM2..."

if ! command -v pm2 &>/dev/null; then
  echo "📦 Menginstall PM2..."
  npm install -g pm2
fi

# Stop bot lama jika ada
pm2 delete ${SERVICE_NAME} 2>/dev/null || true

cd "$APP_DIR"
TG_TOKEN="$TG_TOKEN" pm2 start index.js --name ${SERVICE_NAME}
pm2 save
pm2 startup 2>/dev/null || true

echo ""
echo "=========================================="
echo "✅ BOT BERHASIL DIJALANKAN (PM2)!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Bot tahan 24 jam (selama container hidup)"
echo ""
echo "Perintah berguna:"
echo "  pm2 status               ← cek status"
echo "  pm2 logs ${SERVICE_NAME}   ← lihat log live"
echo "  pm2 restart ${SERVICE_NAME}"
echo "  pm2 stop ${SERVICE_NAME}"
echo "=========================================="
