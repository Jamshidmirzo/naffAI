#!/usr/bin/env bash
# Manual frontend deploy to Vercel prod.
# Run from laptop (needs Vercel CLI + logged-in account):
#   bash deploy/deploy-frontend.sh
# or: make deploy-frontend

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"
PROD_ALIAS="${PROD_ALIAS:-naffcrm.vercel.app}"

if ! command -v vercel >/dev/null 2>&1; then
  echo "[deploy-frontend] vercel CLI not found — install with: npm i -g vercel" >&2
  exit 1
fi

cd "${FRONTEND_DIR}"

echo "[deploy-frontend] deploying to Vercel prod..."
DEPLOY_URL="$(vercel --prod --yes 2>&1 | tee /dev/stderr | grep -oE 'https://naffcrm-[a-z0-9-]+\.vercel\.app' | head -1)"

if [ -z "${DEPLOY_URL}" ]; then
  echo "[deploy-frontend] FAILED to capture deployment URL" >&2
  exit 1
fi

echo "[deploy-frontend] deployment: ${DEPLOY_URL}"
echo "[deploy-frontend] aliasing -> ${PROD_ALIAS}"
vercel alias set "${DEPLOY_URL}" "${PROD_ALIAS}"

echo "[deploy-frontend] done. Verify: curl -I https://${PROD_ALIAS}/"
