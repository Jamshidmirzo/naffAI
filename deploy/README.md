# naffAI — deploy assets

Артефакты для развёртывания на prod-VPS `46.101.112.215` (`/opt/naffAI`).

Все юниты пишут логи в `/var/log/naffAI/` — убедитесь, что каталог существует
и доступен на запись пользователю `root` (`sudo mkdir -p /var/log/naffAI`).

## Обычный релиз

```bash
# на локальной машине
git push origin main
# на VPS
cd /opt/naffAI && bash deploy/deploy.sh
```

Скрипт `deploy.sh` подтягивает код, ставит зависимости, применяет миграции и
перезапускает контейнеры web/api. Фронт деплоится отдельно (`deploy-frontend.sh`
→ Vercel).

## Systemd юниты

### `naff-tg-userclient.service` — Telethon user-client

Долгоживущий процесс, слушает MTProto каждого подключённого оператора.

```bash
sudo cp deploy/systemd/naff-tg-userclient.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now naff-tg-userclient.service

# статус / логи
systemctl status naff-tg-userclient
journalctl -u naff-tg-userclient -f
tail -f /var/log/naffAI/tg-userclient.log
```

### Ежедневная обучалка — два таймера

Пайплайн разбит на две ступени: сначала генерируется урок для каждого активного
оператора (тяжёлый шаг с LLM), потом отдельным юнитом раскидывается в TG DM.

| Юнит | Расписание | Что делает |
|------|-----------|------------|
| `naff-daily-lessons-generate.timer` | `05:30 Asia/Tashkent` | Собирает вчерашние факты и вызывает LLM. Идемпотентен: повторный запуск за ту же дату ничего не создаёт. |
| `naff-daily-lessons-deliver.timer` | `07:30 Asia/Tashkent` | Отправляет уроки в личку операторам с ретраем на transient-ошибках aiogram. |

Установка:

```bash
sudo cp deploy/systemd/naff-daily-lessons-*.service /etc/systemd/system/
sudo cp deploy/systemd/naff-daily-lessons-*.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now naff-daily-lessons-generate.timer \
                            naff-daily-lessons-deliver.timer
```

Проверить, что таймеры активны и когда сработают:

```bash
systemctl list-timers | grep naff
# NEXT                        LEFT  LAST  PASSED UNIT                                ACTIVATES
# Fri 2026-07-25 05:30:00 UZT ...   ...   ...    naff-daily-lessons-generate.timer   naff-daily-lessons-generate.service
# Fri 2026-07-25 07:30:00 UZT ...   ...   ...    naff-daily-lessons-deliver.timer    naff-daily-lessons-deliver.service
```

Обе timer-настройки используют `Persistent=true`, поэтому если сервер был
выключен в момент срабатывания (например, ночью падал VPS), запуск произойдёт
сразу после старта.

Ручной прогон (для отладки за конкретную дату):

```bash
cd /opt/naffAI
sudo -E /opt/naffAI/backend/.venv/bin/python manage.py generate_daily_lessons --date 2026-07-23
sudo -E /opt/naffAI/backend/.venv/bin/python manage.py deliver_daily_lessons  --date 2026-07-23
tail -n 200 /var/log/naffAI/daily-lessons-deliver.log
```

Опция `--operator <id>` фильтрует по одному оператору; `--dry-run` у `generate_*`
показывает, кого бы система обработала, не дёргая LLM.

## Оператор отписался от ежедневной рассылки

Поле `Operator.daily_lesson_opt_out` (bool). Меняется через UI (`Profile.tsx` →
секция «Уведомления») либо напрямую в Django-admin. Обе management-команды и
`generate_daily_lessons`, и `deliver_daily_lessons` пропускают таких операторов.

## Предупреждение о длинных сменах (long-shift warning)

Юнит `naff-attendance-long-shift-check.timer` проверяет незакрытые смены каждые 30 минут.

Установка:

```bash
sudo cp deploy/systemd/naff-attendance-long-shift-check.service /etc/systemd/system/
sudo cp deploy/systemd/naff-attendance-long-shift-check.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now naff-attendance-long-shift-check.timer
```

Проверить, что таймеры активны:

```bash
systemctl list-timers | grep naff-attendance
```

