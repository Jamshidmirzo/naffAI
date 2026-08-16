import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  BarChart3,
  CheckCircle2,
  Circle,
  Lightbulb,
  MessageSquareQuote,
  Sparkles,
  Target,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
} from "lucide-react";
import { api } from "../lib/api";
import { Button, Eyebrow, Modal, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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

// Legacy v1 shape — still used to render lessons generated before the v2
// prompt rollout. We only fall back to it when `content` is empty.
interface LegacyTip { title: string; why: string; example: string; action: string }

interface LessonFeedback {
  id: number;
  rating: "helpful" | "not_helpful";
  comment: string;
}

interface DailyLessonData {
  id: number;
  lesson_date: string;
  language: "ru" | "uz";
  content: LessonContentV2 | Record<string, never>;
  summary: string;
  highlights: Highlight[];
  tips: LegacyTip[];
  micro_lesson: string;
  opened_at?: string | null;
  feedback: LessonFeedback | null;
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtDate(iso: string, language: "ru" | "uz") {
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
  return !!c && typeof c === "object" && "yesterday_summary" in c;
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function DailyLesson() {
  const t = useT();
  usePageHeader({
    title: t("lessons.today_page_title"),
    subtitle: t("lessons.today_page_subtitle"),
  });

  const qc = useQueryClient();
  const { data: lesson, isLoading, error } = useQuery<DailyLessonData>({
    queryKey: ["lessons", "today"],
    queryFn: () => api.get<DailyLessonData>("/lessons/today/").then((r) => r.data),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[760px] py-16 text-center text-muted text-[14px]">
        {t("lessons.loading_lesson")}
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
            {t("lessons.not_ready_title")}
          </div>
          <div className="text-[13.5px] text-muted max-w-md mx-auto">
            {t("lessons.not_ready_body")}
          </div>
          <div className="mt-6">
            <Link
              to="/lessons/history"
              className="text-[13px] font-semibold"
              style={{ color: "var(--accent)" }}
            >
              {t("lessons.my_history_link")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const v2 = isContentV2(lesson.content) ? lesson.content : null;
  const stats = lesson.stats_snapshot || ({} as DailyLessonData["stats_snapshot"]);
  const conversion =
    stats.dialogs_count > 0
      ? Math.round(((stats.sales_count || 0) / stats.dialogs_count) * 100)
      : 0;

  return (
    <div className="mx-auto max-w-[760px] flex flex-col gap-5">
      {/* Sticky top: micro_lesson aphorism */}
      {(v2?.micro_lesson || lesson.micro_lesson) && (
        <section
          className="nf-card animate-nfFadeUp"
          style={{
            borderRadius: 22,
            padding: "22px 24px",
            borderLeft: "4px solid var(--accent)",
            background: "linear-gradient(135deg, rgba(242,86,11,.06), rgba(242,86,11,.02))",
          }}
        >
          <Eyebrow>{t("lessons.focus_day")}</Eyebrow>
          <div
            className="mt-2 font-semibold"
            style={{ fontSize: 18, lineHeight: 1.4, letterSpacing: "-0.01em" }}
          >
            {v2?.micro_lesson || lesson.micro_lesson}
          </div>
        </section>
      )}

      {/* Header card: date + greeting + KPIs */}
      <section
        className="nf-card animate-nfFadeUp"
        style={{ borderRadius: 26, padding: "30px 32px" }}
      >
        <Eyebrow>{t("lessons.eyebrow")}</Eyebrow>
        <h1
          className="font-semibold mt-3"
          style={{ fontSize: 28, letterSpacing: "-0.03em", lineHeight: 1.15 }}
        >
          {fmtDate(lesson.lesson_date, lesson.language)}
        </h1>
        {v2?.greeting_line && (
          <p
            className="mt-2 text-[15px]"
            style={{ color: "var(--muted)", lineHeight: 1.5 }}
          >
            {v2.greeting_line}
          </p>
        )}

        <div className="grid grid-cols-3 gap-3 mt-6">
          <StatTile label={t("lessons.stat_dialogs")} value={stats.dialogs_count || 0} />
          <StatTile label={t("lessons.stat_sales")} value={stats.sales_count || 0} />
          <StatTile label={t("lessons.stat_conversion")} value={`${conversion}%`} />
        </div>
      </section>

      {/* Yesterday summary */}
      {(v2?.yesterday_summary || lesson.summary) && (
        <Section
          icon={<BarChart3 className="w-4 h-4" />}
          title={t("lessons.yesterday_title")}
        >
          <p
            className="text-[14.5px]"
            style={{ color: "var(--muted)", lineHeight: 1.6 }}
          >
            {v2?.yesterday_summary || lesson.summary}
          </p>
        </Section>
      )}

      {/* Main insight */}
      {v2?.main_insight?.text && (
        <Section
          icon={<Lightbulb className="w-4 h-4" />}
          title={t("lessons.main_insight")}
        >
          <div
            className="rounded-xl px-4 py-3"
            style={{
              borderLeft: "3px solid var(--accent)",
              background: "var(--faint)",
            }}
          >
            {v2.main_insight.title && (
              <div
                className="font-semibold text-[14.5px] mb-1"
                style={{ color: "var(--text)" }}
              >
                {v2.main_insight.title}
              </div>
            )}
            <div
              className="text-[14px]"
              style={{ color: "var(--muted)", lineHeight: 1.55 }}
            >
              {v2.main_insight.text}
            </div>
          </div>
        </Section>
      )}

      {/* Highlights */}
      {(v2?.highlights ?? lesson.highlights ?? []).length > 0 && (
        <Section
          icon={<Sparkles className="w-4 h-4" />}
          title={t("lessons.what_worked")}
        >
          <div className="flex flex-col gap-2.5">
            {(v2?.highlights ?? lesson.highlights).map((hl, i) => (
              <HighlightCard key={i} hl={hl} />
            ))}
          </div>
        </Section>
      )}

      {/* Blockers with example quotes */}
      {v2 && v2.blockers?.length > 0 && (
        <Section
          icon={<TriangleAlert className="w-4 h-4" />}
          title={t("lessons.what_blocked")}
        >
          <div className="flex flex-col gap-3">
            {v2.blockers.map((b, i) => <BlockerCard key={i} b={b} />)}
          </div>
        </Section>
      )}

      {/* Practice today — checklist */}
      {v2 && v2.practice_today?.length > 0 && (
        <Section
          icon={<Target className="w-4 h-4" />}
          title={t("lessons.practice_today")}
        >
          <PracticeChecklist steps={v2.practice_today} lessonId={lesson.id} />
        </Section>
      )}

      {/* Legacy tips (only for pre-v2 lessons where content is empty) */}
      {!v2 && lesson.tips?.length > 0 && (
        <Section
          icon={<Target className="w-4 h-4" />}
          title={t("lessons.plan_today")}
        >
          <div className="flex flex-col gap-3">
            {lesson.tips.map((tip, i) => (
              <div key={i}>
                <div className="text-[14px]">
                  <span className="font-semibold">{tip.action || tip.title}</span>
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
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Closing line */}
      {v2?.closing_line && (
        <div
          className="text-center text-[14px] italic"
          style={{ color: "var(--muted)", padding: "8px 12px" }}
        >
          {v2.closing_line}
        </div>
      )}

      {/* Feedback + history footer */}
      <FeedbackBlock
        lessonId={lesson.id}
        initial={lesson.feedback}
        onSaved={() =>
          qc.invalidateQueries({ queryKey: ["lessons", "today"] })
        }
      />

      <div className="flex items-center justify-between gap-3">
        <Link
          to="/lessons/history"
          className="text-[13px] font-medium text-muted hover:text-text transition"
        >
          {t("lessons.history_link")}
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="nf-card animate-nfFadeUp"
      style={{ borderRadius: 22, padding: "22px 24px" }}
    >
      <div
        className="flex items-center gap-2 mb-3"
        style={{ color: "var(--text)" }}
      >
        <div style={{ color: "var(--accent)" }}>{icon}</div>
        <div className="text-[14.5px] font-semibold">{title}</div>
      </div>
      {children}
    </section>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="nf-tile" style={{ padding: "14px 16px" }}>
      <div className="text-[11px] text-muted uppercase tracking-wider font-medium">
        {label}
      </div>
      <div
        className="mt-1 font-semibold tabular-nums"
        style={{ fontSize: 24, letterSpacing: "-0.03em" }}
      >
        {value}
      </div>
    </div>
  );
}

function HighlightCard({ hl }: { hl: Highlight }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{
        background: "var(--faint)",
        borderLeft: "3px solid rgba(60,180,110,.6)",
      }}
    >
      <div className="font-semibold text-[14px]" style={{ color: "var(--text)" }}>
        {hl.title}
      </div>
      {hl.evidence && (
        <div
          className="mt-1 text-[13.5px]"
          style={{ color: "var(--muted)", lineHeight: 1.5 }}
        >
          {hl.evidence}
        </div>
      )}
    </div>
  );
}

function BlockerCard({ b }: { b: Blocker }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{
        background: "var(--faint)",
        borderLeft: "3px solid rgba(220,120,60,.6)",
      }}
    >
      <div className="font-semibold text-[14px]" style={{ color: "var(--text)" }}>
        {b.title}
      </div>
      {b.why && (
        <div
          className="mt-1 text-[13.5px]"
          style={{ color: "var(--muted)", lineHeight: 1.5 }}
        >
          {b.why}
        </div>
      )}
      {b.example && (
        <div
          className="mt-2 rounded-lg px-3 py-2 flex gap-2 items-start"
          style={{
            background: "var(--bg)",
            border: "1px dashed var(--border)",
          }}
        >
          <MessageSquareQuote className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted" />
          <div
            className="text-[12.5px] italic whitespace-pre-line"
            style={{ color: "var(--text)", lineHeight: 1.5 }}
          >
            {b.example}
          </div>
        </div>
      )}
    </div>
  );
}

function PracticeChecklist({
  steps,
  lessonId,
}: {
  steps: PracticeStep[];
  lessonId: number;
}) {
  const storageKey = `naffai_practice_done_${lessonId}`;
  const [done, setDone] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as number[]);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...done]));
    } catch {
      /* ignore quota errors */
    }
  }, [storageKey, done]);

  const toggle = (i: number) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      {steps.map((s, i) => {
        const isDone = done.has(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            className="text-left rounded-xl px-4 py-3 transition flex gap-3 items-start"
            style={{
              background: isDone ? "rgba(60,180,110,.08)" : "var(--faint)",
              border: `1px solid ${isDone ? "rgba(60,180,110,.35)" : "var(--border)"}`,
            }}
          >
            <div className="mt-0.5 shrink-0">
              {isDone ? (
                <CheckCircle2
                  className="w-5 h-5"
                  style={{ color: "rgb(60,180,110)" }}
                />
              ) : (
                <Circle className="w-5 h-5 text-muted" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="font-semibold text-[14px]"
                style={{
                  color: "var(--text)",
                  textDecoration: isDone ? "line-through" : "none",
                  opacity: isDone ? 0.7 : 1,
                }}
              >
                {s.step}
              </div>
              {s.when && (
                <div
                  className="mt-1 text-[12px] uppercase tracking-wider font-medium"
                  style={{ color: "var(--accent)" }}
                >
                  {s.when}
                </div>
              )}
              {s.how && (
                <div
                  className="mt-1 text-[13px] italic"
                  style={{ color: "var(--muted)", lineHeight: 1.5 }}
                >
                  {s.how}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function FeedbackBlock({
  lessonId,
  initial,
  onSaved,
}: {
  lessonId: number;
  initial: LessonFeedback | null;
  onSaved: () => void;
}) {
  const t = useT();
  const [rating, setRating] = useState<LessonFeedback["rating"] | null>(
    initial?.rating ?? null,
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [comment, setComment] = useState(initial?.comment ?? "");

  const submit = useMutation({
    mutationFn: (payload: { rating: "helpful" | "not_helpful"; comment?: string }) =>
      api.post("/lessons/today/feedback/", payload),
    onSuccess: () => {
      toast.success(t("lessons.feedback_saved"));
      setModalOpen(false);
      onSaved();
    },
    onError: () => toast.error(t("common.error")),
  });

  const openModalFor = (r: "helpful" | "not_helpful") => {
    setRating(r);
    setModalOpen(true);
  };

  const submitInline = (r: "helpful" | "not_helpful") => {
    setRating(r);
    submit.mutate({ rating: r });
  };

  // Guard for `lessonId` unused warning — memoise key by id.
  useMemo(() => lessonId, [lessonId]);

  return (
    <>
      <section
        className="nf-card animate-nfFadeUp"
        style={{ borderRadius: 22, padding: "18px 22px" }}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[13.5px] font-semibold">
              {t("lessons.feedback_title")}
            </div>
            <div className="text-[12px] text-muted mt-0.5">
              {t("lessons.feedback_hint")}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => submitInline("helpful")}
              disabled={submit.isPending}
              className="nf-btn"
              style={{
                padding: "8px 14px",
                background: rating === "helpful" ? "rgba(60,180,110,.15)" : undefined,
                color: rating === "helpful" ? "rgb(60,180,110)" : undefined,
                borderColor: rating === "helpful" ? "rgba(60,180,110,.4)" : undefined,
              }}
              aria-pressed={rating === "helpful"}
              title={t("lessons.feedback_helpful")}
            >
              <ThumbsUp className="w-4 h-4" />
              <span className="ml-1.5">{t("lessons.feedback_helpful")}</span>
            </button>
            <button
              type="button"
              onClick={() => openModalFor("not_helpful")}
              disabled={submit.isPending}
              className="nf-btn"
              style={{
                padding: "8px 14px",
                background:
                  rating === "not_helpful" ? "rgba(220,60,40,.1)" : undefined,
                color: rating === "not_helpful" ? "var(--danger)" : undefined,
                borderColor:
                  rating === "not_helpful" ? "rgba(220,60,40,.3)" : undefined,
              }}
              aria-pressed={rating === "not_helpful"}
              title={t("lessons.feedback_not_helpful")}
            >
              <ThumbsDown className="w-4 h-4" />
              <span className="ml-1.5">{t("lessons.feedback_not_helpful")}</span>
            </button>
          </div>
        </div>
      </section>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} width={460}>
        <div className="p-6">
          <div className="text-[16px] font-semibold">
            {t("lessons.feedback_modal_title")}
          </div>
          <div className="text-[13px] text-muted mt-1">
            {t("lessons.feedback_modal_hint")}
          </div>
          <textarea
            className="nf-input mt-4 w-full"
            style={{ minHeight: 110, resize: "vertical" }}
            placeholder={t("lessons.feedback_comment_ph")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="mt-5 flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() =>
                rating && submit.mutate({ rating, comment })
              }
              disabled={submit.isPending}
            >
              {submit.isPending ? "…" : t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
