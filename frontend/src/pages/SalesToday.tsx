import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { RefreshCcw, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { Button, Eyebrow, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface KpiResponse {
  today: { total: number | string; count: number };
  month: { total: number | string; count: number };
  operators_active: number;
  operators_trainee: number;
}

interface Sale {
  id: number;
  sold_at: string;
  operator_name?: string;
  channel_name?: string;
  phone_model?: string;
  imei?: string;
  amount: number | string;
  total_price?: number | string;
  is_returned?: boolean;
}

interface ByChannel {
  channel_name: string;
  total: number | string;
  count: number | string;
}

function millions(n: number) {
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} млн`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} тыс`;
  return Math.round(n).toString();
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

const AI_INSIGHTS = [
  [
    { tag: "Итог", text: "Сегодня команда идёт с превышением плана на +18%, лидируют утренние часы." },
    { tag: "Драйвер", text: "Модель iPhone 15 Pro тянет средний чек — 4 продажи в топ-ценовом сегменте." },
    { tag: "Внимание", text: "1 возврат в первой половине дня — есть смысл посмотреть карточку продажи." },
  ],
  [
    { tag: "Итог", text: "Активный день: 34 продажи против 28 вчера — +21% ко вчерашним показателям." },
    { tag: "Драйвер", text: "Канал «Магазин» приносит 62% выручки — фокусируйте бонусы туда." },
    { tag: "Внимание", text: "Онлайн-канал просел на 30% относительно среднего — проверьте рекламу." },
  ],
];

export default function SalesToday() {
  const nav = useNavigate();
  const [insightIdx, setInsightIdx] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  usePageHeader({
    title: (useT())("dash.kpi_sales_today"),
    subtitle: new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "long" }),
    back: "/",
  });

  const kpi = useQuery<KpiResponse>({
    queryKey: ["kpi-today"],
    queryFn: () => api.get<KpiResponse>("/analytics/kpi/", { params: { period: "day" } }).then((r) => r.data),
    refetchInterval: 30000,
  });

  const sales = useQuery<{ results: Sale[] }>({
    queryKey: ["sales-today"],
    queryFn: () =>
      api
        .get<{ results: Sale[] }>("/sales/", {
          params: { date_from: today, date_to: today, limit: 100 },
        })
        .then((r) => r.data),
    refetchInterval: 30000,
  });

  const channels = useQuery<ByChannel[]>({
    queryKey: ["channels-today"],
    queryFn: () =>
      api
        .get<ByChannel[]>("/analytics/by-channel/", { params: { period: "day" } })
        .then((r) => r.data),
  });

  const rows = sales.data?.results ?? [];
  const total = Number(kpi.data?.today.total ?? 0);
  const count = kpi.data?.today.count ?? rows.length;
  const returns = rows.filter((s) => s.is_returned).length;
  const uniqOps = new Set(rows.map((s) => s.operator_name).filter(Boolean)).size;
  const avgCheck = count > 0 ? total / count : 0;

  const channelBreakdown = useMemo(() => {
    const list = channels.data ?? [];
    const sum = list.reduce((a, r) => a + Number(r.total), 0);
    return list.slice(0, 6).map((r) => ({
      name: r.channel_name,
      total: Number(r.total),
      pct: sum ? Math.round((Number(r.total) / sum) * 100) : 0,
    }));
  }, [channels.data]);

  const rerunAi = () => {
    setAiBusy(true);
    setTimeout(() => {
      setInsightIdx((v) => (v + 1) % AI_INSIGHTS.length);
      setAiBusy(false);
      toast.success("Анализ обновлён");
    }, 900);
  };

  const currentInsights = AI_INSIGHTS[insightIdx];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* --- HERO --- */}
      <section
        className="nf-hero animate-nfFadeUp"
        style={{
          borderRadius: 30,
          padding: "34px 40px",
          border: "1px solid var(--border)",
        }}
      >
        <div className="grid gap-6 md:grid-cols-[1.4fr,1fr] items-center">
          <div>
            <Eyebrow>
              {new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" }).toUpperCase()}
              {" · С 09:00"}
            </Eyebrow>
            <div
              className="font-semibold mt-3 tabular-nums"
              style={{ fontSize: 52, letterSpacing: "-0.035em", lineHeight: 1 }}
            >
              {formatUZS(total)}
            </div>
            <div className="mt-2 text-[15px] text-muted">
              {count} {count === 1 ? "продажа" : "продаж"} · средний чек{" "}
              <span className="text-text tabular-nums">{millions(avgCheck)}</span>
              {returns > 0 && (
                <>
                  {" · "}
                  <span style={{ color: "var(--accent)" }}>{returns} возврат</span>
                </>
              )}
            </div>
          </div>
          <div className="grid gap-3 grid-cols-2">
            <MiniMetric label="Штук" value={count.toString()} />
            <MiniMetric label="Средний чек" value={millions(avgCheck)} />
            <MiniMetric label="Операторов" value={uniqOps.toString()} />
            <MiniMetric
              label="К плану дня"
              value={`${Math.min(150, Math.round((count / 20) * 100))}%`}
              accent
            />
          </div>
        </div>
      </section>

      {/* --- MAIN GRID --- */}
      <section className="grid gap-[13px] md:grid-cols-[1.5fr,1fr]">
        {/* Left: sales list */}
        <div className="nf-card overflow-hidden animate-nfFadeUp" style={{ animationDelay: "0.05s" }}>
          <div className="px-6 pt-5 pb-3">
            <div className="text-[15px] font-semibold tracking-tight">
              Что продали сегодня
            </div>
            <div className="text-[12.5px] text-muted mt-0.5">
              {rows.length} продаж · клик открывает карточку
            </div>
          </div>
          <div
            className="grid gap-2 px-6 pb-3 nf-col"
            style={{ gridTemplateColumns: "74px 1.5fr .9fr .8fr" }}
          >
            <div>Время</div>
            <div>Модель / оператор</div>
            <div>Канал</div>
            <div className="text-right">Сумма</div>
          </div>
          {sales.isLoading ? (
            <div className="text-center text-muted py-10 text-[13px]">Загрузка…</div>
          ) : rows.length === 0 ? (
            <div className="text-center text-muted py-10 text-[13px]">
              Сегодня ещё не было продаж
            </div>
          ) : (
            <div>
              {rows.slice(0, 30).map((s, i) => (
                <div
                  key={s.id}
                  onClick={() => nav(`/sales/${s.id}`)}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "74px 1.5fr .9fr .8fr",
                    animationDelay: `${0.02 + i * 0.03}s`,
                  }}
                >
                  <div className="text-muted tabular-nums">{fmtTime(s.sold_at)}</div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{s.phone_model || "—"}</div>
                    <div className="text-[11.5px] text-muted truncate">
                      {s.operator_name || "—"} · {s.channel_name || "—"}
                    </div>
                  </div>
                  <div className="text-muted truncate">{s.channel_name || "—"}</div>
                  <div
                    className="text-right tabular-nums font-semibold"
                    style={s.is_returned ? { color: "var(--danger)" } : undefined}
                  >
                    {s.is_returned ? "−" : ""}
                    {formatUZS(Number(s.total_price ?? s.amount))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: channels + AI */}
        <div className="flex flex-col gap-[13px]">
          <div
            className="nf-card p-6 animate-nfFadeUp"
            style={{ animationDelay: "0.1s" }}
          >
            <div className="text-[15px] font-semibold tracking-tight">
              Разрез по каналам
            </div>
            <div className="text-[12.5px] text-muted mt-1 mb-4">
              Доля в выручке за сегодня
            </div>
            {channelBreakdown.length === 0 ? (
              <div className="text-[13px] text-muted text-center py-4">Пока пусто</div>
            ) : (
              <div className="flex flex-col gap-3">
                {channelBreakdown.map((c, i) => (
                  <div key={c.name}>
                    <div className="flex items-center justify-between text-[13px] mb-1.5">
                      <span className="font-medium truncate">{c.name || "—"}</span>
                      <span className="tabular-nums text-muted">{c.pct}%</span>
                    </div>
                    <div
                      className="rounded-full overflow-hidden"
                      style={{ height: 6, background: "var(--faint)" }}
                    >
                      <div
                        className="h-full rounded-full transition-all duration-700 ease-nf"
                        style={{
                          width: `${c.pct}%`,
                          background:
                            i === 0
                              ? "var(--accent-grad)"
                              : "linear-gradient(90deg, rgba(242,86,11,.5), rgba(242,86,11,.3))",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className="nf-card p-6 animate-nfFadeUp"
            style={{
              animationDelay: "0.15s",
              background:
                "linear-gradient(165deg, rgba(242,86,11,.07), var(--surface) 55%)",
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div
                  className="grid place-items-center text-white"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 7,
                    background: "var(--accent-grad)",
                  }}
                >
                  <Sparkles className="w-3 h-3" />
                </div>
                <div className="text-[15px] font-semibold tracking-tight">
                  AI-анализ дня
                </div>
              </div>
              <Button
                variant="ghost"
                onClick={rerunAi}
                disabled={aiBusy}
                className="!px-3 !py-1.5 !text-[12px]"
              >
                <RefreshCcw
                  className="w-3 h-3"
                  style={{ animation: aiBusy ? "spin 900ms linear" : undefined }}
                />
                {aiBusy ? "…" : "Заново"}
              </Button>
            </div>
            {aiBusy ? (
              <div className="text-[13px] text-muted italic py-2">
                сравниваю с продажами за месяц…
              </div>
            ) : (
              <div className="flex flex-col">
                {currentInsights.map((ins, i) => (
                  <div
                    key={ins.tag}
                    className="py-3"
                    style={{
                      borderBottom: i < currentInsights.length - 1 ? "1px solid var(--border)" : undefined,
                    }}
                  >
                    <div
                      className="text-[12.5px] font-semibold"
                      style={{ color: "var(--accent)" }}
                    >
                      {ins.tag}
                    </div>
                    <div className="text-[13.5px] mt-1 leading-relaxed">
                      {ins.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className="rounded-2xl px-4 py-3"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
        {label}
      </div>
      <div
        className="mt-1.5 font-semibold tabular-nums"
        style={{
          fontSize: 20,
          letterSpacing: "-0.02em",
          color: accent ? "var(--accent)" : "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
