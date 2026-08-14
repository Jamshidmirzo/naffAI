import { Check, Sparkles } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { InsightRecord } from "./types";

interface Props {
  insight: InsightRecord | null;
  onMarkDone: (index: number) => void;
  isMarkPending: boolean;
}

const PRIORITY_COLORS: Record<string, { fg: string; bg: string; label: string }> = {
  high: { fg: "#dc2626", bg: "rgba(220,38,38,0.1)", label: "HIGH" },
  medium: { fg: "#f59e0b", bg: "rgba(245,158,11,0.1)", label: "MED" },
  low: { fg: "#6b7280", bg: "rgba(107,114,128,0.1)", label: "LOW" },
};

const HIGHLIGHT_STYLE: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  win: { icon: "🏆", color: "#16a34a", bg: "rgba(22,163,74,0.06)", label: "WIN" },
  warn: { icon: "⚠", color: "#dc2626", bg: "rgba(220,38,38,0.06)", label: "WARN" },
  insight: { icon: "💡", color: "#3b82f6", bg: "rgba(59,130,246,0.06)", label: "INSIGHT" },
};

export default function MarketingRecommendations({
  insight,
  onMarkDone,
  isMarkPending,
}: Props) {
  const t = useT();

  if (!insight) {
    return (
      <div className="nf-card p-8 text-center animate-nfFadeUp">
        <Sparkles className="w-6 h-6 mx-auto text-muted mb-3" />
        <div className="text-[14px] text-muted mb-1">{t("marketing.ai.no_insight_title")}</div>
        <div className="text-[13px] text-muted">{t("marketing.ai.no_insight_hint")}</div>
      </div>
    );
  }

  const structured = insight.structured_output || {
    summary: insight.summary || "",
    highlights: [],
    recommendations: [],
    questions_for_owner: [],
  };
  const done = new Set((insight.actions_taken || []).map((a) => a.index));

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <div className="nf-card p-6 animate-nfFadeUp">
        <div className="text-[11px] uppercase tracking-wide text-muted mb-2">
          {t("marketing.ai.summary")}
        </div>
        <div className="text-[15px] leading-relaxed">{structured.summary || "—"}</div>
        <div className="mt-3 text-[11px] uppercase tracking-wide text-muted">
          {insight.model_version} · {insight.provider_used || ""} ·{" "}
          {new Date(insight.updated_at).toLocaleString("ru-RU")}
        </div>
      </div>

      {/* Highlights */}
      {structured.highlights.length > 0 && (
        <div className="grid gap-2 md:grid-cols-3">
          {structured.highlights.map((h, i) => {
            const s = HIGHLIGHT_STYLE[h.type] || HIGHLIGHT_STYLE.insight;
            return (
              <div
                key={i}
                className="nf-card p-4 animate-nfFadeUp"
                style={{ background: s.bg, borderColor: `${s.color}44`, animationDelay: `${0.03 + i * 0.03}s` }}
              >
                <div
                  className="text-[10px] font-bold uppercase tracking-wider mb-1.5"
                  style={{ color: s.color }}
                >
                  {s.icon} {s.label}
                </div>
                <div className="text-[13px] leading-relaxed">{h.text}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recommendations */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted mb-2 px-1">
          {t("marketing.ai.recommendations")} ({structured.recommendations.length})
        </div>
        <div className="flex flex-col gap-2">
          {structured.recommendations.length === 0 && (
            <div className="text-[13px] text-muted text-center py-6 nf-card">
              {t("marketing.ai.no_recs")}
            </div>
          )}
          {structured.recommendations.map((r, i) => {
            const p = PRIORITY_COLORS[r.priority] || PRIORITY_COLORS.low;
            const isDone = done.has(i);
            return (
              <div
                key={i}
                className="nf-card p-4 animate-nfFadeUp"
                style={{
                  animationDelay: `${0.05 + i * 0.05}s`,
                  opacity: isDone ? 0.55 : 1,
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="text-[10px] font-bold px-2 py-0.5 rounded"
                        style={{ background: p.bg, color: p.fg }}
                      >
                        {p.label}
                      </span>
                      {r.source && (
                        <span className="text-[11px] text-muted">
                          → <span className="font-medium">{r.source}</span>
                        </span>
                      )}
                      {typeof r.confidence === "number" && (
                        <span className="ml-auto text-[11px] text-muted tabular-nums">
                          {t("marketing.ai.confidence")}: {(r.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <div
                      className="text-[14px] font-semibold mb-2"
                      style={{ textDecoration: isDone ? "line-through" : undefined }}
                    >
                      {r.action}
                    </div>
                    {r.evidence && (
                      <div className="text-[12.5px] text-muted mb-2 leading-relaxed">
                        <span className="text-[10px] uppercase tracking-wide mr-1">
                          {t("marketing.ai.evidence")}:
                        </span>
                        {r.evidence}
                      </div>
                    )}
                    {r.expected_impact && (
                      <div
                        className="text-[12.5px] mt-1 px-2 py-1 inline-block rounded"
                        style={{ background: "var(--faint)", color: "var(--accent)" }}
                      >
                        📈 {r.expected_impact}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onMarkDone(i)}
                    disabled={isMarkPending}
                    title={isDone ? t("marketing.ai.undo") : t("marketing.ai.mark_done")}
                    className={`shrink-0 w-9 h-9 rounded-full grid place-items-center transition ${
                      isDone
                        ? "bg-[color:var(--accent)] text-white"
                        : "bg-[color:var(--faint)] text-[color:var(--muted)] hover:bg-[color:var(--accent)] hover:text-white"
                    }`}
                  >
                    <Check className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Questions for owner */}
      {structured.questions_for_owner && structured.questions_for_owner.length > 0 && (
        <div className="nf-card p-5 animate-nfFadeUp">
          <div className="text-[11px] uppercase tracking-wide text-muted mb-2">
            {t("marketing.ai.questions")}
          </div>
          <ul className="flex flex-col gap-2 text-[13.5px]">
            {structured.questions_for_owner.map((q, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted shrink-0">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
