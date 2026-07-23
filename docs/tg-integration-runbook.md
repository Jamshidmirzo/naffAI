# Telegram Integration Runbook (naffAI)

Инструкция по настройке, подключению и обслуживанию Telegram-интеграции (Telethon / MTProto).

---

## 1. Настройка API ключей Telegram (для администратора)

Telegram User Client требует один комплект `TG_API_ID` и `TG_API_HASH` на всё приложение:

1. Перейдите на [https://my.telegram.org/apps](https://my.telegram.org/apps) и войдите под аккаунтом компании/администратора.
2. Создайте новое приложение (App title: `naffAI Sales Analysis`, Short name: `naffai`).
3. Скопируйте **App api_id** (`TG_API_ID`) и **App api_hash** (`TG_API_HASH`).
4. Сгенерируйте секретный Fernet-ключ для шифрования Telegram-сессий:
   ```bash
   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```
5. Установите переменные окружения в `.env`:
   ```ini
   TG_API_ID=12345678
   TG_API_HASH=0123456789abcdef0123456789abcdef
   TG_SESSION_ENCRYPTION_KEY=your_generated_fernet_key_here
   ```

---

## 2. Подключение оператора

1. Оператор заходит в личный кабинет на странице **Профиль** (`/profile`).
2. В блоке **Telegram для анализа** нажимает кнопку **Подключить Telegram**.
3. Проходит wizard:
   - Подтверждает согласие на обработку переписки (чекбокс).
   - Вводит номер телефона оператора.
   - Вводит 5-значный код подтверждения из приложения Telegram.
   - Если включена 2FA (двухфакторная аутентификация) — вводит облачный пароль Telegram.
4. После успешной авторизации статус меняется на **Активна** (`@username`).

---

## 3. Просмотр переписок и AI-анализ (для менеджера)

1. Менеджер открывает страницу оператора (`/operators/{id}`).
2. Внизу страницы расположена секция **TG-диалоги с клиентами**.
3. Слева — список всех чатов оператора (1-на-1 и группы, каналы автоматически фильтруются).
4. При клике на чат справа отображаются:
   - **AI-анализ** диалога: оценка качества 0-100, краткое резюме, обнаруженные риски (красные флаги) и положительные моменты.
   - Сообщения переписки.

---

## 4. Операционные команды и фоновые процессы

### 4.1 Runner (приём сообщений)
Запуск процесса слушателя сообщений:
```bash
python manage.py run_tg_userclient
```
В продакшене запустить под `systemd` или `supervisor`:
```ini
[Unit]
Description=naffAI Telegram Userclient Runner
After=network.target

[Service]
Type=simple
User=naffai
WorkingDirectory=/opt/naffAI/backend
ExecStart=/opt/naffAI/backend/.venv/bin/python manage.py run_tg_userclient
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 4.2 AI-Анализ диалогов (Cron)
Периодический запуск анализа всех активных диалогов (рекомендуется каждую минуту или час, команда идемпотентна):
```bash
python manage.py analyze_tg_dialogs
```
Cron пример:
```cron
* * * * * cd /opt/naffAI/backend && .venv/bin/python manage.py analyze_tg_dialogs >> /var/log/naffai_ai.log 2>&1
```

### 4.3 Ретенция сообщений (Purge Cron)
Удаление сообщений старше 90 дней (настраивается через `TG_MESSAGE_RETENTION_DAYS`):
```bash
python manage.py purge_old_tg_messages
```
Cron пример (каждый день в 4 утра):
```cron
0 4 * * * cd /opt/naffAI/backend && .venv/bin/python manage.py purge_old_tg_messages >> /var/log/naffai_purge.log 2>&1
```

---

## 5. Обработка сбоев и ошибок

| Ошибка | Причина | Действие |
|---|---|---|
| `EXPIRED` статус у оператора | Оператор сменил пароль, завершил сессии в TG или истёк auth_key | Красная точка в интерфейсе. Оператор нажимает «Переподключить» в `/profile`. |
| `FloodWaitError` | Частые запросы к TG API | Runner автоматически ожидает указанное Telegram время и возобновляет работу. |
| `PhoneNumberBannedError` | Номер оператора забанен Telegram | Сессия переходит в статус `ERROR`. Требуется разблокировка номера со стороны Telegram. |
