import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import AttendanceStatsCard from "../components/AttendanceStatsCard";
import { Calendar, Users, FileText, ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";

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
  heatmap: any[];
}

interface AttendanceReportResponse {
  period: { from: string; to: string };
  rows: PeriodStats[];
}

export default function AttendanceReport() {
  const getFirstDayOfMonth = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split("T")[0];
  };

  const getTodayDate = () => {
    return new Date().toISOString().split("T")[0];
  };

  const [dateFrom, setDateFrom] = useState(getFirstDayOfMonth());
  const [dateTo, setDateTo] = useState(getTodayDate());
  const [selectedOpIds, setSelectedOpIds] = useState<number[]>([]);
  const [expandedOpId, setExpandedOpId] = useState<number | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<keyof PeriodStats>("operator_name");
  const [sortAsc, setSortAsc] = useState(true);

  // Fetch operators list for filtering
  const { data: operators = [] } = useQuery<Operator[]>({
    queryKey: ["operators-list"],
    queryFn: () => api.get<Operator[]>("/operators/").then((r) => r.data),
  });

  const popoverOptions = useMemo(() => {
    return operators.map((o) => ({ id: o.id, name: o.full_name }));
  }, [operators]);

  // Fetch Range report
  const { data, isLoading } = useQuery<AttendanceReportResponse>({
    queryKey: ["attendance-statistics", dateFrom, dateTo, selectedOpIds],
    queryFn: () => {
      const ops = selectedOpIds.length > 0 ? `&operator=${selectedOpIds.join(",")}` : "";
      return api
        .get<AttendanceReportResponse>(
          `/attendance/report/?date_from=${dateFrom}&date_to=${dateTo}${ops}`
        )
        .then((r) => r.data);
    },
  });

  const handleExportExcel = () => {
    const ops = selectedOpIds.length > 0 ? `&operator=${selectedOpIds.join(",")}` : "";
    const url = `${api.defaults.baseURL}/attendance/report/?date_from=${dateFrom}&date_to=${dateTo}${ops}&format=xlsx`;
    // Trigger download
    window.open(url, "_blank");
  };

  const handleSort = (field: keyof PeriodStats) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
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
      return sortAsc ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });
  }, [data, sortField, sortAsc]);

  const toggleExpand = (id: number) => {
    if (expandedOpId === id) setExpandedOpId(null);
    else setExpandedOpId(id);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Сводная аналитика присутствия</h1>
          <p className="text-sm text-gray-500">Суммарный отчет за период и детальные тепловые карты</p>
        </div>

        <button onClick={handleExportExcel} className="btn-secondary py-2 flex items-center gap-1.5 self-start sm:self-auto">
          <FileText className="w-4 h-4" />
          Экспорт в Excel
        </button>
      </div>

      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-slate-900 p-4 rounded-xl border border-gray-150 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-400" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm dark:bg-slate-950 dark:border-slate-800"
          />
          <span className="text-gray-400">—</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm dark:bg-slate-950 dark:border-slate-800"
          />
        </div>

        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-400" />
          <MultiSelectPopover
            label="Операторы"
            options={popoverOptions}
            selectedIds={selectedOpIds}
            onChange={setSelectedOpIds}
          />
        </div>
      </div>

      {/* Statistics Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-500 font-semibold border-b border-gray-150 dark:border-slate-800">
            <tr>
              <th className="px-5 py-3.5 text-left cursor-pointer select-none" onClick={() => handleSort("operator_name")}>
                <div className="flex items-center gap-1">
                  Оператор <ArrowUpDown className="w-3.5 h-3.5" />
                </div>
              </th>
              <th className="px-5 py-3.5 text-center cursor-pointer select-none" onClick={() => handleSort("days_present")}>
                <div className="flex items-center justify-center gap-1">
                  Явился / Ожидалось <ArrowUpDown className="w-3.5 h-3.5" />
                </div>
              </th>
              <th className="px-5 py-3.5 text-center cursor-pointer select-none" onClick={() => handleSort("late_count")}>
                <div className="flex items-center justify-center gap-1">
                  Опоздал <ArrowUpDown className="w-3.5 h-3.5" />
                </div>
              </th>
              <th className="px-5 py-3.5 text-center cursor-pointer select-none" onClick={() => handleSort("auto_closed_count")}>
                <div className="flex items-center justify-center gap-1">
                  Авто-закрыто <ArrowUpDown className="w-3.5 h-3.5" />
                </div>
              </th>
              <th className="px-5 py-3.5 text-center cursor-pointer select-none" onClick={() => handleSort("manually_closed_count")}>
                <div className="flex items-center justify-center gap-1">
                  Ручное закрытие <ArrowUpDown className="w-3.5 h-3.5" />
                </div>
              </th>
              <th className="px-5 py-3.5 text-center cursor-pointer select-none" onClick={() => handleSort("avg_shift_minutes")}>
                <div className="flex items-center justify-center gap-1">
                  Ср. длина смены <ArrowUpDown className="w-3.5 h-3.5" />
                </div>
              </th>
              <th className="px-5 py-3.5 text-center cursor-pointer select-none" onClick={() => handleSort("total_worked_hours")}>
                <div className="flex items-center justify-center gap-1">
                  Итого часов <ArrowUpDown className="w-3.5 h-3.5" />
                </div>
              </th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-150 dark:divide-slate-800">
            {isLoading && (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-gray-500">
                  Загрузка отчета за период...
                </td>
              </tr>
            )}
            {!isLoading && sortedRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-gray-500">
                  Нет данных о посещаемости за выбранный диапазон.
                </td>
              </tr>
            )}
            {sortedRows.map((row) => (
              <>
                <tr
                  key={row.operator_id}
                  onClick={() => toggleExpand(row.operator_id)}
                  className="hover:bg-gray-50 dark:hover:bg-slate-800/40 transition cursor-pointer select-none font-medium"
                >
                  <td className="px-5 py-3.5 font-bold text-gray-900 dark:text-white">
                    {row.operator_name}
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    {row.days_present} / {row.days_expected}
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    {row.late_count > 0 ? (
                      <span className="text-amber-500 font-bold">
                        {row.late_count} ({row.avg_late_minutes} мин)
                      </span>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-center text-gray-600 dark:text-slate-400">
                    {row.auto_closed_count}
                  </td>
                  <td className="px-5 py-3.5 text-center text-gray-600 dark:text-slate-400">
                    {row.manually_closed_count}
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    {row.avg_shift_minutes} мин
                  </td>
                  <td className="px-5 py-3.5 text-center font-bold text-emerald-600 dark:text-emerald-400">
                    {row.total_worked_hours} ч.
                  </td>
                  <td className="px-3 py-3.5 text-center text-gray-400">
                    {expandedOpId === row.operator_id ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </td>
                </tr>
                {expandedOpId === row.operator_id && (
                  <tr>
                    <td colSpan={8} className="px-5 py-4 bg-gray-50/50 dark:bg-slate-900/10 border-y border-gray-150 dark:border-slate-800">
                      <AttendanceStatsCard stats={row} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
