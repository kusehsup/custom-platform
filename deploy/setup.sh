#!/bin/bash
# Использование:
#   BOT_TOKEN=xxx PLATFORM_URL=yyy bash setup.sh
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[-]${NC} $1"; exit 1; }

[ -z "$BOT_TOKEN" ]    && err "Укажите BOT_TOKEN=..."
[ -z "$PLATFORM_URL" ] && err "Укажите PLATFORM_URL=..."

GITHUB_REPO="${GITHUB_REPO:-https://github.com/kusehsup/custom-platform.git}"
APP_DIR="/opt/custom-platform"
WEB_PORT=8002       # uvicorn порт
NGINX_PORT=8001     # nginx порт (публичный)
PROXY_URL="socks5://127.0.0.1:10808"
DOMAIN="code.kusehsup.ru"
EMAIL="vandeproject@gmail.com"

# ── 1. Пакеты ─────────────────────────────────────────────────────────
log "Обновление пакетов..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq -o Dpkg::Options::="--force-confold" \
    python3 python3-pip python3-venv git nginx curl wget unzip certbot python3-certbot-nginx

# ── 2. Python 3.11+ ───────────────────────────────────────────────────
PYTHON_BIN=python3
PY_MINOR=$($PYTHON_BIN -c "import sys; print(sys.version_info.minor)")
PY_MAJOR=$($PYTHON_BIN -c "import sys; print(sys.version_info.major)")
if [ "$PY_MAJOR" -lt 3 ] || [ "$PY_MINOR" -lt 11 ]; then
    log "Устанавливаем Python 3.12..."
    apt-get install -y -qq software-properties-common
    add-apt-repository -y ppa:deadsnakes/ppa
    apt-get update -qq
    apt-get install -y -qq python3.12 python3.12-venv python3.12-dev
    PYTHON_BIN=python3.12
fi
log "Python: $($PYTHON_BIN --version)"

# ── 3. Репозиторий ────────────────────────────────────────────────────
log "Получаем код..."
if [ -d "$APP_DIR/.git" ]; then
    warn "Директория уже есть — обновляем..."
    git -C "$APP_DIR" pull
else
    git clone "$GITHUB_REPO" "$APP_DIR"
fi
cd "$APP_DIR"

# ── 4. Зависимости ────────────────────────────────────────────────────
log "Устанавливаем Python зависимости..."
$PYTHON_BIN -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q \
    "fastapi" "uvicorn[standard]" \
    "python-jose[cryptography]" "passlib[bcrypt]" \
    "websockets" "python-dotenv" \
    "aiogram" "aiohttp" "aiohttp-socks" \
    "python-socks"

# ── 5. .env ───────────────────────────────────────────────────────────
log "Создаём .env..."
cat > "$APP_DIR/.env" <<EOF
BOT_TOKEN=${BOT_TOKEN}
PLATFORM_URL=${PLATFORM_URL}
PROXY_URL=${PROXY_URL}
EOF
chmod 600 "$APP_DIR/.env"

# ── 6. Xray ───────────────────────────────────────────────────────────
log "Устанавливаем xray-core..."
XRAY_VERSION="v1.8.11"
wget -q "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" -O /tmp/xray.zip
unzip -q -o /tmp/xray.zip -d /tmp/xray_bin
install -m 755 /tmp/xray_bin/xray /usr/local/bin/xray
rm -rf /tmp/xray.zip /tmp/xray_bin

mkdir -p /etc/xray
# Используем python3 чтобы избежать проблем с heredoc в разных окружениях
python3 -c "
import json
cfg = {
  'log': {'loglevel': 'warning'},
  'inbounds': [{'port': 10808, 'protocol': 'socks', 'settings': {'auth': 'noauth', 'udp': True}}],
  'outbounds': [{'protocol': 'vless', 'settings': {'vnext': [{'address': '185.200.178.3', 'port': 443, 'users': [{'id': 'cba60396-75e4-44e7-b2e1-2b96d2a33b36', 'encryption': 'none', 'flow': 'xtls-rprx-vision'}]}]}, 'streamSettings': {'network': 'tcp', 'security': 'reality', 'realitySettings': {'serverName': 'google.com', 'fingerprint': 'chrome', 'publicKey': 'QX5m1uZOv5QPX8dM3vnj5s9l2AK7FqRV8mFgr40s0WE', 'shortId': '', 'spiderX': '/'}}}]
}
open('/etc/xray/config.json','w').write(json.dumps(cfg, indent=2))
"

cat > /etc/systemd/system/xray.service <<'EOF'
[Unit]
Description=Xray Proxy
After=network.target

[Service]
ExecStart=/usr/local/bin/xray run -config /etc/xray/config.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ── 7. Systemd: веб ───────────────────────────────────────────────────
log "Создаём systemd сервисы..."
cat > /etc/systemd/system/custom-platform-web.service <<EOF
[Unit]
Description=CustomPlatform Web
After=network.target xray.service

[Service]
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${APP_DIR}/.venv/bin/uvicorn web.app:app --host 127.0.0.1 --port ${WEB_PORT} --workers 1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ── 8. Systemd: бот ───────────────────────────────────────────────────
cat > /etc/systemd/system/custom-platform-bot.service <<EOF
[Unit]
Description=CustomPlatform Telegram Bot
After=network.target xray.service

[Service]
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${APP_DIR}/.venv/bin/python -m bot.main
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ── 9. Nginx — HTTP (для certbot) ─────────────────────────────────────
log "Настраиваем nginx..."
cat > /etc/nginx/conf.d/custom-platform.conf <<EOF
server {
    listen ${NGINX_PORT};
    server_name ${DOMAIN};
    client_max_body_size 10M;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:${WEB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
    }
}
EOF

mkdir -p /var/www/html
nginx -t && systemctl reload nginx

# ── 10. SSL через Let's Encrypt ───────────────────────────────────────
log "Получаем SSL сертификат для ${DOMAIN}..."
certbot --nginx \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --non-interactive \
    --redirect \
    2>&1 | tail -5

# ── 11. Запуск сервисов ───────────────────────────────────────────────
log "Запускаем сервисы..."
systemctl daemon-reload
systemctl enable xray custom-platform-web custom-platform-bot
systemctl restart xray
sleep 3
systemctl restart custom-platform-web custom-platform-bot

# ── 12. Итог ──────────────────────────────────────────────────────────
echo ""
log "════════════════════════════════════════"
log "  Деплой завершён!"
log "════════════════════════════════════════"
systemctl is-active xray                && echo "  ✅ xray"     || echo "  ❌ xray"
systemctl is-active custom-platform-web && echo "  ✅ web"      || echo "  ❌ web"
systemctl is-active custom-platform-bot && echo "  ✅ bot"      || echo "  ❌ bot"
echo ""
echo "  🌐 https://${DOMAIN}"
echo ""
echo "Логи:"
echo "  journalctl -u custom-platform-web -f"
echo "  journalctl -u custom-platform-bot -f"
echo "  journalctl -u xray -f"
