import { Link, NavLink } from "react-router-dom";
import { FileText, GraduationCap, ListChecks, MessageSquare, PlayCircle } from "lucide-react";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "../ui";
import { useTrainingList, type TrainingRow } from "../api/personal";

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

export default function Training() {
  const t = useT2();
  const q = useTrainingList();
  const rows = q.data ?? [];
  const done = rows.filter((r) => r.attempt_completed).length;
  const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;

  return (
    <>
      <PageHeader title={t("v2.personal.learn.title")} meta={<LearnTabs />}>
        {q.data && rows.length ? (
          <>
            <span className="s c3">{t("v2.personal.training.progress", { n: done, total: rows.length })}</span>
            <div className="bar" style={{ width: 140 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <i className="ok" style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : null}
      </PageHeader>
      <main className="page">
        {q.isLoading ? (
          <section className="card"><LoadingBlock rows={5} onRetry={() => q.refetch()} /></section>
        ) : q.isError ? (
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        ) : rows.length === 0 ? (
          <section className="card">
            <EmptyState icon={<GraduationCap className="ic ic-l" />} title={t("training.empty_eyebrow")} body={t("training.empty_hint_operator")} />
          </section>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
            {rows.map((r) => <CourseCard key={r.id} r={r} />)}
          </div>
        )}
      </main>
    </>
  );
}

function CourseCard({ r }: { r: TrainingRow }) {
  const t = useT2();
  const media = r.has_video && r.has_file
    ? "v2.personal.training.mediaVideoFile"
    : r.has_video
      ? "v2.personal.training.mediaVideo"
      : r.has_file
        ? "v2.personal.training.mediaFile"
        : r.questions_count > 0
          ? "v2.personal.training.mediaTest"
          : "v2.personal.training.mediaText";
  const Icon = r.has_video ? PlayCircle : r.has_file ? FileText : ListChecks;
  return (
    <Link className="card col" to={`/training/${r.id}`} style={{ overflow: "hidden" }}>
      <div className="ph" style={{ height: 140, borderRadius: 0, border: 0, borderBottom: "1px solid var(--line)" }}>
        <Icon className="ic ic-xl" />
        {t(media)}
      </div>
      <div className="col g8" style={{ padding: "14px 16px 16px", flex: "1 1 auto" }}>
        <div className="row between g8" style={{ alignItems: "flex-start" }}>
          <span className="h3">{r.title}</span>
          {r.attempt_completed ? (
            <span className="badge b-ok" style={{ flex: "none" }}>
              {r.score_pct != null ? t("v2.personal.training.passedScore", { n: r.score_pct }) : t("v2.personal.training.passed")}
            </span>
          ) : (
            <span className="badge" style={{ flex: "none" }}>{t("v2.personal.training.notPassed")}</span>
          )}
        </div>
        {r.description ? (
          <span
            className="s c2"
            style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
          >
            {r.description}
          </span>
        ) : null}
        <span className="row g12 xs c3 wrap" style={{ marginTop: "auto", paddingTop: 4 }}>
          {r.has_video ? <span className="row g4"><PlayCircle className="ic ic-s" />{t("training.video")}</span> : null}
          {r.has_file ? <span className="row g4"><FileText className="ic ic-s" />{t("training.file")}</span> : null}
          {r.questions_count > 0 ? <span>{t("training.q_n", { n: r.questions_count })}</span> : null}
          {r.comments_count > 0 ? <span className="row g4"><MessageSquare className="ic ic-s" />{r.comments_count}</span> : null}
        </span>
      </div>
    </Link>
  );
}
