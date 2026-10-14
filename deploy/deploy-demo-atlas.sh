#!/usr/bin/env bash
# Deploy branch feat/design-atlas to DEMO ONLY (demo.naff.flek.uz).
#   - frontend: build (default design v2) → /var/www/naff-demo
#   - backend:  rsync backend/ → /opt/naffAI-demo/backend, rebuild + restart demo-* services
#               (naffai-demo-web runs `migrate` on its own DB naffai_demo at start)
# PROD is never touched: no naffai-web, no /var/www/naff-v2, no prod DB, no compose/env edits.
#
# Usage (from the worktree root):  bash deploy/deploy-demo-atlas.sh [frontend|backend|all]
# Rollback: see ROLLBACK lines printed at the end.
set -euo pipefail

WHAT="${1:-all}"
HOST="ubuntu@63.186.179.240"
KEY="$HOME/.ssh/naffai-lightsail.pem"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== pre-flight (read-only)"
"${SSH[@]}" 'sudo docker ps --format "{{.Names}}" | grep -q "^naffai-demo-web-1$" && sudo grep -q "proxy_pass http://127.0.0.1:8001" /etc/nginx/sites-enabled/naff-demo && sudo grep -q "^POSTGRES_DB=naffai_demo" /opt/naffAI/.env.demo && echo "demo stack OK: own web (8001) + own DB naffai_demo"'

echo "== backups on server"
"${SSH[@]}" "set -e
sudo mkdir -p /opt/naffAI/backups
sudo tar czf /opt/naffAI/backups/naff-demo-backend-$TS.tgz -C /opt/naffAI-demo backend
sudo cp -a /var/www/naff-demo /var/www/naff-demo.bak-$TS
sudo docker exec naffai-db-1 sh -c 'pg_dump -U \"\$POSTGRES_USER\" -d naffai_demo --clean --if-exists' | gzip | sudo tee /opt/naffAI/backups/naffai_demo_pre_atlas_$TS.sql.gz >/dev/null
ls -la /opt/naffAI/backups | tail -3"

if [[ "$WHAT" == "backend" || "$WHAT" == "all" ]]; then
  echo "== backend → /opt/naffAI-demo/backend (no --delete; server-only files kept)"
  rsync -rlc --itemize-changes \
    --exclude '__pycache__' --exclude '.venv' --exclude '*.pyc' --exclude '.env*' --exclude 'media' \
    --exclude 'staticfiles' --exclude '.pytest_cache' --exclude '.ruff_cache' --exclude 'gsheets*.json' \
    -e "ssh -i $KEY -o BatchMode=yes" --rsync-path="sudo rsync" \
    "$ROOT/backend/" "$HOST:/opt/naffAI-demo/backend/" | grep -v '^\.d' | tail -20
  echo "== rebuild + restart demo services only"
  "${SSH[@]}" "set -e; cd /opt/naffAI
sudo docker compose -f docker-compose.prod.yml build demo-web
sudo docker compose -f docker-compose.prod.yml up -d --no-deps demo-web demo-apply-day-offs demo-attendance-auto-close demo-hot-leads-watch
sleep 25
sudo docker logs --tail 25 naffai-demo-web-1
sudo docker exec naffai-demo-web-1 python manage.py showmigrations notifications | tail -2"
fi

if [[ "$WHAT" == "frontend" || "$WHAT" == "all" ]]; then
  echo "== frontend build (default design v2)"
  (cd "$ROOT/frontend" && VITE_API_BASE_URL=/api VITE_DEFAULT_DESIGN=v2 npm run build)
  rsync -a --delete -e "ssh -i $KEY -o BatchMode=yes" "$ROOT/frontend/dist/" "$HOST:/tmp/naff-demo-new/"
  "${SSH[@]}" "sudo rsync -a --delete /tmp/naff-demo-new/ /var/www/naff-demo/ && sudo chown -R ubuntu:ubuntu /var/www/naff-demo && ls -la /var/www/naff-demo | head -4"
fi

echo "== smoke"
curl -s -o /dev/null -w "demo index: %{http_code}\n" https://demo.naff.flek.uz/
curl -s -o /dev/null -w "demo api floor (401 = endpoint exists, auth needed): %{http_code}\n" https://demo.naff.flek.uz/api/operators/floor/
curl -s -o /dev/null -w "prod index (must be unchanged): %{http_code}\n" https://naff.flek.uz/

echo "ROLLBACK frontend: ssh $HOST 'sudo rsync -a --delete /var/www/naff-demo.bak-$TS/ /var/www/naff-demo/'"
echo "ROLLBACK backend:  ssh $HOST 'cd /opt/naffAI-demo && sudo rm -rf backend && sudo tar xzf /opt/naffAI/backups/naff-demo-backend-$TS.tgz && cd /opt/naffAI && sudo docker compose -f docker-compose.prod.yml build demo-web && sudo docker compose -f docker-compose.prod.yml up -d --no-deps demo-web'"
echo "ROLLBACK demo DB:  gunzip -c /opt/naffAI/backups/naffai_demo_pre_atlas_$TS.sql.gz | sudo docker exec -i naffai-db-1 psql -U <user> -d naffai_demo"
