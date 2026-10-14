import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Check, ChevronDown, CircleX, Download, FileText, Lock, Search, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  payrollDownload,
  usePayrollDetail,
  usePayrollList,
  usePayrollRule,
  usePayrollRuleReset,
  usePayrollRuleSave,
  type PayrollDay,
  type PayrollDetail,
  type PayrollPayoutType,
  type PayrollRow,
  type PayrollRuleDto,
} from "../api/team/payroll";

type T = ReturnType<typeof useT2>;
const TZ = "Asia/Tashkent";

/* ---------------- helpers ---------------- */

/** Current month «YYYY-MM» in Tashkent time. */
function tashkentMonth(): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const y = p.find((x) => x.type === "year")?.value ?? "2026";
  const m = p.find((x) => x.type === "month")?.value ?? "01";
  return `${y}-${m}`;
}

/** Last 24 months up to the current one (no future months, as in the old picker). */
function monthOptions(t: T): { value: string; label: string }[] {
  const names = t("v2.team.payroll.months").split(",");
  const [cy, cm] = tashkentMonth().split("-").map(Number);
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 24; i++) {
    const idx = cy * 12 + (cm - 1) - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    out.push({ value: `${y}-${String(m).padStart(2, "0")}`, label: `${names[m - 1]} ${y}` });
  }
  return out;
}

function fmtHM(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** «Пн, 13 окт» from a calendar date «YYYY-MM-DD» (no timezone shift). */
function fmtDay(date: string, t: T): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${t("v2.team.payroll.wdShort").split(",")[wd]}, ${d} ${t("v2.team.payroll.monthsShort").split(",")[m - 1]}`;
}

function pct(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "—";
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
  return `${s}%`;
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function formula(rule: NonNullable<PayrollRuleDto>, t: T): string {
  const v = rule.payout_value;
  switch (rule.payout_type) {
    case "percent":
      return t("payroll_rule.formula_percent", { value: Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) });
    case "fixed":
      return t("payroll_rule.formula_fixed", { value: fmtNum(v) });
    case "tiers":
      return t("payroll_rule.formula_tiers");
  }
}

/* ---------------- page ---------------- */

export default function Payroll() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const months = useMemo(() => monthOptions(t), [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const [month, setMonth] = useState<string>(tashkentMonth());
  const [selectedOpIds, setSelectedOpIds] = useState<number[]>([]);
  const [drillOpId, setDrillOpId] = useState<number | null>(null);
  const [sortPay, setSortPay] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  const list = usePayrollList(month);
  const rowsAll = list.data?.rows ?? [];
  const options = useMemo(() => rowsAll.map((r) => ({ id: r.operator_id, name: r.operator_name })), [rowsAll]);

  const rows = useMemo(() => {
    let r = rowsAll;
    if (selectedOpIds.length) {
      const set = new Set(selectedOpIds);
      r = r.filter((x) => set.has(x.operator_id));
    }
    if (sortPay) r = [...r].sort((a, b) => Number(b.total_earned) - Number(a.total_earned));
    return r;
  }, [rowsAll, selectedOpIds, sortPay]);

  const summary = useMemo(() => {
    const total = rows.reduce((s, r) => s + (Number(r.total_earned) || 0), 0);
    const both = rows.filter((r) => r.attendance.gate_passed && r.sales.gate_passed).length;
    const attG = new Set(rows.map((r) => r.attendance_gate_pct));
    const salG = new Set(rows.map((r) => r.sales_gate_pct));
    return {
      total,
      both,
      gates: attG.size === 1 && salG.size === 1 ? { att: rows[0].attendance_gate_pct, sal: rows[0].sales_gate_pct } : null,
    };
  }, [rows]);

  const selectedRow = rowsAll.find((r) => r.operator_id === drillOpId) ?? null;

  const open = (id: number) => {
    setDrillOpId(id);
    // Narrow screens: the panel wraps under the list — bring it into view.
    window.setTimeout(() => {
      const el = panelRef.current;
      if (el && el.getBoundingClientRect().top > window.innerHeight) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const cols = "minmax(160px, 1fr) 104px 104px 84px 84px 112px";

  return (
    <>
      <PageHeader
        title={t("v2.team.payroll.title")}
        meta={
          <span className="badge">
            <Lock className="ic ic-s" />
            {t("v2.team.payroll.pin")}
          </span>
        }
      >
        <span className="s c3">{t("v2.team.payroll.month")}</span>
        <select
          className="input"
          aria-label={t("v2.team.payroll.month")}
          style={{ width: 170 }}
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
          }}
        >
          {months.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <OperatorMulti options={options} selected={selectedOpIds} onChange={setSelectedOpIds} />
      </PageHeader>

      <main className="page">
        {rows.length > 0 ? (
          <div className="row g24 wrap s">
            <span>
              <span className="c3">{t("v2.team.payroll.totalPay")}</span> <span className="num w6">{fmtNum(summary.total)}</span>{" "}
              <span className="c3">{t("v2.team.payroll.sum")}</span>
            </span>
            <span>
              <span className="c3">{t("v2.team.payroll.bothPassed")}</span> <span className="num w6">{summary.both}</span>{" "}
              <span className="c3">{t("v2.team.payroll.ofN", { n: rows.length })}</span>
            </span>
            {summary.gates ? (
              <span>
                <span className="c3">{t("v2.team.payroll.gates")}</span> <span className="num">{summary.gates.att}%</span>{" "}
                <span className="c3">{t("v2.team.payroll.gatesAtt")}</span> <span className="num">{summary.gates.sal}%</span>{" "}
                <span className="c3">{t("v2.team.payroll.gatesSales")}</span>
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="split">
          <section className="list card tbl">
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 640 }}>
                <div className="tr th" style={{ gridTemplateColumns: cols }}>
                  <span>{t("v2.team.payroll.colOperator")}</span>
                  <span className="r">{t("v2.team.payroll.colPlan")}</span>
                  <span className="r">{t("v2.team.payroll.colSold")}</span>
                  <span>{t("v2.team.payroll.colAtt")}</span>
                  <span>{t("v2.team.payroll.colSales")}</span>
                  <button
                    className={cx("th-s r", sortPay && "is-on")}
                    type="button"
                    title={t("v2.team.payroll.sortHint")}
                    aria-pressed={sortPay}
                    onClick={() => setSortPay((v) => !v)}
                  >
                    {t("v2.team.payroll.colPay")}
                    {sortPay ? <ArrowDown className="ic ic-s" /> : null}
                  </button>
                </div>
                {list.isLoading ? (
                  <LoadingBlock rows={6} onRetry={() => list.refetch()} />
                ) : list.isError ? (
                  <ErrorState error={list.error} onRetry={() => list.refetch()} />
                ) : rowsAll.length === 0 ? (
                  <EmptyState title={t("v2.team.payroll.emptyTitle")} body={t("v2.team.payroll.emptyBody")} />
                ) : rows.length === 0 ? (
                  <EmptyState
                    title={t("v2.team.payroll.emptyFilteredTitle")}
                    body={t("v2.team.payroll.emptyFilteredBody")}
                    action={<button className="btn" type="button" onClick={() => setSelectedOpIds([])}>{t("v2.team.payroll.clear")}</button>}
                  />
                ) : (
                  rows.map((r) => <PayrollTableRow key={r.operator_id} r={r} cols={cols} sel={r.operator_id === drillOpId} onOpen={() => open(r.operator_id)} />)
                )}
              </div>
            </div>
            {rows.length > 0 ? (
              <div className="row between xs c3 wrap g8" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
                <span>{t("v2.team.payroll.footHint")}</span>
                <span>{t("v2.team.payroll.footCount", { shown: rows.length, total: rowsAll.length })}</span>
              </div>
            ) : null}
          </section>

          {rowsAll.length > 0 ? (
            <aside className="panel card col" ref={panelRef} style={{ flex: "1 1 400px", maxWidth: "100%" }}>
              {drillOpId == null ? (
                <EmptyState title={t("v2.team.payroll.pickTitle")} body={t("v2.team.payroll.pickBody")} />
              ) : (
                <PayrollPanel key={`${drillOpId}-${month}`} operatorId={drillOpId} month={month} fallbackName={selectedRow?.operator_name ?? ""} onClose={() => setDrillOpId(null)} />
              )}
            </aside>
          ) : null}
        </div>
      </main>
    </>
  );
}

function PayrollTableRow({ r, cols, sel, onOpen }: { r: PayrollRow; cols: string; sel: boolean; onOpen: () => void }) {
  const zero = Number(r.total_earned) === 0;
  return (
    <div
      className={cx("tr", sel && "is-sel")}
      style={{ gridTemplateColumns: cols, cursor: "pointer" }}
      role="button"
      tabIndex={0}
      aria-pressed={sel}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="row g8" style={{ minWidth: 0 }}>
        <span className="ava ava-s">{initials(r.operator_name)}</span>
        <span className="w6 trunc">{r.operator_name}</span>
      </span>
      <span className="r num s c2">{fmtNum(r.sales.plan_amount_uzs)}</span>
      <span className="r num s">{fmtNum(r.sales.actual_uzs)}</span>
      <GateCell passed={r.attendance.gate_passed} rate={r.attendance.rate_pct} />
      <GateCell passed={r.sales.gate_passed} rate={r.sales.rate_pct} />
      <span className={cx("r num w6", zero && "c3")}>{fmtNum(r.total_earned)}</span>
    </div>
  );
}

function GateCell({ passed, rate }: { passed: boolean; rate: number }) {
  const t = useT2();
  return (
    <span className={cx("row g4 num s w6", passed ? "c-ok" : "c-bad")} title={passed ? t("v2.team.payroll.passed") : t("v2.team.payroll.failed")}>
      {passed ? <Check className="ic ic-s" /> : <CircleX className="ic ic-s" />}
      {pct(rate)}
    </span>
  );
}

/* ---------------- operator multi-select ---------------- */

function OperatorMulti({ options, selected, onChange }: { options: { id: number; name: string }[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const t = useT2();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter((o) => o.name.toLowerCase().includes(n)) : options;
  }, [options, q]);

  const has = selected.length > 0;
  const label = has ? t("v2.team.payroll.opsSelected", { n: selected.length }) : t("v2.team.payroll.opsAll");
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <span
        className="row g4"
        style={{
          height: 40,
          padding: has ? "0 6px 0 12px" : "0 12px",
          border: `1px solid ${has ? "var(--brand)" : "var(--line-2)"}`,
          borderRadius: 9,
          background: has ? "var(--brand-soft)" : "var(--surface)",
        }}
      >
        <button
          className={cx("s w6", has ? "c-brand" : "c2")}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          style={{ border: 0, background: "none", padding: 0, display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}
          onClick={() => setOpen((v) => !v)}
        >
          {label}
          <ChevronDown className={cx("ic ic-s", has && "c-brand")} />
        </button>
        {has ? (
          <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.team.payroll.clear")} style={{ width: 26, height: 26 }} onClick={() => onChange([])}>
            <X className="ic ic-s" />
          </button>
        ) : null}
      </span>
      {open ? (
        <section className="dlg" style={{ position: "absolute", right: 0, top: 46, width: 320, maxWidth: "calc(100vw - 32px)", zIndex: 30 }}>
          <div className="col g8" style={{ padding: 12 }}>
            <div className="row between">
              <span className="s w6">{label}</span>
              {has ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => onChange([])}>{t("v2.team.payroll.clear")}</button> : null}
            </div>
            {options.length > 8 ? (
              <div className="inwrap">
                <Search className="ic" />
                <input className="input" type="search" autoFocus placeholder={t("v2.team.payroll.search")} aria-label={t("v2.team.payroll.searchAria")} value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            ) : null}
            <div className="col g8" role="listbox" aria-multiselectable="true" style={{ maxHeight: 300, overflowY: "auto" }}>
              {filtered.length === 0 ? <span className="s c3">{t("v2.team.payroll.nothing")}</span> : null}
              {filtered.map((o) => (
                <label key={o.id} className="row g8 s" style={{ cursor: "pointer" }}>
                  <input className="check" type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                  <span className="trunc">{o.name}</span>
                </label>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ---------------- drill-down panel ---------------- */

function PayrollPanel({ operatorId, month, fallbackName, onClose }: { operatorId: number; month: string; fallbackName: string; onClose: () => void }) {
  const t = useT2();
  const q = usePayrollDetail(operatorId, month);
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);

  const download = async (format: "xlsx" | "pdf") => {
    setDownloading(format);
    try {
      await payrollDownload(operatorId, month, format);
    } catch {
      toast.error(t("v2.team.payroll.downloadFailed"));
    } finally {
      setDownloading(null);
    }
  };

  const d = q.data;
  return (
    <>
      <div className="card-h" style={{ alignItems: "flex-start" }}>
        <div className="col" style={{ minWidth: 0 }}>
          <span className="h3 trunc">{d?.operator_name ?? fallbackName}</span>
          {d ? <span className="xs c3">{t("payroll.shift_hint", { from: d.shift_start, to: d.shift_end, grace: d.grace_period_min })}</span> : null}
        </div>
        <div className="row g6">
          <button className="btn btn-sm" type="button" disabled={!d || downloading != null} onClick={() => download("xlsx")}>
            <Download className="ic ic-s" />
            {downloading === "xlsx" ? t("common.loading") : t("payroll.download_xlsx")}
          </button>
          <button className="btn btn-sm" type="button" disabled={!d || downloading != null} onClick={() => download("pdf")}>
            <FileText className="ic ic-s" />
            {downloading === "pdf" ? t("common.loading") : t("payroll.download_pdf")}
          </button>
          <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("common.close")} onClick={onClose}>
            <X className="ic" />
          </button>
        </div>
      </div>
      {q.isLoading ? (
        <LoadingBlock rows={5} onRetry={() => q.refetch()} />
      ) : q.isError || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <PayrollBreakdown d={d} />
      )}
    </>
  );
}

function PayrollBreakdown({ d }: { d: PayrollDetail }) {
  const t = useT2();
  const a = d.attendance;
  const s = d.sales;
  const zero = Number(d.total_earned) === 0;
  return (
    <>
      <div className="col g12" style={{ padding: "16px 18px" }}>
        <div className="well row between">
          <div className="col g4">
            <span className="lbl">{t("v2.team.payroll.toPay")}</span>
            <span className="kpi" style={zero ? { color: "var(--ink-3)" } : undefined}>{fmtNum(d.total_earned)}</span>
          </div>
          <span className="num xs c3">{t("v2.team.payroll.of", { v: fmtNum(d.max_possible) })}</span>
        </div>

        <GateCard
          title={t("v2.team.payroll.gateAtt")}
          bonus={d.attendance_bonus_uzs}
          earned={a.block_earned}
          gatePct={d.attendance_gate_pct}
          ratePct={a.rate_pct}
          passed={a.gate_passed}
          shortfall={a.shortfall?.explanation}
          extra={
            <span className="num xs c3">
              {t("v2.team.payroll.daysLine", { a: a.days_attended, p: a.working_days_planned, n: a.days_late })}
              {a.gate_passed && Number(a.late_penalty_total) > 0 ? ` (−${fmtNum(a.late_penalty_total)})` : ""}
            </span>
          }
        />
        <GateCard
          title={t("v2.team.payroll.gateSales")}
          bonus={d.sales_bonus_uzs}
          earned={s.block_earned}
          gatePct={d.sales_gate_pct}
          ratePct={s.rate_pct}
          passed={s.gate_passed}
          shortfall={s.shortfall?.explanation}
          extra={<span className="num xs c3">{fmtNum(s.actual_uzs)} / {fmtNum(s.plan_amount_uzs)}</span>}
        />

        <PayrollRuleBlock operatorId={d.operator_id} operatorName={d.operator_name} />
      </div>
      <hr className="hr" />
      <div className="col g6" style={{ padding: "14px 18px 18px" }}>
        <span className="lbl">{t("v2.team.payroll.byDays")}</span>
        {a.days && a.days.length > 0 ? a.days.map((day) => <PayrollDayRow key={day.date} day={day} />) : <span className="s c3">{t("v2.team.payroll.noDays")}</span>}
      </div>
    </>
  );
}

function GateCard({
  title,
  bonus,
  earned,
  gatePct,
  ratePct,
  passed,
  shortfall,
  extra,
}: {
  title: string;
  bonus: string;
  earned: string;
  gatePct: number;
  ratePct: number;
  passed: boolean;
  shortfall?: string;
  extra?: ReactNode;
}) {
  const t = useT2();
  const bar = Math.max(0, Math.min(100, Number(ratePct) || 0));
  return (
    <div
      className="col g8"
      style={{
        padding: "12px 14px",
        borderRadius: 11,
        border: `1px solid ${passed ? "var(--ok-solid)" : "var(--bad-solid)"}`,
        background: passed ? "var(--ok-bg)" : "var(--bad-bg)",
      }}
    >
      <div className="row between">
        <span className="s w6">{title}</span>
        {passed ? (
          <Check className="ic c-ok" aria-label={t("v2.team.payroll.passed")} />
        ) : (
          <CircleX className="ic c-bad" aria-label={t("v2.team.payroll.failed")} />
        )}
      </div>
      <div className="row g6 wrap" style={{ alignItems: "baseline" }}>
        <span className={cx("num w7", passed ? "c-ok" : "c3")} style={{ fontSize: 18 }}>{fmtNum(earned)}</span>
        <span className="xs c3">{t("v2.team.payroll.of", { v: fmtNum(bonus) })}</span>
      </div>
      <span className="num xs c3">{pct(ratePct)} / {gatePct}%</span>
      <span className="bar" style={{ overflow: "visible" }}>
        <i className={passed ? "ok" : "bad"} style={{ width: `${bar}%` }} />
        {gatePct > 0 && gatePct < 100 ? (
          <span aria-hidden="true" style={{ position: "absolute", left: `${gatePct}%`, top: -3, bottom: -3, width: 2, borderRadius: 1, background: "var(--ink)", opacity: 0.45 }} />
        ) : null}
      </span>
      {extra}
      {!passed && shortfall ? (
        <span className="xs c-bad" style={{ padding: "6px 10px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--bad-bg)" }}>{shortfall}</span>
      ) : null}
    </div>
  );
}

const DAY_TONE: Record<PayrollDay["status"], string> = {
  on_time: "c-ok",
  late: "c-warn",
  absent: "c-bad",
  weekend: "c3",
  free_absence: "c-brand",
};

function PayrollDayRow({ day }: { day: PayrollDay }) {
  const t = useT2();
  const ded = Number(day.deduction_uzs);
  const hasTime = !!(day.checked_in_at || day.checked_out_at);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto 84px",
        gap: 10,
        alignItems: "center",
        padding: "7px 10px",
        borderRadius: 8,
        border: "1px solid var(--line)",
        background: "var(--surface-2)",
      }}
    >
      <span className="col" style={{ minWidth: 0 }}>
        <span className="s w6 trunc">
          {fmtDay(day.date, t)} <span className={cx("xs w5", DAY_TONE[day.status])}>{t(`payroll.day.${day.status}`)}</span>
        </span>
        {day.note ? <span className="xs c3 trunc" title={day.note}>{day.note}</span> : null}
      </span>
      <span className="num xs c3">
        {hasTime ? (
          <>
            {fmtHM(day.checked_in_at)}
            {day.checked_out_at ? <> → {fmtHM(day.checked_out_at)}</> : null}
          </>
        ) : (
          "—"
        )}
      </span>
      <span className={cx("num xs w6", ded > 0 ? "c-bad" : "c3")} style={{ textAlign: "right" }}>
        {ded > 0 ? `−${fmtNum(day.deduction_uzs)}` : "—"}
      </span>
    </div>
  );
}

/* ---------------- personal payroll rule ---------------- */

function PayrollRuleBlock({ operatorId, operatorName }: { operatorId: number; operatorName: string }) {
  const t = useT2();
  const q = usePayrollRule(operatorId);
  const [editing, setEditing] = useState(false);

  if (q.isLoading) {
    return (
      <div className="well">
        <LoadingBlock rows={1} />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="well">
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  }
  const data = q.data;
  const eff = data.effective;
  const isOverride = data.source === "override";
  const badge = <span className={cx("badge", isOverride && "b-info")}>{isOverride ? t("payroll_rule.badge_personal") : t("payroll_rule.badge_global")}</span>;

  return (
    <div className="well col g8">
      <div className="row between g8">
        <div className="row g6 wrap">
          <span className="s w6">{t("payroll_rule.section_title")}</span>
          {badge}
        </div>
        <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>{t("payroll_rule.edit")}</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="col g4">
          <span className="lbl">{t("payroll_rule.threshold_label")}</span>
          <span className="num w6">{eff ? fmtNum(eff.threshold) : "—"}</span>
        </div>
        <div className="col g4">
          <span className="lbl">{t("payroll_rule.payout_label")}</span>
          <span className="s w6">{eff ? formula(eff, t) : "—"}</span>
        </div>
      </div>
      {editing ? (
        <PayrollRuleDialog
          operatorId={operatorId}
          operatorName={operatorName}
          initial={eff}
          isOverride={isOverride}
          badge={badge}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

function PayrollRuleDialog({
  operatorId,
  operatorName,
  initial,
  isOverride,
  badge,
  onClose,
}: {
  operatorId: number;
  operatorName: string;
  initial: PayrollRuleDto;
  isOverride: boolean;
  badge: ReactNode;
  onClose: () => void;
}) {
  const t = useT2();
  const confirm = useConfirm();
  const save = usePayrollRuleSave(operatorId);
  const reset = usePayrollRuleReset(operatorId);
  // Pre-fill from the effective rule (override, else global) — as the old form.
  const [threshold, setThreshold] = useState<string>(initial ? String(Math.round(Number(initial.threshold))) : "50000000");
  const [payoutType, setPayoutType] = useState<PayrollPayoutType>(initial?.payout_type ?? "percent");
  const [payoutValue, setPayoutValue] = useState<string>(initial ? String(Number(initial.payout_value)) : "3");
  const [err, setErr] = useState<{ field: "threshold" | "value"; msg: string } | null>(null);
  const busy = save.isPending || reset.isPending;

  const submit = () => {
    const th = threshold.replace(/\s/g, "");
    const pv = payoutValue.replace(/\s/g, "").replace(",", ".");
    if (!th || !Number.isFinite(Number(th)) || Number(th) < 0) {
      setErr({ field: "threshold", msg: t("payroll_rule.err_threshold") });
      return;
    }
    if (payoutType !== "tiers" && (!pv || !Number.isFinite(Number(pv)) || Number(pv) < 0)) {
      setErr({ field: "value", msg: t("payroll_rule.err_payout_value") });
      return;
    }
    setErr(null);
    save.mutate(
      { threshold: th, payout_type: payoutType, payout_value: pv || "0" },
      {
        onSuccess: () => {
          toast.success(t("payroll_rule.saved"));
          onClose();
        },
        onError: () => toast.error(t("payroll_rule.save_failed")),
      },
    );
  };

  const doReset = async () => {
    const ok = await confirm({
      title: t("v2.team.payroll.resetTitle"),
      body: t("v2.team.payroll.resetBody", { name: operatorName }),
      confirm: t("payroll_rule.reset_to_global"),
    });
    if (!ok) return;
    reset.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("payroll_rule.reset_done"));
        onClose();
      },
      onError: () => toast.error(t("payroll_rule.save_failed")),
    });
  };

  const valueLabel =
    payoutType === "percent" ? t("payroll_rule.value_percent_label") : payoutType === "fixed" ? t("payroll_rule.value_fixed_label") : t("payroll_rule.value_tiers_label");

  return (
    <>
      <Dialog
        open
        onClose={busy ? () => undefined : onClose}
        width={560}
        title={
          <span className="row g8 wrap">
            {t("payroll_rule.section_title")}
            {badge}
          </span>
        }
        sub={initial ? t("v2.team.payroll.ruleNow", { threshold: fmtNum(initial.threshold), formula: formula(initial, t) }) : operatorName}
        footer={
          <>
            {isOverride ? (
              <button className="btn btn-ghost" type="button" disabled={busy} onClick={doReset}>
                {reset.isPending ? t("common.loading") : t("payroll_rule.reset_to_global")}
              </button>
            ) : null}
            <span className="grow" />
            <button className="btn" type="button" disabled={busy} onClick={onClose}>{t("payroll_rule.cancel")}</button>
            <button className="btn btn-pri" type="button" disabled={busy} onClick={submit}>
              {save.isPending ? t("common.loading") : t("payroll_rule.save")}
            </button>
          </>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          <div className="field">
            <label htmlFor="pr-th">{t("payroll_rule.threshold_label")}</label>
            <input
              id="pr-th"
              className={cx("input num", err?.field === "threshold" && "is-bad")}
              type="number"
              min={0}
              inputMode="numeric"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pr-type">{t("payroll_rule.payout_type_label")}</label>
            <select id="pr-type" className="input" value={payoutType} onChange={(e) => setPayoutType(e.target.value as PayrollPayoutType)}>
              <option value="percent">{t("payroll_rule.type_percent")}</option>
              <option value="fixed">{t("payroll_rule.type_fixed")}</option>
              <option value="tiers">{t("payroll_rule.type_tiers")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="pr-val">{valueLabel}</label>
            <input
              id="pr-val"
              className={cx("input num", err?.field === "value" && "is-bad")}
              type="number"
              min={0}
              step={payoutType === "percent" ? "0.1" : "1"}
              disabled={payoutType === "tiers"}
              style={payoutType === "tiers" ? { opacity: 0.5 } : undefined}
              value={payoutValue}
              onChange={(e) => setPayoutValue(e.target.value)}
            />
          </div>
        </div>
        {err ? <span className="err">{err.msg}</span> : null}
        {payoutType === "tiers" ? <span className="hint">{t("payroll_rule.tiers_hint")}</span> : null}
      </Dialog>
      {confirm.node}
    </>
  );
}
