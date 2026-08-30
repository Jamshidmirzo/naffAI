import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Plus, Trash2, Upload, FileText } from "lucide-react";
import { api } from "../lib/api";
import { Button, Eyebrow, TabPill, type TabItem, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

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
interface LessonDetail {
  id: number;
  title: string;
  description: string;
  video_url: string;
  file_url: string;
  file_name: string;
  is_active: boolean;
  questions: {
    id: number;
    text: string;
    order: number;
    answers: { id: number; text: string; is_correct: boolean; order: number }[];
  }[];
}
interface StatsRow {
  id: number;
  text: string;
  order: number;
  attempts: number;
  correct: number;
  wrong: number;
  error_pct: number;
  wrong_operators: { id: number; full_name: string }[];
}
interface StatsResponse {
  lesson_id: number;
  attempts_count: number;
  avg_score: number | null;
  questions: StatsRow[];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

function emptyQuestion(): QuestionDraft {
  const first: AnswerDraft = { key: uid(), text: "", is_correct: true };
  const second: AnswerDraft = { key: uid(), text: "", is_correct: false };
  return { key: uid(), text: "", answers: [first, second] };
}

export default function TrainingLessonForm() {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || "edit";

  usePageHeader({
    title: isEdit ? t("training.edit_title") : t("training.new_title"),
    back: "/training/manage",
  });

  // ---- form state ----
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [clearFile, setClearFile] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [hasTest, setHasTest] = useState(false);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [loaded, setLoaded] = useState(false);

  const detailQ = useQuery<LessonDetail>({
    queryKey: ["training-manage-detail", id],
    queryFn: () => api.get(`/training/lessons/${id}/`).then((r) => r.data),
    enabled: isEdit,
  });

  useEffect(() => {
    if (isEdit && detailQ.data && !loaded) {
      const d = detailQ.data;
      setTitle(d.title);
      setDescription(d.description);
      setVideoUrl(d.video_url);
      setIsActive(d.is_active);
      const qs = d.questions.map((q) => ({
        key: `db-${q.id}`,
        text: q.text,
        answers: q.answers.map((a) => ({
          key: `db-${a.id}`,
          text: a.text,
          is_correct: a.is_correct,
        })),
      }));
      setQuestions(qs);
      setHasTest(qs.length > 0);
      setLoaded(true);
    }
  }, [isEdit, detailQ.data, loaded]);

  const statsQ = useQuery<StatsResponse>({
    queryKey: ["training-manage-stats", id],
    queryFn: () => api.get(`/training/lessons/${id}/stats/`).then((r) => r.data),
    enabled: isEdit && activeTab === "stats",
  });

  const save = useMutation({
    mutationFn: async () => {
      // Валидация client-side — обязательно медиа
      if (!title.trim()) throw new Error(t("training.err_title"));
      if (!videoUrl.trim() && !file && !detailQ.data?.file_url) {
        throw new Error(t("training.err_media"));
      }
      if (hasTest) {
        for (const [qi, q] of questions.entries()) {
          if (!q.text.trim()) throw new Error(t("training.err_q_text", { n: qi + 1 }));
          if (q.answers.length < 2)
            throw new Error(t("training.err_q_answers", { n: qi + 1 }));
          const correct = q.answers.filter((a) => a.is_correct).length;
          if (correct !== 1) throw new Error(t("training.err_q_one_correct", { n: qi + 1 }));
          for (const [ai, a] of q.answers.entries()) {
            if (!a.text.trim())
              throw new Error(t("training.err_a_text", { qn: qi + 1, an: ai + 1 }));
          }
        }
      }

      const form = new FormData();
      form.append("title", title.trim());
      form.append("description", description.trim());
      form.append("video_url", videoUrl.trim());
      form.append("is_active", isActive ? "1" : "0");
      if (file) form.append("file", file);
      if (isEdit && clearFile && !file) form.append("clear_file", "1");
      const qs = hasTest
        ? questions.map((q, qi) => ({
            text: q.text.trim(),
            order: qi,
            answers: q.answers.map((a, ai) => ({
              text: a.text.trim(),
              is_correct: a.is_correct,
              order: ai,
            })),
          }))
        : [];
      form.append("questions", JSON.stringify(qs));

      if (isEdit) {
        return api.patch(`/training/lessons/${id}/`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      return api.post("/training/lessons/", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["training-manage"] });
      qc.invalidateQueries({ queryKey: ["training-manage-detail", id] });
      toast.success(isEdit ? t("training.saved") : t("training.created"));
      nav("/training/manage");
    },
    onError: (e: any) => {
      const detail =
        e?.response?.data?.detail ||
        e?.response?.data?.title?.[0] ||
        e?.response?.data?.video_url?.[0] ||
        e?.response?.data?.questions?.[0] ||
        e?.message ||
        t("common.retry");
      toast.error(detail);
    },
  });

  const tabs: TabItem[] = useMemo(() => {
    if (!isEdit) return [];
    return [
      { value: "edit", label: t("training.tab_edit") },
      { value: "stats", label: t("training.tab_stats") },
    ];
  }, [isEdit, t]);

  return (
    <div className="mx-auto max-w-[880px] flex flex-col gap-5">
      {isEdit && tabs.length > 0 && (
        <TabPill
          items={tabs}
          value={activeTab}
          onChange={(k) => {
            const p = new URLSearchParams(searchParams);
            if (k === "edit") p.delete("tab");
            else p.set("tab", k);
            setSearchParams(p);
          }}
        />
      )}

      {activeTab === "edit" ? (
        <>
          {/* --- Основные поля --- */}
          <section className="nf-card p-6 flex flex-col gap-4">
            <Eyebrow>{t("training.basic")}</Eyebrow>
            <div>
              <div className="nf-col mb-1.5">{t("training.field_title")}</div>
              <input
                className="nf-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("training.title_ph")}
                autoFocus
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("training.field_description")}</div>
              <textarea
                className="nf-input"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("training.description_ph")}
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("training.field_video")}</div>
              <input
                className="nf-input"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
              />
              <div className="text-[12px] text-muted mt-1">{t("training.video_hint")}</div>
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("training.field_file")}</div>
              {isEdit && detailQ.data?.file_url && !file && !clearFile && (
                <div className="flex items-center gap-3 mb-2 text-[13px]">
                  <FileText className="w-4 h-4 text-muted" />
                  <span className="truncate">{detailQ.data.file_name}</span>
                  <button
                    type="button"
                    className="text-[12px] text-rose-600 underline"
                    onClick={() => setClearFile(true)}
                  >
                    {t("training.file_remove")}
                  </button>
                </div>
              )}
              <label className="nf-btn nf-btn--secondary inline-flex items-center gap-2 cursor-pointer text-[13px]">
                <Upload className="w-4 h-4" />
                {file ? file.name : t("training.file_pick")}
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setFile(f);
                    if (f) setClearFile(false);
                  }}
                />
              </label>
              {file && (
                <button
                  type="button"
                  className="ml-3 text-[12px] text-rose-600 underline"
                  onClick={() => setFile(null)}
                >
                  {t("common.remove")}
                </button>
              )}
              <div className="text-[12px] text-muted mt-1">{t("training.file_hint")}</div>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              {t("training.is_active_label")}
            </label>
          </section>

          {/* --- Тест --- */}
          <section className="nf-card p-6 flex flex-col gap-4">
            <label className="flex items-center gap-2 text-[14px] font-medium">
              <input
                type="checkbox"
                checked={hasTest}
                onChange={(e) => {
                  setHasTest(e.target.checked);
                  if (e.target.checked && questions.length === 0) {
                    setQuestions([emptyQuestion()]);
                  }
                }}
              />
              {t("training.add_test")}
            </label>
            {hasTest && (
              <div className="flex flex-col gap-4">
                {questions.map((q, qi) => (
                  <div
                    key={q.key}
                    className="border border-[color:var(--line)] rounded-2xl p-4 flex flex-col gap-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="text-[12px] font-semibold text-muted pt-2 shrink-0">
                        {qi + 1}.
                      </div>
                      <input
                        className="nf-input flex-1"
                        value={q.text}
                        onChange={(e) =>
                          setQuestions((prev) =>
                            prev.map((p, i) =>
                              i === qi ? { ...p, text: e.target.value } : p,
                            ),
                          )
                        }
                        placeholder={t("training.q_text_ph")}
                      />
                      <button
                        type="button"
                        className="nf-btn nf-btn--ghost text-rose-600"
                        style={{ padding: "6px 10px" }}
                        onClick={() =>
                          setQuestions((prev) => prev.filter((_, i) => i !== qi))
                        }
                        title={t("training.remove_q")}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="pl-6 flex flex-col gap-2">
                      {q.answers.map((a, ai) => (
                        <div key={a.key} className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`correct_${q.key}`}
                            className="w-4 h-4"
                            checked={a.is_correct}
                            onChange={() =>
                              setQuestions((prev) =>
                                prev.map((p, i) =>
                                  i === qi
                                    ? {
                                        ...p,
                                        answers: p.answers.map((x, j) => ({
                                          ...x,
                                          is_correct: j === ai,
                                        })),
                                      }
                                    : p,
                                ),
                              )
                            }
                          />
                          <input
                            className="nf-input flex-1"
                            value={a.text}
                            onChange={(e) =>
                              setQuestions((prev) =>
                                prev.map((p, i) =>
                                  i === qi
                                    ? {
                                        ...p,
                                        answers: p.answers.map((x, j) =>
                                          j === ai ? { ...x, text: e.target.value } : x,
                                        ),
                                      }
                                    : p,
                                ),
                              )
                            }
                            placeholder={t("training.a_text_ph")}
                          />
                          <button
                            type="button"
                            className="nf-btn nf-btn--ghost"
                            style={{ padding: "6px 10px" }}
                            disabled={q.answers.length <= 2}
                            onClick={() =>
                              setQuestions((prev) =>
                                prev.map((p, i) =>
                                  i === qi
                                    ? {
                                        ...p,
                                        answers: p.answers.filter((_, j) => j !== ai),
                                      }
                                    : p,
                                ),
                              )
                            }
                            title={t("training.remove_a")}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="nf-btn nf-btn--ghost self-start text-[12px]"
                        style={{ padding: "6px 10px" }}
                        disabled={q.answers.length >= 6}
                        onClick={() =>
                          setQuestions((prev) =>
                            prev.map((p, i) =>
                              i === qi
                                ? {
                                    ...p,
                                    answers: [
                                      ...p.answers,
                                      { key: uid(), text: "", is_correct: false },
                                    ],
                                  }
                                : p,
                            ),
                          )
                        }
                      >
                        <Plus className="w-3.5 h-3.5" /> {t("training.add_a")}
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="nf-btn nf-btn--secondary self-start text-[13px]"
                  onClick={() =>
                    setQuestions((prev) => [...prev, emptyQuestion()])
                  }
                >
                  <Plus className="w-3.5 h-3.5" /> {t("training.add_q")}
                </button>
              </div>
            )}
          </section>

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => nav("/training/manage")}>
              {t("common.cancel")}
            </Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? t("common.loading") : t("common.save")}
            </Button>
          </div>
        </>
      ) : (
        <StatsPane q={statsQ} />
      )}
    </div>
  );
}

function StatsPane({ q }: { q: ReturnType<typeof useQuery<StatsResponse>> }) {
  const t = useT();
  if (q.isLoading || !q.data) {
    return <div className="text-muted text-[13px]">{t("common.loading")}</div>;
  }
  const s = q.data;
  return (
    <div className="flex flex-col gap-4">
      <section className="nf-card p-6 grid grid-cols-2 gap-6">
        <div>
          <Eyebrow>{t("training.stats_attempts")}</Eyebrow>
          <div className="text-[28px] font-semibold mt-1">{s.attempts_count}</div>
        </div>
        <div>
          <Eyebrow>{t("training.stats_avg_score")}</Eyebrow>
          <div className="text-[28px] font-semibold mt-1">
            {s.avg_score != null ? `${s.avg_score}%` : "—"}
          </div>
        </div>
      </section>

      <section className="nf-card p-6">
        <div className="text-[14px] font-semibold mb-4">{t("training.stats_by_question")}</div>
        {s.questions.length === 0 ? (
          <div className="text-[13px] text-muted">{t("training.stats_empty")}</div>
        ) : (
          <div className="flex flex-col gap-4">
            {s.questions.map((row, i) => (
              <div key={row.id} className="border-b border-[color:var(--line)] pb-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[14px] font-medium">
                    {i + 1}. {row.text}
                  </div>
                  <div className="text-[13px] shrink-0">
                    <span className="text-emerald-700">{row.correct}</span>
                    <span className="text-muted"> / </span>
                    <span className="text-rose-700">{row.wrong}</span>
                    <span className="text-muted ml-2">
                      {t("training.error_pct", { n: row.error_pct })}
                    </span>
                  </div>
                </div>
                <div className="mt-2 h-1.5 bg-[color:var(--surface-2)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-rose-400"
                    style={{ width: `${row.error_pct}%` }}
                  />
                </div>
                {row.wrong_operators.length > 0 && (
                  <div className="mt-2 text-[12px] text-muted">
                    {t("training.stats_wrong_ops")}: {row.wrong_operators.map((o) => o.full_name).join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
