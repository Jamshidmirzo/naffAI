import { useT } from "../../lib/i18n";
import type { CohortRow } from "./types";

interface Props {
  cohorts: CohortRow[];
}

export default function MarketingCohortTable({ cohorts }: Props) {
  const t = useT();
  if (cohorts.length === 0) {
    return (
      <div className="nf-card p-8 text-center text-[13.5px] text-muted">
        {t("common.no_data")}
      </div>
    );
  }
  return (
    <div className="nf-card overflow-hidden">
      <div className="px-5 pt-4 pb-2">
        <div className="text-[15px] font-semibold tracking-tight">
          {t("marketing.cohort.title")}
        </div>
        <div className="text-[12px] text-muted mt-0.5">
          {t("marketing.cohort.hint")}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="text-left px-5 py-2 font-semibold">{t("marketing.cohort.week")}</th>
              <th className="text-right px-3 py-2 font-semibold">{t("marketing.cohort.leads")}</th>
              <th className="text-right px-3 py-2 font-semibold">{t("marketing.cohort.conv_7d")}</th>
              <th className="text-right px-3 py-2 font-semibold">{t("marketing.cohort.rate_7d")}</th>
              <th className="text-right px-3 py-2 font-semibold">{t("marketing.cohort.conv_30d")}</th>
              <th className="text-right px-5 py-2 font-semibold">{t("marketing.cohort.rate_30d")}</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.week} className="border-t border-[color:var(--faint)]">
                <td className="px-5 py-2 font-medium">
                  {c.week}
                  <div className="text-[11px] text-muted">{c.week_start}</div>
                </td>
                <td className="text-right px-3 py-2 tabular-nums">{c.leads_count}</td>
                <td className="text-right px-3 py-2 tabular-nums">{c.conv_7d}</td>
                <td
                  className="text-right px-3 py-2 tabular-nums font-semibold"
                  style={{ color: c.conv_rate_7d >= 5 ? "var(--accent)" : undefined }}
                >
                  {c.conv_rate_7d}%
                </td>
                <td className="text-right px-3 py-2 tabular-nums">{c.conv_30d}</td>
                <td
                  className="text-right px-5 py-2 tabular-nums font-semibold"
                  style={{ color: c.conv_rate_30d >= 10 ? "var(--accent)" : undefined }}
                >
                  {c.conv_rate_30d}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
