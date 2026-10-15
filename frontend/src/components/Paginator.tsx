import { useT } from "../lib/i18n";

interface Props {
  page: number;
  total: number;
  pageSize: number;
  onChange: (newPage: number) => void;
}

export function Paginator({ page, total, pageSize, onChange }: Props) {
  const t = useT();
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between py-3 px-1 text-sm text-slate-600 dark:text-slate-400">
      <div>
        {t("paginator.shown", {
          from: (page - 1) * pageSize + 1,
          to: Math.min(page * pageSize, total),
          total,
        })}
      </div>
      <div className="flex items-center gap-1">
        <button
          className="btn-ghost px-3 py-1 text-xs"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          {t("paginator.prev")}
        </button>
        <span className="px-2 font-medium text-slate-800 dark:text-slate-200">
          {t("paginator.page_of", { page, pages: totalPages })}
        </span>
        <button
          className="btn-ghost px-3 py-1 text-xs"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          {t("paginator.next")}
        </button>
      </div>
    </div>
  );
}
