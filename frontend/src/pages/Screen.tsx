import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { buildPeriodParams } from "../lib/period";

const REFRESH_SEC = 30;

const MEDALS = ["🥇", "🥈", "🥉"];
const RANK_LABEL = ["1-е место", "2-е место", "3-е место"];
const CARD_SCALE = ["scale-100", "scale-95", "scale-90"];
const GLOW = [
  "shadow-[0_0_60px_rgba(251,191,36,0.25)] border-yellow-500/40",
  "shadow-[0_0_40px_rgba(148,163,184,0.2)] border-slate-400/30",
  "shadow-[0_0_30px_rgba(180,120,60,0.2)] border-orange-700/30",
];
const BAR_COLOR = ["bg-yellow-400", "bg-slate-300", "bg-orange-400"];

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

export default function Screen() {
  const [tick, setTick] = useState(0);
  const now = useClock();
  const countdown = useCountdown(REFRESH_SEC, () => setTick((t) => t + 1));

  const params = buildPeriodParams("month", { kind: "current" });

  const lb = useQuery({
    queryKey: ["screen-lb", tick],
    queryFn: () =>
      api.get("/analytics/leaderboard/", { params: { ...params, limit: 3 } }).then((r) => r.data),
    staleTime: Infinity,
  });

  const top3: any[] = (lb.data || []).slice(0, 3);

  const planQueries = useQuery({
    queryKey: ["screen-plans", tick, top3.map((o) => o.operator_id).join(",")],
    queryFn: async () => {
      if (!top3.length) return {};
      const results = await Promise.all(
        top3.map((o) =>
          api.get(`/operators/${o.operator_id}/plan/`).then((r) => r.data).catch(() => null)
        )
      );
      return Object.fromEntries(top3.map((o, i) => [o.operator_id, results[i]]));
    },
    enabled: top3.length > 0,
    staleTime: Infinity,
  });

  const monthLabel = now.toLocaleString("ru-RU", { month: "long", year: "numeric" });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 text-white flex flex-col select-none overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-10 pt-8 pb-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-indigo-400 font-medium">Рейтинг продаж</div>
          <h1 className="text-4xl font-black tracking-tight mt-1 uppercase">
            Топ операторов &nbsp;·&nbsp;
            <span className="text-indigo-400">{monthLabel}</span>
          </h1>
        </div>
        <div className="text-right">
          <div className="text-3xl font-mono font-bold tabular-nums text-white/90">
            {now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            обновление через{" "}
            <span className="text-indigo-300 font-semibold tabular-nums">{countdown}с</span>
          </div>
        </div>
      </div>

      {/* Cards */}
      <div className="flex-1 flex flex-col justify-center gap-5 px-10 pb-10">
        {top3.length === 0 && (
          <div className="text-center text-slate-500 text-2xl">Загрузка…</div>
        )}

        {top3.map((op, i) => {
          const plan = planQueries.data?.[op.operator_id];
          const hasPlan = plan?.target != null;
          const pct = hasPlan ? Math.min(100, plan.percent) : 0;

          return (
            <div
              key={op.operator_id}
              className={`
                relative rounded-2xl border bg-white/5 backdrop-blur-sm p-7
                transition-all duration-500
                ${GLOW[i]} ${CARD_SCALE[i]}
              `}
            >
              {/* Rank badge */}
              <div className="absolute -top-4 -left-2 text-5xl">{MEDALS[i]}</div>

              <div className="flex items-center justify-between gap-6 pl-10">
                {/* Left: name + stats */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-4">
                    <span className="text-4xl font-black tracking-tight truncate">
                      {op.operator_name}
                    </span>
                    <span className={`text-sm font-semibold uppercase tracking-widest ${
                      i === 0 ? "text-yellow-400" : i === 1 ? "text-slate-300" : "text-orange-400"
                    }`}>
                      {RANK_LABEL[i]}
                    </span>
                  </div>

                  {hasPlan && (
                    <div className="mt-4">
                      <div className="flex justify-between text-sm text-slate-300 mb-2">
                        <span>
                          {formatUZS(Number(plan.actual))}
                          <span className="text-slate-500 ml-2">из {formatUZS(Number(plan.target))}</span>
                        </span>
                        <span className={`font-bold text-lg ${
                          pct >= 100 ? "text-emerald-400" : i === 0 ? "text-yellow-400" : "text-slate-300"
                        }`}>
                          {pct}%
                        </span>
                      </div>
                      <div className="h-3 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-1000 ${BAR_COLOR[i]} ${
                            pct >= 100 ? "!bg-emerald-400" : ""
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {pct >= 100 && (
                        <div className="text-emerald-400 text-sm font-semibold mt-1">
                          ✓ План выполнен!
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Right: big amount */}
                <div className="text-right shrink-0">
                  <div className={`text-4xl font-black tabular-nums ${
                    i === 0 ? "text-yellow-300" : i === 1 ? "text-slate-200" : "text-orange-300"
                  }`}>
                    {formatUZS(Number(op.total))}
                  </div>
                  <div className="text-slate-400 text-base mt-1">{op.count} продаж</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="text-center pb-6 text-slate-600 text-xs tracking-widest uppercase">
        {now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
      </div>
    </div>
  );
}
