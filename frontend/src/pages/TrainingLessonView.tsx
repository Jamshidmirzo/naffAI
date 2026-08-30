import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText, XCircle, Send } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { Button, Eyebrow, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface Answer {
  id: number;
  text: string;
  order: number;
}
interface Question {
  id: number;
  text: string;
  order: number;
  answers: Answer[];
}
interface AttemptResult {
  completed_at: string;
  score_pct: number;
  per_question: {
    question_id: number;
    chosen_answer_id: number | null;
    is_correct: boolean;
  }[];
}
interface LessonDetail {
  id: number;
  title: string;
  description: string;
  video_url: string;
  file_url: string;
  file_name: string;
  created_at: string;
  questions: Question[];
  attempt: AttemptResult | null;
}
interface CommentRow {
  id: number;
  operator_id: number;
  operator_name: string;
  text: string;
  created_at: string;
}

/**
 * Возвращает YouTube video-id из URL вида
 * https://www.youtube.com/watch?v=XXX или https://youtu.be/XXX,
 * иначе null. Для non-YouTube ссылок покажем `<video controls>` — при
 * условии что это прямой mp4/webm/др. Если это внешний плеер типа
 * Vimeo — фолбэк на ссылку.
 */
function parseYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      return id || null;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      // /embed/XXX
      const parts = u.pathname.split("/").filter(Boolean);
      const idx = parts.indexOf("embed");
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
    return null;
  } catch {
    return null;
  }
}

function isDirectVideo(url: string): boolean {
  return /\.(mp4|webm|ogg|mov|m4v)($|\?)/i.test(url);
}

function absoluteMediaUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  // API_BASE_URL заканчивается на /api → отбрасываем эту часть, чтобы
  // получить корень origin, и приклеиваем /media/...
  const origin = API_BASE_URL.replace(/\/api\/?$/, "");
  return `${origin}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

export default function TrainingLessonView() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  usePageHeader({ title: t("training.lesson"), back: "/training" });

  const q = useQuery<LessonDetail>({
    queryKey: ["training-my", id],
    queryFn: () => api.get(`/training/my-lessons/${id}/`).then((r) => r.data),
    enabled: !!id,
  });

  const commentsQ = useQuery<CommentRow[]>({
    queryKey: ["training-comments", id],
    queryFn: () => api.get(`/training/my-lessons/${id}/comments/`).then((r) => r.data),
    enabled: !!id,
  });

  const [choices, setChoices] = useState<Record<number, number>>({});
  const [commentText, setCommentText] = useState("");

  const submit = useMutation({
    mutationFn: () => api.post(`/training/my-lessons/${id}/submit/`, { choices }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["training-my", id] });
      qc.invalidateQueries({ queryKey: ["training-my-list"] });
      toast.success(t("training.submit_ok"));
    },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail || e?.response?.data?.choices?.[0];
      toast.error(detail || t("training.submit_err"));
    },
  });

  const addComment = useMutation({
    mutationFn: () =>
      api.post(`/training/my-lessons/${id}/comments/`, { text: commentText }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["training-comments", id] });
      setCommentText("");
    },
    onError: () => toast.error(t("training.comment_err")),
  });

  const lesson = q.data;
  const ytId = useMemo(() => (lesson ? parseYouTubeId(lesson.video_url) : null), [lesson]);
  const perQMap = useMemo(() => {
    const r: Record<number, AttemptResult["per_question"][number]> = {};
    if (lesson?.attempt) {
      for (const pq of lesson.attempt.per_question) r[pq.question_id] = pq;
    }
    return r;
  }, [lesson]);

  if (q.isLoading || !lesson) {
    return <div className="text-muted text-[13px]">{t("common.loading")}</div>;
  }

  const attempted = !!lesson.attempt;
  const canSubmit =
    !attempted &&
    lesson.questions.length > 0 &&
    lesson.questions.every((q) => choices[q.id] != null);

  return (
    <div className="mx-auto max-w-[880px] flex flex-col gap-6">
      {/* Header — заголовок + описание --------------------------- */}
      <section className="nf-card p-6">
        <Eyebrow>{t("training.title")}</Eyebrow>
        <div className="mt-2 text-[22px] font-semibold leading-tight">{lesson.title}</div>
        {lesson.description && (
          <div className="mt-3 text-[14px] text-muted whitespace-pre-wrap">
            {lesson.description}
          </div>
        )}
      </section>

      {/* Видео ------------------------------------------------------ */}
      {lesson.video_url && (
        <section className="nf-card overflow-hidden">
          {ytId ? (
            <div className="aspect-video w-full bg-black">
              <iframe
                width="100%"
                height="100%"
                src={`https://www.youtube.com/embed/${ytId}`}
                title={lesson.title}
                frameBorder={0}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : isDirectVideo(lesson.video_url) ? (
            <video
              controls
              src={lesson.video_url}
              className="w-full aspect-video bg-black"
            />
          ) : (
            <div className="p-5">
              <a
                href={lesson.video_url}
                target="_blank"
                rel="noreferrer"
                className="text-[14px] underline text-[color:var(--accent)]"
              >
                {t("training.open_video_link")}
              </a>
            </div>
          )}
        </section>
      )}

      {/* Файл ------------------------------------------------------- */}
      {lesson.file_url && (
        <section className="nf-card p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="w-5 h-5 shrink-0 text-muted" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium truncate">{lesson.file_name}</div>
              <div className="text-[12px] text-muted">{t("training.file_attached")}</div>
            </div>
          </div>
          <a
            className="nf-btn nf-btn--secondary text-[13px]"
            href={absoluteMediaUrl(lesson.file_url)}
            target="_blank"
            rel="noreferrer"
          >
            {t("training.download")}
          </a>
        </section>
      )}

      {/* Тест ------------------------------------------------------- */}
      {lesson.questions.length > 0 && (
        <section className="nf-card p-6">
          <div className="flex items-center justify-between">
            <div className="text-[16px] font-semibold">{t("training.test")}</div>
            {attempted && lesson.attempt && (
              <span className="text-[13px] font-medium px-3 py-1 rounded-full bg-emerald-100 text-emerald-800">
                {t("training.score_x", { n: lesson.attempt.score_pct })}
              </span>
            )}
          </div>
          <div className="mt-5 flex flex-col gap-6">
            {lesson.questions.map((q, qi) => {
              const pq = perQMap[q.id];
              return (
                <div key={q.id}>
                  <div className="text-[14px] font-medium mb-3">
                    {qi + 1}. {q.text}
                  </div>
                  <div className="flex flex-col gap-2">
                    {q.answers.map((a) => {
                      const isChosen = attempted
                        ? pq?.chosen_answer_id === a.id
                        : choices[q.id] === a.id;
                      // Показ «правильности» — только после submit:
                      const rightAnswerVisible =
                        attempted && pq && pq.chosen_answer_id !== null;
                      // Правильный ответ в attempt мы не знаем напрямую —
                      // сервер отдаёт только what-you-chose + is_correct.
                      // Подсветим «выбранный правильно/неправильно».
                      const cls = [
                        "flex items-center gap-3 border rounded-2xl px-4 py-3 cursor-pointer transition-colors",
                      ];
                      if (attempted) {
                        if (isChosen && pq?.is_correct) {
                          cls.push("border-emerald-400 bg-emerald-50");
                        } else if (isChosen && pq && !pq.is_correct) {
                          cls.push("border-rose-400 bg-rose-50");
                        } else {
                          cls.push("border-[color:var(--line)]");
                        }
                      } else {
                        cls.push(
                          isChosen
                            ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)]"
                            : "border-[color:var(--line)] hover:bg-[color:var(--surface-2)]",
                        );
                      }
                      return (
                        <label key={a.id} className={cls.join(" ")}>
                          <input
                            type="radio"
                            name={`q_${q.id}`}
                            className="w-4 h-4"
                            checked={isChosen}
                            disabled={attempted}
                            onChange={() =>
                              setChoices((prev) => ({ ...prev, [q.id]: a.id }))
                            }
                          />
                          <span className="text-[14px]">{a.text}</span>
                          {attempted && isChosen && pq?.is_correct && (
                            <CheckCircle2 className="ml-auto w-4 h-4 text-emerald-600" />
                          )}
                          {attempted && isChosen && pq && !pq.is_correct && (
                            <XCircle className="ml-auto w-4 h-4 text-rose-600" />
                          )}
                          {rightAnswerVisible && false /* placeholder */ && null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {!attempted && (
            <div className="mt-6 flex justify-end">
              <Button
                onClick={() => submit.mutate()}
                disabled={!canSubmit || submit.isPending}
              >
                {submit.isPending ? t("training.submitting") : t("training.submit")}
              </Button>
            </div>
          )}
          {attempted && (
            <div className="mt-5 text-[12px] text-muted">
              {t("training.attempted_hint")}
            </div>
          )}
        </section>
      )}

      {/* Комментарии ----------------------------------------------- */}
      <section className="nf-card p-6">
        <div className="text-[16px] font-semibold mb-4">{t("training.comments")}</div>
        <div className="flex flex-col gap-3">
          {(commentsQ.data || []).length === 0 ? (
            <div className="text-[13px] text-muted">{t("training.no_comments")}</div>
          ) : (
            (commentsQ.data || []).map((c) => (
              <div key={c.id} className="border-b border-[color:var(--line)] pb-3">
                <div className="text-[12px] text-muted mb-1">{c.operator_name}</div>
                <div className="text-[14px] whitespace-pre-wrap">{c.text}</div>
              </div>
            ))
          )}
        </div>
        <div className="mt-5 flex gap-2">
          <input
            className="nf-input flex-1"
            placeholder={t("training.comment_ph")}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && commentText.trim() && !addComment.isPending) {
                addComment.mutate();
              }
            }}
          />
          <Button
            variant="secondary"
            disabled={!commentText.trim() || addComment.isPending}
            onClick={() => addComment.mutate()}
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </section>
    </div>
  );
}
