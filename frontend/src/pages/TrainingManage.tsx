import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { BarChart3, Pencil, Plus, Trash2, EyeOff, Eye } from "lucide-react";
import { api } from "../lib/api";
import { Button, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface Row {
  id: number;
  title: string;
  description: string;
  video_url: string;
  file_url: string;
  file_name: string;
  is_active: boolean;
  questions_count: number;
  attempts_count: number;
  comments_count: number;
  created_at: string;
}

export default function TrainingManage() {
  const t = useT();
  const qc = useQueryClient();
  const nav = useNavigate();

  usePageHeader({ title: t("training.manage_title"), subtitle: t("training.manage_subtitle") });

  const list = useQuery<Row[]>({
    queryKey: ["training-manage"],
    queryFn: () => api.get("/training/lessons/").then((r) => r.data),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/training/lessons/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["training-manage"] });
      toast.success(t("training.deleted"));
    },
    onError: () => toast.error(t("common.retry")),
  });

  const toggle = useMutation({
    mutationFn: (p: { id: number; is_active: boolean }) =>
      api.patch(`/training/lessons/${p.id}/`, { is_active: p.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["training-manage"] }),
  });

  const rows = list.data || [];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <div className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">{t("training.total_n", { n: rows.length })}</div>
        <Button onClick={() => nav("/training/manage/new")}>
          <Plus className="w-3.5 h-3.5" /> {t("training.new")}
        </Button>
      </div>

      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "2.2fr .6fr .5fr .6fr .6fr 1fr" }}
        >
          <div>{t("training.col_title")}</div>
          <div>{t("training.col_media")}</div>
          <div className="text-right">{t("training.col_questions")}</div>
          <div className="text-right">{t("training.col_attempts")}</div>
          <div>{t("common.status")}</div>
          <div className="text-right">{t("common.actions")}</div>
        </div>
        {list.isLoading ? (
          <div className="text-center text-muted py-10 text-[13px]">
            {t("common.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("training.empty_hint_manager")}
          </div>
        ) : (
          <div>
            {rows.map((row, i) => (
              <div
                key={row.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "2.2fr .6fr .5fr .6fr .6fr 1fr",
                  animationDelay: `${0.02 + i * 0.03}s`,
                  cursor: "default",
                }}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{row.title}</div>
                  {row.description && (
                    <div className="text-[12px] text-muted truncate">{row.description}</div>
                  )}
                </div>
                <div className="text-[12px] text-muted">
                  {[row.video_url ? t("training.video") : null, row.file_url ? t("training.file") : null]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </div>
                <div className="text-right">{row.questions_count}</div>
                <div className="text-right">{row.attempts_count}</div>
                <div>
                  <button
                    className="text-[12px] px-2.5 py-1 rounded-full"
                    style={{
                      background: row.is_active
                        ? "rgba(16,185,129,.12)"
                        : "rgba(120,120,130,.14)",
                      color: row.is_active ? "#065f46" : "#4b5563",
                    }}
                    title={row.is_active ? t("training.hide_op") : t("training.show_op")}
                    onClick={() => toggle.mutate({ id: row.id, is_active: !row.is_active })}
                  >
                    {row.is_active ? (
                      <span className="inline-flex items-center gap-1"><Eye className="w-3 h-3" />{t("training.active")}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1"><EyeOff className="w-3 h-3" />{t("training.hidden")}</span>
                    )}
                  </button>
                </div>
                <div className="text-right flex justify-end gap-1.5">
                  <Link
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "6px 10px", fontSize: 12 }}
                    to={`/training/manage/${row.id}?tab=stats`}
                    title={t("training.stats")}
                  >
                    <BarChart3 className="w-3.5 h-3.5" />
                  </Link>
                  <Link
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "6px 10px", fontSize: 12 }}
                    to={`/training/manage/${row.id}`}
                    title={t("common.edit")}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Link>
                  <button
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "6px 10px", fontSize: 12, color: "#b91c1c" }}
                    title={t("common.delete")}
                    onClick={() => {
                      if (window.confirm(t("training.confirm_delete"))) {
                        remove.mutate(row.id);
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
