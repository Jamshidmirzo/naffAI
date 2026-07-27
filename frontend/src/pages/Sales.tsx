import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, Filter, Plus, RotateCcw, Search } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatUZS } from "../lib/format";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import { Button, Chip, StatusBadge } from "../components/ui";
import { SalesFormModal } from "../components/sales/SalesFormModal";
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
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [downloading, setDownloading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

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
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5" /> Новая продажа
          </Button>
        </div>
      </section>

      <SalesFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={(newId) => {
          qc.invalidateQueries({ queryKey: ["sales"] });
          if (newId) nav(`/sales/${newId}`);
        }}
      />

      {filtersOpen && (
        <section className="nf-card p-5 flex flex-wrap gap-4 items-end animate-nfFadeUp">
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
              <select
                className="nf-input py-1.5 px-3 w-auto text-[13px]"
                value={limit}
                onChange={(e) => update({ limit: e.target.value })}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
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
