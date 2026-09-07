import { useMemo, useState } from "react";
import { formatUZS } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { SourceRow } from "./types";

interface Props {
  sources: SourceRow[];
  /** Called with the sheet_source_id (or null for bot/manual) when a row is expanded. */
  onSelect: (row: SourceRow) => void;
  /** Currently-expanded row identity. */
  selectedName: string | null;
}

type SortKey = "revenue" | "leads" | "converted" | "conv_rate" | "avg_check";

function kindBadge(kind: SourceRow["kind"], t: (k: string) => string): { text: string; color: string } {
  const map: Record<SourceRow["kind"], { text: string; color: string }> = {
    sheet: { text: t("marketing_sources.kind.sheet"), color: "#3b82f6" },
    bot: { text: t("marketing_sources.kind.bot"), color: "#8b5cf6" },
    manual: { text: t("marketing_sources.kind.manual"), color: "#f97316" },
    other: { text: t("marketing_sources.kind.other"), color: "#6b7280" },
  };
  return map[kind];
}

/**
 * "Ranking" — one row per source, sorted by revenue by default. Click on
 * a row toggles the expanded detail block (rendered by the parent page).
 *
 * The row shows:
 *   - source name + kind badge
 *   - leads / converted / conversion %
 *   - revenue + avg check
 *   - top-1 bought model (top_products[0]) as a chip
 *   - top-1 asked model (product_hint_top[0]) as a chip with demand-supply
 *     indicator colour if the two disagree (deficit hint)
 *   - a small "demand→supply ratio" number if we have hints
 *
 * We deliberately *don't* show CAC/ROI/AdSpend columns — the field exists
 * in the backend payload but the owner asked to hide these until AdSpend
 * has real data.
 */
export default function SourceRankingTable({ sources, onSelect, selectedName }: Props) {
  const t = useT();
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const copy = [...sources];
    copy.sort((a, b) => {
      const va = sortKey === "revenue" || sortKey === "avg_check"
        ? Number(a[sortKey] || 0)
        : (a[sortKey] as number);
      const vb = sortKey === "revenue" || sortKey === "avg_check"
        ? Number(b[sortKey] || 0)
        : (b[sortKey] as number);
      return sortDir === "desc" ? vb - va : va - vb;
    });
    return copy;
  }, [sources, sortKey, sortDir]);

  const toggle = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  if (!sources.length) {
    return <div className="text-[13px] text-muted">{t("marketing_sources.empty")}</div>;
  }

  const sortIcon = (key: SortKey) => (sortKey === key ? (sortDir === "desc" ? " ▼" : " ▲") : "");

  return (
    <div className="nf-card overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11.5px] uppercase tracking-wide text-muted bg-[color:var(--faint)]">
            <th className="text-left font-normal px-3 py-2">
              {t("marketing_sources.col.source")}
            </th>
            <th className="text-right font-normal px-3 py-2 cursor-pointer select-none" onClick={() => toggle("leads")}>
              {t("marketing_sources.col.leads")}{sortIcon("leads")}
            </th>
            <th className="text-right font-normal px-3 py-2 cursor-pointer select-none" onClick={() => toggle("converted")}>
              {t("marketing_sources.col.sales")}{sortIcon("converted")}
            </th>
            <th className="text-right font-normal px-3 py-2 cursor-pointer select-none" onClick={() => toggle("conv_rate")}>
              {t("marketing_sources.col.conv")}{sortIcon("conv_rate")}
            </th>
            <th className="text-right font-normal px-3 py-2 cursor-pointer select-none" onClick={() => toggle("revenue")}>
              {t("marketing_sources.col.revenue")}{sortIcon("revenue")}
            </th>
            <th className="text-right font-normal px-3 py-2 cursor-pointer select-none" onClick={() => toggle("avg_check")}>
              {t("marketing_sources.col.avg_check")}{sortIcon("avg_check")}
            </th>
            <th className="text-left font-normal px-3 py-2">{t("marketing_sources.col.top_bought")}</th>
            <th className="text-left font-normal px-3 py-2">{t("marketing_sources.col.top_asked")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const bought = r.top_products?.[0]?.name || null;
            const asked = r.product_hint_top?.[0]?.model || null;
            const askedShare = r.product_hint_top?.[0]?.share_pct;
            // Mismatch heuristic: shop's top-sold model isn't the same
            // (normalised) model as the top-asked. This is a soft signal —
            // full detail lives in the expanded gap-table.
            const ratio = r.demand_supply_ratio;
            const badge = kindBadge(r.kind, t);
            const selected = selectedName === r.source_name;

            return (
              <tr
                key={r.source_name}
                onClick={() => onSelect(r)}
                className="border-t border-[color:var(--faint)] cursor-pointer hover:bg-[color:var(--faint)]"
                style={selected ? { background: "var(--faint)" } : undefined}
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold"
                      style={{ background: `${badge.color}20`, color: badge.color }}
                    >
                      {badge.text}
                    </span>
                    <span className="font-medium truncate max-w-[220px]">{r.source_name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.leads}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.converted}
                  {r.leads > 0 && (
                    <span className="text-muted text-[11.5px] ml-1">
                      ({r.conv_rate}%)
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.conv_rate}%</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {formatUZS(r.revenue)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">
                  {r.converted > 0 ? formatUZS(r.avg_check) : "—"}
                </td>
                <td className="px-3 py-2">
                  {bought ? (
                    <span className="inline-block max-w-[160px] truncate text-[12px] px-1.5 py-0.5 rounded" style={{ background: "var(--faint)" }}>
                      {bought}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {asked ? (
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-block max-w-[140px] truncate text-[12px] px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(59, 130, 246, 0.10)", color: "#1d4ed8" }}
                      >
                        {asked}{askedShare != null ? ` · ${askedShare}%` : ""}
                      </span>
                      {ratio != null && ratio < 40 && (
                        <span
                          className="inline-block text-[11px] px-1.5 py-0.5 rounded"
                          style={{ background: "rgba(220, 38, 38, 0.10)", color: "#b91c1c" }}
                          title={t("marketing_sources.deficit_hint")}
                        >
                          {t("marketing_sources.deficit_badge")}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
