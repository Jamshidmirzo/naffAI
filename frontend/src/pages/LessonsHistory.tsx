import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "../lib/api";
import { Button, Eyebrow, StatusBadge } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface LessonHistoryItem {
  id: number;
  lesson_date: string;
  summary: string;
  micro_lesson: string;
  language?: "ru" | "uz";
  opened_at: string | null;
}

interface Highlight { title: string; evidence: string }
interface Blocker { title: string; why: string; example: string }
interface PracticeStep { step: string; when: string; how: string }
interface MainInsight { title: string; text: string }

interface LessonContentV2 {
  greeting_line: string;
  yesterday_summary: string;
  main_insight: MainInsight;
  highlights: Highlight[];
  blockers: Blocker[];
  practice_today: PracticeStep[];
  micro_lesson: string;
  closing_line: string;
}

interface LegacyTip { title: string; why: string; example: string; action: string }

interface DailyLessonDetail {
  id: number;
  lesson_date: string;
  language: "ru" | "uz";
  content: LessonContentV2 | Record<string, never>;
  summary: string;
  highlights: Highlight[];
  tips: LegacyTip[];
  micro_lesson: string;
  stats_snapshot: {
    sales_count: number;
    revenue_uzs: number;
    dialogs_count: number;
    avg_quality: number;
    month_progress_pct: number;
  };
}

function fmtDate(iso: string, language: "ru" | "uz" = "ru") {
  const locale = language === "uz" ? "uz-UZ" : "ru-RU";
  try {
    return new Date(iso).toLocaleDateString(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return new Date(iso).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
}

function isContentV2(c: LessonContentV2 | Record<string, never>): c is LessonContentV2 {
  if (!c || typeof c !== "object") return false;
  const v2Keys = [
    "greeting_line",
    "yesterday_summary",
    "main_insight",
    "blockers",
    "practice_today",
    "closing_line",
  ];
  return v2Keys.some((k) => k in (c as Record<string, unknown>));
}

export default function LessonsHistory() {
  const [searchParams] = useSearchParams();
  const operatorId = searchParams.get("operator") || "";
  const t = useT();

  usePageHeader({
    title: t("lessons.history_analyses_title"),
    subtitle: t("lessons.history_analyses_subtitle"),
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
    queryFn: () => {
      // Operators viewing their own history don't have a ?operator= in the URL —
      // the backend infers their operator id from the auth profile. Managers /
      // superadmins have selected an operator upstream (OperatorDetail passes
      // it via ?operator=), so we forward whatever we have.
      const params = new URLSearchParams({ date: expandedDate! });
      if (operatorId) params.set("operator", operatorId);
      return api
        .get<DailyLessonDetail>(`/lessons/?${params.toString()}`)
        .then((r) => r.data);
    },
    enabled: !!expandedDate,
  });

  return (
    <div className="mx-auto max-w-[760px] flex flex-col gap-4">
      <div className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {isLoading
            ? t("common.loading")
            : t("lessons.history_count", { n: (history || []).length })}
        </div>
        {!operatorId && (
          <Link to="/lessons/today">
            <Button size="sm">{t("lessons.today_analysis_btn")}</Button>
          </Link>
        )}
      </div>

      {!isLoading && (!history || history.length === 0) && (
        <div
          className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
          style={{ border: "1.5px dashed var(--border)" }}
        >
          {t("lessons.history_empty")}
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
                    {fmtDate(item.lesson_date, item.language ?? "ru")}
                  </div>
                  {!item.opened_at && (
                    <StatusBadge tone="hot">{t("lessons.not_read")}</StatusBadge>
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
                    {t("common.loading")}
                  </div>
                )}
                {detail && <LessonDetailBody detail={detail} />}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LessonDetailBody({ detail }: { detail: DailyLessonDetail }) {
  const t = useT();
  const v2 = isContentV2(detail.content) ? detail.content : null;

  return (
    <div className="pt-5 flex flex-col gap-5">
      {(v2?.micro_lesson || detail.micro_lesson) && (
        <div>
          <Eyebrow>{t("lessons.focus_day")}</Eyebrow>
          <div className="text-[14px] font-medium mt-2">
            {v2?.micro_lesson || detail.micro_lesson}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <div className="nf-tile" style={{ padding: "12px 14px" }}>
          <div className="text-[10.5px] text-muted uppercase tracking-wider">
            {t("lessons.stat_sales")}
          </div>
          <div className="mt-1 text-[19px] font-semibold tabular-nums">
            {detail.stats_snapshot?.sales_count || 0}
          </div>
        </div>
        <div className="nf-tile" style={{ padding: "12px 14px" }}>
          <div className="text-[10.5px] text-muted uppercase tracking-wider">
            {t("lessons.stat_dialogs")}
          </div>
          <div className="mt-1 text-[19px] font-semibold tabular-nums">
            {detail.stats_snapshot?.dialogs_count || 0}
          </div>
        </div>
        <div className="nf-tile" style={{ padding: "12px 14px" }}>
          <div className="text-[10.5px] text-muted uppercase tracking-wider">
            {t("lessons.stat_quality")}
          </div>
          <div className="mt-1 text-[19px] font-semibold tabular-nums">
            {Math.round(detail.stats_snapshot?.avg_quality || 0)}
          </div>
        </div>
      </div>

      {(v2?.yesterday_summary || detail.summary) && (
        <div>
          <div className="text-[13.5px] font-semibold">
            {t("lessons.yesterday_title")}
          </div>
          <p
            className="mt-1.5 text-[14px]"
            style={{ color: "var(--muted)", lineHeight: 1.55 }}
          >
            {v2?.yesterday_summary || detail.summary}
          </p>
        </div>
      )}

      {v2?.main_insight?.text && (
        <div>
          <div className="text-[13.5px] font-semibold">
            {t("lessons.main_insight")}
          </div>
          <div
            className="mt-1.5 rounded-lg px-3 py-2"
            style={{
              borderLeft: "3px solid var(--accent)",
              background: "var(--faint)",
            }}
          >
            {v2.main_insight.title && (
              <div
                className="text-[13.5px] font-semibold"
                style={{ color: "var(--text)" }}
              >
                {v2.main_insight.title}
              </div>
            )}
            <div
              className="text-[13px] mt-0.5"
              style={{ color: "var(--muted)", lineHeight: 1.55 }}
            >
              {v2.main_insight.text}
            </div>
          </div>
        </div>
      )}

      {(v2?.highlights ?? detail.highlights ?? []).length > 0 && (
        <div>
          <div className="text-[13.5px] font-semibold">
            {t("lessons.what_worked")}
          </div>
          <div className="mt-1.5 flex flex-col gap-2">
            {(v2?.highlights ?? detail.highlights).map((hl, k) => (
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

      {v2 && v2.blockers?.length > 0 && (
        <div>
          <div className="text-[13.5px] font-semibold">
            {t("lessons.what_blocked")}
          </div>
          <div className="mt-1.5 flex flex-col gap-3">
            {v2.blockers.map((b, k) => (
              <div key={k}>
                <div
                  className="text-[13.5px] font-semibold"
                  style={{ color: "var(--text)" }}
                >
                  {b.title}
                </div>
                {b.why && (
                  <div
                    className="text-[13px] mt-0.5"
                    style={{ color: "var(--muted)", lineHeight: 1.55 }}
                  >
                    {b.why}
                  </div>
                )}
                {b.example && (
                  <div
                    className="mt-1.5 rounded-lg px-3 py-2 text-[12.5px]"
                    style={{
                      background: "var(--faint)",
                      fontStyle: "italic",
                      color: "var(--text)",
                      whiteSpace: "pre-line",
                    }}
                  >
                    «{b.example}»
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {v2 && v2.practice_today?.length > 0 && (
        <div>
          <div className="text-[13.5px] font-semibold">
            {t("lessons.practice_today")}
          </div>
          <div className="mt-1.5 flex flex-col gap-3">
            {v2.practice_today.map((s, k) => (
              <div key={k}>
                <div
                  className="text-[13.5px] font-semibold"
                  style={{ color: "var(--text)" }}
                >
                  {s.step}
                </div>
                {s.when && (
                  <div
                    className="text-[11.5px] uppercase tracking-wider mt-0.5"
                    style={{ color: "var(--accent)" }}
                  >
                    {s.when}
                  </div>
                )}
                {s.how && (
                  <div
                    className="text-[13px] mt-0.5 italic"
                    style={{ color: "var(--muted)", lineHeight: 1.55 }}
                  >
                    {s.how}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!v2 && detail.tips?.length > 0 && (
        <div>
          <div className="text-[13.5px] font-semibold">
            {t("lessons.what_improve")}
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

      {v2?.closing_line && (
        <div
          className="text-center text-[13px] italic"
          style={{ color: "var(--muted)" }}
        >
          {v2.closing_line}
        </div>
      )}
    </div>
  );
}
