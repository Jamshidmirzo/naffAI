# Волна 2 — Прод-надёжность и мониторинг

Спека для builder-агента. Задача — 9 HIGH-приоритетных фиксов чтобы naffAI не легла тихо в проде.

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. Django 5 + DRF + PostgreSQL, HackSoft-раскладка. Волна 1 (безопасность и целостность) уже принята — регресс 145 passed / 0 failed. Спека Волны 1 в файле `/Users/user/.claude/plans/snappy-napping-blanket.md`. **Не трогать Волны 1, 3, 4, 5** — только 2.

## Задачи

### 2.1 systemd unit для `run_tg_userclient`

- **Проблема**: Runner Telethon в prod должен жить 24/7. Сейчас нигде не запускается.
- **Файлы**:
  - `deploy/systemd/naff-tg-userclient.service` (новый):
    ```ini
    [Unit]
    Description=naffAI Telegram User-Client runner
    After=network.target docker.service
    Requires=docker.service

    [Service]
    Type=simple
    WorkingDirectory=/opt/naffAI
    Environment=DJANGO_SETTINGS_MODULE=config.settings.prod
    EnvironmentFile=/opt/naffAI/.env
    ExecStart=/opt/naffAI/backend/.venv/bin/python manage.py run_tg_userclient
    Restart=always
    RestartSec=10
    User=root
    StandardOutput=append:/var/log/naffAI/tg-userclient.log
    StandardError=append:/var/log/naffAI/tg-userclient.log

    [Install]
    WantedBy=multi-user.target
    ```
  - `deploy/deploy.sh` — добавить в конец:
    ```
    install -m 644 deploy/systemd/naff-tg-userclient.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now naff-tg-userclient.service
    ```
  - `README.md` — новый раздел «Telegram User-Client в prod» с командами `systemctl status/restart/logs`.

### 2.2 Расширенный `/healthz`

- **Проблема**: `config/urls.py:7` — `{"status":"ok"}` без проверок.
- **Фикс**: Новый `apps/common/health.py`:
  ```python
  class HealthCheckView(APIView):
      permission_classes = [AllowAny]

      def get(self, request):
          checks = {}
          overall = "ok"

          # DB
          try:
              connection.ensure_connection()
              checks["db"] = {"status": "ok"}
          except Exception as e:
              checks["db"] = {"status": "error", "detail": str(e)}
              overall = "error"

          # Google Sheets sync freshness
          latest = SheetSource.objects.filter(active=True).order_by("-last_synced_at").first()
          if latest and latest.last_synced_at:
              age_min = (timezone.now() - latest.last_synced_at).total_seconds() / 60
              checks["sheets_sync"] = {"status": "warning" if age_min > 5 else "ok", "age_min": age_min}
              if age_min > 5 and overall == "ok": overall = "warning"

          # TG sessions
          total_ops = Operator.objects.filter(status="active").count()
          active_sess = TgSession.objects.filter(status="active").count()
          ratio = active_sess / total_ops if total_ops else 1
          checks["tg_sessions"] = {"status": "warning" if ratio < 0.5 else "ok", "active": active_sess, "total": total_ops}
          if ratio < 0.5 and overall == "ok": overall = "warning"

          # AI insights freshness
          latest_ai = TgAiInsight.objects.order_by("-created_at").first()
          if latest_ai:
              age_h = (timezone.now() - latest_ai.created_at).total_seconds() / 3600
              checks["ai_insights"] = {"status": "warning" if age_h > 2 else "ok", "age_h": age_h}
              if age_h > 2 and overall == "ok": overall = "warning"

          # DM-blocked
          blocked = BotSubscription.objects.filter(blocked_at__isnull=False).count()
          checks["tg_bot_blocked_dms"] = {"status": "ok" if blocked < 3 else "warning", "count": blocked}

          return Response({"status": overall, "checks": checks},
                         status=200 if overall != "error" else 503)
  ```
- Регистрация в `config/urls.py` — заменить простой `healthz` на `HealthCheckView.as_view()`.
- Тест `apps/common/tests/test_healthz.py` — 4 сценария (ok / warning-sheets-stale / warning-tg-down / error-db-down mocked).

### 2.3 DRF rate-limiting

- **Проблема**: `/api/auth/login/` не защищён от брутфорса.
- **Фикс** в `config/settings/base.py:REST_FRAMEWORK`:
  ```python
  "DEFAULT_THROTTLE_CLASSES": [
      "rest_framework.throttling.AnonRateThrottle",
      "rest_framework.throttling.UserRateThrottle",
  ],
  "DEFAULT_THROTTLE_RATES": {
      "anon": "20/min",
      "user": "1000/hour",
      "login": "10/min",
  },
  ```
- Кастомный `LoginRateThrottle` (scope="login") в `apps/users/apis.py`, применить к `LoginApi`.
- Тест `apps/users/tests/test_throttling.py` — 11-й запрос за минуту возвращает 429.

### 2.4 Stale RUNNING timeout сократить + heartbeat

- **Проблема**: `apps/tg_userclient/services.py:_reset_stale_running_jobs` — 10 мин слишком долго. FloodWait 24h блокирует job целые сутки.
- **Фикс**:
  1. `settings.TG_STALE_RUNNING_TIMEOUT_MIN=5` (было 10).
  2. Heartbeat в `apps/tg_userclient/runner.py:_run_backfill` — каждые 10 чатов делать `job.save(update_fields=["updated_at"])`.
  3. Изменить FloodWait handler:
     ```python
     except FloodWaitError as fw:
         if fw.seconds > 300:  # >5 мин
             await sync_to_async(_mark_pending)(job)   # новая функция
             logger.warning("backfill#%s FloodWait %ss > 5min — releasing to PENDING", job.id, fw.seconds)
             return  # runner подхватит на следующем tick через 5+ мин
         await asyncio.sleep(fw.seconds + 5)
     ```
  4. Новый хелпер `_mark_pending(job)` в services.py — статус в PENDING, `started_at=None`.
- Тесты: `test_stale_running_reset_after_5min`, `test_floodwait_over_5min_releases_to_pending`, `test_heartbeat_updates_timestamp`.

### 2.5 ALLOWED_HOSTS дефолт = `""`

- **Проблема**: `config/settings/base.py:22` — `default="*"` уязвимо.
- **Фикс**:
  - `base.py`: `ALLOWED_HOSTS = config("DJANGO_ALLOWED_HOSTS", default="").split(",")` (пустой список).
  - `dev.py`: явно `ALLOWED_HOSTS = ["localhost", "127.0.0.1"]`.
  - `prod.py`: `if not ALLOWED_HOSTS or ALLOWED_HOSTS == [""]: raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS required in prod")`.

### 2.6 Sentry SDK

- **Проблема**: Uncaught exceptions в prod уходят в docker logs, никто не видит.
- **Фикс**:
  - Зависимость `sentry-sdk[django]>=2.0` в `pyproject.toml` + `uv pip install`.
  - `config/settings/prod.py` в начало:
    ```python
    import sentry_sdk
    from sentry_sdk.integrations.django import DjangoIntegration

    SENTRY_DSN = config("SENTRY_DSN", default="")
    if SENTRY_DSN:
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            integrations=[DjangoIntegration()],
            traces_sample_rate=0.05,
            send_default_pii=False,
            environment="production",
        )
    ```
  - `.env.example` — `SENTRY_DSN=` (пустой).
  - README раздел «Ошибки в проде — Sentry (SaaS free tier)» с ссылкой https://sentry.io/signup/.

### 2.7 DM-blocked list

- **Проблема**: Если оператор заблокировал aiogram-бота, `send_callback_dm` бесконечно падает с 403 Forbidden.
- **Фикс**:
  - Миграция: `BotSubscription.blocked_at = models.DateTimeField(null=True, blank=True)` в `apps/tg_bot/models.py`.
  - `apps/tg_bot/notify.py:send_callback_dm`:
    ```python
    from aiogram.exceptions import TelegramForbiddenError
    ...
    try:
        await bot.send_message(...)
        subscription.blocked_at = None  # оператор разблокировал
        subscription.save(update_fields=["blocked_at"])
    except TelegramForbiddenError:
        if not subscription.blocked_at:
            subscription.blocked_at = timezone.now()
            subscription.save(update_fields=["blocked_at"])
        logger.info("skipping DM: operator blocked bot subscription=%s", subscription.id)
        return
    ```
  - В selector `subscriptions_ready_for_dm(...)` — фильтр `blocked_at__isnull=True`.
  - Тест: `test_dm_forbidden_marks_blocked`, `test_dm_skipped_for_blocked_subscription`.

### 2.8 Log rotation

- **Проблема**: `config/settings/base.py:LOGGING` — только `ConsoleHandler`. Management-команды из cron бросают в pipe.
- **Фикс** в `base.py:LOGGING`:
  ```python
  LOG_DIR = config("LOG_DIR", default="")
  handlers = {"console": {"class": "logging.StreamHandler", "level": "INFO"}}
  if LOG_DIR:
      handlers["file"] = {
          "class": "logging.handlers.RotatingFileHandler",
          "filename": f"{LOG_DIR}/naffai.log",
          "maxBytes": 10 * 1024 * 1024,
          "backupCount": 5,
          "level": "INFO",
      }
  LOGGING = {
      "version": 1,
      "disable_existing_loggers": False,
      "handlers": handlers,
      "root": {"handlers": list(handlers.keys()), "level": "INFO"},
  }
  ```
- `.env.example`: `LOG_DIR=` (пусто локально, `/var/log/naffAI` в prod).

### 2.9 Batch delete в `purge_old_tg_messages`

- **Проблема**: `apps/tg_userclient/management/commands/purge_old_tg_messages.py` — один `qs.delete()`. На 500k строках X-lock несколько минут.
- **Фикс** в handle():
  ```python
  cutoff = timezone.now() - timedelta(days=settings.TG_MESSAGE_RETENTION_DAYS)
  total_deleted = 0
  batch_size = 10_000
  while True:
      ids = list(TgMessage.objects.filter(sent_at__lt=cutoff).values_list("id", flat=True)[:batch_size])
      if not ids:
          break
      deleted, _ = TgMessage.objects.filter(id__in=ids).delete()
      total_deleted += deleted
      self.stdout.write(f"batch: {deleted}, total: {total_deleted}")
  ```

## Порядок работ

Не критично, но рекомендую 2.5 → 2.6 → 2.3 → 2.8 → 2.7 → 2.9 → 2.4 → 2.2 → 2.1 (сначала settings/security, потом код, потом инфра).

## Стиль

- HackSoft строго. Все мутирующие сервисы — с `audit_log_create`, `_scrub` уже применяется автоматически из Волны 1.
- Никаких эмодзи в коде/коммитах.
- Type hints везде.
- Комменты только для нюансов (rate limit scope, sentry PII, heartbeat).
- Не пуш'ить в prod, только локальные коммиты. По коммиту на подзадачу.

## Тесты (минимум 15 новых)

- `test_healthz.py` — 4 сценария
- `test_throttling.py` — 2 (login rate limit, anon rate limit)
- `test_stale_running_reset.py` — 3
- `test_dm_blocked.py` — 2
- `test_batch_purge.py` — 2 (small dataset + verify batch progress)
- `test_allowed_hosts_prod_config.py` — 2 (raises when empty, ok when set)

Регресс: **145 pre-existing зелёных должны остаться зелёными**. Итого ≥160 passed.

## Финальный отчёт

- 9 подзадач: file:line ключевых изменений.
- Итог pytest: сколько passed / failed.
- Как проверить каждый фикс:
  - `curl -s http://localhost:8001/healthz | jq` — расширенный ответ
  - `for i in {1..12}; do curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:8001/api/auth/login/ -d '{}' -H 'Content-Type: application/json'; done` — 11-й даёт 429
  - `systemctl status naff-tg-userclient` (на прод-машине)
- Список открытых вопросов — если появятся.
