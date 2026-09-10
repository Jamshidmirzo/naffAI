/**
 * «Утечки» — компактная карточка на Dashboard (виджет Lead Health).
 *
 * 4 строки:
 *   1. system_lost за 24ч (число + сравнение со средним за 7 дней).
 *   2. Лиды в no_answer* застряли >48ч без обновления.
 *   3. Операторы с процентом lost за 24ч > 40% (топ-3 имени).
 *   4. Sync errors на активных SheetSource'ах (+ клик → /sheet-sources).
 *
 * Данные: `GET /api/analytics/lead-health/`. Виджет доступен только
 * менеджеру/team_lead — Dashboard уже под RoleGate.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";

export interface LeadHealthPayload {
  generated_at: string;
  sheet_sources: Array<{ id: number; name: string; last_sync_error: string | null }>;
  leaks: {
    system_lost_24h: number;
    system_lost_7d_avg: number;
    stale_no_answer_48h: number;
    high_lost_operators: Array<{
      operator_id: number;
      name: string;
      closed: number;
      lost: number;
      lost_pct: number;
    }>;
    sync_errors: Array<{ source_id: number; source_name: string; error: string }>;
  };
  bottlenecks: Array<{ status: string; count: number; avg_days_in_status: number }>;
}

export function HealthLeaks({ data }: { data: LeadHealthPayload | undefined }) {
  const t = useT();
  const nav = useNavigate();

  const leaks = data?.leaks;
  const systemLost24h = leaks?.system_lost_24h ?? 0;
  const avg7d = leaks?.system_lost_7d_avg ?? 0;
  // «Skyrocketing»: 24h > 7d avg * 1.3.
  const skyrocketing = systemLost24h > 0 && avg7d > 0 && systemLost24h > avg7d * 1.3;

  const stale = leaks?.stale_no_answer_48h ?? 0;
  const hiLost = leaks?.high_lost_operators ?? [];
  const syncErrs = leaks?.sync_errors ?? [];

  return (
    <div className="nf-card p-4 flex flex-col gap-3" style={{ minWidth: 240 }}>
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" style={{ color: "var(--danger, #dc2626)" }} />
        <div className="font-semibold text-[14px]">{t("dash.health.leaks_title")}</div>
      </div>

      <Row
        label={t("dash.health.system_lost_24h")}
        value={
          <span
            className={skyrocketing ? "font-semibold" : ""}
            style={skyrocketing ? { color: "var(--danger, #dc2626)" } : undefined}
          >
            {systemLost24h}
          </span>
        }
        hint={t("dash.health.system_lost_avg", { n: String(avg7d) })}
        onClick={() => nav("/leads/system-lost")}
      />

      <Row
        label={t("dash.health.stale_no_answer")}
        value={stale}
        onClick={() => nav("/leads?status=no_answer")}
      />

      <Row
        label={t("dash.health.high_lost_ops")}
        value={hiLost.length > 0 ? `${hiLost.length}` : "—"}
        hint={
          hiLost.length > 0
            ? hiLost.map((o) => `${o.name} (${o.lost_pct}%)`).join(", ")
            : undefined
        }
        onClick={hiLost.length > 0 ? () => nav("/leads-stats") : undefined}
      />

      <Row
        label={t("dash.health.sync_errors")}
        value={syncErrs.length > 0 ? syncErrs.length : "—"}
        hint={syncErrs.length > 0 ? syncErrs.map((s) => s.source_name).join(", ") : undefined}
        onClick={() => nav("/sheet-sources")}
        danger={syncErrs.length > 0}
      />
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  onClick,
  danger,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={
        "flex items-center justify-between gap-2 text-left rounded-lg px-2 py-1.5 " +
        (onClick ? "hover:bg-[color:var(--faint)]" : "cursor-default")
      }
      style={{ minHeight: 34 }}
    >
      <div className="flex flex-col min-w-0">
        <div className="text-[12.5px] text-muted">{label}</div>
        {hint && (
          <div
            className="text-[11px] truncate mt-0.5"
            style={{ color: danger ? "var(--danger, #dc2626)" : "var(--muted)" }}
            title={hint}
          >
            {hint}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <div className="text-[15px] font-semibold tabular-nums">{value}</div>
        {onClick && <ChevronRight className="w-3.5 h-3.5 text-muted" />}
      </div>
    </button>
  );
}

/** React-Query loader — виджет и `FunnelBottleneck` берут одни и те же данные. */
export function useLeadHealth() {
  return useQuery<LeadHealthPayload>({
    queryKey: ["lead-health"],
    queryFn: () => api.get("/analytics/lead-health/").then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}
