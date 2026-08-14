import { formatUZS } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { FunnelRow, RejectionRow, SourceRow } from "./types";

interface Props {
  source: SourceRow;
  funnel?: FunnelRow;
  rejection?: RejectionRow;
}

function MiniFunnel({ funnel }: { funnel: FunnelRow }) {
  const stages: [string, keyof FunnelRow, keyof FunnelRow][] = [
    ["Новые", "new", "new_pct"],
    ["Назначены", "assigned", "assigned_pct"],
    ["В работе", "in_progress", "in_progress_pct"],
    ["Callback", "callback_scheduled", "callback_scheduled_pct"],
    ["Продажа", "won", "won_pct"],
    ["Потерян", "lost", "lost_pct"],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      {stages.map(([label, cnt, pct]) => {
        const c = funnel[cnt] as number;
        const p = funnel[pct] as number;
        return (
          <div key={label} className="grid gap-2 items-center" style={{ gridTemplateColumns: "80px 1fr 44px" }}>
            <div className="text-[11.5px] text-muted">{label}</div>
            <div className="h-[6px] rounded-full overflow-hidden" style={{ background: "var(--faint)" }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, p)}%`,
                  background: label === "Продажа" ? "var(--accent)" : label === "Потерян" ? "#dc2626" : "#6b7280",
                }}
              />
            </div>
            <div className="text-[11.5px] tabular-nums text-right">{c}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function MarketingSourceDetail({ source, funnel, rejection }: Props) {
  const t = useT();
  return (
    <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr_1fr]">
      {/* Funnel */}
      <div>
        <div className="text-[12px] uppercase tracking-wide text-muted mb-3">
          {t("marketing.detail.funnel")}
        </div>
        {funnel ? (
          <MiniFunnel funnel={funnel} />
        ) : (
          <div className="text-[13px] text-muted">{t("common.no_data")}</div>
        )}
        {source.avg_time_to_conv_hours != null && (
          <div className="mt-3 text-[12px] text-muted">
            {t("marketing.detail.avg_time")}: <span className="text-[color:var(--text)] font-semibold">
              {source.avg_time_to_conv_hours} ч
            </span>
          </div>
        )}
      </div>

      {/* Top products + operators */}
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">
            {t("marketing.detail.top_products")}
          </div>
          {source.top_products.length === 0 ? (
            <div className="text-[13px] text-muted">{t("common.no_data")}</div>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {source.top_products.map((p) => (
                <li key={p.name} className="flex justify-between">
                  <span className="truncate">{p.name}</span>
                  <span className="tabular-nums text-muted">{p.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">
            {t("marketing.detail.top_operators")}
          </div>
          {source.top_operators.length === 0 ? (
            <div className="text-[13px] text-muted">{t("common.no_data")}</div>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {source.top_operators.map((o) => (
                <li key={o.operator_id} className="flex justify-between gap-2">
                  <span className="truncate">{o.name}</span>
                  <span className="tabular-nums text-muted">{formatUZS(o.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Rejection reasons + AdSpend */}
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">
            {t("marketing.detail.rejection_reasons")}
          </div>
          {!rejection || rejection.reasons.length === 0 ? (
            <div className="text-[13px] text-muted">{t("common.no_data")}</div>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {rejection.reasons.map((r) => (
                <li key={r.text} className="flex justify-between gap-2">
                  <span className="truncate">{r.text}</span>
                  <span className="tabular-nums text-muted">
                    {r.count} <span className="text-[11px]">({r.pct}%)</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {Number(source.adspend.amount) > 0 && (
          <div>
            <div className="text-[12px] uppercase tracking-wide text-muted mb-2">
              {t("marketing.detail.adspend")}
            </div>
            <div className="text-[13px] grid gap-1">
              <div className="flex justify-between">
                <span className="text-muted">{t("marketing.detail.spend")}</span>
                <span className="tabular-nums font-semibold">{formatUZS(source.adspend.amount)}</span>
              </div>
              {source.adspend.cac && (
                <div className="flex justify-between">
                  <span className="text-muted">CAC</span>
                  <span className="tabular-nums font-semibold">{formatUZS(source.adspend.cac)}</span>
                </div>
              )}
              {source.adspend.roi_pct && (
                <div className="flex justify-between">
                  <span className="text-muted">ROI</span>
                  <span
                    className="tabular-nums font-semibold"
                    style={{
                      color: Number(source.adspend.roi_pct) >= 0 ? "#16a34a" : "#dc2626",
                    }}
                  >
                    {source.adspend.roi_pct}%
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
