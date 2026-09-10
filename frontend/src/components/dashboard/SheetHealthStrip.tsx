/**
 * Строчка health-карточек по активным SheetSource'ам — виджет на Dashboard.
 *
 * Данные о списке источников приходят из `useLeadHealth()` (endpoint
 * `/api/analytics/lead-health/`). Далее каждая карточка сама подтягивает
 * подробную статистику `/api/sheet-sources/{id}/stats/` через
 * `SheetSourceHealthCard` — переиспользуем компонент из /sheet-sources.
 *
 * Клик по шестерёнке в карточке ведёт на /sheet-sources — там менеджер
 * увидит wizard и полный список.
 */

import { useNavigate } from "react-router-dom";
import { SheetSourceHealthCard } from "../sheet-sources/SheetSourceHealthCard";
import { useT } from "../../lib/i18n";
import type { LeadHealthPayload } from "./HealthLeaks";

export function SheetHealthStrip({ data }: { data: LeadHealthPayload | undefined }) {
  const t = useT();
  const nav = useNavigate();

  const sources = data?.sheet_sources ?? [];
  if (sources.length === 0) {
    return (
      <div className="nf-card p-4 text-[12px] text-muted flex items-center justify-between gap-2">
        <span>{t("dash.health.no_sheet_sources")}</span>
        <button
          type="button"
          className="nf-btn nf-btn--ghost"
          style={{ padding: "5px 10px", fontSize: 11 }}
          onClick={() => nav("/sheet-sources")}
        >
          {t("dash.health.open_sheet_sources")}
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-[10px] grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {sources.slice(0, 4).map((s) => (
        <SheetSourceHealthCard
          key={s.id}
          sourceId={s.id}
          fallbackName={s.name}
          onConfigure={() => nav("/sheet-sources")}
        />
      ))}
    </div>
  );
}
