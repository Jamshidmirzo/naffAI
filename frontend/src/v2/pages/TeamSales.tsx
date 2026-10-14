import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { useAuth } from "../../store/auth";
import { useT2 } from "../i18n";
import { CountUp, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtMln, fmtNum } from "../ui";
import {
  barCls,
  initials,
  isManagerRole,
  planOf,
  pluralKey,
  toNum,
  useBranchUsers,
  useTeamKpi,
  useTeamLeaderboard,
  useTeamOperators,
  userDisplayName,
  type BranchOperator,
  type LeaderRow,
  type Period,
} from "../api/branch";

/**
 * /team/sales — «Моя команда — продажи» (super_manager / superadmin).
 * Tabs «Всё итого / Прямые / По менеджерам», period day/week/month.
 * Totals come from /analytics/kpi (scoped server-side); per-team and
 * per-operator numbers are the leaderboard grouped by operators.managed_by_id.
 */

type Tab = "total" | "direct" | "by_manager";
type GroupKey = number | "none";
type SortKey = "name" | "count" | "avg" | "sum" | "plan";

interface OpRow {
  op: BranchOperator;
  count: number;
  sum: number;
  avg: number;
  plan: number | null;
}

interface Group {
  key: GroupKey;
  name: string;
  ini: string;
  rows: OpRow[];
  count: number;
  sum: number;
  plan: number | null;
}

function buildRows(ops: BranchOperator[], lb: Map<number, LeaderRow>): OpRow[] {
  return ops.map((op) => {
    const r = lb.get(op.id);
    const p = planOf([op]);
    return { op, count: toNum(r?.count), sum: toNum(r?.total), avg: toNum(r?.avg_ticket), plan: p ? p.pct : null };
  });
}

function totals(rows: OpRow[]) {
  let count = 0;
  let sum = 0;
  for (const r of rows) {
    count += r.count;
    sum += r.sum;
  }
  return { count, sum, plan: planOf(rows.map((r) => r.op))?.pct ?? null };
}

function PlanCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="xs c3">—</span>;
  return (
    <span className="row g8">
      <span className="bar grow">
        <i className={barCls(pct)} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="num xs w6" style={{ width: 40, textAlign: "right" }}>{pct}%</span>
    </span>
  );
}

const GRID = "28px minmax(180px, 1.6fr) 90px 110px 160px minmax(140px, 1.2fr)";

export default function TeamSales() {
  const t = useT2();
  const meUsername = useAuth((s) => s.username);
  const [sp, setSp] = useSearchParams();
  const initialMgr = sp.get("manager");

  const [tab, setTab] = useState<Tab>(initialMgr ? "by_manager" : "total");
  const [period, setPeriod] = useState<Period>("month");
  const [mgr, setMgr] = useState<string>(initialMgr ?? "all");
  const [open, setOpen] = useState<Set<GroupKey> | null>(initialMgr ? new Set([initialMgr === "none" ? "none" : Number(initialMgr)]) : null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "count", desc: true });

  const kpiQ = useTeamKpi(period);
  const lbQ = useTeamLeaderboard(period);
  const opsQ = useTeamOperators();
  const usersQ = useBranchUsers();

  const users = usersQ.data ?? [];
  const ops = opsQ.data ?? [];
  const meId = useMemo(() => users.find((u) => u.username === meUsername)?.id ?? null, [users, meUsername]);
  const managers = useMemo(() => users.filter((u) => u.username !== meUsername && isManagerRole(u.role)), [users, meUsername]);
  const lbByOp = useMemo(() => new Map((lbQ.data ?? []).map((r) => [r.operator_id, r])), [lbQ.data]);

  const directRows = useMemo(
    () => buildRows(ops.filter((o) => meId != null && o.managed_by_id === meId), lbByOp),
    [ops, meId, lbByOp],
  );

  const groups: Group[] = useMemo(() => {
    const by = new Map<GroupKey, BranchOperator[]>();
    for (const o of ops) {
      if (meId != null && o.managed_by_id === meId) continue;
      const k: GroupKey = o.managed_by_id ?? "none";
      const arr = by.get(k) ?? [];
      arr.push(o);
      by.set(k, arr);
    }
    const userById = new Map(users.map((u) => [u.id, u]));
    const mk = (key: GroupKey, name: string, arr: BranchOperator[]): Group => {
      const rows = buildRows(arr, lbByOp);
      const tt = totals(rows);
      return { key, name, ini: key === "none" ? "—" : initials(name), rows, ...tt };
    };
    const out: Group[] = managers.map((m) => mk(m.id, userDisplayName(m), by.get(m.id) ?? []));
    const known = new Set<GroupKey>(managers.map((m) => m.id));
    for (const [k, arr] of by) {
      if (k === "none" || known.has(k)) continue;
      const u = userById.get(k);
      out.push(mk(k, u ? userDisplayName(u) : `#${k}`, arr));
    }
    if (by.get("none")?.length) out.push(mk("none", t("v2.branch.none"), by.get("none") ?? []));
    return out;
  }, [ops, meId, managers, users, lbByOp, t]);

  const shownGroups = mgr === "all" ? groups : groups.filter((g) => String(g.key) === mgr);
  const selGroup = mgr === "all" ? null : shownGroups[0] ?? null;
  const directTotals = totals(directRows);

  const setManagerFilter = (v: string) => {
    setMgr(v);
    const next = new URLSearchParams(sp);
    if (v === "all") next.delete("manager");
    else next.set("manager", v);
    setSp(next, { replace: true });
    if (v !== "all") setOpen(new Set([v === "none" ? "none" : Number(v)]));
  };

  const isOpen = (k: GroupKey, idx: number) => (open ? open.has(k) : idx === 0);
  const toggle = (k: GroupKey, idx: number) =>
    setOpen((prev) => {
      const base = prev ?? new Set<GroupKey>(groups.length ? [groups[0].key] : []);
      const n = new Set(base);
      if (isOpen(k, idx)) n.delete(k);
      else n.add(k);
      return n;
    });

  const sortRows = (rows: OpRow[]) => {
    const dir = sort.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      let d = 0;
      if (sort.key === "name") d = a.op.full_name.localeCompare(b.op.full_name);
      else if (sort.key === "count") d = a.count - b.count;
      else if (sort.key === "avg") d = a.avg - b.avg;
      else if (sort.key === "sum") d = a.sum - b.sum;
      else d = (a.plan ?? -1) - (b.plan ?? -1);
      return d * dir || b.sum - a.sum;
    });
  };

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));
  const sortBtn = (k: SortKey, label: string, right?: boolean) => (
    <button key={k} className={cx("th-s", sort.key === k && "is-on", right && "r")} type="button" onClick={() => onSort(k)} aria-sort={sort.key === k ? (sort.desc ? "descending" : "ascending") : undefined}>
      {label}
      {sort.key === k ? (sort.desc ? <ArrowDown className="ic ic-s" /> : <ArrowUp className="ic ic-s" />) : null}
    </button>
  );

  const salesWord = (n: number) => t(pluralKey("v2.branch.sales", n), { n: fmtNum(n) });
  const opsWord = (n: number) => t(pluralKey("v2.branch.ops", n), { n });

  /* ---------------- header ---------------- */

  const PERIODS: { value: Period; label: string }[] = [
    { value: "day", label: t("common.today") },
    { value: "week", label: t("common.week") },
    { value: "month", label: t("common.month") },
  ];

  const header = (
    <PageHeader title={t("super_manager.team_sales_title")}>
      <select className="input" aria-label={t("v2.tsales.branchAria")} style={{ width: 230, maxWidth: "100%" }} value={mgr} onChange={(e) => setManagerFilter(e.target.value)}>
        <option value="all">{t("v2.tsales.branchAll")}</option>
        {groups.map((g) => (
          <option key={String(g.key)} value={String(g.key)}>{g.name}</option>
        ))}
      </select>
      <div className="seg" role="tablist">
        {PERIODS.map((p) => (
          <button key={p.value} className={cx(period === p.value && "is-on")} type="button" role="tab" aria-selected={period === p.value} onClick={() => setPeriod(p.value)}>
            {p.label}
          </button>
        ))}
      </div>
    </PageHeader>
  );

  const loading = kpiQ.isLoading || lbQ.isLoading || opsQ.isLoading || usersQ.isLoading;
  const failed = kpiQ.isError || lbQ.isError || opsQ.isError || usersQ.isError;
  const retry = () => {
    kpiQ.refetch();
    lbQ.refetch();
    opsQ.refetch();
    usersQ.refetch();
  };

  const tabs = (
    <div className="tabs" role="tablist">
      {(["total", "direct", "by_manager"] as Tab[]).map((k) => (
        <button key={k} className={cx("tab", tab === k && "is-on")} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
          {t(k === "total" ? "super_manager.tab_total" : k === "direct" ? "super_manager.tab_direct" : "super_manager.tab_by_manager")}
        </button>
      ))}
    </div>
  );

  if (loading || failed) {
    return (
      <>
        {header}
        <main className="page">
          {tabs}
          <section className="card">
            {failed ? <ErrorState error={kpiQ.error ?? lbQ.error ?? opsQ.error ?? usersQ.error} onRetry={retry} /> : <LoadingBlock rows={6} onRetry={retry} />}
          </section>
        </main>
      </>
    );
  }

  /* ---------------- KPIs ---------------- */

  const kpi = kpiQ.data;
  const block = period === "day" ? kpi?.today : period === "week" ? kpi?.week : kpi?.month;
  const scopeOps = selGroup ? selGroup.rows.map((r) => r.op) : ops;
  const kTotal = selGroup ? selGroup.sum : toNum(block?.total);
  const kCount = selGroup ? selGroup.count : toNum(block?.count);
  const kActive = selGroup ? scopeOps.filter((o) => o.status === "active").length : kpi?.operators_active ?? 0;
  const kTrainee = selGroup ? scopeOps.filter((o) => o.status === "trainee").length : kpi?.operators_trainee ?? 0;
  const kPlan = planOf(scopeOps);
  const avg = kCount > 0 ? kTotal / kCount : null;

  const kpiCards = (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
      <section className="card pad col g4">
        <span className="lbl">{t("super_manager.kpi_period_total")}</span>
        <span className="kpi num"><CountUp value={kTotal} /></span>
        <span className="s c3">{salesWord(kCount)}</span>
      </section>
      <section className="card pad col g4">
        <span className="lbl">{t("super_manager.kpi_ops_active")}</span>
        <span className="kpi num"><CountUp value={kActive} /></span>
        <span className="s c3">{t(pluralKey("v2.branch.trainees", kTrainee), { n: kTrainee })}</span>
      </section>
      <section className="card pad col g4">
        <span className="lbl">{t("super_manager.kpi_my_managers")}</span>
        <span className="kpi num"><CountUp value={managers.length} /></span>
        <span className="s c3">{t("v2.tsales.opsTotal", { ops: opsWord(ops.length) })}</span>
      </section>
      <section className="card pad col g4">
        <span className="lbl">{t("v2.tsales.avgTicket")}</span>
        <span className="kpi">{avg == null ? "—" : fmtMln(avg)}</span>
        <span className="s c3">{kPlan ? t("v2.tsales.planMonth", { p: kPlan.pct }) : t("v2.tsales.noPlan")}</span>
      </section>
    </div>
  );

  /* ---------------- tables ---------------- */

  const opRowsBlock = (rows: OpRow[]) => (
    <>
      <div className="tr th" style={{ gridTemplateColumns: GRID }}>
        <span />
        {sortBtn("name", t("v2.tsales.colOperator"))}
        {sortBtn("count", t("v2.tsales.colSales"), true)}
        {sortBtn("avg", t("v2.tsales.colAvg"), true)}
        {sortBtn("sum", t("v2.tsales.colSum"), true)}
        {sortBtn("plan", t("v2.tsales.colPlan"))}
      </div>
      {sortRows(rows).map((r) => {
        const dim = r.count === 0 ? "c3" : "";
        return (
          <div key={r.op.id} className="tr" style={{ gridTemplateColumns: GRID }}>
            <span />
            <span className="row g8" style={{ minWidth: 0 }}>
              <span className="ava ava-s">{initials(r.op.full_name)}</span>
              <span className={cx("trunc", dim)}>{r.op.full_name}</span>
              {r.op.status === "trainee" ? <span className="badge" style={{ height: 18, fontSize: 11 }}>{t("v2.branch.trainee")}</span> : null}
              {r.op.status === "inactive" ? <span className="badge" style={{ height: 18, fontSize: 11 }}>{t("v2.branch.inactive")}</span> : null}
            </span>
            <span className={cx("r num w6", dim)}>{fmtNum(r.count)}</span>
            <span className="r num c2">{r.count > 0 ? fmtMln(r.avg) : "—"}</span>
            <span className={cx("r num", dim)}>{r.count > 0 ? fmtNum(r.sum) : "—"}</span>
            <PlanCell pct={r.plan} />
          </div>
        );
      })}
    </>
  );

  const groupHead = (g: { key: GroupKey | "direct"; name: string; ini: string; ops: number; count: number; sum: number; plan: number | null }, opts: { open?: boolean; onClick?: () => void }) => (
    <div
      className="tr"
      role={opts.onClick ? "button" : undefined}
      tabIndex={opts.onClick ? 0 : undefined}
      aria-expanded={opts.onClick ? !!opts.open : undefined}
      aria-label={opts.onClick ? t(opts.open ? "v2.tsales.collapse" : "v2.tsales.expand", { name: g.name }) : undefined}
      onClick={opts.onClick}
      onKeyDown={(e) => {
        if (opts.onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          opts.onClick();
        }
      }}
      style={{ gridTemplateColumns: GRID, minHeight: 60, background: "var(--surface-2)", cursor: opts.onClick ? "pointer" : undefined }}
    >
      {opts.onClick ? (opts.open ? <ChevronDown className="ic" /> : <ChevronRight className="ic" />) : <span />}
      <span className="row g8" style={{ minWidth: 0 }}>
        <span className="ava">{g.ini}</span>
        <span className="col" style={{ minWidth: 0 }}>
          <span className="h3 trunc">{g.name}</span>
          <span className="xs c3">{opsWord(g.ops)}</span>
        </span>
      </span>
      <span className="r num w6">{fmtNum(g.count)}</span>
      <span className="r num c2">{g.count > 0 ? fmtMln(g.sum / g.count) : "—"}</span>
      <span className="r num w6">{fmtNum(g.sum)}</span>
      <PlanCell pct={g.plan} />
    </div>
  );

  const wrap = (node: ReactNode, key?: string) => (
    <section key={key} className="card tbl" style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 760 }}>{node}</div>
    </section>
  );

  let content: ReactNode;
  if (tab === "total") {
    const rowsAll = [
      ...(meId != null && !selGroup ? [{ key: "direct" as const, name: t("super_manager.direct_section_title"), ini: initials(userDisplayName(users.find((u) => u.id === meId)!)), ops: directRows.length, ...directTotals }] : []),
      ...shownGroups.map((g) => ({ key: g.key, name: g.name, ini: g.ini, ops: g.rows.length, count: g.count, sum: g.sum, plan: g.plan })),
    ];
    content = (
      <section className="col g8">
        <div className="col g4">
          <span className="h3">{t("v2.tsales.teams")}</span>
          <span className="xs c3">{t("v2.tsales.teamsHint")}</span>
        </div>
        {rowsAll.length === 0 ? (
          <section className="card">
            <EmptyState title={t("super_manager.no_managers")} body={t("v2.tsales.noManagersBody")} action={<Link className="btn btn-pri btn-sm" to="/team/managers">{t("v2.tsales.toBoard")}</Link>} />
          </section>
        ) : (
          wrap(
            <>
              <div className="tr th" style={{ gridTemplateColumns: GRID }}>
                <span />
                <span>{t("v2.tsales.colTeam")}</span>
                <span className="r">{t("v2.tsales.colSales")}</span>
                <span className="r">{t("v2.tsales.colAvg")}</span>
                <span className="r">{t("v2.tsales.colSum")}</span>
                <span>{t("v2.tsales.colPlan")}</span>
              </div>
              {rowsAll.map((g) => (
                <div
                  key={String(g.key)}
                  className="tr"
                  role="button"
                  tabIndex={0}
                  style={{ gridTemplateColumns: GRID, cursor: "pointer" }}
                  onClick={() => {
                    if (g.key === "direct") setTab("direct");
                    else {
                      setOpen(new Set([g.key]));
                      setTab("by_manager");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.currentTarget as HTMLElement).click();
                  }}
                >
                  <ChevronRight className="ic c3" />
                  <span className="row g8" style={{ minWidth: 0 }}>
                    <span className="ava ava-s">{g.ini}</span>
                    <span className="col" style={{ minWidth: 0 }}>
                      <span className="s w6 trunc">{g.name}</span>
                      <span className="xs c3">{opsWord(g.ops)}</span>
                    </span>
                  </span>
                  <span className="r num w6">{fmtNum(g.count)}</span>
                  <span className="r num c2">{g.count > 0 ? fmtMln(g.sum / g.count) : "—"}</span>
                  <span className="r num">{fmtNum(g.sum)}</span>
                  <PlanCell pct={g.plan} />
                </div>
              ))}
            </>,
          )
        )}
      </section>
    );
  } else if (tab === "direct") {
    const rows = [...directRows].sort((a, b) => b.sum - a.sum);
    content = (
      <section className="card tbl" style={{ overflowX: "auto" }}>
        <div className="card-h">
          <div className="col">
            <span className="h3">{t("super_manager.direct_section_title")}</span>
            <span className="xs c3">{t("super_manager.direct_section_hint")}</span>
          </div>
          <div className="col" style={{ textAlign: "right" }}>
            <span className="num w6">{fmtNum(directTotals.sum)}</span>
            <span className="xs c3">{salesWord(directTotals.count)}</span>
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={t("v2.tsales.noDirectTitle")} body={t("v2.tsales.noDirectBody")} action={<Link className="btn btn-pri btn-sm" to="/team/managers">{t("v2.tsales.toBoard")}</Link>} />
        ) : (
          <div style={{ minWidth: 520 }}>
            <div className="tr th" style={{ gridTemplateColumns: "minmax(180px, 1fr) 180px 120px" }}>
              <span>{t("super_manager.col_operator")}</span>
              <span className="r">{t("super_manager.col_total")}</span>
              <span className="r">{t("super_manager.col_count")}</span>
            </div>
            {rows.map((r) => {
              const dim = r.count === 0 ? "c3" : "";
              return (
                <div key={r.op.id} className="tr" style={{ gridTemplateColumns: "minmax(180px, 1fr) 180px 120px" }}>
                  <span className="row g8" style={{ minWidth: 0 }}>
                    <span className="ava ava-s">{initials(r.op.full_name)}</span>
                    <span className={cx("trunc", dim)}>{r.op.full_name}</span>
                    {r.op.status === "trainee" ? <span className="badge" style={{ height: 18, fontSize: 11 }}>{t("v2.branch.trainee")}</span> : null}
                    {r.op.status === "inactive" ? <span className="badge" style={{ height: 18, fontSize: 11 }}>{t("v2.branch.inactive")}</span> : null}
                  </span>
                  <span className={cx("r num w6", dim)}>{fmtNum(r.sum)}</span>
                  <span className={cx("r num", dim)}>{fmtNum(r.count)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  } else {
    content =
      shownGroups.length === 0 ? (
        <section className="card">
          <EmptyState title={t("super_manager.no_managers")} body={t("v2.tsales.noManagersBody")} action={<Link className="btn btn-pri btn-sm" to="/team/managers">{t("v2.tsales.toBoard")}</Link>} />
        </section>
      ) : (
        <div className="col g16">
          {shownGroups.map((g, idx) => {
            const o = isOpen(g.key, idx);
            return wrap(
              <>
                {groupHead({ key: g.key, name: g.name, ini: g.ini, ops: g.rows.length, count: g.count, sum: g.sum, plan: g.plan }, { open: o, onClick: () => toggle(g.key, idx) })}
                {o ? (g.rows.length ? opRowsBlock(g.rows) : <div className="s c3" style={{ padding: "16px 20px" }}>{t("v2.tsales.noOps")}</div>) : null}
              </>,
              String(g.key),
            );
          })}
        </div>
      );
  }

  return (
    <>
      {header}
      <main className="page">
        {tabs}
        {kpiCards}
        {content}
      </main>
    </>
  );
}
