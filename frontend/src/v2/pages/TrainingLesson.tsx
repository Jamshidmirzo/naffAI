import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, Download, ExternalLink, FileText, PlayCircle, Send, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import {
  isDirectVideo,
  trainingMediaUrl,
  useTrainingAddComment,
  useTrainingComments,
  useTrainingLesson,
  useTrainingSubmit,
  youTubeId,
  type TrainingLessonDetail,
  type TrainingSubmitResult,
} from "../api/personal";

function httpStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";
}

export default function TrainingLesson() {
  const t = useT2();
  const { id } = useParams<{ id: string }>();
  const q = useTrainingLesson(id);
  const lesson = q.data;

  const status = lesson?.attempt ? (
    <span className="badge b-ok">{t("v2.personal.training.passedScore", { n: lesson.attempt.score_pct })}</span>
  ) : lesson && lesson.questions.length > 0 ? (
    <span className="badge">{t("v2.personal.training.notPassed")}</span>
  ) : null;

  return (
    <>
      <PageHeader title={lesson?.title ?? t("training.lesson")} meta={status} back="/training" />
      <main className="page">
        {q.isLoading ? (
          <section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section>
        ) : q.isError || !lesson ? (
          httpStatus(q.error) === 404 ? (
            <section className="card">
              <EmptyState
                title={t("v2.personal.tlesson.notFoundTitle")}
                body={t("v2.personal.tlesson.notFoundBody")}
                action={<Link className="btn btn-pri" to="/training">{t("v2.personal.tlesson.toCourses")}</Link>}
              />
            </section>
          ) : (
            <section className="card">
              <ErrorState error={q.error} title={t("v2.personal.tlesson.errorTitle")} onRetry={() => q.refetch()} />
            </section>
          )
        ) : (
          <LessonView lesson={lesson} id={id!} />
        )}
      </main>
    </>
  );
}

function LessonView({ lesson, id }: { lesson: TrainingLessonDetail; id: string }) {
  const t = useT2();
  const hasTest = lesson.questions.length > 0;
  return (
    <div className="split">
      <div className="list col g16">
        {lesson.video_url ? <Video url={lesson.video_url} title={lesson.title} /> : null}
        {lesson.file_url ? (
          <div className="well row between g12">
            <span className="row g8 s" style={{ minWidth: 0 }}>
              <FileText className="ic" style={{ flex: "none" }} />
              <span className="col" style={{ minWidth: 0 }}>
                <span className="w5 trunc">{lesson.file_name}</span>
                <span className="xs c3">{t("training.file_attached")}</span>
              </span>
            </span>
            <a className="btn btn-sm" href={trainingMediaUrl(lesson.file_url)} target="_blank" rel="noreferrer">
              <Download className="ic" />
              {t("training.download")}
            </a>
          </div>
        ) : null}
        {lesson.description ? (
          <section className="card col g8" style={{ padding: "18px 20px" }}>
            <span className="h3">{t("v2.personal.tlesson.about")}</span>
            <p className="s c2" style={{ whiteSpace: "pre-wrap" }}>{lesson.description}</p>
          </section>
        ) : null}
        <Comments id={id} />
      </div>
      {hasTest ? (
        <aside className="panel card col" style={{ position: "sticky", top: 80 }}>
          <TestPanel lesson={lesson} id={id} />
        </aside>
      ) : null}
    </div>
  );
}

function Video({ url, title }: { url: string; title: string }) {
  const t = useT2();
  const yt = useMemo(() => youTubeId(url), [url]);
  if (yt) {
    return (
      <div style={{ aspectRatio: "16 / 9", borderRadius: 14, overflow: "hidden", background: "#000" }}>
        <iframe
          width="100%"
          height="100%"
          src={`https://www.youtube.com/embed/${yt}`}
          title={title}
          frameBorder={0}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }
  if (isDirectVideo(url)) {
    return <video controls src={url} style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 14, background: "#000", display: "block" }} />;
  }
  return (
    <div className="ph" style={{ aspectRatio: "16 / 9", borderRadius: 14 }}>
      <PlayCircle className="ic ic-xl" />
      <span className="s w6" style={{ color: "var(--ink-2)" }}>{t("v2.personal.tlesson.videoFallback")}</span>
      <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">
        <ExternalLink className="ic" />
        {t("training.open_video_link")}
      </a>
    </div>
  );
}

function TestPanel({ lesson, id }: { lesson: TrainingLessonDetail; id: string }) {
  const t = useT2();
  const [choices, setChoices] = useState<Record<number, number>>({});
  // the correct answer is only revealed in the submit response — keep it for this visit
  const [result, setResult] = useState<TrainingSubmitResult | null>(null);
  const submit = useTrainingSubmit(id);

  const qs = lesson.questions;
  const answered = qs.filter((q) => choices[q.id] != null).length;
  const missing = qs.map((q, i) => (choices[q.id] == null ? i + 1 : null)).filter((n): n is number => n != null);

  const onSubmit = () =>
    submit.mutate(choices, {
      onSuccess: (data) => {
        setResult(data);
        toast.success(t("training.submit_ok"));
      },
      onError: (e: unknown) => {
        const d = (e as { response?: { data?: { detail?: string; choices?: string[] } } })?.response?.data;
        toast.error(d?.detail || d?.choices?.[0] || t("training.submit_err"));
      },
    });

  if (lesson.attempt) {
    const att = lesson.attempt;
    const perQ = new Map(att.per_question.map((p) => [p.question_id, p]));
    const correctById = new Map((result?.per_question ?? []).map((p) => [p.question_id, p.correct_answer_id]));
    const score = att.score_pct;
    const tone = score >= 80 ? "var(--ok)" : score >= 50 ? "var(--warn)" : "var(--bad)";
    return (
      <>
        <div className="card-h">
          <span className="h3">{t("v2.personal.tlesson.result")}</span>
          <span className="kpi" style={{ fontSize: 22, color: tone }}>{score}%</span>
        </div>
        <div className="col g12" style={{ padding: "16px 20px" }}>
          {qs.map((q, i) => {
            const pq = perQ.get(q.id);
            const chosen = q.answers.find((a) => a.id === pq?.chosen_answer_id);
            const correctId = correctById.get(q.id);
            const correct = correctId != null ? q.answers.find((a) => a.id === correctId) : undefined;
            const ok = !!pq?.is_correct;
            return (
              <div key={q.id} className="col g4">
                <span className="s w6">{i + 1}. {q.text}</span>
                {ok ? (
                  <span className="row g6 s c-ok"><Check className="ic ic-s" style={{ flex: "none" }} />{chosen?.text}</span>
                ) : (
                  <>
                    <span className="row g6 s c-bad">
                      <X className="ic ic-s" style={{ flex: "none" }} />
                      {t("v2.personal.tlesson.yourAnswer", { a: chosen?.text ?? t("v2.personal.tlesson.noAnswer") })}
                    </span>
                    {correct ? <span className="s c-ok" style={{ paddingLeft: 20 }}>{t("v2.personal.tlesson.correctAnswer", { a: correct.text })}</span> : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <hr className="hr" />
        <div className="col g8" style={{ padding: "14px 20px 18px" }}>
          <div className="row g8"><Link className="btn" to="/training">{t("v2.personal.tlesson.toCourses")}</Link></div>
          <span className="xs c3">{t("v2.personal.tlesson.oneAttempt")}</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card-h">
        <span className="h3">{t("training.test")}</span>
        <span className="xs c3">{t("v2.personal.tlesson.answered", { n: answered, total: qs.length })}</span>
      </div>
      <div className="col g16" style={{ padding: "16px 20px" }}>
        {qs.map((q, i) => (
          <fieldset key={q.id} className="col g8" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <legend className="s w6" style={{ marginBottom: 8, padding: 0 }}>{i + 1}. {q.text}</legend>
            {q.answers.map((a) => {
              const on = choices[q.id] === a.id;
              return (
                <label
                  key={a.id}
                  className={cx("row g8 s")}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 9,
                    cursor: "pointer",
                    border: `1px solid ${on ? "var(--brand)" : "var(--line)"}`,
                    background: on ? "var(--brand-soft)" : undefined,
                  }}
                >
                  <input
                    type="radio"
                    name={`q_${q.id}`}
                    className="check"
                    checked={on}
                    onChange={() => setChoices((prev) => ({ ...prev, [q.id]: a.id }))}
                  />
                  {a.text}
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
      <hr className="hr" />
      <div className="col g8" style={{ padding: "14px 20px 18px" }}>
        <button className="btn btn-pri" type="button" disabled={missing.length > 0 || submit.isPending} onClick={onSubmit}>
          {submit.isPending ? t("training.submitting") : t("training.submit")}
        </button>
        {missing.length > 0 ? (
          <span className="xs c3">
            {t("v2.personal.tlesson.hintAll")} {t("v2.personal.tlesson.hintMissing", { list: missing.join(", ") })}
          </span>
        ) : null}
      </div>
    </>
  );
}

function Comments({ id }: { id: string }) {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const q = useTrainingComments(id);
  const add = useTrainingAddComment(id);
  const [text, setText] = useState("");
  const rows = q.data ?? [];
  const send = () => {
    if (!text.trim() || add.isPending) return;
    add.mutate(text, {
      onSuccess: () => setText(""),
      onError: () => toast.error(t("training.comment_err")),
    });
  };
  const fmt = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(lang === "uz" ? "uz-UZ" : "ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tashkent" });
    } catch {
      return "";
    }
  };
  return (
    <section className="card col">
      <div className="card-h">
        <span className="h3">{t("training.comments")}</span>
        {q.data ? <span className="xs c3 num">{rows.length}</span> : null}
      </div>
      {q.isLoading ? (
        <LoadingBlock rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <div className="li s c3">{t("training.no_comments")}</div>
      ) : (
        rows.map((c) => (
          <div key={c.id} className="li" style={{ alignItems: "flex-start", paddingTop: 12, paddingBottom: 12 }}>
            <span className="ava ava-s" aria-hidden="true">{initials(c.operator_name)}</span>
            <span className="col g4 grow" style={{ minWidth: 0 }}>
              <span className="xs c3">{c.operator_name}</span>
              <span className="s" style={{ whiteSpace: "pre-wrap" }}>{c.text}</span>
            </span>
            <span className="xs c3" style={{ flex: "none" }}>{fmt(c.created_at)}</span>
          </div>
        ))
      )}
      <div className="row g8" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
        <input
          className="input grow"
          type="text"
          placeholder={t("training.comment_ph")}
          aria-label={t("training.comment_ph")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button className="btn" type="button" disabled={!text.trim() || add.isPending} onClick={send}>
          <Send className="ic" />
          {t("v2.personal.tlesson.send")}
        </button>
      </div>
    </section>
  );
}
