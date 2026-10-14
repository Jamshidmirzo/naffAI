import { Fragment, useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, FileSpreadsheet, Info } from "lucide-react";
import { CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import {
  apiErrorText,
  useLeadStats,
  useRetryExport,
  useRetryStatuses,
  useSaveRetryStatuses,
  type LeadStatsOperatorRow,
} from "../api/managerDaily";

/* ── period presets (same as the old page; always sent as date_from/date_to) ── */

type Preset = "today" | "yesterday" | "week" | "month" | "this_month" | "custom";

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function presetRange(p: Preset): { from: string; to: string } | null {
  const now = new Date();
  const today = fmt(now);
  if (p === "today") return { from: today, to: today };
  if (p === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: fmt(y), to: fmt(y) };
  }
  if (p === "week" || p === "month") {
    const past = new Date(now);
    past.setDate(past.getDate() - (p === "week" ? 6 : 29));
    return { from: fmt(past), to: today };
  }
  if (p === "this_month") return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
  return null;
}

const PRESETS: { value: Preset; key: string }[] = [
  { value: "today", key: "reports.activity.presets.today" },
  { value: "yesterday", key: "reports.activity.presets.yesterday" },
  { value: "week", key: "reports.activity.presets.week" },
  { value: "month", key: "reports.activity.presets.month" },
  { value: "this_month", key: "reports.activity.presets.this_month" },
  { value: "custom", key: "reports.activity.presets.custom" },
];

/** Status tone → bar colour and number colour (Atlas tokens). */
const TONE: Record<string, { bar: string; text: string }> = {
  neutral: { bar: "var(--ink-4)", text: "var(--ink-3)" },
  info: { bar: "var(--brand)", text: "var(--brand-text)" },
  hot: { bar: "var(--hot-solid)", text: "var(--hot)" },
  warn: { bar: "var(--warn-solid)", text: "var(--warn)" },
  danger: { bar: "var(--bad-solid)", text: "var(--bad)" },
  success: { bar: "var(--ok-solid)", text: "var(--ok)" },
};
const tone = (t: string | undefined) => TONE[t || "neutral"] || TONE.neutral;

const ddmm = (iso: string) => (iso && iso.length >= 10 ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : iso);
const pctText = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");

function initials(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "—";
}

/** Nice axis ticks for the horizontal status bars. */
function axisTicks(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const raw = max / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

type SortKey = "total" | "calls_total" | "unique_leads_touched" | "won" | "sold_total" | "in_progress" | "lost" | "conversion_pct";

const OP_COLS = "minmax(0, 1.5fr) 70px 80px 100px 110px 100px 80px 86px 96px";

export default function LeadsStats() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const pickLabel = (s: { label_uz?: string; label_ru?: string; code: string }) =>
    (lang === "uz" ? s.label_uz : s.label_ru) || s.label_ru || s.label_uz || s.code;

  const [preset, setPreset] = useState<Preset>("today");
  const initial = presetRange("today")!;
  const [dateFrom, setDateFrom] = useState(initial.from);
  const [dateTo, setDateTo] = useState(initial.to);
  const applyPreset = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p);
    if (r) {
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  };

  const q = useLeadStats(dateFrom, dateTo);
  const data = q.data;

  /* retry export: statuses selection + export */
  const statusesQ = useRetryStatuses();
  const saveStatuses = useSaveRetryStatuses();
  const exportMut = useRetryExport();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (statusesQ.data) setSelected(new Set(statusesQ.data.statuses));
  }, [statusesQ.data]);
  const dirty = useMemo(() => {
    const server = new Set(statusesQ.data?.statuses ?? []);
    if (server.size !== selected.size) return true;
    for (const c of selected) if (!server.has(c)) return true;
    return false;
  }, [selected, statusesQ.data]);
  const toggleStatus = (code: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  const onSave = () =>
    saveStatuses.mutate(Array.from(selected), {
      onSuccess: () => toast.success(t("leads_stats.retry_statuses.saved")),
      onError: (e) => toast.error(apiErrorText(e, t("v2.state.errorBody"))),
    });
  const onExport = () =>
    exportMut.mutate(undefined, {
      onSuccess: (d) =>
        toast.success(t("leads_stats.retry_export.success", { n: d.count }), {
          action: { label: t("leads_stats.retry_export.open"), onClick: () => window.open(d.url, "_blank", "noopener") },
          duration: 8000,
        }),
      onError: (e) => {
        if ((e as { response?: { status?: number } })?.response?.status === 409) toast.message(t("leads_stats.retry_export.busy"));
        else toast.error(apiErrorText(e, t("v2.state.errorBody")));
      },
    });

  /* operators table: expand + sort */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const ops = useMemo(() => {
    const rows = [...(data?.by_operator ?? [])];
    if (sort) rows.sort((a, b) => ((Number(a[sort.key] ?? 0) - Number(b[sort.key] ?? 0)) * sort.dir));
    return rows;
  }, [data, sort]);
  const statusMeta = useMemo(() => {
    const m: Record<string, { label: string; tone: string }> = {};
    for (const s of data?.by_status ?? []) m[s.code] = { label: pickLabel(s), tone: s.tone };
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lang]);

  const maxStatus = Math.max(0, ...(data?.by_status ?? []).map((s) => s.count));
  const axis = axisTicks(maxStatus);

  const rangeText = dateFrom === dateTo ? ddmm(dateFrom) : `${ddmm(dateFrom)} – ${ddmm(dateTo)}`;

  const SortTh = ({ k, label, hint }: { k: SortKey; label: string; hint?: string }) => {
    const on = sort?.key === k;
    return (
      <button
        className={cx("th-s r", on && "is-on")}
        type="button"
        title={hint}
        aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : undefined}
        onClick={() => setSort(on ? (sort!.dir === -1 ? { key: k, dir: 1 } : null) : { key: k, dir: -1 })}
        style={{ justifySelf: "end", textAlign: "right" }}
      >
        <span>{label}</span>
        {hint ? <Info className="ic ic-s" aria-hidden="true" /> : null}
        {on ? sort!.dir === -1 ? <ArrowDown className="ic ic-s" /> : <ArrowUp className="ic ic-s" /> : null}
      </button>
    );
  };

  const tabs: [string, string][] = [
    ["/analytics", "v2.lstats.tabTeam"],
    ["/leads-stats", "v2.lstats.tabLeads"],
    ["/marketing", "v2.lstats.tabMarketing"],
    ["/marketing/sources", "v2.lstats.tabSources"],
    ["/reports", "v2.lstats.tabReports"],
  ];

  const available = statusesQ.data?.available ?? [];

  return (
    <>
      <PageHeader title={t("v2.lstats.title")}>
        <div className="seg" role="group" style={{ flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button key={p.value} type="button" className={cx(preset === p.value && "is-on")} aria-pressed={preset === p.value} onClick={() => applyPreset(p.value)}>
              {t(p.key)}
            </button>
          ))}
        </div>
        {preset === "custom" ? (
          <span className="row g6">
            <input className="input num" type="date" aria-label={t("v2.lstats.from")} value={dateFrom} max={dateTo || undefined} onChange={(e) => e.target.value && setDateFrom(e.target.value)} style={{ width: 150, height: 36 }} />
            <span className="c3">—</span>
            <input className="input num" type="date" aria-label={t("v2.lstats.to")} value={dateTo} min={dateFrom || undefined} onChange={(e) => e.target.value && setDateTo(e.target.value)} style={{ width: 150, height: 36 }} />
          </span>
        ) : (
          <span className="num s c3">{rangeText}</span>
        )}
      </PageHeader>
      <main className="page">
        <nav className="tabs" aria-label={t("v2.lstats.title")}>
          {tabs.map(([to, key]) => (
            <NavLink key={to} to={to} end className={({ isActive }) => cx("tab", isActive && "is-on")}>
              {t(key)}
            </NavLink>
          ))}
        </nav>

        <div className="row g16 wrap" style={{ alignItems: "stretch" }}>
          <section className="card col g4 pad" style={{ flex: "1 1 200px" }}>
            <span className="lbl">{t("leads_stats.total_label")}</span>
            {q.isLoading ? <i className="sk" style={{ display: "block", height: 34, width: 110 }} /> : <span className="kpi">{data ? fmtNum(data.total) : "—"}</span>}
            <span className="s c3 num">{rangeText}</span>
          </section>

          <section className="card col g12 pad" style={{ flex: "3 1 600px", minWidth: 0 }}>
            <div className="row between wrap g8">
              <span className="h3">{t("v2.lstats.retryTitle")}</span>
              <span className="xs c3">{t("v2.lstats.retrySub")}</span>
            </div>
            {statusesQ.isLoading ? (
              <div className="row g6">{[0, 1, 2, 3].map((i) => <i key={i} className="sk" style={{ display: "block", height: 32, width: 110, borderRadius: 99 }} />)}</div>
            ) : statusesQ.isError ? (
              <div className="row g8 wrap">
                <span className="s c-bad">{t("v2.lstats.retryLoadErr")}</span>
                <button className="btn btn-sm" type="button" onClick={() => statusesQ.refetch()}>{t("v2.state.retry")}</button>
              </div>
            ) : available.length === 0 ? (
              <span className="s c3">{t("v2.lstats.retryNone")}</span>
            ) : (
              <div className="row g6 wrap" role="group" aria-label={t("leads_stats.retry_statuses.title")} title={t("leads_stats.retry_statuses.subtitle")}>
                {available.map((s) => {
                  const on = selected.has(s.code);
                  return (
                    <button key={s.code} type="button" className={cx("chip", on && "is-on")} aria-pressed={on} onClick={() => toggleStatus(s.code)}>
                      {on ? <Check className="ic ic-s" /> : null}
                      {pickLabel(s)}
                    </button>
                  );
                })}
                <span className="xs c3">{t("leads_stats.retry_statuses.count", { n: selected.size })}</span>
                <button className="btn btn-ghost btn-sm" type="button" disabled={!dirty || saveStatuses.isPending} onClick={onSave}>
                  {saveStatuses.isPending ? t("leads_stats.retry_statuses.saving") : t("leads_stats.retry_statuses.save")}
                </button>
              </div>
            )}
            <div className="row g8 wrap">
              <button className="btn btn-pri" type="button" disabled={exportMut.isPending} onClick={onExport} title={t("leads_stats.retry_export.hint")} style={{ color: "var(--brand-ink)" }}>
                <FileSpreadsheet className="ic" />
                {exportMut.isPending ? t("leads_stats.retry_export.pending") : t("v2.lstats.retryExport")}
              </button>
            </div>
          </section>
        </div>

        {q.isError ? (
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        ) : q.isLoading || !data ? (
          <section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section>
        ) : (
          <>
            {/* by status */}
            <section className="card col">
              <div className="card-h">
                <span className="h3">{t("leads_stats.by_status")}</span>
                <span className="xs c3">{t("v2.lstats.statusShare", { n: fmtNum(data.total) })}</span>
              </div>
              {data.by_status.length === 0 ? (
                <div className="s c3" style={{ padding: "16px 20px" }}>{t("leads_stats.no_data")}</div>
              ) : (
                <div className="row g24 wrap" style={{ padding: "16px 20px", alignItems: "flex-start" }}>
                  <div className="col grow" style={{ gap: 10, minWidth: 320, flex: "1 1 420px" }}>
                    {data.by_status.map((s) => (
                      <div key={s.code} className="row g12" title={`${pickLabel(s)}: ${fmtNum(s.count)} · ${pctText(s.pct)}%`}>
                        <span className="s trunc" style={{ width: 150, flex: "none" }}>{pickLabel(s)}</span>
                        <span className="grow" style={{ position: "relative", height: 18, background: "var(--surface-3)", borderRadius: 4 }}>
                          <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(s.count / axis.top) * 100}%`, background: tone(s.tone).bar, borderRadius: 4 }} />
                        </span>
                        <span className="num s w6" style={{ width: 56, textAlign: "right", flex: "none" }}>{fmtNum(s.count)}</span>
                      </div>
                    ))}
                    <div className="row g12">
                      <span style={{ width: 150, flex: "none" }} />
                      <span className="grow row between num xs c3">{axis.ticks.map((v) => <span key={v}>{fmtNum(v)}</span>)}</span>
                      <span style={{ width: 56, flex: "none" }} />
                    </div>
                  </div>
                  <div style={{ flex: "1 1 360px", maxWidth: 470, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
                    {data.by_status.map((s) => (
                      <div key={s.code} className="col" style={{ position: "relative", overflow: "hidden", padding: "12px 12px 8px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface)" }}>
                        <i style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: tone(s.tone).bar }} />
                        <span className="s w6 trunc">{pickLabel(s)}</span>
                        <span className="row g6" style={{ alignItems: "baseline" }}>
                          <span className="num w7" style={{ fontSize: 18, color: tone(s.tone).text }}>{fmtNum(s.count)}</span>
                          <span className="num xs c3">{pctText(s.pct)}%</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* by operator */}
            <section className="card tbl">
              <div className="card-h">
                <span className="h3">{t("leads_stats.by_operator")}</span>
                <span className="xs c3">{t("v2.lstats.opsHint")}</span>
              </div>
              {ops.length === 0 ? (
                <div className="s c3" style={{ padding: "16px 20px" }}>{t("leads_stats.no_data")}</div>
              ) : (
                <>
                  <div style={{ overflowX: "auto" }}>
                    <div style={{ minWidth: 980 }}>
                      <div className="tr th" style={{ gridTemplateColumns: OP_COLS }}>
                        <span>{t("leads_stats.op_name")}</span>
                        <SortTh k="total" label={t("leads_stats.op_total")} />
                        <SortTh k="calls_total" label={t("leads_stats.op_calls_total")} hint={t("leads_stats.op_calls_total_hint")} />
                        <SortTh k="unique_leads_touched" label={t("leads_stats.op_unique_leads")} hint={t("leads_stats.op_unique_leads_hint")} />
                        <SortTh k="won" label={t("leads_stats.op_won")} hint={t("leads_stats.op_won_hint")} />
                        <SortTh k="sold_total" label={t("leads_stats.op_sold_total")} hint={t("leads_stats.op_sold_total_hint")} />
                        <SortTh k="in_progress" label={t("leads_stats.op_in_progress")} />
                        <SortTh k="lost" label={t("leads_stats.op_lost")} />
                        <SortTh k="conversion_pct" label={t("leads_stats.op_conversion")} />
                      </div>
                      {ops.map((r) => (
                        <OperatorRow key={r.operator_id} r={r} open={expanded.has(r.operator_id)} onToggle={() => toggleExpand(r.operator_id)} statusMeta={statusMeta} />
                      ))}
                    </div>
                  </div>
                  <div className="col g4 xs c3" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", background: "var(--surface-2)", borderRadius: "0 0 14px 14px" }}>
                    <span><b className="c2">{t("leads_stats.op_calls_total")}</b> — {t("leads_stats.op_calls_total_hint")} <b className="c2">{t("leads_stats.op_unique_leads")}</b> — {t("leads_stats.op_unique_leads_hint")}</span>
                    <span><b className="c2">{t("leads_stats.op_won")}</b> — {t("leads_stats.op_won_hint")} <b className="c2">{t("leads_stats.op_sold_total")}</b> — {t("leads_stats.op_sold_total_hint")}</span>
                  </div>
                </>
              )}
            </section>

            {/* daily */}
            <section className="card col">
              <div className="card-h">
                <span className="h3">{t("leads_stats.daily")}</span>
                <div className="row g16 xs c2">
                  {[["var(--ink-3)", "leads_stats.d_created"], ["var(--ok-solid)", "leads_stats.d_won"], ["var(--bad-solid)", "leads_stats.d_lost"]].map(([c, k]) => (
                    <span key={k} className="row g6"><i style={{ display: "inline-block", width: 14, height: 3, borderRadius: 2, background: c }} />{t(k)}</span>
                  ))}
                </div>
              </div>
              {data.daily.length > 1 ? (
                <div style={{ padding: "12px 16px 8px", width: "100%", height: 280 }}>
                  <ResponsiveContainer>
                    <LineChart data={data.daily} margin={{ top: 18, right: 16, bottom: 4, left: -8 }}>
                      <CartesianGrid stroke="var(--line)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={ddmm} tick={{ fontSize: 11, fill: "var(--ink-3)", fontFamily: "var(--mono)" }} axisLine={{ stroke: "var(--line)" }} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--ink-3)", fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} />
                      <Tooltip
                        labelFormatter={(l) => ddmm(String(l))}
                        contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, fontSize: 12, color: "var(--ink)" }}
                      />
                      {([["created", "var(--ink-3)", "leads_stats.d_created"], ["won", "var(--ok-solid)", "leads_stats.d_won"], ["lost", "var(--bad-solid)", "leads_stats.d_lost"]] as const).map(([key, color, label]) => (
                        <Line key={key} type="linear" dataKey={key} name={t(label)} stroke={color} strokeWidth={2} dot={{ r: 3, fill: "var(--surface)", stroke: color, strokeWidth: 1.5 }} activeDot={{ r: 4 }} isAnimationActive={false}>
                          {data.daily.length <= 16 ? <LabelList dataKey={key} position="top" formatter={(v: unknown) => (Number(v) ? String(v) : "")} style={{ fontSize: 10, fill: color, fontFamily: "var(--mono)" }} /> : null}
                        </Line>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="s c3" style={{ padding: "16px 20px" }}>{t("v2.lstats.dailyOneDay")}</div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function OperatorRow({
  r,
  open,
  onToggle,
  statusMeta,
}: {
  r: LeadStatsOperatorRow;
  open: boolean;
  onToggle: () => void;
  statusMeta: Record<string, { label: string; tone: string }>;
}) {
  const t = useT2();
  const entries = Object.entries(r.by_status ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <Fragment>
      <div
        className={cx("tr", open && "is-sel")}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}
        style={{ gridTemplateColumns: OP_COLS, cursor: "pointer" }}
      >
        <span className="row g8" style={{ minWidth: 0 }}>
          {open ? <ChevronDown className="ic ic-s c3" /> : <ChevronRight className="ic ic-s c3" />}
          <span className="ava ava-s">{initials(r.operator_name)}</span>
          <span className="trunc">{r.operator_name}</span>
        </span>
        <span className="r num">{fmtNum(r.total)}</span>
        <span className="r num c2">{fmtNum(r.calls_total ?? 0)}</span>
        <span className="r num c2">{fmtNum(r.unique_leads_touched ?? 0)}</span>
        <span className="r num w6 c-ok">{fmtNum(r.won)}</span>
        <span className="r num c-ok">{fmtNum(r.sold_total ?? 0)}</span>
        <span className="r num c2">{fmtNum(r.in_progress)}</span>
        <span className="r num c-bad">{fmtNum(r.lost)}</span>
        <span className="r num w6">{pctText(r.conversion_pct)}%</span>
      </div>
      {open ? (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--line)", background: "var(--surface-2)" }}>
          {entries.length === 0 ? (
            <span className="s c3">{t("v2.lstats.noBreakdown")}</span>
          ) : (
            <div className="row g8 wrap">
              {entries.map(([code, n]) => {
                const m = statusMeta[code] ?? { label: code, tone: "neutral" };
                return (
                  <span key={code} className="row g6 s" style={{ padding: "5px 10px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--line)", borderLeft: `3px solid ${tone(m.tone).bar}` }}>
                    <span className="c3">{m.label}:</span>
                    <span className="num w6">{fmtNum(n)}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </Fragment>
  );
}
