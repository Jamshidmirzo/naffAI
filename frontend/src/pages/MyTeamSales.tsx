import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatUZS, formatNumber } from "../lib/format";
import { usePageHeader } from "../store/page";
import { useAuth } from "../store/auth";
import { useT } from "../lib/i18n";

/**
 * Super-manager team sales overview — три таба:
 *   1) «Всё итого»    — агрегат всей своей ветки (бэкенд scope-ed KPI).
 *   2) «Прямые»       — только собственные direct-операторы (managed_by=me).
 *   3) «По менеджерам» — breakdown per-manager + его operators.
 *
 * Все цифры приходят scope-ed с backend — super_manager видит только
 * свою ветку через visible_operator_ids(). Фильтрация per-manager
 * делается на фронте через operators list + grouping.
 */

type Period = "day" | "week" | "month";

interface LeaderRow {
  operator_id: number;
  operator_name: string;
  is_trainee: boolean;
  total: number | string;
  count: number | string;
  avg_ticket: number | string;
}

interface OperatorRow {
  id: number;
  full_name: string;
  status: string;
  managed_by_id: number | null;
}

interface UserRow {
  id: number;
  username: string;
  role: string;
  reports_to_id: number | null;
}

interface KpiBlock {
  total: string;
  count: number;
}

interface Kpi {
  today: KpiBlock;
  week: KpiBlock;
  month: KpiBlock;
  operators_active: number;
  operators_trainee: number;
}

function num(v: number | string | undefined | null): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" ? v : parseFloat(String(v)) || 0;
}

export default function MyTeamSales() {
  const t = useT();
  const meUsername = useAuth((s) => s.username);

  usePageHeader(
    { title: t("super_manager.team_sales_title") },
    [t("super_manager.team_sales_title")]
  );

  const [tab, setTab] = useState<"total" | "direct" | "by_manager">("total");
  const [period, setPeriod] = useState<Period>("month");

  const kpiQ = useQuery<Kpi>({
    queryKey: ["my-team-kpi", period],
    queryFn: () =>
      api.get<Kpi>("/analytics/kpi/", { params: { period } }).then((r) => r.data),
  });

  const leaderboardQ = useQuery<LeaderRow[]>({
    queryKey: ["my-team-leaderboard", period],
    queryFn: () =>
      api
        .get<LeaderRow[]>("/analytics/leaderboard/", { params: { period } })
        .then((r) => r.data),
  });

  const operatorsQ = useQuery<OperatorRow[]>({
    queryKey: ["my-team-operators"],
    queryFn: () =>
      api.get<OperatorRow[]>("/operators/").then((r) => r.data),
  });

  const usersQ = useQuery<UserRow[]>({
    queryKey: ["users"],
    queryFn: () => api.get<UserRow[]>("/users/").then((r) => r.data),
  });

  const myUserId = useMemo(() => {
    const me = (usersQ.data ?? []).find((u) => u.username === meUsername);
    return me?.id ?? null;
  }, [usersQ.data, meUsername]);

  const myManagers = useMemo(
    () =>
      (usersQ.data ?? []).filter(
        (u) =>
          (u.role === "manager" || u.role === "team_lead") &&
          u.reports_to_id === myUserId
      ),
    [usersQ.data, myUserId]
  );

  const directOperatorIds = useMemo(
    () =>
      new Set(
        (operatorsQ.data ?? [])
          .filter((o) => o.managed_by_id === myUserId)
          .map((o) => o.id)
      ),
    [operatorsQ.data, myUserId]
  );

  const operatorsByManager = useMemo(() => {
    const map = new Map<number, OperatorRow[]>();
    for (const op of operatorsQ.data ?? []) {
      if (op.managed_by_id && op.managed_by_id !== myUserId) {
        const arr = map.get(op.managed_by_id) ?? [];
        arr.push(op);
        map.set(op.managed_by_id, arr);
      }
    }
    return map;
  }, [operatorsQ.data, myUserId]);

  const leaderboardByOp = useMemo(() => {
    const map = new Map<number, LeaderRow>();
    for (const row of leaderboardQ.data ?? []) {
      map.set(row.operator_id, row);
    }
    return map;
  }, [leaderboardQ.data]);

  // ---- Aggregations ----
  const directStats = useMemo(() => {
    let total = 0;
    let count = 0;
    for (const row of leaderboardQ.data ?? []) {
      if (directOperatorIds.has(row.operator_id)) {
        total += num(row.total);
        count += num(row.count);
      }
    }
    return { total, count };
  }, [leaderboardQ.data, directOperatorIds]);

  const perManagerStats = useMemo(() => {
    return myManagers.map((mgr) => {
      const ops = operatorsByManager.get(mgr.id) ?? [];
      let total = 0;
      let count = 0;
      for (const op of ops) {
        const row = leaderboardByOp.get(op.id);
        if (row) {
          total += num(row.total);
          count += num(row.count);
        }
      }
      return {
        manager: mgr,
        operators: ops,
        total,
        count,
      };
    });
  }, [myManagers, operatorsByManager, leaderboardByOp]);

  const PERIODS: { value: Period; label: string }[] = [
    { value: "day", label: t("common.today") },
    { value: "week", label: t("common.week") },
    { value: "month", label: t("common.month") },
  ];

  // KPI backend keys: day → today, week → week, month → month.
  const periodBlock: KpiBlock | undefined =
    period === "day"
      ? kpiQ.data?.today
      : period === "week"
      ? kpiQ.data?.week
      : kpiQ.data?.month;

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Period selector */}
      <section className="flex items-center justify-between animate-nfFadeUp">
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              className={`nf-btn ${period === p.value ? "" : "nf-btn--ghost"}`}
              style={{ padding: "6px 12px", fontSize: 13 }}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {/* Tabs */}
      <section className="flex gap-2 animate-nfFadeUp">
        <TabButton active={tab === "total"} onClick={() => setTab("total")}>
          {t("super_manager.tab_total")}
        </TabButton>
        <TabButton active={tab === "direct"} onClick={() => setTab("direct")}>
          {t("super_manager.tab_direct")}
        </TabButton>
        <TabButton
          active={tab === "by_manager"}
          onClick={() => setTab("by_manager")}
        >
          {t("super_manager.tab_by_manager")}
        </TabButton>
      </section>

      {/* Content */}
      {tab === "total" && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3 animate-nfFadeUp">
          <KpiCard
            label={t("super_manager.kpi_period_total")}
            value={formatUZS(num(periodBlock?.total ?? 0))}
            sub={`${formatNumber(num(periodBlock?.count ?? 0))} ${t("nav.sales").toLowerCase()}`}
          />
          <KpiCard
            label={t("super_manager.kpi_ops_active")}
            value={formatNumber(kpiQ.data?.operators_active ?? 0)}
            sub={`${kpiQ.data?.operators_trainee ?? 0} ${t("super_manager.kpi_trainees")}`}
          />
          <KpiCard
            label={t("super_manager.kpi_my_managers")}
            value={formatNumber(myManagers.length)}
            sub={`${(operatorsQ.data ?? []).length} ${t("super_manager.kpi_ops_total")}`}
          />
        </section>
      )}

      {tab === "direct" && (
        <section className="nf-card overflow-hidden animate-nfFadeUp">
          <div className="px-6 py-4 flex items-center justify-between border-b nf-divider">
            <div>
              <div className="text-[14px] font-semibold">
                {t("super_manager.direct_section_title")}
              </div>
              <div className="text-[12px] text-muted mt-0.5">
                {t("super_manager.direct_section_hint")}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[18px] font-semibold tabular-nums">
                {formatUZS(directStats.total)}
              </div>
              <div className="text-[12px] text-muted">
                {formatNumber(directStats.count)} {t("nav.sales").toLowerCase()}
              </div>
            </div>
          </div>
          {directOperatorIds.size === 0 ? (
            <div className="text-center text-muted py-12 text-[13px]">
              {t("super_manager.no_direct_ops")}
            </div>
          ) : (
            <OpList
              operators={(operatorsQ.data ?? []).filter((o) => directOperatorIds.has(o.id))}
              leaderboardByOp={leaderboardByOp}
            />
          )}
        </section>
      )}

      {tab === "by_manager" && (
        <section className="flex flex-col gap-4 animate-nfFadeUp">
          {perManagerStats.length === 0 ? (
            <div className="nf-card text-center text-muted py-12 text-[13px]">
              {t("super_manager.no_managers")}
            </div>
          ) : (
            perManagerStats.map((m) => (
              <div key={m.manager.id} className="nf-card overflow-hidden">
                <div className="px-6 py-4 flex items-center justify-between border-b nf-divider">
                  <div>
                    <div className="text-[14px] font-semibold">
                      {m.manager.username}
                    </div>
                    <div className="text-[12px] text-muted mt-0.5">
                      {t("super_manager.manager_ops_count", {
                        n: String(m.operators.length),
                      })}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[18px] font-semibold tabular-nums">
                      {formatUZS(m.total)}
                    </div>
                    <div className="text-[12px] text-muted">
                      {formatNumber(m.count)} {t("nav.sales").toLowerCase()}
                    </div>
                  </div>
                </div>
                {m.operators.length > 0 && (
                  <OpList
                    operators={m.operators}
                    leaderboardByOp={leaderboardByOp}
                  />
                )}
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`nf-btn ${active ? "" : "nf-btn--ghost"}`}
      style={{ padding: "8px 14px", fontSize: 13 }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="nf-card p-5">
      <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
        {label}
      </div>
      <div className="mt-2 text-[22px] font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="text-[12px] text-muted mt-1">{sub}</div>
    </div>
  );
}

function OpList({
  operators,
  leaderboardByOp,
}: {
  operators: OperatorRow[];
  leaderboardByOp: Map<number, LeaderRow>;
}) {
  const t = useT();
  const rows = operators.map((op) => {
    const row = leaderboardByOp.get(op.id);
    return {
      op,
      total: num(row?.total ?? 0),
      count: num(row?.count ?? 0),
    };
  });
  rows.sort((a, b) => b.total - a.total);

  return (
    <div>
      <div
        className="grid gap-2 px-6 pt-4 pb-3 nf-col"
        style={{ gridTemplateColumns: "2fr 1fr 1fr" }}
      >
        <div>{t("super_manager.col_operator")}</div>
        <div className="text-right">{t("super_manager.col_total")}</div>
        <div className="text-right">{t("super_manager.col_count")}</div>
      </div>
      {rows.map((r) => (
        <div
          key={r.op.id}
          className="nf-row"
          style={{
            gridTemplateColumns: "2fr 1fr 1fr",
            cursor: "default",
          }}
        >
          <div className="flex items-center gap-2.5">
            <div className="font-medium">{r.op.full_name}</div>
            {r.op.status === "trainee" && (
              <span className="text-[10.5px] text-muted">{t("op_edit.status_trainee")}</span>
            )}
          </div>
          <div className="text-right tabular-nums">{formatUZS(r.total)}</div>
          <div className="text-right tabular-nums text-muted">{formatNumber(r.count)}</div>
        </div>
      ))}
    </div>
  );
}
