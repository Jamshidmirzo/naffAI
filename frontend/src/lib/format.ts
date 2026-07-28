import { useLang, type Lang } from "../store/lang";

const LOCALE_MAP: Record<Lang, string> = {
  ru: "ru-RU",
  uz: "uz-UZ",
};

const CURRENCY_LABEL: Record<Lang, string> = {
  ru: "сум",
  uz: "so‘m",
};

function activeLang(): Lang {
  return useLang.getState().lang;
}

function localeFor(lang?: Lang): string {
  return LOCALE_MAP[lang ?? activeLang()];
}

export const formatUZS = (
  value: number | string | null | undefined,
  lang?: Lang,
): string => {
  const label = CURRENCY_LABEL[lang ?? activeLang()];
  if (value == null || value === "") return `0 ${label}`;
  const num = typeof value === "string" ? Number(value) : value;
  if (!isFinite(num)) return `0 ${label}`;
  return Math.round(num).toLocaleString(localeFor(lang)).replace(/,/g, " ") + ` ${label}`;
};

export const formatNumber = (
  value: number | string | null | undefined,
  lang?: Lang,
): string => {
  if (value == null) return "0";
  return Number(value).toLocaleString(localeFor(lang)).replace(/,/g, " ");
};

export const formatDate = (
  iso: string | null | undefined,
  lang?: Lang,
): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  const loc = localeFor(lang);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    return d.toLocaleDateString(loc, { dateStyle: "short" });
  }
  return d.toLocaleString(loc, { dateStyle: "short", timeStyle: "short" });
};

export const formatDateTime = (
  iso: string | null | undefined,
  lang?: Lang,
): string => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(localeFor(lang), {
    dateStyle: "short",
    timeStyle: "short",
  });
};

export const formatMonthLong = (
  iso: string | Date | null | undefined,
  lang?: Lang,
): string => {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleDateString(localeFor(lang), { month: "long", year: "numeric" });
};

export const toDateInputValue = (iso: string | Date | null | undefined): string => {
  if (!iso) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};
