/**
 * «Bottleneck» — компактная карточка на Dashboard (виджет Lead Health).
 *
 * Показывает топ-3 «застрявших» non-terminal статуса за последние 7 дней:
 * количество лидов и средний срок в статусе. Клик по строке → фильтр
 * в /leads по статусу — менеджер идёт туда работать вручную.
 *
 * Данные — те же что и `HealthLeaks`, приходят из хука `useLeadHealth()`.
 */

import { useNavigate } from "react-router-dom";
import { ChevronRight, Activity } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { LeadHealthPayload } from "./HealthLeaks";

// Локализованные ярлыки для статусов (fallback: сырой code).
// Статусы приходят в snake_case из бэка (LeadStatus enum).
const STATUS_LABELS_RU: Record<string, string> = {
  in_progress: "В работе",
  no_answer: "Не ответил (1)",
  no_answer_2: "Не ответил (2)",
  phone_on: "Телефон включён",
  callback_scheduled: "Запланирован callback",
  sms_jonatildi: "SMS отправлен",
  waiting_salary: "Ждёт зарплату",
  has_debt: "Есть долг",
  qimmatlik_qildi: "Дорого",
};

export function FunnelBottleneck({ data }: { data: LeadHealthPayload | undefined }) {
  const t = useT();
  const nav = useNavigate();

  const items = data?.bottlenecks ?? [];

  return (
    <div className="nf-card p-4 flex flex-col gap-3" style={{ minWidth: 240 }}>
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4" style={{ color: "var(--accent, #6366f1)" }} />
        <div className="font-semibold text-[14px]">{t("dash.health.bottleneck_title")}</div>
      </div>

      {items.length === 0 ? (
        <div className="text-[12px] text-muted py-3 text-center">
          {t("dash.health.bottleneck_empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((b) => (
            <button
              key={b.status}
              type="button"
              onClick={() =>
                nav(`/leads?status=${encodeURIComponent(b.status)}`)
              }
              className="flex items-center justify-between gap-2 text-left rounded-lg px-2 py-1.5 hover:bg-[color:var(--faint)]"
              style={{ minHeight: 42 }}
            >
              <div className="min-w-0">
                <div className="text-[13px] truncate">
                  {STATUS_LABELS_RU[b.status] || b.status}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {t("dash.health.avg_days", { n: b.avg_days_in_status.toFixed(1) })}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <div className="text-[15px] font-semibold tabular-nums">{b.count}</div>
                <ChevronRight className="w-3.5 h-3.5 text-muted" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
