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
  // Imported / backdated sales typically carry no time component — drop
  // the trailing "00:00" so the column doesn't look noisy.
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    return d.toLocaleDateString("ru-RU", { dateStyle: "short" });
  }
  return d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};

export const toDateInputValue = (iso: string | Date | null | undefined): string => {
  if (!iso) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};
