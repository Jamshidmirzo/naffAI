import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";

/**
 * Мягкий баннер «Не забудьте отметиться об уходе» — enforcement wave
 * 2026-08-26.
 *
 * Отображается только когда:
 *   - `open_log` есть (оператор на смене);
 *   - `checkout_reminder_active === true` (cron уже пометил
 *     open_log.checkout_reminder_sent_at);
 *   - dismissed-key НЕ выставлен в localStorage для этого log_id.
 *
 * Оранжевый (soft) стиль, не красный. Кнопка «Завершить смену» открывает
 * тот же QR-flow, что и `AttendanceStatusWidget` — но здесь мы для
 * простоты просто скроллим/направляем внимание на виджет (виджет уже на
 * дашборде). При dismiss пишем `checkout_reminder_dismissed_${log_id}` в
 * localStorage, чтобы после следующего check-in (новый log_id) баннер
 * снова появился.
 */

type OpenLog = {
  id: number;
  checked_in_at: string;
  checkout_reminder_sent_at?: string | null;
} | null;

type MeCurrent = {
  open_log: OpenLog;
  checkout_reminder_active?: boolean;
};

// Скрываем баннер на маршрутах, где он визуально мешает — например, при
// заполнении формы новой продажи или на /scan.
const HIDE_PATHS = new Set([
  "/scan",
  "/scan-photo",
  "/kiosk",
  "/login",
  "/my/sale-new",
]);

function dismissKey(logId: number): string {
  return `checkout_reminder_dismissed_${logId}`;
}

export default function CheckoutReminderBanner() {
  const t = useT();
  const loc = useLocation();

  const { data: current } = useQuery<MeCurrent>({
    queryKey: ["me-attendance-current"],
    queryFn: () => api.get<MeCurrent>("/attendance/me/current/").then((r) => r.data),
    refetchInterval: 60_000,
    retry: false,
  });

  const openLog = current?.open_log;
  const reminderActive = current?.checkout_reminder_active;

  // Локальный tick, чтобы dismiss'нувший баннер не перерисовывался пока
  // key не поменяется (следующий check-in = новый log_id).
  const [dismissed, setDismissed] = useState<Record<number, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const acc: Record<number, boolean> = {};
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("checkout_reminder_dismissed_")) {
          const id = Number(key.slice("checkout_reminder_dismissed_".length));
          if (!Number.isNaN(id)) acc[id] = true;
        }
      }
      return acc;
    } catch {
      return {};
    }
  });

  const shouldShow = useMemo(() => {
    if (!openLog || !reminderActive) return false;
    if (HIDE_PATHS.has(loc.pathname)) return false;
    if (dismissed[openLog.id]) return false;
    return true;
  }, [openLog, reminderActive, loc.pathname, dismissed]);

  if (!shouldShow || !openLog) return null;

  const onDismiss = () => {
    try {
      localStorage.setItem(dismissKey(openLog.id), "1");
    } catch {
      /* ignore quota errors — dismissal просто не переживёт reload */
    }
    setDismissed((prev) => ({ ...prev, [openLog.id]: true }));
  };

  // Кнопка «Завершить смену» ведёт на /my — там AttendanceStatusWidget
  // ловит клик и открывает QR-модал. На управленческих страницах это
  // безопасный fallback (оператор всё равно быстро попадает к виджету).
  const onGoCheckout = () => {
    onDismiss();
    if (typeof window !== "undefined") {
      // Скроллим к виджету если он на текущей странице.
      const el = document.querySelector<HTMLElement>(
        "[data-attendance-widget]",
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      window.location.href = "/my";
    }
  };

  return (
    <div
      className="w-full flex items-center gap-3 px-4 py-3"
      style={{
        background: "linear-gradient(90deg, rgba(249,115,22,.12), rgba(249,115,22,.06))",
        borderBottom: "1px solid rgba(249,115,22,.25)",
        color: "var(--text)",
      }}
      role="alert"
    >
      <AlertCircle className="w-5 h-5 shrink-0" style={{ color: "#f97316" }} />
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-semibold leading-tight">
          {t("checkout_reminder.title")}
        </div>
        <div className="text-[12px] text-muted leading-snug mt-0.5">
          {t("checkout_reminder.subtitle")}
        </div>
      </div>
      <button
        onClick={onGoCheckout}
        className="shrink-0 rounded-xl px-3 py-2 text-[13px] font-semibold text-white transition-all active:scale-[.98]"
        style={{
          background: "linear-gradient(180deg, #f97316, #ea580c)",
          boxShadow: "0 6px 14px -8px rgba(249,115,22,.55)",
        }}
      >
        {t("checkout_reminder.btn_finish")}
      </button>
      <button
        onClick={onDismiss}
        className="shrink-0 grid place-items-center rounded-full hover:bg-[color:var(--faint)] transition"
        style={{ width: 32, height: 32 }}
        aria-label={t("common.close")}
      >
        <X className="w-4 h-4" style={{ color: "var(--muted)" }} />
      </button>
    </div>
  );
}
