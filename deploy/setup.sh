#!/bin/bash
# Использование:
#   BOT_TOKEN=xxx PLATFORM_URL=yyy bash setup.sh
#
# Опциональные переменные (с дефолтами):
#   DOMAIN=code.kusehsup.ru
#   EMAIL=vandeproject@gmail.com
#   GITHUB_REPO=https://github.com/kusehsup/custom-platform.git
#   APP_DIR=/opt/custom-platform
#   NGINX_PORT=8001
#   WEB_PORT=8002
#
# Xray (vless) — задаётся ровно одним из способов:
#   XRAY_VLESS="vless://uuid@host:port?security=reality&pbk=...&sni=...&fp=chrome&flow=xtls-rprx-vision&type=tcp"
#   (формат строки как в v2RayNG / Streisand / Hiddify — paste-and-go)
# Если XRAY_VLESS пуст и /etc/xray/config.json не существует — шаг xray
# полностью пропускается (платформа поднимется, но WS к SA-MP-серверу
# не будет работать пока ты сам не положишь config.json и не сделаешь
# systemctl start xray).
#
# Скрипт идемпотентный — можно перезапускать без боязни сломать.
# certbot не валит весь скрипт если упал (например DNS не пропагирован).
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[-]${NC} $1"; exit 1; }

[ -z "$BOT_TOKEN" ]    && err "Укажите BOT_TOKEN=..."
[ -z "$PLATFORM_URL" ] && err "Укажите PLATFORM_URL=..."

GITHUB_REPO="${GITHUB_REPO:-https://github.com/kusehsup/custom-platform.git}"
APP_DIR="${APP_DIR:-/opt/custom-platform}"
WEB_PORT="${WEB_PORT:-8002}"        # uvicorn порт
NGINX_PORT="${NGINX_PORT:-8001}"    # nginx порт (публичный)
PROXY_URL="${PROXY_URL:-socks5://127.0.0.1:10808}"
DOMAIN="${DOMAIN:-code.kusehsup.ru}"
EMAIL="${EMAIL:-vandeproject@gmail.com}"

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
# Берём из requirements.txt в репе — единственный источник правды.
# Фоллбэк со списком пакетов на случай если файла нет (старый клон).
if [ -f "$APP_DIR/requirements.txt" ]; then
    .venv/bin/pip install -q -r "$APP_DIR/requirements.txt"
else
    warn "requirements.txt не найден — ставим минимальный набор"
    .venv/bin/pip install -q \
        "fastapi" "uvicorn[standard]" "python-multipart" \
        "python-jose[cryptography]" "passlib[bcrypt]" \
        "pyotp" "qrcode[pil]" \
        "websockets" "python-dotenv" \
        "pymysql" "cryptography" \
        "aiogram" "aiohttp" "aiohttp-socks" "python-socks"
fi

# ── 5. .env ───────────────────────────────────────────────────────────
log "Создаём .env..."
cat > "$APP_DIR/.env" <<EOF
BOT_TOKEN=${BOT_TOKEN}
PLATFORM_URL=${PLATFORM_URL}
PROXY_URL=${PROXY_URL}
EOF
chmod 600 "$APP_DIR/.env"

# ── 6. Xray ───────────────────────────────────────────────────────────
# Ставим бинарь всегда (он маленький, не повредит). Конфиг — только
# если есть XRAY_VLESS из env, либо уже существующий /etc/xray/config.json.
log "Устанавливаем xray-core..."
XRAY_VERSION="v1.8.11"
wget -q "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" -O /tmp/xray.zip
unzip -q -o /tmp/xray.zip -d /tmp/xray_bin
install -m 755 /tmp/xray_bin/xray /usr/local/bin/xray
rm -rf /tmp/xray.zip /tmp/xray_bin

mkdir -p /etc/xray

# Если конфиг уже есть — не трогаем (юзер мог отредактировать).
# Если нет — генерируем из XRAY_VLESS если она задана.
XRAY_READY=0
if [ -f /etc/xray/config.json ]; then
    warn "xray-конфиг уже существует — оставляем как есть"
    XRAY_READY=1
elif [ -n "${XRAY_VLESS:-}" ]; then
    log "Генерируем /etc/xray/config.json из XRAY_VLESS..."
    if XRAY_VLESS_INPUT="$XRAY_VLESS" python3 - <<'PY' ; then
import json
import os
import sys
from urllib.parse import urlparse, parse_qs, unquote

url = os.environ['XRAY_VLESS_INPUT'].strip()
if not url.startswith('vless://'):
    print('XRAY_VLESS не начинается с vless://', file=sys.stderr)
    sys.exit(2)

# urlparse режет fragment по '#' — нам label не нужен
parsed = urlparse(url)
uuid = parsed.username or ''
host = parsed.hostname or ''
port = parsed.port or 443
qs = parse_qs(parsed.query)

def q(key, default=''):
    v = qs.get(key, [default])
    return v[0] if v else default

security  = q('security', 'reality')
sni       = q('sni') or q('host') or ''
pbk       = q('pbk', '')
sid       = q('sid', '')
fp        = q('fp', 'chrome')
flow      = q('flow', '')
spx       = unquote(q('spx', '/'))
net       = q('type', 'tcp')

if not uuid or not host:
    print('vless:// без uuid или host', file=sys.stderr)
    sys.exit(2)

outbound = {
    'protocol': 'vless',
    'settings': {
        'vnext': [{
            'address': host,
            'port':    int(port),
            'users':   [{
                'id': uuid,
                'encryption': 'none',
                **({'flow': flow} if flow else {}),
            }],
        }],
    },
    'streamSettings': {
        'network':  net,
        'security': security,
    },
}

if security == 'reality':
    outbound['streamSettings']['realitySettings'] = {
        'serverName':  sni or 'google.com',
        'fingerprint': fp,
        'publicKey':   pbk,
        'shortId':     sid,
        'spiderX':     spx,
    }
elif security == 'tls':
    outbound['streamSettings']['tlsSettings'] = {
        'serverName': sni,
        'fingerprint': fp,
    }

cfg = {
    'log': {'loglevel': 'warning'},
    'inbounds': [{
        'port': 10808,
        'protocol': 'socks',
        'settings': {'auth': 'noauth', 'udp': True},
    }],
    'outbounds': [outbound],
}

with open('/etc/xray/config.json', 'w') as f:
    f.write(json.dumps(cfg, indent=2))
print('xray config written')
PY
        XRAY_READY=1
    else
        warn "Не удалось распарсить XRAY_VLESS — xray не настроен"
    fi
else
    warn "XRAY_VLESS не задан — xray не настроен."
    warn "Чтобы настроить позже: положи vless-конфиг в /etc/xray/config.json и сделай systemctl restart xray"
fi

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
# Не валим весь скрипт если certbot не справился (например DNS ещё
# не пропагирован). Будет работать по HTTP, юзер запустит certbot
# вручную позже.
log "Получаем SSL сертификат для ${DOMAIN}..."
if certbot --nginx \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --non-interactive \
    --redirect \
    2>&1 | tail -10; then
    log "SSL получен"
else
    warn "Certbot не справился (DNS не пропагирован? ratelimit?). Работаем по HTTP."
    warn "Когда DNS будет указывать на этот сервер — запусти:"
    warn "  certbot --nginx -d ${DOMAIN} --email ${EMAIL} --agree-tos --non-interactive --redirect"
fi

# ── 11. Запуск сервисов ───────────────────────────────────────────────
log "Запускаем сервисы..."
systemctl daemon-reload
systemctl enable custom-platform-web custom-platform-bot
if [ "$XRAY_READY" = "1" ]; then
    systemctl enable xray
    systemctl restart xray
    sleep 3
else
    systemctl stop xray 2>/dev/null || true
    warn "xray не настроен — не запускаем (см. сообщение выше)"
fi
systemctl restart custom-platform-web custom-platform-bot

# ── 12. Итог ──────────────────────────────────────────────────────────
echo ""
log "════════════════════════════════════════"
log "  Деплой завершён!"
log "════════════════════════════════════════"
if [ "$XRAY_READY" = "1" ]; then
    systemctl is-active xray    && echo "  ✅ xray"     || echo "  ❌ xray"
else
    echo "  ⏸  xray (не настроен — см. сообщения выше)"
fi
systemctl is-active custom-platform-web && echo "  ✅ web"      || echo "  ❌ web"
systemctl is-active custom-platform-bot && echo "  ✅ bot"      || echo "  ❌ bot"
echo ""
echo "  🌐 https://${DOMAIN}"
echo ""
echo "Логи:"
echo "  journalctl -u custom-platform-web -f"
echo "  journalctl -u custom-platform-bot -f"
echo "  journalctl -u xray -f"
