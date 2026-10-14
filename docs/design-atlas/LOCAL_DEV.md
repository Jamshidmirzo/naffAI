# Локальная проверка v2

Бэкенд (уже запущен, код из этого worktree, автоперезагрузка): `http://localhost:8010/api` — контейнеры `naff-db-1`, `naff-web-1` (`docker compose -p naff …` из корня worktree; web собран под linux/amd64). Локальная база с данными (183 продажи, 168 лидов, 24 оператора). Это НЕ прод.

Учётки (только локально):
| роль | логин | пароль |
|---|---|---|
| manager | `v2manager` | `v2pass123` |
| super_manager | `v2super` | `v2pass123` |
| operator | `v2operator` (оператор Asadbek, id 29) | `v2pass123` |
| superadmin | `v2admin` | `v2pass123` |

У `v2manager` в команде 8 операторов (`managed_by`), `v2manager.reports_to = v2super`.

Фронт: `cd frontend && npm run dev -- --port <свой порт>` (у каждого агента свой порт: 5181–5189, чтобы не мешать друг другу). `.env.local` уже указывает на `http://localhost:8010/api`.

Логин в Playwright без формы:
```js
const r = await fetch('http://localhost:8010/api/auth/login/', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:'v2manager', password:'v2pass123'})}).then(r=>r.json());
await page.goto('http://localhost:5181/login');
await page.evaluate((r) => { localStorage.setItem('naffai_token', r.token); localStorage.setItem('naffai_username', r.username); localStorage.setItem('naffai_role', r.role); localStorage.setItem('naffai_design','v2'); }, r);
await page.goto('http://localhost:5181/sales?design=v2');
```
Разделы «Посещаемость» требуют PIN (`PinGate`); если PIN не задан локально — задать в `/settings` под менеджером.

Логин ограничен 10 в минуту, и новый логин может сбросить токен той же учётки у другого агента — логинься один раз на прогон и переиспользуй токен.

PIN раздела «Посещаемость» (локально): `2468` — вводится в окне PIN на /attendance/*.
