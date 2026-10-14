# Как делать страницу нового дизайна (v2 «Атлас»)

Репозиторий: `/Users/user/Desktop/mp/ai/naff-atlas` (git worktree, ветка `feat/design-atlas`). Старый дизайн (v1) НЕ трогаем.

## Как это устроено
- Переключатель: `src/store/design.ts` (`v1|v2`, localStorage `naffai_design`, `?design=v2` в URL). В v2 у `<html data-design="v2">`, у `<body class="nf">`.
- Стили v2: `src/v2/styles/atlas.css` — СГЕНЕРИРОВАН из `docs/design-atlas/naff.css` (`python3 frontend/scripts/build-atlas-css.py`). Классы те же, что в артбордах: `card card-h pad tr th badge b-ok chip seg tabs tab btn btn-pri input field err banner well kpi lbl h1 h2 h3 s xs c2 c3 num row col g4..g24 grow wrap between trunc li row-item split list panel icon-tile switch check ava bar empty sk toast dlg* when ikat seat floor board bcol bcard rail side keycap dayline slot queue-item focus palette` и т.д. Новые общие классы — только через правку `docs/design-atlas/naff.css` + перегенерацию (координируй с главным агентом; в своих страницах используй inline `style`).
- Маршрут → файл страницы: `src/v2/registry.tsx` (`V2_SLUGS`). Страница = `src/v2/pages/<Slug>.tsx` с `export default function …`. Пока файла нет, показывается старая страница в новой оболочке. `App.tsx` НЕ трогаем.
- Оболочка (меню, ⌘K, оверлеи оператора) уже есть: `src/v2/shell/*`. Страница рендерит только своё содержимое: `<PageHeader …/>` + `<main className="page">…</main>` (см. артборды: `<header class="top">` + `<main class="page">`). Меню, `side-wrap`, `main-col` НЕ рисовать.
- Гейты (`RoleGate`, `PinGate`, `SuperadminGate`) уже стоят в `App.tsx` вокруг маршрута — в странице их не повторять.

## Спецификация страницы
1. Артборды: `docs/design-atlas/artboards/<Name>.dc.html` (HTML + данные-примеры в `renderVals()`), скриншоты `docs/design-atlas/shots/<Name>.png` (смотри через Read). Какие артборды у маршрута — `docs/design-atlas/ROUTES.md`. Окна/ошибки — листы `*Sheet*`, `SmSheet`, `SmStates`, `Dialogs`, `SysStates`.
2. Поведение и данные — старая страница `src/pages/<Old>.tsx` (+ её компоненты). **Паритет обязателен**: каждый запрос, мутация, фильтр, колонка, действие, валидация, тост старой страницы должны быть в v2. Плюс всё, что нарисовано на артборде, если для этого есть данные в API.
3. То, что на артборде помечено бейджем «новое» и требует данных, которых нет в API, — делать только если данные есть (см. `docs/design-atlas/BACKEND_V2.md`, когда появится), иначе не рисовать. Сам бейдж «новое» в продукте НЕ показывать.
4. Данные-примеры из артбордов не хардкодить — только реальные данные API.

## Код
- React 18 + TS, react-query 5, axios `api` из `src/lib/api.ts`, роутер v6. Иконки — `lucide-react` (`className="ic"`), без emoji.
- Хуки данных: в `src/v2/api/<домен>.ts` (свой файл на свою зону). **Query keys — те же, что у старой страницы**, чтобы кэш и инвалидация были общими. После мутаций инвалидировать те же ключи, что старая страница.
- Тексты: `useT2()` из `src/v2/i18n`. Свои ключи — в `src/v2/i18n/<домен>.ts` (`export default { ru: {...}, uz: {...} }`, ключи `v2.<домен>.*`), RU обязательно, UZ — перевод (латиница, ‘ ’). Существующие ключи старого словаря (`common.save`, `sales.*`…) можно использовать напрямую через тот же `t()`.
- Общие компоненты: `src/v2/ui` — `PageHeader`, `Dialog` (`locked` для одноразового пароля), `useConfirm()` (вместо `window.confirm`, с `reason`), `EmptyState`, `ErrorState` (с «Повторить»), `LoadingBlock`, `PageSkeleton`, `NoAccess`, `fmtNum`, `fmtMln`, `cx`. Тосты — `toast` из `src/components/ui` (sonner).
- Загрузка → `LoadingBlock`; ошибка → `ErrorState onRetry`; пусто → `EmptyState` с объяснением. Никогда «Загрузка…» навсегда, никогда нули вместо загрузки.
- Таблицы: grid-строки `.tr` с inline `gridTemplateColumns`, обёртка с `overflowX: auto` для узких экранов.
- Сложные старые компоненты с нетривиальной логикой устройства (камера `CameraCapture`, `LiveStreamPublisher`, QR-сканер, `SnapshotRequestPrompt`) — переиспользовать как есть. Всё остальное — рисовать в v2.
- Не менять файлы вне своей зоны. Нужна правка общего файла (`ui`, `shell`, `registry`, `atlas.css`) — опиши в отчёте, главный агент сделает.

## Проверка
- `cd frontend && npx tsc -b` — без ошибок.
- `npm run dev` (порт 5173, API — локальный бэкенд 8010, если запущен) → открыть страницу с `?design=v2`, Playwright-скриншот (`node` + `playwright`, уже в devDependencies), сравнить с PNG артборда, проверить консоль.
- Переключение на `?design=v1` — старая страница не изменилась.
