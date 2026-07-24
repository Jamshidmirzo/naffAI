import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronRight, TrendingUp, TrendingDown, Target, BookOpen } from "lucide-react";
import { api } from "../lib/api";

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

interface DailyLessonData {
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
    delta_revenue?: number;
    delta_count?: number;
  };
}

export default function DailyLesson() {
  const { data: lesson, isLoading, error } = useQuery<DailyLessonData>({
    queryKey: ["lessons", "today"],
    queryFn: () => api.get<DailyLessonData>("/lessons/today/").then((r) => r.data),
    retry: false,
  });

  const [checkedTips, setCheckedTips] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (lesson) {
      const saved = localStorage.getItem(`lesson-${lesson.id}-tips`);
      if (saved) {
        setCheckedTips(JSON.parse(saved));
      }
    }
  }, [lesson]);

  const handleCheckTip = (index: number) => {
    if (!lesson) return;
    const updated = { ...checkedTips, [index]: !checkedTips[index] };
    setCheckedTips(updated);
    localStorage.setItem(`lesson-${lesson.id}-tips`, JSON.stringify(updated));
  };

  const allTipsChecked = lesson
    ? lesson.tips.length > 0 && lesson.tips.every((_, idx) => checkedTips[idx])
    : false;

  const formatUZS = (val: number) => {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "UZS",
      maximumFractionDigits: 0,
    }).format(val).replace("UZS", "сум");
  };

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500">Загрузка разбора...</div>;
  }

  if (error || !lesson) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center card p-8 space-y-4">
        <BookOpen className="w-12 h-12 text-gray-400 mx-auto" />
        <h2 className="text-xl font-medium text-gray-900 dark:text-slate-100">
          Утренний разбор ещё не готов
        </h2>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Если вчера не было продаж или диалогов, урок пропускается. Вчерашний день был тихим? Отличный шанс показать класс сегодня!
        </p>
        <div className="pt-4">
          <Link to="/lessons/history" className="text-blue-600 hover:underline text-sm font-medium">
            История моих разборов
          </Link>
        </div>
      </div>
    );
  }

  const stats = lesson.stats_snapshot || {};
  const deltaRevenue = stats.delta_revenue || 0;
  const deltaCount = stats.delta_count || 0;

  return (
    <div className="space-y-6">
      {/* Hero Card */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-indigo-700 p-6 md:p-8 text-white shadow-lg">
        <div className="absolute top-0 right-0 -mt-4 -mr-4 w-40 h-40 bg-white/10 rounded-full blur-2xl" />
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-2">
            <span className="inline-block px-3 py-1 bg-white/20 rounded-full text-xs font-semibold uppercase tracking-wider">
              {new Date(lesson.lesson_date).toLocaleDateString("ru-RU", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
            <h1 className="text-2xl md:text-3xl font-bold">Вчерашний день под ИИ-микроскопом</h1>
          </div>
          <div className="flex items-center gap-3 bg-white/10 rounded-xl p-4 max-w-md border border-white/10">
            <Target className="w-10 h-10 text-amber-300 flex-shrink-0" />
            <div>
              <div className="text-xs text-white/70">Фокус на сегодня:</div>
              <div className="text-sm font-bold leading-snug">{lesson.micro_lesson}</div>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Plaquettes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Sales Card */}
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">Продажи</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-gray-900 dark:text-slate-100">{stats.sales_count || 0}</span>
            <span className="text-sm text-gray-500 dark:text-slate-400">шт</span>
          </div>
          <div className="mt-2 flex items-center gap-1 text-xs">
            {deltaCount >= 0 ? (
              <span className="flex items-center gap-0.5 text-emerald-600 font-medium">
                <TrendingUp className="w-3.5 h-3.5" /> +{deltaCount.toFixed(1)}
              </span>
            ) : (
              <span className="flex items-center gap-0.5 text-red-600 font-medium">
                <TrendingDown className="w-3.5 h-3.5" /> {deltaCount.toFixed(1)}
              </span>
            )}
            <span className="text-gray-400">к среднему 30д</span>
          </div>
        </div>

        {/* Revenue Card */}
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">Сумма</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-gray-900 dark:text-slate-100">{formatUZS(stats.revenue_uzs || 0)}</span>
          </div>
          <div className="mt-2 flex items-center gap-1 text-xs">
            {deltaRevenue >= 0 ? (
              <span className="flex items-center gap-0.5 text-emerald-600 font-medium">
                <TrendingUp className="w-3.5 h-3.5" /> +{formatUZS(deltaRevenue)}
              </span>
            ) : (
              <span className="flex items-center gap-0.5 text-red-600 font-medium">
                <TrendingDown className="w-3.5 h-3.5" /> {formatUZS(deltaRevenue)}
              </span>
            )}
            <span className="text-gray-400">к среднему 30д</span>
          </div>
        </div>

        {/* Dialogs Card */}
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">Диалоги</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-gray-900 dark:text-slate-100">{stats.dialogs_count || 0}</span>
            <span className="text-sm text-gray-500 dark:text-slate-400">активных</span>
          </div>
          <div className="mt-2 text-xs text-gray-400">
            Пропущено колбеков: <span className="font-semibold text-gray-700 dark:text-slate-300">{stats.callbacks_missed || 0}</span>
          </div>
        </div>

        {/* Quality Card */}
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">Качество диалогов</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-gray-900 dark:text-slate-100">{stats.avg_quality ? Math.round(stats.avg_quality) : 0}</span>
            <span className="text-sm text-gray-500 dark:text-slate-400">/ 100</span>
          </div>
          <div className="mt-2 text-xs text-gray-400">
            Прогресс месяца: <span className="font-semibold text-gray-700 dark:text-slate-300">{stats.month_progress_pct ? stats.month_progress_pct.toFixed(1) : 0}%</span>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="card p-6 space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Как прошёл день</h3>
        <p className="text-lg leading-relaxed text-gray-800 dark:text-slate-200 font-medium">
          {lesson.summary}
        </p>
      </div>

      {/* Highlights (Зеленый блок) */}
      {lesson.highlights && lesson.highlights.length > 0 && (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-6 dark:border-emerald-900/30 dark:bg-emerald-950/10 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-400">Что было сильно</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {lesson.highlights.map((hl, i) => (
              <div key={i} className="bg-white dark:bg-slate-900 border border-emerald-100 dark:border-emerald-900/20 rounded-lg p-4 space-y-1 shadow-sm">
                <h4 className="font-semibold text-emerald-950 dark:text-emerald-300 text-sm">{hl.title}</h4>
                <p className="text-xs text-emerald-900/80 dark:text-emerald-400/80">{hl.evidence}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tips (Желто-оранжевый блок) */}
      <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-6 dark:border-amber-900/30 dark:bg-amber-950/10 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-400">Что подтянуть</h3>
          {allTipsChecked && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 px-2 py-1 rounded-full font-semibold">
              <CheckCircle2 className="w-3.5 h-3.5" /> Отлично, идём в бой!
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {lesson.tips.map((tip, idx) => {
            const isChecked = checkedTips[idx] || false;
            return (
              <div
                key={idx}
                onClick={() => handleCheckTip(idx)}
                className={`cursor-pointer transition-all duration-200 border rounded-xl p-5 flex flex-col justify-between space-y-4 shadow-sm hover:shadow-md ${
                  isChecked
                    ? "bg-emerald-50/20 border-emerald-200 dark:border-emerald-900/20 opacity-70"
                    : "bg-white dark:bg-slate-900 border-amber-100 dark:border-amber-900/20"
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-semibold text-gray-900 dark:text-slate-100 text-sm leading-snug">
                      {tip.title}
                    </h4>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}} // Handled by div click
                      className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer mt-0.5 flex-shrink-0"
                    />
                  </div>
                  <div className="text-xs text-gray-500 dark:text-slate-400">
                    <span className="font-semibold text-amber-800 dark:text-amber-400">Почему важно:</span> {tip.why}
                  </div>
                  <div className="bg-gray-50 dark:bg-slate-800/50 border-l-2 border-amber-300 rounded p-3 text-xs italic text-gray-600 dark:text-slate-300 leading-relaxed font-mono">
                    "{tip.example}"
                  </div>
                </div>
                <div className="pt-2 border-t border-gray-100 dark:border-slate-800 text-xs font-semibold text-amber-900 dark:text-amber-400 flex items-center gap-1">
                  <ChevronRight className="w-3.5 h-3.5" />
                  Действие: {tip.action}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer Navigation */}
      <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-slate-800">
        <Link to="/lessons/history" className="text-sm font-semibold text-blue-600 hover:underline">
          История моих разборов &rarr;
        </Link>
      </div>
    </div>
  );
}
