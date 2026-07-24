import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, BookOpen, Eye, EyeOff, ChevronRight, Target, History, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { Modal } from "../components/Modal";
import { useAuth } from "../store/auth";
import AttendanceStatsCard from "../components/AttendanceStatsCard";
import { toast } from "sonner";
import { formatNumber, formatUZS } from "../lib/format";
import {
  buildPeriodParams,
  periodTitle,
  type MonthChoice,
  type Period,
} from "../lib/period";
import KpiCard from "../components/KpiCard";
import MonthPicker from "../components/MonthPicker";
import NumericInput from "../components/NumericInput";
import ProgressBar from "../components/ProgressBar";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import TgDialogsPanel from "../components/TgDialogsPanel";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "day", label: "День" },
  { value: "week", label: "Неделя" },
  { value: "month", label: "Месяц" },
];

const STATUS_LABEL: Record<string, string> = {
  active: "Активен",
  trainee: "Стажёр",
  inactive: "Неактивен",
};

const STATUS_BADGE: Record<string, string> = {
  active:
    "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  trainee: "bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300",
  inactive: "bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400",
};

export default function OperatorDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const role = useAuth((s) => s.role);
  const isTeamLead = role === "team_lead";
  const [period, setPeriod] = useState<Period>("month");
  const [choice, setChoice] = useState<MonthChoice>({ kind: "all" });
  const [editPlan, setEditPlan] = useState(false);
  const [planInput, setPlanInput] = useState("");
  const [selectedLessonDate, setSelectedLessonDate] = useState<string | null>(null);

  const lessonsQ = useQuery({
    queryKey: ["operator-lessons", id],
    queryFn: () =>
      api.get<any[]>(`/lessons/history/?operator=${id}&limit=7`).then((r) => r.data),
    enabled: role === "team_lead" || role === "manager",
  });

  const lessonDetailQ = useQuery({
    queryKey: ["operator-lesson-detail", id, selectedLessonDate],
    queryFn: () =>
      api
        .get<any>(`/lessons/?operator=${id}&date=${selectedLessonDate}`)
        .then((r) => r.data),
    enabled: !!selectedLessonDate,
  });

  // Hide the day/week/month tabs whenever the choice is not "current" — the
  // tabs only steer the ?period= param, and any of the other three variants
  // (all / specific month / arbitrary range) already sends a full window.
  const isSpecific = choice.kind !== "current";
  const params = buildPeriodParams(period, choice);
  const paramKey = JSON.stringify(params);
  const title = periodTitle(period, choice);
  const titleLower = title.toLowerCase();

  // Derive which year/month the plan should reflect based on the selected period
  const today = new Date();
  const planYear = choice.kind === "specific" ? choice.year : today.getFullYear();
  const planMonth = choice.kind === "specific" ? choice.month : today.getMonth() + 1;

  const stats = useQuery({
    queryKey: ["operator-stats", id, paramKey],
    queryFn: () =>
      api
        .get(`/operators/${id}/stats/`, { params })
        .then((r) => r.data),
    enabled: !!id,
  });

  const planQuery = useQuery({
    queryKey: ["operator-plan", id, planYear, planMonth],
    queryFn: () =>
      api.get(`/operators/${id}/plan/`, { params: { year: planYear, month: planMonth } }).then((r) => r.data),
    enabled: !!id,
  });
  const dateFrom30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const dateToToday = new Date().toISOString().split("T")[0];

  const attendanceReportQ = useQuery({
    queryKey: ["operator-attendance-report", id],
    queryFn: () =>
      api
        .get(`/attendance/report/?date_from=${dateFrom30}&date_to=${dateToToday}&operator=${id}`)
        .then((r) => r.data),
    enabled: !!id && (role === "team_lead" || role === "manager"),
  });

  const attendanceLogsQ = useQuery({
    queryKey: ["operator-attendance-logs", id],
    queryFn: () =>
      api
        .get(`/attendance/operators/${id}/logs/`)
        .then((r) => r.data),
    enabled: !!id && (role === "team_lead" || role === "manager"),
  });

  const [closingLog, setClosingLog] = useState<{ id: number; name: string } | null>(null);
  const [closeNote, setCloseNote] = useState("");

  const handleCloseSubmit = async () => {
    if (!closingLog) return;
    try {
      await api.post(`/attendance/logs/${closingLog.id}/close/`, { note: closeNote });
      toast.success("Смена успешно закрыта");
      setClosingLog(null);
      setCloseNote("");
      attendanceLogsQ.refetch();
      attendanceReportQ.refetch();
    } catch (err) {
      toast.error("Не удалось закрыть смену");
    }
  };
  const setPlanMut = useMutation({
    mutationFn: (target_amount: string) =>
      api.put(`/operators/${id}/plan/`, { target_amount, year: planYear, month: planMonth }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operator-plan", id, planYear, planMonth] });
      setEditPlan(false);
    },
  });

  if (!id) return null;

  const s = stats.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/operators"
            className="text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-slate-100"
            aria-label="Назад к списку операторов"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {s?.operator?.full_name || "Оператор"}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              {s?.operator?.status && (
                <span
                  className={`badge ${STATUS_BADGE[s.operator.status] || ""}`}
                >
                  {STATUS_LABEL[s.operator.status] || s.operator.status}
                </span>
              )}
              {s?.operator?.phone && (
                <span className="text-sm text-gray-600 dark:text-slate-400">
                  {s.operator.phone}
                </span>
              )}
              {s?.operator?.hired_at && (
                <span className="text-sm text-gray-500 dark:text-slate-500">
                  · с {new Date(s.operator.hired_at).toLocaleDateString("ru-RU")}
                </span>
              )}
            </div>
            {(planQuery.data?.achievements?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {planQuery.data.achievements.map((b: any) => (
                  <span
                    key={b.slug}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30"
                  >
                    {b.emoji} {b.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!isSpecific && (
            <div
              role="tablist"
              aria-label="Период"
              className="inline-flex rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1"
            >
              {PERIOD_OPTIONS.map((opt) => {
                const active = period === opt.value;
                return (
                  <button
                    key={opt.value}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setPeriod(opt.value)}
                    className={
                      "px-3 py-1.5 text-sm rounded-md transition-colors " +
                      (active
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800")
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
          <MonthPicker value={choice} onChange={setChoice} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard
          label={`Сумма · ${titleLower}`}
          value={formatUZS(s?.totals?.total || 0)}
          sub={`${formatNumber(s?.totals?.count || 0)} продаж`}
        />
        <KpiCard
          label="Средний чек"
          value={
            s && s.totals?.count > 0
              ? formatUZS(Number(s.totals.total) / s.totals.count)
              : formatUZS(0)
          }
          sub="Кредитованная сумма ÷ кол-во"
        />
        <div className="card p-5 flex flex-col gap-4">
          {/* Зарплата */}
          {s?.payroll ? (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">
                Зарплата · этот месяц
              </div>
              <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-slate-100">
                {formatUZS(s.payroll.payout)}
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-xs text-gray-600 dark:text-slate-400 mb-1">
                  <span>
                    {formatUZS(s.payroll.total_sales)} / {formatUZS(s.payroll.threshold)}
                  </span>
                  <span>{s.payroll.progress_percent}%</span>
                </div>
                <ProgressBar value={s.payroll.progress_percent} />
              </div>
              {s.payroll.threshold_reached && (
                <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                  Порог достигнут — формула: {s.payroll.payout_type} · {s.payroll.payout_value}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">Зарплата · этот месяц</div>
              <div className="mt-2 text-2xl font-semibold text-gray-400 dark:text-slate-500">—</div>
              <div className="text-xs text-gray-400 dark:text-slate-500 mt-1">Правило не настроено</div>
            </div>
          )}

          {/* Разделитель */}
          <div className="border-t border-gray-100 dark:border-slate-800" />

          {/* План на месяц */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">
                План · {new Date(planYear, planMonth - 1).toLocaleString("ru-RU", { month: "long", year: "numeric" })}
              </div>
              {isTeamLead && !editPlan && (
                <button
                  className="btn-ghost text-xs py-0.5 px-2"
                  onClick={() => {
                    setEditPlan(true);
                    setPlanInput(
                      planQuery.data?.target
                        ? String(Math.round(Number(planQuery.data.target)))
                        : ""
                    );
                  }}
                >
                  {planQuery.data?.target ? "Изменить" : "Установить"}
                </button>
              )}
            </div>

            {editPlan ? (
              <div className="flex items-center gap-2">
                <NumericInput
                  className="input flex-1 text-sm py-1"
                  value={planInput}
                  onChange={setPlanInput}
                  placeholder="Цель в сумах"
                  autoFocus
                />
                <button
                  className="btn-primary text-xs py-1 px-3"
                  disabled={!planInput || setPlanMut.isPending}
                  onClick={() => setPlanMut.mutate(planInput)}
                >
                  {setPlanMut.isPending ? "…" : "OK"}
                </button>
                <button className="btn-ghost text-xs py-1" onClick={() => setEditPlan(false)}>
                  ✕
                </button>
              </div>
            ) : planQuery.data?.target ? (
              <div>
                <div className="flex justify-between text-xs text-gray-600 dark:text-slate-400 mb-1">
                  <span>{formatUZS(Number(planQuery.data.actual))}</span>
                  <span className="font-semibold">{planQuery.data.percent}%</span>
                </div>
                <ProgressBar value={planQuery.data.percent} />
                <div className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                  из {formatUZS(Number(planQuery.data.target))}
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-400 dark:text-slate-500">
                {planQuery.isLoading ? "Загрузка…" : "Не установлен"}
                {isTeamLead && !planQuery.isLoading && (
                  <span className="ml-1 text-blue-500 cursor-pointer hover:underline"
                    onClick={() => { setEditPlan(true); setPlanInput(""); }}>
                    — задать
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="text-sm font-medium mb-4">
          Продажи по дням · {titleLower}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={(s?.by_day || []).map((r: any) => ({
              day: r.day,
              total: Number(r.total),
              count: r.count,
            }))}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v: any, name: any) =>
                name === "total" ? formatUZS(v) : formatNumber(v)
              }
              labelFormatter={(l) => `Дата: ${l}`}
            />
            <Bar dataKey="total" fill="#2563EB" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        {(s?.by_day || []).length === 0 && !stats.isLoading && (
          <div className="text-center text-sm text-gray-500 dark:text-slate-400 py-4">
            Нет продаж за период
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
            По моделям
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Модель</th>
                <th className="px-4 py-2 text-right">Кол-во</th>
                <th className="px-4 py-2 text-right">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {(s?.by_model || []).length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-gray-500 dark:text-slate-400"
                  >
                    Нет данных за период
                  </td>
                </tr>
              )}
              {(s?.by_model || []).map((r: any, i: number) => (
                <tr
                  key={i}
                  className="border-t border-gray-100 dark:border-slate-800"
                >
                  <td className="px-4 py-2">{r.phone_model}</td>
                  <td className="px-4 py-2 text-right">{formatNumber(r.count)}</td>
                  <td className="px-4 py-2 text-right">{formatUZS(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
            По партнёрам
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Партнёр</th>
                <th className="px-4 py-2 text-right">Кол-во</th>
                <th className="px-4 py-2 text-right">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {(s?.by_partner || []).length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-gray-500 dark:text-slate-400"
                  >
                    Нет данных за период
                  </td>
                </tr>
              )}
              {(s?.by_partner || []).map((r: any) => (
                <tr
                  key={r.partner_id}
                  className="border-t border-gray-100 dark:border-slate-800"
                >
                  <td className="px-4 py-2">{r.partner_name}</td>
                  <td className="px-4 py-2 text-right">{formatNumber(r.count)}</td>
                  <td className="px-4 py-2 text-right">{formatUZS(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Посещаемость (Сводка + Логи) */}
      {(role === "team_lead" || role === "manager") && (
        <div className="space-y-6 mt-6">
          <div className="card p-5">
            <h3 className="text-base font-semibold mb-4 text-gray-900 dark:text-slate-100 flex items-center gap-2">
              <History className="w-5 h-5 text-gray-500" />
              Посещаемость за последние 30 дней
            </h3>
            {attendanceReportQ.isLoading && <div className="text-center py-6 text-gray-500">Загрузка сводки...</div>}
            {!attendanceReportQ.isLoading && attendanceReportQ.data?.rows?.[0] && (
              <AttendanceStatsCard stats={attendanceReportQ.data.rows[0]} />
            )}
          </div>

          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium flex items-center justify-between">
              <span>История смен</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
                  <tr>
                    <th className="px-5 py-3 text-left">Дата</th>
                    <th className="px-5 py-3 text-left">Пришёл</th>
                    <th className="px-5 py-3 text-left">Ушёл</th>
                    <th className="px-5 py-3 text-left">Длительность</th>
                    <th className="px-5 py-3 text-center">Опоздание</th>
                    <th className="px-5 py-3 text-center">Канал</th>
                    <th className="px-5 py-3 text-center">Статус</th>
                    <th className="px-5 py-3 text-center">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-150 dark:divide-slate-800">
                  {attendanceLogsQ.isLoading && (
                    <tr>
                      <td colSpan={8} className="px-5 py-6 text-center text-gray-500">
                        Загрузка истории смен...
                      </td>
                    </tr>
                  )}
                  {!attendanceLogsQ.isLoading && (!attendanceLogsQ.data || attendanceLogsQ.data.length === 0) && (
                    <tr>
                      <td colSpan={8} className="px-5 py-6 text-center text-gray-500">
                        Нет записей о сменах
                      </td>
                    </tr>
                  )}
                  {attendanceLogsQ.data?.map((l: any) => (
                    <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                      <td className="px-5 py-3.5 font-medium whitespace-nowrap">
                        {new Date(l.checked_in_at).toLocaleDateString("ru-RU")}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {new Date(l.checked_in_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {l.checked_out_at
                          ? new Date(l.checked_out_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
                          : "-"}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {l.duration_min !== null ? `${l.duration_min} мин` : "-"}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        {l.was_late ? (
                          <span className="text-red-600 dark:text-red-400 font-semibold inline-flex items-center gap-0.5">
                            <AlertTriangle className="w-3.5 h-3.5" /> Да
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        {l.source === "tg" ? (
                          <span className="px-2 py-0.5 text-xs font-semibold bg-cyan-50 text-cyan-600 dark:bg-cyan-950/20 dark:text-cyan-400 rounded-full">
                            TG
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs font-semibold bg-gray-50 text-gray-500 rounded-full">
                            QR
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        {l.checked_out_at ? (
                          l.manually_closed ? (
                            <span
                              className="px-2 py-0.5 text-xs font-semibold bg-blue-50 text-blue-600 dark:bg-blue-950/20 dark:text-blue-400 rounded-full cursor-help"
                              title={l.manual_close_note ? `Примечание: ${l.manual_close_note}` : `Закрыл: ${l.manually_closed_by_name}`}
                            >
                              TL: {l.manually_closed_by_name}
                            </span>
                          ) : l.auto_closed ? (
                            <span className="px-2 py-0.5 text-xs font-semibold bg-amber-50 text-amber-600 dark:bg-amber-950/20 dark:text-amber-400 rounded-full">
                              Авто-закрыто в 23:00
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 text-xs font-semibold bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20 dark:text-emerald-400 rounded-full">
                              Успешно
                            </span>
                          )
                        ) : (
                          <span className="px-2 py-0.5 text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 rounded-full">
                            на смене
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        {!l.checked_out_at && !l.auto_closed && (
                          <button
                            onClick={() => setClosingLog({ id: l.id, name: stats.data?.full_name || "Оператор" })}
                            className="px-2.5 py-1 text-xs font-semibold bg-red-50 text-red-600 hover:bg-red-100 rounded transition"
                          >
                            Закрыть смену
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TG Dialogs */}
      {(role === 'team_lead' || role === 'manager') && (
        <div className="card overflow-hidden mt-6">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
            TG-диалоги с клиентами
          </div>
          <TgDialogsPanel operatorId={Number(id)} />
        </div>
      )}

      {/* Обучение (последние 7 разборов) */}
      {(role === "team_lead" || role === "manager") && (
        <div className="card overflow-hidden mt-6">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium flex items-center justify-between">
            <span>Обучение (последние 7 разборов)</span>
            <Link
              to={`/lessons/history?operator=${id}`}
              className="text-xs text-blue-600 hover:underline font-semibold"
            >
              Вся история
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3 text-left">Дата</th>
                  <th className="px-5 py-3 text-left">Фокус дня</th>
                  <th className="px-5 py-3 text-left">Резюме разбора</th>
                  <th className="px-5 py-3 text-center">Просмотрен</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-150 dark:divide-slate-800">
                {lessonsQ.isLoading && (
                  <tr>
                    <td colSpan={4} className="px-5 py-6 text-center text-gray-500">
                      Загрузка разборов...
                    </td>
                  </tr>
                )}
                {!lessonsQ.isLoading && (!lessonsQ.data || lessonsQ.data.length === 0) && (
                  <tr>
                    <td colSpan={4} className="px-5 py-6 text-center text-gray-500">
                      Разборов пока нет
                    </td>
                  </tr>
                )}
                {lessonsQ.data?.map((lesson: any) => (
                  <tr
                    key={lesson.id}
                    onClick={() => setSelectedLessonDate(lesson.lesson_date)}
                    className="cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/40 transition"
                  >
                    <td className="px-5 py-3 whitespace-nowrap font-medium">
                      {new Date(lesson.lesson_date).toLocaleDateString("ru-RU", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-5 py-3 font-semibold text-gray-900 dark:text-slate-200">
                      {lesson.micro_lesson}
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-slate-400 max-w-sm truncate">
                      {lesson.summary}
                    </td>
                    <td className="px-5 py-3 text-center">
                      <span className="inline-flex justify-center">
                        {lesson.opened_at ? (
                          <span title={`Открыт: ${new Date(lesson.opened_at).toLocaleDateString()}`}><Eye className="w-4 h-4 text-emerald-600" /></span>
                        ) : (
                          <span title="Не открыт оператором"><EyeOff className="w-4 h-4 text-gray-400" /></span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Lesson Detail Modal */}
      <Modal
        open={!!selectedLessonDate}
        onClose={() => setSelectedLessonDate(null)}
        title={
          selectedLessonDate
            ? `ИИ-разбор за ${new Date(selectedLessonDate).toLocaleDateString("ru-RU", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}`
            : ""
        }
        widthClass="max-w-4xl"
      >
        {lessonDetailQ.isLoading && <div className="text-center py-8 text-gray-500">Загрузка деталей...</div>}
        {!lessonDetailQ.isLoading && lessonDetailQ.data && (
          <div className="space-y-6 max-h-[80vh] overflow-y-auto pr-2">
            <div className="flex items-start gap-3 bg-blue-50 dark:bg-slate-800/50 rounded-xl p-4 border border-blue-100 dark:border-slate-800">
              <Target className="w-6 h-6 text-blue-600 mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs uppercase tracking-wider text-blue-800 dark:text-blue-400 font-semibold font-mono">
                  Фокус на этот день:
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-slate-100 mt-0.5">
                  {lessonDetailQ.data.micro_lesson}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Продажи</div>
                <div className="text-lg font-semibold mt-1">
                  {lessonDetailQ.data.stats_snapshot?.sales_count || 0} шт
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Сумма</div>
                <div className="text-lg font-semibold mt-1">
                  {formatUZS(lessonDetailQ.data.stats_snapshot?.revenue_uzs || 0)}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Диалоги</div>
                <div className="text-lg font-semibold mt-1">
                  {lessonDetailQ.data.stats_snapshot?.dialogs_count || 0}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Качество</div>
                <div className="text-lg font-semibold mt-1">
                  {lessonDetailQ.data.stats_snapshot?.avg_quality ? Math.round(lessonDetailQ.data.stats_snapshot.avg_quality) : 0}/100
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Итог дня</h3>
              <p className="text-sm text-gray-800 dark:text-slate-200 leading-relaxed font-medium">
                {lessonDetailQ.data.summary}
              </p>
            </div>

            {lessonDetailQ.data.highlights && lessonDetailQ.data.highlights.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-400">
                  Что было сильно
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {lessonDetailQ.data.highlights.map((hl: any, i: number) => (
                    <div
                      key={i}
                      className="bg-emerald-50/20 dark:bg-emerald-950/5 border border-emerald-100 dark:border-emerald-900/10 rounded-lg p-3 space-y-1"
                    >
                      <div className="font-semibold text-xs text-emerald-950 dark:text-emerald-300">
                        {hl.title}
                      </div>
                      <div className="text-xs text-emerald-900/80 dark:text-emerald-400/80">
                        {hl.evidence}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {lessonDetailQ.data.tips && lessonDetailQ.data.tips.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-400">
                  Рекомендации
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {lessonDetailQ.data.tips.map((tip: any, i: number) => (
                    <div
                      key={i}
                      className="bg-white dark:bg-slate-900 border border-gray-150 dark:border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-3"
                    >
                      <div className="space-y-2">
                        <h4 className="font-semibold text-gray-900 dark:text-slate-100 text-xs">
                          {tip.title}
                        </h4>
                        <div className="text-[11px] text-gray-500">
                          <span className="font-semibold text-amber-800 dark:text-amber-400">Важно:</span>{" "}
                          {tip.why}
                        </div>
                        <div className="bg-gray-50 dark:bg-slate-800/40 border-l-2 border-amber-300 p-2 text-[10px] italic text-gray-600 dark:text-slate-300 leading-normal font-mono">
                          "{tip.example}"
                        </div>
                      </div>
                      <div className="pt-2 border-t border-gray-100 dark:border-slate-800 text-[10px] font-semibold text-amber-900 dark:text-amber-400 flex items-center gap-1">
                        <ChevronRight className="w-3 h-3" />
                        Действие: {tip.action}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Manual close confirmation modal */}
      {closingLog && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 max-w-md w-full rounded-2xl p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">
              Закрыть смену оператора {closingLog.name}?
            </h3>
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
        </div>
      )}
    </div>
  );
}
