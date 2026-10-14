import type { ReactNode } from "react";
import { useT2 } from "../i18n";
import { cx, fmtNum } from "./index";

/** Numbered pager: «1–50 из 214», Назад / 1 … 4 5 6 … 9 / Вперёд. */
export function Pager({ page, total, pageSize, onChange, left }: { page: number; total: number; pageSize: number; onChange: (p: number) => void; left?: ReactNode }) {
  const t = useT2();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= 0) return left ? <div className="row between wrap g8">{left}</div> : null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const nums: Array<number | "…"> = [];
  const add = (n: number) => {
    if (n < 1 || n > pages || nums.includes(n)) return;
    const last = nums[nums.length - 1];
    if (typeof last === "number" && n - last > 1) nums.push("…");
    nums.push(n);
  };
  [1, page - 1, page, page + 1, pages].sort((a, b) => a - b).forEach(add);
  return (
    <div className="row between wrap g8">
      <span>{left}</span>
      <nav className="row g8 wrap" aria-label={t("v2.pager.label")}>
        <span className="s c3">{t("v2.pager.shown", { from: fmtNum(from), to: fmtNum(to), total: fmtNum(total) })}</span>
        <button className="btn btn-sm" type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>{t("v2.pager.prev")}</button>
        {nums.map((n, i) =>
          n === "…" ? (
            <span key={`e${i}`} className="c3">…</span>
          ) : (
            <button
              key={n}
              className={cx("btn btn-sm btn-sq", n === page && "btn-pri")}
              type="button"
              aria-current={n === page ? "page" : undefined}
              onClick={() => n !== page && onChange(n)}
              style={{ width: "auto", minWidth: 30, padding: "0 8px" }}
            >
              <span className="num">{n}</span>
            </button>
          ),
        )}
        <button className="btn btn-sm" type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>{t("v2.pager.next")}</button>
      </nav>
    </div>
  );
}
