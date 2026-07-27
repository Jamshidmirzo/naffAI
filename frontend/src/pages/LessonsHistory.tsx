import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "../lib/api";
import { Button, Eyebrow, StatusBadge } from "../components/ui";
import { usePageHeader } from "../store/page";

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
    dialogs_count: number;
    avg_quality: number;
    month_progress_pct: number;
  };
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function LessonsHistory() {
  const [searchParams] = useSearchParams();
  const operatorId = searchParams.get("operator") || "";

  usePageHeader({
    title: "История разборов",
    subtitle: "Все утренние AI-разборы",
  });

  const { data: history, isLoading } = useQuery<LessonHistoryItem[]>({
    queryKey: ["lessons", "history", operatorId],
    queryFn: () => {
      const url = operatorId
        ? `/lessons/history/?operator=${operatorId}`
        : "/lessons/history/";
      return api.get<LessonHistoryItem[]>(url).then((r) => r.data);
    },
  });

  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const { data: detail, isLoading: isLoadingDetail } = useQuery<DailyLessonDetail>({
    queryKey: ["lessons", "detail", operatorId, expandedDate],
    queryFn: () =>
      api
        .get<DailyLessonDetail>(
          `/lessons/?operator=${operatorId}&date=${expandedDate}`,
        )
        .then((r) => r.data),
    enabled: !!expandedDate,
  });

  return (
    <div className="mx-auto max-w-[760px] flex flex-col gap-4">
      <div className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {isLoading
            ? "Загрузка…"
            : `${(history || []).length} разборов`}
        </div>
        {!operatorId && (
          <Link to="/lessons/today">
            <Button size="sm">Сегодняшний разбор</Button>
          </Link>
        )}
      </div>

      {!isLoading && (!history || history.length === 0) && (
        <div
          className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
          style={{ border: "1.5px dashed var(--border)" }}
        >
          История пока пуста
        </div>
      )}

      {(history || []).map((item, i) => {
        const isOpen = expandedDate === item.lesson_date;
        return (
          <section
            key={item.id}
            className="nf-card overflow-hidden animate-nfFadeUp"
            style={{ borderRadius: 22, animationDelay: `${0.03 + i * 0.045}s` }}
          >
            <button
              type="button"
              onClick={() =>
                setExpandedDate(isOpen ? null : item.lesson_date)
              }
              className="w-full text-left flex items-center gap-4 transition"
              style={{ padding: "18px 22px" }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <div className="text-[14.5px] font-semibold">
                    {fmtDate(item.lesson_date)}
                  </div>
                  {!item.opened_at && (
                    <StatusBadge tone="hot">не прочитан</StatusBadge>
                  )}
                </div>
                {item.micro_lesson && (
                  <div className="text-[12.5px] text-muted mt-1 truncate">
                    {item.micro_lesson}
                  </div>
                )}
              </div>
              {isOpen ? (
                <ChevronUp className="w-4 h-4 text-muted shrink-0" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted shrink-0" />
              )}
            </button>

            {isOpen && (
              <div
                className="animate-nfFade"
                style={{
                  padding: "0 22px 22px",
                  borderTop: "1px solid var(--border)",
                }}
              >
                {isLoadingDetail && (
                  <div className="py-8 text-center text-muted text-[13px]">
                    Загрузка…
                  </div>
                )}
                {detail && (
                  <div className="pt-5 flex flex-col gap-5">
                    {detail.micro_lesson && (
                      <div>
                        <Eyebrow>Фокус дня</Eyebrow>
                        <div className="text-[14px] font-medium mt-2">
                          {detail.micro_lesson}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2">
                      <div className="nf-tile" style={{ padding: "12px 14px" }}>
                        <div className="text-[10.5px] text-muted uppercase tracking-wider">
                          Продаж
                        </div>
                        <div className="mt-1 text-[19px] font-semibold tabular-nums">
                          {detail.stats_snapshot?.sales_count || 0}
                        </div>
                      </div>
                      <div className="nf-tile" style={{ padding: "12px 14px" }}>
                        <div className="text-[10.5px] text-muted uppercase tracking-wider">
                          Диалогов
                        </div>
                        <div className="mt-1 text-[19px] font-semibold tabular-nums">
                          {detail.stats_snapshot?.dialogs_count || 0}
                        </div>
                      </div>
                      <div className="nf-tile" style={{ padding: "12px 14px" }}>
                        <div className="text-[10.5px] text-muted uppercase tracking-wider">
                          Качество
                        </div>
                        <div className="mt-1 text-[19px] font-semibold tabular-nums">
                          {Math.round(detail.stats_snapshot?.avg_quality || 0)}
                        </div>
                      </div>
                    </div>

                    {detail.summary && (
                      <div>
                        <div className="text-[13.5px] font-semibold">
                          Как прошёл день
                        </div>
                        <p
                          className="mt-1.5 text-[14px]"
                          style={{ color: "var(--muted)", lineHeight: 1.55 }}
                        >
                          {detail.summary}
                        </p>
                      </div>
                    )}

                    {detail.highlights?.length > 0 && (
                      <div>
                        <div className="text-[13.5px] font-semibold">
                          Что сработало
                        </div>
                        <div className="mt-1.5 flex flex-col gap-2">
                          {detail.highlights.map((hl, k) => (
                            <div
                              key={k}
                              className="text-[13.5px]"
                              style={{ color: "var(--muted)", lineHeight: 1.55 }}
                            >
                              <span style={{ color: "var(--text)", fontWeight: 600 }}>
                                {hl.title}.
                              </span>{" "}
                              {hl.evidence}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {detail.tips?.length > 0 && (
                      <div>
                        <div className="text-[13.5px] font-semibold">
                          Что подтянуть
                        </div>
                        <div className="mt-1.5 flex flex-col gap-3">
                          {detail.tips.map((tip, k) => (
                            <div key={k}>
                              <div
                                className="text-[13.5px] font-semibold"
                                style={{ color: "var(--text)" }}
                              >
                                {tip.title}
                              </div>
                              <div
                                className="text-[13px] mt-0.5"
                                style={{ color: "var(--muted)", lineHeight: 1.55 }}
                              >
                                {tip.why}
                              </div>
                              {tip.example && (
                                <div
                                  className="mt-1.5 rounded-lg px-3 py-2 text-[12.5px]"
                                  style={{
                                    background: "var(--faint)",
                                    fontStyle: "italic",
                                    color: "var(--text)",
                                  }}
                                >
                                  «{tip.example}»
                                </div>
                              )}
                              {tip.action && (
                                <div
                                  className="mt-1.5 text-[12.5px] font-medium"
                                  style={{ color: "var(--accent)" }}
                                >
                                  → {tip.action}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
