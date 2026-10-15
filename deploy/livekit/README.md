# Live-эфир: LiveKit + egress (prod и demo на одном сервере)

`apps.livestream` работает на одном self-hosted LiveKit, общем для prod и
demo. Разделение — по комнате: у каждого бэкенда своя
(`LIVEKIT_ROOM_NAME`: `naffai-prod` в `.env`, `naffai-demo` в `.env.demo`).
LiveKit шлёт вебхуки в оба бэкенда, каждый берёт события только своей
комнаты.

LiveKit живёт на отдельном сервере, чтобы видео не нагружало CRM:
Lightsail `naffai-media` (small_3_0, 2 vCPU / 2 ГБ, eu-central-1a), публичный
IP 3.70.241.228 (не статический — лимит статических IP в аккаунте; меняется
только при stop/start), приватный 172.26.5.12. Деплой —
`bash deploy/deploy-media.sh` (compose — `deploy/livekit/docker-compose.media.yml`,
host network, ключи берёт из `.env` CRM, IP определяет сам). SSH — тем же
`~/.ssh/naffai-lightsail.pem`.

| Сервис (media)  | Что делает                                                |
|-----------------|-----------------------------------------------------------|
| `livekit`       | SFU + встроенный TURN. Конфиг — env `LIVEKIT_CONFIG`.     |
| `livekit-redis` | Состояние комнат и шина egress (noeviction, 127.0.0.1).   |
| `egress`        | Запись: track egress → mp4 в S3. Конфиг — `EGRESS_CONFIG_BODY`. |

На CRM-сервере (`docker-compose.prod.yml`) — только `live-ops` /
`demo-live-ops` (`manage.py live_ops`: сверка «кто в эфире» с LiveKit,
часовая нарезка записей, чистка), `LIVEKIT_API_URL=http://172.26.5.12:7880`
и nginx `/livekit/` → тот же адрес.

## Порты (Lightsail firewall `naffai-media`)

| Порт      | Протокол | Откуда           | Зачем                                      |
|-----------|----------|------------------|--------------------------------------------|
| 7880      | TCP      | только CRM-хост  | сигналинг (через nginx CRM) + API бэкенда  |
| 7881      | TCP      | все              | ICE по TCP для сетей без UDP               |
| 7882      | UDP      | все              | все WebRTC-потоки одним портом (UDP mux)   |
| 3478      | UDP      | все              | встроенный TURN (строгий NAT)              |

Ядро медиасервера: `/etc/sysctl.d/60-livekit.conf` (`net.core.rmem_max` /
`wmem_max` = 5000000) — ставится user-data при создании.

## nginx

`/etc/nginx/conf.d/websocket-upgrade.conf` — общий `map` (один на весь
nginx, копия в `deploy/nginx/`). В оба сайта (`naffai`, `naff-demo`):

```nginx
location /livekit/ {
    rewrite ^/livekit/(.*)$ /$1 break;
    proxy_pass http://172.26.5.12:7880;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
}
```

## .env

prod (`/opt/naffAI/.env`):
```
LIVEKIT_WS_URL=wss://naff.flek.uz/livekit/
LIVEKIT_ROOM_NAME=naffai-prod
LIVEKIT_API_URL=http://172.26.5.12:7880
LIVEKIT_S3_BUCKET=naffai-livestream-recordings
LIVEKIT_RECORDING_ENABLED=1
```
demo (`/opt/naffAI/.env.demo`, перекрывает): `LIVEKIT_WS_URL=wss://demo.naff.flek.uz/livekit/`,
`LIVEKIT_ROOM_NAME=naffai-demo`, `LIVEKIT_S3_BUCKET=naffai-livestream-recordings-demo`.

## S3

Бакет на окружение, приватный, SSE-S3, lifecycle: удалять объекты через
`LIVEKIT_RECORDING_RETENTION_DAYS` (30) дней + `AbortIncompleteMultipartUpload`
1 день. IAM-пользователь бэкенда: `s3:PutObject`, `s3:GetObject`,
`s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` только на свой
бакет (egress пишет с этими же ключами, бэкенд подписывает ссылки на
просмотр).

## Проверка

```bash
# на CRM
sudo docker compose -f docker-compose.prod.yml exec -T web python manage.py live_ops --once
# на media
cd /opt/naffai-media && sudo docker compose logs --since 5m livekit | grep -iE 'error|turn|webhook'
sudo docker compose logs --since 5m egress | tail
```
