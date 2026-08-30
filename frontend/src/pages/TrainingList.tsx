import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, FileText, Play, MessageSquare } from "lucide-react";
import { api } from "../lib/api";
import { Eyebrow } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface Row {
  id: number;
  title: string;
  description: string;
  has_video: boolean;
  has_file: boolean;
  has_media: boolean;
  questions_count: number;
  comments_count: number;
  created_at: string;
  attempt_completed: boolean;
  score_pct: number | null;
}

export default function TrainingList() {
  const t = useT();
  usePageHeader({ title: t("training.title"), subtitle: t("training.subtitle_operator") });

  const q = useQuery<Row[]>({
    queryKey: ["training-my-list"],
    queryFn: () => api.get("/training/my-lessons/").then((r) => r.data),
  });

  const rows = q.data || [];

  return (
    <div className="mx-auto max-w-[1080px] flex flex-col gap-5">
      {q.isLoading ? (
        <div className="text-muted text-[13px]">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="nf-card p-10 text-center">
          <Eyebrow>{t("training.empty_eyebrow")}</Eyebrow>
          <div className="text-[15px] mt-2">{t("training.empty_hint_operator")}</div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((row, i) => (
            <Link
              to={`/training/${row.id}`}
              key={row.id}
              className="nf-card p-5 flex flex-col gap-3 animate-nfFadeUp hover:-translate-y-[2px] transition-transform"
              style={{ animationDelay: `${0.02 + i * 0.03}s` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="text-[16px] font-semibold leading-snug">{row.title}</div>
                {row.attempt_completed ? (
                  <span className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {row.score_pct != null ? `${row.score_pct}%` : t("training.done")}
                  </span>
                ) : (
                  <span className="text-[12px] px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">
                    {t("training.not_done")}
                  </span>
                )}
              </div>
              {row.description && (
                <div className="text-[13px] text-muted line-clamp-3">{row.description}</div>
              )}
              <div className="flex items-center gap-3 text-[12px] text-muted mt-auto pt-2">
                {row.has_video && (
                  <span className="inline-flex items-center gap-1">
                    <Play className="w-3.5 h-3.5" /> {t("training.video")}
                  </span>
                )}
                {row.has_file && (
                  <span className="inline-flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5" /> {t("training.file")}
                  </span>
                )}
                {row.questions_count > 0 && (
                  <span>{t("training.q_n", { n: row.questions_count })}</span>
                )}
                {row.comments_count > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="w-3.5 h-3.5" /> {row.comments_count}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
