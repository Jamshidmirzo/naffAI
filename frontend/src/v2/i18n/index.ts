import { useLang, type Lang } from "../../store/lang";
import { translate } from "../../lib/i18n";

/**
 * v2 strings live in src/v2/i18n/<domain>.ts files, each
 * `export default { ru: {...}, uz: {...} }` with keys prefixed by domain
 * ("v2.nav.*", "v2.sales.*"…). Separate files so parallel work never edits
 * the same file. Unknown keys fall back to the main dictionary (lib/i18n.ts),
 * so existing keys like "common.save" work too.
 */
type Dict = { ru: Record<string, string>; uz?: Record<string, string> };

const modules = import.meta.glob<{ default: Dict }>("./*.ts", { eager: true });
const RU: Record<string, string> = {};
const UZ: Record<string, string> = {};
for (const [path, mod] of Object.entries(modules)) {
  if (path.endsWith("/index.ts")) continue;
  Object.assign(RU, mod.default.ru);
  Object.assign(UZ, mod.default.uz ?? {});
}

function fill(value: string, params?: Record<string, string | number>) {
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""));
}

export function t2(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const own = lang === "uz" ? UZ[key] ?? RU[key] : RU[key];
  if (own !== undefined) return fill(own, params);
  return translate(lang, key, params);
}

/** Translate hook for v2 pages: v2 dictionary first, then the main one. */
export function useT2() {
  const lang = useLang((s) => s.lang);
  return (key: string, params?: Record<string, string | number>) => t2(lang, key, params);
}
