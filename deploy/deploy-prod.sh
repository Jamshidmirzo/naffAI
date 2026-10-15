#!/usr/bin/env bash
# Deploy PROD (naff.flek.uz) from origin/main — the only way to deploy prod.
#
# Rule: main == prod. The server must have no hand edits: if /opt/naffAI has
# changes in tracked files the script stops and lists them (commit them to
# main first). Everything else is automatic:
#   1. backup: pg_dump + current image tagged naffai-backend:rollback-<TS> + HEAD
#   2. /opt/naffAI → origin/main
#   3. one image build, ALL backend services (+ bot) recreated on it — never
#      again a web on new code and background services on old code
#   4. health check; if web does not come up → automatic rollback
#   5. live stack (profile `live`: livekit, livekit-redis, egress) brought
#      up when .env has LIVEKIT_API_KEY; recreated only if its config changed
# Frontend is NOT touched unless --frontend is given.
#
# Usage:  bash deploy/deploy-prod.sh            # backend
#         bash deploy/deploy-prod.sh --frontend # backend + frontend (dist → /var/www/naff-v2)
#         bash deploy/deploy-prod.sh --dry-run  # show what would be deployed, change nothing
set -euo pipefail

HOST="ubuntu@63.186.179.240"
KEY="$HOME/.ssh/naffai-lightsail.pem"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
APP=/opt/naffAI
COMPOSE="sudo docker compose -f docker-compose.prod.yml"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WITH_FRONTEND=0
DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --frontend) WITH_FRONTEND=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

echo "== what will be deployed"
git -C "$ROOT" fetch -q origin main
TARGET=$(git -C "$ROOT" rev-parse origin/main)
CURRENT=$("${SSH[@]}" "sudo git -C $APP rev-parse HEAD")
echo "server: $CURRENT"
echo "target: $TARGET (origin/main)"
if [[ "$CURRENT" == "$TARGET" ]]; then
  echo "server already on origin/main — will rebuild and restart anyway"
else
  git -C "$ROOT" log --oneline "$CURRENT..$TARGET" 2>/dev/null | head -30 || echo "(server commit not in local history)"
fi

echo "== server pre-flight"
"${SSH[@]}" "set -e; cd $APP
dirty=\$(sudo git status --porcelain --untracked-files=no)
if [ -n \"\$dirty\" ]; then
  echo 'STOP: hand edits on the server (commit them to main first, main == prod):'
  echo \"\$dirty\"
  exit 3
fi
echo 'server tree clean'"

[[ $DRY_RUN == 1 ]] && { echo "dry-run: nothing changed"; exit 0; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
echo "== backups ($TS)"
"${SSH[@]}" "set -e; cd $APP; sudo mkdir -p backups
$COMPOSE exec -T db pg_dump -U naffai -d naffai --clean --if-exists | gzip | sudo tee backups/naffai_predeploy_$TS.sql.gz >/dev/null
sudo docker tag naffai-backend:latest naffai-backend:rollback-$TS
sudo git rev-parse HEAD | sudo tee backups/head-predeploy-$TS.txt >/dev/null
ls -la backups/naffai_predeploy_$TS.sql.gz"

echo "== code → origin/main"
"${SSH[@]}" "set -e; cd $APP
sudo git fetch -q origin main
sudo git checkout -q -B main origin/main
sudo git log --oneline -1"

# Every service that runs the backend image (computed from compose, demo-* excluded).
SERVICES=$("${SSH[@]}" "cd $APP && $COMPOSE --profile bot config --format json" | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(" ".join(n for n, s in c["services"].items()
               if s.get("image") == "naffai-backend:latest" and not n.startswith("demo")))')
echo "services: $SERVICES"

rollback() {
  echo "!! web did not come up — rolling back to $CURRENT / rollback-$TS"
  "${SSH[@]}" "cd $APP
sudo docker tag naffai-backend:rollback-$TS naffai-backend:latest
sudo git checkout -q -B main $CURRENT
$COMPOSE --profile bot up -d --no-deps $SERVICES"
  exit 1
}

echo "== build once, recreate all backend services"
"${SSH[@]}" "set -e; cd $APP
$COMPOSE build web 2>&1 | tail -2
$COMPOSE --profile bot up -d --no-deps $SERVICES 2>&1 | grep -cE 'Started|Running' || true"

echo "== health"
ok=0
for _ in $(seq 1 40); do
  code=$("${SSH[@]}" "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8000/api/auth/login/ -H 'Content-Type: application/json' -d '{}'" || true)
  if [[ "$code" == "400" ]]; then ok=1; break; fi
  sleep 5
done
[[ $ok == 1 ]] || rollback
"${SSH[@]}" "set -e; cd $APP
NEW=\$(sudo docker images naffai-backend:latest --format '{{.ID}}')
bad=0
for c in \$(sudo docker ps --format '{{.Names}}' | grep -E '^naffai-' | grep -vE 'demo|db-1|redis-1|docker-proxy|livekit|egress'); do
  img=\$(sudo docker inspect -f '{{.Image}}' \$c | cut -c8-19)
  [ \"\$img\" = \"\$NEW\" ] || { echo \"OLD IMAGE: \$c\"; bad=1; }
done
echo \"all backend containers on \$NEW (mismatch=\$bad)\"
sudo docker logs --since 2m naffai-web-1 2>&1 | grep -E 'Applying|Traceback' | head -5 || true
# keep the last 3 rollback images
sudo docker images naffai-backend --format '{{.Tag}}' | grep '^rollback-' | sort -r | tail -n +4 | xargs -r -I{} sudo docker rmi naffai-backend:{} >/dev/null 2>&1 || true"

# Live stack (LiveKit + egress) — third-party images, not rebuilt; started
# when the server has LiveKit keys, recreated only when its config changed.
echo "== live stack"
"${SSH[@]}" "set -e; cd $APP
if ! sudo grep -qE '^LIVEKIT_API_KEY=.+' .env; then echo 'no LIVEKIT_API_KEY in .env — skipped'; exit 0; fi
FORCE=''
sudo git diff --quiet $CURRENT HEAD -- docker-compose.prod.yml deploy/livekit 2>/dev/null || FORCE=--force-recreate
$COMPOSE --profile live up -d \$FORCE livekit-redis livekit egress 2>&1 | grep -E 'Started|Recreated|Running|Error' || true
sudo docker ps --format '{{.Names}} {{.Status}}' | grep -E 'livekit|egress'"

if [[ $WITH_FRONTEND == 1 ]]; then
  echo "== frontend (main) → /var/www/naff-v2"
  (cd "$ROOT" && git diff --quiet HEAD origin/main -- frontend) || { echo "STOP: local checkout is not origin/main for frontend/"; exit 4; }
  (cd "$ROOT/frontend" && npm run build)
  rsync -a --delete -e "ssh -i $KEY -o BatchMode=yes" "$ROOT/frontend/dist/" "$HOST:/tmp/naff-prod-dist/"
  "${SSH[@]}" "sudo cp -a /var/www/naff-v2 /var/www/naff-v2.bak-$TS && sudo rsync -a --delete /tmp/naff-prod-dist/ /var/www/naff-v2/"
  echo "ROLLBACK frontend: ssh $HOST 'sudo rsync -a --delete /var/www/naff-v2.bak-$TS/ /var/www/naff-v2/'"
fi

curl -s -o /dev/null -w "public api: %{http_code}\n" -X POST https://naff.flek.uz/api/auth/login/ -H 'Content-Type: application/json' -d '{}'
echo "ROLLBACK backend: ssh $HOST 'cd $APP && sudo docker tag naffai-backend:rollback-$TS naffai-backend:latest && sudo git checkout -q -B main $CURRENT && $COMPOSE --profile bot up -d --no-deps $SERVICES'"
echo "ROLLBACK db:      gunzip -c $APP/backups/naffai_predeploy_$TS.sql.gz | sudo docker exec -i naffai-db-1 psql -U naffai -d naffai"
