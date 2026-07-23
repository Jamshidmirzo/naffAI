# Волна 3 — Frontend UX и permissions

Спека для builder-агента. Задача — 8 HIGH-приоритетных фиксов frontend'а.

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. React 18 + Vite + TypeScript + Tailwind + shadcn + Zustand + React Query. Роли: `manager / team_lead / operator`. Волна 1 (backend security) уже принята — 145 passed. **Не трогать Волны 1, 2, 4, 5** — только 3.

## Задачи

### 3.1 Пагинация в `/leads` (админ) и `/my` (оператор)

- **Проблема**:
  - `frontend/src/pages/Leads.tsx:67` — `limit=100`, нет пагинации.
  - `frontend/src/pages/MyLeads.tsx` — оператор с 534 лидами видит 16 (DRF default page size).
- **Фикс**:
  1. Backend: убедиться что `PageNumberPagination` в `config/settings/base.py:REST_FRAMEWORK` даёт `count / next / previous / results`. Дефолт `PAGE_SIZE=50`.
  2. Новый компонент `frontend/src/components/Paginator.tsx`:
     ```tsx
     export function Paginator({page, total, pageSize, onChange}: Props) {
       const totalPages = Math.ceil(total / pageSize);
       // Prev / [1] ... [current] ... [totalPages] / Next
     }
     ```
  3. `Leads.tsx`: `const [page, setPage] = useSearchParams()`... → `qp.set("page", page)`. Показывать `Paginator` под таблицей.
  4. `MyLeads.tsx`: аналогично. Позиция паджинатора — под гридом карточек.
- Тесты: не требуются (frontend), но проверить визуально что клик Next меняет URL и подгружает next страницу.

### 3.2 Единый queryKey для TG-статуса

- **Проблема**: 3 разных key на один ресурс:
  - `Layout.tsx:56` — `["tg-status-indicator"]`
  - `Profile.tsx:73` — `["tg-status"]`
  - `TgDialogsPanel.tsx:8` — `["tg-status", operatorId]`
- **Фикс**:
  - В `frontend/src/lib/tgUserclient.ts` — экспорт:
    ```ts
    export const TG_STATUS_KEY = (operatorId?: number) => ["tg-status", operatorId ?? "me"] as const;
    ```
  - Заменить во всех трёх местах на `TG_STATUS_KEY(operatorId)`.
  - Мутация `revokeSession` инвалидирует `TG_STATUS_KEY()` — красная точка на аватарке пропадает моментально.

### 3.3 Обработка 403 в axios interceptor

- **Проблема**: `frontend/src/lib/api.ts:17-26` ловит только 401. 403 показывается сырым.
- **Фикс**:
  ```ts
  api.interceptors.response.use(
    (r) => r,
    (err) => {
      if (err.response?.status === 401) {
        localStorage.removeItem("naffai_token");
        window.location.href = "/login";
      } else if (err.response?.status === 403) {
        toast.error("Доступ запрещён");
        // не редиректить — оставляем на текущей странице
      }
      return Promise.reject(err);
    }
  );
  ```
- Добавить `sonner` (или `react-hot-toast`) в `package.json`, подключить `<Toaster />` в `App.tsx`.

### 3.4 Invalidate кэша после мутаций

- **Проблема**:
  - `MyLeads.tsx:294 ScheduleCallbackModal` — `onSuccess: onDone` без `qc.invalidateQueries`.
  - `MyLeads.tsx:350 CallbackDueModal` — то же.
- **Фикс** — в обеих мутациях:
  ```ts
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ["leads-my"] });
    qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
    onDone();
  }
  ```
- Проверить все остальные мутации в проекте на предмет забытой инвалидации.

### 3.5 Ролевой гейт на страницах (`RoleGate`)

- **Проблема**: `App.tsx` защищает только по токену. Оператор может ткнуть URL `/operators`, увидит 403 без объяснения.
- **Фикс**:
  1. Новый компонент `frontend/src/components/RoleGate.tsx`:
     ```tsx
     type Role = "manager" | "team_lead" | "operator";
     interface Props { allow: Role[]; children: ReactNode; }

     export function RoleGate({ allow, children }: Props) {
       const role = useAuthStore((s) => s.role);
       if (!role) return <Navigate to="/login" replace />;
       if (!allow.includes(role)) return <Navigate to="/my" replace />;
       return <>{children}</>;
     }
     ```
  2. В `App.tsx` обернуть manager-only маршруты:
     ```tsx
     <Route path="/operators" element={<RoleGate allow={["manager", "team_lead"]}><Operators /></RoleGate>} />
     <Route path="/leads" element={<RoleGate allow={["manager", "team_lead"]}><Leads /></RoleGate>} />
     <Route path="/sheet-sources" element={<RoleGate allow={["manager"]}><SheetSources /></RoleGate>} />
     <Route path="/audit" element={<RoleGate allow={["manager"]}><Audit /></RoleGate>} />
     ```

### 3.6 Общий `<Modal>` компонент с Escape и focus trap

- **Проблема**: 8+ разных модалок (`MyLeads.tsx:405 ModalShell`, `Leads.tsx:287 ReassignModal`, `AccountControls.tsx` 5 модалок, `TgConnectWizard.tsx:71`). Ни одна не закрывается по Esc, нет focus trap.
- **Фикс**:
  - Новый `frontend/src/components/Modal.tsx`:
    ```tsx
    interface Props {
      open: boolean;
      onClose: () => void;
      title: string;
      children: ReactNode;
      widthClass?: string;
    }

    export function Modal({ open, onClose, title, children, widthClass = "max-w-md" }: Props) {
      const modalRef = useRef<HTMLDivElement>(null);

      useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            // simple focus trap
            const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            if (!focusable?.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [open, onClose]);

      useEffect(() => {
        if (open) modalRef.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
      }, [open]);

      if (!open) return null;
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/60 p-4"
             onClick={onClose}>
          <div ref={modalRef}
               className={`card p-5 w-full ${widthClass}`}
               onClick={(e) => e.stopPropagation()}
               role="dialog" aria-modal="true" aria-label={title}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">{title}</h2>
              <button className="btn-ghost text-xs" onClick={onClose} aria-label="Закрыть">×</button>
            </div>
            {children}
          </div>
        </div>
      );
    }
    ```
  - Переехать все 8+ мест на `<Modal>`. `ModalShell` в MyLeads.tsx удалить.
  - Клик по overlay = закрытие. Клик внутри карточки = не закрывает.

### 3.7 URL search params для фильтров `/leads`

- **Проблема**: `frontend/src/pages/Leads.tsx:41-46` — фильтры в `useState`. F5 — всё сбрасывается.
- **Фикс**:
  ```tsx
  const [searchParams, setSearchParams] = useSearchParams();
  const status = (searchParams.get("status") as LeadStatus) || "";
  const needsReview = searchParams.get("needs_review") === "1";
  const phoneInvalid = searchParams.get("phone_invalid") === "1";
  const search = searchParams.get("search") || "";
  const sheetSourceId = searchParams.get("sheet_source") ? Number(searchParams.get("sheet_source")) : null;
  const page = Number(searchParams.get("page")) || 1;

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    next.delete("page"); // reset page on filter change
    setSearchParams(next);
  };
  ```
- Все `onChange` вызывают `setFilter(...)` вместо `useState` setter'а.

### 3.8 Пункт «Требуют проверки» в навигации

- **Проблема**: 10 348 лидов с `needs_review=true` + 1 738 с `phone_invalid=true` — теряются в общем списке.
- **Фикс** в `Layout.tsx`:
  - Для `manager` / `team_lead` — добавить пункт:
    ```tsx
    { to: "/leads?needs_review=1", label: "Требуют проверки", icon: AlertTriangle,
      badge: needsReviewCount }
    ```
  - Показывать badge с числом (запрос `GET /api/leads/?needs_review=1&count_only=1` — если у API есть, иначе через `count` из paginated response).

## Порядок работ

Порядок 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 3.1 → 3.8 (сначала быстрые, потом крупные компоненты).

## Стиль

- TypeScript strict — никакого `any`. Для ошибок — `type ApiError = { response?: { data?: { detail?: string } } }`.
- Tailwind классы группировать логично: layout / spacing / colors / effects.
- Никаких эмодзи в коде.
- `shadcn/ui` уже установлен — использовать компоненты `Button`, `Input`, `Toast` вместо самопальных где уместно.
- Не создавать новые markdown-файлы.

## Проверка

- `npx tsc --noEmit` — 0 ошибок.
- Ручной прогон:
  - Оператор пытается зайти на `/operators` → редирект на `/my`.
  - `/leads?needs_review=1` работает после F5.
  - Esc закрывает любую модалку.
  - После callback → таблица `/my` обновляется без ручного refresh.
  - 403 показывает toast «Доступ запрещён».
  - Пагинация: 534 лида, 11 страниц по 50, next/prev работают.

## Финальный отчёт

- 8 подзадач: file:line ключевых изменений.
- Скриншоты (описание): пагинатор, RoleGate редирект, Modal с Esc, toast 403.
- Список открытых вопросов если появятся.
