/** Shared pure helpers (no React), imported by index.tsx and sibling ui modules without cycles. */

/** cx — tiny className joiner. */
export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** Number formatting used across the design: «14 500 000». */
export function fmtNum(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  return Math.round(v).toLocaleString("ru-RU").replace(/ /g, " ");
}

/** «241,6 млн» style for big sums. */
export function fmtMln(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? Number(n) : n ?? 0;
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2).replace(".", ",") + " млрд";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + " млн";
  return fmtNum(v);
}
