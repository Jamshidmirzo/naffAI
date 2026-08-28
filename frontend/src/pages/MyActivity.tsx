import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, PhoneCall, Users2 } from "lucide-react";
import { api } from "../lib/api";
import { Chip, type TabItem } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT, useLangValue } from "../lib/i18n";

/**
 * Operator's own activity report — one row (theirs), no operator picker,
 * same preset chips as the manager view.
 *
 * Backend: GET /api/reports/my-activity/?date_from=&date_to=
 */

type Preset = "today" | "yesterday" | "week" | "month" | "this_month" | "custom";

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
  return null;
}

export default function MyActivity() {
  const t = useT();
  const lang = useLangValue();
  usePageHeader({
    title: t("reports.activity.my_title"),
    subtitle: t("reports.activity.my_subtitle"),
  });

  const [preset, setPreset] = useState<Preset>("today");
  const initial = presetRange("today")!;
  const [dateFrom, setDateFrom] = useState(initial.from);
  const [dateTo, setDateTo] = useState(initial.to);

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

  const { data, isLoading } = useQuery<ActivityReportResponse>({
    queryKey: ["my-activity", dateFrom, dateTo],
    queryFn: () =>
      api
        .get<ActivityReportResponse>(
          `/reports/my-activity/?date_from=${dateFrom}&date_to=${dateTo}`,
        )
        .then((r) => r.data),
  });

  const row: ActivityRow | null = data?.rows?.[0] ?? null;

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

  const sortedStatuses = useMemo(() => {
    if (!row) return [] as [string, number][];
    return Object.entries(row.by_status).sort(
      ([, a], [, b]) => (b as number) - (a as number),
    ) as [string, number][];
  }, [row]);

  return (
    <div className="mx-auto max-w-[820px] flex flex-col gap-5">
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
      </section>

      {isLoading ? (
        <section className="nf-card p-8 text-center text-muted text-[13px]">
          {t("attendance.report.loading")}
        </section>
      ) : !row ? (
        <section className="nf-card p-8 text-center text-muted text-[13px]">
          {t("reports.activity.empty")}
        </section>
      ) : (
        <>
          {/* KPI cards */}
          <section className="grid gap-3 md:grid-cols-2 animate-nfFadeUp">
            <div className="nf-card p-5 flex items-center gap-4">
              <div
                className="grid place-items-center shrink-0"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: "var(--accent-grad)",
                  color: "#fff",
                }}
              >
                <Users2 className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] text-muted">
                  {t("reports.activity.col.unique_leads")}
                </div>
                <div className="text-[26px] font-semibold tabular-nums">
                  {row.unique_leads_touched}
                </div>
              </div>
            </div>
            <div className="nf-card p-5 flex items-center gap-4">
              <div
                className="grid place-items-center shrink-0"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: "var(--accent-grad)",
                  color: "#fff",
                }}
              >
                <PhoneCall className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] text-muted">
                  {t("reports.activity.col.calls_total")}
                </div>
                <div className="text-[26px] font-semibold tabular-nums">
                  {row.calls_total}
                </div>
              </div>
            </div>
          </section>

          {/* Status breakdown */}
          <section className="nf-card overflow-hidden animate-nfFadeUp">
            <div className="px-6 pt-5 pb-3 text-[14px] font-semibold tracking-tight">
              {t("reports.activity.by_status_title")}
            </div>
            {sortedStatuses.length === 0 ? (
              <div className="text-center text-muted py-8 text-[13px]">
                {t("reports.activity.no_statuses")}
              </div>
            ) : (
              <div className="pb-2">
                {sortedStatuses.map(([code, n]) => (
                  <div
                    key={code}
                    className="grid gap-2 px-6 py-2.5 items-center"
                    style={{
                      gridTemplateColumns: "1fr 60px",
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <span
                      className="inline-flex items-center gap-2 text-[13.5px]"
                      style={{ color: statusColor(code) }}
                    >
                      <span
                        className="inline-block"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: statusColor(code),
                        }}
                      />
                      <span className="text-[color:var(--text)]">
                        {statusLabel(code)}
                      </span>
                    </span>
                    <span className="text-right font-semibold tabular-nums">
                      {n}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
