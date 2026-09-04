import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, Filter, Plus, RotateCcw, Search } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatUZS } from "../lib/format";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import { Select } from "../components/Select";
import { Button, Chip, StatusBadge } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

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

type StatusFilter = "" | "returned" | "gift" | "regular";

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: "", label: "Все" },
  { key: "regular", label: "Продажи" },
  { key: "returned", label: "Возвраты" },
  { key: "gift", label: "Подарки" },
];

function _iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DATE_PRESETS: { key: string; label: string; range: () => { from: string; to: string } }[] = [
  {
    key: "today",
    label: "Сегодня",
    range: () => {
      const t = _iso(new Date());
      return { from: t, to: t };
    },
  },
  {
    key: "yesterday",
    label: "Вчера",
    range: () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const t = _iso(d);
      return { from: t, to: t };
    },
  },
  {
    key: "week",
    label: "7 дней",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 6);
      return { from: _iso(from), to: _iso(to) };
    },
  },
  {
    key: "this_month",
    label: "Этот месяц",
    range: () => {
      const now = new Date();
      return {
        from: _iso(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: _iso(now),
      };
    },
  },
  {
    key: "last_month",
    label: "Прошлый месяц",
    range: () => {
      const now = new Date();
      return {
        from: _iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: _iso(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    },
  },
];

type SalesSummary = {
  total_amount: string | number;
  total_count: number;
  by_operator: { operator_id: number; name: string; count: number; amount: string | number }[];
  by_model: { model: string; count: number; amount: string | number }[];
};

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
  const [filtersOpen, setFiltersOpen] = useState(false);

  const t = useT();
  usePageHeader({ title: t("sales.title"), subtitle: t("sales.subtitle") }, [t("sales.title")]);

  const limit = Number(searchParams.get("limit") || DEFAULT_LIMIT);
  const offset = Number(searchParams.get("offset") || 0);
  const search = searchParams.get("search") || "";
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo = searchParams.get("date_to") || "";
  const statusVal = (searchParams.get("status_filter") || "") as StatusFilter;
  const partnerIds = searchParams.getAll("partner_ids").map(Number).filter(Boolean);
  const operatorIds = searchParams.getAll("operator_ids").map(Number).filter(Boolean);

  const anyFilterActive = useMemo(
    () => Boolean(dateFrom || dateTo || partnerIds.length || operatorIds.length),
    [dateFrom, dateTo, partnerIds.length, operatorIds.length],
  );

  useEffect(() => {
    if (!searchParams.has("limit")) {
      const next = new URLSearchParams(searchParams);
      next.set("limit", String(DEFAULT_LIMIT));
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (
    patch: Record<string, string | string[] | null>,
    opts?: { keepOffset?: boolean },
  ) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      if (Array.isArray(value)) value.forEach((v) => next.append(key, String(v)));
      else next.set(key, String(value));
    }
    if (!opts?.keepOffset) next.delete("offset");
    if (!next.has("limit")) next.set("limit", String(DEFAULT_LIMIT));
    setSearchParams(next);
  };

  const resetFilters = () => {
    const next = new URLSearchParams();
    next.set("limit", String(limit));
    setSearchParams(next);
  };

  // Build actual API params — map status_filter -> is_returned/is_gift.
  const apiParams = useMemo(() => {
    const p = new URLSearchParams(searchParams);
    p.delete("status_filter");
    if (statusVal === "returned") p.set("is_returned", "true");
    if (statusVal === "gift") p.set("is_gift", "true");
    if (statusVal === "regular") p.set("is_returned", "false");
    return p;
  }, [searchParams, statusVal]);

  const queryKey = useMemo(
    () => ["sales", paramsToObject(apiParams)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiParams.toString()],
  );

  const sales = useQuery<Paginated<any>>({
    queryKey,
    queryFn: () => api.get("/sales/", { params: apiParams }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  // Сводка «кто сколько продал / что продавали / общая сумма» — те же
  // фильтры, что и таблица (кроме пагинации/поиска), только confirmed.
  const summaryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    for (const id of operatorIds) p.append("operator_ids", String(id));
    for (const id of partnerIds) p.append("partner_ids", String(id));
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, operatorIds.join(","), partnerIds.join(",")]);

  const summaryQ = useQuery<SalesSummary>({
    queryKey: ["sales-summary", summaryParams.toString()],
    queryFn: () =>
      api.get("/sales/summary/", { params: summaryParams }).then((r) => r.data),
    enabled: Boolean(dateFrom || dateTo),
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
    () => (operatorsQ.data?.results || []).map((o) => ({ id: o.id, name: o.full_name })),
    [operatorsQ.data],
  );

  const downloadExcel = async () => {
    setDownloading(true);
    try {
      const exportParams = new URLSearchParams(apiParams);
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
    } finally {
      setDownloading(false);
    }
  };

  const total = sales.data?.count ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const goPrev = () =>
    update({ offset: String(Math.max(0, offset - limit)) }, { keepOffset: true });
  const goNext = () =>
    update({ offset: String(offset + limit) }, { keepOffset: true });

  const rows = sales.data?.results || [];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* --- TOOLBAR --- */}
      <section className="flex flex-wrap items-center gap-3 animate-nfFadeUp">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search
            className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted"
            aria-hidden
          />
          <input
            className="nf-input pl-11"
            placeholder="Поиск по IMEI, модели, оператору…"
            value={search}
            onChange={(e) => update({ search: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {STATUS_TABS.map((t) => (
            <Chip
              key={t.key}
              active={statusVal === t.key}
              onClick={() => update({ status_filter: t.key || null })}
            >
              {t.label}
            </Chip>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="nf-btn nf-btn--ghost"
            style={{ padding: "9px 14px" }}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <Filter className="w-3.5 h-3.5" /> Фильтры
            {anyFilterActive && (
              <span
                className="ml-1 grid place-items-center text-[10px] font-bold text-white rounded-full"
                style={{ width: 16, height: 16, background: "var(--accent)" }}
              >
                {[
                  dateFrom ? 1 : 0,
                  dateTo ? 1 : 0,
                  partnerIds.length ? 1 : 0,
                  operatorIds.length ? 1 : 0,
                ].reduce((a, b) => a + b, 0)}
              </span>
            )}
          </button>
          <Button variant="secondary" onClick={downloadExcel} disabled={downloading}>
            <Download className="w-3.5 h-3.5" /> {downloading ? "…" : "Excel"}
          </Button>
          <Link to="/sales/new" className="nf-btn nf-btn--primary">
            <Plus className="w-3.5 h-3.5" /> Новая продажа
          </Link>
        </div>
      </section>

      {filtersOpen && (
        <section className="nf-card p-5 flex flex-wrap gap-4 items-end animate-nfFadeUp">
          <div className="w-full flex flex-wrap gap-2">
            {DATE_PRESETS.map((p) => (
              <Chip
                key={p.key}
                active={dateFrom === p.range().from && dateTo === p.range().to}
                onClick={() => {
                  const r = p.range();
                  update({ date_from: r.from, date_to: r.to });
                }}
              >
                {p.label}
              </Chip>
            ))}
          </div>
          <div>
            <div className="nf-col mb-1.5">Дата от</div>
            <input
              type="date"
              className="nf-input"
              value={dateFrom}
              onChange={(e) => update({ date_from: e.target.value })}
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">Дата до</div>
            <input
              type="date"
              className="nf-input"
              value={dateTo}
              onChange={(e) => update({ date_to: e.target.value })}
            />
          </div>
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
            <button type="button" className="nf-btn nf-btn--ghost" onClick={resetFilters}>
              <RotateCcw className="w-3.5 h-3.5" /> Сбросить
            </button>
          )}
        </section>
      )}

      {/* --- SUMMARY (по выбранному периоду) --- */}
      {(dateFrom || dateTo) && summaryQ.data && (
        <section className="nf-card p-5 animate-nfFadeUp">
          <div className="flex flex-wrap items-baseline gap-3 mb-3">
            <div className="text-[15px] font-semibold">Сводка за период</div>
            <div className="text-[13px] text-muted">
              {summaryQ.data.total_count} продаж ·{" "}
              <span className="font-semibold" style={{ color: "var(--accent)" }}>
                {formatUZS(summaryQ.data.total_amount)}
              </span>
            </div>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <div className="nf-col mb-2">Кто сколько продал</div>
              {summaryQ.data.by_operator.length === 0 ? (
                <div className="text-[13px] text-muted">Нет данных</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {summaryQ.data.by_operator.map((r) => (
                    <div
                      key={r.operator_id ?? r.name}
                      className="flex items-center justify-between text-[13px]"
                    >
                      <span className="truncate">{r.name}</span>
                      <span className="text-muted tabular-nums ml-3 shrink-0">
                        {r.count} шт · {formatUZS(r.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="nf-col mb-2">Что продавали</div>
              {summaryQ.data.by_model.length === 0 ? (
                <div className="text-[13px] text-muted">Нет данных</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {summaryQ.data.by_model.slice(0, 10).map((r) => (
                    <div
                      key={r.model}
                      className="flex items-center justify-between text-[13px]"
                    >
                      <span className="truncate">{r.model}</span>
                      <span className="text-muted tabular-nums ml-3 shrink-0">
                        {r.count} шт · {formatUZS(r.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* --- TABLE --- */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "90px 1.1fr .9fr 1.2fr .9fr .9fr .8fr" }}
        >
          <div>Время</div>
          <div>Оператор</div>
          <div>Канал</div>
          <div>Модель</div>
          <div>IMEI</div>
          <div className="text-right">Сумма</div>
          <div className="text-right">Статус</div>
        </div>

        {sales.isLoading ? (
          <div className="text-center text-muted py-16 text-[13px]">Загрузка…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-16 text-[13px]">
            Ничего не найдено — измените запрос или фильтры
          </div>
        ) : (
          <div>
            {rows.map((s: any, i: number) => (
              <div
                key={s.id}
                onClick={() => nav(`/sales/${s.id}`)}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "90px 1.1fr .9fr 1.2fr .9fr .9fr .8fr",
                  animationDelay: `${0.03 + i * 0.045}s`,
                }}
              >
                <div className="text-muted tabular-nums">{formatDate(s.sold_at)}</div>
                <div className="truncate font-medium">
                  {s.operator_name || "—"}
                  {s.operator_lines?.length > 1 && (
                    <span className="ml-1 text-[11px] text-muted">
                      +{s.operator_lines.length - 1}
                    </span>
                  )}
                </div>
                <div className="text-muted truncate">{s.channel_name || "—"}</div>
                <div className="truncate">{s.phone_model || "—"}</div>
                <div className="text-muted font-mono text-[12px] truncate">{s.imei || "—"}</div>
                <div className="text-right font-semibold tabular-nums">
                  {formatUZS(s.total_price ?? s.amount)}
                </div>
                <div className="text-right">
                  {s.is_returned ? (
                    <StatusBadge tone="danger">возврат</StatusBadge>
                  ) : s.status === "pending" ? (
                    <StatusBadge tone="hot">ожидает</StatusBadge>
                  ) : (
                    <StatusBadge>оплачено</StatusBadge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {total > 0 && (
          <div
            className="flex items-center justify-between px-6 py-4 text-[13px]"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <div className="flex items-center gap-2 text-muted">
              <span>На странице:</span>
              <Select<string>
                className="w-24"
                value={String(limit)}
                onChange={(v) => update({ limit: v })}
                options={PAGE_SIZE_OPTIONS.map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
                ariaLabel="Размер страницы"
              />
              <span className="ml-3 tabular-nums">
                {rangeStart}–{rangeEnd} из {total}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="nf-btn nf-btn--ghost"
                style={{ padding: "9px 14px" }}
                onClick={goPrev}
                disabled={!hasPrev}
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Назад
              </button>
              <button
                type="button"
                className="nf-btn nf-btn--ghost"
                style={{ padding: "9px 14px" }}
                onClick={goNext}
                disabled={!hasNext}
              >
                Вперёд <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
