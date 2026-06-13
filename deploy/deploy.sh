#!/usr/bin/env bash
# Run on the VPS (Ubuntu/Debian). Idempotent.
#   curl -fsSL https://raw.githubusercontent.com/Jamshidmirzo/naffAI/main/deploy/deploy.sh | bash
# Or after `git clone`: `bash deploy/deploy.sh`.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Jamshidmirzo/naffAI.git}"
TARGET="${TARGET:-/opt/naffAI}"
PUBLIC_IP="${PUBLIC_IP:-46.101.112.215}"
VERCEL_DOMAIN="${VERCEL_DOMAIN:-naff.vercel.app}"

echo "[deploy] installing prerequisites (docker, git)..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v git >/dev/null 2>&1; then
  apt-get update && apt-get install -y git
fi

echo "[deploy] cloning / updating repo at ${TARGET}..."
if [ ! -d "${TARGET}/.git" ]; then
  git clone "${REPO_URL}" "${TARGET}"
else
  git -C "${TARGET}" fetch --all --prune
  git -C "${TARGET}" reset --hard origin/main
fi

cd "${TARGET}"

if [ ! -f .env ]; then
  echo "[deploy] generating production .env..."
  SECRET=$(openssl rand -hex 32)
  DBPASS=$(openssl rand -hex 16)
  cat > .env <<EOF
DJANGO_SECRET_KEY=${SECRET}
DJANGO_DEBUG=0
DJANGO_ALLOWED_HOSTS=${PUBLIC_IP},localhost,127.0.0.1,web,${VERCEL_DOMAIN}
DJANGO_CSRF_TRUSTED_ORIGINS=https://${VERCEL_DOMAIN},http://${PUBLIC_IP}
DJANGO_TIME_ZONE=Asia/Tashkent
DJANGO_LANGUAGE_CODE=ru

POSTGRES_DB=naffai
POSTGRES_USER=naffai
POSTGRES_PASSWORD=${DBPASS}
POSTGRES_HOST=db
POSTGRES_PORT=5432

CORS_ALLOWED_ORIGINS=https://${VERCEL_DOMAIN}

DJANGO_SUPERUSER_USERNAME=dostik
DJANGO_SUPERUSER_PASSWORD=tostik
DJANGO_SUPERUSER_EMAIL=dostik@example.com

PAYROLL_DEFAULT_THRESHOLD_UZS=50000000
PAYROLL_DEFAULT_PAYOUT_TYPE=percent
PAYROLL_DEFAULT_PAYOUT_VALUE=3.0

IMEI_ONLINE_LOOKUP_ENABLED=0
IMEI_ONLINE_API_URL=
IMEI_ONLINE_API_KEY=

TELEGRAM_BOT_ENABLED=0
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_ID=
TELEGRAM_API_BASE=http://web:8000

VITE_API_BASE_URL=/api
EOF
  chmod 600 .env
fi

echo "[deploy] pulling images and starting stack..."
docker compose -f docker-compose.prod.yml pull || true
docker compose -f docker-compose.prod.yml up -d --build

echo "[deploy] waiting for web..."
for i in {1..30}; do
  if curl -fsS "http://localhost/api/docs/" >/dev/null 2>&1; then
    echo "[deploy] up: http://${PUBLIC_IP}/api/docs/"
    exit 0
  fi
  sleep 2
done
echo "[deploy] WARNING: web did not respond on /api/docs/ within 60s — check 'docker compose logs'"
exit 1
