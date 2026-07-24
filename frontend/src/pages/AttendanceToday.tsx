import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import KpiCard from "../components/KpiCard";
import { Calendar, User, Clock, AlertTriangle, Moon } from "lucide-react";
import { RoleGate } from "../components/RoleGate";
import { Modal } from "../components/Modal";
import { toast } from "sonner";

interface AttendanceEvent {
  id: number;
  operator_id: number;
  operator_name: string;
  checked_in_at: string;
  checked_out_at: string | null;
  was_late: boolean;
  duration_min: number | null;
  auto_closed: boolean;
  manually_closed?: boolean;
  manually_closed_by_name?: string;
  source: "qr" | "tg" | "manual";
}

interface AbsentOperator {
  id: number;
  full_name: string;
}

interface AttendanceReport {
  total_active_operators: number;
  present: AttendanceEvent[];
  late: AttendanceEvent[];
  absent: AbsentOperator[];
  counts: {
    present: number;
    late: number;
    absent: number;
  };
}

export default function AttendanceToday() {
  const [tab, setTab] = useState<"today">("today");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  // Manual close state
  const [closingLog, setClosingLog] = useState<{ id: number; name: string } | null>(null);
  const [closeNote, setCloseNote] = useState("");

  const { data: report, isLoading: isLoadingReport, refetch } = useQuery<AttendanceReport>({
    queryKey: ["attendance-report", date],
    queryFn: () => api.get<AttendanceReport>(`/attendance/report/?date=${date}`).then((r) => r.data),
  });

  const formatTime = (isoString: string | null) => {
    if (!isoString) return "-";
    return new Date(isoString).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Tashkent",
    });
  };

  const handleCloseSubmit = async () => {
    if (!closingLog) return;
    try {
      await api.post(`/attendance/logs/${closingLog.id}/close/`, { note: closeNote });
      toast.success("Смена успешно закрыта");
      setClosingLog(null);
      setCloseNote("");
      refetch();
    } catch (err) {
      toast.error("Не удалось закрыть смену");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Посещаемость</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Контроль присутствия операторов на рабочих местах
          </p>
        </div>

        <div className="flex bg-gray-100 dark:bg-slate-900 rounded-lg p-1">
          <button
            onClick={() => setTab("today")}
            className={`px-4 py-2 text-sm font-semibold rounded-md transition ${
              tab === "today"
                ? "bg-white dark:bg-slate-800 text-gray-900 dark:text-white shadow-sm"
                : "text-gray-500 hover:text-gray-900 dark:hover:text-white"
            }`}
          >
            Отчёт по дням
          </button>
        </div>
      </div>

      {tab === "today" && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-gray-600 dark:text-slate-400 flex items-center gap-1.5">
              <Calendar className="w-4 h-4" /> Выберите дату:
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg px-3 py-1.5 text-sm"
            />
          </div>

          {report && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <KpiCard
                label="На месте"
                value={`${report.counts.present} / ${report.total_active_operators}`}
                sub="Операторов сегодня"
              />
              <KpiCard
                label="Опоздали"
                value={`${report.counts.late}`}
                sub="Более чем на 15 мин"
              />
              <KpiCard
                label="Отсутствуют"
                value={`${report.counts.absent}`}
                sub="Не отметились"
              />
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
              Присутствующие операторы
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3 text-left">Имя оператора</th>
                  <th className="px-5 py-3 text-left">Пришёл</th>
                  <th className="px-5 py-3 text-left">Ушёл</th>
                  <th className="px-5 py-3 text-left">Длительность</th>
                  <th className="px-5 py-3 text-center">Опоздание</th>
                  <th className="px-5 py-3 text-center">Канал</th>
                  <RoleGate allow={["team_lead", "manager"]}>
                    <th className="px-5 py-3 text-center">Действия</th>
                  </RoleGate>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-150 dark:divide-slate-800">
                {isLoadingReport && (
                  <tr>
                    <td colSpan={7} className="px-5 py-8 text-center text-gray-500">
                      Загрузка отчёта...
                    </td>
                  </tr>
                )}
                {!isLoadingReport && report?.present.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-8 text-center text-gray-500">
                      Ни один оператор сегодня ещё не пришёл.
                    </td>
                  </tr>
                )}
                {report?.present.map((e) => (
                  <tr key={e.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                    <td className="px-5 py-3.5 font-semibold text-gray-900 dark:text-slate-200">
                      {e.operator_name}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {formatTime(e.checked_in_at)}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {e.checked_out_at ? (
                        formatTime(e.checked_out_at)
                      ) : e.auto_closed ? (
                        <span className="text-gray-400 flex items-center gap-1">
                          <Moon className="w-3.5 h-3.5" /> 23:00 (авто)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 rounded-full">
                          на смене
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      {e.duration_min !== null ? `${e.duration_min} мин` : "-"}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {e.was_late ? (
                        <span className="text-red-600 dark:text-red-400 font-semibold inline-flex items-center gap-0.5">
                          <AlertTriangle className="w-3.5 h-3.5" /> Да
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center text-xs font-mono uppercase text-gray-500">
                      {e.source}
                    </td>
                    <RoleGate allow={["team_lead", "manager"]}>
                      <td className="px-5 py-3.5 text-center">
                        {!e.checked_out_at && !e.auto_closed && (
                          <button
                            onClick={() => setClosingLog({ id: e.id, name: e.operator_name })}
                            className="px-2.5 py-1 text-xs font-semibold bg-red-50 text-red-600 hover:bg-red-100 rounded transition"
                          >
                            Закрыть смену
                          </button>
                        )}
                      </td>
                    </RoleGate>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!isLoadingReport && report?.absent.length && report.absent.length > 0 ? (
            <div className="card overflow-hidden border-red-100 dark:border-red-950/20">
              <div className="px-5 py-4 border-b border-red-100 bg-red-50/20 dark:border-red-950/20 text-sm font-semibold text-red-800 dark:text-red-400">
                Отсутствующие
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-150 dark:divide-slate-800">
                  {report.absent.map((op) => (
                    <tr key={op.id} className="hover:bg-red-50/10 transition">
                      <td className="px-5 py-3 font-medium flex items-center gap-2 text-gray-700 dark:text-slate-300">
                        <User className="w-4 h-4 text-gray-400" />
                        {op.full_name}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}

      {/* Manual close confirmation modal */}
      {closingLog && (
        <Modal
          open={!!closingLog}
          title={`Закрыть смену оператора ${closingLog.name}?`}
          onClose={() => setClosingLog(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Вы принудительно завершаете текущую открытую смену. Будет зафиксировано время ухода.
            </p>
            <div>
              <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">
                Комментарий (необязательно)
              </label>
              <textarea
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                className="w-full border border-gray-250 dark:border-slate-800 rounded-lg p-2.5 text-sm bg-white dark:bg-slate-950"
                placeholder="Комментарий к закрытию смены (макс. 280 символов)"
                maxLength={280}
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setClosingLog(null)} className="btn-secondary py-2 px-4">
                Отмена
              </button>
              <button onClick={handleCloseSubmit} className="btn-primary bg-red-600 hover:bg-red-500 py-2 px-4">
                Закрыть
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
