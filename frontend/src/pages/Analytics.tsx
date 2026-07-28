import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { formatUZS } from "../lib/format";
import { buildPeriodParams, periodTitle, type MonthChoice } from "../lib/period";
import MonthPicker from "../components/MonthPicker";
import { Button, Eyebrow } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface LeaderboardRow {
  operator_id: number;
  operator_name: string;
  total: number | string;
  count?: number | string;
}
interface ByChannelRow {
  channel_name: string;
  total: number | string;
  count: number | string;
}
interface ByModelRow {
  phone_model: string;
  count: number | string;
  total: number | string;
}
interface BySourceRow {
  sheet_source_id: number | null;
  sheet_source_name: string;
  total: number | string;
  sales_count: number;
  leads_count: number;
  conversion_pct: number;
}
interface FunnelRow {
  operator_id: number;
  operator_name: string;
  leads_total: number;
  contacted: number;
  callbacks: number;
  sales: number;
}
interface HeatmapPayload {
  operators: { id: number; name: string }[];
  hours: number[];
  matrix: number[][];
}

function millions(n: number) {
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} млн`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} тыс`;
  return Math.round(n).toString();
}

export default function Analytics() {
  const [choice, setChoice] = useState<MonthChoice>({ kind: "current" });
  const params = buildPeriodParams("month", choice);
  const paramKey = JSON.stringify(params);
  const title = periodTitle("month", choice);

  const t = useT();
  usePageHeader({ title: t("analytics.title"), subtitle: title }, [t("analytics.title"), title]);

  const exportParams = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null) as [string, string][],
  ).toString();

  const lb = useQuery<LeaderboardRow[]>({
    queryKey: ["lb", paramKey],
    queryFn: () =>
      api.get<LeaderboardRow[]>("/analytics/leaderboard/", { params }).then((r) => r.data),
  });
  const ch = useQuery<ByChannelRow[]>({
    queryKey: ["by-channel", paramKey],
    queryFn: () =>
      api.get<ByChannelRow[]>("/analytics/by-channel/", { params }).then((r) => r.data),
  });
  const md = useQuery<ByModelRow[]>({
    queryKey: ["by-model", paramKey],
    queryFn: () =>
      api.get<ByModelRow[]>("/analytics/by-model/", { params }).then((r) => r.data),
  });
  const src = useQuery<BySourceRow[]>({
    queryKey: ["by-source", paramKey],
    queryFn: () =>
      api.get<BySourceRow[]>("/analytics/by-source/", { params }).then((r) => r.data),
  });
  const funnels = useQuery<FunnelRow[]>({
    queryKey: ["operator-funnels"],
    queryFn: () =>
      api.get<FunnelRow[]>("/analytics/operator-funnels/?top_n=20").then((r) => r.data),
  });
  const heatmap = useQuery<HeatmapPayload>({
    queryKey: ["callback-heatmap"],
    queryFn: () =>
      api.get<HeatmapPayload>("/analytics/callback-heatmap/?days_back=30").then((r) => r.data),
  });

  const teamFunnel = useMemo(() => {
    const rows = funnels.data ?? [];
    return rows.reduce(
      (acc, r) => {
        acc.leads += r.leads_total;
        acc.contacted += r.contacted;
        acc.callbacks += r.callbacks;
        acc.sales += r.sales;
        return acc;
      },
      { leads: 0, contacted: 0, callbacks: 0, sales: 0 },
    );
  }, [funnels.data]);

  const channels = useMemo(() => {
    const rows = (ch.data ?? []).slice(0, 6);
    const total = rows.reduce((a, r) => a + Number(r.total), 0);
    return rows.map((r) => ({
      name: r.channel_name,
      total: Number(r.total),
      pct: total ? Math.round((Number(r.total) / total) * 100) : 0,
    }));
  }, [ch.data]);

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Controls */}
      <section className="flex flex-wrap items-center justify-between gap-3 animate-nfFadeUp">
        <div>
          <Eyebrow>{title.toUpperCase()}</Eyebrow>
          <div className="text-[15px] font-semibold mt-1">Аналитика по команде</div>
        </div>
        <div className="flex items-center gap-2">
          <MonthPicker value={choice} onChange={setChoice} />
          <a
            href={`${API_BASE_URL}/analytics/export.xlsx${exportParams ? "?" + exportParams : ""}`}
          >
            <Button variant="secondary">
              <Download className="w-3.5 h-3.5" /> Excel
            </Button>
          </a>
        </div>
      </section>

      {/* Team funnel + Channels */}
      <section className="grid gap-[13px] md:grid-cols-2">
        <div className="nf-card p-6 animate-nfFadeUp">
          <div className="text-[15px] font-semibold tracking-tight">Воронка команды</div>
          <div className="text-[12.5px] text-muted mt-1">Лиды → контакт → callback → продажа</div>
          <div className="mt-5 flex flex-col gap-3">
            <FunnelBar label="Лиды" value={teamFunnel.leads} max={teamFunnel.leads || 1} />
            <FunnelBar
              label="Дозвоны"
              value={teamFunnel.contacted}
              max={teamFunnel.leads || 1}
            />
            <FunnelBar
              label="Callback"
              value={teamFunnel.callbacks}
              max={teamFunnel.leads || 1}
            />
            <FunnelBar
              label="Продажи"
              value={teamFunnel.sales}
              max={teamFunnel.leads || 1}
              accent
            />
          </div>
        </div>

        <div className="nf-card p-6 animate-nfFadeUp" style={{ animationDelay: "0.05s" }}>
          <div className="text-[15px] font-semibold tracking-tight">{t("analytics.channels_title")}</div>
          <div className="text-[12.5px] text-muted mt-1">{t("analytics.channels_hint", { period: title })}</div>
          <div className="mt-5 flex flex-col gap-4">
            {channels.length === 0 && (
              <div className="text-[13px] text-muted text-center py-6">Нет данных</div>
            )}
            {channels.map((c, i) => (
              <div key={c.name}>
                <div className="flex items-center justify-between text-[13px] mb-1.5">
                  <span className="font-medium truncate">{c.name || "—"}</span>
                  <span className="tabular-nums text-muted">
                    {formatUZS(c.total)} · {c.pct}%
                  </span>
                </div>
                <div
                  className="h-[7px] rounded-full overflow-hidden"
                  style={{ background: "var(--faint)" }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-nf"
                    style={{
                      width: `${c.pct}%`,
                      background:
                        i === 0
                          ? "var(--accent-grad)"
                          : `linear-gradient(90deg, var(--accent2), var(--accent))`,
                      opacity: i === 0 ? 1 : 0.7 - i * 0.1,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* By source (targetolog) */}
      <section
        className="nf-card p-6 animate-nfFadeUp"
        style={{ animationDelay: "0.08s" }}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[15px] font-semibold tracking-tight">
              {t("analytics.by_source_title")}
            </div>
            <div className="text-[12.5px] text-muted mt-0.5">
              {t("analytics.by_source_hint", { period: title })}
            </div>
          </div>
        </div>
        {(src.data ?? []).length === 0 ? (
          <div className="text-[13px] text-muted text-center py-6">
            {t("common.no_data")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div
              className="grid gap-2 pb-2 nf-col"
              style={{ gridTemplateColumns: "1.5fr .8fr .8fr .8fr 1.1fr" }}
            >
              <div>{t("analytics.by_source_col_name")}</div>
              <div className="text-right">{t("analytics.by_source_col_leads")}</div>
              <div className="text-right">{t("analytics.by_source_col_sales")}</div>
              <div className="text-right">{t("analytics.by_source_col_conv")}</div>
              <div className="text-right">{t("analytics.by_source_col_revenue")}</div>
            </div>
            {(src.data ?? []).map((r, i) => {
              const max = Math.max(
                1,
                ...(src.data ?? []).map((x) => Number(x.total)),
              );
              const pct = (Number(r.total) / max) * 100;
              return (
                <div
                  key={r.sheet_source_id ?? `direct-${i}`}
                  className="grid gap-2 items-center py-2 animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "1.5fr .8fr .8fr .8fr 1.1fr",
                    borderTop: i === 0 ? "1px solid var(--border)" : undefined,
                    borderBottom: "1px solid var(--faint)",
                    animationDelay: `${0.02 + i * 0.04}s`,
                  }}
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-medium truncate text-[13.5px]">
                      {r.sheet_source_name}
                    </span>
                    <div
                      className="h-[5px] rounded-full overflow-hidden"
                      style={{ background: "var(--faint)" }}
                    >
                      <div
                        className="h-full rounded-full transition-all duration-700 ease-nf"
                        style={{
                          width: `${pct}%`,
                          background:
                            i === 0
                              ? "var(--accent-grad)"
                              : "linear-gradient(90deg, var(--accent2), var(--accent))",
                          opacity: i === 0 ? 1 : Math.max(0.4, 0.75 - i * 0.08),
                        }}
                      />
                    </div>
                  </div>
                  <div className="text-right tabular-nums text-[13px]">
                    {r.leads_count}
                  </div>
                  <div className="text-right tabular-nums text-[13px]">
                    {r.sales_count}
                  </div>
                  <div
                    className="text-right tabular-nums text-[13px] font-semibold"
                    style={{
                      color: r.conversion_pct >= 3 ? "var(--accent)" : "var(--muted)",
                    }}
                  >
                    {r.conversion_pct}%
                  </div>
                  <div className="text-right tabular-nums text-[13px]">
                    {formatUZS(r.total)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Leaderboard bars */}
      <section
        className="nf-card p-6 animate-nfFadeUp"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="text-[15px] font-semibold tracking-tight">
              {t("analytics.top_operators_title")}
            </div>
            <div className="text-[12.5px] text-muted mt-0.5">
              {t("analytics.top_operators_hint", { period: title })}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {(lb.data ?? []).length === 0 && (
            <div className="text-[13px] text-muted text-center py-6">Нет данных</div>
          )}
          {(() => {
            const max = Math.max(
              1,
              ...(lb.data ?? []).map((r) => Number(r.total)),
            );
            return (lb.data ?? []).slice(0, 10).map((r, i) => {
              const total = Number(r.total);
              const pct = (total / max) * 100;
              return (
                <div
                  key={r.operator_id}
                  className="grid items-center gap-3 animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "22px 1fr auto",
                    animationDelay: `${0.03 + i * 0.045}s`,
                  }}
                >
                  <div
                    className="grid place-items-center text-[11px] tabular-nums font-semibold"
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 99,
                      background: i === 0 ? "var(--accent-grad)" : "var(--faint)",
                      color: i === 0 ? "#fff" : "var(--muted)",
                    }}
                  >
                    {i + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium truncate mb-1">
                      {r.operator_name}
                    </div>
                    <div
                      className="h-[5px] rounded-full overflow-hidden"
                      style={{ background: "var(--faint)" }}
                    >
                      <div
                        className="h-full rounded-full transition-all duration-700 ease-nf"
                        style={{
                          width: `${pct}%`,
                          background: "var(--accent-grad)",
                        }}
                      />
                    </div>
                  </div>
                  <div className="text-[13px] tabular-nums font-semibold shrink-0">
                    {millions(total)}
                  </div>
                </div>
              );
            });
          })()}
        </div>
      </section>

      {/* Top models */}
      <section
        className="nf-card overflow-hidden animate-nfFadeUp"
        style={{ animationDelay: "0.15s" }}
      >
        <div className="px-6 pt-5 pb-3 flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold tracking-tight">Топ моделей</div>
            <div className="text-[12.5px] text-muted mt-0.5">По продажам · {title}</div>
          </div>
        </div>
        <div
          className="grid gap-2 px-6 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.5fr .8fr .8fr" }}
        >
          <div>Модель</div>
          <div className="text-right">Кол-во</div>
          <div className="text-right">Сумма</div>
        </div>
        {(md.data ?? []).length === 0 ? (
          <div className="text-center text-muted py-10 text-[13px]">Нет данных</div>
        ) : (
          <div>
            {(md.data ?? []).slice(0, 12).map((r, i) => (
              <div
                key={i}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "1.5fr .8fr .8fr",
                  animationDelay: `${0.02 + i * 0.03}s`,
                  cursor: "default",
                }}
              >
                <div className="truncate font-medium">{r.phone_model || "—"}</div>
                <div className="text-right tabular-nums text-muted">
                  {Number(r.count)}
                </div>
                <div className="text-right tabular-nums font-semibold">
                  {formatUZS(Number(r.total))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Heatmap */}
      <section
        className="nf-card p-6 overflow-x-auto animate-nfFadeUp"
        style={{ animationDelay: "0.2s" }}
      >
        <div className="text-[15px] font-semibold tracking-tight">
          Тепловая карта callback-активности
        </div>
        <div className="text-[12.5px] text-muted mt-1 mb-5">
          Часы дня — колонки; операторы — строки; интенсивность = число callback'ов · 30 дней
        </div>
        <HeatmapView payload={heatmap.data} />
      </section>
    </div>
  );
}

function FunnelBar({
  label,
  value,
  max,
  accent,
}: {
  label: string;
  value: number;
  max: number;
  accent?: boolean;
}) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1.5">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">{value}</span>
      </div>
      <div
        className="rounded-full overflow-hidden"
        style={{ height: 26, background: "var(--faint)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-700 ease-nf"
          style={{
            width: `${pct}%`,
            background: accent
              ? "var(--accent-grad)"
              : "linear-gradient(90deg, rgba(242,86,11,.55), rgba(242,86,11,.35))",
          }}
        />
      </div>
    </div>
  );
}

function HeatmapView({ payload }: { payload: HeatmapPayload | undefined }) {
  if (!payload || payload.operators.length === 0) {
    return <div className="text-center text-muted py-8 text-[13px]">Нет данных</div>;
  }
  const maxV = Math.max(1, ...payload.matrix.flat());
  return (
    <table className="text-[11.5px] border-separate" style={{ borderSpacing: 2 }}>
      <thead>
        <tr>
          <th className="text-left pr-4 font-normal text-muted"></th>
          {payload.hours.map((h) => (
            <th
              key={h}
              className="font-normal text-muted tabular-nums text-center"
              style={{ width: 22 }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {payload.operators.map((op, ri) => (
          <tr key={op.id}>
            <td className="pr-4 py-0.5 whitespace-nowrap max-w-[180px] truncate text-[12px]">
              {op.name}
            </td>
            {payload.hours.map((h, hi) => {
              const v = payload.matrix[ri][hi];
              const intensity = v === 0 ? 0 : Math.min(1, v / maxV);
              return (
                <td
                  key={h}
                  className="text-center tabular-nums"
                  title={`${op.name}, ${h}:00 → ${v}`}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background:
                      v === 0
                        ? "var(--faint)"
                        : `rgba(242,86,11,${(0.12 + intensity * 0.85).toFixed(3)})`,
                    color: intensity > 0.55 ? "#fff" : "var(--muted)",
                    fontSize: 10,
                  }}
                >
                  {v > 0 ? v : ""}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
