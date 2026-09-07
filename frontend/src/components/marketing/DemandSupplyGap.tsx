import { useMemo } from "react";
import { useT } from "../../lib/i18n";
import type { DemandSupplyPayload, GapRow } from "./types";

interface Props {
  data: DemandSupplyPayload | undefined;
  isLoading?: boolean;
}

function indicatorLabel(indicator: GapRow["indicator"], t: (k: string) => string): { text: string; bg: string; color: string } {
  if (indicator === "gap_deficit") {
    return {
      text: t("marketing_sources.indicator.deficit"),
      bg: "rgba(220, 38, 38, 0.10)",
      color: "#b91c1c",
    };
  }
  if (indicator === "gap_surplus") {
    return {
      text: t("marketing_sources.indicator.surplus"),
      bg: "rgba(234, 179, 8, 0.15)",
      color: "#a16207",
    };
  }
  return {
    text: t("marketing_sources.indicator.match"),
    bg: "rgba(22, 163, 74, 0.10)",
    color: "#15803d",
  };
}

/**
 * "Что искали vs что купили" table. Full-outer join of Lead.product_hint
 * demand and Sale.phone_model supply, with a colour-coded indicator per row.
 *
 * We deliberately sort by (demand + supply) descending — top of the table
 * = the models the shop actually cares about (either lots asked or lots
 * sold). Deficits bubble up because "asked a lot, sold few" pushes the sum
 * up too.
 */
export default function DemandSupplyGap({ data, isLoading }: Props) {
  const t = useT();

  const rows = useMemo(() => data?.gap ?? [], [data]);

  if (isLoading) {
    return <div className="text-[13px] text-muted animate-pulse">{t("common.loading")}</div>;
  }
  if (!rows.length) {
    return <div className="text-[13px] text-muted">{t("marketing_sources.gap_empty")}</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11.5px] uppercase tracking-wide text-muted">
            <th className="text-left font-normal pb-2 pr-2">{t("marketing_sources.gap.model")}</th>
            <th className="text-right font-normal pb-2 px-2">{t("marketing_sources.gap.demand")}</th>
            <th className="text-right font-normal pb-2 px-2">{t("marketing_sources.gap.supply")}</th>
            <th className="text-right font-normal pb-2 px-2">{t("marketing_sources.gap.conv")}</th>
            <th className="text-left font-normal pb-2 pl-2">{t("marketing_sources.gap.status")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ind = indicatorLabel(r.indicator, t);
            return (
              <tr key={r.model_key} className="border-t border-[color:var(--faint)]">
                <td className="py-1.5 pr-2 font-medium">{r.model_key}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{r.demand_count}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{r.supply_count}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-muted">
                  {r.conv_pct == null ? "—" : `${r.conv_pct}%`}
                </td>
                <td className="py-1.5 pl-2">
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
                    style={{ background: ind.bg, color: ind.color }}
                  >
                    {ind.text}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data && (
        <div className="text-[11.5px] text-muted mt-2">
          {t("marketing_sources.gap.totals", { d: data.totals.demand, s: data.totals.supply })}
        </div>
      )}
    </div>
  );
}
