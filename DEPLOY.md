# naffAI — Deploy & Change Runbook

Единый справочник: где что лежит, как менять код и БД, как катить на demo и prod. Prod — только по явной команде.

---

## 1. Окружения

| env  | host                                | domain               | code dir             | web container       | frontend static     | compose file                              |
|------|-------------------------------------|----------------------|----------------------|---------------------|---------------------|-------------------------------------------|
| prod | AWS Lightsail `63.186.179.240`      | `naff.flek.uz`       | `/opt/naffAI`        | `naffai-web-1`      | `/var/www/naff-v2/` | `/opt/naffAI/docker-compose.prod.yml`     |
| demo | тот же хост                         | `demo.naff.flek.uz`  | `/opt/naffAI-demo`   | `naffai-demo-web-1` | `/var/www/naff-demo/` | тот же `docker-compose.prod.yml`, service `demo-web` (build context = `/opt/naffAI-demo/backend`) |

- SSH: `ssh -i ~/.ssh/naffai-lightsail.pem ubuntu@63.186.179.240`
- Sudo без пароля у `ubuntu`.
- Оба окружения на одном хосте, **разные контейнеры и разные static-каталоги** — можно катить на demo, не задевая prod.
- `/opt/naffAI-demo/docker-compose.prod.yml` **STALE, не использовать**. Всегда prod-compose с service-name.
- Локальный репо у разработчика: `/Users/user/Desktop/mp/ai/naff/`.

### Прочие контейнеры (в том же compose)
- `naffai-bot-1` — aiogram, команды/отчёты владельцу (chat 88938071). Cron 3h-leaderboard: `/etc/cron.d/naffai-3h-leaderboard`, 05/08/11/14 UTC.
- `naffai-userclient-1` — Telethon, читает чаты 1121552077 / 1249574296 / 1950246877 → `TgMessage`, лидов не создаёт.
- `naffai-sheet-sync-1` — runner `manage.py sync_sheets_leads` каждые 5 мин. **Единственный источник Lead в prod.**
- `naffai-db-1` — Postgres.

---

## 2. Golden path — деплой кода

### 2.1 Backend

Локально: правки в `/Users/user/Desktop/mp/ai/naff/backend/` → тесты `pytest apps/<app>/tests/` → миграции `python manage.py makemigrations <app>`.

**Demo (сначала всегда):**
```bash
cd /Users/user/Desktop/mp/ai/naff
scp -i ~/.ssh/naffai-lightsail.pem \
  backend/apps/<app>/<files...> \
  ubuntu@63.186.179.240:/tmp/

ssh -i ~/.ssh/naffai-lightsail.pem ubuntu@63.186.179.240 '
  sudo cp /tmp/<files...> /opt/naffAI-demo/backend/apps/<app>/
  cd /opt/naffAI && sudo docker compose -f docker-compose.prod.yml build demo-web
  sudo docker compose -f docker-compose.prod.yml up -d demo-web
  sudo docker exec naffai-demo-web-1 python manage.py migrate <app>
'
```

**Prod (по явной команде user'а):**
```bash
# аналогично, но /opt/naffAI/ и service web
ssh -i ~/.ssh/naffai-lightsail.pem ubuntu@63.186.179.240 '
  sudo cp /tmp/<files...> /opt/naffAI/backend/apps/<app>/
  cd /opt/naffAI && sudo docker compose -f docker-compose.prod.yml build web
  sudo docker compose -f docker-compose.prod.yml up -d web
  sudo docker exec naffai-web-1 python manage.py migrate <app>
'
```

> Note: `deploy.sh` в репо делает `git reset --hard` — опасно, поэтому в этом runbook’е ручной scp-flow.

### 2.2 Frontend

Билд ВСЕГДА локально (у контейнеров нет node).
```bash
cd /Users/user/Desktop/mp/ai/naff/frontend
npm run build   # tsc -b && vite build → dist/
```

**Demo:**
```bash
rsync -avz --delete -e "ssh -i ~/.ssh/naffai-lightsail.pem" \
  dist/ ubuntu@63.186.179.240:/tmp/naff-demo-dist/
ssh -i ~/.ssh/naffai-lightsail.pem ubuntu@63.186.179.240 '
  sudo cp -a /var/www/naff-demo /var/www/naff-demo.bak.$(date +%Y%m%dT%H%M%SZ)
  sudo rsync -a --delete /tmp/naff-demo-dist/ /var/www/naff-demo/
  sudo chown -R ubuntu:ubuntu /var/www/naff-demo
'
```

**Prod (по команде):**
```bash
rsync -avz --delete -e "ssh -i ~/.ssh/naffai-lightsail.pem" \
  dist/ ubuntu@63.186.179.240:/tmp/naff-prod-dist/
ssh -i ~/.ssh/naffai-lightsail.pem ubuntu@63.186.179.240 '
  sudo cp -a /var/www/naff-v2 /var/www/naff-v2.bak.$(date +%Y%m%dT%H%M%SZ)
  sudo rsync -a --delete /tmp/naff-prod-dist/ /var/www/naff-v2/
  sudo chown -R ubuntu:ubuntu /var/www/naff-v2
'
```

Nginx кэш агрессивный — при чистом рефреше видно сразу; иначе Cmd+Shift+R.

### 2.3 Smoke после деплоя

```bash
curl -sI https://demo.naff.flek.uz/               # 200
curl -sI https://naff.flek.uz/                    # 200
curl -sI https://demo.naff.flek.uz/api/health/    # 200 если endpoint есть
ssh ... 'sudo docker compose -f /opt/naffAI/docker-compose.prod.yml ps'
ssh ... 'sudo docker logs --tail=200 naffai-demo-web-1'
ssh ... 'sudo docker logs --tail=200 naffai-sheet-sync-1'
```

---

## 3. Rollback

- **Backend:** до scp сохрани копию: `sudo cp <file> <file>.bak.<ts>` внутри `/opt/naffAI[-demo]/backend/…`. Откат — `cp` обратно + пересборка контейнера.
- **Frontend:** бэкап `/var/www/naff-{demo,v2}.bak.<ts>` уже делают команды выше. Откат — `sudo rsync -a --delete /var/www/naff-v2.bak.<ts>/ /var/www/naff-v2/`.
- **Миграции:** `sudo docker exec naffai-web-1 python manage.py migrate <app> <prev_migration>`.
- **DB row:** делай dump в `/tmp/*.json` перед `update()` — см. §5.

---

## 4. Правила безопасности

1. **Prod → только по явной команде user'а.** Всегда сначала demo, отчёт, ждём «промоут».
2. **Никаких `git push --force`, `--no-verify`, `--no-gpg-sign`.**
3. **Никакой сети к камерам / NVR / LAN** (см. память `feedback_no_prod_portscan`).
4. **`open <url>` не выполнять** — только присылать ссылку в чат.
5. **Не показывать промежуточные результаты**, работать до конца → один итоговый отчёт (см. `feedback_work_autonomously`).
6. **Ветка ark-* не переключать** без команды (см. `feedback_ark_branch_switch_wait`) — не про этот проект, но общее правило.

---

## 5. Типовые операции

### 5.1 Sync лидов из Google Sheets

Модель `apps.leads.models.SheetSource`. Sync — `manage.py sync_sheets_leads` (runner `naffai-sheet-sync-1`, 5 мин).

**Смена spreadsheet у существующего SheetSource:**

Pre-flight (dry-read через service account):
```bash
sudo docker exec naffai-web-1 python manage.py shell -c "
from apps.leads.integrations.google_sheets.client import GoogleSheetsClient
c = GoogleSheetsClient()
print(c.get_sheet_metadata('<NEW_SPREADSHEET_ID>'))
"
```
Если 403 → расшарить таблицу сервисному аккаунту `naff-sheets-reader@naff-sheets.iam.gserviceaccount.com` (Editor, uncheck Notify).
Первый лист (gid=0) = `sheets[0].properties.title`.

Backup + update:
```bash
sudo docker exec naffai-web-1 python manage.py shell -c "
import json
from apps.leads.models import SheetSource
s = SheetSource.objects.get(id=<ID>)
json.dump({'id': s.id, 'spreadsheet_id': s.spreadsheet_id, 'worksheet_name': s.worksheet_name,
           'last_synced_at': str(s.last_synced_at), 'last_synced_row': s.last_synced_row,
           'last_sync_error': s.last_sync_error},
          open('/tmp/sheet_source_<ID>_bak.json','w'))
SheetSource.objects.filter(id=<ID>).update(
    spreadsheet_id='<NEW_ID>',
    worksheet_name='<TITLE>',
    last_synced_row=0,
    last_synced_at=None,
    last_sync_error='',
)
"
sudo docker exec naffai-web-1 python manage.py sync_sheets_leads
sudo docker logs --tail=100 naffai-sheet-sync-1
```

Дедуп: sync ищет существующий Lead по phone/imei перед create — повторный импорт той же таблицы не задублит.

**Service account:** `naff-sheets-reader@naff-sheets.iam.gserviceaccount.com`, ключ в контейнере `/app/gsheets.json`.

### 5.2 3-часовой leaderboard-бот

- Файл: `backend/apps/tg_bot/management/commands/send_3h_leaderboard.py`.
- Селектор: `apps/analytics/selectors.py::lead_stats_snapshot()`.
- Формула «касаний» = `by_operator[*].total` (union CallAttempt + Lead updates). **НЕ** `unique_leads_touched` (только CallAttempt) — старая формула занижала в 5×, была починена.
- Cron: `/etc/cron.d/naffai-3h-leaderboard` на хосте, 05/08/11/14 UTC.
- Dry-run: `sudo docker exec naffai-web-1 python manage.py send_3h_leaderboard --dry-run`.

### 5.3 Sale celebration

- Backend: `_broadcast_new_sale()` в `backend/apps/sales/services.py` рассылает `NotificationKind.SALE_CELEBRATION` всем активным операторам, исключая всех `SaleOperator.operator_id`.
- Frontend: `frontend/src/components/SaleCelebration.tsx` (polling 30с) в `AppShell.tsx` под `role === "operator"`.
- i18n: `frontend/src/lib/i18n.ts` блок `sale_celebration.*` (ru+uz, en в проекте нет).

### 5.4 Демо-креды операторов (App Store / smoke)

- Prod pro-мастер (клиент App Store): phone `+998900000042`, pass `Demo2026!`, role master.
- Prod client App Store: login `hayrli_demo` (без +), pass `Demo2026!` (это Hayrli, не naffAI — здесь для справки).
- Test-оператор naffAI (для UI-smoke): id 51, phone `+998900000099`, pass `TestBonu123`, 18 клонированных лидов.

---

## 6. Полезные ссылки

- Асtериск (звонки): 63.186.179.240:5060 UDP, AMI 127.0.0.1:5038. Детали в памяти `reference_asterisk_naffai`.
- TG-канал отчётов владельцу: chat_id `88938071`.
- Терминология: **«партнёр» = payment channel** (Anor/TBC/Alif/Birzum/Hamroh), НЕ коллега-менеджер. Модель `SalePartner`.
- Роли по бизнесу: `manager` + `operator`. `team_lead` в коде оставлен, но в UI скрывается (см. `project_naffai_roles`).

---

## 7. Prod pre-flight checklist (обязательно перед промоутом)

- [ ] На demo протестировано, скриншот/отчёт есть.
- [ ] User сказал «промоут» / «катим на prod» ЯВНО.
- [ ] `docker compose -f docker-compose.prod.yml ps` — все сервисы healthy.
- [ ] Backup файлов/dist сделан (см. §3).
- [ ] Миграции обратимы или backup БД сделан для рискованных.
- [ ] После деплоя: smoke `curl -sI`, `docker logs --tail=200 naffai-web-1`, `docker logs --tail=200 naffai-sheet-sync-1`.
- [ ] Отчёт пользователю: что задеплоено + команда отката.
