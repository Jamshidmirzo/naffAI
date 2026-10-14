import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, PhoneCall, Users2 } from "lucide-react";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import { useLeadStatuses, useMyActivity, useMySales, type MySaleRow } from "../api/operatorWork";

type Tab = "sales" | "activity";
type Period = "today" | "week" | "month" | "all";
type Preset = "today" | "yesterday" | "week" | "month" | "this_month" | "custom";

const TZ = "Asia/Tashkent";

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function presetRange(p: Preset): { from: string; to: string } | null {
  const now = new Date();
  const today = isoDay(now);
  const back = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return isoDay(d);
  };
  if (p === "today") return { from: today, to: today };
  if (p === "yesterday") return { from: back(1), to: back(1) };
  if (p === "week") return { from: back(6), to: today };
  if (p === "month") return { from: back(29), to: today };
  if (p === "this_month") return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
  return null;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const f = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (k: string) => f.find((x) => x.type === k)?.value ?? "";
  return `${g("day")}.${g("month")} ${g("hour")}:${g("minute")}`;
}

const STATUS_META: Record<string, { tone: string; key: string }> = {
  pending: { tone: "b-warn", key: "v2.mysales.st.pending" },
  confirmed: { tone: "b-ok", key: "v2.mysales.st.confirmed" },
  rejected: { tone: "b-bad", key: "v2.mysales.st.rejected" },
  returned: { tone: "b-bad", key: "v2.mysales.st.returned" },
};

export function SaleStatusBadge({ status }: { status: string }) {
  const t = useT2();
  const m = STATUS_META[status] ?? { tone: "", key: "" };
  return (
    <span className={cx("badge", m.tone)}>
      <i className="dot" />
      {m.key ? t(m.key) : status}
    </span>
  );
}

function plural(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "one";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "few";
  return "many";
}

export default function MySales({ tab = "sales" }: { tab?: Tab }) {
  const t = useT2();
  const nav = useNavigate();
  const lang = useLang((s) => s.lang);
  const monthName = new Intl.DateTimeFormat(lang === "uz" ? "uz-Latn-UZ" : "ru-RU", { month: "long" }).format(new Date());
  const [period, setPeriod] = useState<Period>("month");

  return (
    <>
      <PageHeader title={t("my_sales.title")}>
        {tab === "sales" ? (
          <div className="seg" role="group" aria-label={t("v2.mysales.period")}>
            {(
              [
                ["today", t("reports.activity.presets.today")],
                ["week", t("v2.mysales.week")],
                ["month", monthName.charAt(0).toUpperCase() + monthName.slice(1)],
                ["all", t("v2.mysales.all")],
              ] as Array<[Period, string]>
            ).map(([k, label]) => (
              <button key={k} type="button" className={cx(period === k && "is-on")} onClick={() => setPeriod(k)}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </PageHeader>
      <main className="page">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "sales"} className={cx("tab", tab === "sales" && "is-on")} onClick={() => nav("/my/sales")}>
            {t("v2.mysales.tabSales")}
          </button>
          <button type="button" role="tab" aria-selected={tab === "activity"} className={cx("tab", tab === "activity" && "is-on")} onClick={() => nav("/my/activity")}>
            {t("v2.mysales.tabActivity")}
          </button>
        </div>
        {tab === "sales" ? <SalesTab period={period} /> : <ActivityTab />}
      </main>
    </>
  );
}

function inPeriod(iso: string, p: Period) {
  if (p === "all") return true;
  const ms = Date.parse(iso);
  const now = new Date();
  if (p === "today") return isoDay(new Date(ms)) === isoDay(now);
  if (p === "week") return ms >= now.getTime() - 7 * 86400_000;
  const d = new Date(ms);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function SalesTab({ period }: { period: Period }) {
  const t = useT2();
  const q = useMySales();
  const all = q.data?.results ?? [];
  const rows = useMemo(() => all.filter((s) => inPeriod(s.sold_at, period)), [all, period]);
  const agg = (st: string) => {
    const list = rows.filter((r) => r.status === st);
    return { n: list.length, sum: list.reduce((s, r) => s + (Number(r.share_amount) || 0), 0) };
  };
  const ok = agg("confirmed");
  const wait = agg("pending");
  const bad = agg("rejected");
  const share = rows.reduce((s, r) => s + (Number(r.share_amount) || 0), 0);

  if (q.isLoading) return <section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section>;
  if (q.isError) return <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>;

  const kpi = (label: string, v: { n: number; sum: number }, sub: string, color?: string) => (
    <div className="card pad col g4">
      <span className="lbl">{label}</span>
      <span className="kpi" style={color ? { color } : undefined}>{fmtNum(v.sum)}</span>
      <span className="s c3">
        {t(`v2.mysales.count.${plural(v.n)}`, { n: v.n })} · {sub}
      </span>
    </div>
  );

  const cols = "120px 1.3fr 1.1fr 130px 150px 1.2fr";
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
        {kpi(t("v2.mysales.kpi.ok"), ok, t("v2.mysales.kpi.okSub"))}
        {kpi(t("v2.mysales.kpi.wait"), wait, t("v2.mysales.kpi.waitSub"), "var(--warn)")}
        {kpi(t("v2.mysales.kpi.bad"), bad, t("v2.mysales.kpi.badSub"), "var(--bad)")}
      </div>

      <section className="card tbl">
        <div className="card-h">
          <span className="h3">{t("my_sales.list_title")}</span>
          <span className="xs c3">
            {t("v2.mysales.totals", { n: rows.length, sum: fmtNum(share) })}
            {period === "all" && (q.data?.count ?? 0) >= 100 ? ` · ${t("v2.mysales.last100")}` : ""}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title={all.length ? t("v2.mysales.emptyPeriod") : t("v2.mysales.emptyTitle")}
            body={all.length ? t("v2.mysales.emptyPeriodBody") : t("my_sales.empty")}
            action={<Link className="btn btn-pri" to="/my/sale-new">{t("v2.op.newSale")}</Link>}
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 860 }}>
              <div className="tr th" style={{ gridTemplateColumns: cols }}>
                <span>{t("my_sales.col.date")}</span>
                <span>{t("v2.mysales.col.model")}</span>
                <span>{t("v2.mysales.col.client")}</span>
                <span>{t("v2.mysales.col.partner")}</span>
                <span className="r">{t("v2.mysales.col.share")}</span>
                <span>{t("v2.mysales.col.status")}</span>
              </div>
              {rows.map((s) => (
                <SaleRow key={s.id} s={s} cols={cols} />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function SaleRow({ s, cols }: { s: MySaleRow; cols: string }) {
  const t = useT2();
  const share = Number(s.share_amount) || 0;
  const tot = Number(s.amount_total) || 0;
  const shared = Math.round(share) !== Math.round(tot);
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(s.sold_at)) / 60000));
  const note =
    s.status === "pending"
      ? mins < 60
        ? t("v2.mysales.sentMin", { n: mins })
        : t("v2.mysales.sentLong")
      : s.status === "rejected"
        ? t("v2.mysales.rejNote")
        : "";
  return (
    <Link to={`/sales/${s.id}`} className="tr" style={{ gridTemplateColumns: cols, color: "inherit" }}>
      <span className="num s c2">{fmtWhen(s.sold_at)}</span>
      <span className="w6 trunc">{s.phone_model || "—"}</span>
      <span className="col" style={{ minWidth: 0 }}>
        <span className="trunc">{s.client_name || "—"}</span>
        {s.client_phone ? <span className="num xs c3 trunc">{s.client_phone}</span> : null}
      </span>
      <span className="c2 trunc">{s.channel_name || "—"}</span>
      <span className="r col" style={{ alignItems: "flex-end" }}>
        <span className="num w6">{fmtNum(share)}</span>
        {shared ? <span className="num xs c3">{t("v2.mysales.of", { n: fmtNum(tot) })}</span> : null}
      </span>
      <span className="row g6" style={{ minWidth: 0 }}>
        <SaleStatusBadge status={s.status} />
        {note ? <span className="xs c3 trunc">{note}</span> : null}
        <span className="grow" />
        <ChevronRight className="ic c3" />
      </span>
    </Link>
  );
}

/* ── activity (old MyActivity) ── */

function ActivityTab() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const [preset, setPreset] = useState<Preset>("today");
  const init = presetRange("today")!;
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const rangeBad = !from || !to || from > to;
  const q = useMyActivity(from, to, !rangeBad);
  const statuses = useLeadStatuses();
  const sales = useMySales();

  const apply = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const row = q.data?.rows?.[0] ?? null;
  const byCode = useMemo(() => new Map((statuses.data ?? []).map((s) => [s.code, s])), [statuses.data]);
  const label = (code: string) => {
    const s = byCode.get(code);
    if (!s) return code;
    return lang === "uz" && s.label_uz ? s.label_uz : s.label_ru;
  };
  const toneColor: Record<string, string> = {
    neutral: "var(--ink-3)",
    hot: "var(--hot-solid)",
    danger: "var(--bad-solid)",
    success: "var(--ok-solid)",
    info: "var(--brand)",
  };
  const sorted = row ? (Object.entries(row.by_status) as Array<[string, number]>).sort(([, a], [, b]) => b - a) : [];
  const max = sorted[0]?.[1] ?? 0;

  const periodSales = (sales.data?.results ?? []).filter((s) => {
    const d = isoDay(new Date(s.sold_at));
    return d >= from && d <= to;
  });
  const periodShare = periodSales.reduce((s, r) => s + (Number(r.share_amount) || 0), 0);

  const presets: Array<[Preset, string]> = [
    ["today", t("reports.activity.presets.today")],
    ["yesterday", t("reports.activity.presets.yesterday")],
    ["week", t("reports.activity.presets.week")],
    ["month", t("reports.activity.presets.month")],
    ["this_month", t("reports.activity.presets.this_month")],
    ["custom", t("reports.activity.presets.custom")],
  ];

  return (
    <>
      <div className="row g8 wrap">
        {presets.map(([k, l]) => (
          <button key={k} type="button" className={cx("chip", preset === k && "is-on")} onClick={() => apply(k)}>
            {l}
          </button>
        ))}
        {preset === "custom" ? (
          <span className="row g8 wrap">
            <input className={cx("input num", rangeBad && "is-bad")} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label={t("v2.mysales.from")} style={{ width: 160, height: 32 }} />
            <span className="c3">—</span>
            <input className={cx("input num", rangeBad && "is-bad")} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label={t("v2.mysales.to")} style={{ width: 160, height: 32 }} />
          </span>
        ) : null}
      </div>
      {rangeBad ? <span className="err">{t("v2.mysales.rangeBad")}</span> : null}

      {rangeBad ? null : q.isLoading ? (
        <section className="card"><LoadingBlock rows={4} onRetry={() => q.refetch()} /></section>
      ) : q.isError ? (
        <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
      ) : !row ? (
        <section className="card"><EmptyState title={t("reports.activity.empty")} body={t("v2.mysales.actEmptyBody")} /></section>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            <div className="card pad row g12">
              <span className="icon-tile"><Users2 className="ic" /></span>
              <span className="col g4">
                <span className="lbl">{t("reports.activity.col.unique_leads")}</span>
                <span className="kpi">{fmtNum(row.unique_leads_touched)}</span>
              </span>
            </div>
            <div className="card pad row g12">
              <span className="icon-tile"><PhoneCall className="ic" /></span>
              <span className="col g4">
                <span className="lbl">{t("reports.activity.col.calls_total")}</span>
                <span className="kpi">{fmtNum(row.calls_total)}</span>
              </span>
            </div>
            <Link className="card pad col g4" to="/my/sales" style={{ color: "inherit" }}>
              <span className="lbl">{t("my_activity.my_sales_title")}</span>
              <span className="kpi">{fmtNum(periodSales.length)}</span>
              <span className="s c3">
                {t("v2.mysales.shareSum", { sum: fmtNum(periodShare) })} · {t("v2.mysales.openAll")}
              </span>
            </Link>
          </div>

          <section className="card col">
            <div className="card-h"><span className="h3">{t("reports.activity.by_status_title")}</span></div>
            {sorted.length === 0 ? (
              <EmptyState title={t("reports.activity.no_statuses")} />
            ) : (
              sorted.map(([code, n]) => (
                <div key={code} className="tr" style={{ gridTemplateColumns: "1fr 2fr 60px" }}>
                  <span className="row g8" style={{ minWidth: 0 }}>
                    <i className="dot" style={{ color: toneColor[byCode.get(code)?.tone ?? "neutral"] }} />
                    <span className="trunc">{label(code)}</span>
                  </span>
                  <span className="bar" aria-hidden="true">
                    <i style={{ width: `${max ? (n / max) * 100 : 0}%`, background: toneColor[byCode.get(code)?.tone ?? "neutral"] }} />
                  </span>
                  <span className="r num w6">{n}</span>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </>
  );
}
