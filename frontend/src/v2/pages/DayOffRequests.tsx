import { useState } from "react";
import { AlertTriangle, CalendarClock, Check, ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import { useDayOffContext, useDayOffDecide, useDayOffPending, type DayOffRow } from "../api/team/people";

const TZ = "Asia/Tashkent";

function locale(lang: string) {
  return lang === "uz" ? "uz-Latn-UZ" : "ru-RU";
}

/** «Сб, 18 октября» for a plain YYYY-MM-DD date (no timezone shift). */
function fmtDayOffDate(iso: string, lang: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = d.toLocaleDateString(locale(lang), { weekday: "short", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtShortDate(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function tashkentYmd(d: Date) {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function DayOffRequests() {
  const t = useT2();
  const q = useDayOffPending();
  const rows = q.data?.results ?? [];

  return (
    <>
      <PageHeader title={t("day_off_admin.title")} meta={t("day_off_admin.subtitle")} />
      <main className="page">
        <section className="card row g16" style={{ padding: "14px 18px" }}>
          <span className="icon-tile t-warn">
            <CalendarClock className="ic" />
          </span>
          <span className="col grow" style={{ minWidth: 0 }}>
            <span className="h3">
              {t("day_off_admin.total_prefix")}: <span className="num">{q.isLoading ? "…" : q.data?.count ?? rows.length}</span>
            </span>
            <span className="s c3">{t("day_off_admin.hint")}</span>
          </span>
        </section>

        {q.isLoading ? (
          <section className="card">
            <LoadingBlock rows={3} onRetry={() => q.refetch()} />
          </section>
        ) : q.isError ? (
          <section className="card">
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </section>
        ) : rows.length === 0 ? (
          <section className="card">
            <EmptyState
              icon={<CalendarClock className="ic ic-l" />}
              title={t("day_off_admin.empty")}
              body={t("v2.team.people.dayOffEmptyBody")}
            />
          </section>
        ) : (
          <div className="col g12" style={{ maxWidth: 960 }}>
            {rows.map((r, i) => (
              <RequestCard key={r.id} row={r} defaultOpen={i === 0} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function RequestCard({ row, defaultOpen }: { row: DayOffRow; defaultOpen: boolean }) {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const [open, setOpen] = useState(defaultOpen);
  const [note, setNote] = useState("");
  const ctx = useDayOffContext(row.id, open);
  const decide = useDayOffDecide(row.id);

  const sent = (() => {
    const d = new Date(row.created_at);
    if (Number.isNaN(d.getTime())) return "";
    const time = d.toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    const day = tashkentYmd(d);
    const today = tashkentYmd(new Date());
    const yesterday = tashkentYmd(new Date(Date.now() - 86400000));
    if (day === today) return t("v2.team.people.sentToday", { time });
    if (day === yesterday) return t("v2.team.people.sentYesterday", { time });
    return t("v2.team.people.sentOn", { date: d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" }), time });
  })();

  const run = (decision: "approve" | "reject") =>
    decide.mutate(
      { decision, note },
      {
        onSuccess: () => toast.success(t(decision === "approve" ? "day_off_admin.approved_toast" : "day_off_admin.rejected_toast")),
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { detail?: string } } };
          toast.error(err.response?.data?.detail || t("day_off_admin.action_failed"));
        },
      },
    );

  const c = ctx.data?.context;
  const noteId = `v2-dayoff-note-${row.id}`;

  return (
    <section className="card col">
      <button
        type="button"
        className="row-item"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "none",
          border: 0,
          borderBottom: open ? "1px solid var(--line)" : 0,
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
        }}
      >
        <span className="ava ava-l">{initials(row.operator_name || "?")}</span>
        <span className="col grow" style={{ minWidth: 0 }}>
          <span className="h3 trunc">{row.operator_name}</span>
          <span className="s c3 trunc">
            {fmtDayOffDate(row.date, lang)}
            {row.reason ? ` · «${row.reason}»` : ""}
          </span>
        </span>
        {sent ? <span className="xs c3 num">{sent}</span> : null}
        {open ? <ChevronUp className="ic" /> : <ChevronDown className="ic" />}
      </button>

      {open ? (
        <>
          {ctx.isLoading ? (
            <LoadingBlock rows={1} />
          ) : c ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, padding: 16 }}>
              <div className="well col g4">
                <span className="lbl">{t("day_off_admin.stat_last_day_off")}</span>
                <span className="num w6">{c.last_day_off ? fmtShortDate(c.last_day_off) : t("day_off_admin.never")}</span>
              </div>
              <div className="well col g4" style={c.others_on_date >= 3 ? { borderColor: "var(--bad-solid)" } : undefined}>
                <span className="lbl">{t("day_off_admin.stat_others")}</span>
                <span className={cx("num w6", c.others_on_date >= 3 && "c-bad")}>{c.others_on_date}</span>
              </div>
              <div className="well col g4">
                <span className="lbl">{t("day_off_admin.stat_sales_7d")}</span>
                <span className="num w6">
                  {c.recent.sales_7d_count} · {fmtNum(c.recent.sales_7d_total)}
                </span>
              </div>
              <div className="well col g4">
                <span className="lbl">{t("day_off_admin.stat_activity_7d")}</span>
                <span className="num w6">
                  {c.recent.leads_7d_touched} · {c.recent.calls_7d_total}
                </span>
                <span className="xs c3">{t("day_off_admin.stat_activity_hint")}</span>
              </div>
            </div>
          ) : (
            // Context failed — the decision must stay possible.
            <div className="banner b-warn" style={{ margin: "16px 16px 0" }}>
              <AlertTriangle className="ic" />
              <span className="grow">{t("v2.team.people.ctxFailed")}</span>
              <button className="btn btn-sm" type="button" onClick={() => ctx.refetch()} disabled={ctx.isFetching}>
                <RefreshCw className="ic" />
                {t("v2.state.retry")}
              </button>
            </div>
          )}

          <div className="col g8" style={{ padding: 16 }}>
            <div className="field">
              <label htmlFor={noteId}>{t("day_off_admin.note_label")}</label>
              <textarea
                id={noteId}
                className="input"
                rows={2}
                value={note}
                maxLength={2000}
                placeholder={t("day_off_admin.note_ph")}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <div className="row g8" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-bad" type="button" disabled={decide.isPending} onClick={() => run("reject")}>
                <X className="ic" />
                {t("day_off_admin.reject_btn")}
              </button>
              <button className="btn btn-ok" type="button" disabled={decide.isPending} onClick={() => run("approve")}>
                <Check className="ic" />
                {t("day_off_admin.approve_btn")}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
