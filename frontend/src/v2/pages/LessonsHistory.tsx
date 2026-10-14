import { useEffect, useState } from "react";
import { Link, NavLink, useSearchParams } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import { lessonContentV2, useLessonDetail, useLessonsHistory, type DailyLessonData } from "../api/personal";

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

function httpStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

function parseDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date(iso);
}
function loc(lang: string) {
  return lang === "uz" ? "uz-UZ" : "ru-RU";
}
function fmtShort(iso: string) {
  const d = parseDay(iso);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function fmtWeekday(iso: string, lang: string) {
  try {
    return parseDay(iso).toLocaleDateString(loc(lang), { weekday: "long" });
  } catch {
    return "";
  }
}
function fmtLong(iso: string, lang: string) {
  try {
    return parseDay(iso).toLocaleDateString(loc(lang), { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function LessonsHistory() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const [searchParams] = useSearchParams();
  // managers come here from the operator card with ?operator=<id>
  const operatorId = searchParams.get("operator") || "";
  const q = useLessonsHistory(operatorId);
  const rows = q.data ?? [];
  const [sel, setSel] = useState<string | null>(null);

  // pick the newest analysis once the list arrives (detail GET does not mark it read)
  useEffect(() => {
    if (!sel && rows.length) setSel(rows[0].lesson_date);
  }, [rows, sel]);

  const unread = rows.filter((r) => !r.opened_at).length;
  const meta = q.data
    ? unread
      ? t("v2.personal.history.meta", { n: rows.length, u: unread })
      : t("v2.personal.history.metaAllRead", { n: rows.length })
    : undefined;

  return (
    <>
      <PageHeader
        title={operatorId ? t("lessons.history_analyses_title") : t("v2.personal.learn.title")}
        meta={!operatorId ? <LearnTabs /> : undefined}
        back={operatorId ? `/operators/${operatorId}` : undefined}
      >
        {meta ? <span className="s c3">{meta}</span> : null}
      </PageHeader>
      <main className="page">
        {q.isLoading ? (
          <section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section>
        ) : q.isError && httpStatus(q.error) !== 400 ? (
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        ) : rows.length === 0 ? (
          <section className="card">
            <EmptyState
              icon={<BookOpen className="ic ic-l" />}
              title={t("lessons.history_empty")}
              body={t("v2.personal.history.emptyBody")}
              action={!operatorId ? <Link className="btn btn-pri" to="/lessons/today">{t("lessons.today_analysis_btn")}</Link> : undefined}
            />
          </section>
        ) : (
          <div className="split">
            <section className="list card col" style={{ overflow: "hidden" }}>
              {rows.map((r) => {
                const on = sel === r.lesson_date;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={cx("row-item", on && "is-sel")}
                    aria-pressed={on}
                    onClick={() => setSel(r.lesson_date)}
                    style={{ width: "100%", textAlign: "left", background: on ? undefined : "none", borderLeft: 0, borderRight: 0, borderTop: 0 }}
                  >
                    <span className="col" style={{ width: 110, flex: "none" }}>
                      <span className="s w6 num">{fmtShort(r.lesson_date)}</span>
                      <span className="xs c3">{fmtWeekday(r.lesson_date, r.language ?? lang)}</span>
                    </span>
                    <span className="s grow trunc">{r.micro_lesson || r.summary}</span>
                    {!r.opened_at ? <span className="badge b-info">{t("v2.personal.history.unread")}</span> : null}
                  </button>
                );
              })}
            </section>
            <aside className="panel card col" style={{ position: "sticky", top: 16 }}>
              {sel ? <DetailPanel operatorId={operatorId} date={sel} /> : <EmptyState title={t("v2.personal.history.pick")} />}
            </aside>
          </div>
        )}
      </main>
    </>
  );
}

function DetailPanel({ operatorId, date }: { operatorId: string; date: string }) {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const q = useLessonDetail(operatorId, date);
  if (q.isLoading) return <LoadingBlock rows={4} onRetry={() => q.refetch()} />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return <DetailBody d={d} title={t("v2.personal.history.forDate", { date: fmtLong(d.lesson_date, d.language || lang) })} />;
}

function DetailBody({ d, title }: { d: DailyLessonData; title: string }) {
  const t = useT2();
  const v2 = lessonContentV2(d.content);
  const focus = v2?.micro_lesson || d.micro_lesson;
  const summary = v2?.yesterday_summary || d.summary;
  const highlights = v2?.highlights ?? d.highlights ?? [];
  const s = d.stats_snapshot;
  return (
    <>
      <div className="card-h">
        <div className="col g4" style={{ minWidth: 0 }}>
          <span className="lbl">{title}</span>
          {focus ? <span className="h3">{focus}</span> : null}
        </div>
      </div>
      <div className="row g24" style={{ padding: "16px 20px" }}>
        <div className="col g4"><span className="lbl">{t("lessons.stat_sales")}</span><span className="kpi" style={{ fontSize: 22 }}>{s?.sales_count || 0}</span></div>
        <div className="col g4"><span className="lbl">{t("lessons.stat_dialogs")}</span><span className="kpi" style={{ fontSize: 22 }}>{s?.dialogs_count || 0}</span></div>
        <div className="col g4"><span className="lbl">{t("lessons.stat_quality")}</span><span className="kpi" style={{ fontSize: 22 }}>{Math.round(s?.avg_quality || 0)}</span></div>
      </div>
      <hr className="hr" />
      <div className="col g16" style={{ padding: "16px 20px 20px" }}>
        {summary ? (
          <Block label={t("lessons.yesterday_title")}><p className="s c2">{summary}</p></Block>
        ) : null}
        {v2?.main_insight?.text ? (
          <Block label={t("lessons.main_insight")}>
            {v2.main_insight.title ? <span className="s w6">{v2.main_insight.title}</span> : null}
            <p className="s">{v2.main_insight.text}</p>
          </Block>
        ) : null}
        {highlights.length > 0 ? (
          <Block label={t("lessons.what_worked")}>
            {highlights.map((h, k) => (
              <p key={k} className="s c2"><span className="w6" style={{ color: "var(--ink)" }}>{h.title}.</span> {h.evidence}</p>
            ))}
          </Block>
        ) : null}
        {v2 && v2.blockers?.length > 0 ? (
          <Block label={t("lessons.what_blocked")}>
            {v2.blockers.map((b, k) => (
              <div key={k} className="col g4">
                <span className="s w6">{b.title}</span>
                {b.why ? <span className="s c2">{b.why}</span> : null}
                {b.example ? <span className="well s" style={{ padding: "8px 10px", fontStyle: "italic", whiteSpace: "pre-line" }}>«{b.example}»</span> : null}
              </div>
            ))}
          </Block>
        ) : null}
        {v2 && v2.practice_today?.length > 0 ? (
          <Block label={t("lessons.practice_today")}>
            {v2.practice_today.map((p, k) => (
              <div key={k} className="col g4">
                <span className="s w6"><span className="num c3">{k + 1}.</span> {p.step}</span>
                {p.when ? <span className="xs w6" style={{ color: "var(--brand-text)" }}>{p.when}</span> : null}
                {p.how ? <span className="s c3" style={{ fontStyle: "italic" }}>{p.how}</span> : null}
              </div>
            ))}
          </Block>
        ) : null}
        {!v2 && d.tips?.length > 0 ? (
          <Block label={t("lessons.what_improve")}>
            {d.tips.map((tip, k) => (
              <div key={k} className="col g4">
                <span className="s w6">{tip.title}</span>
                {tip.why ? <span className="s c2">{tip.why}</span> : null}
                {tip.example ? <span className="well s" style={{ padding: "8px 10px", fontStyle: "italic" }}>«{tip.example}»</span> : null}
                {tip.action ? <span className="s w6" style={{ color: "var(--brand-text)" }}>→ {tip.action}</span> : null}
              </div>
            ))}
          </Block>
        ) : null}
        {v2?.closing_line ? <p className="s c3" style={{ textAlign: "center", fontStyle: "italic" }}>{v2.closing_line}</p> : null}
      </div>
    </>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="col g8">
      <span className="lbl">{label}</span>
      {children}
    </div>
  );
}
