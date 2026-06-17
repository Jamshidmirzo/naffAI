import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, Filter, Plus, RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatUZS } from "../lib/format";
import { MultiSelectPopover } from "../components/MultiSelectPopover";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const DEFAULT_LIMIT = 50;

type Paginated<T> = {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
};

type Option = { id: number; name: string };
type OperatorOption = { id: number; full_name: string };

function paramsToObject(sp: URLSearchParams): Record<string, string | string[]> {
  const obj: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    obj[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return obj;
}

export default function Sales() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [downloading, setDownloading] = useState(false);

  // The single source of truth for filters + pagination is the URL.
  // Reading helpers below normalize that into typed local values; every
  // mutation goes through `update()` which patches the searchParams.

  const limit = Number(searchParams.get("limit") || DEFAULT_LIMIT);
  const offset = Number(searchParams.get("offset") || 0);
  const search = searchParams.get("search") || "";
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo = searchParams.get("date_to") || "";
  const statusVal = searchParams.get("status") || "";
  const partnerIds = searchParams.getAll("partner_ids").map(Number).filter(Boolean);
  const operatorIds = searchParams.getAll("operator_ids").map(Number).filter(Boolean);

  // Filters panel is open by default if any filter (other than pagination)
  // is active — so the user instantly sees what's narrowing their results.
  const anyFilterActive = useMemo(
    () =>
      Boolean(
        search ||
          dateFrom ||
          dateTo ||
          statusVal ||
          partnerIds.length ||
          operatorIds.length,
      ),
    [search, dateFrom, dateTo, statusVal, partnerIds.length, operatorIds.length],
  );
  const [filtersOpen, setFiltersOpen] = useState(anyFilterActive);

  // Always ensure limit is present in the URL so the React Query key is
  // stable across reloads and the pagination component has a number to
  // diff against. Offset stays implicit at 0 until the user paginates.
  if (!searchParams.has("limit")) {
    const next = new URLSearchParams(searchParams);
    next.set("limit", String(DEFAULT_LIMIT));
    setSearchParams(next, { replace: true });
  }

  /** Mutate URL state. Resets offset to 0 unless `keepOffset` is true. */
  const update = (
    patch: Record<string, string | string[] | null>,
    opts?: { keepOffset?: boolean },
  ) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      if (Array.isArray(value)) {
        value.forEach((v) => next.append(key, String(v)));
      } else {
        next.set(key, String(value));
      }
    }
    if (!opts?.keepOffset) next.delete("offset");
    if (!next.has("limit")) next.set("limit", String(DEFAULT_LIMIT));
    setSearchParams(next);
  };

  const resetFilters = () => {
    setSearchParams(new URLSearchParams({ limit: String(limit) }));
  };

  // --- Data ---------------------------------------------------------------
  const queryKey = useMemo(
    () => ["sales", paramsToObject(searchParams)],
    // `searchParams` identity changes whenever the URL changes — using
    // its string form keeps React Query's key stable & comparable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams.toString()],
  );

  const sales = useQuery<Paginated<any>>({
    queryKey,
    queryFn: () =>
      // Pass the live URLSearchParams instance straight to axios so
      // repeating keys (?partner_ids=1&partner_ids=2) survive without
      // a custom paramsSerializer.
      api.get("/sales/", { params: searchParams }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  const partnersQ = useQuery<Paginated<Option>>({
    queryKey: ["partners-list"],
    queryFn: () => api.get("/channels/", { params: { limit: 200 } }).then((r) => r.data),
  });
  const operatorsQ = useQuery<Paginated<OperatorOption>>({
    queryKey: ["operators-list"],
    queryFn: () => api.get("/operators/", { params: { limit: 200 } }).then((r) => r.data),
  });

  const partnerOptions = useMemo<Option[]>(
    () => (partnersQ.data?.results || []).map((p) => ({ id: p.id, name: p.name })),
    [partnersQ.data],
  );
  const operatorOptions = useMemo<Option[]>(
    () =>
      (operatorsQ.data?.results || []).map((o) => ({ id: o.id, name: o.full_name })),
    [operatorsQ.data],
  );

  // --- Excel export -------------------------------------------------------
  const downloadExcel = async () => {
    setDownloading(true);
    try {
      const exportParams = new URLSearchParams(searchParams);
      // The export endpoint doesn't paginate — drop the pagination keys.
      exportParams.delete("limit");
      exportParams.delete("offset");
      const r = await api.get("/sales/export.xlsx", {
        params: exportParams,
        responseType: "blob",
      });
      const blob = new Blob([r.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "naffcrm-savdo.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      alert("Не удалось скачать Excel — попробуй ещё раз");
    } finally {
      setDownloading(false);
    }
  };

  // --- Pagination helpers -------------------------------------------------
  const total = sales.data?.count ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const goPrev = () =>
    update({ offset: String(Math.max(0, offset - limit)) }, { keepOffset: true });
  const goNext = () =>
    update({ offset: String(offset + limit) }, { keepOffset: true });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Продажи</h1>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <Filter className="w-4 h-4" />
            Фильтры
            {anyFilterActive && (
              <span className="ml-1 inline-flex items-center justify-center rounded-full bg-indigo-600 text-white text-xs w-5 h-5">
                {[
                  search ? 1 : 0,
                  dateFrom ? 1 : 0,
                  dateTo ? 1 : 0,
                  statusVal ? 1 : 0,
                  partnerIds.length ? 1 : 0,
                  operatorIds.length ? 1 : 0,
                ].reduce((a, b) => a + b, 0)}
              </span>
            )}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={downloadExcel}
            disabled={downloading}
          >
            <Download className="w-4 h-4" /> {downloading ? "Скачивание…" : "Excel"}
          </button>
          <Link to="/sales/new" className="btn-primary">
            <Plus className="w-4 h-4" /> Новая продажа
          </Link>
        </div>
      </div>

      {filtersOpen && (
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[16rem]">
              <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">
                Поиск
              </label>
              <input
                className="input"
                placeholder="IMEI, модель, оператор…"
                value={search}
                onChange={(e) => update({ search: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">
                Дата от
              </label>
              <input
                type="date"
                className="input"
                value={dateFrom}
                onChange={(e) => update({ date_from: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">
                Дата до
              </label>
              <input
                type="date"
                className="input"
                value={dateTo}
                onChange={(e) => update({ date_to: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">
                Статус
              </label>
              <select
                className="input"
                value={statusVal || ""}
                onChange={(e) => update({ status: e.target.value || null })}
              >
                <option value="">Все</option>
                <option value="pending">Ожидает</option>
                <option value="confirmed">Подтверждено</option>
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <MultiSelectPopover
              label="Партнёры"
              options={partnerOptions}
              selectedIds={partnerIds}
              onChange={(ids) => update({ partner_ids: ids.map(String) })}
            />
            <MultiSelectPopover
              label="Операторы"
              options={operatorOptions}
              selectedIds={operatorIds}
              onChange={(ids) => update({ operator_ids: ids.map(String) })}
            />
            {anyFilterActive && (
              <button type="button" className="btn-ghost" onClick={resetFilters}>
                <RotateCcw className="w-4 h-4" /> Сбросить
              </button>
            )}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-gray-600 dark:text-slate-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Дата</th>
              <th className="px-4 py-2 text-left">IMEI</th>
              <th className="px-4 py-2 text-left">Модель</th>
              <th className="px-4 py-2 text-left">Оператор</th>
              <th className="px-4 py-2 text-left">Партнёр</th>
              <th className="px-4 py-2 text-right">Сумма</th>
              <th className="px-4 py-2 text-center">Статус</th>
            </tr>
          </thead>
          <tbody>
            {(sales.data?.results || []).map((s: any) => (
              <tr
                key={s.id}
                className="border-t border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/40 cursor-pointer"
                onClick={() => nav(`/sales/${s.id}`)}
              >
                <td className="px-4 py-2 text-gray-600 dark:text-slate-400">
                  {formatDate(s.sold_at)}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{s.imei}</td>
                <td className="px-4 py-2">{s.phone_model}</td>
                <td className="px-4 py-2">
                  {s.operator_name}
                  {s.operator_lines?.length > 1 && (
                    <span
                      className="ml-1 text-xs text-gray-400 dark:text-slate-500"
                      title={s.operator_lines
                        .map((l: any) => `${l.operator_name}: ${l.amount}`)
                        .join("\n")}
                    >
                      +{s.operator_lines.length - 1}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-gray-600 dark:text-slate-400">
                  {s.channel_name}
                  {s.partner_lines?.length > 1 && (
                    <span
                      className="ml-1 text-xs text-gray-400 dark:text-slate-500"
                      title={s.partner_lines
                        .map((l: any) => `${l.partner_name}: ${l.amount}`)
                        .join("\n")}
                    >
                      +{s.partner_lines.length - 1}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">{formatUZS(s.amount)}</td>
                <td className="px-4 py-2 text-center">
                  {s.is_returned ? (
                    <span className="badge bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300">
                      возврат
                    </span>
                  ) : s.status === "pending" ? (
                    <span className="badge bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
                      ожидает
                    </span>
                  ) : (
                    <span className="badge bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">
                      ОК
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sales.isLoading && (
          <div className="px-4 py-12 text-center text-gray-500 dark:text-slate-400 text-sm">
            Загрузка…
          </div>
        )}
        {!sales.isLoading && sales.data?.results?.length === 0 && (
          <div className="px-4 py-12 text-center text-gray-500 dark:text-slate-400 text-sm">
            Нет продаж
          </div>
        )}

        {/* Pagination footer — always shown when there's at least one row */}
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-slate-800 text-sm">
            <div className="flex items-center gap-2 text-gray-600 dark:text-slate-400">
              <span>На странице:</span>
              <select
                className="input py-1 px-2 w-auto"
                value={limit}
                onChange={(e) => update({ limit: e.target.value })}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="ml-2">
                {rangeStart}–{rangeEnd} из {total}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn-ghost"
                onClick={goPrev}
                disabled={!hasPrev}
              >
                <ChevronLeft className="w-4 h-4" /> Назад
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={goNext}
                disabled={!hasNext}
              >
                Вперёд <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
