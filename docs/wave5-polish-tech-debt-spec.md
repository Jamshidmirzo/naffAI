# Волна 5 — Полировка и технический долг

Спека для builder-агента. 10 LOW/MEDIUM задач: мёртвый код, типы, документация, мелкий UX.

**Контекст**: Волны 1-4 приняты. **Не трогать их** — только 5. Проект `/Users/user/Desktop/mp/ai/naff/`.

## Задачи

### 5.1 TypeScript `any` → строгие типы

- **Проблема**: 20+ мест `err: any` и `data: any` в мутациях. Аудит перечислил:
  - `TgConnectWizard.tsx:34,35,51,66`
  - `Leads.tsx:283`
  - `MyLeads.tsx:242,300`
  - `Operators.tsx:57,79`
  - Также в `Sales.tsx`, `Analytics.tsx`, `Screen.tsx` — сделать grep, найти всё.
- **Фикс**:
  - Новый файл `frontend/src/lib/api-types.ts`:
    ```ts
    export interface ApiError {
      response?: {
        status?: number;
        data?: {
          detail?: string;
          [k: string]: string[] | string | undefined;
        };
      };
      message?: string;
    }

    export function apiErrorMessage(err: unknown): string {
      const e = err as ApiError;
      return (
        e?.response?.data?.detail ||
        (typeof e?.response?.data === "object" && Object.values(e.response.data)[0]?.toString()) ||
        e?.message ||
        "Ошибка"
      );
    }
    ```
  - Все `err: any` → `err: unknown`, использовать `apiErrorMessage(err)`.
  - `data: any` в React Query — типизировать через generic: `useQuery<TResult>`.

### 5.2 Убрать неиспользуемые React импорты

- **Проблема**: `import React, { useState } from "react"` в React 18+ с автомат JSX — React в scope не нужен.
- **Файлы**: `TgConnectWizard.tsx:1`, `TgDialogsPanel.tsx:1`.
- **Фикс**: `import { useState } from "react"`.
- Прогнать `grep -rn "^import React," frontend/src/` — найти все, убрать.

### 5.3 aria-label ко всем icon-only кнопкам

- **Проблема**: Иконки без текста — без aria-label только `title` (screen reader'ы не читают).
- **Файлы**:
  - `AccountControls.tsx:268-300` — 5 icon-кнопок (KeyRound, RefreshCcw, Lock, Unlock, Trash2).
  - `MyLeads.tsx:132-181` — 6 кнопок (Phone, CheckCircle2, AlarmClock, PhoneMissed, MessageCircle, XCircle).
- **Фикс**: Добавить `aria-label="Сбросить пароль"` и т.п. везде.

### 5.4 Дефолт API URL в frontend

- **Проблема**: `frontend/src/lib/api.ts:4` — дефолт `http://localhost:8000/api`, а Django на `8001`.
- **Фикс**: `... || "http://localhost:8001/api"`.

### 5.5 Синхронизировать docs с реализацией

- **Проблема**: После Волны 2.4 `FloodWaitError` над 5 минут переводится в PENDING, а `docs/tg-integration-spec.md` описывает старое поведение.
- **Фикс**:
  - Обновить `docs/tg-integration-spec.md` — секция §10 (Ошибки и edge cases): описать новое поведение FloodWait (при `>5min` → status=PENDING, runner подхватит позже).
  - Обновить `docs/tg-backfill-spec.md` — §11 таблица ошибок.
  - `README.md` — раздел «Google Sheets setup» упорядочить: указать точную последовательность (bootstrap → share sheet with SA email → set env → run sync).

### 5.6 Payroll documentation

- **Проблема**: Нигде не описано как считается payroll когда оператор неактивен часть месяца.
- **Фикс**: `README.md` раздел «Payroll — как считается»:
  - Порог активности (кол-во продаж/callback'ов минимум)
  - Пропорционально дням активности?
  - Считаются ли callback'и в KPI?
  - Прочитать `apps/payroll/services.py` и описать текущее поведение.

### 5.7 Мёртвый `useEffect(() => {}, [])`

- **Проблема**: `SheetSources.tsx:401` — `useEffect(() => { /* no-op */ }, [])`.
- **Фикс**: Удалить.
- Прогнать grep на другие мертвые useEffect: `grep -rn "useEffect.*=&gt; {\s*}\s*," frontend/src/`.

### 5.8 `formatDate` использовать везде

- **Проблема**: Inline `new Date().toLocaleString()` в `TgDialogsPanel.tsx:91,134`.
- **Фикс**: Импортировать `formatDate` из `lib/format.ts`, заменить inline.

### 5.9 Инструкция запуска `retry_tg_backfill` в README

- **Проблема**: Management-команда есть, но в README не описана.
- **Фикс** — раздел «Управление Telegram User-Client»:
  ```markdown
  ## Пересобрать backfill для оператора
  
  Если backfill упал (status=ERROR) или его нужно повторить:
  ```
  python manage.py retry_tg_backfill --operator <id>
  python manage.py retry_tg_backfill --session <id>
  python manage.py retry_tg_backfill --all-errors
  ```
  ```

### 5.10 Плашка «alias не привязан» на `/sheet-sources`

- **Проблема**: Alias'ы `Nihola / Sevara / Yasmina / Abdulaziz` бывают unbound. UI показывает, но не выделяет визуально.
- **Фикс** в `frontend/src/pages/SheetSources.tsx` — если `alias.operator === null`:
  ```tsx
  <span className="badge bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
    Не привязан
  </span>
  ```
  Плюс в заголовке страницы — счётчик «N неснопривязанных alias'ов» жёлтым.

## Порядок работ

5.2 → 5.4 → 5.7 → 5.8 → 5.1 → 5.3 → 5.10 → 5.5 → 5.6 → 5.9 (от мелких к крупным).

## Стиль

- TypeScript strict, никакого `any`.
- Никаких эмодзи в коде.
- Markdown-файлы — только обновлять существующие, новых не создавать.
- По коммиту на подзадачу.

## Проверка

- `npx tsc --noEmit` — 0 ошибок, 0 warnings по `any`.
- Регресс `pytest -q` — не изменяется (Волна 5 фронт + docs, backend почти не трогает).
- Ручной прогон: /profile отображает даты правильно, /sheet-sources подсвечивает unbound alias, кнопки в AccountControls читаются screen reader'ом (VoiceOver в Mac).

## Финальный отчёт

- 10 подзадач: file:line изменений.
- Итог tsc.
- Обновлённые докспеки и README перечислить.
