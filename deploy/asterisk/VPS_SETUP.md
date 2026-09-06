# NaffAI · Развёртывание Asterisk на VPS

Пошаговая инструкция для полного разворота Фазы 2 (SIP-инфраструктура)
плана `parallel-inventing-dragon.md`.

**Время**: 40-60 минут суммарно (сборка Asterisk = 15 минут, остальное — конфиги).

---

## Что тебе понадобится ДО начала

- [ ] VPS Ubuntu 22.04, минимум 2 GB RAM / 40 GB диск / 1 CPU
- [ ] Root SSH-доступ к VPS
- [ ] Домен, куда можно добавить A-запись (например `naff.flek.uz` — добавляем `sip.naff.flek.uz`)
- [ ] Заключённый договор с SIP-провайдером (креденшлы можно получить позже — до шага 7)
- [ ] Локальный SSH-ключ основного naff-сервера (для rsync записей звонков)

---

## Шаг 1. Завести VPS

Рекомендованные варианты:

| Провайдер | Тариф | Цена/мес | Плюсы |
|-----------|-------|----------|-------|
| **Hetzner CPX11** | 2 vCPU, 2 GB RAM, 40 GB | €5.83 (~75 000 сум) | Стабильно, DC в EU |
| **Timeweb UZ** | 2 CPU, 2 GB RAM | ~65 000 сум | DC в Ташкенте, ниже latency до UZ-мобильных |
| **DigitalOcean s-2vcpu-2gb** | 2 vCPU, 2 GB, 60 GB | $18 | Опыт, но дороже |

**Совет**: для минимальной задержки до UZ-номеров бери Timeweb UZ (DC в Ташкенте).
Задержка Hetzner (Германия) → UZ-мобильные добавит ~80-100 мс one-way.

---

## Шаг 2. Настроить DNS

В панели твоего домена добавь A-запись:

```
sip.naff.flek.uz.    A    <IP_VPS>    TTL 300
```

Проверь через `dig sip.naff.flek.uz +short` — должно вернуться IP VPS.
**Не переходи к шагу 5 пока DNS не резолвится** — иначе Let's Encrypt не выпустит сертификат.

---

## Шаг 3. Подключиться к VPS

```bash
ssh root@<IP_VPS>
```

Обнови базовые пакеты и создай рабочего пользователя (по желанию):

```bash
apt update && apt upgrade -y
```

---

## Шаг 4. Склонировать репозиторий

```bash
cd /opt
git clone https://github.com/Jamshidmirzo/naffAI.git naffAI
cd /opt/naffAI/deploy/asterisk
chmod +x *.sh
```

---

## Шаг 5. Установить Asterisk + FreePBX

Одной командой:

```bash
sudo SIP_DOMAIN=sip.naff.flek.uz LETSENCRYPT_EMAIL=you@example.com ./install-asterisk.sh
```

**Время**: 20-30 минут (в основном компиляция Asterisk).
Скрипт идемпотентен — можно перезапускать при ошибках.

После завершения:
- FreePBX web доступен на `http://<IP_VPS>/admin` — открой в браузере, пройди мастер (задай admin-пароль).
- Проверь: `sudo systemctl status asterisk` → `active (running)`
- Файрвол: `sudo ufw status` → должно быть 6 правил

---

## Шаг 6. Оформить SIP-транк у провайдера

См. `SIP_PROVIDERS_UZ.md` для сравнения провайдеров.

**Рекомендация**: Beeline Business Uzbekistan.
При заключении договора попроси:
- IP whitelist для регистрации (укажи IP твоего VPS)
- Формат номеров: E.164 (`+998XXXXXXXXX`)
- Тип аутентификации: userpass (не IP-only — гибче)

Провайдер даст:
- SIP-хост (например `sip.beeline.uz`)
- Логин + пароль
- Твой корпоративный номер (то, что увидит клиент)

---

## Шаг 7. Подключить транк

Создай на VPS файл с креденшлами:

```bash
cd /opt/naffAI/deploy/asterisk
cp sip_trunk.env.example sip_trunk.env
nano sip_trunk.env       # заполни SIP_TRUNK_HOST, USERNAME, PASSWORD, CALLER_ID
```

Запусти конфигуратор:

```bash
sudo ./configure-sip-trunk.sh sip_trunk.env
```

Проверь регистрацию:

```bash
sudo asterisk -rx "pjsip show registrations"
```

Должно быть `Registered`. Если `Unauthorized` — проверь логин/пароль.
Если `Timeout` — попроси провайдера добавить IP VPS в whitelist.

**Тест исходящего** (замени на свой мобильный):

```bash
sudo asterisk -rx "channel originate PJSIP/+998901234567@trunk-beeline_business extension +998901234567@from-internal"
```

Твой телефон должен зазвонить.

---

## Шаг 8. Создать SIP-extension'ы для операторов

Для каждого оператора (26 штук):

```bash
sudo ./create-operator-extension.sh +998901234567
```

Выведет JSON:
```json
{"username": "4567", "password": "aBc123...", "host": "sip.naff.flek.uz", "port": 5061, "transport": "tls"}
```

Эти креды нужно передать в CRM — записать в поля `Operator.sip_username` / `Operator.sip_password`
(в Django добавляются в Фазе 4 плана).

Автоматизация для массового создания (пример):

```bash
# operators.txt — по одному +998... номеру на строку
while read phone; do
  sudo ./create-operator-extension.sh "$phone" >> operator_credentials.jsonl
done < operators.txt
```

---

## Шаг 9. Настроить mixmonitor post-hook

Создай `/etc/default/naffai-asterisk`:

```bash
sudo tee /etc/default/naffai-asterisk >/dev/null <<'EOF'
NAFF_API_BASE=https://naff.flek.uz
NAFF_API_TOKEN=<длинный_рандомный_токен>
NAFF_MEDIA_HOST=naff.flek.uz
NAFF_MEDIA_USER=ubuntu
NAFF_MEDIA_PATH=/var/www/naffai-media/call-recordings
NAFF_MEDIA_SSH_KEY=/etc/asterisk/keys/naff_media_deploy
EOF
```

Сгенерируй SSH-ключ и добавь его в `authorized_keys` основного naff-сервера
(только для пользователя, у которого write в `/var/www/naffai-media/call-recordings/`):

```bash
sudo -u asterisk ssh-keygen -t ed25519 -f /etc/asterisk/keys/naff_media_deploy -N ""
sudo cat /etc/asterisk/keys/naff_media_deploy.pub
# скопируй в ~/.ssh/authorized_keys на naff.flek.uz (для user ubuntu)
```

Проверь rsync руками:

```bash
sudo -u asterisk ssh -i /etc/asterisk/keys/naff_media_deploy ubuntu@naff.flek.uz "echo ok"
```

Первый реальный звонок → `.mp3` появится в `/var/www/naffai-media/call-recordings/YYYY/MM/DD/`
на основном сервере, а в Django придёт POST на `/api/calls/recording-attach/`.

---

## Шаг 10. AMI listener в основном проекте

**Только после того как в backend будет реализована `apps/calls/management/commands/asterisk_ami_listener.py`** (Фаза 4).

На VPS создай AMI-пользователя в `/etc/asterisk/manager.conf`:

```ini
[general]
enabled = yes
port = 5038
bindaddr = 0.0.0.0

[naffai]
secret = <ASTERISK_AMI_SECRET>
deny=0.0.0.0/0
permit=<PUBLIC_IP основного naff-сервера>/32
read = system,call,cdr,dialplan
write = system,call,originate
```

Открой файрвол только для IP основного сервера:

```bash
sudo ufw allow from <IP_naff_сервера> to any port 5038 comment 'AMI'
sudo asterisk -rx "manager reload"
```

На **основном** naff-сервере отредактируй `/opt/naffAI/docker-compose.prod.yml` —
добавь сервис `asterisk-listener` (см. `docker-compose-additions.yml`), обнови `.env`, запусти:

```bash
cd /opt/naffAI
docker compose -f docker-compose.prod.yml up -d asterisk-listener
docker compose logs -f asterisk-listener
```

---

## Диагностика

| Проблема | Что смотреть |
|----------|--------------|
| Транк не регистрируется | `sudo asterisk -rx "pjsip show registrations"` → если Timeout — файрвол/whitelist провайдера. Если Unauthorized — креды. |
| Звонок обрывается сразу | `journalctl -u asterisk -n 100` — ищи `403`, `404`, `no matching endpoint` |
| Нет звука в одну сторону | NAT. Раскомментируй `external_media_address=<PUBLIC_IP>` в pjsip.conf transport-udp |
| Записи не появляются на naff-сервере | `journalctl -t naffai-mixmon -n 50` — проблема в hook. Проверь SSH-ключ. |
| FreePBX 500-ка | `tail -100 /var/log/apache2/error.log` |
| fail2ban ложно банит меня | `sudo fail2ban-client status asterisk` → `sudo fail2ban-client unban <IP>` |

**Полезное**:
- `sudo asterisk -rvvv` — интерактивная CLI Asterisk
- `sudo systemctl restart asterisk` — рестарт
- `sudo asterisk -rx "core reload"` — reload без разрыва звонков

---

## Что дальше

После Фазы 2 (эта инструкция) → переходим к **Фазе 3**: разработка Flutter-app NaffCall
(отдельный репозиторий `naff-call/`). Оператор устанавливает через TestFlight/Play Console,
логинится, регистрируется на Asterisk по SIP TLS через `dart_sip_ua`, и всё работает.
