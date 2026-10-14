import { useMemo, useState, type ReactNode } from "react";
import { Download, Loader2, X } from "lucide-react";
import { toast } from "../../components/ui";
import { buildPeriodParams, monthLabel, periodTitle, recentMonths, type MonthChoice } from "../../lib/period";
import {
  adminBlobErrorDetail,
  adminDownloadXlsx,
  useAnByChannel,
  useAnByModel,
  useAnBySource,
  useAnCallbackHeatmap,
  useAnLeaderboard,
  useAnOperatorFunnels,
  type AnHeatmap,
} from "../api/admin";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, fmtNum } from "../ui";

type T = ReturnType<typeof useT2>;

function mln(n: number, t: T) {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "").replace(".", ",")} ${t("v2.admin.analytics.mln")}`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} ${t("v2.admin.analytics.thousand")}`;
  return String(Math.round(n));
}

function pct1(n: number, of: number) {
  if (!of) return "0%";
  return `${(Math.round((n / of) * 1000) / 10).toString().replace(".", ",")}%`;
}

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isoMonthStart = () => isoToday().slice(0, 8) + "01";

/** Month select + reset + optional date range, same choices as the old MonthPicker. */
function AnPeriodPicker({ value, onChange }: { value: MonthChoice; onChange: (v: MonthChoice) => void }) {
  const t = useT2();
  const months = useMemo(() => recentMonths(12), []);
  const sel =
    value.kind === "specific" ? `m:${value.year}-${value.month}` : value.kind === "range" ? "range" : value.kind;
  const onSel = (v: string) => {
    if (v === "current") onChange({ kind: "current" });
    else if (v === "all") onChange({ kind: "all" });
    else if (v === "range") onChange({ kind: "range", from: isoMonthStart(), to: isoToday() });
    else {
      const [y, m] = v.slice(2).split("-").map(Number);
      onChange({ kind: "specific", year: y, month: m });
    }
  };
  return (
    <div className="row g6 wrap">
      <select className="input" aria-label={t("dash.month_picker")} style={{ width: 200 }} value={sel} onChange={(e) => onSel(e.target.value)}>
        <option value="current">{t("v2.admin.analytics.currentMonth")}</option>
        <option value="all">{t("v2.admin.analytics.allTime")}</option>
        {months.map((m) => (
          <option key={`${m.year}-${m.month}`} value={`m:${m.year}-${m.month}`}>{monthLabel(m.year, m.month)}</option>
        ))}
        <option value="range">{t("v2.admin.analytics.customRange")}</option>
      </select>
      {value.kind === "range" ? (
        <>
          <input className="input num" type="date" aria-label={t("v2.admin.analytics.from")} style={{ width: 150 }} value={value.from} max={value.to}
            onChange={(e) => e.target.value && onChange({ kind: "range", from: e.target.value, to: value.to })} />
          <span className="c3">—</span>
          <input className="input num" type="date" aria-label={t("v2.admin.analytics.to")} style={{ width: 150 }} value={value.to} min={value.from}
            onChange={(e) => e.target.value && onChange({ kind: "range", from: value.from, to: e.target.value })} />
        </>
      ) : null}
      {value.kind !== "current" ? (
        <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.admin.analytics.resetMonth")} title={t("v2.admin.analytics.resetMonth")} onClick={() => onChange({ kind: "current" })}>
          <X className="ic" />
        </button>
      ) : null}
    </div>
  );
}

function CardHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="card-h">
      <div className="col" style={{ minWidth: 0 }}>
        <span className="h3">{title}</span>
        {sub ? <span className="xs c3">{sub}</span> : null}
      </div>
      {right}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty" style={{ padding: "22px 16px" }}>
      <span className="s">{text}</span>
    </div>
  );
}

export default function Analytics() {
  const t = useT2();
  const [choice, setChoice] = useState<MonthChoice>({ kind: "current" });
  const params = buildPeriodParams("month", choice);
  const title = periodTitle("month", choice);
  const [busy, setBusy] = useState(false);

  const lb = useAnLeaderboard(params);
  const ch = useAnByChannel(params);
  const md = useAnByModel(params);
  const src = useAnBySource(params);
  const funnels = useAnOperatorFunnels();
  const heatmap = useAnCallbackHeatmap();

  const team = useMemo(
    () =>
      (funnels.data ?? []).reduce(
        (a, r) => ({ leads: a.leads + r.leads_total, contacted: a.contacted + r.contacted, callbacks: a.callbacks + r.callbacks, sales: a.sales + r.sales }),
        { leads: 0, contacted: 0, callbacks: 0, sales: 0 },
      ),
    [funnels.data],
  );

  const channels = useMemo(() => {
    const rows = (ch.data ?? []).slice(0, 6);
    const total = rows.reduce((a, r) => a + Number(r.total), 0);
    return { total, rows: rows.map((r) => ({ name: r.channel_name, total: Number(r.total), pct: total ? Math.round((Number(r.total) / total) * 100) : 0 })) };
  }, [ch.data]);

  const exportXlsx = async () => {
    setBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await adminDownloadXlsx("/analytics/export.xlsx", params, `naff-analytics-${stamp}.xlsx`);
      toast.success(t("v2.admin.reports.done", { title: t("analytics.title"), size: `${Math.max(1, Math.round(r.size / 1024))} KB` }));
    } catch (err) {
      const { status, detail } = await adminBlobErrorDetail(err);
      toast.error(status === 403 ? t("v2.admin.reports.err403") : status === 404 ? t("v2.admin.reports.err404") : detail || t("reports.download_failed"));
    } finally {
      setBusy(false);
    }
  };

  const steps: { label: string; n: number; ok?: boolean }[] = [
    { label: t("v2.admin.analytics.stLeads"), n: team.leads },
    { label: t("v2.admin.analytics.stContacted"), n: team.contacted },
    { label: t("v2.admin.analytics.stCallback"), n: team.callbacks },
    { label: t("v2.admin.analytics.stSales"), n: team.sales, ok: true },
  ];

  const srcRows = src.data ?? [];
  const srcMax = Math.max(1, ...srcRows.map((x) => Number(x.total)));
  const lbRows = lb.data ?? [];
  const lbMax = Math.max(1, ...lbRows.map((x) => Number(x.total)));
  const mdRows = (md.data ?? []).slice(0, 12);

  return (
    <>
      <PageHeader title={t("analytics.title")} meta={`${t("v2.admin.analytics.sub")} · ${title}`}>
        <AnPeriodPicker value={choice} onChange={setChoice} />
        <button className="btn" type="button" onClick={exportXlsx} disabled={busy}>
          {busy ? <Loader2 className="ic" /> : <Download className="ic" />}Excel
        </button>
      </PageHeader>
      <main className="page">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
          <section className="card col">
            <CardHead title={t("v2.admin.analytics.funnelTitle")} sub={t("v2.admin.analytics.funnelSub")} right={<span className="xs c3">{t("v2.admin.analytics.top20")}</span>} />
            {funnels.isLoading ? (
              <LoadingBlock rows={4} onRetry={() => funnels.refetch()} />
            ) : funnels.isError ? (
              <ErrorState error={funnels.error} onRetry={() => funnels.refetch()} />
            ) : (
              <div className="col g12" style={{ padding: "18px 20px 20px" }}>
                {steps.map((s, i) => (
                  <div className="col g6" key={s.label}>
                    <div className="row between s">
                      <span className="w6">{s.label}</span>
                      <span className="row g8"><span className="num w6">{fmtNum(s.n)}</span><span className="xs c3">{i === 0 ? (s.n ? "100%" : "—") : pct1(s.n, team.leads)}</span></span>
                    </div>
                    <span className="bar" style={{ height: 22, borderRadius: 7 }}>
                      <i className={s.ok ? "ok" : undefined} style={{ width: `${team.leads ? Math.max(s.n ? 2 : 0, Math.min(100, (s.n / team.leads) * 100)) : 0}%`, borderRadius: 7 }} />
                    </span>
                  </div>
                ))}
                <span className="xs c3">{t("v2.admin.analytics.funnelNote")}</span>
              </div>
            )}
          </section>

          <section className="card col">
            <CardHead
              title={t("analytics.channels_title")}
              sub={t("analytics.channels_hint", { period: title })}
              right={channels.total ? <span className="num s w6">{fmtNum(channels.total)} {t("v2.admin.analytics.sum")}</span> : null}
            />
            {ch.isLoading ? (
              <LoadingBlock rows={4} onRetry={() => ch.refetch()} />
            ) : ch.isError ? (
              <ErrorState error={ch.error} onRetry={() => ch.refetch()} />
            ) : channels.rows.length === 0 ? (
              <Empty text={t("common.no_data")} />
            ) : (
              <div className="col g12" style={{ padding: "18px 20px 20px" }}>
                {channels.rows.map((c, i) => (
                  <div className="col g6" key={c.name || i}>
                    <div className="row between s">
                      <span className="w6 trunc">{c.name || "—"}</span>
                      <span className="row g8"><span className="num c2">{fmtNum(c.total)}</span><span className="num w6" style={{ width: 40, textAlign: "right" }}>{c.pct}%</span></span>
                    </div>
                    <span className="bar"><i style={{ width: `${c.pct}%`, opacity: i === 0 ? 1 : Math.max(0.35, 0.8 - i * 0.1) }} /></span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))", gap: 16, alignItems: "start" }}>
          <section className="card tbl">
            <CardHead
              title={t("analytics.by_source_title")}
              sub={t("analytics.by_source_hint", { period: title })}
              right={<span className="row g6 xs c3"><i className="dot" style={{ color: "var(--brand)" }} />{t("v2.admin.analytics.convFrom3")}</span>}
            />
            {src.isLoading ? (
              <LoadingBlock rows={5} onRetry={() => src.refetch()} />
            ) : src.isError ? (
              <ErrorState error={src.error} onRetry={() => src.refetch()} />
            ) : srcRows.length === 0 ? (
              <Empty text={t("common.no_data")} />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: 520 }}>
                  <div className="tr th" style={{ gridTemplateColumns: "1.5fr 70px 70px 90px 140px" }}>
                    <span>{t("analytics.by_source_col_name")}</span>
                    <span className="r">{t("analytics.by_source_col_leads")}</span>
                    <span className="r">{t("analytics.by_source_col_sales")}</span>
                    <span className="r">{t("analytics.by_source_col_conv")}</span>
                    <span className="r">{t("analytics.by_source_col_revenue")}</span>
                  </div>
                  {srcRows.map((r, i) => (
                    <div className="tr" key={r.sheet_source_id ?? `direct-${i}`} style={{ gridTemplateColumns: "1.5fr 70px 70px 90px 140px", minHeight: 56 }}>
                      <span className="col g6" style={{ minWidth: 0 }}>
                        <span className="s w6 trunc">{r.sheet_source_name}</span>
                        <span className="bar" style={{ height: 5 }}><i style={{ width: `${(Number(r.total) / srcMax) * 100}%`, opacity: i === 0 ? 1 : Math.max(0.4, 0.75 - i * 0.08) }} /></span>
                      </span>
                      <span className="r num">{fmtNum(r.leads_count)}</span>
                      <span className="r num">{fmtNum(r.sales_count)}</span>
                      <span className={`r num w6 ${r.conversion_pct >= 3 ? "c-brand" : "c3"}`}>{String(r.conversion_pct).replace(".", ",")}%</span>
                      <span className="r num">{fmtNum(r.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="card col">
            <CardHead
              title={t("analytics.top_operators_title")}
              sub={t("analytics.top_operators_hint", { period: title })}
              right={lbRows.length ? <span className="xs c3">{t("v2.admin.analytics.nOfM", { n: Math.min(10, lbRows.length), m: lbRows.length })}</span> : null}
            />
            {lb.isLoading ? (
              <LoadingBlock rows={5} onRetry={() => lb.refetch()} />
            ) : lb.isError ? (
              <ErrorState error={lb.error} onRetry={() => lb.refetch()} />
            ) : lbRows.length === 0 ? (
              <Empty text={t("common.no_data")} />
            ) : (
              <div className="col g12" style={{ padding: "16px 20px 18px" }}>
                {lbRows.slice(0, 10).map((r, i) => (
                  <div className="row g12" key={r.operator_id}>
                    <span className={`rank ${i === 0 ? "r1" : ""}`} style={{ width: 24, height: 24, fontSize: 12 }}>{i + 1}</span>
                    <span className="col g4 grow">
                      <span className="s w5 trunc">{r.operator_name}</span>
                      <span className="bar" style={{ height: 5 }}><i style={{ width: `${(Number(r.total) / lbMax) * 100}%` }} /></span>
                    </span>
                    <span className="num s w6" style={{ width: 80, textAlign: "right" }}>{mln(Number(r.total), t)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="card tbl">
          <CardHead
            title={t("v2.admin.analytics.modelsTitle")}
            sub={`${t("v2.admin.analytics.modelsSub")} · ${title}`}
            right={mdRows.length ? <span className="xs c3">{t("v2.admin.analytics.nModels", { n: mdRows.length })}</span> : null}
          />
          {md.isLoading ? (
            <LoadingBlock rows={5} onRetry={() => md.refetch()} />
          ) : md.isError ? (
            <ErrorState error={md.error} onRetry={() => md.refetch()} />
          ) : mdRows.length === 0 ? (
            <Empty text={t("common.no_data")} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <div className="tr th" style={{ gridTemplateColumns: "1.5fr 80px 150px" }}>
                <span>{t("v2.admin.analytics.colModel")}</span>
                <span className="r">{t("v2.admin.analytics.colCount")}</span>
                <span className="r">{t("v2.admin.analytics.colSum")}</span>
              </div>
              {mdRows.map((r, i) => (
                <div className="tr" key={`${r.phone_model}-${i}`} style={{ gridTemplateColumns: "1.5fr 80px 150px", minHeight: 40 }}>
                  <span className="s w6 trunc">{r.phone_model || "—"}</span>
                  <span className="r num c2">{fmtNum(r.count)}</span>
                  <span className="r num w6">{fmtNum(r.total)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card col">
          <CardHead
            title={t("v2.admin.analytics.heatTitle")}
            sub={t("v2.admin.analytics.heatSub")}
            right={
              <span className="row g6 xs c3">
                {t("v2.admin.analytics.less")}
                <span className="row" style={{ gap: 2 }}>
                  {[0, 30, 60, 100].map((p) => (
                    <i key={p} style={{ display: "block", width: 14, height: 14, borderRadius: 4, background: p ? `color-mix(in srgb, var(--brand) ${p}%, var(--surface-3))` : "var(--surface-3)" }} />
                  ))}
                </span>
                {t("v2.admin.analytics.more")}
              </span>
            }
          />
          {heatmap.isLoading ? (
            <LoadingBlock rows={4} onRetry={() => heatmap.refetch()} />
          ) : heatmap.isError ? (
            <ErrorState error={heatmap.error} onRetry={() => heatmap.refetch()} />
          ) : (
            <Heatmap payload={heatmap.data} />
          )}
        </section>
      </main>
    </>
  );
}

function Heatmap({ payload }: { payload: AnHeatmap | undefined }) {
  const t = useT2();
  if (!payload || payload.operators.length === 0) return <EmptyState title={t("common.no_data")} body={t("v2.admin.analytics.heatEmpty")} />;
  const maxV = Math.max(1, ...payload.matrix.flat());
  return (
    <div style={{ overflowX: "auto" }}>
      <div className="col" style={{ padding: "14px 20px 18px", gap: 3, minWidth: 760 }}>
        <div className="row" style={{ gap: 3 }}>
          <span style={{ width: 140, flex: "none" }} />
          {payload.hours.map((h) => (
            <span key={h} className="grow num xs c3" style={{ textAlign: "center" }}>{String(h).padStart(2, "0")}</span>
          ))}
        </div>
        {payload.operators.map((op, ri) => (
          <div className="row" style={{ gap: 3 }} key={op.id}>
            <span className="s trunc" style={{ width: 140, flex: "none" }} title={op.name}>{op.name}</span>
            {payload.hours.map((h, hi) => {
              const v = payload.matrix[ri]?.[hi] ?? 0;
              const k = v / maxV;
              return (
                <span
                  key={h}
                  className="grow num"
                  title={`${op.name}, ${h}:00 → ${v}`}
                  style={{
                    height: 26,
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    background: v ? `color-mix(in srgb, var(--brand) ${Math.round(14 + k * 86)}%, var(--surface-3))` : "var(--surface-3)",
                    color: k > 0.42 ? "#FFFFFF" : "var(--ink-3)",
                  }}
                >
                  {v || ""}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
