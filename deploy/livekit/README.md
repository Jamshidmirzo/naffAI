# Live-эфир: LiveKit + egress (prod и demo на одном сервере)

`apps.livestream` работает на одном self-hosted LiveKit, общем для prod и
demo. Разделение — по комнате: у каждого бэкенда своя
(`LIVEKIT_ROOM_NAME`: `naffai-prod` в `.env`, `naffai-demo` в `.env.demo`).
LiveKit шлёт вебхуки в оба бэкенда, каждый берёт события только своей
комнаты.

Сервисы — `docker-compose.prod.yml`, профиль `live`:

| Сервис          | Что делает                                                |
|-----------------|-----------------------------------------------------------|
| `livekit`       | SFU + встроенный TURN. Конфиг — env `LIVEKIT_CONFIG`.     |
| `livekit-redis` | Состояние комнат и шина egress (noeviction).              |
| `egress`        | Запись: track egress → mp4 в S3. Конфиг — `EGRESS_CONFIG_BODY`. |
| `live-ops`, `demo-live-ops` | Бэкенд-цикл `manage.py live_ops`: сверка «кто в эфире» с LiveKit, часовая нарезка записей, чистка. |

Ключи подставляет compose из `/opt/naffAI/.env` (`LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`). Отдельных yaml-файлов нет — справка по полям:
https://docs.livekit.io/home/self-hosting/deployment/ .

`deploy/deploy-prod.sh` поднимает профиль `live` сам (если в `.env` есть
`LIVEKIT_API_KEY`) и пересоздаёт его, только если менялся compose или эта
папка.

## Порты

| Порт      | Протокол | Зачем                                                   |
|-----------|----------|---------------------------------------------------------|
| 7880      | TCP      | сигналинг + API, только 127.0.0.1 — nginx `/livekit/`   |
| 7881      | TCP      | ICE по TCP для сетей, где UDP закрыт                    |
| 7882      | UDP      | все WebRTC-потоки одним портом (UDP mux)                |
| 3478      | UDP      | встроенный TURN (строгий NAT)                           |

Lightsail firewall: открыть 7881/tcp, 7882/udp, 3478/udp. Старые диапазоны
49160-49200/udp и 50000-50200/udp (coturn) больше не нужны.

Ядро: LiveKit просит буфер UDP побольше —
`/etc/sysctl.d/60-livekit.conf`: `net.core.rmem_max=5000000`,
`net.core.wmem_max=5000000` → `sudo sysctl --system`.

## nginx

`/etc/nginx/conf.d/websocket-upgrade.conf` — общий `map` (один на весь
nginx, копия в `deploy/nginx/`). В оба сайта (`naffai`, `naff-demo`):

```nginx
location /livekit/ {
    rewrite ^/livekit/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:7880;
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
LIVEKIT_API_URL=http://livekit:7880
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
sudo docker compose -f docker-compose.prod.yml exec -T web python manage.py live_ops --once
sudo docker logs --since 5m naffai-livekit-1 | grep -iE 'error|turn|webhook'
sudo docker logs --since 5m naffai-egress-1 | tail
```
