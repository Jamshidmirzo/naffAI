import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { BarsScene } from "../components/three/BarsScene";

const REFRESH_SEC = 30;

function millions(n: number) {
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} млн`;
  }
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} тыс`;
  return Math.round(n).toString();
}

export default function Screen() {
  const nav = useNavigate();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), REFRESH_SEC * 1000);
    return () => clearInterval(t);
  }, []);

  const lb = useQuery({
    queryKey: ["screen-lb-v2", tick],
    queryFn: () =>
      api
        .get("/analytics/leaderboard/", { params: { period: "month", limit: 5 } })
        .then((r) => r.data),
    staleTime: Infinity,
  });

  const rows: Array<{
    operator_id: number;
    operator_name: string;
    total: number | string;
    count: number | string;
  }> = lb.data || [];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col text-white overflow-hidden select-none"
      style={{
        background: "#08080a",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, "Segoe UI", sans-serif',
      }}
    >
      {/* 3D bars scene — top-right ambient */}
      <BarsScene
        values={rows.map((r) => Number(r.count) || Number(r.total) || 1)}
        className="absolute top-0 right-0 pointer-events-none"
        style={{ width: 460, height: 320, opacity: 0.6 }}
      />

      {/* HEADER */}
      <header className="flex items-center justify-between px-14 pt-10 pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <div
            className="grid place-items-center text-white font-bold text-[16px]"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "linear-gradient(145deg, #ff9d47, #f2560b)",
              boxShadow: "0 10px 24px -10px #f2560b",
            }}
          >
            n
          </div>
          <div>
            <div className="text-[20px] font-semibold tracking-tight">
              Табло продаж · сегодня
            </div>
            <div
              className="text-[12px] mt-0.5"
              style={{ color: "rgba(255,255,255,.4)" }}
            >
              обновление каждые {REFRESH_SEC} сек
            </div>
          </div>
        </div>
        <button
          onClick={() => nav("/")}
          className="rounded-full px-5 py-2 text-[13px] transition"
          style={{
            background: "rgba(255,255,255,.06)",
            color: "rgba(255,255,255,.75)",
          }}
        >
          Выйти
        </button>
      </header>

      {/* LEADERBOARD */}
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] px-16">
          {rows.length === 0 && (
            <div
              className="text-center py-20"
              style={{ color: "rgba(255,255,255,.4)" }}
            >
              Пока нет данных за месяц
            </div>
          )}
          {rows.map((op, i) => {
            const total = Number(op.total);
            const isFirst = i === 0;
            return (
              <div
                key={op.operator_id}
                className="grid items-center animate-nfSlide"
                style={{
                  gridTemplateColumns: "80px 1fr auto",
                  padding: "22px 0",
                  borderTop: i === 0 ? undefined : "1px solid rgba(255,255,255,.08)",
                  animationDelay: `${i * 0.09}s`,
                }}
              >
                <div
                  className="font-semibold tabular-nums text-center"
                  style={{
                    fontSize: 56,
                    letterSpacing: "-0.02em",
                    color: isFirst ? "#f2560b" : "rgba(255,255,255,.3)",
                    lineHeight: 1,
                  }}
                >
                  {i + 1}
                </div>
                <div className="flex items-baseline gap-4 min-w-0 pl-6">
                  <div
                    className="font-semibold truncate"
                    style={{ fontSize: 46, letterSpacing: "-0.03em", lineHeight: 1.05 }}
                  >
                    {op.operator_name}
                  </div>
                  <div
                    className="text-[30px] tabular-nums shrink-0"
                    style={{ color: "rgba(255,255,255,.4)" }}
                  >
                    {op.count} шт
                  </div>
                </div>
                <div
                  className="font-semibold tabular-nums text-right"
                  style={{
                    fontSize: 46,
                    letterSpacing: "-0.03em",
                    color: isFirst ? "#f2560b" : "#fff",
                    lineHeight: 1.05,
                  }}
                >
                  {millions(total)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
