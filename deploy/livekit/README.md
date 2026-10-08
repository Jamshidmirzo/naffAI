# LiveKit SFU — demo-only deployment notes

The `apps.livestream` feature uses a self-hosted LiveKit server + a
separate egress worker + coturn. All three services ship via
`docker-compose.prod.yml` with the `naffai-demo-*` prefix so prod stays
untouched.

Config files in this directory:

* `livekit.yaml` — SFU config. Keys / S3 creds come from env (see
  `.env.example` → `LIVEKIT_*` block). Only used by the
  `naffai-demo-livekit` container.
* `egress.yaml` — Egress-worker config. Reuses the same keys. S3
  destination is wired via env too.
* `coturn.conf` — TURN server config for operators behind symmetric NAT
  (common for office networks). Shared secret with LiveKit via env.

## Ports used

| Port       | Proto | Service       | Purpose                                  |
|------------|-------|---------------|------------------------------------------|
| 7880       | TCP   | livekit       | HTTP signaling (nginx proxies as `/livekit/`) |
| 7881       | TCP   | livekit       | RTC/TCP fallback for clients             |
| 7882       | UDP   | livekit       | WebRTC/UDP primary (direct, no TURN)     |
| 3478       | UDP   | coturn        | TURN control                             |
| 5349       | TCP   | coturn        | TURN over TLS (optional)                 |
| 49160-49200| UDP   | livekit       | RTC media (range; small on purpose)      |
| 50000-50200| UDP   | coturn        | TURN relay range                         |

Open these on the Lightsail firewall for the demo host; nginx already
sits in front, so only `/livekit/` needs HTTP routing — everything else
is direct from the browser.

## Nginx snippet for `demo.naff.flek.uz`

```nginx
# WebSocket upgrade for LiveKit signaling.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    server_name demo.naff.flek.uz;
    # ... existing TLS config ...

    location /livekit/ {
        # Strip the /livekit prefix before forwarding.
        rewrite ^/livekit/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;  # keep WS alive — LiveKit tokens TTL 12h
    }

    # Webhook from LiveKit back into Django.
    location /api/live/webhooks/livekit/ {
        proxy_pass http://127.0.0.1:8001;  # demo-web port
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Deploy sequence (demo only)

```bash
# On the AWS Lightsail host:
cd /opt/naffAI
sudo git pull origin main

# Merge main → demo (demo-web is built from /opt/naffAI-demo on demo branch).
cd /opt/naffAI-demo
sudo git fetch --all
sudo git merge origin/main --no-edit --no-ff
cd /opt/naffAI

# Edit .env to add LIVEKIT_* vars (see .env.example).
sudo nano .env

# Build only the demo-prefixed services.
sudo docker compose -f docker-compose.prod.yml build \
    naffai-demo-web naffai-demo-livekit naffai-demo-coturn naffai-demo-egress

# Apply migrations on demo DB only.
sudo docker compose -f docker-compose.prod.yml up -d naffai-demo-web
sudo docker exec naffai-demo-web python manage.py migrate operators livestream

# Start the rest.
sudo docker compose -f docker-compose.prod.yml up -d \
    naffai-demo-livekit naffai-demo-coturn naffai-demo-egress

# Edit nginx and reload (see snippet above).
sudo nano /etc/nginx/sites-enabled/demo.naff.flek.uz
sudo nginx -t && sudo systemctl reload nginx
```

Never run `docker compose build web` or `docker compose up -d web` — prod
is sacred.

## AWS resources to create before first deploy

1. S3 bucket `naffai-livestream-recordings-demo` (private, region
   `eu-central-1`).
2. IAM user `naffai-livestream-egress-demo` with policy restricted to
   `s3:PutObject` on that bucket only.
3. Second IAM user (or same, with read policy) for the backend to
   generate presigned GET URLs. Access-key goes into
   `LIVEKIT_S3_ACCESS_KEY` / `LIVEKIT_S3_SECRET_KEY`.
4. Lifecycle rule: delete objects after 30 days.
