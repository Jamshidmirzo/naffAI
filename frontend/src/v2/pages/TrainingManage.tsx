import { Link, useNavigate } from "react-router-dom";
import { BarChart3, Eye, EyeOff, GraduationCap, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  useTrainingHide,
  useTrainingManageList,
  useTrainingToggleActive,
  type TrainingRow,
} from "../api/team/trainingLive";

const COLS = "minmax(0, 1fr) 120px 90px 80px 120px 132px";

export default function TrainingManage() {
  const t = useT2();
  const nav = useNavigate();
  const confirm = useConfirm();
  const list = useTrainingManageList();
  const hide = useTrainingHide();
  const toggle = useTrainingToggleActive();
  const rows = list.data ?? [];

  const askHide = async (row: TrainingRow, viaDelete: boolean) => {
    const ok = await confirm({
      title: t("v2.team.trainingLive.hideTitle", { title: row.title }),
      body:
        row.attempts_count > 0
          ? t("v2.team.trainingLive.hideBodyAttempts", { n: row.attempts_count })
          : t("v2.team.trainingLive.hideBody"),
      confirm: t("v2.team.trainingLive.hideConfirm"),
    });
    if (!ok) return;
    if (viaDelete) {
      hide.mutate(row.id, {
        onSuccess: () => toast.success(t("training.deleted")),
        onError: () => toast.error(t("v2.team.trainingLive.actionFailed")),
      });
    } else {
      toggle.mutate(
        { id: row.id, is_active: false },
        {
          onSuccess: () => toast.success(t("training.deleted")),
          onError: () => toast.error(t("v2.team.trainingLive.actionFailed")),
        },
      );
    }
  };

  const show = (row: TrainingRow) =>
    toggle.mutate(
      { id: row.id, is_active: true },
      {
        onSuccess: () => toast.success(t("v2.team.trainingLive.shown")),
        onError: () => toast.error(t("v2.team.trainingLive.actionFailed")),
      },
    );

  return (
    <>
      <PageHeader title={t("training.manage_title")} meta={list.data ? t("training.total_n", { n: rows.length }) : undefined}>
        <button className="btn btn-pri" type="button" onClick={() => nav("/training/manage/new")}>
          <Plus className="ic" />
          {t("training.new")}
        </button>
      </PageHeader>
      <main className="page">
        <p className="s c3" style={{ marginTop: -6 }}>{t("v2.team.trainingLive.manageSub")}</p>
        <section className="card tbl" style={{ overflowX: "auto" }}>
          {list.isLoading ? (
            <LoadingBlock rows={5} onRetry={() => list.refetch()} />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<GraduationCap className="ic ic-l" />}
              title={t("v2.team.trainingLive.emptyTitle")}
              body={t("training.empty_hint_manager")}
              action={
                <button className="btn btn-pri" type="button" onClick={() => nav("/training/manage/new")}>
                  <Plus className="ic" />
                  {t("training.new")}
                </button>
              }
            />
          ) : (
            <div style={{ minWidth: 760 }}>
              <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                <span>{t("training.col_title")}</span>
                <span>{t("training.col_media")}</span>
                <span className="r">{t("training.col_questions")}</span>
                <span className="r">{t("training.col_attempts")}</span>
                <span>{t("common.status")}</span>
                <span className="r">{t("common.actions")}</span>
              </div>
              {rows.map((row) => {
                const media =
                  [row.video_url ? t("training.video") : null, row.file_url ? t("training.file") : null].filter(Boolean).join(" · ") || "—";
                const busy = (toggle.isPending && toggle.variables?.id === row.id) || (hide.isPending && hide.variables === row.id);
                return (
                  <div key={row.id} className="tr" style={{ gridTemplateColumns: COLS, minHeight: 58 }}>
                    <Link to={`/training/manage/${row.id}`} className="col" style={{ minWidth: 0, color: "inherit", textDecoration: "none" }}>
                      <span className="w6 trunc">{row.title}</span>
                      {row.description ? <span className="xs c3 trunc">{row.description}</span> : null}
                    </Link>
                    <span className="s c2">{media}</span>
                    <span className="r num">{fmtNum(row.questions_count)}</span>
                    <span className="r num">{fmtNum(row.attempts_count)}</span>
                    <span>
                      <button
                        className={cx("badge", row.is_active && "b-ok")}
                        type="button"
                        style={{ border: 0, cursor: "pointer" }}
                        disabled={busy}
                        title={row.is_active ? t("training.hide_op") : t("training.show_op")}
                        onClick={() => (row.is_active ? askHide(row, false) : show(row))}
                      >
                        {row.is_active ? <Eye className="ic ic-s" /> : <EyeOff className="ic ic-s" />}
                        {row.is_active ? t("training.active") : t("training.hidden")}
                      </button>
                    </span>
                    <span className="row g4" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn btn-sm btn-ghost btn-sq" to={`/training/manage/${row.id}?tab=stats`} title={t("training.stats")} aria-label={t("training.stats")}>
                        <BarChart3 className="ic" />
                      </Link>
                      <Link className="btn btn-sm btn-ghost btn-sq" to={`/training/manage/${row.id}`} title={t("common.edit")} aria-label={t("common.edit")}>
                        <Pencil className="ic" />
                      </Link>
                      <button
                        className="btn btn-sm btn-ghost btn-sq"
                        type="button"
                        style={{ color: "var(--bad)" }}
                        disabled={!row.is_active || busy}
                        title={row.is_active ? t("v2.team.trainingLive.hideAction") : t("v2.team.trainingLive.alreadyHidden")}
                        aria-label={t("v2.team.trainingLive.hideAction")}
                        onClick={() => askHide(row, true)}
                      >
                        <Trash2 className="ic" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
      {confirm.node}
    </>
  );
}
