import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Loader2, PauseCircle, Play, RefreshCw } from "lucide-react";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import { useTgqQueue, useTgqRetry, type TgqRow, type TgqSessionStatus } from "../api/admin";

const COLS = "minmax(170px,1.2fr) minmax(200px,1.5fr) minmax(200px,1.5fr) 60px 90px 50px 130px";

const SESSION_TONE: Record<TgqSessionStatus, string> = {
  active: "b-ok",
  pending_code: "b-warn",
  pending_2fa: "b-warn",
  error: "b-bad",
  expired: "",
  revoked: "",
  none: "",
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/** /tg-queue — operator Telegram sessions and history backfill (MgTgQueue). Polls every 5 s. */
export default function TgQueue() {
  const t = useT2();
  const nav = useNavigate();
  const q = useTgqQueue();
  const retry = useTgqRetry();
  const rows = q.data?.queue ?? [];

  const rel = (iso: string | null) => {
    if (!iso) return "—";
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return t("tg_queue.just_now");
    if (min < 60) return t("tg_queue.min_ago", { n: min });
    const h = Math.round(min / 60);
    if (h < 24) return t("tg_queue.hour_ago", { n: h });
    return t("tg_queue.day_ago", { n: Math.round(h / 24) });
  };

  const totals = useMemo(() => {
    const x = { active: 0, connecting: 0, running: 0, none: 0, error: 0, chats: 0, msgs: 0, ai: 0 };
    for (const r of rows) {
      x.chats += r.chats_count;
      x.msgs += r.messages_count;
      x.ai += r.insights_count;
      if (r.session_status === "active") x.active++;
      else if (r.session_status === "pending_code" || r.session_status === "pending_2fa") x.connecting++;
      else if (r.session_status === "error" || r.session_status === "expired") x.error++;
      else if (r.session_status === "none") x.none++;
      if (r.latest_job?.status === "running") x.running++;
    }
    return x;
  }, [rows]);

  const tile = (label: string, value: number, opts: { color?: string; sub?: string; bad?: boolean } = {}) => (
    <section className="card col g4 pad" style={opts.bad ? { borderColor: "var(--bad-solid)" } : undefined}>
      <span className="lbl">{label}</span>
      <span className="kpi" style={{ fontSize: 22, color: opts.color }}>{fmtNum(value)}</span>
      {opts.sub ? <span className="xs c3">{opts.sub}</span> : null}
    </section>
  );

  const jobCell = (r: TgqRow) => {
    const j = r.latest_job;
    if (!j) return <span className="s c3">—</span>;
    if (j.status === "running")
      return (
        <span className="row g6 s c-brand" style={{ minWidth: 0 }}>
          <Loader2 className="ic ic-s" style={{ animation: "spin 1s linear infinite" }} />
          <span className="trunc">{t("v2.admin.tgq.loading", { c: fmtNum(j.chats_scanned), m: fmtNum(j.messages_saved) })}</span>
        </span>
      );
    if (j.status === "done")
      return (
        <span className="row g6 s c-ok" style={{ minWidth: 0 }}>
          <CheckCircle2 className="ic ic-s" />
          <span className="trunc">{j.finished_at ? t("v2.admin.tgq.doneAgo", { ago: rel(j.finished_at) }) : t("tg_queue.job_done")}</span>
        </span>
      );
    if (j.status === "error")
      return (
        <span className="row g6 s c-bad" style={{ minWidth: 0 }} title={j.last_error || undefined}>
          <AlertTriangle className="ic ic-s" />
          <span className="trunc">{j.last_error ? t("v2.admin.tgq.errorJob", { err: j.last_error }) : t("tg_queue.job_error")}</span>
        </span>
      );
    return (
      <span className="row g6 s c3">
        <PauseCircle className="ic ic-s" />
        {t("tg_queue.job_pending")}
      </span>
    );
  };

  const sessionSub = (r: TgqRow) => {
    if (r.last_error) return <span className="xs c-bad trunc" title={r.last_error}>{r.last_error}</span>;
    if (r.last_connected_at) return <span className="xs c3 trunc">{t("v2.admin.tgq.connectedAt", { at: fmtDate(r.last_connected_at) })}</span>;
    return null;
  };

  const num = (n: number, accent?: boolean) => <span className={cx("r num", n > 0 ? (accent ? "c-brand w6" : "w6") : "c3")}>{n > 0 ? fmtNum(n) : "—"}</span>;

  return (
    <>
      <PageHeader title={t("tg_queue.title")} meta={t("tg_queue.subtitle")}>
        <span className="row g6 s c3">
          <i className="dot" style={{ color: q.isError ? "var(--bad-solid)" : "var(--ok-solid)" }} />
          {t("tg_queue.auto_refresh")} · {t("tg_queue.operators_count", { n: q.data?.total ?? 0 })}
        </span>
      </PageHeader>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      <main className="page">
        {q.isLoading ? (
          <section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section>
        ) : q.isError && !q.data ? (
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              {tile(t("tg_queue.tile_active"), totals.active, { color: "var(--ok)" })}
              {tile(t("tg_queue.tile_connecting"), totals.connecting, { sub: t("v2.admin.tgq.connectingSub") })}
              {tile(t("tg_queue.tile_running"), totals.running)}
              {tile(t("tg_queue.tile_none"), totals.none)}
              {tile(t("tg_queue.tile_errors"), totals.error, totals.error > 0 ? { color: "var(--bad)", bad: true } : {})}
              {tile(t("tg_queue.tile_total_msgs"), totals.msgs)}
            </div>
            <section className="card tbl">
              {rows.length === 0 ? (
                <EmptyState title={t("v2.admin.tgq.emptyTitle")} body={t("v2.admin.tgq.emptyBody")} />
              ) : (
                <div className="scroll-x">
                  <div style={{ minWidth: 960 }}>
                    <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                      <span>{t("common.operator")}</span>
                      <span>{t("tg_queue.col_session")}</span>
                      <span>{t("tg_queue.col_backfill")}</span>
                      <span className="r">{t("tg_queue.col_chats")}</span>
                      <span className="r">{t("tg_queue.col_msgs")}</span>
                      <span className="r">{t("tg_queue.col_ai")}</span>
                      <span />
                    </div>
                    {rows.map((r) => {
                      const canRetry = r.session_status === "active" && r.latest_job?.status === "error";
                      const retrying = retry.isPending && retry.variables === r.operator_id;
                      return (
                        <div
                          key={r.operator_id}
                          className="tr"
                          role="link"
                          tabIndex={0}
                          style={{ gridTemplateColumns: COLS, minHeight: 60, cursor: "pointer" }}
                          onClick={() => nav(`/operators/${r.operator_id}`)}
                          onKeyDown={(e) => e.key === "Enter" && nav(`/operators/${r.operator_id}`)}
                        >
                          <span className="row g8" style={{ minWidth: 0 }}>
                            <span className="ava ava-s">{initials(r.operator_name)}</span>
                            <span className="trunc">{r.operator_name}</span>
                          </span>
                          <span className="col g4" style={{ minWidth: 0 }}>
                            <span className="row g6" style={{ minWidth: 0 }}>
                              <span className={cx("badge", SESSION_TONE[r.session_status])}>{t(`tg_queue.session_${r.session_status}`)}</span>
                              {r.tg_username ? <span className="num xs c2 trunc">@{r.tg_username}</span> : null}
                            </span>
                            {sessionSub(r)}
                          </span>
                          {jobCell(r)}
                          {num(r.chats_count)}
                          {num(r.messages_count)}
                          {num(r.insights_count, true)}
                          <span onClick={(e) => e.stopPropagation()}>
                            {canRetry ? (
                              <button
                                className="btn btn-sm"
                                type="button"
                                title={t("tg_queue.retry_backfill")}
                                disabled={retrying}
                                onClick={() =>
                                  retry.mutate(r.operator_id, {
                                    onSuccess: () => toast.success(t("tg_queue.retry_ok")),
                                    onError: () => toast.error(t("tg_queue.retry_fail")),
                                  })
                                }
                              >
                                <RefreshCw className="ic ic-s" />
                                {t("v2.admin.tgq.retry")}
                              </button>
                            ) : r.session_status === "none" ? (
                              <Link className="btn btn-sm" to={`/operators/${r.operator_id}`} title={t("tg_queue.connect_tg")}>
                                <Play className="ic ic-s" />
                                {t("tg_queue.connect")}
                              </Link>
                            ) : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="row g8 wrap" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
                <span className="xs c3">{t("common.total")}:</span>
                <span className="chip" style={{ height: 28 }}>{t("tg_queue.chats_long", { n: fmtNum(totals.chats) })}</span>
                <span className="chip" style={{ height: 28 }}>{t("tg_queue.msgs_long", { n: fmtNum(totals.msgs) })}</span>
                <span className="chip" style={{ height: 28 }}>{t("tg_queue.ai_insights", { n: fmtNum(totals.ai) })}</span>
              </div>
            </section>
            <p className="xs c3">{t("v2.admin.tgq.hint")}</p>
          </>
        )}
      </main>
    </>
  );
}
