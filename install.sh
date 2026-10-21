#!/bin/bash
# ============================================================
# INSTALLER OTOMATIS - GitHub Manager Bot (VPS Ubuntu/Debian)
# Jalankan: sudo bash install.sh
# ============================================================

set -e

# ---- Mode remote: download file dari GitHub jika dijalankan via curl ----
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

# ---- Minta token bot ----
if [ -z "$TG_TOKEN" ]; then
  read -p "Masukkan token bot Telegram (dari @BotFather): " TG_TOKEN
fi
if [ ! "$TG_TOKEN" ]; then
  echo "❌ Token tidak boleh kosong!"; exit 1
fi

SERVICE_NAME="github-bot"

# ---- Cek & install Node.js 20 ----
if ! command -v node &>/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  echo "📦 Menginstall Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "✅ Node.js $(node -v)"

# ---- Install dependensi ----
echo "📦 Menginstall dependensi..."
cd "$APP_DIR"
npm install --omit=dev

# ---- Buat service systemd ----
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
  echo "✅ BOT BERHASIL DIJALANKAN!"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Bot tahan 24 jam & auto-start saat reboot."
  echo ""
  echo "Perintah berguna:"
  echo "  systemctl status ${SERVICE_NAME}   ← cek status"
  echo "  journalctl -u ${SERVICE_NAME} -f   ← lihat log live"
  echo "  systemctl restart ${SERVICE_NAME}  ← restart"
  echo "  systemctl stop ${SERVICE_NAME}     ← matikan"
  echo "=========================================="
else
  echo "❌ Bot gagal start. Cek log: journalctl -u ${SERVICE_NAME} -n 20"
  exit 1
fi
