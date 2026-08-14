import { formatUZS } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { MarketingTotals, WowDelta } from "./types";

interface Props {
  totals: MarketingTotals;
  wow: WowDelta;
}

function deltaBadge(pct: number | null) {
  if (pct == null) return null;
  const positive = pct > 0;
  const color = positive ? "#16a34a" : pct < 0 ? "#dc2626" : "var(--muted)";
  const arrow = positive ? "▲" : pct < 0 ? "▼" : "·";
  return (
    <span className="text-[12px] font-semibold tabular-nums" style={{ color }}>
      {arrow} {Math.abs(pct)}%
    </span>
  );
}

export default function MarketingKpiCards({ totals, wow }: Props) {
  const t = useT();
  const cards = [
    {
      label: t("marketing.kpi.leads"),
      value: totals.leads.toString(),
      sub: `${t("marketing.kpi.vs_prev")}: ${wow.previous.leads}`,
      delta: deltaBadge(wow.delta.leads_pct),
    },
    {
      label: t("marketing.kpi.converted"),
      value: totals.converted.toString(),
      sub: `${t("marketing.kpi.conv_rate")}: ${totals.conv_rate}%`,
      delta: deltaBadge(wow.delta.converted_pct),
    },
    {
      label: t("marketing.kpi.revenue"),
      value: formatUZS(totals.revenue),
      sub: `${t("marketing.kpi.avg_check")}: ${formatUZS(totals.avg_check)}`,
      delta: deltaBadge(wow.delta.revenue_pct),
    },
    {
      label: t("marketing.kpi.spend"),
      value: formatUZS(totals.spend),
      sub: totals.cac
        ? `${t("marketing.kpi.cac")}: ${formatUZS(totals.cac)}`
        : t("marketing.kpi.spend_hint"),
      delta:
        totals.roi_pct != null ? (
          <span
            className="text-[12px] font-semibold tabular-nums"
            style={{ color: Number(totals.roi_pct) >= 0 ? "#16a34a" : "#dc2626" }}
          >
            ROI: {totals.roi_pct}%
          </span>
        ) : null,
    },
  ];

  return (
    <div className="grid gap-[13px] md:grid-cols-2 lg:grid-cols-4">
      {cards.map((c, i) => (
        <div
          key={c.label}
          className="nf-card animate-nfFadeUp"
          style={{ padding: "18px 20px 20px", animationDelay: `${0.03 + i * 0.05}s` }}
        >
          <div className="text-[12px] uppercase tracking-wide text-muted">{c.label}</div>
          <div
            className="mt-2 font-semibold tabular-nums"
            style={{ fontSize: 24, letterSpacing: "-0.03em", lineHeight: 1.1 }}
          >
            {c.value}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[12px] text-muted">
            {c.delta}
            <span className="truncate">{c.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
