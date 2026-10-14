import { useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BarChart3, Clock, Download, FileDown, Loader2, MessageSquare, Phone, Users2, Wallet } from "lucide-react";
import { toast } from "../../components/ui";
import { formatDateRu, monthLabel } from "../../lib/period";
import { adminBlobErrorDetail, adminDownloadXlsx } from "../api/admin";
import { useT2 } from "../i18n";
import { EmptyState, PageHeader, cx } from "../ui";

type Period = "today" | "week" | "month" | "custom";
type Range = { date_from: string; date_to: string };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Same windows as the old page: today, last 7 days, last 30 days; custom = chosen dates. */
function periodRange(p: Period, custom: Range): Range {
  const now = new Date();
  const today = iso(now);
  if (p === "today") return { date_from: today, date_to: today };
  if (p === "custom") return custom;
  const past = new Date(now);
  past.setDate(past.getDate() - (p === "week" ? 6 : 29));
  return { date_from: iso(past), date_to: today };
}

interface ReportCard {
  key: string;
  title: string;
  description: string;
  meta: string;
  icon: ComponentType<{ className?: string }>;
  xlsxUrl?: string;
  buildParams?: (r: Range) => Record<string, string>;
  linkTo?: string;
}

interface RecentExport {
  key: string;
  filename: string;
  sizeBytes: number;
  when: number;
  /** v2: params used, so the file can be downloaded again exactly. */
  params?: Record<string, string>;
}

const LS_KEY = "naff:reports:recent";

function loadRecent(): RecentExport[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, 10) : [];
  } catch {
    return [];
  }
}
function saveRecent(list: RecentExport[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* quota / private mode */
  }
}

function fmtSize(bytes: number, t: ReturnType<typeof useT2>): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ${t("reports.unit_kb")}`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function fmtWhen(ms: number, t: ReturnType<typeof useT2>): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return t("v2.admin.reports.justNow");
  if (sec < 3600) return t("v2.admin.reports.minAgo", { n: Math.floor(sec / 60) });
  const d = new Date(ms);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t("v2.admin.reports.todayAt", { time });
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("v2.admin.reports.yesterdayAt", { time });
  return d.toLocaleDateString("ru-RU");
}

export default function Reports() {
  const t = useT2();
  const [period, setPeriod] = useState<Period>("today");
  const [custom, setCustom] = useState<Range>(() => periodRange("month", { date_from: "", date_to: "" }));
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentExport[]>(() => loadRecent());
  useEffect(() => saveRecent(recent), [recent]);

  const range = periodRange(period, custom);
  const customBad = period === "custom" && (!custom.date_from || !custom.date_to || custom.date_from > custom.date_to);
  const rangeLabel = range.date_from === range.date_to ? formatDateRu(range.date_from) : `${formatDateRu(range.date_from)} – ${formatDateRu(range.date_to)}`;
  const payMonth = (r: Range) => {
    const [y, m] = (r.date_to || iso(new Date())).split("-").map(Number);
    return { year: y, month: m };
  };
  const pm = payMonth(range);

  const PERIODS: { value: Period; label: string }[] = [
    { value: "today", label: t("common.today") },
    { value: "week", label: t("common.week") },
    { value: "month", label: t("common.month") },
    { value: "custom", label: t("reports.period_custom") },
  ];

  const CARDS: ReportCard[] = [
    { key: "sales", title: t("reports.card_sales_title"), description: t("reports.card_sales_desc"), meta: rangeLabel, icon: BarChart3, xlsxUrl: "/sales/export.xlsx" },
    {
      key: "attendance",
      title: t("reports.card_attendance_title"),
      description: t("reports.card_attendance_desc"),
      meta: rangeLabel,
      icon: Clock,
      xlsxUrl: "/attendance/report/",
      buildParams: (r) => ({ ...r, format: "xlsx" }),
    },
    {
      key: "payroll",
      title: t("reports.card_payroll_title"),
      description: t("reports.card_payroll_desc"),
      meta: t("v2.admin.reports.payrollMeta", { month: monthLabel(pm.year, pm.month) }),
      icon: Wallet,
      xlsxUrl: "/payroll/monthly/export.xlsx",
      buildParams: (r) => {
        const p = payMonth(r);
        return { year: String(p.year), month: String(p.month) };
      },
    },
    { key: "leads", title: t("reports.card_leads_title"), description: t("reports.card_leads_desc"), meta: rangeLabel, icon: Users2, xlsxUrl: "/analytics/export.xlsx" },
    { key: "activity", title: t("reports.card_activity_title"), description: t("reports.card_activity_desc"), meta: t("reports.card_activity_meta"), icon: Phone, linkTo: "/leads-stats" },
    { key: "channels", title: t("reports.card_channels_title"), description: t("reports.card_channels_desc"), meta: rangeLabel, icon: MessageSquare, xlsxUrl: "/marketing/export.xlsx/" },
  ];

  const run = async (card: ReportCard, params: Record<string, string>) => {
    if (!card.xlsxUrl) {
      toast.error(t("reports.download_failed"));
      return;
    }
    setBusyKey(card.key);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `naff-${card.key}-${stamp}.xlsx`;
      const r = await adminDownloadXlsx(card.xlsxUrl, params, filename);
      setRecent((prev) => [{ key: card.key, filename, sizeBytes: r.size, when: Date.now(), params }, ...prev.filter((x) => x.filename !== filename)]);
      toast.success(t("v2.admin.reports.done", { title: card.title, size: fmtSize(r.size, t) }));
    } catch (err) {
      const { status, detail } = await adminBlobErrorDetail(err);
      if (status === 403) toast.error(t("v2.admin.reports.err403"));
      else if (status === 404) toast.error(t("v2.admin.reports.err404"));
      else toast.error(detail ? `${t("reports.download_failed")}: ${detail}` : t("reports.download_failed"));
    } finally {
      setBusyKey(null);
    }
  };

  const download = (card: ReportCard) => {
    if (customBad) {
      toast.error(t("v2.admin.reports.badRange"));
      return;
    }
    run(card, card.buildParams ? card.buildParams(range) : range);
  };

  const again = (r: RecentExport) => {
    const card = CARDS.find((c) => c.key === r.key);
    if (!card) return;
    if (r.params) run(card, r.params);
    else download(card);
  };

  return (
    <>
      <PageHeader title={t("reports.title")} meta={t("reports.subtitle")}>
        <div className="seg" role="tablist" aria-label={t("common.period")}>
          {PERIODS.map((p) => (
            <button key={p.value} type="button" role="tab" aria-selected={period === p.value} className={cx(period === p.value && "is-on")} onClick={() => setPeriod(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
        {period === "custom" ? (
          <span className="row g6">
            <input className={cx("input num", customBad && "is-bad")} type="date" aria-label={t("v2.admin.reports.from")} style={{ width: 150 }} value={custom.date_from} max={custom.date_to || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, date_from: e.target.value }))} />
            <span className="c3">–</span>
            <input className={cx("input num", customBad && "is-bad")} type="date" aria-label={t("v2.admin.reports.to")} style={{ width: 150 }} value={custom.date_to} min={custom.date_from || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, date_to: e.target.value }))} />
          </span>
        ) : null}
      </PageHeader>
      <main className="page">
        {customBad ? <span className="err">{t("v2.admin.reports.badRange")}</span> : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 16 }}>
          {CARDS.map((c) => {
            const Icon = c.icon;
            const isBusy = busyKey === c.key;
            return (
              <section key={c.key} className="card col g8" style={{ padding: "18px 20px" }}>
                <div className="row between">
                  <span className="icon-tile t-info"><Icon className="ic" /></span>
                  <span className="xs c3 num">{c.meta}</span>
                </div>
                <span className="h3">{c.title}</span>
                <span className="s c3 grow">{c.description}</span>
                {c.linkTo ? (
                  <Link className="btn btn-sm" to={c.linkTo} style={{ alignSelf: "flex-start" }}>
                    {t("reports.open")}<ArrowRight className="ic ic-s" />
                  </Link>
                ) : (
                  <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} disabled={!!busyKey || customBad} onClick={() => download(c)}>
                    {isBusy ? <Loader2 className="ic ic-s" /> : <Download className="ic ic-s" />}
                    {isBusy ? "…" : "Excel"}
                  </button>
                )}
              </section>
            );
          })}
        </div>

        <section className="card tbl">
          <div className="card-h">
            <span className="h3">{t("reports.recent_title")}</span>
            {recent.length > 0 ? (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRecent([])}>{t("v2.admin.reports.clear")}</button>
            ) : null}
          </div>
          {recent.length === 0 ? (
            <EmptyState icon={<FileDown className="ic ic-l" />} title={t("v2.admin.reports.emptyTitle")} body={t("v2.admin.reports.emptyBody")} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 560 }}>
                <div className="tr th" style={{ gridTemplateColumns: "1.6fr 100px 180px 150px" }}>
                  <span>{t("reports.col_file")}</span>
                  <span className="r">{t("reports.col_size")}</span>
                  <span>{t("reports.col_when")}</span>
                  <span />
                </div>
                {recent.map((r, i) => (
                  <div className="tr" key={`${r.filename}-${i}`} style={{ gridTemplateColumns: "1.6fr 100px 180px 150px" }}>
                    <span className="s w6 trunc num">{r.filename}</span>
                    <span className="r num c2">{fmtSize(r.sizeBytes, t)}</span>
                    <span className="s c3">{fmtWhen(r.when, t)}</span>
                    <span className="row g6">
                      {CARDS.some((c) => c.key === r.key && c.xlsxUrl) ? (
                        <button className="btn btn-ghost btn-sm" type="button" disabled={!!busyKey} onClick={() => again(r)}>
                          <Download className="ic ic-s" />{t("v2.admin.reports.again")}
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
