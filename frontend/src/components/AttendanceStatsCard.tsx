import React from "react";

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
        return "Вовремя";
      case "late":
        return "Опоздание";
      case "absent":
        return "Отсутствие";
      case "weekend":
        return "Выходной";
      case "auto_closed":
        return "Авто-закрытие (23:00)";
      case "manually_closed":
        return "Закрыто вручную TL";
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
          <div className="text-xs text-gray-500">Присутствие</div>
          <div className="text-lg font-bold mt-1 text-gray-900 dark:text-white">
            {stats.days_present} / {stats.days_expected} дн.
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
          <div className="text-xs text-gray-500">Пропуски</div>
          <div className="text-lg font-bold mt-1 text-rose-600">
            {stats.days_absent} дн.
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
          <div className="text-xs text-gray-500">Опоздания (среднее)</div>
          <div className="text-lg font-bold mt-1 text-amber-500">
            {stats.late_count} ({stats.avg_late_minutes} мин)
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
          <div className="text-xs text-gray-500">Средняя смена</div>
          <div className="text-lg font-bold mt-1 text-blue-500">
            {stats.avg_shift_minutes} мин
          </div>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-slate-900 rounded-lg col-span-2 md:col-span-1">
          <div className="text-xs text-gray-500">Итого часов</div>
          <div className="text-lg font-bold mt-1 text-emerald-600">
            {stats.total_worked_hours} ч.
          </div>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-slate-200">
          Календарь присутствия (Heatmap)
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
            Вовремя
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-amber-400 inline-block" />
            Опоздание
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-rose-500 inline-block" />
            Пропуск
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-slate-200 dark:bg-slate-800 inline-block" />
            Выходной
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="w-3.5 h-3.5 rounded inline-block"
              style={{
                background: "repeating-linear-gradient(45deg, #d97706, #d97706 2px, #f59e0b 2px, #f59e0b 4px)",
              }}
            />
            Авто-закрыто (23:00)
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded bg-blue-600 inline-block" />
            Закрыто ТL/Менеджером
          </div>
        </div>
      </div>
    </div>
  );
}
