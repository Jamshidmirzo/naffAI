import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { Modal } from "../components/Modal";
import { CheckCircle2, ChevronRight, Target, Eye, EyeOff, BookOpen } from "lucide-react";
import { useAuth } from "../store/auth";

interface LessonHistoryItem {
  id: number;
  lesson_date: string;
  summary: string;
  micro_lesson: string;
  opened_at: string | null;
}

interface Tip {
  title: string;
  why: string;
  example: string;
  action: string;
}

interface Highlight {
  title: string;
  evidence: string;
}

interface DailyLessonDetail {
  id: number;
  lesson_date: string;
  summary: string;
  highlights: Highlight[];
  tips: Tip[];
  micro_lesson: string;
  stats_snapshot: {
    sales_count: number;
    revenue_uzs: number;
    avg_check: number;
    dialogs_count: number;
    avg_quality: number;
    callbacks_missed: number;
    leads_won: number;
    leads_lost: number;
    month_progress_pct: number;
  };
}

export default function LessonsHistory() {
  const [searchParams] = useSearchParams();
  const operatorParam = searchParams.get("operator");
  const auth = useAuth();

  const operatorId = operatorParam || "";

  // 1. Fetch History List
  const { data: history, isLoading } = useQuery<LessonHistoryItem[]>({
    queryKey: ["lessons", "history", operatorId],
    queryFn: () => {
      const url = operatorId ? `/lessons/history/?operator=${operatorId}` : "/lessons/history/";
      return api.get<LessonHistoryItem[]>(url).then((r) => r.data);
    },
  });

  // 2. State for Modal and Selected Lesson
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // 3. Fetch Single Lesson Detail
  const { data: detail, isLoading: isLoadingDetail } = useQuery<DailyLessonDetail>({
    queryKey: ["lessons", "detail", operatorId, selectedDate],
    queryFn: () => {
      // Find operator_id from auth if not manager
      const opId = operatorId || "";
      return api
        .get<DailyLessonDetail>(`/lessons/?operator=${opId}&date=${selectedDate}`)
        .then((r) => r.data);
    },
    enabled: !!selectedDate,
  });

  const formatUZS = (val: number) => {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "UZS",
      maximumFractionDigits: 0,
    }).format(val).replace("UZS", "сум");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">История ИИ-разборов</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Список всех утренних разборов и рекомендаций
          </p>
        </div>
        {!operatorParam && (
          <Link to="/lessons/today" className="btn-primary text-sm">
            Сегодняшний разбор
          </Link>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
            <tr>
              <th className="px-5 py-3 text-left">Дата</th>
              <th className="px-5 py-3 text-left">Фокус дня</th>
              <th className="px-5 py-3 text-left">Кратко</th>
              <th className="px-5 py-3 text-center">Просмотрен</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-150 dark:divide-slate-800">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-gray-500">
                  Загрузка истории...
                </td>
              </tr>
            )}
            {!isLoading && (!history || history.length === 0) && (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-gray-500">
                  История разборов пуста.
                </td>
              </tr>
            )}
            {history?.map((item) => (
              <tr
                key={item.id}
                onClick={() => setSelectedDate(item.lesson_date)}
                className="cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/40 transition"
              >
                <td className="px-5 py-4 whitespace-nowrap font-medium">
                  {new Date(item.lesson_date).toLocaleDateString("ru-RU", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </td>
                <td className="px-5 py-4 font-semibold text-gray-900 dark:text-slate-200">
                  {item.micro_lesson}
                </td>
                <td className="px-5 py-4 text-gray-500 dark:text-slate-400 max-w-md truncate">
                  {item.summary}
                </td>
                <td className="px-5 py-4 text-center">
                  <span className="inline-flex justify-center">
                    {item.opened_at ? (
                      <span title="Просмотрен"><Eye className="w-4 h-4 text-emerald-600" /></span>
                    ) : (
                      <span title="Не просмотрен"><EyeOff className="w-4 h-4 text-gray-400" /></span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail Modal */}
      <Modal
        open={!!selectedDate}
        onClose={() => setSelectedDate(null)}
        title={
          selectedDate
            ? `ИИ-разбор за ${new Date(selectedDate).toLocaleDateString("ru-RU", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}`
            : ""
        }
        widthClass="max-w-4xl"
      >
        {isLoadingDetail && <div className="text-center py-8 text-gray-500">Загрузка деталей...</div>}
        {!isLoadingDetail && detail && (
          <div className="space-y-6 max-h-[80vh] overflow-y-auto pr-2">
            {/* Focus Banner */}
            <div className="flex items-start gap-3 bg-blue-50 dark:bg-slate-800/50 rounded-xl p-4 border border-blue-100 dark:border-slate-800">
              <Target className="w-6 h-6 text-blue-600 mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs uppercase tracking-wider text-blue-800 dark:text-blue-400 font-semibold">
                  Фокус на этот день:
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-slate-100 mt-0.5">
                  {detail.micro_lesson}
                </div>
              </div>
            </div>

            {/* KPI list */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Продажи</div>
                <div className="text-lg font-semibold mt-1">
                  {detail.stats_snapshot.sales_count || 0} шт
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Сумма</div>
                <div className="text-lg font-semibold mt-1">
                  {formatUZS(detail.stats_snapshot.revenue_uzs || 0)}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Диалоги</div>
                <div className="text-lg font-semibold mt-1">
                  {detail.stats_snapshot.dialogs_count || 0}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-slate-800/30 p-3 rounded-lg text-center">
                <div className="text-[10px] uppercase text-gray-500">Качество</div>
                <div className="text-lg font-semibold mt-1">
                  {detail.stats_snapshot.avg_quality ? Math.round(detail.stats_snapshot.avg_quality) : 0}/100
                </div>
              </div>
            </div>

            {/* Summary */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Итог дня</h3>
              <p className="text-sm text-gray-800 dark:text-slate-200 leading-relaxed font-medium">
                {detail.summary}
              </p>
            </div>

            {/* Highlights */}
            {detail.highlights && detail.highlights.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-400">
                  Что было сильно
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {detail.highlights.map((hl, i) => (
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

            {/* Tips */}
            {detail.tips && detail.tips.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-400">
                  Рекомендации
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {detail.tips.map((tip, i) => (
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
    </div>
  );
}
