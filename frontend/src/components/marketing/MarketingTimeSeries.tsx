import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useT } from "../../lib/i18n";
import type { SourceRow, WowDelta } from "./types";

interface Props {
  sources: SourceRow[];
  wow: WowDelta;
}

// Compact comparison chart: shows top 6 sources with current vs previous
// leads and conversion rate. Not a real timeseries per day (backend doesn't
// carry daily-by-source yet) — this is period vs prev-period.

export default function MarketingTimeSeries({ sources, wow }: Props) {
  const t = useT();
  const data = useMemo(() => {
    return sources
      .slice(0, 6)
      .map((s) => ({
        source: s.source_name.length > 14 ? s.source_name.slice(0, 12) + "…" : s.source_name,
        leads_cur: s.leads,
        leads_prev: s.prev_period.leads,
        conv_cur: s.conv_rate,
        conv_prev: s.prev_period.conv_rate,
      }));
  }, [sources]);

  if (data.length === 0) {
    return (
      <div className="nf-card p-8 text-center text-[13.5px] text-muted">
        {t("common.no_data")}
      </div>
    );
  }

  return (
    <div className="grid gap-[13px] lg:grid-cols-2">
      <div className="nf-card p-5">
        <div className="text-[15px] font-semibold tracking-tight">
          {t("marketing.ts.leads_title")}
        </div>
        <div className="text-[12px] text-muted mt-0.5 mb-4">
          {t("marketing.ts.leads_hint")}
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--faint)" />
            <XAxis dataKey="source" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="leads_prev" fill="rgba(0,0,0,.2)" name={t("marketing.ts.prev")} />
            <Bar dataKey="leads_cur" fill="#3b82f6" name={t("marketing.ts.cur")} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="nf-card p-5">
        <div className="text-[15px] font-semibold tracking-tight">
          {t("marketing.ts.conv_title")}
        </div>
        <div className="text-[12px] text-muted mt-0.5 mb-4">
          {t("marketing.ts.conv_hint")}
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--faint)" />
            <XAxis dataKey="source" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="conv_prev" fill="rgba(0,0,0,.2)" name={`${t("marketing.ts.prev")} %`} />
            <Bar dataKey="conv_cur" fill="#f2560b" name={`${t("marketing.ts.cur")} %`} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="lg:col-span-2 grid gap-3 md:grid-cols-3">
        <div className="nf-card p-4">
          <div className="text-[11px] uppercase text-muted">{t("marketing.ts.leads_wow")}</div>
          <div className="mt-1 text-[22px] font-semibold tabular-nums">
            {wow.delta.leads_pct == null ? "—" : `${wow.delta.leads_pct >= 0 ? "+" : ""}${wow.delta.leads_pct}%`}
          </div>
          <div className="text-[12px] text-muted mt-1">
            {wow.current.leads} vs {wow.previous.leads}
          </div>
        </div>
        <div className="nf-card p-4">
          <div className="text-[11px] uppercase text-muted">{t("marketing.ts.converted_wow")}</div>
          <div className="mt-1 text-[22px] font-semibold tabular-nums">
            {wow.delta.converted_pct == null ? "—" : `${wow.delta.converted_pct >= 0 ? "+" : ""}${wow.delta.converted_pct}%`}
          </div>
          <div className="text-[12px] text-muted mt-1">
            {wow.current.converted} vs {wow.previous.converted}
          </div>
        </div>
        <div className="nf-card p-4">
          <div className="text-[11px] uppercase text-muted">{t("marketing.ts.revenue_wow")}</div>
          <div className="mt-1 text-[22px] font-semibold tabular-nums">
            {wow.delta.revenue_pct == null ? "—" : `${wow.delta.revenue_pct >= 0 ? "+" : ""}${wow.delta.revenue_pct}%`}
          </div>
          <div className="text-[12px] text-muted mt-1">
            Δ conv_rate: {wow.delta.conv_rate_pp >= 0 ? "+" : ""}{wow.delta.conv_rate_pp} pp
          </div>
        </div>
      </div>
    </div>
  );
}
