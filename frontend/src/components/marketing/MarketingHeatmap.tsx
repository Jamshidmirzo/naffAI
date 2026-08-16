import { useState } from "react";
import { useT } from "../../lib/i18n";
import { Select } from "../Select";
import type { TimePatternSource } from "./types";

interface Props {
  sources: TimePatternSource[];
}

type Mode = "leads" | "sales";

function cellColor(v: number, max: number, mode: Mode) {
  if (v === 0 || max === 0) return "var(--faint)";
  const t = Math.min(1, v / max);
  // sales = orange scale (accent), leads = blue-gray scale
  if (mode === "sales") {
    const alpha = 0.15 + t * 0.75;
    return `rgba(242, 86, 11, ${alpha.toFixed(2)})`;
  }
  const alpha = 0.15 + t * 0.75;
  return `rgba(59, 130, 246, ${alpha.toFixed(2)})`;
}

export default function MarketingHeatmap({ sources }: Props) {
  const t = useT();
  const [source, setSource] = useState<string>(sources[0]?.source_name || "");
  const [mode, setMode] = useState<Mode>("leads");

  const current = sources.find((s) => s.source_name === source) || sources[0];
  if (!current) {
    return (
      <div className="nf-card p-8 text-center text-[13.5px] text-muted">
        {t("common.no_data")}
      </div>
    );
  }

  const values = current.hours.map((h) => (mode === "leads" ? h.leads : h.sales));
  const max = Math.max(1, ...values);

  return (
    <div className="nf-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-[15px] font-semibold tracking-tight">
            {t("marketing.heatmap.title")}
          </div>
          <div className="text-[12px] text-muted mt-0.5">
            {t("marketing.heatmap.hint")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select<string>
            className="min-w-[180px]"
            value={source}
            onChange={(v) => setSource(v)}
            options={sources.map((s) => ({
              value: s.source_name,
              label: s.source_name,
            }))}
            ariaLabel="Источник"
            searchable={sources.length > 8}
          />
          <div className="nf-tabs">
            <button
              type="button"
              onClick={() => setMode("leads")}
              className={`nf-tab ${mode === "leads" ? "nf-tab--active" : ""}`}
            >
              {t("marketing.heatmap.leads")}
            </button>
            <button
              type="button"
              onClick={() => setMode("sales")}
              className={`nf-tab ${mode === "sales" ? "nf-tab--active" : ""}`}
            >
              {t("marketing.heatmap.sales")}
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: `48px repeat(24, minmax(24px, 1fr))` }}>
          <div />
          {current.hours.map((h) => (
            <div key={h.hour} className="text-center text-[10px] text-muted tabular-nums">
              {h.hour}
            </div>
          ))}
          <div className="text-[11px] text-muted">{mode === "leads" ? t("marketing.heatmap.leads") : t("marketing.heatmap.sales")}</div>
          {current.hours.map((h) => {
            const v = mode === "leads" ? h.leads : h.sales;
            return (
              <div
                key={h.hour}
                className="rounded flex items-center justify-center text-[10px] tabular-nums"
                title={`${h.hour}:00 — ${v}`}
                style={{
                  height: 28,
                  background: cellColor(v, max, mode),
                  color: v > max * 0.5 ? "#fff" : "var(--muted)",
                }}
              >
                {v > 0 ? v : ""}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 text-[11px] text-muted">
        {t("marketing.heatmap.legend")}: 0 → {max}
      </div>
    </div>
  );
}
