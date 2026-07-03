// Shared helpers for the dashboard/operator-detail period selector.
//
// The dashboard has two coexisting controls:
//   - a day|week|month "period" tab strip (current-relative windows)
//   - a "specific month" picker (Июнь 2026, Май 2026, …) that overrides
//     the period tabs. When a specific month is selected, we send
//     `date_from` / `date_to` to the backend (never `period`); the tabs
//     hide because they only make sense for the current month.
//
// This module is the single source of truth for both selectors so the
// two pages stay in lockstep.

export type Period = "day" | "week" | "month";

export type MonthChoice =
  // "current" means: use the ?period=... label; no date_from/date_to.
  | { kind: "current" }
  // "specific" means: pin a concrete calendar month. Ignores period tabs.
  | { kind: "specific"; year: number; month: number }; // month is 1..12

const RU_MONTH_NAMES = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

export const monthLabel = (year: number, month: number): string => {
  const name = RU_MONTH_NAMES[month - 1] ?? String(month);
  return `${name} ${year}`;
};

// Build a rolling list of past N months + the current month, newest first.
// Default N=6 covers "last half-year" which is the usual analysis horizon
// for the shop's lead.
export const recentMonths = (count = 6): { year: number; month: number }[] => {
  const now = new Date();
  const out: { year: number; month: number }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return out;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

// Convert a specific-month choice to an ISO datetime range that the
// backend selectors accept as `date_from` / `date_to`.
// Range is inclusive-inclusive on the day boundaries.
export const monthRange = (
  year: number,
  month: number,
): { date_from: string; date_to: string } => {
  const from = `${year}-${pad2(month)}-01T00:00:00`;
  // Last day of `month`: day 0 of the next month.
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad2(month)}-${pad2(lastDay)}T23:59:59`;
  return { date_from: from, date_to: to };
};

// Build the query params to pass to axios .get(..., { params }).
// - "current" → { period } (existing behaviour, unchanged)
// - "specific" → { date_from, date_to } (new)
// Extra params (e.g. `limit`) can be spread in on top by the caller.
export const buildPeriodParams = (
  period: Period,
  choice: MonthChoice,
): Record<string, string> => {
  if (choice.kind === "specific") {
    return monthRange(choice.year, choice.month);
  }
  return { period };
};

// Titles for KPI cards, hero copy, etc.
export const currentPeriodTitle: Record<Period, string> = {
  day: "Сегодня",
  week: "Эта неделя",
  month: "Этот месяц",
};

export const periodTitle = (period: Period, choice: MonthChoice): string => {
  if (choice.kind === "specific") return monthLabel(choice.year, choice.month);
  return currentPeriodTitle[period];
};
