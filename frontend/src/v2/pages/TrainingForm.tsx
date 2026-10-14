import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, FileText, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  useTrainingLessonDetail,
  useTrainingLessonSave,
  useTrainingLessonStats,
  type TrainingStats,
} from "../api/team/trainingLive";

interface AnswerDraft {
  key: string;
  text: string;
  is_correct: boolean;
}
interface QuestionDraft {
  key: string;
  text: string;
  answers: AnswerDraft[];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

function emptyQuestion(): QuestionDraft {
  return {
    key: uid(),
    text: "",
    answers: [
      { key: uid(), text: "", is_correct: true },
      { key: uid(), text: "", is_correct: false },
    ],
  };
}

type FormState = {
  title: string;
  description: string;
  videoUrl: string;
  isActive: boolean;
  hasTest: boolean;
  questions: QuestionDraft[];
};

const EMPTY: FormState = { title: "", description: "", videoUrl: "", isActive: true, hasTest: false, questions: [] };

/** Snapshot used to detect unsaved changes (keys are ignored). */
function snapshot(s: FormState, file: File | null, clearFile: boolean) {
  return JSON.stringify({
    t: s.title.trim(),
    d: s.description.trim(),
    v: s.videoUrl.trim(),
    a: s.isActive,
    q: s.hasTest ? s.questions.map((q) => [q.text.trim(), q.answers.map((x) => [x.text.trim(), x.is_correct])]) : [],
    f: file ? file.name + file.size : "",
    c: clearFile,
  });
}

interface Problems {
  title?: string;
  media?: string;
  test?: string;
  /** per question key → message */
  q: Record<string, string>;
  /** answer keys with empty text */
  badAnswers: Set<string>;
  list: string[];
}

export default function TrainingForm() {
  const t = useT2();
  const nav = useNavigate();
  const loc = useLocation();
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = isEdit && searchParams.get("tab") === "stats" ? "stats" : "edit";

  const [form, setForm] = useState<FormState>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [clearFile, setClearFile] = useState(false);
  const [loaded, setLoaded] = useState(!isEdit);
  const [initial, setInitial] = useState(() => snapshot(EMPTY, null, false));
  const [showErrors, setShowErrors] = useState(false);
  const leavingRef = useRef(false);

  const detailQ = useTrainingLessonDetail(id);
  const statsQ = useTrainingLessonStats(id, isEdit);
  const save = useTrainingLessonSave(id);

  useEffect(() => {
    if (isEdit && detailQ.data && !loaded) {
      const d = detailQ.data;
      const qs = d.questions.map((q) => ({
        key: `db-${q.id}`,
        text: q.text,
        answers: q.answers.map((a) => ({ key: `db-${a.id}`, text: a.text, is_correct: a.is_correct })),
      }));
      const next: FormState = {
        title: d.title,
        description: d.description,
        videoUrl: d.video_url,
        isActive: d.is_active,
        hasTest: qs.length > 0,
        questions: qs,
      };
      setForm(next);
      setInitial(snapshot(next, null, false));
      setLoaded(true);
    }
  }, [isEdit, detailQ.data, loaded]);

  const dirty = loaded && snapshot(form, file, clearFile) !== initial;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((p) => ({ ...p, [k]: v }));
  const setQuestions = (fn: (prev: QuestionDraft[]) => QuestionDraft[]) => setForm((p) => ({ ...p, questions: fn(p.questions) }));

  const existingFile = isEdit && detailQ.data?.file_url && !clearFile ? detailQ.data : null;

  /* ── validation (same rules and order as the old page, plus «test on, no questions») ── */
  const problems: Problems = useMemo(() => {
    const p: Problems = { q: {}, badAnswers: new Set(), list: [] };
    if (!form.title.trim()) {
      p.title = t("training.err_title");
      p.list.push(p.title);
    }
    if (!form.videoUrl.trim() && !file && !existingFile) {
      p.media = t("training.err_media");
      p.list.push(p.media);
    }
    if (form.hasTest) {
      if (form.questions.length === 0) {
        p.test = t("v2.team.trainingLive.errNoQuestions");
        p.list.push(p.test);
      }
      form.questions.forEach((q, qi) => {
        let msg = "";
        if (!q.text.trim()) msg = t("training.err_q_text", { n: qi + 1 });
        else if (q.answers.length < 2) msg = t("training.err_q_answers", { n: qi + 1 });
        else if (q.answers.filter((a) => a.is_correct).length !== 1) msg = t("training.err_q_one_correct", { n: qi + 1 });
        q.answers.forEach((a, ai) => {
          if (!a.text.trim()) {
            p.badAnswers.add(a.key);
            if (!msg) msg = t("training.err_a_text", { qn: qi + 1, an: ai + 1 });
          }
        });
        if (msg) {
          p.q[q.key] = msg;
          p.list.push(msg);
        }
      });
    }
    return p;
  }, [form, file, existingFile, t]);

  /* ── unsaved-changes guard ── */
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const askLeave = useCallback(
    () =>
      confirm({
        title: t("v2.team.trainingLive.leaveTitle"),
        body: t("v2.team.trainingLive.leaveBody"),
        confirm: t("v2.team.trainingLive.leaveConfirm"),
        danger: true,
      }),
    [confirm, t],
  );

  const leave = useCallback(
    async (to: string) => {
      if (dirty && !leavingRef.current) {
        const ok = await askLeave();
        if (!ok) return;
      }
      leavingRef.current = true;
      nav(to);
    },
    [dirty, askLeave, nav],
  );

  // BrowserRouter (not a data router) → no useBlocker. Intercept in-app link
  // clicks (menu, ⌘K results rendered as links) while the form is dirty.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (leavingRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (url.pathname === loc.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      void leave(to);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, leave, loc.pathname]);

  /* ── save ── */
  const onSave = () => {
    setShowErrors(true);
    if (problems.list.length) {
      toast.error(problems.list[0]);
      return;
    }
    const fd = new FormData();
    fd.append("title", form.title.trim());
    fd.append("description", form.description.trim());
    fd.append("video_url", form.videoUrl.trim());
    fd.append("is_active", form.isActive ? "1" : "0");
    if (file) fd.append("file", file);
    if (isEdit && clearFile && !file) fd.append("clear_file", "1");
    const qs = form.hasTest
      ? form.questions.map((q, qi) => ({
          text: q.text.trim(),
          order: qi,
          answers: q.answers.map((a, ai) => ({ text: a.text.trim(), is_correct: a.is_correct, order: ai })),
        }))
      : [];
    fd.append("questions", JSON.stringify(qs));
    save.mutate(fd, {
      onSuccess: () => {
        toast.success(isEdit ? t("training.saved") : t("training.created"));
        leavingRef.current = true;
        nav("/training/manage");
      },
      onError: (e: unknown) => {
        const d = (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
        const first = (v: unknown) => (Array.isArray(v) ? String(v[0]) : typeof v === "string" ? v : "");
        const detail =
          first(d?.detail) || first(d?.title) || first(d?.video_url) || first(d?.questions) || first(d?.file) || (e as Error)?.message || t("common.retry");
        toast.error(detail);
      },
    });
  };

  const setTab = (k: "edit" | "stats") => {
    const p = new URLSearchParams(searchParams);
    if (k === "edit") p.delete("tab");
    else p.set("tab", k);
    setSearchParams(p, { replace: true });
  };

  const attempts = statsQ.data?.attempts_count ?? 0;
  const headerTitle = isEdit ? (detailQ.data?.title || t("training.edit_title")) : t("training.new_title");

  const header = (
    <PageHeader
      title={headerTitle}
      back={() => void leave("/training/manage")}
      meta={
        isEdit ? (
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={activeTab === "edit"} className={cx(activeTab === "edit" && "is-on")} onClick={() => setTab("edit")}>
              {t("training.tab_edit")}
            </button>
            <button type="button" role="tab" aria-selected={activeTab === "stats"} className={cx(activeTab === "stats" && "is-on")} onClick={() => setTab("stats")}>
              {t("training.tab_stats")}
            </button>
          </div>
        ) : undefined
      }
    >
      {dirty ? <span className="xs c3">{t("v2.team.trainingLive.unsaved")}</span> : null}
      <button className="btn" type="button" onClick={() => void leave("/training/manage")}>
        {t("common.cancel")}
      </button>
      <button className="btn btn-pri" type="button" disabled={save.isPending || !loaded} onClick={onSave}>
        {save.isPending ? t("common.loading") : t("common.save")}
      </button>
    </PageHeader>
  );

  if (isEdit && !loaded) {
    return (
      <>
        {header}
        <main className="page">
          <section className="card">
            {detailQ.isError ? (
              <ErrorState error={detailQ.error} onRetry={() => detailQ.refetch()} />
            ) : (
              <LoadingBlock rows={6} onRetry={() => detailQ.refetch()} />
            )}
          </section>
        </main>
        {confirm.node}
      </>
    );
  }

  const err = (k?: string) => (showErrors && k ? <span className="err">{k}</span> : null);

  return (
    <>
      {header}
      <main className="page">
        {activeTab === "stats" ? (
          <StatsPanel stats={statsQ.data} loading={statsQ.isLoading} error={statsQ.isError ? statsQ.error : null} onRetry={() => statsQ.refetch()} wide />
        ) : (
          <div className="split">
            <form className="list col g16" onSubmit={(e) => e.preventDefault()}>
              {showErrors && problems.list.length > 0 ? (
                <div className="banner b-bad" role="alert">
                  <AlertTriangle className="ic" />
                  <span className="col g4">
                    <span className="w6">{t("v2.team.trainingLive.errSummary", { n: problems.list.length })}</span>
                    {problems.list.map((m, i) => (
                      <span key={i}>{m}</span>
                    ))}
                  </span>
                </div>
              ) : null}

              <section className="card col g12" style={{ padding: "18px 20px" }}>
                <span className="lbl">{t("training.basic")}</span>
                <div className="field">
                  <label htmlFor="tf-title">{t("training.field_title")}</label>
                  <input
                    id="tf-title"
                    className={cx("input", showErrors && problems.title && "is-bad")}
                    value={form.title}
                    onChange={(e) => set("title", e.target.value)}
                    placeholder={t("training.title_ph")}
                    autoFocus={!isEdit}
                  />
                  {err(problems.title)}
                </div>
                <div className="field">
                  <label htmlFor="tf-desc">{t("training.field_description")}</label>
                  <textarea
                    id="tf-desc"
                    className="input"
                    rows={2}
                    value={form.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder={t("training.description_ph")}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tf-video">{t("training.field_video")}</label>
                  <input
                    id="tf-video"
                    className={cx("input", showErrors && problems.media && "is-bad")}
                    value={form.videoUrl}
                    onChange={(e) => set("videoUrl", e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=…"
                  />
                  <span className="hint">{t("training.video_hint")}</span>
                </div>
                <div className="field">
                  <span className="flabel">{t("training.field_file")}</span>
                  {existingFile && !file ? (
                    <div className="row g8 s">
                      <FileText className="ic ic-s c3" />
                      <a className="trunc" href={existingFile.file_url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                        {existingFile.file_name}
                      </a>
                      <button className="btn btn-ghost btn-sm" type="button" style={{ color: "var(--bad)" }} onClick={() => setClearFile(true)}>
                        {t("training.file_remove")}
                      </button>
                    </div>
                  ) : null}
                  {isEdit && clearFile && !file ? (
                    <div className="row g8 s c3">
                      <span>{t("v2.team.trainingLive.fileWillBeRemoved")}</span>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setClearFile(false)}>
                        {t("v2.team.trainingLive.undo")}
                      </button>
                    </div>
                  ) : null}
                  <div className="row g8">
                    <label className="btn btn-sm" style={{ alignSelf: "flex-start", cursor: "pointer" }}>
                      <Upload className="ic ic-s" />
                      <span className="trunc" style={{ maxWidth: 280 }}>{file ? file.name : t("training.file_pick")}</span>
                      <input
                        type="file"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0] || null;
                          setFile(f);
                          if (f) setClearFile(false);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {file ? (
                      <button className="btn btn-ghost btn-sm" type="button" style={{ color: "var(--bad)" }} onClick={() => setFile(null)}>
                        {t("common.remove")}
                      </button>
                    ) : null}
                  </div>
                  <span className="hint">{t("training.file_hint")}</span>
                  {err(problems.media)}
                </div>
                <label className="row g8 s">
                  <input className="check" type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
                  {t("training.is_active_label")}
                </label>
              </section>

              <section className="card col g12" style={{ padding: "18px 20px" }}>
                <div className="row between wrap g8">
                  <label className="row g8 h3">
                    <input
                      className="check"
                      type="checkbox"
                      checked={form.hasTest}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setForm((p) => ({ ...p, hasTest: on, questions: on && p.questions.length === 0 ? [emptyQuestion()] : p.questions }));
                      }}
                    />
                    {t("training.add_test")}
                  </label>
                  {isEdit && attempts > 0 && form.hasTest ? (
                    <span className="banner b-warn" style={{ padding: "6px 10px" }}>
                      {t("v2.team.trainingLive.attemptsWarn", { n: attempts })}
                    </span>
                  ) : null}
                </div>
                {form.hasTest ? (
                  <>
                    {form.questions.map((q, qi) => {
                      const qErr = showErrors ? problems.q[q.key] : undefined;
                      return (
                        <div key={q.key} className="well col g8" style={{ borderColor: qErr ? "var(--bad-solid)" : undefined }}>
                          <div className="row g8">
                            <span className="num w6 c3">{qi + 1}.</span>
                            <input
                              className={cx("input grow", qErr && !q.text.trim() && "is-bad")}
                              value={q.text}
                              placeholder={t("training.q_text_ph")}
                              aria-label={`${t("training.q_text_ph")} ${qi + 1}`}
                              onChange={(e) => setQuestions((prev) => prev.map((p, i) => (i === qi ? { ...p, text: e.target.value } : p)))}
                            />
                            <button
                              className="btn btn-ghost btn-sq btn-sm"
                              type="button"
                              title={t("training.remove_q")}
                              aria-label={`${t("training.remove_q")} ${qi + 1}`}
                              onClick={() => setQuestions((prev) => prev.filter((_, i) => i !== qi))}
                            >
                              <Trash2 className="ic ic-s" />
                            </button>
                          </div>
                          {q.answers.map((a, ai) => (
                            <div key={a.key} className="row g8" style={{ paddingLeft: 22 }}>
                              <input
                                type="radio"
                                name={`correct_${q.key}`}
                                checked={a.is_correct}
                                aria-label={t("v2.team.trainingLive.correctAnswer")}
                                style={{ margin: 0 }}
                                onChange={() =>
                                  setQuestions((prev) =>
                                    prev.map((p, i) => (i === qi ? { ...p, answers: p.answers.map((x, j) => ({ ...x, is_correct: j === ai })) } : p)),
                                  )
                                }
                              />
                              <input
                                className={cx("input grow", showErrors && problems.badAnswers.has(a.key) && "is-bad")}
                                value={a.text}
                                placeholder={t("training.a_text_ph")}
                                style={{ height: 36 }}
                                onChange={(e) =>
                                  setQuestions((prev) =>
                                    prev.map((p, i) =>
                                      i === qi ? { ...p, answers: p.answers.map((x, j) => (j === ai ? { ...x, text: e.target.value } : x)) } : p,
                                    ),
                                  )
                                }
                              />
                              <button
                                className="btn btn-ghost btn-sq btn-sm"
                                type="button"
                                title={t("training.remove_a")}
                                aria-label={t("training.remove_a")}
                                disabled={q.answers.length <= 2}
                                onClick={() =>
                                  setQuestions((prev) => prev.map((p, i) => (i === qi ? { ...p, answers: p.answers.filter((_, j) => j !== ai) } : p)))
                                }
                              >
                                <Trash2 className="ic ic-s" />
                              </button>
                            </div>
                          ))}
                          <button
                            className="btn btn-ghost btn-sm"
                            type="button"
                            style={{ alignSelf: "flex-start", marginLeft: 16 }}
                            disabled={q.answers.length >= 6}
                            onClick={() =>
                              setQuestions((prev) =>
                                prev.map((p, i) => (i === qi ? { ...p, answers: [...p.answers, { key: uid(), text: "", is_correct: false }] } : p)),
                              )
                            }
                          >
                            <Plus className="ic ic-s" />
                            {t("training.add_a")}
                          </button>
                          {qErr ? (
                            <span className="err" style={{ paddingLeft: 22 }}>
                              {qErr}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                    {err(problems.test)}
                    <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setQuestions((prev) => [...prev, emptyQuestion()])}>
                      <Plus className="ic ic-s" />
                      {t("training.add_q")}
                    </button>
                  </>
                ) : null}
              </section>
            </form>

            {isEdit ? (
              <StatsPanel stats={statsQ.data} loading={statsQ.isLoading} error={statsQ.isError ? statsQ.error : null} onRetry={() => statsQ.refetch()} />
            ) : null}
          </div>
        )}
      </main>
      {confirm.node}
    </>
  );
}

function StatsPanel({
  stats,
  loading,
  error,
  onRetry,
  wide,
}: {
  stats?: TrainingStats;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  wide?: boolean;
}) {
  const t = useT2();
  return (
    <aside className={cx("card col", !wide && "panel")} style={wide ? undefined : { flex: "0 1 440px" }}>
      <div className="card-h">
        <span className="h3">{t("training.tab_stats")}</span>
      </div>
      {loading ? (
        <LoadingBlock rows={3} onRetry={onRetry} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : stats ? (
        <>
          <div className="row g24" style={{ padding: "16px 20px" }}>
            <div className="col g4">
              <span className="lbl">{t("training.stats_attempts")}</span>
              <span className="kpi" style={{ fontSize: 22 }}>{fmtNum(stats.attempts_count)}</span>
            </div>
            <div className="col g4">
              <span className="lbl">{t("training.stats_avg_score")}</span>
              <span className="kpi" style={{ fontSize: 22 }}>{stats.avg_score != null ? `${Math.round(stats.avg_score)}%` : "—"}</span>
            </div>
          </div>
          <hr className="hr" />
          <div className="col" style={{ padding: "8px 20px 16px" }}>
            <span className="s w6" style={{ padding: "8px 0" }}>{t("training.stats_by_question")}</span>
            {stats.attempts_count === 0 || stats.questions.length === 0 ? (
              <EmptyState title={t("training.stats_empty")} body={stats.questions.length === 0 ? t("v2.team.trainingLive.statsNoTest") : undefined} />
            ) : (
              stats.questions.map((x, i) => (
                <div key={x.id} className="col g6" style={{ padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
                  <div className="row between g8" style={{ alignItems: "flex-start" }}>
                    <span className="s w6">
                      {i + 1}. {x.text}
                    </span>
                    <span className="num xs" style={{ whiteSpace: "nowrap" }}>
                      <span className="c-ok">{x.correct}</span>
                      <span className="c3"> / </span>
                      <span className="c-bad">{x.wrong}</span>
                    </span>
                  </div>
                  <div className="row g8">
                    <span className="bar grow">
                      <i className="bad" style={{ width: `${Math.min(100, Math.max(0, x.error_pct))}%` }} />
                    </span>
                    <span className="num xs c3" style={{ whiteSpace: "nowrap" }}>
                      {t("training.error_pct", { n: Math.round(x.error_pct) })}
                    </span>
                  </div>
                  {x.wrong_operators.length > 0 ? (
                    <span className="xs c3">
                      {t("training.stats_wrong_ops")}: {x.wrong_operators.map((o) => o.full_name).join(", ")}
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </aside>
  );
}
