import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Users } from "lucide-react";
import { api } from "../lib/api";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import { Chip, type TabItem } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT, useLangValue } from "../lib/i18n";

/**
 * Manager-facing per-operator activity report:
 *   sonar-style table «сколько лидов оператор обзвонил + какие у них
 *   текущие статусы» за произвольный диапазон дат (сегодня / вчера /
 *   7дн / 30дн / этот месяц / свой). Не под PIN-гейтом, в отличие от
 *   attendance-отчёта.
 *
 * Backend: GET /api/reports/operator-activity/?date_from=&date_to=[&operator=]
 * Selector: apps.calls.selectors.operator_activity_report
 */

type Preset = "today" | "yesterday" | "week" | "month" | "this_month" | "custom";

interface Operator {
  id: number;
  full_name: string;
}

interface ActivityRow {
  operator_id: number;
  operator_name: string;
  unique_leads_touched: number;
  calls_total: number;
  by_status: Record<string, number>;
}

interface ActivityReportResponse {
  period: { from: string; to: string };
  rows: ActivityRow[];
}

interface StatusLabel {
  id: number;
  code: string;
  label_ru: string;
  label_uz: string;
  tone: "neutral" | "hot" | "danger" | "success" | "info";
  emoji: string;
  sort_order: number;
}

const toneToColor: Record<StatusLabel["tone"], string> = {
  neutral: "var(--muted)",
  hot: "#f59e0b",
  danger: "#ef4444",
  success: "#10b981",
  info: "#3b82f6",
};

// Local date helper (YYYY-MM-DD) that uses browser local time — matches
// how backend interprets the request (Asia/Tashkent is Asia/Tashkent
// everywhere the app runs).
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

export default function OperatorActivityReport() {
  const t = useT();
  const lang = useLangValue();
  usePageHeader({
    title: t("reports.activity.title"),
    subtitle: t("reports.activity.subtitle"),
  });

  const [preset, setPreset] = useState<Preset>("today");
  const initial = presetRange("today")!;
  const [dateFrom, setDateFrom] = useState(initial.from);
  const [dateTo, setDateTo] = useState(initial.to);
  const [selectedOpIds, setSelectedOpIds] = useState<number[]>([]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p);
    if (r) {
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  };

  const presetTabs: TabItem<Preset>[] = [
    { value: "today", label: t("reports.activity.presets.today") },
    { value: "yesterday", label: t("reports.activity.presets.yesterday") },
    { value: "week", label: t("reports.activity.presets.week") },
    { value: "month", label: t("reports.activity.presets.month") },
    { value: "this_month", label: t("reports.activity.presets.this_month") },
    { value: "custom", label: t("reports.activity.presets.custom") },
  ];

  const { data: operatorsRaw } = useQuery<Operator[] | { results: Operator[] }>({
    queryKey: ["operators-list"],
    queryFn: () =>
      api
        .get<Operator[] | { results: Operator[] }>("/operators/")
        .then((r) => r.data),
  });

  const operators = useMemo<Operator[]>(
    () =>
      Array.isArray(operatorsRaw)
        ? operatorsRaw
        : (operatorsRaw?.results ?? []),
    [operatorsRaw],
  );

  const popoverOptions = useMemo(
    () => operators.map((o) => ({ id: o.id, name: o.full_name })),
    [operators],
  );

  const { data: statusesRaw } = useQuery<
    StatusLabel[] | { results: StatusLabel[] }
  >({
    queryKey: ["lead-statuses"],
    queryFn: () =>
      api
        .get<StatusLabel[] | { results: StatusLabel[] }>("/lead-statuses/")
        .then((r) => r.data),
  });

  const statuses = useMemo<StatusLabel[]>(
    () =>
      Array.isArray(statusesRaw)
        ? statusesRaw
        : (statusesRaw?.results ?? []),
    [statusesRaw],
  );

  const statusByCode = useMemo(() => {
    const m = new Map<string, StatusLabel>();
    for (const s of statuses) m.set(s.code, s);
    return m;
  }, [statuses]);

  const { data, isLoading, error } = useQuery<ActivityReportResponse>({
    queryKey: ["operator-activity", dateFrom, dateTo, selectedOpIds],
    queryFn: () => {
      const ops =
        selectedOpIds.length > 0 ? `&operator=${selectedOpIds.join(",")}` : "";
      return api
        .get<ActivityReportResponse>(
          `/reports/operator-activity/?date_from=${dateFrom}&date_to=${dateTo}${ops}`,
        )
        .then((r) => r.data);
    },
  });

  // Union of status codes across all rows — dynamic columns. Sort by
  // total row-count desc so hotter statuses land on the left.
  const dynamicStatusCodes = useMemo<string[]>(() => {
    if (!data?.rows) return [];
    const totals: Record<string, number> = {};
    for (const row of data.rows) {
      for (const [code, n] of Object.entries(row.by_status)) {
        totals[code] = (totals[code] || 0) + n;
      }
    }
    return Object.keys(totals).sort(
      (a, b) => totals[b] - totals[a] || a.localeCompare(b),
    );
  }, [data]);

  const statusLabel = (code: string): string => {
    const s = statusByCode.get(code);
    if (!s) return code;
    if (lang === "uz" && s.label_uz) return s.label_uz;
    return s.label_ru;
  };

  const statusColor = (code: string): string => {
    const s = statusByCode.get(code);
    if (!s) return "var(--muted)";
    return toneToColor[s.tone] ?? "var(--muted)";
  };

  // Totals row across all operators.
  const totals = useMemo(() => {
    const acc = {
      unique: 0,
      calls: 0,
      byStatus: {} as Record<string, number>,
    };
    if (!data?.rows) return acc;
    for (const row of data.rows) {
      acc.unique += row.unique_leads_touched;
      acc.calls += row.calls_total;
      for (const [code, n] of Object.entries(row.by_status)) {
        acc.byStatus[code] = (acc.byStatus[code] || 0) + n;
      }
    }
    return acc;
  }, [data]);

  const gridCols = `1.4fr .8fr .8fr repeat(${Math.max(1, dynamicStatusCodes.length)}, minmax(90px, 1fr))`;

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Preset chips + custom date inputs */}
      <section className="nf-card p-4 flex flex-wrap items-center gap-4 animate-nfFadeUp">
        <div className="flex flex-wrap gap-2">
          {presetTabs.map((p) => (
            <Chip
              key={p.value}
              active={preset === p.value}
              onClick={() => applyPreset(p.value)}
            >
              {p.label}
            </Chip>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-muted" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="nf-input py-2 px-3 w-auto text-[13px]"
            />
            <span className="text-muted">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="nf-input py-2 px-3 w-auto text-[13px]"
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-muted" />
          <MultiSelectPopover
            label={t("nav.operators")}
            options={popoverOptions}
            selectedIds={selectedOpIds}
            onChange={setSelectedOpIds}
          />
        </div>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: gridCols }}
        >
          <div>{t("reports.activity.col.operator")}</div>
          <div className="text-center">
            {t("reports.activity.col.unique_leads")}
          </div>
          <div className="text-center">
            {t("reports.activity.col.calls_total")}
          </div>
          {dynamicStatusCodes.map((code) => (
            <div
              key={code}
              className="text-center text-[12.5px]"
              title={statusByCode.get(code)?.code}
            >
              <span
                className="inline-flex items-center gap-1.5"
                style={{ color: statusColor(code) }}
              >
                <span
                  className="inline-block"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: statusColor(code),
                  }}
                />
                <span className="text-[color:var(--text)]">
                  {statusLabel(code)}
                </span>
              </span>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("attendance.report.loading")}
          </div>
        ) : error ? (
          <div className="text-center py-12 text-[13px]" style={{ color: "#ef4444" }}>
            {(error as Error).message || t("attendance.report.no_data_range")}
          </div>
        ) : !data?.rows || data.rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("reports.activity.empty")}
          </div>
        ) : (
          <div>
            {data.rows.map((row, i) => (
              <div
                key={row.operator_id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: gridCols,
                  animationDelay: `${0.02 + i * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="font-semibold truncate">{row.operator_name}</div>
                <div className="text-center font-semibold tabular-nums">
                  {row.unique_leads_touched}
                </div>
                <div className="text-center tabular-nums text-muted">
                  {row.calls_total}
                </div>
                {dynamicStatusCodes.map((code) => {
                  const n = row.by_status[code] || 0;
                  return (
                    <div
                      key={code}
                      className="text-center tabular-nums"
                      style={{
                        color: n > 0 ? statusColor(code) : "var(--muted)",
                        fontWeight: n > 0 ? 600 : 400,
                      }}
                    >
                      {n > 0 ? n : "—"}
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Totals row */}
            <div
              className="grid gap-2 px-6 py-3"
              style={{
                gridTemplateColumns: gridCols,
                borderTop: "1px solid var(--border)",
                background: "var(--faint)",
                fontSize: 13,
              }}
            >
              <div className="font-semibold">
                {t("reports.activity.total")}
              </div>
              <div className="text-center font-semibold tabular-nums">
                {totals.unique}
              </div>
              <div className="text-center font-semibold tabular-nums">
                {totals.calls}
              </div>
              {dynamicStatusCodes.map((code) => {
                const n = totals.byStatus[code] || 0;
                return (
                  <div
                    key={code}
                    className="text-center tabular-nums font-semibold"
                    style={{ color: n > 0 ? statusColor(code) : "var(--muted)" }}
                  >
                    {n > 0 ? n : "—"}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
