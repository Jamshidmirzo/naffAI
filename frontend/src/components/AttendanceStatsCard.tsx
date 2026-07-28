import React from "react";
import { useT } from "../lib/i18n";

interface HeatmapDay {
  date: string;
  status: "on_time" | "late" | "absent" | "weekend" | "auto_closed" | "manually_closed";
}

interface OperatorStats {
  days_expected: number;
  days_present: number;
  days_absent: number;
  late_count: number;
  avg_late_minutes: number;
  auto_closed_count: number;
  manually_closed_count: number;
  avg_shift_minutes: number;
  total_worked_hours: number;
  heatmap: HeatmapDay[];
}

interface Props {
  stats: OperatorStats;
}

export default function AttendanceStatsCard({ stats }: Props) {
  const t = useT();

  const getStatusColor = (status: HeatmapDay["status"]) => {
    switch (status) {
      case "on_time":
        return "bg-emerald-500 text-white";
      case "late":
        return "bg-amber-400 text-slate-900";
      case "absent":
        return "bg-rose-500 text-white";
      case "weekend":
        return "bg-slate-200 dark:bg-slate-800 text-gray-400";
      case "auto_closed":
        // Striped pattern via inline style (amber / yellow striping)
        return "bg-amber-600 text-white";
      case "manually_closed":
        return "bg-blue-600 text-white";
      default:
        return "bg-slate-100 dark:bg-slate-900";
    }
  };

  const getStatusLabel = (status: HeatmapDay["status"]) => {
    switch (status) {
      case "on_time":
        return t("attendance.stats.status_on_time");
      case "late":
        return t("attendance.stats.status_late");
      case "absent":
        return t("attendance.stats.status_absent");
      case "weekend":
        return t("attendance.stats.status_weekend");
      case "auto_closed":
        return t("attendance.stats.status_auto_closed");
      case "manually_closed":
        return t("attendance.stats.status_manually_closed");
      default:
        return "";
    }
  };

  const getHeatmapStyle = (status: HeatmapDay["status"]): React.CSSProperties => {
    if (status === "auto_closed") {
      return {
        background: "repeating-linear-gradient(45deg, #d97706, #d97706 4px, #f59e0b 4px, #f59e0b 8px)",
      };
    }
    return {};
  };

  return (
    <div className="card p-5 space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
          <div className="text-xs text-gray-500">{t("attendance.stats.presence")}</div>
          <div className="text-lg font-bold mt-1 text-gray-900 dark:text-white">
            {stats.days_present} / {stats.days_expected} {t("tg.attendance_days")}
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
          <div className="text-xs text-gray-500">{t("attendance.stats.absences")}</div>
          <div className="text-lg font-bold mt-1 text-rose-600">
            {stats.days_absent} {t("tg.attendance_days")}
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
          <div className="text-xs text-gray-500">{t("attendance.stats.late_avg")}</div>
          <div className="text-lg font-bold mt-1 text-amber-500">
            {stats.late_count} ({t("attendance.stats.min_short", { n: stats.avg_late_minutes })})
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
          <div className="text-xs text-gray-500">{t("attendance.stats.avg_shift")}</div>
          <div className="text-lg font-bold mt-1 text-blue-500">
            {t("attendance.stats.min_short", { n: stats.avg_shift_minutes })}
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg col-span-2 md:col-span-1">
          <div className="text-xs text-gray-500">{t("attendance.stats.total_hours")}</div>
          <div className="text-lg font-bold mt-1 text-emerald-600">
            {t("attendance.stats.hours_short", { n: stats.total_worked_hours })}
          </div>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-slate-200">
          {t("attendance.stats.heatmap_title")}
        </h4>
        <div className="flex flex-wrap gap-1.5 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-150 dark:border-slate-800">
          {stats.heatmap.map((day) => (
            <div
              key={day.date}
              className={`w-7 h-7 rounded flex items-center justify-center text-[9px] font-bold select-none transition-all shadow-sm ${getStatusColor(
                day.status
              )}`}
              style={getHeatmapStyle(day.status)}
              title={`${day.date}: ${getStatusLabel(day.status)}`}
            >
              {day.date.split("-")[2]}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-4 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-emerald-500 inline-block" />
            {t("attendance.stats.status_on_time")}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-amber-400 inline-block" />
            {t("attendance.stats.status_late")}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-rose-500 inline-block" />
            {t("attendance.stats.legend_absent_short")}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-slate-200 dark:bg-slate-800 inline-block" />
            {t("attendance.stats.status_weekend")}
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="w-3.5 h-3.5 rounded inline-block"
              style={{
                background: "repeating-linear-gradient(45deg, #d97706, #d97706 2px, #f59e0b 2px, #f59e0b 4px)",
              }}
            />
            {t("attendance.stats.status_auto_closed")}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-blue-600 inline-block" />
            {t("attendance.stats.legend_closed_by_tl")}
          </div>
        </div>
      </div>
    </div>
  );
}
