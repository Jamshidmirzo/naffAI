import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, FileSpreadsheet, Settings2 } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "../lib/api";
import { apiErrorMessage, type ApiError } from "../lib/api-types";
import { toast } from "../components/ui";
import { useT } from "../lib/i18n";

type StatusRow = {
  code: string;
  label_ru: string;
  label_uz: string;
  tone: string;
  emoji: string;
  count: number;
  pct: number;
};

type OperatorRow = {
  operator_id: number;
  operator_name: string;
  total: number;
  won: number;
  lost: number;
  in_progress: number;
  // Backend may not send these fields on older deploys — treat as
  // optional and default to 0 in the render step so the UI stays
  // graceful during a rolling deploy (frontend can hit an old backend).
  sold_total?: number;
  calls_total?: number;
  unique_leads_touched?: number;
  conversion_pct: number;
};

type DailyRow = { date: string; created: number; won: number; lost: number };

type StatsResponse = {
  total: number;
  by_status: StatusRow[];
  by_operator: OperatorRow[];
  daily: DailyRow[];
};

// Solid accent used for the top stripe of each chip. Kept saturated
// so it reads at a glance without staining the whole card.
const TONE_ACCENT: Record<string, string> = {
  neutral: "#94a3b8", // slate-400
  info: "#3b82f6",    // blue-500
  hot: "#f97316",     // orange-500
  danger: "#ef4444",  // red-500
  success: "#10b981", // emerald-500
};

// Six preset chips + one custom-range option. Presets are computed on
// the client and always sent to the backend as YYYY-MM-DD `date_from`+
// `date_to` — the backend also still accepts the legacy `?period=` param
// (backwards compat), but the FE consistently uses the explicit shape.
type Preset =
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "this_month"
  | "custom";

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetRange(preset: Preset): { from: string; to: string } | null {
  const now = new Date();
  const today = fmt(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: fmt(y), to: fmt(y) };
  }
  if (preset === "week") {
    const past = new Date(now);
    past.setDate(past.getDate() - 6);
    return { from: fmt(past), to: today };
  }
  if (preset === "month") {
    const past = new Date(now);
    past.setDate(past.getDate() - 29);
    return { from: fmt(past), to: today };
  }
  if (preset === "this_month") {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: fmt(first), to: today };
  }
  return null; // custom
}

// Retry-export: описания структур ответа /api/settings/retry-export/.
type RetryLabel = {
  code: string;
  label_ru: string;
  label_uz: string;
  tone: string;
  emoji: string;
};
type RetryStatusesResp = { statuses: string[]; available: RetryLabel[] };

export default function LeadsStats() {
  const t = useT();
  const qc = useQueryClient();
  const [preset, setPreset] = useState<Preset>("today");
  const initial = presetRange("today")!;
  const [dateFrom, setDateFrom] = useState(initial.from);
  const [dateTo, setDateTo] = useState(initial.to);
  // Раскрытие блока «Retry статусы» — по умолчанию свёрнут, чтобы не
  // отвлекать; менеджер разворачивает, когда надо поменять выбор.
  const [statusesOpen, setStatusesOpen] = useState(false);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
    new Set(),
  );

  const applyPreset = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p);
    if (r) {
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  };

  const q = useQuery<StatsResponse>({
    queryKey: ["lead-stats", dateFrom, dateTo],
    queryFn: () =>
      api
        .get<StatsResponse>("/analytics/lead-stats/", {
          params: { date_from: dateFrom, date_to: dateTo },
        })
        .then((r) => r.data),
  });

  // Retry-export: снапшот всех лидов в sms_jonatildi + contacted_telegram
  // в отдельный tab Google Sheet'а. Кнопка в шапке. При успехе toast с
  // action-кнопкой «Открыть», при 409 (уже формируется) — info-toast.
  interface RetryExportResponse {
    count: number;
    spreadsheet_id: string;
    tab_name: string;
    gid: number;
    url: string;
    exported_at: string;
  }
  const retryExportMut = useMutation({
    mutationFn: () =>
      api
        .post<RetryExportResponse>("/leads/retry-export/")
        .then((r) => r.data),
    onSuccess: (d) => {
      toast.success(t("leads_stats.retry_export.success", { n: d.count }), {
        action: {
          label: t("leads_stats.retry_export.open"),
          onClick: () => window.open(d.url, "_blank", "noopener"),
        },
        duration: 8000,
      });
    },
    onError: (err: unknown) => {
      const status = (err as ApiError)?.response?.status;
      if (status === 409) {
        toast.message(t("leads_stats.retry_export.busy"));
      } else {
        toast.error(apiErrorMessage(err));
      }
    },
  });

  // Retry-статусы: подгружаем текущий выбор + список доступных
  // LeadStatusLabel только когда блок раскрыт (иначе — лишний запрос
  // при каждой навигации на /leads-stats).
  const statusesQuery = useQuery<RetryStatusesResp>({
    queryKey: ["retry-export-statuses"],
    queryFn: () =>
      api
        .get<RetryStatusesResp>("/settings/retry-export/")
        .then((r) => r.data),
    enabled: statusesOpen,
    staleTime: 30_000,
  });

  // Инициализируем локальный state выбранных статусов из сервера при
  // первой загрузке (или при повторном раскрытии) — чтобы отменённые
  // изменения не сохранялись.
  useEffect(() => {
    if (statusesQuery.data) {
      setSelectedStatuses(new Set(statusesQuery.data.statuses));
    }
  }, [statusesQuery.data]);

  const statusesMut = useMutation({
    mutationFn: (statuses: string[]) =>
      api
        .patch<RetryStatusesResp>("/settings/retry-export/", { statuses })
        .then((r) => r.data),
    onSuccess: (d) => {
      toast.success(t("leads_stats.retry_statuses.saved"));
      qc.setQueryData<RetryStatusesResp>(
        ["retry-export-statuses"],
        (old) =>
          old ? { ...old, statuses: d.statuses } : { statuses: d.statuses, available: [] },
      );
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const toggleStatus = (code: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const data = q.data;

  const statusChartData = useMemo(
    () =>
      (data?.by_status || []).map((s) => ({
        name: s.label_ru || s.code,
        count: s.count,
        pct: s.pct,
        tone: s.tone,
      })),
    [data],
  );

  const dailyChartData = useMemo(() => data?.daily || [], [data]);

  const PRESETS: { value: Preset; label: string }[] = [
    { value: "today", label: t("reports.activity.presets.today") },
    { value: "yesterday", label: t("reports.activity.presets.yesterday") },
    { value: "week", label: t("reports.activity.presets.week") },
    { value: "month", label: t("reports.activity.presets.month") },
    { value: "this_month", label: t("reports.activity.presets.this_month") },
    { value: "custom", label: t("reports.activity.presets.custom") },
  ];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Header + period chips + custom range */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-[22px] font-semibold">{t("leads_stats.title")}</h1>
          <div className="text-[13px] text-muted mt-0.5">
            {t("leads_stats.subtitle")}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => applyPreset(p.value)}
              className="px-3 py-1.5 rounded-full text-[12.5px] font-medium border transition"
              style={{
                borderColor:
                  preset === p.value ? "var(--accent)" : "var(--border)",
                background:
                  preset === p.value ? "var(--accent)" : "transparent",
                color: preset === p.value ? "#fff" : "var(--fg)",
              }}
            >
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-2 ml-1">
              <Calendar className="w-3.5 h-3.5 text-muted" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="nf-input py-1.5 px-2.5 w-auto text-[12.5px]"
              />
              <span className="text-muted">—</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="nf-input py-1.5 px-2.5 w-auto text-[12.5px]"
              />
            </div>
          )}
          {/* Retry-статусы: выбор статусов для retry-export'a (шестерёнка).
              Кнопка-toggle сворачивает/раскрывает панель ниже. */}
          <button
            type="button"
            onClick={() => setStatusesOpen((v) => !v)}
            title={t("leads_stats.retry_statuses.hint")}
            className="ml-1 px-3 py-1.5 rounded-full text-[12.5px] font-medium border transition flex items-center gap-1.5"
            style={{
              borderColor: statusesOpen ? "var(--accent)" : "var(--border)",
              background: statusesOpen ? "var(--accent)" : "var(--surface)",
              color: statusesOpen ? "#fff" : "var(--fg)",
            }}
          >
            <Settings2 className="w-3.5 h-3.5" />
            {t("leads_stats.retry_statuses.button")}
          </button>
          {/* Retry-export: снимок выбранных статусов в отдельный tab Sheets */}
          <button
            type="button"
            onClick={() => retryExportMut.mutate()}
            disabled={retryExportMut.isPending}
            title={t("leads_stats.retry_export.hint")}
            className="ml-1 px-3 py-1.5 rounded-full text-[12.5px] font-medium border transition flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-wait"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface)",
              color: "var(--fg)",
            }}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            {retryExportMut.isPending
              ? t("leads_stats.retry_export.pending")
              : t("leads_stats.retry_export.button")}
          </button>
        </div>
      </div>

      {/* Retry-статусы: панель выбора. Разворачивается по кнопке-шестерёнке
          в шапке. Каждый LeadStatusLabel = чип-toggle. Кнопка «Сохранить»
          пишет в SystemSetting.retry_export_statuses через сервис. */}
      {statusesOpen && (
        <section
          className="rounded-[16px] border p-4"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[14px] font-semibold">
                {t("leads_stats.retry_statuses.title")}
              </div>
              <div className="text-[12px] text-muted mt-0.5 max-w-[560px]">
                {t("leads_stats.retry_statuses.subtitle")}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted">
                {t("leads_stats.retry_statuses.count", {
                  n: selectedStatuses.size,
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  statusesMut.mutate(Array.from(selectedStatuses))
                }
                disabled={statusesMut.isPending || statusesQuery.isLoading}
                className="px-3 py-1.5 rounded-full text-[12.5px] font-medium transition disabled:opacity-60 disabled:cursor-wait"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                {statusesMut.isPending
                  ? t("leads_stats.retry_statuses.saving")
                  : t("leads_stats.retry_statuses.save")}
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {statusesQuery.isLoading && (
              <div className="text-[13px] text-muted">
                {t("common.loading")}
              </div>
            )}
            {(statusesQuery.data?.available || []).map((s) => {
              const on = selectedStatuses.has(s.code);
              const accent = TONE_ACCENT[s.tone] || TONE_ACCENT.neutral;
              return (
                <button
                  key={s.code}
                  type="button"
                  onClick={() => toggleStatus(s.code)}
                  className="px-2.5 py-1.5 rounded-full text-[12px] font-medium border transition flex items-center gap-1.5"
                  style={{
                    borderColor: on ? accent : "var(--border)",
                    background: on ? accent : "transparent",
                    color: on ? "#fff" : "var(--fg)",
                  }}
                >
                  {on && <Check className="w-3 h-3" />}
                  {s.emoji && <span>{s.emoji}</span>}
                  <span>{s.label_ru || s.code}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Total card */}
      <div
        className="rounded-[20px] px-6 py-5 flex items-center gap-4"
        style={{
          background: "linear-gradient(100deg, var(--accent), var(--accent2))",
          color: "#fff",
        }}
      >
        <div className="flex-1">
          <div className="text-[13px] opacity-90">{t("leads_stats.total_label")}</div>
          <div className="text-[36px] font-semibold leading-tight tabular-nums">
            {q.isLoading ? "…" : (data?.total ?? 0)}
          </div>
        </div>
      </div>

      {/* By status */}
      <section className="rounded-[16px] border p-5" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-[16px] font-semibold mb-3">
          {t("leads_stats.by_status")}
        </h2>
        {statusChartData.length === 0 ? (
          <div className="text-[13px] text-muted">{t("leads_stats.no_data")}</div>
        ) : (
          <>
            {/* Horizontal bars — vertical layout would clip long uz labels
                like «TG'га боғланди» when the pool grows past ~7 statuses.
                Height auto-scales with row count so every status is legible. */}
            <div
              style={{
                width: "100%",
                height: Math.max(180, statusChartData.length * 30 + 24),
              }}
            >
              <ResponsiveContainer>
                <BarChart
                  data={statusChartData}
                  layout="vertical"
                  margin={{ top: 4, right: 24, bottom: 4, left: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tick={{ fontSize: 12 }}
                    width={140}
                    interval={0}
                  />
                  <Tooltip
                    formatter={(value: number, _n, entry) => [
                      `${value} · ${(entry.payload as { pct: number }).pct}%`,
                      "лидов",
                    ]}
                  />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                    {statusChartData.map((s, i) => (
                      <Cell
                        key={i}
                        fill={TONE_ACCENT[s.tone] || TONE_ACCENT.neutral}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {(data?.by_status || []).map((s) => {
                const accent = TONE_ACCENT[s.tone] || TONE_ACCENT.neutral;
                return (
                  <div
                    key={s.code}
                    className="relative rounded-lg border px-3 pt-3 pb-2 text-[12.5px] overflow-hidden"
                    style={{
                      background: "var(--surface)",
                      borderColor: "var(--border)",
                    }}
                  >
                    {/* colour cue as a thin top stripe — cheap-to-scan, keeps
                        the card body high-contrast for the number + label. */}
                    <span
                      className="absolute top-0 left-0 right-0"
                      style={{ height: 3, background: accent }}
                    />
                    <div
                      className="font-medium truncate flex items-center gap-1.5"
                      style={{ color: "var(--fg)" }}
                    >
                      {s.emoji && <span>{s.emoji}</span>}
                      <span className="truncate">{s.label_ru || s.code}</span>
                    </div>
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                      <span
                        className="text-[18px] font-semibold tabular-nums leading-none"
                        style={{ color: accent }}
                      >
                        {s.count}
                      </span>
                      <span className="text-[11px] text-muted tabular-nums">
                        {s.pct}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* By operator */}
      <section className="rounded-[16px] border p-5" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-[16px] font-semibold mb-3">
          {t("leads_stats.by_operator")}
        </h2>
        {(data?.by_operator || []).length === 0 ? (
          <div className="text-[13px] text-muted">{t("leads_stats.no_data")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left border-b" style={{ borderColor: "var(--border)" }}>
                  <th className="py-2 pr-3">{t("leads_stats.op_name")}</th>
                  <th className="py-2 px-3 text-right">{t("leads_stats.op_total")}</th>
                  <th
                    className="py-2 px-3 text-right"
                    title={t("leads_stats.op_calls_total_hint")}
                  >
                    {t("leads_stats.op_calls_total")}
                  </th>
                  <th
                    className="py-2 px-3 text-right"
                    title={t("leads_stats.op_unique_leads_hint")}
                  >
                    {t("leads_stats.op_unique_leads")}
                  </th>
                  <th
                    className="py-2 px-3 text-right"
                    title={t("leads_stats.op_won_hint")}
                  >
                    {t("leads_stats.op_won")}
                  </th>
                  <th
                    className="py-2 px-3 text-right"
                    title={t("leads_stats.op_sold_total_hint")}
                  >
                    {t("leads_stats.op_sold_total")}
                  </th>
                  <th className="py-2 px-3 text-right">{t("leads_stats.op_in_progress")}</th>
                  <th className="py-2 px-3 text-right">{t("leads_stats.op_lost")}</th>
                  <th className="py-2 pl-3 text-right">{t("leads_stats.op_conversion")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_operator || []).map((r) => (
                  <tr key={r.operator_id} className="border-b" style={{ borderColor: "var(--border)" }}>
                    <td className="py-2 pr-3">{r.operator_name}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium">{r.total}</td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {r.calls_total ?? 0}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {r.unique_leads_touched ?? 0}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums" style={{ color: "#059669" }}>
                      {r.won}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium" style={{ color: "#059669" }}>
                      {r.sold_total ?? 0}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.in_progress}</td>
                    <td className="py-2 px-3 text-right tabular-nums" style={{ color: "#dc2626" }}>
                      {r.lost}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums font-medium">
                      {r.conversion_pct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Daily */}
      {dailyChartData.length > 1 && (
        <section className="rounded-[16px] border p-5" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-[16px] font-semibold mb-3">
            {t("leads_stats.daily")}
          </h2>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={dailyChartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="created"
                  name={t("leads_stats.d_created")}
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="won"
                  name={t("leads_stats.d_won")}
                  stroke="#059669"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="lost"
                  name={t("leads_stats.d_lost")}
                  stroke="#dc2626"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}
    </div>
  );
}
