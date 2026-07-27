import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Eyebrow, toast } from "../components/ui";
import { usePageHeader } from "../store/page";

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
  opened_at?: string | null;
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

export default function DailyLesson() {
  usePageHeader({ title: "Урок на сегодня", subtitle: "AI-разбор вчерашнего дня" });

  const qc = useQueryClient();
  const { data: lesson, isLoading, error } = useQuery<DailyLessonData>({
    queryKey: ["lessons", "today"],
    queryFn: () => api.get<DailyLessonData>("/lessons/today/").then((r) => r.data),
    retry: false,
  });

  const [markedRead, setMarkedRead] = useState(false);

  useEffect(() => {
    if (lesson?.opened_at) setMarkedRead(true);
  }, [lesson?.opened_at]);

  const markRead = useMutation({
    mutationFn: () => api.post("/lessons/today/mark-read/").catch(() => null),
    onSuccess: () => {
      setMarkedRead(true);
      toast.success("Разбор прочитан");
      qc.invalidateQueries({ queryKey: ["lessons", "today", "peek"] });
    },
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[760px] py-16 text-center text-muted text-[14px]">
        Загрузка разбора…
      </div>
    );
  }

  if (error || !lesson) {
    return (
      <div className="mx-auto max-w-[760px]">
        <div
          className="nf-card text-center"
          style={{ borderRadius: 26, padding: "44px 36px" }}
        >
          <div className="text-[18px] font-semibold mb-2">
            Утренний разбор ещё не готов
          </div>
          <div className="text-[13.5px] text-muted max-w-md mx-auto">
            Если вчера не было продаж или диалогов, урок пропускается. Отличный шанс
            показать класс сегодня!
          </div>
          <div className="mt-6">
            <Link
              to="/lessons/history"
              className="text-[13px] font-semibold"
              style={{ color: "var(--accent)" }}
            >
              История моих разборов →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const stats = lesson.stats_snapshot || ({} as DailyLessonData["stats_snapshot"]);
  const conversion =
    stats.dialogs_count > 0
      ? Math.round(((stats.sales_count || 0) / stats.dialogs_count) * 100)
      : 0;

  return (
    <div className="mx-auto max-w-[760px] flex flex-col gap-5">
      <section
        className="nf-card animate-nfFadeUp"
        style={{ borderRadius: 26, padding: "34px 36px" }}
      >
        <Eyebrow>AI-РАЗБОР · ВЧЕРА</Eyebrow>
        <h1
          className="font-semibold mt-3"
          style={{ fontSize: 30, letterSpacing: "-0.03em", lineHeight: 1.1 }}
        >
          {new Date(lesson.lesson_date).toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </h1>
        {lesson.micro_lesson && (
          <p
            className="mt-3 text-[15px]"
            style={{ color: "var(--text)", lineHeight: 1.55 }}
          >
            {lesson.micro_lesson}
          </p>
        )}

        <div className="grid grid-cols-3 gap-3 mt-7">
          <div className="nf-tile" style={{ padding: "16px 18px" }}>
            <div className="text-[11.5px] text-muted uppercase tracking-wider font-medium">
              Диалогов
            </div>
            <div
              className="mt-1.5 font-semibold tabular-nums"
              style={{ fontSize: 26, letterSpacing: "-0.03em" }}
            >
              {stats.dialogs_count || 0}
            </div>
          </div>
          <div className="nf-tile" style={{ padding: "16px 18px" }}>
            <div className="text-[11.5px] text-muted uppercase tracking-wider font-medium">
              Продаж
            </div>
            <div
              className="mt-1.5 font-semibold tabular-nums"
              style={{ fontSize: 26, letterSpacing: "-0.03em" }}
            >
              {stats.sales_count || 0}
            </div>
          </div>
          <div className="nf-tile" style={{ padding: "16px 18px" }}>
            <div className="text-[11.5px] text-muted uppercase tracking-wider font-medium">
              Конверсия
            </div>
            <div
              className="mt-1.5 font-semibold tabular-nums"
              style={{ fontSize: 26, letterSpacing: "-0.03em" }}
            >
              {conversion}%
            </div>
          </div>
        </div>

        {lesson.summary && (
          <div className="mt-7">
            <div className="text-[14.5px] font-semibold">Как прошёл день</div>
            <p
              className="mt-2 text-[14.5px]"
              style={{ color: "var(--muted)", lineHeight: 1.6 }}
            >
              {lesson.summary}
            </p>
          </div>
        )}

        {lesson.highlights && lesson.highlights.length > 0 && (
          <div className="mt-7">
            <div className="text-[14.5px] font-semibold">Что сработало</div>
            <div className="mt-2 flex flex-col gap-2.5">
              {lesson.highlights.map((hl, i) => (
                <div
                  key={i}
                  className="text-[14.5px]"
                  style={{ color: "var(--muted)", lineHeight: 1.6 }}
                >
                  <span
                    className="font-semibold"
                    style={{ color: "var(--text)" }}
                  >
                    {hl.title}.
                  </span>{" "}
                  {hl.evidence}
                </div>
              ))}
            </div>
          </div>
        )}

        {lesson.tips && lesson.tips.length > 0 && (
          <>
            <div className="mt-7">
              <div className="text-[14.5px] font-semibold">Что мешало</div>
              <div className="mt-2 flex flex-col gap-2.5">
                {lesson.tips.map((tip, i) => (
                  <div
                    key={i}
                    className="text-[14.5px]"
                    style={{ color: "var(--muted)", lineHeight: 1.6 }}
                  >
                    <span
                      className="font-semibold"
                      style={{ color: "var(--text)" }}
                    >
                      {tip.title}.
                    </span>{" "}
                    {tip.why}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[14.5px] font-semibold">План на сегодня</div>
              <div className="mt-2 flex flex-col gap-3">
                {lesson.tips.map((tip, i) => (
                  <div key={i}>
                    <div
                      className="text-[14.5px]"
                      style={{ color: "var(--muted)", lineHeight: 1.6 }}
                    >
                      <span
                        className="font-semibold"
                        style={{ color: "var(--text)" }}
                      >
                        {tip.action}.
                      </span>{" "}
                      {tip.example && (
                        <span style={{ fontStyle: "italic" }}>«{tip.example}»</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="mt-8 flex items-center justify-between gap-3">
          <Link
            to="/lessons/history"
            className="text-[13px] font-medium text-muted hover:text-text transition"
          >
            История разборов →
          </Link>
          <Button
            disabled={markedRead || markRead.isPending}
            onClick={() => markRead.mutate()}
          >
            {markedRead ? "Разбор прочитан ✓" : "Отметить прочитанным"}
          </Button>
        </div>
      </section>
    </div>
  );
}
