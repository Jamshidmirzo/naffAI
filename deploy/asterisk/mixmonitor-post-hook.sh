#!/usr/bin/env bash
# ==============================================================================
# mixmonitor-post-hook.sh <uniqueid>
#
# Вызывается Asterisk после Hangup (см. MixMonitor() в dialplan).
# Делает:
#   1. Находит .wav файл записи в /var/spool/asterisk/monitor/YYYY/MM/DD/
#   2. Конвертит в mp3 (16 kbps, mono — экономим место, речь всё ещё разборчива)
#   3. rsync .mp3 в наше медиа-хранилище на naff.flek.uz
#   4. POST в Django API: /api/calls/recording-attach/
#      {sip_call_id, duration_seconds, mp3_url}
#
# Env-переменные (задай в /etc/default/naffai-asterisk):
#   NAFF_API_BASE=https://naff.flek.uz
#   NAFF_API_TOKEN=xxx           # HMAC-ключ для аутентификации хука
#   NAFF_MEDIA_HOST=naff.flek.uz
#   NAFF_MEDIA_USER=ubuntu
#   NAFF_MEDIA_PATH=/var/www/naffai-media/call-recordings
#   NAFF_MEDIA_SSH_KEY=/etc/asterisk/keys/naff_media_deploy   # readonly rsync-ключ
# ==============================================================================

set -euo pipefail

# Загружаем env
[[ -f /etc/default/naffai-asterisk ]] && source /etc/default/naffai-asterisk

: "${NAFF_API_BASE:=https://naff.flek.uz}"
: "${NAFF_API_TOKEN:=changeme}"
: "${NAFF_MEDIA_HOST:=naff.flek.uz}"
: "${NAFF_MEDIA_USER:=ubuntu}"
: "${NAFF_MEDIA_PATH:=/var/www/naffai-media/call-recordings}"
: "${NAFF_MEDIA_SSH_KEY:=/etc/asterisk/keys/naff_media_deploy}"
: "${RECORDING_DIR:=/var/spool/asterisk/monitor}"

UNIQUEID="${1:-}"
[[ -n "${UNIQUEID}" ]] || { echo "Usage: $0 <uniqueid>"; exit 1; }

LOG_TAG="[mixmon-hook ${UNIQUEID}]"
log() { logger -t naffai-mixmon "${LOG_TAG} $*"; echo "${LOG_TAG} $*" >&2; }

# ------------------------------------------------------------------------------
# 1. Ищем wav-файл
# ------------------------------------------------------------------------------
WAV=$(find "${RECORDING_DIR}" -name "${UNIQUEID}.wav" -type f 2>/dev/null | head -1)
if [[ -z "${WAV}" || ! -f "${WAV}" ]]; then
  log "wav-файл не найден для ${UNIQUEID}"
  exit 0
fi
log "нашли wav: ${WAV}"

# Дата из пути (YYYY/MM/DD)
REL_PATH=$(realpath --relative-to="${RECORDING_DIR}" "${WAV}")
DATE_PART=$(dirname "${REL_PATH}")

# ------------------------------------------------------------------------------
# 2. Конверт в mp3 (16 kbps mono — 1 час звонка = ~7 MB)
# ------------------------------------------------------------------------------
MP3="${WAV%.wav}.mp3"
if [[ ! -f "${MP3}" ]]; then
  ffmpeg -y -loglevel error -i "${WAV}" -ac 1 -ar 16000 -b:a 16k "${MP3}"
  log "сконвертили в mp3: $(du -h "${MP3}" | cut -f1)"
fi

# Длительность в секундах (для API)
DURATION=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${MP3}" 2>/dev/null | awk '{printf "%d", $1}')
DURATION="${DURATION:-0}"

# ------------------------------------------------------------------------------
# 3. rsync на основной сервер
# ------------------------------------------------------------------------------
REMOTE_DIR="${NAFF_MEDIA_PATH}/${DATE_PART}"
REMOTE_FILE="${REMOTE_DIR}/${UNIQUEID}.mp3"

SSH_OPTS=(-i "${NAFF_MEDIA_SSH_KEY}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes)

# Создаём каталог на remote
ssh "${SSH_OPTS[@]}" "${NAFF_MEDIA_USER}@${NAFF_MEDIA_HOST}" "mkdir -p '${REMOTE_DIR}'" \
  || { log "SSH mkdir failed"; exit 1; }

rsync -e "ssh ${SSH_OPTS[*]}" -q "${MP3}" \
  "${NAFF_MEDIA_USER}@${NAFF_MEDIA_HOST}:${REMOTE_FILE}" \
  || { log "rsync failed"; exit 1; }

MP3_URL="https://${NAFF_MEDIA_HOST}/media/call-recordings/${DATE_PART}/${UNIQUEID}.mp3"
log "залито: ${MP3_URL}"

# ------------------------------------------------------------------------------
# 4. POST в Django
# ------------------------------------------------------------------------------
PAYLOAD=$(cat <<JSON
{"sip_call_id": "${UNIQUEID}", "duration_seconds": ${DURATION}, "mp3_url": "${MP3_URL}"}
JSON
)

curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Asterisk-Token: ${NAFF_API_TOKEN}" \
  -d "${PAYLOAD}" \
  "${NAFF_API_BASE}/api/calls/recording-attach/" \
  --max-time 15 \
  --retry 3 --retry-delay 5 \
  || { log "Django API notify failed"; exit 1; }

log "API notified, всё ок"

# Cleanup — оставляем wav ещё сутки на всякий случай (janitor уберёт)
