# Аудит безопасности naffAI CRM — 2026-10-04

Скоп: backend (Django REST, 20 apps, 175+ endpoints), frontend (React/Vite), инфраструктура (VPS 63.186.179.240, docker-compose, nginx), live-тесты demo.naff.flek.uz и naff.flek.uz.

Метод: статический аудит кода (3 параллельных субагента + ручная верификация каждой находки по file:line) + живое тестирование демо/прода снаружи и по SSH (read-only, ничего не менял).

Легенда: 🔴 CRITICAL 🟠 HIGH 🟡 MEDIUM 🔵 LOW

---

## Итог

| Серверность | Кол-во |
|---|---|
| 🔴 CRITICAL | 5 |
| 🟠 HIGH | 8 |
| 🟡 MEDIUM | 10 |
| 🔵 LOW | 8 |

---

## 🔴 CRITICAL

### C1. QR scan отдаёт авторизационный токен оператора без аутентификации
- **Где:** `backend/apps/attendance/services.py:534-540` (issue_token → `Token.objects.get_or_create`), `services.py:602` (токен в ответе), `backend/apps/attendance/apis.py:72` (`ScanAttendanceApi`, `AllowAny`), `:117` (scan-with-photo, `AllowAny`)
- **Что:** POST `/api/attendance/scan/` (и `/scan-with-photo/`) разрешён всем (QR = credential). При **check-in** ответ содержит полноценный бессрочный DRF Token аккаунта оператора (`{"token": ..., "username": ..., "role": ...}`).
- **Эксплуатация:** любой, кто сфотографировал/скопировал чужой QR (плакат на стене, экран кассира), один POST — и получает вечный токен оператора. Frontend сам сохраняет его в localStorage (`frontend/src/hooks/useAttendanceScan.ts:43-44`).
- **Фикс:** не выдавать токен на публичный scan; для киоска держать сессию по одноразовому nonce (короткий TTL, привязка к IP/устройству) или заменить выдачу токена на подписанный короткоживущий JWT, выдаваемый только после check-in с фото.

### C2. Superuser пароль `dostik/tostik` захардкожен в git и работает на проде и демо (подтверждено live)
- **Где:** `deploy/deploy.sh:51-52` (username `dostik`, password `tostik`), `.env.example:25-26`, `backend/scripts/entrypoint.sh` (`DJANGO_SUPERUSER_PASSWORD:-admin` fallback)
- **Live-подтверждение:** POST `/api/auth/login/` `dostik/tostik` → **200 + валидный токен** на https://naff.flek.uz (прод) и на demo. Роль `team_lead`, `is_superuser: true`.
- **Эксплуатация:** полный админ-доступ любому, кто прочитал публичный репо (`github.com/Jamshidmirzo/naffAI`). Через суперюзера: все данные CRM, plaintext-пароли операторов (IsManager пропускает is_superuser), удаление аккаунтов.
- **Фикс:** немедленно сменить пароль на проде+демо; удалить креды из `deploy.sh`/`.env.example` и почистить git-историю (`git filter-repo`); убрать `:-admin` fallback в entrypoint (отказываться создавать superuser без явного пароля); включить 2FA/axes на админку.

### C3. Фото attendance (лица операторов) доступны без авторизации по угадываемому URL
- **Где:** nginx `location /media/ { alias /var/www/naffai-media/; }` (`/etc/nginx/sites-enabled/naff-demo`, прод-конфиг аналогично) — статика раздаётся мимо Django; `backend/apps/attendance/models.py:97,103` (`upload_to="attendance/%Y/%m/"`), `services.py:439-441` — имя файла `checkin-op{ID}-{YYYYMMDD-HHMMSS}.jpg` предсказуемо.
- **Live-подтверждение:** `GET https://naff.flek.uz/media/attendance/2026/08/selfie-1788069642388.jpg` → **200** без авторизации (и на demo). На диске 895 фото.
- **Эксплуатация:** перебор по дням/часам вокруг известного времени смены → массовая выгрузка селфи сотрудников. Галерея-то закрыта `IsSuperadminOrManager`, но nginx обходит permission полностью.
- **Фикс:** убрать `/media/attendance` из nginx-alias (оставить только `/media/catalog`); attendance-фото отдавать через authenticated Django view (X-Accel-Redirect) либо перенести в приватный bucket с подписанными URL.

### C4. Demo-контейнеры используют продовые секреты
- **Где:** `docker-compose.prod.yml:247-249,280-282` (`env_file: [.env, .env.demo]`, где `.env.demo` = 24 байта: только `POSTGRES_DB=naffai_demo`).
- **Подтверждение по SSH:** в env `naffai-demo-web-1` лежат те же значения, что в проде: `DJANGO_SECRET_KEY=f2bf…` (совпадает префикс), `OPERATOR_PASSWORD_ENCRYPTION_KEY=9Uplsm0…` (совпадает), `TELEGRAM_BOT_TOKEN`, `TG_*`, `GEMINI_API_KEY`, `GOOGLE_SHEETS_CREDENTIALS_JSON`, `POSTGRES_PASSWORD` (тот же).
- **Эксплуатация:** demo — публичный стенд с демо-веткой кода; любая уязвимость/RCE на demo отдаёт атакующему ключ шифрования паролей всех операторов ПРОДА, JWT-секрет прода, TG-сессии, доступ к Telegram-боту.
- **Фикс:** отдельный `.env` для demo: свой `DJANGO_SECRET_KEY`, свой `OPERATOR_PASSWORD_ENCRYPTION_KEY` (и миграция перешифрования OperatorSecret демо-БД), `TELEGRAM_BOT_ENABLED=0`, пустые `TG_*`/`GEMINI_*`/Sheets.

### C5. IDOR: конвертация чужого лида в подтверждённую продажу
- **Где:** `backend/apps/leads/apis.py:741-759` (`LeadConvertToSaleApi`, `IsAuthenticatedAnyRole`), `leads/services.py:1676-1732` (`lead_convert_to_sale` — нет проверки владения), `sales/services.py:244` (дефолт `status=CONFIRMED`)
- **Эксплуатация:** оператор POST `/api/leads/{id}/convert-to-sale/` на **любой** чужой лид: произвольный `operator_id`/`operators[]` (кредит кому угодно), произвольные `amount`/`sold_at`. Роль-гейт из `SaleListCreateApi` (pending + self-allocation, `sales/apis.py:444-456`) здесь **обходится** — сервис вызывается напрямую. Чужой лид уходит в `WON`, пейролл/аналитика загрязняются, аккаунт коллеги получает чужую продажу.
- **Фикс:** в view для `role == "operator"`: проверка `lead.operator_id == profile.operator_id`, форсить `status=pending` и self-allocation (вынести гейт из `SaleListCreateApi` в общий хелпер сервиса).

---

## 🟠 HIGH

### H1. IDOR-семейство: мутации чужих объектов оператором (5 эндпоинтов)
Все — `IsAuthenticatedAnyRole`, объект грузится по pk без сверки владельца:
1. **POST `/api/leads/{id}/status/`** — `leads/apis.py:667-685` + `services.py:1344` `lead_update_status` без ownership. Оператор меняет статус любого лида (закрыть чужой `won`, слить в `lost`).
2. **GET+POST `/api/leads/{id}/call-attempts/`** — `calls/apis.py:126-161`. GET: чужая история звонков и комментарии. POST: `operator_id` из body через `_operator_for_request` (calls/apis.py:108-120 — body приоритетнее профиля) → звонок «от имени» другого оператора.
3. **POST `/api/callbacks/{id}/done/`** — `calls/apis.py:236-244`. Закрытие чужих напоминаний (подавить DM-напоминание и overdue-гейт коллеги).
4. **POST `/api/callbacks/{id}/snooze/`** — `calls/apis.py:247-262`. Бесконечный snooze чужих callback'ов.
5. **POST `/api/calls/start/`** — `calls/apis.py:377-404`. Click-to-call на чужой лид от чужого имени.
Контраст: `MobileLeadStatusApi` проверяет владение (`mobile/apis.py:226-237`), веб-версия — нет; `CallAttemptFinishApi` проверяет владельца (`calls/apis.py:417-428`), а create/start — нет.
**Фикс:** перенести ownership в сервисный слой (`lead_update_status`, `call_attempt_log`, `callback_reminder_*`): если `user.profile.role == operator` и `object.operator_id != profile.operator_id` → 403.

### H2. Роль из localStorage — подмена superadmin-UI
- **Где:** `frontend/src/store/auth.ts:14-18` (роль пишется в localStorage при логине), `frontend/src/components/RoleGate.tsx:33-36` и `SuperadminGate:47-50`, `AppShell.tsx:144-147` читают роль **только** из `naffai_role`, никогда не сверяя с `/auth/me/`.
- **Эксплуатация:** оператор в консоли: `localStorage.setItem("naffai_role","superadmin")` → видит superadmin-навигацию, `/leads/system-lost`, PIN-обход UI (`PinGate` рендерит children для superadmin). Бэкенд отобьёт API-вызовы, но фронт раскрывает URL-структуру и шлёт запросы.
- **Фикс:** источник роли — `useMe()` (хук уже есть), сверка при маунте AppShell; localStorage хранит только токен.

### H3. Токен в localStorage — кража через любой XSS
- **Где:** `frontend/src/store/auth.ts:12-20`, `frontend/src/lib/api.ts:28-33`.
- DRF Token не имеет expiry (подтверждено: logout удаляет, иначе вечный). При этом сессия по cookie уже поддерживается (`api.ts:13,42` `withCredentials`, keepalive `/auth/me/`).
- **Фикс:** уйти на HttpOnly cookie-сессию как основной механизм; токен из localStorage убрать.

### H4. Захардкоженные креды/QA-токен в git-репо
- **Где:** `frontend/qa-leads.mjs:7` — бессрочный DRF-токен `e37b681e…`; `frontend/probe-login.mjs:9-10` — `qa/qa12345`; `Login.tsx:212-215` — подсказка логинов «manager · qa · admin» на экране логина.
- **Проверено live:** токен недействителен и на demo, и на проде; `qa/qa12345` не логинится. НО аккаунт `qa` существует **active superuser на проде** и `team_lead` на демо — пароль от него в репо уже светился; если пароль менялся лишь частично — риск сохраняется.
- **Фикс:** деактивировать/переименовать `qa` на проде; ротировать; вычистить файлы из git-истории; убрать подсказку с логин-экрана.

### H5. Throttling фактически глобальный, не per-IP (brute-force + DoS)
- **Где:** `backend/apps/users/apis.py:29-30`, `backend/apps/mobile/apis.py:49-50` — `AnonRateThrottle.get_ident()` = `REMOTE_ADDR`; в `config/wsgi.py` нет ProxyFix; nginx передаёт `X-Real-IP`/`X-Forwarded-For`, но Django их не читает.
- **Следствие:** (а) все клиенты мира делят один бакет → 10 login/min на всех (DoS логина); (б) распределённый перебор паролей ничем не ограничен по-настоящему (per-IP нет).
- **Live:** 10 логинов → 429, 21 qr-preview → 429 (работает, но как глобальный лимит).
- **Фикс:** `GunicornProxyFix` или custom `get_ident()` с `NUM_PROXIES=1`; per-username счётчик неудач (Redis/axes) + lockout.

### H6. Обратимо-хранимые пароли операторов, plaintext в API-ответах
- **Где:** `apps/users/services.py:215-237` (`password_view` — расшифровка), эндпоинты: `GET /operators/{id}/account/password/` (`apis.py:316-327`), create/reset возвращают plaintext (`apis.py:310-313,345-350,486-495,522`).
- Доступ: любой senior (IsManager = team_lead/manager/superadmin) — тимлид может прочитать пароль и войти в аккаунт любого оператора. Аудит есть (`PASSWORD_VIEWED`), но нет step-up auth, rate-limit и алертов.
- **Фикс:** ограничить password_view `superadmin`'ом + повторный ввод своего пароля + TG-алерт при N просмотрах; минимально — переходить на одноразовый reset вместо показа.

### H7. JWT: refresh 30 дней без ротации/blacklist; SIGNING_KEY = SECRET_KEY
- **Где:** `backend/config/settings/base.py:239-248`, `mobile/apis.py:104-130` (refresh без ротации). Logout удаляет только DRF Token — JWT живёт дальше; смена пароля JWT не инвалидирует.
- **Фикс:** подключить `token_blacklist`, `ROTATE_REFRESH_TOKENS=True`, `BLACKLIST_AFTER_ROTATION=True`, сократить refresh до 7 дней; вынести `JWT_SIGNING_KEY` в отдельную переменную.

### H8. Прод отстаёт от main на 276 коммитов; prod-main — июль
- Live: прод (`index-BnxxN19n.js`) ≠ demo (`index-CJigp7T1.js`). Все фиксы последних 3 месяцев (включая «4 critical + 1 high» из 8395aec) — только на demo.
- **Фикс:** немедленно смёржить проверенные фиксы в prod после C1-C5.

---

## 🟡 MEDIUM

1. **`/admin/` открыт публично** на проде и демо (200, без смены URL, без IP-ограничений, без django-axes). `config/urls.py:10`.
2. **`/api/schema/` отдаёт карту всех 218 эндпоинтов без авторизации** на проде и демо. Закрыть `SERVE_PUBLIC=False` или в проде отключить.
3. **Нет HSTS/SSL-redirect/security-заголовков** на уровне Django (`prod.py:18-21` — только cookie-флаги) и на уровне nginx (нет Strict-Transport-Security, CSP, X-Frame-Options на статике). SPA-страницы отдаются без заголовков вообще.
4. **`GET /api/leads/phone-search/?q=`** — `IsAuthenticated` (`leads/apis.py:688-738`): оператор по 4+ цифрам выгружает чужую клиентскую базу (имя, телефон, статус, оператор). Ввести фильтр «только свои лиды» для operator.
5. **POST `/api/telegram/lookup`** — `IsAuthenticatedAnyRole` (`leads/apis.py:1447-1482`): оператор перезаписывает глобальный кэш phone→TG-username (подсунуть фишинговый контакт). POST → `IsTeamLead`.
6. **POST `/api/sales/` с чужим `lead_id`** — `sales/services.py:515-551`: линковка продажи к чужому лиду помечает его `WON`. Валидировать `lead.operator_id == profile.operator_id` для оператора.
7. **Удаление оператора без PIN-гейта**: `operators/apis.py:293-301` (`IsTeamLead`) vs деактивация `:212` (`+ IsDestructiveActionPinVerified`). Добавить PIN к delete.
8. **Анонимные `_operator_for_request(request)` берёт `operator_id` из body** (`calls/apis.py:108-120`): подмена идентичности во всех call-эндпоинтах (см. H1). Для operator-роли игнорировать body.
9. **Атака перебором QR нереальна** (64-bit sig, 128-bit nonce, throttle 21/min ≈ 1671 млрд лет), но `qr-preview` на демо **не проверяет IP** и раскрывает формат ошибок (revoked vs invalid) — оставить, но учесть при redesign.
10. **Парольная политика**: минимум 8 символов, без сложности (`users/services.py:33,46-51`); user-enumeration по таймингу в `LoginApi`/`MobileLoginApi` (нет dummy-hash). Добавить django-axes и dummy-check.

---

## 🔵 LOW

1. Роль `smm` сломана на фронте: `normaliseRole` возвращает `null` → SMM-юзера кидает на `/login`, но `AppShell` fallback показывает ему менеджерское меню (`RoleGate.tsx:20-25`, `AppShell.tsx:145`). Бэкенд тоже: `IsAuthenticatedAnyRole` не пускает `smm` — SMM может только логиниться и ходить в `IsAuthenticated`-эндпоинты.
2. `IsTeamLeadOrManagerReadOnly` — имя врёт (read-only нет, все senior пишут) (`users/permissions.py:48-55`). Переименовать.
3. Три разных permission-класса для одного маркетингового домена (`marketing/apis.py` + дубли в `stickers/apis.py:28-39`, `tg_userclient/permissions.py:31-35`). Унифицировать.
4. Payroll: `IsTeamLead` vs `IsManager` на одном ресурсе (`payroll/apis.py:44,56` vs `:200`).
5. Каталог: `ChannelListCreateApi` GET — any role, `ChannelDetailApi` GET — `IsManager` (`catalog/apis.py:40-43` vs `70-73`); `ImeiLookupApi` — senior-only, но нужен оператору на форме продажи (`catalog/apis.py:85,105`).
6. Inline role-проверки вместо permission-классов (`operators/apis.py:318-320`, `attendance/pin_apis.py:113,140,164`) — не покрыты тестами матрицы.
7. `.env.production.bak` (gitignored) с внутренним `nip.io`-URL старого деплоя — удалить.
8. ~12 `eslint-disable react-hooks/exhaustive-deps` по страницам; `MyLeads.tsx` 2300+ строк — техдолг.

---

## Проверено и корректно (не находки)

- Анонимный доступ к данным: все `/leads /sales /operators /audit /users /callbacks` → 403 без токена (live, demo и prod).
- `me/*`, `notifications`, `mobile/*`, `lessons`, `tg_userclient` (session ownership), `day-off` (чужую заявку не создать), `attendance me/*`, `audit`, `system_settings` — скоупинг корректный.
- `/sales/{id}/` GET для оператора фильтруется `created_by` (`sales/apis.py:474-485`) — фронтовый незакрытый роут `/sales/:id` не даёт чужие данные.
- QR HMAC: `hmac.compare_digest`, revoked-проверка, nonce 128-bit в БД — подделка непрактична.
- `.env` не в git (проверено `git log --all -- .env` — пусто); `.gitignore` корректен.
- Login throttle живой (10 → 429); logout удаляет DRF Token; смена пароля инвалидирует сессии Django (`set_password`).
- docker: web/db/redis только на 127.0.0.1/внутренней сети (проверено `ss -tlnp` на сервере), наружу только 22/80/443.
- `SECURE_PROXY_SSL_HEADER`, `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE` в prod — есть.

---

## Приоритетный план фиксов (порядок)

1. **Сегодня:** сменить пароль `dostik` (прод+демо), ротировать `qa`, убрать креды из `deploy.sh` (C2, H4).
2. **Сегодня:** закрыть `/media/attendance` в nginx; attendance-фото через auth-view (C3).
3. **Сегодня:** `demo-web`/demo-cron перевести на отдельные секреты (C4).
4. **Эта неделя:** ownership-чеки в `lead_update_status`, `lead_convert_to_sale`, `call_attempt_*`, `callback_*`, `calls/start` + убрать `operator_id` из body для операторов (C5, H1).
5. **Эта неделя:** убрать выдачу DRF Token из публичного scan (C1) + перестать сохранять токен на фронте из scan-flow.
6. **Эта неделя:** ProxyFix/NUM_PROXIES=1 + per-username lockout (H5); HSTS/SSL-redirect (M3); скрыть `/admin/` (M1); закрыть `/api/schema/` (M2).
7. **Следующий спринт:** JWT blacklist/ротация (H7); роль из `useMe()` вместо localStorage (H2); cookie-сессия вместо localStorage-токена (H3); password_view → superadmin + step-up (H6); промоут demo→prod (H8).
8. **Фон:** permission-матрица тестами (5 веток × ключевые эндпоинты), унификация permission-классов, django-axes, парольная политика.

---

## Приложение: live-тестирование демо (2026-10-04, браузер + API)

Вход: superadmin `dostik` через UI (подтверждает C2), создан тестовый оператор «QA Audit Probe Op» (id 74) + team_lead `qa_audit_probe` (оба удалены/деактивированы после тестов; аудит-журнал демо хранит следы под пометкой «qa … probe»).

### Подтверждено живьём

1. **C1 (QR→токен) — подтверждено:** публичный `POST /api/attendance/scan/` с валидным QR-пейлоадом (полученным легально из `/me/qr-token/`) вернул `{"token": ..., "username": ..., "role": ...}` — полный доступ к аккаунту оператора без логина, с внешнего IP. Смена зачекинена, потом закрыта (`/me/toggle/`).
2. **C5 (convert-to-sale IDOR) — подтверждено:** оператор 74 POST `/api/leads/47855/convert-to-sale/` (лид принадлежит оператору 34 Munisa2) → 201, продажа `#728` создана **сразу в status=confirmed** с `operator_id=34` (кредит чужому оператору), лид → `won`. Откачено: продажа удалена, лид возвращён в `no_answer`.
3. **LeadStatus IDOR — подтверждено:** тот же оператор поменял статус чужого лида `47855` (владелец Munisa2) `no_answer → no_answer_2`, 200 OK. Откачено.
4. **Call-attempt подмена — подтверждено:** оператор 74 создал call-attempt `#9422` от имени оператора 34 на её же лид (201). Запись осталась в демо с комментарием `qa idor probe attempt` (API удаления нет).
5. **H6 (sales с чужим lead_id) — подтверждено:** оператор создал pending-продажу `#729` с `lead_id=47874` (чужой/свободный лид) → лид **сразу стал `won`** ещё до подтверждения продажи. Откачено (продажа удалена, лид → `new`).
6. **phone-search утечка — подтверждено:** по 4 цифрам номера оператор получает чужие лиды других операторов (Kuganov/оператор Muxlisa, Jamshidbek/Vasila, Fayot/Munisa2) с именем, телефоном, статусом и владельцем.
7. **telegram/lookup POST — подтверждено:** оператор перезаписал кэш `phone→username` (200). Восстановлено пустым значением.
8. **Role-spoof фронтенда — подтверждено:** оператор с `localStorage.naffai_role=superadmin` видит полное менеджерское меню и открывает `/leads/system-lost` (бэкенд данные не отдал — 403, toast «Доступ запрещён», но навигация/URL раскрыты).
9. **password_view — подтверждено:** `GET /operators/29/account/password/` отдал plaintext пароль оператора (аудит-запись `password_viewed` создалась — видна в журнале).
10. **PIN brute-force — подтверждено отсутствие защиты:** 3+ неверных `pin/verify` подряд без блокировки/троттлинга; PIN = 4 цифры (10 000 комбинаций), перебор ничем не ограничен. Добавить в план фиксов п.6: throttle/lockout на `pin/verify` (например, 5 неудач → 15 мин блок).

### Что отбито корректно (live)

- Чужой lead detail, operators/{id}/stats, чужой QR-token, чужие attendance-логи, audit, payroll, users, sales чужие, system-lost, orphans, postpone/reassign — все 403 под оператором.
- Анонимный доступ к данным — 403 везде; throttle 10/min логин, 21/min anon — работают (глобально, см. H5).
- Audit-журнал фиксирует все действия, включая password_viewed и массовые изменения.

### Остатки тестовых данных в демо (безвредны)

- Call-attempt `#9422` (лид 47855) с комментарием «qa idor probe attempt» — API удаления нет.
- Аудит-записи о создании/удалении qa-аккаунтов.

---

## Не проверено (нет доступа/вне скоупа)

- Реальные значения `SENTRY_DSN`, `GEMINI_API_KEY`, `GOOGLE_SHEETS_CREDENTIALS_JSON` на сервере (не читал значения секретов, только ключи env и совпадения префиксов между demo/prod).
- Бэкапы БД (есть, но recovery не тестировался), логи Sentry на предмет утечек.
- Flutter-мобильный клиент (только backend-side mobile API).
- Конфиг Cloudflare (Tunnel, WAF) — вне досягаемости.
