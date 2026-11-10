import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { formatUZS } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { monthRange, periodTitle, type MonthChoice } from "../../lib/period";
import MonthPicker from "../MonthPicker";
import { MultiSelectPopover } from "../MultiSelectPopover";
import { Chip } from "../ui";
import OperatorSalesModal, { type SalesWindow } from "./OperatorSalesModal";

const COLLAPSED_ROWS = 10;

type Quick = "today" | "yesterday" | "week";

interface Row {
  operator_id: number;
  operator_name: string;
  total: number | string;
  count?: number | string;
}

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Always explicit dates — the same window feeds the rating and the sales list. */
function windowFor(quick: Quick | null, choice: MonthChoice): SalesWindow {
  const now = new Date();
  if (quick === "today") return { date_from: iso(now), date_to: iso(now) };
  if (quick === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return { date_from: iso(d), date_to: iso(d) };
  }
  if (quick === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { date_from: iso(d), date_to: iso(now) };
  }
  if (choice.kind === "all") return {};
  if (choice.kind === "specific") return monthRange(choice.year, choice.month);
  if (choice.kind === "range") return { date_from: choice.from, date_to: choice.to };
  return { date_from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), date_to: iso(now) };
}

/**
 * «Top operatorlar» on Tahlil: total sales over the block, its own period +
 * hamkor filters, and a click on an operator opens their sales.
 */
export default function TopOperatorsCard({ pageChoice }: { pageChoice: MonthChoice }) {
  const t = useT();
  const [choice, setChoice] = useState<MonthChoice>(pageChoice);
  const [quick, setQuick] = useState<Quick | null>(null);
  const [partnerIds, setPartnerIds] = useState<number[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState<{ id: number; name: string } | null>(null);

  // The page month picker still drives the block until the block's own
  // filter is touched again.
  useEffect(() => {
    setChoice(pageChoice);
    setQuick(null);
  }, [pageChoice]);

  const win = useMemo(() => windowFor(quick, choice), [quick, choice]);
  const periodLabel = quick
    ? t(`analytics.filter_${quick}`)
    : periodTitle("month", choice);

  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: "0" });
    if (win.date_from) p.set("date_from", win.date_from);
    if (win.date_to) p.set("date_to", win.date_to);
    for (const id of partnerIds) p.append("partner_ids", String(id));
    return p;
  }, [win, partnerIds]);

  const lb = useQuery<Row[]>({
    queryKey: ["lb-top-card", params.toString()],
    queryFn: () => api.get<Row[]>("/analytics/leaderboard/", { params }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  const partnersQ = useQuery<{ results: { id: number; name: string }[] }>({
    queryKey: ["partners-list"],
    queryFn: () => api.get("/channels/", { params: { limit: 200 } }).then((r) => r.data),
  });
  const partnerOptions = (partnersQ.data?.results ?? []).map((p) => ({ id: p.id, name: p.name }));

  const rows = lb.data ?? [];
  const totalSum = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  const totalCount = rows.reduce((a, r) => a + (Number(r.count) || 0), 0);
  const max = Math.max(1, ...rows.map((r) => Number(r.total)));
  const visible = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);
  const filtered = quick !== null || partnerIds.length > 0 || choice !== pageChoice;

  return (
    <section className="nf-card p-6 animate-nfFadeUp" style={{ animationDelay: "0.1s" }}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-[15px] font-semibold tracking-tight">
            {t("analytics.top_operators_title")}
          </div>
          <div className="text-[12.5px] text-muted mt-0.5">
            {t("analytics.top_operators_hint", { period: periodLabel })}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[20px] font-semibold tabular-nums tracking-tight">
            {formatUZS(totalSum)}
          </div>
          <div className="text-[12px] text-muted tabular-nums">
            {t("analytics.top_total", { count: totalCount, ops: rows.length })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div style={{ opacity: quick ? 0.55 : 1 }} className="transition">
          <MonthPicker
            value={choice}
            onChange={(v) => {
              setChoice(v);
              setQuick(null);
            }}
          />
        </div>
        {(["today", "yesterday", "week"] as Quick[]).map((k) => (
          <Chip key={k} active={quick === k} onClick={() => setQuick(quick === k ? null : k)}>
            {t(`analytics.filter_${k}`)}
          </Chip>
        ))}
        <MultiSelectPopover
          label={t("analytics.filter_partners")}
          options={partnerOptions}
          selectedIds={partnerIds}
          onChange={setPartnerIds}
        />
        {filtered && (
          <button
            type="button"
            className="nf-btn nf-btn--ghost"
            style={{ padding: "7px 12px" }}
            onClick={() => {
              setChoice(pageChoice);
              setQuick(null);
              setPartnerIds([]);
            }}
          >
            <RotateCcw className="w-3.5 h-3.5" /> {t("analytics.filter_reset")}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {rows.length === 0 && !lb.isLoading && (
          <div className="text-[13px] text-muted text-center py-6">{t("common.no_data")}</div>
        )}
        {visible.map((r, i) => {
          const total = Number(r.total);
          return (
            <button
              key={r.operator_id}
              type="button"
              onClick={() => setOpened({ id: r.operator_id, name: r.operator_name })}
              className="group grid items-center gap-3 text-left rounded-xl px-2 py-1.5 -mx-2 transition hover:bg-[color:var(--faint)]"
              style={{ gridTemplateColumns: "22px 1fr auto auto 14px" }}
            >
              <div
                className="grid place-items-center text-[11px] tabular-nums font-semibold"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 99,
                  background: i === 0 ? "var(--accent-grad)" : "var(--faint)",
                  color: i === 0 ? "#fff" : "var(--muted)",
                }}
              >
                {i + 1}
              </div>
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium truncate mb-1">{r.operator_name}</div>
                <div className="h-[5px] rounded-full overflow-hidden" style={{ background: "var(--faint)" }}>
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-nf"
                    style={{ width: `${(total / max) * 100}%`, background: "var(--accent-grad)" }}
                  />
                </div>
              </div>
              <div className="text-[12px] text-muted tabular-nums shrink-0">
                {t("analytics.top_sales_count", { n: Number(r.count ?? 0) })}
              </div>
              <div className="text-[13px] tabular-nums font-semibold shrink-0 text-right" style={{ minWidth: 130 }}>
                {formatUZS(total)}
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-muted opacity-0 group-hover:opacity-100 transition" />
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-4 text-[12px] text-muted">
        <span>{rows.length > 0 ? t("analytics.top_click_hint") : ""}</span>
        {rows.length > COLLAPSED_ROWS && (
          <button type="button" className="font-medium hover:text-text transition" onClick={() => setShowAll((v) => !v)}>
            {showAll ? t("analytics.top_show_less") : t("analytics.top_show_all", { n: rows.length })}
          </button>
        )}
      </div>

      <OperatorSalesModal
        operator={opened}
        window={win}
        partnerIds={partnerIds}
        periodLabel={periodLabel}
        onClose={() => setOpened(null)}
      />
    </section>
  );
}
