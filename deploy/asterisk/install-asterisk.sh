#!/usr/bin/env bash
# ==============================================================================
# install-asterisk.sh
#
# Разворачивает Asterisk 20 LTS + FreePBX 17 на чистом Ubuntu 22.04.
# Идемпотентно: можно перезапускать — уже установленные шаги пропускаются.
#
# Использование:  sudo ./install-asterisk.sh
#
# После завершения:
#   - Asterisk работает как systemd-сервис (systemctl status asterisk)
#   - FreePBX web-интерфейс на http://<VPS_IP>/admin (первый вход = мастер)
#   - ufw файрвол включён, открыты SSH/HTTP/HTTPS/SIP-TLS/RTP
#   - fail2ban защищает SIP от брутфорса
#   - Let's Encrypt сертификат для домена SIP_DOMAIN (переменная окружения)
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# Переменные (можно переопределить через env)
# ------------------------------------------------------------------------------
: "${ASTERISK_VERSION:=20-current}"
: "${SIP_DOMAIN:=sip.naff.flek.uz}"
: "${LETSENCRYPT_EMAIL:=admin@naff.flek.uz}"
: "${ASTERISK_USER:=asterisk}"
: "${SRC_DIR:=/usr/src}"
: "${RTP_PORT_START:=10000}"
: "${RTP_PORT_END:=20000}"

log()  { echo -e "\033[1;34m[$(date +%H:%M:%S)]\033[0m $*"; }
ok()   { echo -e "\033[1;32m  ok\033[0m $*"; }
warn() { echo -e "\033[1;33m  ~~\033[0m $*"; }
die()  { echo -e "\033[1;31m  !!\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Запусти под sudo: sudo $0"

# ------------------------------------------------------------------------------
# 0. Проверка ОС
# ------------------------------------------------------------------------------
log "0. Проверка окружения"
if ! grep -q "Ubuntu 22" /etc/os-release; then
  warn "Скрипт заточен под Ubuntu 22.04. Продолжаем на свой риск."
fi
ok "OS = $(lsb_release -ds 2>/dev/null || echo unknown)"

# ------------------------------------------------------------------------------
# 1. apt update + зависимости
# ------------------------------------------------------------------------------
log "1. Обновление apt и установка зависимостей"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  build-essential wget curl git subversion pkg-config \
  libssl-dev libncurses5-dev libnewt-dev libxml2-dev \
  libsqlite3-dev uuid-dev libjansson-dev libedit-dev \
  libsrtp2-dev libpopt-dev libcurl4-openssl-dev \
  autoconf automake libtool bison flex \
  sox mpg123 lame ffmpeg rsync \
  ufw fail2ban expect \
  apache2 mariadb-server \
  php php-cli php-common php-curl php-mysql php-mbstring \
  php-xml php-zip php-gd php-intl \
  nodejs npm \
  certbot python3-certbot-apache \
  python3 python3-pip
ok "Зависимости установлены"

# ------------------------------------------------------------------------------
# 2. Скачивание и сборка Asterisk 20
# ------------------------------------------------------------------------------
log "2. Установка Asterisk ${ASTERISK_VERSION}"

if [[ -x /usr/sbin/asterisk ]]; then
  installed_ver=$(/usr/sbin/asterisk -V 2>/dev/null | awk '{print $2}')
  ok "Asterisk уже установлен: ${installed_ver} — пропускаем сборку"
else
  cd "${SRC_DIR}"
  if [[ ! -d asterisk-20 ]]; then
    log "  Скачиваем tarball…"
    wget -q "http://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_VERSION}.tar.gz" \
      -O asterisk.tar.gz
    tar xzf asterisk.tar.gz
    mv asterisk-20.* asterisk-20
  fi

  cd asterisk-20
  log "  contrib/scripts/install_prereq install"
  contrib/scripts/install_prereq install >/dev/null

  log "  ./configure"
  ./configure --with-jansson-bundled --with-pjproject-bundled >/dev/null

  log "  make menuselect (headless, defaults + chan_pjsip + format_mp3)"
  make menuselect.makeopts >/dev/null
  menuselect/menuselect --enable chan_pjsip menuselect.makeopts
  menuselect/menuselect --enable format_mp3 menuselect.makeopts
  menuselect/menuselect --enable res_srtp menuselect.makeopts

  log "  make -j$(nproc) (это долго ~10-15 минут)"
  make -j"$(nproc)" >/dev/null

  log "  make install / samples / config"
  make install >/dev/null
  make samples >/dev/null
  make config >/dev/null
  ldconfig
  ok "Asterisk собран и установлен"
fi

# ------------------------------------------------------------------------------
# 3. Пользователь asterisk + права
# ------------------------------------------------------------------------------
log "3. Пользователь ${ASTERISK_USER}"
if ! id -u "${ASTERISK_USER}" >/dev/null 2>&1; then
  useradd -m -d /var/lib/asterisk -s /bin/bash "${ASTERISK_USER}"
fi
usermod -aG audio,dialout "${ASTERISK_USER}"
chown -R "${ASTERISK_USER}:${ASTERISK_USER}" \
  /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /usr/lib/asterisk
ok "Права выставлены"

# ------------------------------------------------------------------------------
# 4. systemd unit
# ------------------------------------------------------------------------------
log "4. systemd unit"
cat >/etc/systemd/system/asterisk.service <<EOF
[Unit]
Description=Asterisk PBX
Documentation=https://wiki.asterisk.org
After=network.target mariadb.service
Wants=mariadb.service

[Service]
Type=simple
User=${ASTERISK_USER}
Group=${ASTERISK_USER}
ExecStart=/usr/sbin/asterisk -f -C /etc/asterisk/asterisk.conf
ExecReload=/usr/sbin/asterisk -rx 'core reload'
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
LimitNPROC=32768

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable asterisk
ok "asterisk.service зарегистрирован"

# ------------------------------------------------------------------------------
# 5. FreePBX 17 (опционально, если ещё не установлен)
# ------------------------------------------------------------------------------
log "5. FreePBX 17"
if [[ -d /var/www/html/admin ]]; then
  ok "FreePBX уже установлен — пропускаем"
else
  # Останавливаем asterisk на время установки FreePBX
  systemctl stop asterisk || true

  cd "${SRC_DIR}"
  if [[ ! -d freepbx ]]; then
    wget -q http://mirror.freepbx.org/modules/packages/freepbx/freepbx-17.0-latest.tgz
    tar xzf freepbx-17.0-latest.tgz
  fi

  cd freepbx
  # start_asterisk чтобы FreePBX увидел его
  systemctl start asterisk
  sleep 5

  # Автоматическая установка через --dbuser/--dbpass с authless local root
  ./start_asterisk stop || true
  ./install -n \
    --webroot=/var/www/html \
    --dbuser=root \
    --dbpass="" \
    --user="${ASTERISK_USER}" \
    --group="${ASTERISK_USER}" \
    || warn "FreePBX installer завершился с ошибкой — проверь /var/log/asterisk"

  # Apache права
  chown -R "${ASTERISK_USER}:${ASTERISK_USER}" /var/www/html
  a2enmod rewrite
  systemctl restart apache2
  ok "FreePBX установлен, web http://<IP>/admin"
fi

# ------------------------------------------------------------------------------
# 6. ufw firewall
# ------------------------------------------------------------------------------
log "6. ufw firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'FreePBX web'
ufw allow 443/tcp comment 'FreePBX SSL'
ufw allow 5061/tcp comment 'SIP TLS'
ufw allow 5060/udp comment 'SIP UDP (для транка если провайдер без TLS)'
ufw allow "${RTP_PORT_START}:${RTP_PORT_END}/udp" comment 'RTP media'
ufw --force enable
ok "ufw активен ($(ufw status | grep -c ALLOW) правил)"

# ------------------------------------------------------------------------------
# 7. fail2ban
# ------------------------------------------------------------------------------
log "7. fail2ban"
cat >/etc/fail2ban/jail.d/asterisk.conf <<'EOF'
[asterisk]
enabled  = true
filter   = asterisk
action   = iptables-allports[name=ASTERISK, protocol=all]
logpath  = /var/log/asterisk/messages
maxretry = 5
findtime = 600
bantime  = 3600
EOF

# Убеждаемся что log существует
mkdir -p /var/log/asterisk
touch /var/log/asterisk/messages
chown -R "${ASTERISK_USER}:${ASTERISK_USER}" /var/log/asterisk

systemctl enable fail2ban
systemctl restart fail2ban
ok "fail2ban: jail asterisk активен"

# ------------------------------------------------------------------------------
# 8. Let's Encrypt для SIP_DOMAIN
# ------------------------------------------------------------------------------
log "8. Let's Encrypt сертификат для ${SIP_DOMAIN}"
if [[ -f /etc/letsencrypt/live/${SIP_DOMAIN}/fullchain.pem ]]; then
  ok "Сертификат уже выпущен — пропускаем"
else
  if getent hosts "${SIP_DOMAIN}" >/dev/null; then
    certbot --apache -n --agree-tos --email "${LETSENCRYPT_EMAIL}" -d "${SIP_DOMAIN}" || \
      warn "certbot не смог выпустить сертификат — проверь что ${SIP_DOMAIN} резолвится на этот VPS"
  else
    warn "${SIP_DOMAIN} НЕ резолвится. Настрой DNS A-запись → IP VPS и перезапусти:"
    warn "  sudo certbot --apache -d ${SIP_DOMAIN}"
  fi
fi

# Копируем сертификат в Asterisk (он не читает /etc/letsencrypt по правам)
if [[ -f /etc/letsencrypt/live/${SIP_DOMAIN}/fullchain.pem ]]; then
  mkdir -p /etc/asterisk/keys
  cp /etc/letsencrypt/live/${SIP_DOMAIN}/fullchain.pem /etc/asterisk/keys/asterisk.crt
  cp /etc/letsencrypt/live/${SIP_DOMAIN}/privkey.pem   /etc/asterisk/keys/asterisk.key
  cat /etc/asterisk/keys/asterisk.crt /etc/asterisk/keys/asterisk.key > /etc/asterisk/keys/asterisk.pem
  chown -R "${ASTERISK_USER}:${ASTERISK_USER}" /etc/asterisk/keys
  chmod 600 /etc/asterisk/keys/*
  ok "Сертификат скопирован в /etc/asterisk/keys/"
fi

# Renewal hook — обновлять копии для asterisk
cat >/etc/letsencrypt/renewal-hooks/deploy/asterisk-copy.sh <<EOF
#!/bin/bash
set -e
cp /etc/letsencrypt/live/${SIP_DOMAIN}/fullchain.pem /etc/asterisk/keys/asterisk.crt
cp /etc/letsencrypt/live/${SIP_DOMAIN}/privkey.pem   /etc/asterisk/keys/asterisk.key
cat /etc/asterisk/keys/asterisk.crt /etc/asterisk/keys/asterisk.key > /etc/asterisk/keys/asterisk.pem
chown -R ${ASTERISK_USER}:${ASTERISK_USER} /etc/asterisk/keys
systemctl reload asterisk || true
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/asterisk-copy.sh

# ------------------------------------------------------------------------------
# 9. Каталоги для записей
# ------------------------------------------------------------------------------
log "9. Каталоги записей"
mkdir -p /var/spool/asterisk/monitor
mkdir -p /var/www/naffai-media/call-recordings
chown -R "${ASTERISK_USER}:${ASTERISK_USER}" /var/spool/asterisk /var/www/naffai-media
ok "Каталоги готовы"

# ------------------------------------------------------------------------------
# 10. Запуск
# ------------------------------------------------------------------------------
log "10. Запуск Asterisk"
systemctl restart asterisk
sleep 3
if systemctl is-active --quiet asterisk; then
  ok "Asterisk работает: $(/usr/sbin/asterisk -V)"
else
  die "Asterisk не поднялся. journalctl -u asterisk -n 50"
fi

echo
echo "========================================================================"
echo "  Установка завершена!"
echo "========================================================================"
echo "  FreePBX web:     http://$(curl -s ifconfig.me)/admin"
echo "  Asterisk CLI:    sudo asterisk -rvvv"
echo "  Логи:            journalctl -u asterisk -f"
echo "  SIP домен:       ${SIP_DOMAIN}"
echo
echo "  Следующие шаги:"
echo "    1. Заведи SIP-транк у провайдера (см. SIP_PROVIDERS_UZ.md)"
echo "    2. sudo ./configure-sip-trunk.sh sip_trunk.env"
echo "    3. Для каждого оператора: ./create-operator-extension.sh +998XXXXXXXXX"
echo "========================================================================"
