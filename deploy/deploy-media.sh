#!/usr/bin/env bash
# Deploy the live-эфир media server (LiveKit + egress + redis) to the
# Lightsail instance `naffai-media`. The CRM host is not touched except for
# reading the LiveKit keys from its .env.
#
# Usage:  bash deploy/deploy-media.sh            # sync compose, (re)start, health
#         bash deploy/deploy-media.sh --dry-run  # show the rendered config only
#
# The instance has no static IP (account quota): its public IP changes only
# on stop/start. After that, re-run this script (it re-detects the IP) and
# nothing else — the CRM talks to it over the private IP.
set -euo pipefail

MEDIA="ubuntu@3.70.241.228"
CRM="ubuntu@63.186.179.240"
KEY="$HOME/.ssh/naffai-lightsail.pem"
DIR=/opt/naffai-media
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_M=(ssh -i "$KEY" -o BatchMode=yes "$MEDIA")
SSH_C=(ssh -i "$KEY" -o BatchMode=yes "$CRM")
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

echo "== compose → $MEDIA:$DIR"
scp -q -i "$KEY" "$ROOT/deploy/livekit/docker-compose.media.yml" "$MEDIA:/tmp/docker-compose.media.yml"
"${SSH_M[@]}" "sudo mkdir -p $DIR && sudo cp /tmp/docker-compose.media.yml $DIR/docker-compose.yml"

echo "== .env (keys from the CRM, public IP detected on the media host)"
"${SSH_C[@]}" "sudo grep -E '^LIVEKIT_API_(KEY|SECRET)=' /opt/naffAI/.env" | "${SSH_M[@]}" "set -e
IP=\$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '[:space:]')
[ -n \"\$IP\" ] || { echo 'cannot detect public IP'; exit 3; }
{ cat; echo \"MEDIA_PUBLIC_IP=\$IP\"; } | sudo tee $DIR/.env.new >/dev/null
sudo chmod 600 $DIR/.env.new && sudo mv $DIR/.env.new $DIR/.env
echo \"public IP \$IP\"
cd $DIR && sudo docker compose config -q && echo 'config ok'"

[[ $DRY_RUN == 1 ]] && { echo "dry-run: not started"; exit 0; }

echo "== up"
"${SSH_M[@]}" "set -e; cd $DIR
sudo docker compose pull -q
sudo docker compose up -d 2>&1 | grep -E 'Started|Recreated|Running|Error' || true
sleep 8
sudo docker compose ps --format '{{.Name}} {{.Status}}'
curl -s -m 5 http://127.0.0.1:7880/ && echo ' ← livekit'
sudo docker compose logs --since 1m livekit 2>&1 | grep -E 'starting LiveKit|rror' | cut -c1-200 | tail -3"

echo "== reachable from the CRM (private network)"
PRIV=$(aws lightsail get-instance --instance-name naffai-media --region eu-central-1 --query instance.privateIpAddress --output text 2>/dev/null || echo 172.26.5.12)
"${SSH_C[@]}" "curl -s -m 5 http://$PRIV:7880/ && echo ' ← from CRM via $PRIV'"
