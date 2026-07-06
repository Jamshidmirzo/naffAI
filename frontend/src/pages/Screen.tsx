import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { buildPeriodParams } from "../lib/period";

const REFRESH_SEC = 30;
const MEDALS: Record<number, string> = { 0: "🥇", 1: "🥈", 2: "🥉" };
const BAR_COLORS = [
  "bg-yellow-400",
  "bg-slate-300",
  "bg-orange-400",
  "bg-indigo-400",
  "bg-emerald-400",
];
const CARD_BORDER = [
  "border-yellow-500/50 shadow-[0_0_40px_rgba(251,191,36,0.2)]",
  "border-slate-400/30 shadow-[0_0_25px_rgba(148,163,184,0.1)]",
  "border-orange-600/30",
  "border-indigo-500/20",
  "border-emerald-500/20",
];
const NAME_COLOR = [
  "text-yellow-300",
  "text-slate-200",
  "text-orange-300",
  "text-white",
  "text-white",
];

function useCountdown(sec: number, onZero: () => void) {
  const [left, setLeft] = useState(sec);
  useEffect(() => {
    setLeft(sec);
    const t = setInterval(() => {
      setLeft((p) => {
        if (p <= 1) { onZero(); return sec; }
        return p - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec]);
  return left;
}

function useClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return time;
}

function Ticker({ sales }: { sales: any[] }) {
  if (!sales.length) return null;
  const items = [...sales, ...sales]; // duplicate for seamless loop
  return (
    <div className="overflow-hidden whitespace-nowrap border-t border-white/10 bg-black/30 py-2 px-4">
      <div className="inline-flex gap-12 animate-[marquee_40s_linear_infinite]">
        {items.map((s: any, i: number) => (
          <span key={i} className="text-sm text-slate-300">
            <span className="text-white font-semibold">{s.operator_name || "—"}</span>
            {" → "}
            <span className="text-indigo-300">{s.phone_model}</span>
            {" · "}
            <span className="text-emerald-400 font-semibold">{formatUZS(s.amount)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Screen() {
  const [tick, setTick] = useState(0);
  const now = useClock();
  const countdown = useCountdown(REFRESH_SEC, () => setTick((t) => t + 1));

  const params = buildPeriodParams("month", { kind: "current" });

  const lb = useQuery({
    queryKey: ["screen-lb", tick],
    queryFn: () =>
      api.get("/analytics/leaderboard/", { params: { ...params, limit: 10 } }).then((r) => r.data),
    staleTime: Infinity,
  });

  const kpi = useQuery({
    queryKey: ["screen-kpi", tick],
    queryFn: () => api.get("/analytics/kpi/", { params }).then((r) => r.data),
    staleTime: Infinity,
  });

  const recent = useQuery({
    queryKey: ["screen-recent", tick],
    queryFn: () => api.get("/sales/?limit=20").then((r) => r.data),
    staleTime: Infinity,
  });

  const top5 = (lb.data || []).slice(0, 5);

  const planQueries = useQuery({
    queryKey: ["screen-plans", tick, top5.map((o: any) => o.operator_id).join(",")],
    queryFn: async () => {
      if (!top5.length) return {};
      const results = await Promise.all(
        top5.map((o: any) =>
          api.get(`/operators/${o.operator_id}/plan/`).then((r) => r.data).catch(() => null)
        )
      );
      return Object.fromEntries(top5.map((o: any, i: number) => [o.operator_id, results[i]]));
    },
    enabled: top5.length > 0,
    staleTime: Infinity,
  });

  const recentSales: any[] = recent.data?.results || [];
  const monthLabel = now.toLocaleString("ru-RU", { month: "long", year: "numeric" });

  return (
    <div className="h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 text-white flex flex-col overflow-hidden select-none"
      style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-5 pb-3 shrink-0">
        <div className="flex items-baseline gap-4">
          <span className="text-3xl">🏆</span>
          <div>
            <div className="text-xs uppercase tracking-[0.25em] text-indigo-400">Рейтинг продаж</div>
            <h1 className="text-3xl font-black tracking-tight uppercase leading-none">
              Топ операторов&nbsp;
              <span className="text-indigo-400">{monthLabel}</span>
            </h1>
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-mono font-bold tabular-nums">
            {now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            обновление через <span className="text-indigo-300 font-bold tabular-nums">{countdown}с</span>
          </div>
        </div>
      </div>

      {/* Body: left leaderboard + right panel */}
      <div className="flex-1 flex gap-5 px-8 pb-3 min-h-0">

        {/* LEFT: Top 5 */}
        <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
          {top5.map((op: any, i: number) => {
            const plan = planQueries.data?.[op.operator_id];
            const hasPlan = plan?.target != null;
            const pct = hasPlan ? Math.min(100, plan.percent) : 0;

            return (
              <div
                key={op.operator_id}
                className={`rounded-xl border bg-white/5 backdrop-blur-sm px-5 py-3 flex items-center gap-5 ${CARD_BORDER[i]}`}
              >
                {/* Rank */}
                <div className="w-10 text-center shrink-0">
                  {i < 3
                    ? <span className="text-3xl">{MEDALS[i]}</span>
                    : <span className="text-2xl font-black text-slate-500">{i + 1}</span>
                  }
                </div>

                {/* Name + bar */}
                <div className="flex-1 min-w-0">
                  <div className={`text-2xl font-black truncate ${NAME_COLOR[i]}`}>
                    {op.operator_name}
                  </div>
                  {hasPlan ? (
                    <div className="mt-1.5">
                      <div className="flex justify-between text-xs text-slate-400 mb-1">
                        <span>{formatUZS(Number(plan.actual))} из {formatUZS(Number(plan.target))}</span>
                        <span className={`font-bold ${pct >= 100 ? "text-emerald-400" : ""}`}>{pct}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-1000 ${BAR_COLORS[i]} ${pct >= 100 ? "!bg-emerald-400" : ""}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500 mt-1">{op.count} продаж</div>
                  )}
                </div>

                {/* Amount */}
                <div className="text-right shrink-0">
                  <div className={`text-2xl font-black tabular-nums ${NAME_COLOR[i]}`}>
                    {formatUZS(Number(op.total))}
                  </div>
                  {hasPlan && (
                    <div className="text-xs text-slate-400">{op.count} продаж</div>
                  )}
                  {pct >= 100 && (
                    <div className="text-xs text-emerald-400 font-semibold">✓ план выполнен</div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Rest of leaderboard (6–10) compact */}
          {(lb.data || []).length > 5 && (
            <div className="rounded-xl border border-white/5 bg-white/3 px-5 py-2">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">Остальные</div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                {(lb.data || []).slice(5, 10).map((op: any, i: number) => (
                  <div key={op.operator_id} className="flex items-center justify-between text-sm">
                    <span className="text-slate-400 tabular-nums w-5">{i + 6}.</span>
                    <span className="flex-1 truncate text-slate-300 ml-1">{op.operator_name}</span>
                    <span className="text-white font-semibold ml-2 tabular-nums">{formatUZS(Number(op.total))}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: KPI + recent sales */}
        <div className="w-80 shrink-0 flex flex-col gap-3 min-h-0">

          {/* Team total */}
          <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 shrink-0">
            <div className="text-xs uppercase tracking-widest text-indigo-400 mb-1">Команда · {monthLabel}</div>
            <div className="text-3xl font-black text-white tabular-nums">
              {formatUZS(kpi.data?.month?.total || 0)}
            </div>
            <div className="text-sm text-indigo-300 mt-0.5">
              {kpi.data?.month?.count || 0} продаж · {kpi.data?.operators_active || 0} операторов
            </div>
          </div>

          {/* Recent sales feed */}
          <div className="flex-1 rounded-xl border border-white/10 bg-white/3 flex flex-col min-h-0 overflow-hidden">
            <div className="px-4 pt-3 pb-2 text-xs uppercase tracking-widest text-slate-500 shrink-0 border-b border-white/5">
              Последние продажи
            </div>
            <div className="flex-1 overflow-y-auto space-y-0">
              {recentSales.slice(0, 12).map((s: any, i: number) => (
                <div key={s.id}
                  className={`px-4 py-2.5 flex flex-col gap-0.5 ${i % 2 === 0 ? "bg-white/2" : ""} border-b border-white/5 last:border-0`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white truncate">{s.operator_name || "—"}</span>
                    <span className="text-sm font-bold text-emerald-400 tabular-nums shrink-0 ml-2">{formatUZS(s.amount)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-indigo-300 truncate">{s.phone_model}</span>
                    <span className="text-xs text-slate-500 tabular-nums shrink-0 ml-2">
                      {new Date(s.sold_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* Ticker */}
      <Ticker sales={recentSales.slice(0, 15)} />
    </div>
  );
}
