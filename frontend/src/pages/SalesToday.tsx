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

function millions(n: number, mln: string, ths: string) {
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} ${mln}`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} ${ths}`;
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

export default function SalesToday() {
  const nav = useNavigate();
  const [insightIdx, setInsightIdx] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  const t = useT();

  const AI_INSIGHTS = [
    [
      { tag: t("sales_today.ai_tag_result"), text: t("sales_today.ai_insight_1_1") },
      { tag: t("sales_today.ai_tag_driver"), text: t("sales_today.ai_insight_1_2") },
      { tag: t("sales_today.ai_tag_attention"), text: t("sales_today.ai_insight_1_3") },
    ],
    [
      { tag: t("sales_today.ai_tag_result"), text: t("sales_today.ai_insight_2_1") },
      { tag: t("sales_today.ai_tag_driver"), text: t("sales_today.ai_insight_2_2") },
      { tag: t("sales_today.ai_tag_attention"), text: t("sales_today.ai_insight_2_3") },
    ],
  ];

  usePageHeader({
    title: t("dash.kpi_sales_today"),
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
      toast.success(t("sales_today.analysis_updated"));
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
              {" · "}{t("sales_today.since_9")}
            </Eyebrow>
            <div
              className="font-semibold mt-3 tabular-nums"
              style={{ fontSize: 52, letterSpacing: "-0.035em", lineHeight: 1 }}
            >
              {formatUZS(total)}
            </div>
            <div className="mt-2 text-[15px] text-muted">
              {count === 1 ? t("sales_today.sale_one", { n: count }) : t("sales_today.sale_many", { n: count })} · {t("sales_today.avg_check_lower")}{" "}
              <span className="text-text tabular-nums">{millions(avgCheck, t("sales_today.unit_mln"), t("sales_today.unit_ths"))}</span>
              {returns > 0 && (
                <>
                  {" · "}
                  <span style={{ color: "var(--accent)" }}>{t("sales_today.returns_count", { n: returns })}</span>
                </>
              )}
            </div>
          </div>
          <div className="grid gap-3 grid-cols-2">
            <MiniMetric label={t("sales_today.mini_units")} value={count.toString()} />
            <MiniMetric label={t("sales_today.mini_avg_check")} value={millions(avgCheck, t("sales_today.unit_mln"), t("sales_today.unit_ths"))} />
            <MiniMetric label={t("sales_today.mini_operators")} value={uniqOps.toString()} />
            <MiniMetric
              label={t("sales_today.mini_plan")}
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
              {t("sales_today.sold_today")}
            </div>
            <div className="text-[12.5px] text-muted mt-0.5">
              {t("sales_today.rows_hint", { n: rows.length })}
            </div>
          </div>
          <div
            className="grid gap-2 px-6 pb-3 nf-col"
            style={{ gridTemplateColumns: "74px 1.5fr .9fr .8fr" }}
          >
            <div>{t("sales_today.col_time")}</div>
            <div>{t("sales_today.col_model_op")}</div>
            <div>{t("sales_today.col_channel")}</div>
            <div className="text-right">{t("common.amount")}</div>
          </div>
          {sales.isLoading ? (
            <div className="text-center text-muted py-10 text-[13px]">{t("common.loading")}</div>
          ) : rows.length === 0 ? (
            <div className="text-center text-muted py-10 text-[13px]">
              {t("sales_today.empty")}
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
              {t("sales_today.by_channel_title")}
            </div>
            <div className="text-[12.5px] text-muted mt-1 mb-4">
              {t("sales_today.by_channel_hint")}
            </div>
            {channelBreakdown.length === 0 ? (
              <div className="text-[13px] text-muted text-center py-4">{t("sales_today.empty_short")}</div>
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
                  {t("sales_today.ai_day_title")}
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
                {aiBusy ? "…" : t("sales_today.ai_redo")}
              </Button>
            </div>
            {aiBusy ? (
              <div className="text-[13px] text-muted italic py-2">
                {t("sales_today.ai_thinking")}
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
