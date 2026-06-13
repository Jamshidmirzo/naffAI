export const formatUZS = (value: number | string | null | undefined): string => {
  if (value == null || value === "") return "0 сум";
  const num = typeof value === "string" ? Number(value) : value;
  if (!isFinite(num)) return "0 сум";
  return Math.round(num).toLocaleString("ru-RU").replace(/,/g, " ") + " сум";
};

export const formatNumber = (value: number | string | null | undefined): string => {
  if (value == null) return "0";
  return Number(value).toLocaleString("ru-RU").replace(/,/g, " ");
};

export const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};
