import type React from "react";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import AttendanceStatsCard from "../components/AttendanceStatsCard";
import {
  Calendar,
  Users,
  FileText,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface Operator {
  id: number;
  full_name: string;
}

interface PeriodStats {
  operator_id: number;
  operator_name: string;
  days_expected: number;
  days_present: number;
  days_absent: number;
  late_count: number;
  avg_late_minutes: number;
  auto_closed_count: number;
  manually_closed_count: number;
  avg_shift_minutes: number;
  total_worked_hours: number;
  heatmap: Array<{
    date: string;
    status: "on_time" | "late" | "absent" | "weekend" | "auto_closed" | "manually_closed";
  }>;
}

interface AttendanceReportResponse {
  period: { from: string; to: string };
  rows: PeriodStats[];
}

export default function AttendanceReport() {
  usePageHeader({
    title: (useT())("attendance.report.title"),
    subtitle: (useT())("attendance.report.title"),
  });

  const firstDayOfMonth = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split("T")[0];
  };
  const todayDate = () => new Date().toISOString().split("T")[0];

  const [dateFrom, setDateFrom] = useState(firstDayOfMonth());
  const [dateTo, setDateTo] = useState(todayDate());
  const [selectedOpIds, setSelectedOpIds] = useState<number[]>([]);
  const [expandedOpId, setExpandedOpId] = useState<number | null>(null);

  const [sortField, setSortField] = useState<keyof PeriodStats>("operator_name");
  const [sortAsc, setSortAsc] = useState(true);

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

  const { data, isLoading } = useQuery<AttendanceReportResponse>({
    queryKey: ["attendance-statistics", dateFrom, dateTo, selectedOpIds],
    queryFn: () => {
      const ops = selectedOpIds.length > 0 ? `&operator=${selectedOpIds.join(",")}` : "";
      return api
        .get<AttendanceReportResponse>(
          `/attendance/report/?date_from=${dateFrom}&date_to=${dateTo}${ops}`,
        )
        .then((r) => r.data);
    },
  });

  const handleExportExcel = () => {
    const ops = selectedOpIds.length > 0 ? `&operator=${selectedOpIds.join(",")}` : "";
    const url = `${api.defaults.baseURL}/attendance/report/?date_from=${dateFrom}&date_to=${dateTo}${ops}&format=xlsx`;
    window.open(url, "_blank");
  };

  const handleSort = (field: keyof PeriodStats) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const sortedRows = useMemo(() => {
    if (!data?.rows) return [];
    return [...data.rows].sort((a, b) => {
      const valA = a[sortField];
      const valB = b[sortField];
      if (typeof valA === "string" && typeof valB === "string") {
        return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortAsc
        ? (valA as number) - (valB as number)
        : (valB as number) - (valA as number);
    });
  }, [data, sortField, sortAsc]);

  const toggleExpand = (id: number) =>
    setExpandedOpId((cur) => (cur === id ? null : id));

  const cols: Array<{ key: keyof PeriodStats | ""; label: string; align?: "center" | "right" | "left" }> = [
    { key: "operator_name", label: "Оператор", align: "left" },
    { key: "days_present", label: "Явился / Ожид.", align: "center" },
    { key: "late_count", label: "Опоздал", align: "center" },
    { key: "auto_closed_count", label: "Авто-закрыто", align: "center" },
    { key: "manually_closed_count", label: "Ручное закр.", align: "center" },
    { key: "avg_shift_minutes", label: "Ср. смена", align: "center" },
    { key: "total_worked_hours", label: "Итого часов", align: "center" },
    { key: "", label: "" },
  ];

  const gridTpl = "1.4fr .9fr .8fr .9fr .9fr .8fr .8fr 40px";

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <div className="flex items-center justify-end animate-nfFadeUp">
        <Button variant="secondary" onClick={handleExportExcel}>
          <FileText className="w-3.5 h-3.5" /> Экспорт в Excel
        </Button>
      </div>

      <section className="nf-card p-4 flex flex-wrap items-center gap-4 animate-nfFadeUp">
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
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-muted" />
          <MultiSelectPopover
            label="Операторы"
            options={popoverOptions}
            selectedIds={selectedOpIds}
            onChange={setSelectedOpIds}
          />
        </div>
      </section>

      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: gridTpl }}
        >
          {cols.map((c, i) => (
            <div
              key={i}
              className={
                c.align === "center"
                  ? "text-center cursor-pointer select-none"
                  : c.align === "right"
                    ? "text-right cursor-pointer select-none"
                    : "cursor-pointer select-none"
              }
              onClick={() => c.key && handleSort(c.key)}
            >
              {c.label && (
                <span className="inline-flex items-center gap-1">
                  {c.label} {c.key && <ArrowUpDown className="w-3 h-3 opacity-60" />}
                </span>
              )}
            </div>
          ))}
        </div>
        {isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">
            Загрузка отчёта…
          </div>
        ) : sortedRows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            Нет данных за выбранный диапазон
          </div>
        ) : (
          <div>
            {sortedRows.map((row, i) => (
              <div key={row.operator_id}>
                <div
                  onClick={() => toggleExpand(row.operator_id)}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: gridTpl,
                    animationDelay: `${0.02 + i * 0.035}s`,
                  }}
                >
                  <div className="font-semibold truncate">{row.operator_name}</div>
                  <div className="text-center tabular-nums">
                    {row.days_present} / {row.days_expected}
                  </div>
                  <div className="text-center">
                    {row.late_count > 0 ? (
                      <span
                        className="font-semibold tabular-nums"
                        style={{ color: "var(--accent)" }}
                      >
                        {row.late_count} ({row.avg_late_minutes} мин)
                      </span>
                    ) : (
                      <span className="text-muted">0</span>
                    )}
                  </div>
                  <div className="text-center text-muted tabular-nums">
                    {row.auto_closed_count}
                  </div>
                  <div className="text-center text-muted tabular-nums">
                    {row.manually_closed_count}
                  </div>
                  <div className="text-center tabular-nums">
                    {row.avg_shift_minutes} мин
                  </div>
                  <div
                    className="text-center font-semibold tabular-nums"
                    style={{
                      color: row.total_worked_hours > 0 ? "var(--accent)" : "var(--muted)",
                    }}
                  >
                    {row.total_worked_hours} ч
                  </div>
                  <div className="text-center text-muted">
                    {expandedOpId === row.operator_id ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </div>
                </div>
                {expandedOpId === row.operator_id && (
                  <div
                    className="px-6 py-4"
                    style={{
                      background: "var(--faint)",
                      borderTop: "1px solid var(--border)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <AttendanceStatsCard stats={row as unknown as React.ComponentProps<typeof AttendanceStatsCard>["stats"]} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
