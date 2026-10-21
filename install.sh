#!/bin/bash
# ============================================================
# INSTALLER OTOMATIS - GitHub Manager Bot (VPS Ubuntu/Debian)
# Versi visible token: biar keliatan pas ngetik, gak hidden
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

# ---- Minta token bot (visible, biar tau kalo salah ketik) ----
if [ -z "$TG_TOKEN" ]; then
  echo ""
  echo "🔑 Token bot belum di-set"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  # Baca dari /dev/tty biar work walau pake curl | bash
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

echo "✅ Token diterima: ${TG_TOKEN:0:10}...${TG_TOKEN: -5} (disensor dikit)"

SERVICE_NAME="github-bot"

# ---- Cek & install git + Node.js 20 ----
if ! command -v git &>/dev/null; then
  echo "📦 Menginstall git..."
  apt-get update -y && apt-get install -y git
fi

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
  echo "  systemctl status ${SERVICE_NAME}"
  echo "  journalctl -u ${SERVICE_NAME} -f"
  echo "=========================================="
else
  echo "❌ Bot gagal start. Cek log: journalctl -u ${SERVICE_NAME} -n 20"
  exit 1
fi