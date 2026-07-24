# QR check-in / check-out — учёт присутствия операторов

Спека для builder-агента. Одна фича, одна волна. Даёт офису единый источник правды «кто и когда пришёл / ушёл», плюс совмещает вход по QR-коду с автоматическим логином оператора на его рабочей станции — чтобы убрать бардак «пришёл-не-пришёл-забыл-разлогиниться».

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. Django 5 + DRF (Token auth) + React + Vite + TS. HackSoft-раскладка (`services.py` / `selectors.py`, тонкие views/serializers). TZ по умолчанию — `Asia/Tashkent`. Никаких эмодзи в коде и тестах.

Никаких биометрий, geofencing и интеграций с турникетами. QR + камера рабочей станции — и всё.

---

## Модель работы (human overview)

**Никакого общего киоска на входе нет.** Оператор приходит в офис, садится за свой (или любой свободный) офисный ноутбук/десктоп, открывает в браузере CRM и попадает на страницу `/scan`. Достаёт свой личный QR (либо распечатанный бейдж, либо картинку в галерее телефона), подносит его к веб-камере рабочей станции — и система разом делает две вещи: (1) фиксирует check-in в журнале посещаемости, (2) выдаёт DRF-токен и логинит оператора в CRM прямо на этом же устройстве. Никакого отдельного 6-значного кода, никакой синхронизации между устройствами: сессия создаётся ровно там, где сканирует камера.

В конце смены оператор снова открывает `/scan` (либо жмёт «Выйти» в меню — там та же логика), сканирует тот же QR — сервер видит открытую смену, закрывает её (check-out), инвалидирует токен этой сессии и показывает «До завтра, {name}». Оператор закрывает ноутбук и уходит. Если оператор забыл сканировать при уходе — cron в 23:00 (Asia/Tashkent) закрывает все открытые смены с флагом `auto_closed=True` и утром TL получает сводку.

Свой QR оператор берёт со страницы `/profile` в CRM — там отдельная секция «Мой QR для входа» с большим QR-кодом и кнопками «Скачать PNG» и «Распечатать». Тимлид может ротировать QR любого оператора на `OperatorDetail` (например, если бейдж потерялся) — старый nonce получает `revoked_at`, при попытке сканирования — HTTP 410. Логин по паролю остаётся как fallback (для TL/Manager всегда, для оператора — на случай сломанной камеры).

---

## Решения по открытым вопросам (зафиксировано, не пересматриваем)

| # | Вопрос | Решение |
|---|---|---|
| 1 | Где оператор видит свой QR | На странице `/profile` в веб-CRM, отдельной секцией «Мой QR для входа». Большой QR (генерится сервером в PNG через `qrcode`, эндпоинт `GET /api/me/attendance-qr.png`), кнопки «Скачать PNG» (простой anchor `download`) и «Распечатать» (`window.print` с CSS `@media print` — на печатной странице остаются только имя + QR, всё остальное скрыто). Один и тот же QR **статический** — печатается один раз и живёт до ротации. Ежедневная ротация — не делаем: печатный бейдж должен работать месяцами. |
| 2 | Что в QR | **Статический подписанный токен**: `naffai-att-v1:<operator_id>:<nonce_hex>:<hmac>` (HMAC-SHA256 от `operator_id:nonce` под серверным `QR_ATTENDANCE_HMAC_KEY`, первые 16 hex-символов). Ротируется тимлидом по требованию (потеря/компрометация). |
| 3 | Где сканирует оператор | На том же устройстве, где будет работать. Публичная страница `/scan` (без auth) → браузерная камера → JS-декодер QR → `POST /api/attendance/scan/`. Никакого отдельного киоска. |
| 4 | JS-декодер QR | **`html5-qrcode`** — 1 npm-пакет, работает на chrome/safari/firefox/mobile-safari без танцев, автоматически рендерит `<video>` + `<canvas>`, ест 15 KB gzip. Альтернатива `@zxing/browser` требует ручной работы с `<video>` и обработки frame-timing — для нашей задачи overkill. |
| 5 | Как QR-сканирование становится CRM-сессией | Сервер на `/api/attendance/scan/` при check-in возвращает **DRF-токен прямо в ответе**. Фронт кладёт его в `localStorage` (тот же ключ `naffai_token`, что и обычный логин) и редиректит на дашборд. Никаких claim-кодов и промежуточных экранов — сканирование и создание сессии происходят на одном устройстве. |
| 6 | «Забыл сканировать при уходе» | Автозакрытие в 23:00 по Ташкенту через systemd-timer. Все открытые смены закрываются с `auto_closed=True`. TL утром в 10:15 получает TG-DM «вчера auto_closed: N смен». |
| 7 | Расписание смен / опоздания | Единое офисное расписание в singleton `AttendanceSettings`: `shift_start` (default 10:00) + `shift_end` (default 20:00) + `late_threshold_min` (default 15) + `auto_close_at` (default 23:00). `was_late` замораживается в момент чек-ина, не пересчитывается. |
| 8 | Уведомления | Единственный источник — `apps/tg_bot/notify.py`. (a) TL в 10:15 сводка «на месте: N/M, опоздали: X, не пришли: Y — [список]»; (b) TL в 23:05 «вчера auto_closed: N смен»; (c) самому оператору при чек-ине — короткое ack-сообщение «Добро пожаловать, {name}. Смена открыта в {HH:MM}». |
| 9 | Интеграция с payroll | MVP: отдельный отчёт «Посещаемость», в payroll не подмешиваем. |
| 10 | Ротация / отзыв QR оператора | Одна активная `OperatorQr` на оператора (unique constraint). TL на `OperatorDetail` → секция «Посещаемость» → кнопка «Ротировать QR» (создаёт новую nonce, старая → `revoked_at=now()`). Скан отозванного QR → HTTP 410 Gone + сообщение «QR отозван, обратитесь к тимлиду». |
| 11 | Security без kiosk-auth | Эндпоинт `/api/attendance/scan/` публичный, поэтому: (a) rate-limit 20 сканов/мин на IP через `AnonRateThrottle`; (b) rate-limit 1 успешный скан за 30 сек на одного оператора (in-DB проверка last event); (c) опциональный whitelist `ATTENDANCE_ALLOWED_NETWORKS` (list of CIDR из env, пусто → не ограничивать); (d) аудит-запись на каждый скан (успех и провал). Скомпрометированный QR лечится ротацией. |

---

## Что переиспользуем (не изобретаем заново)

| Инфра | Файл | Зачем |
|---|---|---|
| Роли, permissions | `apps/users/permissions.py` (`IsTeamLead`, `IsManager`, `IsAuthenticatedAnyRole`) | Реюзаем как есть. Новых ролей не вводим — публичный `/scan` защищён HMAC-подписью QR + rate-limit. |
| Логин / токен | DRF `Token` из `authtoken`, `apps.users.services` | `attendance_scan_checkin` вызывает `Token.objects.get_or_create(user=operator_user)` и возвращает `.key`. Тот же ключ `localStorage['naffai_token']`, что и при обычном логине. |
| Аудит | `apps/audit/services.audit_log_create` + автоскраб чувствительных ключей | Каждое действие (scan-success, scan-fail, rotate-qr) пишет `AuditLog`. В meta НЕ кладём `qr_payload` целиком — только `operator_id` и результат. |
| TG-уведомления | `apps/tg_bot/notify.py` | Добавляем `send_attendance_ack(user_id, message)`, `send_daily_attendance_summary(...)` — реюзаем стиль из `send_callback_dm`. |
| Systemd timers | `deploy/systemd/naff-daily-lessons-generate.timer` | Копия шаблона: `naff-attendance-auto-close.timer` (23:00) + `naff-attendance-morning-report.timer` (10:15). |
| Хелперы | `apps/common/validators.py`, `apps/common/pagination.py`, `apps/common/models.TimestampedModel` | Стандартный `PageNumberPagination` для истории посещаемости; `TimestampedModel` для новых моделей. |
| Layout / бейджи в sidebar | `frontend/src/components/Layout.tsx` (есть паттерн `todayLessonQ`) | Добавляем ссылку «Посещаемость» для TL/manager; для оператора — маленький «зелёный статус смены» в футере sidebar. |
| KpiCard, Paginator | `frontend/src/components/` | Используем на странице `/attendance/today`. |
| Fernet-vault паттерн | `apps/common/crypto.FernetVault` | НЕ используем — HMAC-подпись QR достаточно, шифровать нечего. `QR_ATTENDANCE_HMAC_KEY` кладётся в `.env` в том же стиле, что и `FERNET_KEY`. |
| QR PNG-рендер | новая зависимость `qrcode[pil]` (Python) | Используется в эндпоинте `GET /api/me/attendance-qr.png` и на printable-странице. |

---

## Фича — `apps/attendance/` (новый app, ~2-3 дня)

### 1. Модели

Новый app `apps/attendance/`. Файл `models.py`:

```python
from django.conf import settings
from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator

from apps.common.models import TimestampedModel


class OperatorQr(TimestampedModel):
    """
    Один активный QR на оператора. Печатается на бейдж / скачивается PNG,
    служит неопределённо долго до ротации.
    """

    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="attendance_qrs",
    )
    nonce = models.CharField(
        max_length=32,
        unique=True,
        help_text="16 hex-байт (32 символа). Входит в HMAC-подпись QR.",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["operator"],
                condition=models.Q(revoked_at__isnull=True),
                name="uniq_active_qr_per_operator",
            ),
        ]
        indexes = [models.Index(fields=["nonce"])]


class AttendanceLog(TimestampedModel):
    """
    Одна открытая смена = один незакрытый check-in для оператора.
    Закрывается либо повторным сканом (check-out), либо ночным авто-закрытием.
    """

    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="attendance_logs",
    )
    checked_in_at = models.DateTimeField(db_index=True)
    checked_out_at = models.DateTimeField(null=True, blank=True)
    checked_in_ip = models.GenericIPAddressField(null=True, blank=True)
    checked_out_ip = models.GenericIPAddressField(null=True, blank=True)
    checked_in_user_agent = models.CharField(max_length=256, blank=True, default="")
    checked_out_user_agent = models.CharField(max_length=256, blank=True, default="")
    auto_closed = models.BooleanField(default=False)
    was_late = models.BooleanField(
        default=False,
        help_text=(
            "Заморожено на момент чек-ина: True, если checked_in_at > shift_start + late_threshold. "
            "Хранится, чтобы отчёты не пересчитывать при изменении расписания."
        ),
    )
    # Токен сессии, выданной при чек-ине — храним, чтобы инвалидировать при чек-ауте.
    token_key = models.CharField(max_length=64, blank=True, default="")
    source = models.CharField(
        max_length=16,
        choices=[("qr", "qr"), ("tg", "tg"), ("manual", "manual")],
        default="qr",
        help_text=(
            "Канал, через который создан лог: qr — скан на рабочей станции; "
            "tg — команда /checkin в Telegram-боте; manual — правка тимлидом через админку."
        ),
    )
    long_shift_warning_sent_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=(
            "Момент, когда системa отправила оператору DM «работаешь уже N часов, "
            "не забыл отметить уход?». Заполняется командой attendance_long_shift_check. "
            "Пока непустой — повторное предупреждение по этому логу не шлётся."
        ),
    )
    warning_dismissed_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=(
            "Момент, когда оператор нажал «Нет, продолжаю» на inline-кнопке в DM. "
            "Служит признаком, что предупреждение осознанно отклонено — повторно не шлём."
        ),
    )
    manually_closed = models.BooleanField(
        default=False,
        help_text=(
            "True, если смена закрыта тимлидом/менеджером через UI-кнопку "
            "«Закрыть смену вручную» (endpoint POST /api/attendance/logs/<id>/close/). "
            "Взаимоисключающе с auto_closed по семантике: manually_closed — TL руками, "
            "auto_closed — ночной cron. Оба поля False → нормальный check-out самим оператором."
        ),
    )
    manually_closed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="Кто именно из TL/Manager закрыл смену вручную. Заполняется вместе с manually_closed=True.",
    )

    class Meta:
        constraints = [
            # Только одна открытая смена на оператора.
            models.UniqueConstraint(
                fields=["operator"],
                condition=models.Q(checked_out_at__isnull=True),
                name="uniq_open_log_per_operator",
            ),
        ]
        indexes = [
            models.Index(fields=["operator", "-checked_in_at"]),
            models.Index(fields=["checked_in_at"]),
        ]

    @property
    def duration_seconds(self) -> int | None:
        if self.checked_out_at is None:
            return None
        return int((self.checked_out_at - self.checked_in_at).total_seconds())


class AttendanceSettings(models.Model):
    """Singleton (pk=1). Управляется тимлидом через /settings-like эндпоинт."""

    shift_start = models.TimeField(default="10:00")
    shift_end = models.TimeField(default="20:00")
    late_threshold_min = models.PositiveSmallIntegerField(
        default=15, validators=[MinValueValidator(0), MaxValueValidator(240)],
    )
    auto_close_at = models.TimeField(default="23:00")
    long_shift_warning_hours = models.PositiveSmallIntegerField(
        default=10,
        validators=[MinValueValidator(1), MaxValueValidator(24)],
        help_text=(
            "Через сколько часов после check_in (при пустом check_out) система шлёт "
            "оператору и его team_lead DM «работаешь уже N часов, не забыл отметить уход?». "
            "Проверяется командой attendance_long_shift_check (systemd-timer каждые 30 минут)."
        ),
    )
    tg_checkin_enabled = models.BooleanField(
        default=True,
        help_text=(
            "Разрешает check-in/out через Telegram-бота (/checkin, /checkout, "
            "inline-кнопку в утреннем DM). При False бот отвечает подсказкой "
            "и не создаёт AttendanceLog."
        ),
    )
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
    )

    class Meta:
        constraints = [
            models.CheckConstraint(check=models.Q(pk=1), name="attendance_settings_singleton"),
        ]

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)
```

Одна миграция: две модели (`OperatorQr`, `AttendanceLog`) + singleton `AttendanceSettings`. Никаких новых ролей, никаких новых permission-классов.

Отдельной последующей миграцией (см. шаг 14 в порядке работ) в `AttendanceLog` добавляются поля `long_shift_warning_sent_at`, `warning_dismissed_at`, `manually_closed`, `manually_closed_by`, а в `AttendanceSettings` — `long_shift_warning_hours` (default=10). Разделено на две миграции, чтобы Long-shift и Manual-close функциональность катилась отдельно от базовой QR-волны.

### 2. Сервисы

`apps/attendance/services.py` — вся запись строго через них.

Публичные функции (обязательные):

```python
def qr_token_build(operator: Operator, nonce: str) -> str: ...
    # returns "naffai-att-v1:<operator_id>:<nonce>:<hmac>"

def qr_token_verify(raw: str) -> tuple[Operator, OperatorQr]: ...
    # raises ValidationError / PermissionDenied / Http410

@transaction.atomic
def operator_qr_rotate(*, operator: Operator, actor: User) -> OperatorQr: ...
    # revokes current (if any) + creates new + audit

@transaction.atomic
def attendance_scan(
    *,
    qr_raw: str,
    ip: str | None,
    user_agent: str,
) -> dict: ...
    # Тонкая обёртка над process_attendance_event: верифицирует QR (qr_token_verify)
    # и вызывает process_attendance_event(operator=..., source="qr", initiator=f"ip={ip}", ...).
    # Возвращает тот же shape, что и process_attendance_event, плюс поле "token"
    # при check-in (для HTTP-канала — см. раздел 4).

@transaction.atomic
def process_attendance_event(
    *,
    operator: Operator,
    source: str,               # "qr" | "tg" | "manual"
    initiator: str,            # human-readable: "ip=1.2.3.4", "tg=@ivan id=12345", "manual=user_id=7"
    ip: str | None = None,     # только для QR-канала; None для tg/manual
    user_agent: str = "",      # только для QR-канала
    issue_token: bool = False, # True только для QR-канала (см. раздел 4a про CRM-сессию)
) -> dict: ...
    # Единая точка правды для check-in / check-out. Вызывается и из HTTP endpoint'а,
    # и из TG-хендлеров. Внутри решает — check-in или check-out (по наличию открытого
    # AttendanceLog у оператора).
    # Возвращает один из двух shapes:
    #   check-in:  {"action": "check_in", "operator": {...}, "token": "..." | None,
    #               "was_late": bool, "checked_in_at": iso, "source": "qr|tg|manual"}
    #   check-out: {"action": "check_out", "operator": {...}, "duration_min": int,
    #               "checked_out_at": iso, "source": "qr|tg|manual"}
    # Ошибки (кидаются доменными исключениями, транспорт маппит их сам):
    #   ValidationError                → HTTP 400 (битый/поддельный QR — только для QR-канала)
    #   QrRevokedError                 → HTTP 410 (QR отозван — только для QR-канала)
    #   ScanRateLimitError             → HTTP 429 (общий cooldown, см. ниже)
    #   IpNotAllowedError              → HTTP 403 (только для QR-канала при заданном whitelist)
    #   TgCheckinDisabledError         → HTTP 400 / бот отвечает подсказкой (при source="tg" и
    #                                     AttendanceSettings.tg_checkin_enabled=False)
    # Cooldown 30 сек — общий счётчик на оператора, не важно откуда пришёл запрос.

@transaction.atomic
def _attendance_check_in(*, operator, source, initiator, ip, user_agent, issue_token) -> dict: ...  # private
@transaction.atomic
def _attendance_check_out(*, log, source, initiator, ip, user_agent) -> dict: ...  # private

@transaction.atomic
def auto_close_open_logs(*, at: datetime | None = None) -> int: ...
    # Закрывает все AttendanceLog.checked_out_at IS NULL, auto_closed=True,
    # checked_out_at = at (или now). Инвалидирует token_key для каждого.
    # Возвращает count. Идемпотентна.

def morning_attendance_summary(day: date) -> dict: ...
    # Для TG-DM тимлиду: {present:[...], late:[...], absent:[...], counts}

@transaction.atomic
def attendance_log_close_manually(
    *,
    log: AttendanceLog,
    actor: User,
    note: str = "",
) -> AttendanceLog: ...
    # Закрывает открытую смену «руками» тимлида/менеджера.
    # Ставит checked_out_at=now(), manually_closed=True, manually_closed_by=actor,
    # инвалидирует token_key. Пишет audit_log_create(action="attendance.log_closed_manually",
    # meta={"note": note, "actor_id": actor.id}).
    # Ошибки:
    #   AlreadyClosedError → HTTP 409 (лог уже имеет checked_out_at)

@transaction.atomic
def attendance_long_shift_warn(*, log: AttendanceLog, now: datetime) -> dict: ...
    # Отправляет два DM: (1) оператору через привязанный telegram_user_id
    # (с inline-клавиатурой «Отметить уход» / «Нет, продолжаю»);
    # (2) team_lead оператора через Operator.team_lead.telegram_user_id.
    # Проставляет long_shift_warning_sent_at=now. Идемпотентна на уровне модели
    # (unique guard "long_shift_warning_sent_at IS NULL" в WHERE вызывающей команды).
    # Возвращает {"sent_to_operator": bool, "sent_to_team_lead": bool, "skipped_reason": str | None}.
    # Правила по получателям:
    #   - Нет TG у оператора → DM только TL с меткой «(нет TG у оператора)».
    #   - Нет team_lead → DM только оператору.
    #   - Ни того, ни другого → ничего не шлём, audit action="attendance.warning_skipped_no_recipients".

def attendance_period_report(
    *,
    date_from: date,
    date_to: date,
    operator: Operator | None = None,
) -> list[dict]: ...
    # Сводка по операторам за период. Возвращает список dict-ов:
    #   {operator_id, full_name, days_expected, days_present, days_late,
    #    avg_late_minutes, auto_closed_count, manually_closed_count,
    #    avg_shift_duration_min, heatmap: [{date, status}]}
    # status ∈ {"on_time","late","absent","dayoff"}.
    # dayoff вычисляется из AttendanceSettings (пока — фиксированные выходные;
    # если появится per-day график, расширим здесь без ломки контракта).

def attendance_period_report_xlsx(
    *,
    date_from: date,
    date_to: date,
    operator: Operator | None = None,
) -> bytes: ...
    # Тонкая обёртка над attendance_period_report + рендер xlsx через ту же
    # инфраструктуру, что используется существующими экспортами
    # (проверить в apps/sales/ — там уже есть openpyxl-хелперы; переиспользовать,
    # не заводить второй набор).
```

**Callback-хендлеры Telegram (в `apps/tg_bot/handlers/attendance.py`)** для inline-кнопок в long-shift DM:

- `callback_data="attendance:auto_checkout_confirm:<log_id>"` — вызывает `process_attendance_event(operator=op, source="tg", initiator=f"tg=@{u} id={uid} auto_checkout_confirm log={log_id}")`. По сути обычный TG-check-out, но инициирован из кнопки предупреждения. Ответ: «Хорошего вечера, {name}. Смена: HH:MM–HH:MM ({duration_min} мин).»
- `callback_data="attendance:continue_working:<log_id>"` — ставит `AttendanceLog.warning_dismissed_at = now()`, `cb.answer("Понял, работайте дальше.")`. Никаких изменений check_out. Повторное 10-часовое предупреждение по этому логу больше не шлётся (см. WHERE-условие в `attendance_long_shift_check` ниже).

Оба callback'а проверяют, что `log_id` принадлежит именно этому TG-user'у (иначе `cb.answer("Кнопка не для вас.", show_alert=True)`).

`qr_token_build` формат:
```
naffai-att-v1:<operator_id>:<nonce>:<hmac_hex_first_16>
```
HMAC = `hmac.new(QR_ATTENDANCE_HMAC_KEY.encode(), f"{operator_id}:{nonce}".encode(), sha256).hexdigest()[:16]`.

`qr_token_verify`:
- парсит, проверяет префикс версии → иначе `ValidationError` (HTTP 400);
- ищет `OperatorQr` по nonce → не найден → `ValidationError` (HTTP 400, generic message «неверный QR» — не раскрываем, есть ли такой nonce);
- если `revoked_at` не null → кастомное исключение `QrRevokedError` → маппится в HTTP 410;
- проверяет HMAC через `hmac.compare_digest` → иначе `ValidationError` (HTTP 400);
- возвращает `(operator, qr)`.

Rate-limit «1 успешный скан за 30 сек на оператора» — реализуется внутри `attendance_scan` до принятия решения check-in/out: `AttendanceLog.objects.filter(operator=op).order_by('-checked_in_at').first()`, смотрим `max(checked_in_at, checked_out_at or checked_in_at)` — если разница < 30 сек, кидаем `ScanRateLimitError` → HTTP 429.

IP-whitelist — реализуется middleware-free, прямо в `attendance_scan` через хелпер `_ip_allowed(ip)` на базе `ATTENDANCE_ALLOWED_NETWORKS` (список `ipaddress.ip_network(...)`). Пустой список → пропускаем всех.

### 3. Селекторы

`apps/attendance/selectors.py`:

```python
def open_log_for_operator(operator: Operator) -> AttendanceLog | None: ...
def logs_for_operator(operator: Operator, *, since: date, until: date) -> QuerySet: ...
def attendance_report(day: date) -> dict: ...
    # {"total_active_operators": N, "present": [...], "late": [...], "absent": [...]}
def attendance_settings_get() -> AttendanceSettings: ...  # get_or_create pk=1
def operator_qr_current(operator: Operator) -> OperatorQr | None: ...
def operator_qr_png_bytes(operator: Operator) -> bytes: ...
    # Использует qrcode[pil] для рендера PNG самого QR-payload (не URL, а сам naffai-att-v1:...).

def open_logs_awaiting_long_shift_warning(now: datetime) -> QuerySet: ...
    # AttendanceLog.objects.filter(
    #     checked_out_at__isnull=True,
    #     long_shift_warning_sent_at__isnull=True,
    #     checked_in_at__lte=now - timedelta(hours=settings.long_shift_warning_hours),
    # )
    # warning_dismissed_at здесь не в фильтре: dismissed никогда не был предупреждён,
    # но если оператор dismiss'нул — long_shift_warning_sent_at уже стоит, повтор не пойдёт.
```

### 4. API

`apps/attendance/apis.py` + `urls.py`, префикс `/api/attendance/`. Только `APIView`, ручная сериализация в plain dict.

**Публичное сканирование:**
- `POST /api/attendance/scan/` — permission `AllowAny`. Body `{ "qr_payload": "naffai-att-v1:..." }`. Response см. выше. Throttle: `AnonRateThrottle` scope `attendance_scan_ip`, 20 req/min per IP. IP-whitelist через `ATTENDANCE_ALLOWED_NETWORKS`. Аудит-запись на каждый вход (даже неудачный).

**Оператор — свои данные:**
- `GET /api/attendance/me/current/` — permission `IsAuthenticatedAnyRole`, оператор видит только своё → `{open_log: {...} | null, today_events: [...]}`.
- `GET /api/attendance/me/history/?from=YYYY-MM-DD&to=YYYY-MM-DD` — пагинированный список смен.
- `GET /api/me/attendance-qr.png` — permission `IsAuthenticatedAnyRole` (у оператора должна быть роль `OPERATOR`; TL/Manager, если у них нет привязанного `Operator`, → HTTP 404). Возвращает `image/png` — рендер текущего активного `OperatorQr` оператора. Cache-Control: `private, no-store`.

**TL/Manager — управление и отчёты:**
- `GET /api/attendance/report/?date=YYYY-MM-DD` (`IsTeamLead | IsManager`, read-only) → сводка на день (`present/late/absent`).
- `GET /api/attendance/today/` — алиас для `report/?date=today`, удобно для страницы `/attendance/today`.
- `GET /api/attendance/operators/{id}/logs/?from=&to=` — смены оператора.
- `GET /api/attendance/operators/{id}/qr/` — данные текущего QR (nonce short, created_at, revoked_at).
- `POST /api/attendance/operators/{id}/qr/rotate/` (`IsTeamLead`) — новая nonce, старая revoked. Response `{qr: {...}, png_url}`.
- `GET /api/attendance/operators/{id}/qr.png` (`IsTeamLead | IsManager`) — PNG чужого оператора (для распечатки TL'ом).
- `GET /api/attendance/settings/` / `PATCH /api/attendance/settings/` (`IsTeamLead`) — singleton. PATCH принимает в том числе `long_shift_warning_hours` (int 1..24).
- `POST /api/attendance/logs/<log_id>/close/` (`IsTeamLead | IsManager`) — ручное закрытие смены. Body: `{"note": "optional TL comment"}`. Действие: если `checked_out_at IS NULL` → `attendance_log_close_manually(log=..., actor=request.user, note=...)`, возвращает обновлённый лог. Если лог уже закрыт → HTTP 409 Conflict `{"error": "already_closed"}`. Оператору эндпоинт недоступен (permission гейт возвращает 403 в том числе на попытку закрыть собственный лог — операторы закрывают смены только сканом QR или через TG).
- `GET /api/attendance/report/?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&operator=<id>&format=json|xlsx` (`IsTeamLead | IsManager`) — сводный отчёт за период. Формат по умолчанию `json` — массив объектов из `attendance_period_report(...)`. `format=xlsx` → `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, файл через `attendance_period_report_xlsx(...)`. Фильтр `operator` необязательный — при отсутствии агрегирует по всем активным операторам. Диапазон дат обязательный; максимум 92 дня (защита от неограниченных запросов), иначе HTTP 400 `{"error": "range_too_large"}`.

Все ответы — плоские dict через `Response(...)`. Никаких `ModelViewSet`, никаких `ModelSerializer` — сериализация вручную по образцу `MeApi`.

### 4a. Альтернативный канал — Telegram-бот

QR-скан на рабочей станции — основной способ. TG-бот — **альтернативный канал подтверждения** для случаев «в дороге», «забыл бейдж», «сломалась камера». Оба канала пишут в один и тот же `AttendanceLog` через один и тот же сервис-слой; разница только в транспорте и в поле `source`.

**Флоу оператора:**
- Оператор пишет боту `/checkin` (или нажимает inline-кнопку «Отметить приход» в утреннем DM — см. ниже).
- Бот берёт `message.from_user.id`, ищет привязанного оператора через существующую систему `link_operator` в `apps/tg_bot/` (FSM `LinkOperator` и хранение `telegram_user_id` на `Operator` уже реализованы — реюзаем как есть, ничего нового не изобретаем).
- Если оператор не привязан → бот отвечает «Сначала привяжите аккаунт: /link_operator» и завершается. `AttendanceLog` не создаётся.
- Если привязан → бот вызывает `process_attendance_event(operator=op, source="tg", initiator=f"tg=@{msg.from_user.username or '-'} id={msg.from_user.id}", issue_token=False)` — тот же сервис, что и HTTP endpoint `/api/attendance/scan/`. Одна точка правды, два транспорта.
- Ответ бота:
  - На check-in: «Доброе утро, {name}. Отмечен приход в HH:MM.» + строкой ниже «Опоздание: N мин.», если `was_late=True`.
  - На check-out: «До завтра, {name}. Смена: HH:MM–HH:MM ({duration_min} мин).»
  - На cooldown (второй /checkin в пределах 30 сек, в том числе если сначала был скан QR на рабочей станции): «Подождите 30 секунд.»
  - На отсутствие привязки: «Сначала привяжите аккаунт: /link_operator».
  - На отключённый канал (см. флаг ниже): «Отметка через Telegram отключена. Используйте QR на рабочей станции.»

**Команды бота:**
- `/checkin` — единая точка входа: если открытой смены нет → check-in; если есть → **не** делаем неявный check-out (чтобы не путать оператора), а отвечаем «Смена уже открыта в HH:MM. Для завершения используйте /checkout.»
- `/checkout` — принудительно закрывает смену; если смены нет → «Вы сегодня не отмечались. Отметьтесь по QR или командой /checkin.»
- `/status` — «Вы на смене с HH:MM, работаете Nч Mмин.» или «Вы не на смене.» (селектор `open_log_for_operator`, никакой мутации).

**CRM-сессия — принципиально не выдаём через TG:**
- Через TG невозможно надёжно связать telegram-чат с рабочим браузером оператора (в отличие от QR-скана, где сканирование происходит на том же устройстве, где будет сессия). Никаких «claim-кодов» — это ровно то, чего мы избегали в основном флоу.
- TG check-in фиксирует **только присутствие**. Логин в CRM оператор делает обычным путём (пароль или QR на рабочем месте).
- Поэтому `process_attendance_event(..., source="tg", issue_token=False)` — токен не создаётся, поле `token_key` в `AttendanceLog` остаётся пустым, `Token.objects.get_or_create` не дёргается.

**Rate-limit и защита:**
- 30-сек cooldown на оператора — **общий счётчик** через сервис. Не важно, откуда пришёл запрос (HTTP или TG) — cooldown единый, потому что считается по `AttendanceLog` конкретного оператора (см. `attendance_scan` в разделе 2). Тест `test_tg_rate_limit_shared_with_http` это проверяет.
- IP-whitelist `ATTENDANCE_ALLOWED_NETWORKS` **не применяется к TG-каналу** — у бота нет IP оператора. Это осознанный trade-off: TG-канал менее строгий по сети, но привязан к личному Telegram-аккаунту (link_operator подтверждает владение аккаунтом через код), что уже вето.
- Флаг `AttendanceSettings.tg_checkin_enabled` (BooleanField, default=True). Если False — сервис кидает `TgCheckinDisabledError`, бот отвечает «Отметка через Telegram отключена…», `AttendanceLog` не создаётся. Флаг переключается тимлидом через тот же `PATCH /api/attendance/settings/`.
- Аудит-запись пишется точно так же, как для QR: `apps/audit/services.audit_log_create` с `action="attendance.scan_ok"` / `attendance.scan_fail`, `meta["source"]="tg"`, `meta["initiator"]="tg=@ivan id=12345"`. В `meta` НЕ кладём текст сообщения — только источник, tg_user_id и результат.

**Утреннее уведомление с inline-кнопкой:**
- Существующий утренний DM оператору (`apps/lessons/deliver_daily_lessons` или утренний runner в `apps/greetings/` — использовать тот, что уже шлёт утренний summary; **не** плодить второй) расширяется: в шапку сообщения (перед summary урока) добавляется inline-клавиатура с одной кнопкой «Отметить приход».
- Клик → `CallbackQuery` c `data="attendance:checkin"` → тот же handler, что и `/checkin` (тонкая обёртка над `process_attendance_event`).
- Вечернее сообщение с кнопкой «Отметить уход» — **только если оно уже существует**. Если сейчас вечернего DM нет, отдельного ради этого не заводим (out of scope этой волны).

**Реализация в коде (руководство для builder-агента):**
- Убедиться, что `process_attendance_event(...)` в `apps/attendance/services.py` вынесен как отдельная функция и `attendance_scan` — тонкая обёртка над ним (см. раздел 2). Если бизнес-логика check-in/out сидит внутри HTTP-view — рефакторить в сервис до начала работы над TG-каналом.
- Новый модуль `apps/tg_bot/handlers/attendance.py` (создать директорию `handlers/` и `__init__.py`, если её ещё нет; сейчас у бота все хендлеры сидят в `runner.py` — можно оставить и там, но новый файл чище). Содержит:
  - `cmd_checkin(msg: Message)`
  - `cmd_checkout(msg: Message)`
  - `cmd_status(msg: Message)`
  - `cb_attendance_checkin(cb: CallbackQuery)`
  - Каждый — тонкий wrapper: находит `Operator` по `telegram_user_id` (через существующий селектор), вызывает `process_attendance_event(...)` в `asyncio.to_thread(...)` (ORM синхронный), ловит доменные исключения, шлёт ответное сообщение через `msg.answer(...)` / `cb.message.answer(...)` + `cb.answer()`.
- Регистрация handler'а в `apps/tg_bot/runner.py` — по образцу существующего `cmd_link_operator` (см. `runner.py:787`): `@dp.message(Command("checkin"))`, `@dp.message(Command("checkout"))`, `@dp.message(Command("status"))`, `@dp.callback_query(F.data == "attendance:checkin")`.
- Расширение утреннего DM: найти место, где формируется утреннее сообщение оператору, и передать `reply_markup=InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="Отметить приход", callback_data="attendance:checkin")]])`. Только для операторов; для TL/manager кнопку не показывать.

**Env / настройки** — новых переменных **не добавляем**. Всё управление через `AttendanceSettings.tg_checkin_enabled`.

### 5. Frontend

**Хук `useAttendanceScan(payload)`** — общий фронт-хелпер в `frontend/src/hooks/useAttendanceScan.ts`. Умеет: (a) взять raw QR-payload, (b) вызвать `POST /api/attendance/scan/`, (c) при `action=check_in` — сохранить токен через `useAuth.setAuth(...)`, (d) вернуть `{action, operator, was_late?, duration_min?}` или ошибку. Используется на `/scan` и на превью в `/profile`.

**Новая страница `/scan` (`frontend/src/pages/Scan.tsx`)** — публичная, БЕЗ `Protected`, БЕЗ `Layout`. Отдельный минималистичный шаблон на весь экран.

Состояния:
1. **Idle**: центрированный блок «Сканирование QR для входа». Большая кнопка «Включить камеру» → `getUserMedia({video: true})`. Если пользователь отклонил permission — показать инструкцию «Разрешите доступ к камере в настройках браузера» + ссылку «Войти по паролю» → `/login`.
2. **Scanning**: `<div id="qr-reader">` от `html5-qrcode`, `Html5QrcodeScanner`, `fps: 10`, `qrbox: 250`. Инструкция снизу «Поднесите ваш QR к камере». Кнопка «Отмена» → возвращает в Idle и вызывает `scanner.clear()`.
3. **Success — check-in**: зелёная плашка «Добро пожаловать, {name}. Смена открыта.» (+ жёлтая пометка «Вы опоздали на N мин», если `was_late`). Через 1.5 сек `navigate('/')`.
4. **Success — check-out**: синяя плашка «До завтра, {name}. Смена: HH:MM.». Через 2 сек `navigate('/scan')` (страница сама возвращается в Idle, оператор физически уже уходит).
5. **Errors**: 410 → «QR отозван, обратитесь к тимлиду»; 400 → «Неверный QR»; 429 → «Слишком часто, подождите 30 секунд»; 403 → «Сканирование недоступно с этого IP»; network → «Нет связи с сервером». В каждом случае — кнопка «Попробовать ещё раз».

Верхний правый угол: тонкая ссылка «Войти по паролю» → `/login`.

**Изменение `Login.tsx`**: над формой phone+password — крупная кнопка-CTA «Войти по QR» → `navigate('/scan')`. Форма пароля остаётся как fallback (для TL/Manager и на случай сломанной камеры).

**Изменение `Profile.tsx`** — новая секция «Мой QR для входа»:
- Заголовок + короткий текст «Отсканируйте этот QR на странице сканирования, чтобы войти в CRM и открыть смену».
- Крупный QR (в px, не svg) через `<img src="/api/me/attendance-qr.png" />`.
- Строка «Обновлён {date}» (по `OperatorQr.created_at`).
- Кнопки: «Скачать PNG» (anchor с `download="my-qr.png"` на тот же URL), «Распечатать» (открывает printable-модалку с CSS `@media print` — на печатной странице остаются только имя оператора + QR + строчка «naffAI · внутренний идентификатор»).
- Если у пользователя нет привязанного `Operator` (TL без своего Operator-профиля) — секция скрыта.

**Новая страница `/attendance/today` (`frontend/src/pages/AttendanceToday.tsx`, для TL/Manager)**:
- Верх: DatePicker (default today) + KPI-плашки: На месте / Опоздали / Не пришли (`KpiCard`).
- Таблица операторов: имя | пришёл (HH:MM) | ушёл (HH:MM или «на смене» или «auto_closed 23:00») | длительность | опоздание (+N мин / —) | статус-бейдж.
- Статус-бейдж для строк с закрытой сменой:
  - `auto_closed=True` → жёлтый бейдж «авто» (иконка часов, tooltip «Закрыто ночным cron в 23:00 — оператор забыл отметить уход»).
  - `manually_closed=True` → синий бейдж «TL» (иконка человека, tooltip «Закрыто вручную {manually_closed_by.full_name}»).
  - Оба False → без бейджа.
- В строке каждого «на смене» оператора — кнопка «Закрыть смену вручную» (только TL/Manager видит). Клик → confirm-модалка с textarea «Комментарий (опционально)» + двумя кнопками «Отмена» / «Закрыть». Submit → `POST /api/attendance/logs/<id>/close/` c `{note}` → на успехе рефреш строки; на 409 → тост «Смена уже закрыта».
- Ссылка «История посещаемости» → `/attendance?tab=history` — контент меняется на пагинированную таблицу всех смен за выбранный период.
- Ссылка «Отчёт за период» → `/attendance/report`.

**Новая страница `/attendance/report` (`frontend/src/pages/AttendanceReport.tsx`, для TL/Manager)**:
- Фильтры: пресеты «Неделя» / «Месяц» / «Кастом» (диапазон), select оператора (или «все»), кнопка «Экспорт в Excel».
- Основная таблица (одна строка на оператора):
  - Оператор | Явок / должно | Опозданий | Ср. опоздание (мин) | auto-closed (кол-во) | manually-closed (кол-во) | Ср. длительность смены (ч:мин).
  - Auto-closed кол-во ≥ 1 подсвечивается красной цифрой (сигнал «забывает выходить»), manually-closed — синим.
- Ниже таблицы для каждого оператора — heatmap-полоска на 30 дней (или на выбранный диапазон, максимум 92 клетки): зелёная клетка (был вовремя), жёлтая (опоздал), красная (не пришёл), серая (выходной). При hover — tooltip с датой и статусом.
- Кнопка «Экспорт в Excel» → `GET /api/attendance/report/?...&format=xlsx` → скачивание файла (использует существующий фронт-хелпер для xlsx-download из `apps/sales/`-паттерна на фронте, не изобретать заново).

**Изменение `OperatorDetail.tsx`** — новая секция «Посещаемость»:
- Верх: текущий статус («На смене с 10:03» или «Не на смене»). Если статус «На смене» и роль зрителя TL/Manager — рядом кнопка «Закрыть смену вручную» (та же confirm-модалка с textarea, что и на `/attendance/today`).
- Сводка по этому оператору за выбранный период (те же цифры из `attendance_period_report`, отфильтрованные по одному оператору): дней явился / должен был, опозданий, ср. опоздание, auto-closed, manually-closed, ср. длительность.
- Мини-таблица за последние 30 дней: дата | пришёл | ушёл | длительность | опоздание | статус-бейдж (те же «авто» / «TL» / без бейджа, что и на `/attendance/today`).
- В строках истории, где смена ещё открыта (обычно текущий день) — та же кнопка «Закрыть смену вручную» для TL/Manager. Оператор эти кнопки не видит вообще.
- Блок «QR оператора»: строка «Создан {date}, nonce {short_first_6}...», кнопка «Скачать PNG» (GET `/api/attendance/operators/{id}/qr.png`, роль TL/Manager), кнопка «Ротировать QR» (только TL, confirm-модалка «Старый QR перестанет работать. Продолжить?» → POST → обновить UI).

**Изменение `Layout.tsx`**:
- В `TEAM_LEAD_ITEMS` (и `MANAGER_ITEMS`) добавить `{ to: "/attendance/today", label: "Посещаемость" }` и `{ to: "/attendance/report", label: "Отчёт посещаемости" }` (можно свернуть в подпункт, если layout это поддерживает).
- Для оператора — маленький индикатор в футере sidebar: зелёная точка + «Смена открыта в 10:12» или серая + «Смена не открыта». Запрос `GET /api/attendance/me/current/`, `staleTime: 30s`.

**Изменение `App.tsx`** — новые routes:
- `<Route path="/scan" element={<Scan />} />` (БЕЗ `Protected`, БЕЗ `Layout`).
- `<Route path="/attendance/today" element={<RoleGate allow={["manager","team_lead"]}><AttendanceToday /></RoleGate>} />`.
- `<Route path="/attendance/report" element={<RoleGate allow={["manager","team_lead"]}><AttendanceReport /></RoleGate>} />`.

**Изменение логаута**: в `useAuth.logout()` — если у пользователя есть открытый `AttendanceLog` (по данным `/attendance/me/current/`), показать confirm-модалку «У вас открыта смена. Закрыть смену при выходе?» → yes: вызывать `POST /api/attendance/scan/` виртуально не можем (нужен QR), поэтому просто разлогинить обычным способом и предупредить, что смена останется открытой (автозакроется в 23:00). Более чистый вариант — отдельный эндпоинт `POST /api/attendance/me/check-out/` (auth-required, без QR — оператор доверяет самому себе), но это отдельное решение; для v1 просто показываем предупреждение.

**Зависимости фронта:**
- `html5-qrcode` — добавить в `package.json`.

### 6. Management commands

`apps/attendance/management/commands/attendance_auto_close.py`:
```
python manage.py attendance_auto_close [--at YYYY-MM-DDTHH:MM] [--dry-run]
```
Идемпотентна. По умолчанию закрывает все `AttendanceLog.checked_out_at IS NULL` временем `now()`. Печатает количество, инвалидирует токены сессий (`Token.objects.filter(key__in=[...]).delete()`).

`apps/attendance/management/commands/attendance_morning_report.py`:
```
python manage.py attendance_morning_report [--date YYYY-MM-DD]
```
Собирает `morning_attendance_summary(day)` и шлёт TG-DM тимлиду (все `Profile.role=team_lead` с непустым `telegram_user_id`).

`apps/attendance/management/commands/backfill_operator_qrs.py`:
```
python manage.py backfill_operator_qrs [--force]
```
Для всех активных операторов без активного `OperatorQr` — создаёт новый со случайной nonce. Идемпотентна. `--force` — ротирует всем (используется при смене `QR_ATTENDANCE_HMAC_KEY`).

`apps/attendance/management/commands/attendance_long_shift_check.py`:
```
python manage.py attendance_long_shift_check [--now YYYY-MM-DDTHH:MM] [--dry-run]
```
Находит открытые `AttendanceLog`, где `checked_in_at <= now - AttendanceSettings.long_shift_warning_hours` и `long_shift_warning_sent_at IS NULL` (селектор `open_logs_awaiting_long_shift_warning(now)`). Для каждого — вызывает `attendance_long_shift_warn(log=..., now=...)`, который шлёт DM оператору (inline-кнопки «Отметить уход» / «Нет, продолжаю»), DM team_lead'у (без кнопок, только уведомление) и проставляет `long_shift_warning_sent_at=now`. Идемпотентна: повторный прогон не шлёт вторую пачку по тому же логу. При `--dry-run` — только печатает, кому бы отправила.

Порог 10 часов берётся из `AttendanceSettings.long_shift_warning_hours` (по умолчанию 10). Threshold auto-close в 23:00 остаётся отдельным механизмом (команда `attendance_auto_close`, timer `naff-attendance-auto-close.timer`) — long-shift-warning ничего в нём не меняет.

### 7. Systemd timers на VPS

Три новые пары timer/service в `deploy/systemd/`:

**`naff-attendance-auto-close.timer`** — 23:00 Asia/Tashkent.
**`naff-attendance-morning-report.timer`** — 10:15 Asia/Tashkent.
**`naff-attendance-long-shift-check.timer`** — каждые 30 минут (`OnCalendar=*:00/30`, `Persistent=true`, чтобы после аптайма догнало пропущенные тики). Запускает `python manage.py attendance_long_shift_check`. Лог: `/var/log/naffAI/attendance-long-shift-check.log`.

Все три по образцу существующих `naff-daily-lessons-*` (тот же `WorkingDirectory=/opt/naffAI`, тот же `EnvironmentFile`, лог в `/var/log/naffAI/attendance-*.log`).

Плюс обновить `deploy/deploy.sh` — установить/перезапустить все три таймера.

### 8. Настройки / env

В `backend/config/settings/base.py`:

```python
QR_ATTENDANCE_HMAC_KEY = config("QR_ATTENDANCE_HMAC_KEY", default="")
ATTENDANCE_ALLOWED_NETWORKS = config(
    "ATTENDANCE_ALLOWED_NETWORKS",
    default="",
    cast=lambda v: [s.strip() for s in v.split(",") if s.strip()],
)
ATTENDANCE_SCAN_COOLDOWN_SECONDS = config("ATTENDANCE_SCAN_COOLDOWN_SECONDS", default=30, cast=int)

REST_FRAMEWORK.setdefault("DEFAULT_THROTTLE_RATES", {})
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["attendance_scan_ip"] = "20/min"
```

В `.env.example` — добавить:
```
QR_ATTENDANCE_HMAC_KEY=  # secrets.token_urlsafe(48)
ATTENDANCE_ALLOWED_NETWORKS=  # empty in dev; в проде, например: 10.0.0.0/24,192.168.1.0/24
ATTENDANCE_SCAN_COOLDOWN_SECONDS=30
```

При пустом `QR_ATTENDANCE_HMAC_KEY` — сервисы `qr_token_build/verify` кидают `ImproperlyConfigured` при первом вызове (не при импорте — иначе развалятся миграции).

### 9. Security model — фиксация

- **QR**: HMAC-SHA256 (первые 16 hex-символов) от `operator_id:nonce`, ключ `QR_ATTENDANCE_HMAC_KEY` в `.env` (никогда в git). Сравнение через `hmac.compare_digest`.
- **Nonce**: 16 hex-байт из `secrets.token_hex(16)`. При ротации — новая nonce, старая помечается `revoked_at`. Отозванный QR → HTTP 410 Gone.
- **Session token**: обычный DRF `Token`, привязан к `User` оператора. При чек-ауте — `Token.objects.filter(key=log.token_key).delete()` инвалидирует сессию на этом устройстве. Обычный логин по паролю выдаёт тот же ключ токена (у DRF `Token` OneToOne с юзером), поэтому чек-аут инвалидирует и его — это ок, оператор точно уходит домой.
- **IP whitelist**: `ATTENDANCE_ALLOWED_NETWORKS` (CSV of CIDR) проверяется в сервисе через `ipaddress.ip_address(ip) in ipaddress.ip_network(cidr)`. Пустой список → пропускаем всех (dev-режим).
- **Per-operator cooldown**: 30 сек между успешными сканами одного оператора (защита от двойного скана). Считается на уровне сервиса по `AttendanceLog`, без Redis.
- **Rate limit по IP**: `AnonRateThrottle` scope `attendance_scan_ip` = 20/min. Достаточно, чтобы не дать перебирать битые QR.
- **Аудит**: `audit_log_create` на каждый вход в `attendance_scan` — success (action=`attendance.scan_ok`) и fail (action=`attendance.scan_fail`, meta включает `error_code` типа `bad_hmac`/`revoked`/`rate_limited`, но НЕ включает сам `qr_payload`).
- **PII**: в audit-логах не пишем `qr_payload`, `token_key`, `hmac`. Scrub-регекс в `apps/audit/services.py` уже покрывает `token/secret` — проверить, что `qr` тоже в blacklist, если нет — добавить.
- **PNG endpoint** `/api/me/attendance-qr.png`: `Cache-Control: private, no-store`, `Content-Disposition: inline`.

### 10. Тесты

`apps/attendance/tests/`:

**Юниты сервисов:**
- `test_qr_signing.py` — build → verify roundtrip; неверный HMAC → 400; неверный префикс → 400; отозванный QR → 410; unknown nonce → 400 (generic).
- `test_operator_qr_rotate.py` — старый становится revoked, новый уникален, audit-запись создана.
- `test_scan_check_in_creates_log.py` — первый скан за день → 1 `AttendanceLog` (open), возвращён token, `was_late=False` при раннем чек-ине.
- `test_scan_check_out_closes_log.py` — второй скан → `checked_out_at` заполнен, `duration_seconds > 0`, `token_key` удалён из `Token`.
- `test_scan_rate_limited.py` — два скана подряд < 30 сек → второй HTTP 429.
- `test_scan_revoked_qr_returns_410.py` — сканирование ротированного QR → 410.
- `test_scan_invalid_hmac_returns_400.py` — подделанный HMAC → 400.
- `test_scan_office_ip_whitelist.py` — с не-офисного IP при заданном `ATTENDANCE_ALLOWED_NETWORKS` → 403; при пустом whitelist → ok.
- `test_scan_late_marks_was_late.py` — `shift_start=10:00`, `late_threshold_min=15`: скан в 10:14 → `was_late=False`; скан в 10:16 → `was_late=True`.
- `test_auto_close_command_closes_open_logs.py` — 3 открытых лога → команда `attendance_auto_close` закрывает все три, `auto_closed=True`, `checked_out_at` = `--at`, токены инвалидированы.
- `test_morning_report_shape.py` — селектор `attendance_report(day)` возвращает правильные счётчики (present/late/absent).

**Юниты API:**
- `test_qr_png_endpoint_returns_own_only.py` — оператор A видит только свой QR через `/api/me/attendance-qr.png`; не может через `/api/attendance/operators/{B_id}/qr.png` (403).
- `test_rotate_qr_creates_new_nonce_and_revokes_old.py` — TL через API ротирует → старый `revoked_at` заполнен, новый активен и уникален.
- `test_api_operator_sees_only_own.py` — оператор X дёргает `/api/attendance/operators/Y/logs/` → 403.
- `test_api_settings_singleton.py` — PATCH создаёт/обновляет одну строку, второй PATCH не создаёт вторую.
- `test_api_rate_limit_scan_ip.py` — 21-й запрос на `/scan/` за минуту с одного IP → 429.

**TG-канал (`apps/tg_bot/tests/test_attendance_handlers.py` или `apps/attendance/tests/test_tg_channel.py`):**
- `test_tg_checkin_creates_log` — привязанный оператор (Operator с `telegram_user_id=12345`) шлёт `/checkin` → создаётся `AttendanceLog` с `source="tg"`, `token_key=""`, бот отвечает welcome-сообщением. Aiogram замокан (фиктивный `Message` + `bot.send_message` — spy).
- `test_tg_checkin_not_linked_returns_hint` — TG user_id, не привязанный ни к одному оператору → бот отвечает «Сначала привяжите аккаунт: /link_operator» и `AttendanceLog.objects.count() == 0`.
- `test_tg_checkout_closes_log` — сначала `/checkin` (создан открытый лог), затем `/checkout` → лог закрыт, `checked_out_at` заполнен, `duration_seconds > 0`, ответ бота содержит `duration_min`.
- `test_tg_checkout_without_open_log_returns_hint` — `/checkout` без открытой смены → бот отвечает «Вы сегодня не отмечались…» и ничего не создаёт.
- `test_tg_disabled_by_settings` — `AttendanceSettings.tg_checkin_enabled=False` → `/checkin` от привязанного оператора → бот отвечает «Отметка через Telegram отключена…», `AttendanceLog` не создаётся, аудит-запись `attendance.scan_fail` с `meta.error_code="tg_disabled"`.
- `test_tg_rate_limit_shared_with_http` — сначала HTTP `POST /api/attendance/scan/` (check-in по QR), сразу за ним `/checkin` в TG от того же оператора (в пределах 30 сек) → второй попадает в общий cooldown, бот отвечает «Подождите 30 секунд», второго `AttendanceLog` не создано.
- `test_tg_status_reports_open_shift` — открытая смена с `checked_in_at=10:03` → `/status` → бот отвечает «Вы на смене с 10:03…».
- `test_tg_source_field_persisted` — после `/checkin` в БД `AttendanceLog.source == "tg"`; после HTTP scan — `"qr"`.

**Аудит:**
- `test_audit_no_secret_leak.py` — после scan/rotate: ни в одной `AuditLog.changes/meta` нет ключей `qr`, `qr_payload`, `hmac`, `password`, `secret`, `token`, `token_key`.
- `test_audit_source_recorded` — после HTTP scan `meta["source"]=="qr"`; после TG `/checkin` `meta["source"]=="tg"` и `meta["initiator"]` содержит `tg_user_id`.

**Long-shift warning + ручное закрытие + отчёт:**
- `test_long_shift_warning_command_sends_dms` — открытый лог 10ч+ без warning → команда `attendance_long_shift_check` шлёт 2 DM (оператору с inline-клавиатурой из двух кнопок + team_lead без клавиатуры), проставляет `long_shift_warning_sent_at`. `apps/tg_bot/notify.py` замокан, проверяем аргументы вызовов.
- `test_long_shift_warning_not_re_sent` — второй прогон команды на том же логe не шлёт повторно, счётчик отправок = 1.
- `test_long_shift_warning_no_tg_operator_notifies_tl_only` — у оператора пусто в `telegram_user_id` → шлём только TL с меткой «(нет TG у оператора)» в тексте DM. `long_shift_warning_sent_at` всё равно проставлен.
- `test_long_shift_warning_no_tl_notifies_operator_only` — у оператора `team_lead=None` → шлём только оператору, DM для TL не отправляется.
- `test_long_shift_warning_no_recipients_audit` — ни TG у оператора, ни team_lead → ничего не шлём, есть audit-запись `attendance.warning_skipped_no_recipients`, `long_shift_warning_sent_at` всё равно проставлен (чтобы не долбить пустотой каждые 30 мин).
- `test_operator_confirms_auto_checkout_via_callback` — оператор нажал «Отметить уход» (callback `attendance:auto_checkout_confirm:<log_id>`) → лог закрыт, `checked_out_at` заполнен, `source="tg"`, `manually_closed=False`, `auto_closed=False`, ответ бота содержит длительность смены.
- `test_operator_dismisses_warning_no_repeat` — оператор нажал «Нет, продолжаю» (callback `attendance:continue_working:<log_id>`) → `warning_dismissed_at` заполнен, лог остаётся открытым, повторный прогон `attendance_long_shift_check` не шлёт новое DM.
- `test_long_shift_callback_foreign_log_rejected` — TG user попытался нажать callback с чужим `log_id` → `cb.answer("Кнопка не для вас.", show_alert=True)`, лог не тронут.
- `test_manual_close_endpoint_closes_log` — TL `POST /api/attendance/logs/<id>/close/` с `{"note":"тестовый"}` → 200, лог закрыт: `checked_out_at≈now`, `manually_closed=True`, `manually_closed_by=<tl_user>`, `auto_closed=False`. Audit `attendance.log_closed_manually` с `meta.note=="тестовый"`.
- `test_manual_close_by_operator_forbidden` — оператор (роль OPERATOR) POST на свой или чужой открытый лог → HTTP 403, лог не тронут.
- `test_manual_close_already_closed_returns_409` — лог с непустым `checked_out_at` → POST → 409 `{"error":"already_closed"}`, поля не меняются, audit не пишется.
- `test_manual_close_invalidates_token` — при ручном закрытии `token_key` инвалидируется (`Token.objects.filter(key=old_key).exists() == False`).
- `test_report_endpoint_returns_period_stats` — 3 оператора с разной посещаемостью за 7 дней → `GET /api/attendance/report/?date_from=...&date_to=...` возвращает корректные `days_expected`, `days_present`, `days_late`, `avg_late_minutes`, `auto_closed_count`, `manually_closed_count`, `avg_shift_duration_min` на каждого.
- `test_report_endpoint_filter_by_operator` — `?operator=<id>` → в ответе только один оператор.
- `test_report_endpoint_range_too_large` — диапазон > 92 дней → HTTP 400 `{"error":"range_too_large"}`.
- `test_report_endpoint_permission` — оператор → 403.
- `test_report_xlsx_export` — `?format=xlsx` возвращает `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, файл открывается openpyxl'ом, есть заголовки колонок и хотя бы одна строка данных.

**Регресс:**
- Прогнать существующую сюиту. Не менее чем текущее число `passed` после мержа.

### 11. Наблюдаемость

- Каждый ExecStart systemd-таймера пишет в отдельный лог (`/var/log/naffAI/attendance-auto-close.log`, `.../attendance-morning-report.log`).
- В `apps/common/health.py` — расширить healthcheck: количество открытых логов за вчера, которые НЕ закрылись автозакрытием (если >0 после 23:30 — WARN).
- `django-admin` — зарегистрировать `OperatorQr`, `AttendanceLog`, `AttendanceSettings`. Фильтры по дате, оператору, `auto_closed`, `was_late`.

---

## Что НЕ делаем (out of scope)

- **Никаких kiosk-устройств, kiosk-user'ов, kiosk-токенов и enroll-QR.** Сканирование происходит на рабочей станции оператора — той же, где будет работать.
- **Никаких claim-кодов и промежуточных экранов** — сессия создаётся ровно там, где сканирует камера.
- Никакой биометрии. Никакого распознавания лиц.
- Никакого geofencing / GPS-подтверждения. IP-whitelist — единственная сетевая проверка.
- Никакой интеграции с турникетами / физическими замками.
- Никаких индивидуальных графиков смен для операторов (только офисное расписание).
- Никакого учёта перерывов / обеденных сессий (одна смена в день, ок для MVP).
- Никакого влияния посещаемости на payroll в этой волне. Только отдельный отчёт.
- Никакой мобильной apps-обёртки для оператора — QR печатается / сохраняется в галерее и живёт неопределённо долго.
- Никакого «уведомлять TL при опоздании конкретного оператора в реальном времени». Только утренняя сводка + вечерняя сводка авто-закрытий.
- Никакой автоматической генерации QR при создании оператора — на первом заходе в `/profile` PNG-эндпоинт сам создаст `OperatorQr` через `get_or_create`. Плюс есть `backfill_operator_qrs`.
- Никакого «удалить лог» из UI. `AttendanceLog` иммутабельны для операционного персонала. TL может исправить время только через `django-admin` (с аудитом).
- Никакой ежедневной ротации QR — один статический QR на оператора, ротация только по требованию TL.
- **TG check-in не выдаёт CRM-сессию.** Не связываем TG-канал с автоматическим логином в веб-CRM — оператор всё равно логинится обычным путём (пароль или QR на рабочем месте). Обоснование: невозможно надёжно связать telegram-чат с браузером на рабочей станции без промежуточных claim-кодов, а от них мы уже отказались в основном флоу.
- **Никакого geofencing / проверки координат отправителя в TG.** Location в Telegram легко спуфится, а офис-IP уже даёт нужный уровень контроля для QR-канала. TG-канал полагается на факт владения личным Telegram-аккаунтом (через `link_operator`).
- **Никаких WhatsApp / SMS / других мессенджеров для check-in.** Только Telegram, потому что вся инфраструктура бота (link_operator FSM, aiogram runner, notify.py) уже в проекте. Расширение на другие каналы — отдельная волна, если реально понадобится.
- **Не шлём long-shift warning раньше 10 часов.** Даже если TL хочет 8 — пусть меняет через `AttendanceSettings.long_shift_warning_hours` (валидатор 1..24). Хардкод 10ч в коде запрещён.
- **Не пытаемся автоматически «догадаться», когда оператор реально ушёл.** Auto-close и ручное закрытие всегда ставят `checked_out_at = now()` в момент закрытия (23:00 для auto-close, момент клика TL для manual). Обратное — эвристика по «последней активности в CRM» / IP-отключению — было бы враньём в статистику; лучше честный «auto_closed» флаг.
- **Не эскалируем выше DM.** Если оператор не ответил на long-shift warning ни кнопкой, ни `/checkout` — звонок / SMS / повторный DM через час не шлём. Единственная реакция — оставляем открытый лог до 23:00, где его подберёт `attendance_auto_close`. Более агрессивная эскалация — off scope.
- **Ручное закрытие смены недоступно операторам через API.** Даже свою смену оператор может закрыть только сканом QR или командой в TG. Кнопка «Закрыть смену вручную» рендерится только для ролей TL/Manager. Обоснование: manual-close ставит `manually_closed=True` с автором из request.user — это «TL закрыл руками», семантически другое событие, чем обычный check-out самим оператором. Смешивать нельзя.

---

## Порядок работы для builder-агента

1. **Модели + миграция**: `apps/attendance/models.py` (`OperatorQr`, `AttendanceLog`, `AttendanceSettings`) + миграция + admin.py.
2. **Сервисы + селекторы**: `services.py` (все функции из раздела 2) + `selectors.py`. Юниты сервисов зелёные до перехода к API.
3. **API + urls**: `apis.py` (все эндпоинты из раздела 4) + `urls.py` + подцепить в `config/api_urls.py` как `path("attendance/", include("apps.attendance.urls"))`. Также добавить `path("me/attendance-qr.png", ...)` в общий me-роутер (или разместить в `apps/users/apis.py` — по стилю проекта). Throttle scope в base settings.
4. **Env**: добавить `QR_ATTENDANCE_HMAC_KEY`, `ATTENDANCE_ALLOWED_NETWORKS`, `ATTENDANCE_SCAN_COOLDOWN_SECONDS` в `.env.example` + прод-`.env` на VPS (генерить `secrets.token_urlsafe(48)`). Если `QR_ATTENDANCE_HMAC_KEY` пуст — `ImproperlyConfigured` при первом вызове.
5. **Management commands**: `attendance_auto_close`, `attendance_morning_report`, `backfill_operator_qrs`. Тесты идемпотентности.
6. **Systemd**: два новых пары `.timer + .service` в `deploy/systemd/`, обновить `deploy/deploy.sh` (`systemctl enable --now`).
6a. **TG-канал check-in / check-out**: новый `apps/tg_bot/handlers/attendance.py` с командами `/checkin`, `/checkout`, `/status` и callback-handler'ом `attendance:checkin`. Регистрация в `apps/tg_bot/runner.py` по образцу `cmd_link_operator`. Флаг `AttendanceSettings.tg_checkin_enabled` уже в миграции из шага 1 — на этом шаге прикручиваем чтение флага в сервисе и `PATCH`-эндпоинт настроек. Inline-кнопка «Отметить приход» в существующем утреннем DM оператору (не заводим отдельное сообщение). Все TG-тесты из раздела 10 зелёные. Проверить, что `process_attendance_event` — единая точка правды и вызывается из обоих транспортов, никакого дублирования логики check-in/out.
7. **Frontend — базовые страницы**: `Scan.tsx`, `AttendanceToday.tsx`. Route в `App.tsx`. Sidebar items в `Layout.tsx`.
8. **Frontend — интеграция**: `Login.tsx` — кнопка «Войти по QR». `Profile.tsx` — секция «Мой QR для входа» с download/print. `OperatorDetail.tsx` — секция «Посещаемость» + «Ротировать QR». Мини-индикатор смены в футере sidebar для оператора.
9. **Frontend — QR-сканер**: подключить `html5-qrcode` в `package.json`, реализовать `Scan.tsx` с `Html5QrcodeScanner`, обработкой permission-ошибок и всех статусов из раздела 5. Printable-CSS для секции QR в `Profile.tsx`.
10. **Хук `useAttendanceScan`**: общий helper в `frontend/src/hooks/useAttendanceScan.ts`, реюз на `/scan` и в `/profile` для превью.
11. **Тесты**: всё из раздела 10 зелёное. Проверить `pytest -q apps/attendance` + полная сюита.
12. **Backfill**: на VPS запустить `python manage.py backfill_operator_qrs`. Прокатать один тестовый check-in вручную (открыть `/scan` в браузере ноутбука, отсканировать свой QR с телефона).
13. **Документация**: короткий раздел в `README.md` — «QR check-in», как оператор берёт свой QR из `/profile`, как ротировать HMAC-ключ (deploy + `backfill_operator_qrs --force` для регенерации всех nonce), как настроить `ATTENDANCE_ALLOWED_NETWORKS` для прода. Отдельным подразделом — «Отметка через Telegram»: команды `/checkin`, `/checkout`, `/status`, требование `link_operator` до первого использования, флаг `AttendanceSettings.tg_checkin_enabled` (как отключить канал, если офис хочет только QR).
14. **Миграция long-shift + manual-close**: расширение `AttendanceLog` полями `long_shift_warning_sent_at`, `warning_dismissed_at`, `manually_closed`, `manually_closed_by`; `AttendanceSettings` — `long_shift_warning_hours` (default=10, валидатор 1..24). Отдельная миграция, чтобы не смешивать с базовой QR-волной.
15. **Management command `attendance_long_shift_check`** + systemd `naff-attendance-long-shift-check.{service,timer}` (каждые 30 минут). Апдейт `deploy/deploy.sh` (`systemctl enable --now`). Сервис `attendance_long_shift_warn(...)` в `apps/attendance/services.py`, селектор `open_logs_awaiting_long_shift_warning(now)`. Все `test_long_shift_*` из раздела 10 зелёные.
16. **Endpoint `POST /api/attendance/logs/<id>/close/`** + сервис `attendance_log_close_manually(...)` + audit-запись `attendance.log_closed_manually` с `meta.note`. Permission `IsTeamLead | IsManager`. Тесты `test_manual_close_*` зелёные.
17. **Endpoint `GET /api/attendance/report/`** (json + xlsx) + сервисы `attendance_period_report(...)` / `attendance_period_report_xlsx(...)`. Excel-инфру не заводить заново — переиспользовать openpyxl-хелперы из `apps/sales/` (проверить точный путь в момент реализации, стандарт проекта, а не отдельный набор). Тесты `test_report_*` зелёные.
18. **UI: кнопки «Закрыть смену вручную»** — на `/attendance/today` в строке каждого «на смене» оператора и в секции «Посещаемость» на `OperatorDetail`. Confirm-модалка с textarea для note, POST на новый endpoint, обработка 409. Бейджи «авто» (жёлтый) / «TL» (синий) на закрытых сменах. Кнопки НЕ рендерить для роли OPERATOR.
19. **UI: страница `/attendance/report`** (`frontend/src/pages/AttendanceReport.tsx`) с фильтрами (пресеты «Неделя» / «Месяц» / «Кастом», select оператора), сводной таблицей и heatmap-полосками на 30 дней. Кнопка «Экспорт в Excel» дёргает `?format=xlsx`. Route в `App.tsx`, ссылка в sidebar для TL/Manager.
20. **TG callback-handler'ы `attendance:auto_checkout_confirm:*` и `attendance:continue_working:*`** в `apps/tg_bot/handlers/attendance.py` (или в `runner.py`, если ещё не выделены отдельные хендлеры). Первый — тонкая обёртка над `process_attendance_event(source="tg", ...)`. Второй — простая мутация `warning_dismissed_at=now()` + `cb.answer(...)`. Проверка принадлежности лога TG-user'у. Тесты `test_operator_confirms_auto_checkout_via_callback`, `test_operator_dismisses_warning_no_repeat`, `test_long_shift_callback_foreign_log_rejected` зелёные.

Регресс: полная тест-сюита проходит. Никаких изменений в моделях `Operator`, `Profile`, `Sale`, `PayrollRule`. Единственное правка вне `apps/attendance/` — строчка в `config/api_urls.py`, эндпоинт `/api/me/attendance-qr.png`, systemd-файлы и фронтовые роуты/Layout.
