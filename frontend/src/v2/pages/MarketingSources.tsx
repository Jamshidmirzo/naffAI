import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, X } from "lucide-react";
import { monthLabel } from "../../lib/period";
import type { FunnelRow, GapRow, RejectionRow, SourceRow } from "../../components/marketing/types";
import { useMsrcBreakdown, useMsrcDashboard, useMsrcGap } from "../api/admin";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";

type T = ReturnType<typeof useT2>;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function monthList() {
  const now = new Date();
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    return { label: monthLabel(y, m + 1), from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  });
}

type SortKey = "revenue" | "leads" | "converted" | "conv_rate" | "avg_check";
const COLS = "1.7fr 70px 80px 70px 130px 110px 1fr 1fr";

const KIND: Record<SourceRow["kind"], string> = { sheet: "b-info", bot: "b-hot", manual: "b-warn", other: "" };

function pctStr(n: number | null | undefined) {
  return n == null ? "—" : `${String(n).replace(".", ",")}%`;
}

export default function MarketingSources() {
  const t = useT2();
  const nav = useNavigate();
  const months = useMemo(monthList, []);
  const [monthIdx, setMonthIdx] = useState(0);
  const month = months[monthIdx];
  const dateFrom = month.from;
  const dateTo = month.to;

  const breakdown = useMsrcBreakdown(dateFrom, dateTo);
  const dashboard = useMsrcDashboard(dateFrom, dateTo);
  const [selected, setSelected] = useState<SourceRow | null>(null);
  const gap = useMsrcGap(dateFrom, dateTo, selected);

  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rows = useMemo(() => {
    const copy = [...(breakdown.data ?? [])];
    const val = (r: SourceRow) => Number(r[sortKey] || 0);
    copy.sort((a, b) => (sortDir === "desc" ? val(b) - val(a) : val(a) - val(b)));
    return copy;
  }, [breakdown.data, sortKey, sortDir]);

  const totals = useMemo(() => {
    const r = breakdown.data ?? [];
    return {
      sources: r.length,
      leads: r.reduce((s, x) => s + x.leads, 0),
      converted: r.reduce((s, x) => s + x.converted, 0),
      revenue: r.reduce((s, x) => s + Number(x.revenue || 0), 0),
    };
  }, [breakdown.data]);

  const toggle = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };
  const arrow = (k: SortKey) => (sortKey === k ? (sortDir === "desc" ? " ▼" : " ▲") : "");
  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <button className={cx("th-s r", sortKey === k && "is-on")} type="button" onClick={() => toggle(k)} aria-sort={sortKey === k ? (sortDir === "desc" ? "descending" : "ascending") : undefined}>
      {label}{arrow(k)}
    </button>
  );

  const changeMonth = (i: number) => {
    setMonthIdx(i);
    setSelected(null);
  };

  const funnels = dashboard.data?.funnels ?? [];
  const rejections = dashboard.data?.rejection_reasons ?? [];

  return (
    <>
      <PageHeader title={t("marketing_sources.title")} meta={t("marketing_sources.subtitle")}>
        <div className="row g6">
          <select className="input" aria-label={t("dash.month_picker")} style={{ width: 200 }} value={monthIdx} onChange={(e) => changeMonth(Number(e.target.value))}>
            {months.map((m, i) => <option key={m.from} value={i}>{m.label}</option>)}
          </select>
          {monthIdx !== 0 ? (
            <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.admin.analytics.resetMonth")} title={t("v2.admin.analytics.resetMonth")} onClick={() => changeMonth(0)}>
              <X className="ic" />
            </button>
          ) : null}
        </div>
      </PageHeader>
      <main className="page">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 12 }}>
          <Kpi label={t("marketing_sources.summary.sources")} value={breakdown.data ? fmtNum(totals.sources) : "—"} />
          <Kpi label={t("marketing_sources.summary.leads")} value={breakdown.data ? fmtNum(totals.leads) : "—"} />
          <Kpi
            label={t("marketing_sources.summary.converted")}
            value={breakdown.data ? fmtNum(totals.converted) : "—"}
            hint={totals.leads > 0 ? t("v2.admin.msources.conv", { p: ((totals.converted * 100) / totals.leads).toFixed(1).replace(".", ",") }) : undefined}
          />
          <Kpi label={t("marketing_sources.summary.revenue")} value={breakdown.data ? fmtNum(totals.revenue) : "—"} />
        </div>

        <section className="card tbl">
          {breakdown.isLoading ? (
            <LoadingBlock rows={6} onRetry={() => breakdown.refetch()} />
          ) : breakdown.isError ? (
            <ErrorState error={breakdown.error} onRetry={() => breakdown.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title={t("marketing_sources.empty")} body={t("v2.admin.msources.emptyBody")} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 980 }}>
                <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                  <span>{t("marketing_sources.col.source")}</span>
                  <Th k="leads" label={t("marketing_sources.col.leads")} />
                  <Th k="converted" label={t("marketing_sources.col.sales")} />
                  <Th k="conv_rate" label={t("marketing_sources.col.conv")} />
                  <Th k="revenue" label={t("marketing_sources.col.revenue")} />
                  <Th k="avg_check" label={t("marketing_sources.col.avg_check")} />
                  <span>{t("marketing_sources.col.top_bought")}</span>
                  <span>{t("marketing_sources.col.top_asked")}</span>
                </div>
                {rows.map((r) => {
                  const sel = selected?.source_name === r.source_name;
                  const bought = r.top_products?.[0]?.name || null;
                  const asked = r.product_hint_top?.[0]?.model || null;
                  const askedShare = r.product_hint_top?.[0]?.share_pct;
                  const deficit = r.demand_supply_ratio != null && r.demand_supply_ratio < 40;
                  return (
                    <div
                      key={r.source_name}
                      className={cx("tr", sel && "is-sel")}
                      style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
                      role="button"
                      tabIndex={0}
                      aria-expanded={sel}
                      onClick={() => setSelected(sel ? null : r)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(sel ? null : r);
                        }
                      }}
                    >
                      <span className="row g8" style={{ minWidth: 0 }}>
                        <span className={cx("badge", KIND[r.kind])} style={{ height: 20, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em" }}>{t(`marketing_sources.kind.${r.kind}`)}</span>
                        <span className="w6 trunc">{r.source_name}</span>
                        {deficit ? <span className="badge b-warn" style={{ height: 20 }} title={t("marketing_sources.deficit_hint")}>{t("marketing_sources.deficit_badge")}</span> : null}
                      </span>
                      <span className="r num">{fmtNum(r.leads)}</span>
                      <span className="r num">{fmtNum(r.converted)}</span>
                      <span className="r num w6">{r.leads > 0 ? pctStr(r.conv_rate) : "—"}</span>
                      <span className="r num">{fmtNum(r.revenue)}</span>
                      <span className="r num c3">{r.converted > 0 ? fmtNum(r.avg_check) : "—"}</span>
                      <span className="s trunc">{bought ?? <span className="c3">—</span>}</span>
                      <span className="s c2 trunc">{asked ? `${asked}${askedShare != null ? ` · ${askedShare}%` : ""}` : <span className="c3">—</span>}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {selected ? (
          <section className="card col">
            <div className="card-h">
              <div className="col" style={{ minWidth: 0 }}>
                <span className="lbl">{t("marketing_sources.detail.title")}</span>
                <span className="h3 trunc">{selected.source_name}</span>
              </div>
              <span className="row g8">
                {selected.sheet_source_id ? (
                  <button className="btn btn-sm" type="button" onClick={() => nav(`/sales?sheet_source_id=${selected.sheet_source_id}&date_from=${dateFrom}&date_to=${dateTo}`)}>
                    {t("marketing_sources.open_sales")}<ArrowRight className="ic ic-s" />
                  </button>
                ) : null}
                <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.admin.msources.closeDetail")} onClick={() => setSelected(null)}>
                  <X className="ic" />
                </button>
              </span>
            </div>
            {dashboard.isError ? <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} /> : null}
            <Detail
              t={t}
              source={selected}
              loading={dashboard.isLoading}
              funnel={funnels.find((f) => f.source_name === selected.source_name)}
              rejection={rejections.find((r) => r.source_name === selected.source_name)}
            />
            <div className="card-h" style={{ borderTop: "1px solid var(--line)" }}>
              <span className="h3">{t("marketing_sources.demand_vs_supply")}</span>
              <span className="xs c3">{t("v2.admin.msources.gapHint")}</span>
            </div>
            {gap.isLoading ? (
              <LoadingBlock rows={4} onRetry={() => gap.refetch()} />
            ) : gap.isError ? (
              <ErrorState error={gap.error} onRetry={() => gap.refetch()} />
            ) : !gap.data?.gap?.length ? (
              <div className="empty"><span className="s">{t("marketing_sources.gap_empty")}</span></div>
            ) : (
              <GapTable t={t} rows={gap.data.gap} totals={gap.data.totals} />
            )}
          </section>
        ) : null}
      </main>
    </>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <section className="card col g4 pad">
      <span className="lbl">{label}</span>
      <span className="kpi" style={{ fontSize: 22 }}>{value}</span>
      {hint ? <span className="xs c3">{hint}</span> : null}
    </section>
  );
}

function Detail({ t, source, funnel, rejection, loading }: { t: T; source: SourceRow; funnel?: FunnelRow; rejection?: RejectionRow; loading: boolean }) {
  const stages: [string, keyof FunnelRow, keyof FunnelRow, string][] = [
    [t("v2.admin.msources.stNew"), "new", "new_pct", ""],
    [t("v2.admin.msources.stAssigned"), "assigned", "assigned_pct", ""],
    [t("v2.admin.msources.stInProgress"), "in_progress", "in_progress_pct", ""],
    ["Callback", "callback_scheduled", "callback_scheduled_pct", ""],
    [t("v2.admin.msources.stWon"), "won", "won_pct", "ok"],
    [t("v2.admin.msources.stLost"), "lost", "lost_pct", "bad"],
  ];
  const noData = <span className="s c3">{t("common.no_data")}</span>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 28, padding: "18px 20px", alignItems: "start" }}>
      <div className="col" style={{ gap: 10 }}>
        <span className="lbl">{t("marketing.detail.funnel")}</span>
        {loading ? <i className="sk" style={{ display: "block", height: 90 }} /> : funnel ? stages.map(([label, cnt, pct, cls]) => (
          <div className="row g8" key={String(cnt)}>
            <span className="xs c3" style={{ width: 80, flex: "none" }}>{label}</span>
            <span className="bar grow" style={{ height: 6 }}><i className={cls || undefined} style={{ width: `${Math.min(100, Number(funnel[pct]) || 0)}%` }} /></span>
            <span className="num xs" style={{ width: 40, textAlign: "right" }}>{fmtNum(funnel[cnt] as number)}</span>
          </div>
        )) : noData}
        {source.avg_time_to_conv_hours != null ? (
          <span className="xs c3">{t("marketing.detail.avg_time")}: <span className="w6" style={{ color: "var(--ink)" }}>{t("v2.admin.msources.hours", { n: source.avg_time_to_conv_hours })}</span></span>
        ) : null}
      </div>
      <div className="col g16">
        <div className="col g8">
          <span className="lbl">{t("marketing.detail.top_products")}</span>
          {source.top_products.length === 0 ? noData : source.top_products.map((p) => (
            <div className="row between s" key={p.name}><span className="trunc">{p.name}</span><span className="num c3">{fmtNum(p.count)}</span></div>
          ))}
        </div>
        <div className="col g8">
          <span className="lbl">{t("marketing.detail.top_operators")}</span>
          {source.top_operators.length === 0 ? noData : source.top_operators.map((o) => (
            <div className="row between s" key={o.operator_id}><span className="trunc">{o.name}</span><span className="num c3">{fmtNum(o.total)}</span></div>
          ))}
        </div>
      </div>
      <div className="col g16">
        <div className="col g8">
          <span className="lbl">{t("marketing.detail.rejection_reasons")}</span>
          {loading ? <i className="sk" style={{ display: "block", height: 60 }} /> : !rejection || rejection.reasons.length === 0 ? noData : rejection.reasons.map((r) => (
            <div className="row between s" key={r.text}><span className="trunc">{r.text}</span><span className="num c3">{fmtNum(r.count)} <span className="xs">({r.pct}%)</span></span></div>
          ))}
        </div>
        {Number(source.adspend.amount) > 0 ? (
          <div className="col g8">
            <span className="lbl">{t("marketing.detail.adspend")}</span>
            <div className="row between s"><span className="c3">{t("marketing.detail.spend")}</span><span className="num w6">{fmtNum(source.adspend.amount)}</span></div>
            {source.adspend.cac ? <div className="row between s"><span className="c3">CAC</span><span className="num w6">{fmtNum(source.adspend.cac)}</span></div> : null}
            {source.adspend.roi_pct ? (
              <div className="row between s"><span className="c3">ROI</span><span className={cx("num w6", Number(source.adspend.roi_pct) >= 0 ? "c-ok" : "c-bad")}>{fmtNum(source.adspend.roi_pct)}%</span></div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GapTable({ t, rows, totals }: { t: T; rows: GapRow[]; totals: { demand: number; supply: number } }) {
  const tone = (i: GapRow["indicator"]) =>
    i === "gap_deficit" ? ["b-warn", t("marketing_sources.indicator.deficit")] : i === "gap_surplus" ? ["b-info", t("marketing_sources.indicator.surplus")] : ["b-ok", t("marketing_sources.indicator.match")];
  const cols = "1.6fr 90px 90px 90px 140px";
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 560 }}>
        <div className="tr th" style={{ gridTemplateColumns: cols }}>
          <span>{t("marketing_sources.gap.model")}</span>
          <span className="r">{t("marketing_sources.gap.demand")}</span>
          <span className="r">{t("marketing_sources.gap.supply")}</span>
          <span className="r">{t("marketing_sources.gap.conv")}</span>
          <span>{t("marketing_sources.gap.status")}</span>
        </div>
        {rows.map((r) => {
          const [cls, label] = tone(r.indicator);
          return (
            <div className="tr" key={r.model_key} style={{ gridTemplateColumns: cols, minHeight: 42 }}>
              <span className="s w6 trunc">{r.model_key}</span>
              <span className="r num">{fmtNum(r.demand_count)}</span>
              <span className="r num">{fmtNum(r.supply_count)}</span>
              <span className="r num c2">{pctStr(r.conv_pct)}</span>
              <span><span className={cx("badge", cls)}>{label}</span></span>
            </div>
          );
        })}
        <div className="row between s" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
          <span className="c3">{t("marketing_sources.gap.totals", { d: fmtNum(totals.demand), s: fmtNum(totals.supply) })}</span>
          <span className="xs c3">{t("v2.admin.msources.sortNote")}</span>
        </div>
      </div>
    </div>
  );
}
