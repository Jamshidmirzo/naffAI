#!/usr/bin/env bash
# ==============================================================================
# create-operator-extension.sh <operator_phone>
#
# Создаёт SIP endpoint для оператора NaffCall Flutter app.
#   - username = последние 4 цифры телефона
#   - password = случайный 32-символьный
#   - секция [endpoint-<user>] в /etc/asterisk/pjsip.conf
#   - разрешено звонить только через from-internal (наш транк)
#
# Возвращает JSON на stdout:
#   {"username": "2062", "password": "...", "host": "sip.naff.flek.uz", "port": 5061, "transport": "tls"}
#
# Оператор получает эти креды через backend API (пишутся в Operator.sip_username/password).
# ==============================================================================

set -euo pipefail

PHONE="${1:-}"
[[ -n "${PHONE}" ]] || { echo "Usage: sudo $0 <operator_phone>  (e.g. +998901234567)"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Нужен sudo"; exit 1; }

: "${SIP_DOMAIN:=sip.naff.flek.uz}"
: "${SIP_PORT:=5061}"
: "${SIP_TRANSPORT:=tls}"

PJSIP=/etc/asterisk/pjsip.conf

# Нормализуем телефон: убираем всё кроме цифр
DIGITS=$(echo "${PHONE}" | tr -cd '0-9')
[[ ${#DIGITS} -ge 4 ]] || { echo "Плохой номер: ${PHONE}"; exit 1; }
USERNAME="${DIGITS: -4}"

# Если такой username уже существует — добавляем счётчик
BASE_USERNAME="${USERNAME}"
COUNTER=0
while grep -q "^\[endpoint-${USERNAME}\]" "${PJSIP}" 2>/dev/null; do
  COUNTER=$((COUNTER+1))
  USERNAME="${BASE_USERNAME}${COUNTER}"
done

PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)

# Backup
cp "${PJSIP}" "${PJSIP}.bak.$(date +%s)"

cat >> "${PJSIP}" <<EOF

; OPERATOR ${PHONE} BEGIN
[endpoint-${USERNAME}-auth]
type=auth
auth_type=userpass
username=${USERNAME}
password=${PASSWORD}

[endpoint-${USERNAME}-aor]
type=aor
max_contacts=2
remove_existing=yes
qualify_frequency=30

[endpoint-${USERNAME}]
type=endpoint
transport=transport-tls
context=from-internal
disallow=all
allow=opus
allow=alaw
allow=ulaw
auth=endpoint-${USERNAME}-auth
aors=endpoint-${USERNAME}-aor
direct_media=no
force_rport=yes
rewrite_contact=yes
rtp_symmetric=yes
send_pai=yes
media_encryption=sdes
dtls_verify=no
callerid="Operator ${PHONE}" <${USERNAME}>
; Разрешено только исходить наружу — inbound от Asterisk-а идёт от [from-internal]
; На уровне dialplan оператор не может звонить на другие endpoint'ы кроме транка

[endpoint-${USERNAME}-identify]
type=identify
endpoint=endpoint-${USERNAME}
username=${USERNAME}
; OPERATOR ${PHONE} END
EOF

# Reload
asterisk -rx "pjsip reload" >/dev/null 2>&1 || true

# JSON output (structured, для скриптов)
cat <<JSON
{"username": "${USERNAME}", "password": "${PASSWORD}", "host": "${SIP_DOMAIN}", "port": ${SIP_PORT}, "transport": "${SIP_TRANSPORT}", "phone": "${PHONE}"}
JSON
