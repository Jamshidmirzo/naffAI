#!/usr/bin/env bash
# ==============================================================================
# configure-sip-trunk.sh <provider_config.env>
#
# Подключает SIP-транк провайдера к Asterisk:
#   - генерирует секцию [trunk-<name>] в /etc/asterisk/pjsip.conf
#   - добавляет исходящий маршрут в /etc/asterisk/extensions.conf
#   - делает reload
#
# env-файл должен содержать:
#   SIP_TRUNK_PROVIDER=beeline_business
#   SIP_TRUNK_HOST=sip.beeline.uz
#   SIP_TRUNK_PORT=5060
#   SIP_TRUNK_USERNAME=xxx
#   SIP_TRUNK_PASSWORD=xxx
#   SIP_TRUNK_CALLER_ID=+998YY1234567
#   SIP_TRUNK_TRANSPORT=udp   # или tls
# ==============================================================================

set -euo pipefail

ENV_FILE="${1:-}"
[[ -n "${ENV_FILE}" && -f "${ENV_FILE}" ]] || {
  echo "Usage: sudo $0 <provider_config.env>"
  echo "Пример env-файла см. sip_trunk.env.example"
  exit 1
}

# shellcheck disable=SC1090
source "${ENV_FILE}"

: "${SIP_TRUNK_PROVIDER:?}"
: "${SIP_TRUNK_HOST:?}"
: "${SIP_TRUNK_USERNAME:?}"
: "${SIP_TRUNK_PASSWORD:?}"
: "${SIP_TRUNK_CALLER_ID:?}"
: "${SIP_TRUNK_PORT:=5060}"
: "${SIP_TRUNK_TRANSPORT:=udp}"

TRUNK_NAME="${SIP_TRUNK_PROVIDER}"
PJSIP=/etc/asterisk/pjsip.conf
EXTENSIONS=/etc/asterisk/extensions.conf
TEMPLATE_DIR="$(dirname "$0")/templates"

log() { echo -e "\033[1;34m[trunk]\033[0m $*"; }

[[ $EUID -eq 0 ]] || { echo "Нужен sudo"; exit 1; }

log "Конфигурируем транк: ${TRUNK_NAME} → ${SIP_TRUNK_HOST}:${SIP_TRUNK_PORT} (${SIP_TRUNK_TRANSPORT})"

# ------------------------------------------------------------------------------
# Backup
# ------------------------------------------------------------------------------
cp "${PJSIP}" "${PJSIP}.bak.$(date +%s)" 2>/dev/null || true
cp "${EXTENSIONS}" "${EXTENSIONS}.bak.$(date +%s)" 2>/dev/null || true

# ------------------------------------------------------------------------------
# pjsip.conf — базовый transport (idempotent)
# ------------------------------------------------------------------------------
if ! grep -q "^\[transport-udp\]" "${PJSIP}" 2>/dev/null; then
  log "  Добавляем transport секции"
  cat >> "${PJSIP}" <<EOF

; ===== Base transports =====
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0

[transport-tls]
type=transport
protocol=tls
bind=0.0.0.0:5061
cert_file=/etc/asterisk/keys/asterisk.pem
priv_key_file=/etc/asterisk/keys/asterisk.key
method=tlsv1_2
verify_client=no
verify_server=no
EOF
fi

# ------------------------------------------------------------------------------
# pjsip.conf — секция trunk (регенерируем)
# ------------------------------------------------------------------------------
# Удаляем старую секцию с таким же именем (idempotent replace)
python3 - "$PJSIP" "$TRUNK_NAME" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
name = sys.argv[2]
text = p.read_text()
# Убираем все секции связанные с этим trunk (маркер: ; TRUNK <name> BEGIN/END)
pattern = re.compile(
    rf"; TRUNK {re.escape(name)} BEGIN.*?; TRUNK {re.escape(name)} END\n",
    re.DOTALL,
)
new = pattern.sub("", text)
p.write_text(new)
PY

log "  Пишем секцию trunk-${TRUNK_NAME}"
cat >> "${PJSIP}" <<EOF

; TRUNK ${TRUNK_NAME} BEGIN
[trunk-${TRUNK_NAME}-auth]
type=auth
auth_type=userpass
username=${SIP_TRUNK_USERNAME}
password=${SIP_TRUNK_PASSWORD}

[trunk-${TRUNK_NAME}-aor]
type=aor
contact=sip:${SIP_TRUNK_HOST}:${SIP_TRUNK_PORT}
qualify_frequency=60

[trunk-${TRUNK_NAME}]
type=endpoint
transport=transport-${SIP_TRUNK_TRANSPORT}
context=from-trunk
disallow=all
allow=alaw
allow=ulaw
allow=opus
outbound_auth=trunk-${TRUNK_NAME}-auth
aors=trunk-${TRUNK_NAME}-aor
from_domain=${SIP_TRUNK_HOST}
from_user=${SIP_TRUNK_USERNAME}
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
send_pai=yes

[trunk-${TRUNK_NAME}-identify]
type=identify
endpoint=trunk-${TRUNK_NAME}
match=${SIP_TRUNK_HOST}

[trunk-${TRUNK_NAME}-registration]
type=registration
transport=transport-${SIP_TRUNK_TRANSPORT}
outbound_auth=trunk-${TRUNK_NAME}-auth
server_uri=sip:${SIP_TRUNK_HOST}:${SIP_TRUNK_PORT}
client_uri=sip:${SIP_TRUNK_USERNAME}@${SIP_TRUNK_HOST}
retry_interval=60
forbidden_retry_interval=600
expiration=3600
; TRUNK ${TRUNK_NAME} END
EOF

# ------------------------------------------------------------------------------
# extensions.conf — dialplan
# ------------------------------------------------------------------------------
if ! grep -q "^\[globals\]" "${EXTENSIONS}" 2>/dev/null; then
  cat >> "${EXTENSIONS}" <<EOF

[globals]
RECORDING_DIR=/var/spool/asterisk/monitor
POST_HOOK=/opt/naffAI/deploy/asterisk/mixmonitor-post-hook.sh

EOF
fi

# Секция для этого trunk (idempotent replace)
python3 - "$EXTENSIONS" "$TRUNK_NAME" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
name = sys.argv[2]
text = p.read_text()
pattern = re.compile(
    rf"; DIALPLAN {re.escape(name)} BEGIN.*?; DIALPLAN {re.escape(name)} END\n",
    re.DOTALL,
)
new = pattern.sub("", text)
p.write_text(new)
PY

cat >> "${EXTENSIONS}" <<EOF

; DIALPLAN ${TRUNK_NAME} BEGIN
[from-internal]
; Исходящие на +998XXXXXXXXX через транк ${TRUNK_NAME}
exten => _+998XXXXXXXXX,1,NoOp(Outbound to \${EXTEN} via ${TRUNK_NAME})
 same => n,Set(CALLERID(all)="${SIP_TRUNK_CALLER_ID}" <${SIP_TRUNK_CALLER_ID}>)
 same => n,Set(CDR(userfield)=\${UNIQUEID})
 same => n,MixMonitor(\${STRFTIME(\${EPOCH},,%Y/%m/%d)}/\${UNIQUEID}.wav,ab,${TEMPLATE_DIR}/../mixmonitor-post-hook.sh \${UNIQUEID})
 same => n,Dial(PJSIP/\${EXTEN}@trunk-${TRUNK_NAME},60,tT)
 same => n,Hangup()

; Также поддержка формата без плюса: 998XXXXXXXXX
exten => _998XXXXXXXXX,1,Goto(from-internal,+\${EXTEN},1)

[from-trunk]
; Входящие — пока просто hangup (Фаза 2 без inbound)
exten => _.,1,NoOp(Inbound from ${TRUNK_NAME}: \${EXTEN})
 same => n,Hangup()
; DIALPLAN ${TRUNK_NAME} END
EOF

# ------------------------------------------------------------------------------
# Reload
# ------------------------------------------------------------------------------
log "  asterisk -rx 'core reload'"
asterisk -rx "core reload" >/dev/null

log "  Проверяем регистрацию (жди ~10 сек)…"
sleep 10
if asterisk -rx "pjsip show registrations" | grep -q "Registered"; then
  echo -e "\033[1;32m  OK\033[0m транк ${TRUNK_NAME} зарегистрирован на ${SIP_TRUNK_HOST}"
else
  echo -e "\033[1;33m  ~~\033[0m транк пока не зарегистрирован. Проверь:"
  echo "     sudo asterisk -rx 'pjsip show registrations'"
  echo "     sudo asterisk -rx 'pjsip show endpoint trunk-${TRUNK_NAME}'"
  echo "     journalctl -u asterisk -n 100"
fi

echo
echo "Готово. Тест исходящего звонка (замени номер на свой мобильный):"
echo "  sudo asterisk -rx 'channel originate PJSIP/+998901234567@trunk-${TRUNK_NAME} extension +998901234567@from-internal'"
