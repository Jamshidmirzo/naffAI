import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Download, Lightbulb, Plus, RefreshCcw, Sparkles, Trash2, Trophy } from "lucide-react";
import { toast } from "../../components/ui";
import { formatUZS, toDateInputValue } from "../../lib/format";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  mktExport,
  useMktAdSpend,
  useMktAdSpendCreate,
  useMktAdSpendDelete,
  useMktAdSpendPatch,
  useMktDashboard,
  useMktGenerate,
  useMktInsight,
  useMktMarkDone,
  useMktSheetSources,
  type MktDashboard,
  type MktFunnelRow,
  type MktInsight,
  type MktRejectionRow,
  type MktSourceRow,
  type MktTimePatternSource,
} from "../api/admin";

type Tab = "overview" | "sources" | "patterns" | "dynamics" | "ai" | "spend";
const TABS: Tab[] = ["overview", "sources", "patterns", "dynamics", "ai", "spend"];
const PRESETS = [7, 14, 30, 90];

function shift(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function errDetail(e: unknown): string | undefined {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || undefined;
}

const pct = (n: number) => `${String(n).replace(".", ",")}%`;
const signed = (n: number | null, suffix = "%") => (n == null ? "—" : `${n > 0 ? "▲" : n < 0 ? "▼" : "·"} ${Math.abs(n)}${suffix}`);
const toneOf = (n: number | null | undefined) => (n == null || n === 0 ? "c3" : n > 0 ? "c-ok" : "c-bad");

/** /marketing — sources, funnels, patterns, dynamics, AI advice, ad spend (MgMarketing, MgMarketing2, MgMarketingSource). */
export default function Marketing() {
  const t = useT2();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = TABS.includes(sp.get("tab") as Tab) ? (sp.get("tab") as Tab) : "overview";
  const setTab = (x: Tab) => setSp(x === "overview" ? {} : { tab: x }, { replace: true });

  const today = useMemo(() => toDateInputValue(new Date()), []);
  const [preset, setPreset] = useState<number | "custom">(30);
  const [dateFrom, setDateFrom] = useState(() => toDateInputValue(shift(29)));
  const [dateTo, setDateTo] = useState(today);
  const [exporting, setExporting] = useState(false);
  const badRange = !!dateFrom && !!dateTo && dateFrom > dateTo;

  const applyPreset = (days: number) => {
    setDateFrom(toDateInputValue(shift(days - 1)));
    setDateTo(toDateInputValue(new Date()));
    setPreset(days);
  };

  const dash = useMktDashboard(dateFrom, dateTo);
  const insight = useMktInsight(dash.data?.latest_insight_id);
  const generate = useMktGenerate();
  const markDone = useMktMarkDone();

  const days = Math.max(1, Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86_400_000) + 1);

  const runGenerate = () =>
    generate.mutate(days, {
      onSuccess: () => toast.success(t("marketing.generated")),
      onError: (e) => toast.error(errDetail(e) || t("marketing.generate_failed")),
    });

  const runExport = async () => {
    setExporting(true);
    try {
      await mktExport(dateFrom, dateTo);
    } catch (e) {
      let msg = errDetail(e);
      const blob = (e as { response?: { data?: unknown } })?.response?.data;
      if (!msg && blob instanceof Blob) {
        try {
          msg = (JSON.parse(await blob.text()) as { detail?: string }).detail;
        } catch {
          /* not JSON */
        }
      }
      toast.error(msg || t("v2.admin.marketing.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const d = dash.data;

  return (
    <>
      <PageHeader title={t("marketing.title")} meta={t("marketing.subtitle_v2")}>
        <button className="btn" type="button" disabled={generate.isPending || badRange} onClick={runGenerate}>
          <RefreshCcw className="ic ic-s" />
          {generate.isPending ? t("marketing.calculating") : t("marketing.regenerate_ai")}
        </button>
        <button className="btn" type="button" disabled={exporting || badRange} onClick={runExport}>
          <Download className="ic ic-s" />
          {exporting ? t("v2.admin.marketing.exporting") : t("v2.admin.marketing.export")}
        </button>
      </PageHeader>
      <main className="page">
        <div className="row g12 wrap">
          <div className="seg" role="group">
            {PRESETS.map((p) => (
              <button key={p} type="button" className={cx(preset === p && "is-on")} onClick={() => applyPreset(p)}>
                {t(`marketing.range.${p}d`)}
              </button>
            ))}
            {preset === "custom" ? <button type="button" className="is-on">{t("v2.admin.marketing.custom")}</button> : null}
          </div>
          <div className="row g8">
            <input
              className={cx("input num", badRange && "is-bad")}
              type="date"
              value={dateFrom}
              max={dateTo || today}
              aria-label={t("v2.admin.marketing.from")}
              style={{ width: 150, height: 36 }}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPreset("custom");
              }}
            />
            <span className="c3">—</span>
            <input
              className={cx("input num", badRange && "is-bad")}
              type="date"
              value={dateTo}
              min={dateFrom}
              max={today}
              aria-label={t("v2.admin.marketing.to")}
              style={{ width: 150, height: 36 }}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPreset("custom");
              }}
            />
          </div>
          {badRange ? <span className="err">{t("v2.admin.marketing.badRange")}</span> : <span className="xs c3">{t("v2.admin.marketing.customHint")}</span>}
        </div>

        <div className="tabs" role="tablist">
          {TABS.map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} className={cx("tab", tab === x && "is-on")} onClick={() => setTab(x)}>
              {t(`marketing.tab.${x}`)}
              {x === "sources" && d ? <span className="num xs c3">{d.sources.length}</span> : null}
            </button>
          ))}
        </div>

        {tab === "spend" ? (
          <SpendTab />
        ) : dash.isLoading ? (
          <section className="card"><LoadingBlock rows={6} onRetry={() => dash.refetch()} /></section>
        ) : dash.isError ? (
          <section className="card"><ErrorState error={dash.error} onRetry={() => dash.refetch()} /></section>
        ) : d ? (
          tab === "overview" ? (
            <>
              <KpiRow d={d} />
              <SourceTable d={d} limit={6} onAll={() => setTab("sources")} />
            </>
          ) : tab === "sources" ? (
            <SourceTable d={d} />
          ) : tab === "patterns" ? (
            <Heatmap sources={d.time_patterns.sources} />
          ) : tab === "dynamics" ? (
            <Dynamics d={d} />
          ) : (
            <AiTab
              insight={insight.data ?? null}
              loading={!!d.latest_insight_id && insight.isLoading}
              error={insight.isError ? insight.error : null}
              onRetry={() => insight.refetch()}
              pending={markDone.isPending}
              onMark={(index) => insight.data && markDone.mutate({ id: insight.data.id, index }, { onError: (e) => toast.error(errDetail(e) || t("common.save_failed")) })}
            />
          )
        ) : null}
      </main>
    </>
  );
}

/* ------------------------------ overview ------------------------------ */

function KpiRow({ d }: { d: MktDashboard }) {
  const t = useT2();
  const { totals, wow } = d;
  const cards = [
    { label: t("marketing.kpi.leads"), value: fmtNum(totals.leads), delta: signed(wow.delta.leads_pct), dCls: toneOf(wow.delta.leads_pct), sub: `${t("marketing.kpi.vs_prev")}: ${fmtNum(wow.previous.leads)}` },
    { label: t("marketing.kpi.converted"), value: fmtNum(totals.converted), delta: signed(wow.delta.converted_pct), dCls: toneOf(wow.delta.converted_pct), sub: `${t("marketing.kpi.conv_rate")}: ${pct(totals.conv_rate)}` },
    { label: t("marketing.kpi.revenue"), value: fmtNum(totals.revenue), delta: signed(wow.delta.revenue_pct), dCls: toneOf(wow.delta.revenue_pct), sub: `${t("marketing.kpi.avg_check")}: ${fmtNum(totals.avg_check)}` },
    {
      label: t("marketing.kpi.spend"),
      value: fmtNum(totals.spend),
      delta: totals.roi_pct != null ? `ROI: ${fmtNum(totals.roi_pct)}%` : "",
      dCls: totals.roi_pct != null && Number(totals.roi_pct) < 0 ? "c-bad" : "c-ok",
      sub: totals.cac ? `${t("marketing.kpi.cac")}: ${fmtNum(totals.cac)}` : t("marketing.kpi.spend_hint"),
    },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
      {cards.map((c) => (
        <section key={c.label} className="card col g6" style={{ padding: "16px 18px" }}>
          <span className="lbl">{c.label}</span>
          <span className="kpi" style={{ fontSize: 24 }}>{c.value}</span>
          <span className="row g8 xs">
            {c.delta ? <span className={cx("num w6", c.dCls)}>{c.delta}</span> : null}
            <span className="c3 trunc">{c.sub}</span>
          </span>
        </section>
      ))}
    </div>
  );
}

type SortKey = "leads" | "converted" | "conv_rate" | "revenue" | "avg_check" | "delta_pp";
const SRC_COLS = "minmax(200px,1.6fr) 80px 80px 80px 140px 120px 80px 24px";
const KIND_CLS: Record<string, string> = { sheet: "b-info", bot: "b-hot", manual: "b-warn", other: "" };

function SourceTable({ d, limit, onAll }: { d: MktDashboard; limit?: number; onAll?: () => void }) {
  const t = useT2();
  const [key, setKey] = useState<SortKey>("leads");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [open, setOpen] = useState<string | null>(null);

  const base = limit ? d.sources.slice(0, limit) : d.sources;
  const rows = useMemo(() => {
    const get = (r: MktSourceRow) => (key === "revenue" || key === "avg_check" ? Number(r[key]) : (r[key] as number));
    return [...base].sort((a, b) => (dir === "asc" ? get(a) - get(b) : get(b) - get(a)));
  }, [base, key, dir]);
  const funnels = useMemo(() => new Map(d.funnels.map((f) => [f.source_name, f])), [d.funnels]);
  const rejections = useMemo(() => new Map(d.rejection_reasons.map((r) => [r.source_name, r])), [d.rejection_reasons]);

  if (d.sources.length === 0) return <section className="card"><EmptyState title={t("marketing.no_sources")} /></section>;

  const sortBtn = (k: SortKey, label: string) => (
    <button
      type="button"
      className={cx("th-s", key === k && "is-on")}
      style={{ justifySelf: "end" }}
      onClick={() => {
        if (key === k) setDir(dir === "asc" ? "desc" : "asc");
        else {
          setKey(k);
          setDir("desc");
        }
      }}
    >
      {label} {key === k ? (dir === "asc" ? "▲" : "▼") : ""}
    </button>
  );

  return (
    <section className="card tbl">
      <div className="scroll-x">
        <div style={{ minWidth: 860 }}>
          <div className="tr th" style={{ gridTemplateColumns: SRC_COLS }}>
            <span>{t("marketing.table.source")}</span>
            {sortBtn("leads", t("marketing.table.leads"))}
            {sortBtn("converted", t("marketing.table.converted"))}
            {sortBtn("conv_rate", t("marketing.table.conv"))}
            {sortBtn("revenue", t("marketing.table.revenue"))}
            {sortBtn("avg_check", t("marketing.table.avg_check"))}
            {sortBtn("delta_pp", t("marketing.table.delta"))}
            <span />
          </div>
          {rows.map((s) => {
            const isOpen = open === s.source_name;
            return (
              <Fragment key={s.source_name}>
                <div
                  className={cx("tr", isOpen && "is-sel")}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  style={{ gridTemplateColumns: SRC_COLS, cursor: "pointer" }}
                  onClick={() => setOpen(isOpen ? null : s.source_name)}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(isOpen ? null : s.source_name)}
                >
                  <span className="row g8" style={{ minWidth: 0 }}>
                    <span className={cx("badge", KIND_CLS[s.kind])} style={{ height: 20, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em" }}>
                      {t(`v2.admin.marketing.kind.${s.kind}`)}
                    </span>
                    <span className="w6 trunc">{s.source_name}</span>
                  </span>
                  <span className="r num">{fmtNum(s.leads)}</span>
                  <span className="r num">{fmtNum(s.converted)}</span>
                  <span className={cx("r num w6", s.conv_rate >= 5 && "c-brand")}>{pct(s.conv_rate)}</span>
                  <span className="r num">{fmtNum(s.revenue)}</span>
                  <span className="r num c3">{Number(s.avg_check) > 0 ? fmtNum(s.avg_check) : "—"}</span>
                  <span className={cx("r num w6", toneOf(s.delta_pp))}>{(s.delta_pp > 0 ? "+" : "") + s.delta_pp.toFixed(1).replace(".", ",")}</span>
                  <span className="c3">{isOpen ? <ChevronDown className="ic ic-s" /> : <ChevronRight className="ic ic-s" />}</span>
                </div>
                {isOpen ? <SourceDetail s={s} funnel={funnels.get(s.source_name)} rejection={rejections.get(s.source_name)} /> : null}
              </Fragment>
            );
          })}
        </div>
      </div>
      {limit && d.sources.length > limit && onAll ? (
        <div className="row" style={{ justifyContent: "center", padding: 12, borderTop: "1px solid var(--line)" }}>
          <button type="button" className="btn btn-ghost btn-sm c-brand" onClick={onAll}>{t("marketing.see_all_sources")} →</button>
        </div>
      ) : null}
    </section>
  );
}

const STAGES: Array<[keyof MktFunnelRow, keyof MktFunnelRow, string]> = [
  ["new", "new_pct", ""],
  ["assigned", "assigned_pct", ""],
  ["in_progress", "in_progress_pct", ""],
  ["callback_scheduled", "callback_scheduled_pct", "warn"],
  ["won", "won_pct", "ok"],
  ["lost", "lost_pct", "bad"],
];

function SourceDetail({ s, funnel, rejection }: { s: MktSourceRow; funnel?: MktFunnelRow; rejection?: MktRejectionRow }) {
  const t = useT2();
  const noData = <span className="s c3">{t("v2.admin.marketing.noData")}</span>;
  return (
    <div style={{ padding: "20px 24px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 28, alignItems: "start" }}>
        <div className="col" style={{ gap: 10 }}>
          <span className="lbl">{t("marketing.detail.funnel")}</span>
          {funnel ? (
            <>
              {STAGES.map(([cnt, p, cls]) => (
                <div key={cnt} className="row g8">
                  <span className="xs c3" style={{ width: 80, flex: "none" }}>{t(`v2.admin.marketing.funnel.${cnt}`)}</span>
                  <span className="bar grow" style={{ height: 6 }}><i className={cls} style={{ width: `${Math.min(100, funnel[p] as number)}%` }} /></span>
                  <span className="num xs" style={{ width: 44, textAlign: "right" }}>{fmtNum(funnel[cnt] as number)}</span>
                  <span className="num xs c3" style={{ width: 44, textAlign: "right" }}>{pct(funnel[p] as number)}</span>
                </div>
              ))}
            </>
          ) : (
            noData
          )}
          {s.avg_time_to_conv_hours != null ? (
            <span className="xs c3" style={{ marginTop: 4 }}>
              {t("marketing.detail.avg_time")}: <span className="w6" style={{ color: "var(--ink)" }}>{t("v2.admin.marketing.hours", { n: s.avg_time_to_conv_hours })}</span>
            </span>
          ) : null}
        </div>
        <div className="col g16">
          <div className="col g8">
            <span className="lbl">{t("marketing.detail.top_products")}</span>
            {s.top_products.length === 0
              ? noData
              : s.top_products.map((p) => (
                  <div key={p.name} className="row between s"><span className="trunc">{p.name}</span><span className="num c3">{fmtNum(p.count)}</span></div>
                ))}
          </div>
          <div className="col g8">
            <span className="lbl">{t("marketing.detail.top_operators")}</span>
            {s.top_operators.length === 0
              ? noData
              : s.top_operators.map((o) => (
                  <div key={o.operator_id} className="row between s"><span className="trunc">{o.name}</span><span className="num c3">{fmtNum(o.total)}</span></div>
                ))}
          </div>
        </div>
        <div className="col g16">
          <div className="col g8">
            <span className="lbl">{t("marketing.detail.rejection_reasons")}</span>
            {!rejection || rejection.reasons.length === 0
              ? noData
              : rejection.reasons.map((r) => (
                  <div key={r.text} className="row between s g8">
                    <span className="trunc">{r.text}</span>
                    <span className="num c3" style={{ flex: "none" }}>{fmtNum(r.count)} <span className="xs">({pct(r.pct)})</span></span>
                  </div>
                ))}
          </div>
          {Number(s.adspend.amount) > 0 ? (
            <div className="col g8">
              <span className="lbl">{t("marketing.detail.adspend")}</span>
              <div className="row between s"><span className="c3">{t("marketing.detail.spend")}</span><span className="num w6">{formatUZS(s.adspend.amount)}</span></div>
              {s.adspend.cac ? <div className="row between s"><span className="c3">CAC</span><span className="num w6">{formatUZS(s.adspend.cac)}</span></div> : null}
              {s.adspend.roi_pct ? (
                <div className="row between s"><span className="c3">ROI</span><span className={cx("num w6", Number(s.adspend.roi_pct) >= 0 ? "c-ok" : "c-bad")}>{fmtNum(s.adspend.roi_pct)}%</span></div>
              ) : null}
            </div>
          ) : (
            <span className="xs c3">{t("v2.admin.marketing.noSpend")}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ patterns ------------------------------ */

function Heatmap({ sources }: { sources: MktTimePatternSource[] }) {
  const t = useT2();
  const [src, setSrc] = useState(sources[0]?.source_name ?? "");
  const [mode, setMode] = useState<"leads" | "sales">("leads");
  useEffect(() => {
    if (!sources.find((s) => s.source_name === src)) setSrc(sources[0]?.source_name ?? "");
  }, [sources, src]);
  const cur = sources.find((s) => s.source_name === src) ?? sources[0];
  if (!cur) return <section className="card"><EmptyState title={t("v2.admin.marketing.noData")} /></section>;
  const vals = cur.hours.map((h) => (mode === "leads" ? h.leads : h.sales));
  const max = Math.max(1, ...vals);
  const total = vals.reduce((a, b) => a + b, 0);
  const label = mode === "leads" ? t("marketing.heatmap.leads") : t("marketing.heatmap.sales");
  return (
    <section className="card col">
      <div className="card-h" style={{ flexWrap: "wrap" }}>
        <div className="col">
          <span className="h3">{t("marketing.heatmap.title")}</span>
          <span className="xs c3">{t("marketing.heatmap.hint")}</span>
        </div>
        <div className="row g8">
          <select className="input" aria-label={t("v2.admin.marketing.source")} style={{ width: 220, height: 34 }} value={cur.source_name} onChange={(e) => setSrc(e.target.value)}>
            {sources.map((s) => (
              <option key={s.source_name} value={s.source_name}>{s.source_name}</option>
            ))}
          </select>
          <div className="seg">
            <button type="button" className={cx(mode === "leads" && "is-on")} onClick={() => setMode("leads")}>{t("marketing.heatmap.leads")}</button>
            <button type="button" className={cx(mode === "sales" && "is-on")} onClick={() => setMode("sales")}>{t("marketing.heatmap.sales")}</button>
          </div>
        </div>
      </div>
      <div className="scroll-x">
        <div className="col" style={{ padding: "16px 20px 18px", gap: 4, minWidth: 760 }}>
          <div className="row" style={{ gap: 3 }}>
            <span style={{ width: 60, flex: "none" }} />
            {cur.hours.map((h) => (
              <span key={h.hour} className="grow num xs c3" style={{ textAlign: "center" }}>{String(h.hour).padStart(2, "0")}</span>
            ))}
          </div>
          <div className="row" style={{ gap: 3 }}>
            <span className="xs c3" style={{ width: 60, flex: "none" }}>{label}</span>
            {cur.hours.map((h) => {
              const v = mode === "leads" ? h.leads : h.sales;
              const k = v / max;
              return (
                <span
                  key={h.hour}
                  className="grow num"
                  title={`${String(h.hour).padStart(2, "0")}:00 — ${v}`}
                  style={{
                    height: 30,
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    background: v ? `color-mix(in srgb, var(--brand) ${Math.round(12 + k * 88)}%, var(--surface-3))` : "var(--surface-3)",
                    color: k > 0.42 ? "#FFFFFF" : "var(--ink-3)",
                  }}
                >
                  {v || ""}
                </span>
              );
            })}
          </div>
          <div className="row g8 xs c3" style={{ marginTop: 8, paddingLeft: 63 }}>
            {t("marketing.heatmap.legend")}: 0
            <span className="row" style={{ gap: 2 }}>
              {[0, 35, 65, 100].map((p) => (
                <i key={p} style={{ display: "block", width: 14, height: 14, borderRadius: 4, background: p ? `color-mix(in srgb, var(--brand) ${p}%, var(--surface-3))` : "var(--surface-3)" }} />
              ))}
            </span>
            {fmtNum(max)} · {t("v2.admin.marketing.legendMax", { src: cur.source_name, n: fmtNum(total) })}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ dynamics ------------------------------ */

function BarsCard({ title, hint, bars }: { title: string; hint: string; bars: Array<{ n: string; prev: number; cur: number; label: string }> }) {
  const t = useT2();
  const max = Math.max(1, ...bars.flatMap((b) => [b.prev, b.cur]));
  return (
    <section className="card col">
      <div className="card-h" style={{ flexWrap: "wrap" }}>
        <div className="col"><span className="h3">{title}</span><span className="xs c3">{hint}</span></div>
        <span className="row g12 xs c3">
          <span className="row g6"><i style={{ display: "block", width: 10, height: 10, borderRadius: 3, background: "var(--line-2)" }} />{t("marketing.ts.prev")}</span>
          <span className="row g6"><i style={{ display: "block", width: 10, height: 10, borderRadius: 3, background: "var(--brand)" }} />{t("marketing.ts.cur")}</span>
        </span>
      </div>
      <div className="col g8" style={{ padding: "18px 20px 16px" }}>
        <div className="row" style={{ alignItems: "flex-end", gap: 14, height: 200, borderBottom: "1px solid var(--line-2)" }}>
          {bars.map((b) => (
            <div key={b.n} className="col grow" style={{ height: "100%", justifyContent: "flex-end", alignItems: "center", gap: 4 }} title={`${b.n}: ${b.label}`}>
              <span className="num xs c2">{b.label}</span>
              <span className="row" style={{ alignItems: "flex-end", gap: 3, width: "100%", justifyContent: "center", height: 170 }}>
                <i style={{ display: "block", width: "40%", maxWidth: 22, height: `${(b.prev / max) * 100}%`, background: "var(--line-2)", borderRadius: "4px 4px 0 0" }} />
                <i style={{ display: "block", width: "40%", maxWidth: 22, height: `${(b.cur / max) * 100}%`, background: "var(--brand)", borderRadius: "4px 4px 0 0" }} />
              </span>
            </div>
          ))}
        </div>
        <div className="row" style={{ gap: 14 }}>
          {bars.map((b) => (
            <span key={b.n} className="grow xs c3 trunc" style={{ textAlign: "center" }} title={b.n}>{b.n}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Dynamics({ d }: { d: MktDashboard }) {
  const t = useT2();
  const top = d.sources.slice(0, 6);
  const { wow } = d;
  const wowCards = [
    { label: t("marketing.ts.leads_wow"), delta: wow.delta.leads_pct, cur: fmtNum(wow.current.leads), prev: fmtNum(wow.previous.leads) },
    { label: t("marketing.ts.converted_wow"), delta: wow.delta.converted_pct, cur: fmtNum(wow.current.converted), prev: fmtNum(wow.previous.converted) },
    { label: t("marketing.ts.revenue_wow"), delta: wow.delta.revenue_pct, cur: fmtNum(wow.current.revenue), prev: fmtNum(wow.previous.revenue) },
  ];
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {wowCards.map((w) => (
          <section key={w.label} className="card col g6" style={{ padding: "16px 18px" }}>
            <span className="lbl">{w.label}</span>
            <span className="row g12 wrap" style={{ alignItems: "baseline" }}>
              <span className={cx("kpi", toneOf(w.delta))} style={{ fontSize: 24 }}>{signed(w.delta)}</span>
              <span className="s c3 num">{t("v2.admin.marketing.versus", { cur: w.cur, prev: w.prev })}</span>
            </span>
          </section>
        ))}
      </div>
      <span className="xs c3" style={{ marginTop: -8 }}>{t("v2.admin.marketing.convDelta", { n: (wow.delta.conv_rate_pp >= 0 ? "+" : "") + String(wow.delta.conv_rate_pp).replace(".", ",") })}</span>
      {top.length === 0 ? (
        <section className="card"><EmptyState title={t("marketing.no_sources")} /></section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16, alignItems: "start" }}>
          <BarsCard title={t("marketing.ts.leads_title")} hint={t("marketing.ts.leads_hint")} bars={top.map((s) => ({ n: s.source_name, prev: s.prev_period.leads, cur: s.leads, label: fmtNum(s.leads) }))} />
          <BarsCard title={t("marketing.ts.conv_title")} hint={t("marketing.ts.conv_hint")} bars={top.map((s) => ({ n: s.source_name, prev: s.prev_period.conv_rate, cur: s.conv_rate, label: pct(s.conv_rate) }))} />
        </div>
      )}
      <section className="card tbl">
        <div className="card-h"><div className="col"><span className="h3">{t("marketing.cohort.title")}</span><span className="xs c3">{t("marketing.cohort.hint")}</span></div></div>
        {d.cohorts.length === 0 ? (
          <EmptyState title={t("v2.admin.marketing.noData")} />
        ) : (
          <div className="scroll-x">
            <div style={{ minWidth: 640 }}>
              <div className="tr th" style={{ gridTemplateColumns: "1.4fr 100px 100px 100px 100px 100px" }}>
                <span>{t("marketing.cohort.week")}</span>
                <span className="r">{t("marketing.cohort.leads")}</span>
                <span className="r">{t("marketing.cohort.conv_7d")}</span>
                <span className="r">{t("marketing.cohort.rate_7d")}</span>
                <span className="r">{t("marketing.cohort.conv_30d")}</span>
                <span className="r">{t("marketing.cohort.rate_30d")}</span>
              </div>
              {d.cohorts.map((c) => (
                <div key={c.week} className="tr" style={{ gridTemplateColumns: "1.4fr 100px 100px 100px 100px 100px", minHeight: 42 }}>
                  <span className="col"><span className="num s">{c.week}</span><span className="xs c3 num">{c.week_start}</span></span>
                  <span className="r num">{fmtNum(c.leads_count)}</span>
                  <span className="r num">{fmtNum(c.conv_7d)}</span>
                  <span className={cx("r num w6", c.conv_rate_7d >= 5 && "c-brand")}>{pct(c.conv_rate_7d)}</span>
                  <span className="r num">{fmtNum(c.conv_30d)}</span>
                  <span className={cx("r num w6", c.conv_rate_30d >= 10 && "c-brand")}>{pct(c.conv_rate_30d)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/* ------------------------------ AI advice ------------------------------ */

const PRIO_TONE: Record<string, string> = { high: "b-bad", medium: "b-warn", low: "" };
const HL: Record<string, { cls: string; bd: string; Icon: typeof Trophy }> = {
  win: { cls: "c-ok", bd: "var(--ok-bg)", Icon: Trophy },
  warn: { cls: "c-bad", bd: "var(--bad-bg)", Icon: AlertTriangle },
  insight: { cls: "c-brand", bd: "var(--brand-soft)", Icon: Lightbulb },
};

function AiTab({ insight, loading, error, onRetry, pending, onMark }: { insight: MktInsight | null; loading: boolean; error: unknown; onRetry: () => void; pending: boolean; onMark: (i: number) => void }) {
  const t = useT2();
  if (loading) return <section className="card"><LoadingBlock rows={4} onRetry={onRetry} /></section>;
  if (error) return <section className="card"><ErrorState error={error} onRetry={onRetry} /></section>;
  if (!insight)
    return (
      <section className="card">
        <EmptyState icon={<Sparkles className="ic ic-l" />} title={t("marketing.ai.no_insight_title")} body={t("marketing.ai.no_insight_hint")} />
      </section>
    );
  const st = insight.structured_output || { summary: insight.summary || "", highlights: [], recommendations: [], questions_for_owner: [] };
  const done = new Set((insight.actions_taken || []).map((a) => a.index));
  const recs = st.recommendations || [];
  return (
    <>
      <section className="card col">
        <div className="card-h">
          <div className="col">
            <span className="h3">{t("marketing.ai.summary")}</span>
            <span className="xs c3 num">
              {[insight.model_version, insight.provider_used, new Date(insight.updated_at).toLocaleString("ru-RU")].filter(Boolean).join(" · ")}
            </span>
          </div>
        </div>
        <div className="col g16" style={{ padding: "16px 20px 20px" }}>
          <p className="s c2" style={{ maxWidth: 900 }}>{st.summary || "—"}</p>
          {st.highlights?.length ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              {st.highlights.map((h, i) => {
                const s = HL[h.type] ?? HL.insight;
                return (
                  <div key={i} className="well col g6" style={{ borderColor: s.bd, background: "var(--surface)" }}>
                    <span className={cx("row g6 xs w7", s.cls)} style={{ letterSpacing: ".06em" }}>
                      <s.Icon className="ic ic-s" />
                      {t(`v2.admin.marketing.hl.${HL[h.type] ? h.type : "insight"}`)}
                    </span>
                    <span className="s">{h.text}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>

      <section className="card col">
        <div className="card-h">
          <span className="h3">{t("marketing.ai.recommendations")} ({recs.length})</span>
          <span className="xs c3">{t("v2.admin.marketing.recsHint")}</span>
        </div>
        {recs.length === 0 ? (
          <EmptyState title={t("marketing.ai.no_recs")} />
        ) : (
          recs.map((r, i) => {
            const isDone = done.has(i);
            const label = isDone ? t("marketing.ai.undo") : t("marketing.ai.mark_done");
            return (
              <div key={i} className="row g12" style={{ alignItems: "flex-start", padding: "14px 20px", borderBottom: "1px solid var(--line)", opacity: isDone ? 0.55 : 1 }}>
                <button className={cx("btn btn-sq btn-sm", isDone && "btn-ok")} type="button" aria-label={label} title={label} disabled={pending} style={{ borderRadius: "50%", marginTop: 2 }} onClick={() => onMark(i)}>
                  <Check className="ic ic-s" />
                </button>
                <span className="col g6 grow">
                  <span className="row g8 wrap">
                    <span className={cx("badge", PRIO_TONE[r.priority] ?? "")} style={{ height: 20, fontSize: 10.5, letterSpacing: ".06em" }}>
                      {t(`v2.admin.marketing.prio.${PRIO_TONE[r.priority] !== undefined ? r.priority : "low"}`)}
                    </span>
                    {r.source ? <span className="xs c2 w6">→ {r.source}</span> : null}
                    {typeof r.confidence === "number" ? <span className="xs c3">{t("marketing.ai.confidence")}: {(r.confidence * 100).toFixed(0)}%</span> : null}
                  </span>
                  <span className="s w6" style={{ textDecoration: isDone ? "line-through" : "none" }}>{r.action}</span>
                  {r.evidence ? <span className="xs c3"><span className="w6 c2">{t("marketing.ai.evidence")}:</span> {r.evidence}</span> : null}
                  {r.expected_impact ? <span className="badge b-ok" style={{ alignSelf: "flex-start", height: "auto", minHeight: 22, whiteSpace: "normal", padding: "3px 8px" }}>{r.expected_impact}</span> : null}
                </span>
              </div>
            );
          })
        )}
      </section>

      {st.questions_for_owner?.length ? (
        <section className="card col">
          <div className="card-h"><span className="h3">{t("marketing.ai.questions")}</span></div>
          <ol className="col g8 s c2" style={{ padding: "14px 20px 16px 38px" }}>
            {st.questions_for_owner.map((q, i) => <li key={i}>{q}</li>)}
          </ol>
        </section>
      ) : null}
    </>
  );
}

/* ------------------------------ ad spend ------------------------------ */

const SPEND_COLS = "200px minmax(140px,1.1fr) 170px minmax(160px,1.4fr) 36px";

function SpendTab() {
  const t = useT2();
  const list = useMktAdSpend();
  const sources = useMktSheetSources();
  const create = useMktAdSpendCreate();
  const del = useMktAdSpendDelete();
  const patch = useMktAdSpendPatch();
  const confirm = useConfirm();
  const today = toDateInputValue(new Date());
  const blank = { period_start: today, period_end: today, source_id: "", source_label: "", amount: "", note: "" };
  const [draft, setDraft] = useState(blank);
  const [err, setErr] = useState<"" | "amount" | "source">("");

  const submit = () => {
    if (!draft.amount || Number(draft.amount) <= 0) {
      setErr("amount");
      toast.error(t("marketing.adspend.err_amount"));
      return;
    }
    if (!draft.source_id && !draft.source_label.trim()) {
      setErr("source");
      toast.error(t("marketing.adspend.err_source"));
      return;
    }
    setErr("");
    create.mutate(
      {
        period_start: draft.period_start,
        period_end: draft.period_end,
        source: draft.source_id ? Number(draft.source_id) : null,
        source_label: draft.source_label.trim(),
        amount: draft.amount,
        note: draft.note,
      },
      {
        onSuccess: () => {
          toast.success(t("marketing.adspend.created"));
          setDraft(blank);
        },
        onError: (e) => toast.error(errDetail(e) || t("marketing.adspend.create_failed")),
      },
    );
  };

  const rows = list.data ?? [];
  const total = rows.reduce((a, r) => a + Number(r.amount), 0);

  return (
    <>
      <section className="card col">
        <div className="card-h"><span className="h3">{t("marketing.adspend.add_title")}</span><span className="xs c3">{t("v2.admin.marketing.spendSub")}</span></div>
        <form
          className="col g12"
          style={{ padding: "16px 20px 18px" }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="row g8 wrap" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ width: 150 }}>
              <label htmlFor="sp1">{t("v2.admin.marketing.periodFrom")}</label>
              <input id="sp1" className="input num" type="date" value={draft.period_start} max={draft.period_end || undefined} onChange={(e) => setDraft({ ...draft, period_start: e.target.value })} />
            </div>
            <div className="field" style={{ width: 150 }}>
              <label htmlFor="sp2">{t("v2.admin.marketing.periodTo")}</label>
              <input id="sp2" className="input num" type="date" value={draft.period_end} min={draft.period_start || undefined} onChange={(e) => setDraft({ ...draft, period_end: e.target.value })} />
            </div>
            <div className="field grow" style={{ flexBasis: 180 }}>
              <label htmlFor="sp3">{t("marketing.adspend.source")}</label>
              <select id="sp3" className={cx("input", err === "source" && "is-bad")} value={draft.source_id} onChange={(e) => setDraft({ ...draft, source_id: e.target.value })}>
                <option value="">— {t("marketing.adspend.pick_source")} —</option>
                {(sources.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="field grow" style={{ flexBasis: 180 }}>
              <label htmlFor="sp4">{t("v2.admin.marketing.orName")}</label>
              <input
                id="sp4"
                className={cx("input", err === "source" && !draft.source_id && "is-bad")}
                type="text"
                value={draft.source_label}
                disabled={!!draft.source_id}
                placeholder={t("marketing.adspend.custom_label_ph")}
                onChange={(e) => setDraft({ ...draft, source_label: e.target.value })}
              />
            </div>
            <div className="field" style={{ width: 160 }}>
              <label htmlFor="sp5">{t("marketing.adspend.amount")}</label>
              <input id="sp5" className={cx("input num", err === "amount" && "is-bad")} type="number" min="0" step="1000" value={draft.amount} placeholder={t("marketing.adspend.amount_ph")} style={{ textAlign: "right" }} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            </div>
            <button className="btn btn-pri" type="submit" disabled={create.isPending}>
              <Plus className="ic ic-s" />
              {t("common.save")}
            </button>
          </div>
          {err ? <span className="err">{err === "amount" ? t("marketing.adspend.err_amount") : t("marketing.adspend.err_source")}</span> : null}
          <input className="input" type="text" value={draft.note} placeholder={t("marketing.adspend.note_ph")} aria-label={t("marketing.adspend.note")} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          <span className="hint">{t("v2.admin.marketing.spendHint")}</span>
        </form>
      </section>

      <section className="card tbl">
        <div className="card-h">
          <span className="h3">{t("marketing.adspend.list_title")}</span>
          <span className="s">{t("marketing.adspend.total")}: <span className="num w6">{formatUZS(total)}</span></span>
        </div>
        {list.isLoading ? (
          <LoadingBlock rows={4} onRetry={() => list.refetch()} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("marketing.adspend.empty")} />
        ) : (
          <div className="scroll-x">
            <div style={{ minWidth: 760 }}>
              <div className="tr th" style={{ gridTemplateColumns: SPEND_COLS }}>
                <span>{t("marketing.adspend.period")}</span>
                <span>{t("marketing.adspend.source")}</span>
                <span className="r">{t("marketing.adspend.amount")}</span>
                <span>{t("marketing.adspend.note")}</span>
                <span />
              </div>
              {rows.map((r) => (
                <div key={r.id} className="tr" style={{ gridTemplateColumns: SPEND_COLS }}>
                  <span className="num s">{r.period_start} — {r.period_end}</span>
                  <span className="s w6 trunc">{r.resolved_label}</span>
                  <input
                    key={`${r.id}-${r.amount}`}
                    className="input num"
                    type="number"
                    min="0"
                    defaultValue={r.amount}
                    aria-label={`${t("marketing.adspend.amount")}: ${r.resolved_label}`}
                    style={{ height: 34, textAlign: "right" }}
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v && Number(v) !== Number(r.amount))
                        patch.mutate(
                          { id: r.id, fields: { amount: v } },
                          {
                            onSuccess: () => toast.success(t("v2.admin.marketing.amountSaved")),
                            onError: (er) => {
                              e.target.value = r.amount;
                              toast.error(errDetail(er) || t("common.save_failed"));
                            },
                          },
                        );
                    }}
                  />
                  <span className="s c3 trunc">{r.note}</span>
                  <button
                    className="btn btn-ghost btn-sq btn-sm"
                    type="button"
                    aria-label={t("common.delete")}
                    title={t("common.delete")}
                    style={{ color: "var(--bad)" }}
                    disabled={del.isPending && del.variables === r.id}
                    onClick={async () => {
                      const ok = await confirm({
                        title: t("marketing.adspend.confirm_delete"),
                        body: t("v2.admin.marketing.deleteBody", { src: r.resolved_label, period: `${r.period_start} — ${r.period_end}`, sum: formatUZS(r.amount) }),
                        confirm: t("common.delete"),
                        danger: true,
                      });
                      if (ok)
                        del.mutate(r.id, {
                          onSuccess: () => toast.success(t("marketing.adspend.deleted")),
                          onError: (e) => toast.error(errDetail(e) || t("common.save_failed")),
                        });
                    }}
                  >
                    <Trash2 className="ic ic-s" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      {confirm.node}
    </>
  );
}
