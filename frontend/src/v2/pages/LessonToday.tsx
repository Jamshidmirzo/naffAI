import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Check, CheckCircle2, Circle, MessageSquareQuote, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import {
  lessonContentV2,
  useLessonFeedback,
  useTodayLesson,
  useTrainingList,
  type DailyLessonData,
  type LessonFeedback,
  type LessonPracticeStep,
} from "../api/personal";

/** «Урок дня» / «История разборов» / «Курсы» — one section, three tabs. */
function LearnTabs() {
  const t = useT2();
  const tabs: Array<[string, string]> = [
    ["/lessons/today", "v2.personal.learn.tabToday"],
    ["/lessons/history", "v2.personal.learn.tabHistory"],
    ["/training", "v2.personal.learn.tabCourses"],
  ];
  return (
    <nav className="seg" aria-label={t("v2.personal.learn.title")}>
      {tabs.map(([to, key]) => (
        <NavLink key={to} to={to} end className={({ isActive }) => (isActive ? "is-on" : undefined)}>
          {t(key)}
        </NavLink>
      ))}
    </nav>
  );
}

function fmtLessonDate(iso: string, lang: "ru" | "uz") {
  const [y, m, d] = iso.split("-").map(Number);
  const date = y && m && d ? new Date(y, m - 1, d) : new Date(iso);
  try {
    return date.toLocaleDateString(lang === "uz" ? "uz-UZ" : "ru-RU", { day: "numeric", month: "long" });
  } catch {
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }
}

function httpStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

export default function LessonToday() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const q = useTodayLesson();
  const lesson = q.data;

  const header = (
    <PageHeader title={t("v2.personal.learn.title")} meta={<LearnTabs />}>
      <span className="s c3">
        {lesson ? t("v2.personal.lesson.forDate", { date: fmtLessonDate(lesson.lesson_date, lesson.language || lang) }) : t("v2.personal.lesson.meta")}
      </span>
    </PageHeader>
  );

  if (q.isLoading) {
    return (
      <>
        {header}
        <main className="page"><section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section></main>
      </>
    );
  }

  if (q.error || !lesson) {
    const st = httpStatus(q.error);
    // 404 = no lesson (no activity yesterday), 400 = account not linked to an operator.
    const notReady = !q.error || st === 404 || st === 400;
    return (
      <>
        {header}
        <main className="page">
          <div className="split">
            <section className="list card" style={{ overflow: "hidden" }}>
              {notReady ? (
                <>
                  <EmptyState
                    title={t("v2.personal.lesson.notReadyTitle")}
                    body={t("v2.personal.lesson.notReadyBody")}
                    action={<Link className="btn btn-ghost btn-sm" to="/lessons/history">{t("v2.personal.learn.tabHistory")}</Link>}
                  />
                </>
              ) : (
                <ErrorState error={q.error} title={t("v2.personal.lesson.errorTitle")} onRetry={() => q.refetch()} />
              )}
            </section>
            <CoursesAside />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <main className="page">
        <div className="split">
          <LessonBody lesson={lesson} />
          <aside className="panel col g16">
            <FeedbackCard initial={lesson.feedback ?? null} />
            <CoursesCard />
          </aside>
        </div>
      </main>
    </>
  );
}

function LessonBody({ lesson }: { lesson: DailyLessonData }) {
  const t = useT2();
  const v2 = lessonContentV2(lesson.content);
  const stats = lesson.stats_snapshot || ({} as DailyLessonData["stats_snapshot"]);
  const dialogs = stats.dialogs_count || 0;
  const sales = stats.sales_count || 0;
  const conversion = dialogs > 0 ? Math.round((sales / dialogs) * 100) : 0;
  const focus = v2?.micro_lesson || lesson.micro_lesson;
  const summary = v2?.yesterday_summary || lesson.summary;
  const highlights = v2?.highlights ?? lesson.highlights ?? [];
  const blockers = v2?.blockers ?? [];

  return (
    <div className="list col g16">
      {focus ? (
        <section className="card col g8" style={{ padding: "20px 24px", background: "var(--brand-soft)", borderColor: "transparent" }}>
          <span className="lbl" style={{ color: "var(--brand-text)" }}>{t("lessons.focus_day")}</span>
          <p className="h2">{focus}</p>
        </section>
      ) : null}

      <section className="card row g24 wrap" style={{ padding: "18px 24px" }}>
        <div className="col g4"><span className="lbl">{t("v2.personal.lesson.kpiDialogs")}</span><span className="kpi">{dialogs}</span></div>
        <div className="col g4"><span className="lbl">{t("lessons.stat_sales")}</span><span className="kpi">{sales}</span></div>
        <div className="col g4"><span className="lbl">{t("lessons.stat_conversion")}</span><span className="kpi">{conversion}%</span></div>
        {v2?.main_insight?.text ? (
          <div className="col g4 grow" style={{ minWidth: 220 }}>
            <span className="lbl">{t("v2.personal.lesson.main")}</span>
            {v2.main_insight.title ? <span className="s w6">{v2.main_insight.title}</span> : null}
            <p className="s c2">{v2.main_insight.text}</p>
          </div>
        ) : null}
      </section>

      {v2?.greeting_line || summary ? (
        <section className="card col g8" style={{ padding: "18px 24px" }}>
          <span className="h3">{t("lessons.yesterday_title")}</span>
          {v2?.greeting_line ? <p className="s c2">{v2.greeting_line}</p> : null}
          {summary ? <p className="s c2" style={{ lineHeight: 1.6 }}>{summary}</p> : null}
        </section>
      ) : null}

      {highlights.length > 0 || blockers.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {highlights.length > 0 ? (
            <section className="card col">
              <div className="card-h"><span className="h3">{t("lessons.what_worked")}</span><span className="badge b-ok">{highlights.length}</span></div>
              <div className="col" style={{ padding: "14px 20px 18px", gap: 10 }}>
                {highlights.map((h, i) => (
                  <div key={i} className="row g8 s" style={{ alignItems: "flex-start" }}>
                    <Check className="ic c-ok" style={{ flex: "none", marginTop: 1 }} />
                    <span className="col g4">
                      <span className="w6">{h.title}</span>
                      {h.evidence ? <span className="c2">{h.evidence}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {blockers.length > 0 ? (
            <section className="card col">
              <div className="card-h"><span className="h3">{t("lessons.what_blocked")}</span><span className="badge b-bad">{blockers.length}</span></div>
              <div className="col" style={{ padding: "14px 20px 18px", gap: 12 }}>
                {blockers.map((b, i) => (
                  <div key={i} className="row g8 s" style={{ alignItems: "flex-start" }}>
                    <X className="ic c-bad" style={{ flex: "none", marginTop: 1 }} />
                    <span className="col g4 grow" style={{ minWidth: 0 }}>
                      <span className="w6">{b.title}</span>
                      {b.why ? <span className="c2">{b.why}</span> : null}
                      {b.example ? (
                        <span className="well row g8" style={{ alignItems: "flex-start", padding: "8px 10px" }}>
                          <MessageSquareQuote className="ic ic-s c3" style={{ flex: "none", marginTop: 2 }} />
                          <span style={{ fontStyle: "italic", whiteSpace: "pre-line" }}>{b.example}</span>
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {v2 && v2.practice_today?.length > 0 ? (
        <section className="card col">
          <div className="card-h"><span className="h3">{t("lessons.practice_today")}</span></div>
          <PracticeChecklist steps={v2.practice_today} lessonId={lesson.id} />
        </section>
      ) : null}

      {!v2 && lesson.tips?.length > 0 ? (
        <section className="card col">
          <div className="card-h"><span className="h3">{t("lessons.plan_today")}</span></div>
          <ol className="col" style={{ margin: 0, padding: "14px 20px 18px 40px", gap: 10 }}>
            {lesson.tips.map((tip, i) => (
              <li key={i} className="s">
                <span className="w6">{tip.action || tip.title}</span>
                {tip.example ? <div className="well s" style={{ marginTop: 6, padding: "8px 10px", fontStyle: "italic" }}>«{tip.example}»</div> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {v2?.closing_line ? <p className="s c3" style={{ textAlign: "center", fontStyle: "italic", padding: "4px 12px" }}>{v2.closing_line}</p> : null}
    </div>
  );
}

/** Same localStorage key as the old page, so ticks survive switching designs. */
function PracticeChecklist({ steps, lessonId }: { steps: LessonPracticeStep[]; lessonId: number }) {
  const t = useT2();
  const storageKey = `naffai_practice_done_${lessonId}`;
  const [done, setDone] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? new Set(JSON.parse(raw) as number[]) : new Set();
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
    <div className="col">
      {steps.map((s, i) => {
        const on = done.has(i);
        return (
          <button
            key={i}
            type="button"
            className="li"
            aria-pressed={on}
            aria-label={`${t("v2.personal.lesson.stepDone")}: ${s.step}`}
            onClick={() => toggle(i)}
            style={{ width: "100%", textAlign: "left", background: on ? "var(--ok-bg)" : "none", borderTop: 0, borderLeft: 0, borderRight: 0, alignItems: "flex-start", padding: "12px 20px" }}
          >
            {on ? <CheckCircle2 className="ic c-ok" style={{ flex: "none", marginTop: 1 }} /> : <Circle className="ic c3" style={{ flex: "none", marginTop: 1 }} />}
            <span className="col g4 grow" style={{ minWidth: 0 }}>
              <span className="s w6" style={{ textDecoration: on ? "line-through" : "none", opacity: on ? 0.7 : 1 }}>
                <span className="num c3">{i + 1}.</span> {s.step}
              </span>
              {s.when ? <span className="xs w6" style={{ color: "var(--brand-text)" }}>{s.when}</span> : null}
              {s.how ? <span className="s c3" style={{ fontStyle: "italic" }}>{s.how}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const REASONS = ["v2.personal.lesson.reasonGeneric", "v2.personal.lesson.reasonNotMine", "v2.personal.lesson.reasonLong"];

function FeedbackCard({ initial }: { initial: LessonFeedback | null }) {
  const t = useT2();
  const [rating, setRating] = useState<LessonFeedback["rating"] | null>(initial?.rating ?? null);
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [reasons, setReasons] = useState<string[]>([]);
  useEffect(() => setRating(initial?.rating ?? null), [initial?.rating]);

  const submit = useLessonFeedback();
  const send = (r: LessonFeedback["rating"], text?: string) =>
    submit.mutate(
      text !== undefined ? { rating: r, comment: text } : { rating: r },
      {
        onSuccess: () => {
          setRating(r);
          setOpen(false);
          toast.success(t("lessons.feedback_saved"));
        },
        onError: () => toast.error(t("common.error")),
      },
    );

  const closeModal = () => {
    // cancel leaves the previous rating as it was — «Не помог» does not stay pressed
    setOpen(false);
    setReasons([]);
  };
  const sendNotHelpful = () => {
    const prefix = reasons.map((k) => t(k)).join("; ");
    const text = [prefix, comment.trim()].filter(Boolean).join(". ");
    send("not_helpful", text);
  };

  return (
    <section className="card col g12" style={{ padding: 20 }}>
      <span className="h3">{t("lessons.feedback_title")}</span>
      <div className="row g8">
        <button
          type="button"
          className={cx("btn grow", rating === "helpful" && "btn-ok")}
          aria-pressed={rating === "helpful"}
          disabled={submit.isPending}
          onClick={() => send("helpful")}
        >
          <ThumbsUp className="ic" />
          {t("lessons.feedback_helpful")}
        </button>
        <button
          type="button"
          className={cx("btn grow", rating === "not_helpful" && "btn-bad")}
          aria-pressed={rating === "not_helpful"}
          disabled={submit.isPending}
          onClick={() => setOpen(true)}
        >
          <ThumbsDown className="ic" />
          {t("lessons.feedback_not_helpful")}
        </button>
      </div>
      <span className="xs c3">{t("v2.personal.lesson.feedbackNote")}</span>

      <Dialog
        open={open}
        onClose={closeModal}
        title={t("lessons.feedback_modal_title")}
        sub={t("v2.personal.lesson.modalSub")}
        footer={
          <>
            <button className="btn" type="button" onClick={closeModal}>{t("common.cancel")}</button>
            <button className="btn btn-pri" type="button" disabled={submit.isPending} onClick={sendNotHelpful}>
              {submit.isPending ? "…" : t("v2.personal.lesson.send")}
            </button>
          </>
        }
      >
        <div className="row g6 wrap">
          {REASONS.map((k) => {
            const on = reasons.includes(k);
            return (
              <button
                key={k}
                type="button"
                className={cx("chip", on && "is-on")}
                aria-pressed={on}
                onClick={() => setReasons((prev) => (on ? prev.filter((x) => x !== k) : [...prev, k]))}
              >
                {t(k)}
              </button>
            );
          })}
        </div>
        <textarea
          className="input"
          rows={3}
          aria-label={t("lessons.feedback_modal_title")}
          placeholder={t("lessons.feedback_comment_ph")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ minHeight: 96, resize: "vertical", paddingTop: 8 }}
        />
      </Dialog>
    </section>
  );
}

/** Courses next to the «not ready» state — only when there are courses to show. */
function CoursesAside() {
  const q = useTrainingList();
  if (!q.data?.length) return null;
  return <aside className="panel col g16"><CoursesCard /></aside>;
}

function CoursesCard() {
  const t = useT2();
  const q = useTrainingList();
  const rows = q.data ?? [];
  if (q.isError || (!q.isLoading && rows.length === 0)) return null;
  const done = rows.filter((r) => r.attempt_completed).length;
  return (
    <section className="card col">
      <div className="card-h">
        <span className="h3">{t("v2.personal.learn.tabCourses")}</span>
        {q.data ? <span className="xs c3">{t("v2.personal.lesson.coursesDone", { n: done, total: rows.length })}</span> : null}
      </div>
      {q.isLoading ? (
        <LoadingBlock rows={3} />
      ) : (
        <>
          {rows.slice(0, 5).map((c) => {
            const meta = [
              c.has_video ? t("training.video") : null,
              c.has_file ? t("training.file") : null,
              c.questions_count > 0 ? t("training.q_n", { n: c.questions_count }) : null,
            ].filter(Boolean).join(" · ");
            return (
              <Link key={c.id} className="li" to={`/training/${c.id}`}>
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="s w6 trunc">{c.title}</span>
                  {meta ? <span className="xs c3">{meta}</span> : null}
                </span>
                {c.attempt_completed ? (
                  <span className="badge b-ok">{c.score_pct != null ? t("v2.personal.training.passedScore", { n: c.score_pct }) : t("v2.personal.training.passed")}</span>
                ) : (
                  <span className="badge">{t("v2.personal.training.notPassed")}</span>
                )}
              </Link>
            );
          })}
          {rows.length > 5 ? <Link className="li s w6" to="/training" style={{ color: "var(--brand-text)" }}>{t("v2.personal.lesson.allCourses")}</Link> : null}
        </>
      )}
    </section>
  );
}
