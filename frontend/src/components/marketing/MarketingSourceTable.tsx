import { useState } from "react";
import { formatUZS } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { FunnelRow, RejectionRow, SourceRow } from "./types";
import MarketingSourceDetail from "./MarketingSourceDetail";

interface Props {
  sources: SourceRow[];
  funnels: FunnelRow[];
  rejection: RejectionRow[];
}

type SortKey =
  | "leads"
  | "converted"
  | "conv_rate"
  | "revenue"
  | "avg_check"
  | "delta_pp";

function sortIcon(active: boolean, direction: "asc" | "desc") {
  if (!active) return "";
  return direction === "asc" ? "▲" : "▼";
}

function kindBadge(kind: SourceRow["kind"]) {
  const map: Record<SourceRow["kind"], { text: string; color: string }> = {
    sheet: { text: "Sheet", color: "#3b82f6" },
    bot: { text: "Bot", color: "#8b5cf6" },
    manual: { text: "Manual", color: "#f97316" },
    other: { text: "?", color: "#6b7280" },
  };
  const b = map[kind];
  return (
    <span
      className="inline-block text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
      style={{ background: `${b.color}22`, color: b.color }}
    >
      {b.text}
    </span>
  );
}

export default function MarketingSourceTable({ sources, funnels, rejection }: Props) {
  const t = useT();
  const [sortKey, setSortKey] = useState<SortKey>("leads");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [openRow, setOpenRow] = useState<string | null>(null);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setDir("desc");
    }
  };

  const sorted = [...sources].sort((a, b) => {
    const get = (r: SourceRow) => {
      switch (sortKey) {
        case "leads":
          return r.leads;
        case "converted":
          return r.converted;
        case "conv_rate":
          return r.conv_rate;
        case "revenue":
          return Number(r.revenue);
        case "avg_check":
          return Number(r.avg_check);
        case "delta_pp":
          return r.delta_pp;
      }
    };
    const av = get(a);
    const bv = get(b);
    return dir === "asc" ? av - bv : bv - av;
  });

  if (sources.length === 0) {
    return (
      <div className="nf-card p-8 text-center text-[13.5px] text-muted">
        {t("marketing.no_sources")}
      </div>
    );
  }

  const funnelByName = new Map(funnels.map((f) => [f.source_name, f]));
  const rejectionByName = new Map(rejection.map((r) => [r.source_name, r]));

  return (
    <div className="nf-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="text-left px-4 py-3 font-semibold">
                {t("marketing.table.source")}
              </th>
              {(
                [
                  ["leads", t("marketing.table.leads")],
                  ["converted", t("marketing.table.converted")],
                  ["conv_rate", t("marketing.table.conv")],
                  ["revenue", t("marketing.table.revenue")],
                  ["avg_check", t("marketing.table.avg_check")],
                  ["delta_pp", t("marketing.table.delta")],
                ] as [SortKey, string][]
              ).map(([k, label]) => (
                <th
                  key={k}
                  className="text-right px-3 py-3 font-semibold whitespace-nowrap select-none cursor-pointer hover:text-[color:var(--accent)]"
                  onClick={() => toggleSort(k)}
                >
                  {label} {sortIcon(sortKey === k, dir)}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const key = s.source_name;
              const isOpen = openRow === key;
              const delta = s.delta_pp;
              const deltaColor = delta > 0 ? "#16a34a" : delta < 0 ? "#dc2626" : "var(--muted)";
              return (
                <>
                  <tr
                    key={key}
                    className="border-t border-[color:var(--faint)] hover:bg-[color:var(--faint)] cursor-pointer transition"
                    onClick={() => setOpenRow(isOpen ? null : key)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {kindBadge(s.kind)}
                        <span className="font-medium truncate">{s.source_name}</span>
                      </div>
                    </td>
                    <td className="text-right px-3 py-3 tabular-nums">{s.leads}</td>
                    <td className="text-right px-3 py-3 tabular-nums">{s.converted}</td>
                    <td
                      className="text-right px-3 py-3 tabular-nums font-semibold"
                      style={{ color: s.conv_rate >= 5 ? "var(--accent)" : undefined }}
                    >
                      {s.conv_rate}%
                    </td>
                    <td className="text-right px-3 py-3 tabular-nums">{formatUZS(s.revenue)}</td>
                    <td className="text-right px-3 py-3 tabular-nums text-muted">
                      {Number(s.avg_check) > 0 ? formatUZS(s.avg_check) : "—"}
                    </td>
                    <td
                      className="text-right px-3 py-3 tabular-nums font-semibold"
                      style={{ color: deltaColor }}
                    >
                      {delta > 0 ? "+" : ""}
                      {delta.toFixed(1)}
                    </td>
                    <td className="text-center pr-3 text-muted">
                      {isOpen ? "▾" : "▸"}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${key}-detail`}>
                      <td colSpan={8} style={{ background: "var(--faint)" }} className="px-6 py-5">
                        <MarketingSourceDetail
                          source={s}
                          funnel={funnelByName.get(s.source_name)}
                          rejection={rejectionByName.get(s.source_name)}
                        />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
