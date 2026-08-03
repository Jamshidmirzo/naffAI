import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shuffle, Users, X } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { type Lead } from "../lib/leads";
import { Button, Checkbox, Chip, Modal, StatusBadge, toast } from "../components/ui";
import { Paginator } from "../components/Paginator";
import { usePageHeader } from "../store/page";

interface OrphanResponse {
  results: Lead[];
  count: number;
  counts_by_source: Record<string, number>;
  counts_by_status: Record<string, number>;
  next: string | null;
  previous: string | null;
}

interface Operator {
  id: number;
  full_name: string;
  status: string;
}

interface SheetSource {
  id: number;
  name: string;
  active: boolean;
}

const PAGE_SIZE = 50;

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function OrphanLeads() {
  usePageHeader(
    { title: "Свободные лиды", subtitle: "Пул без оператора — раздайте вручную" },
    ["orphan-leads"],
  );

  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const sheetSourceId = searchParams.get("sheet_source")
    ? Number(searchParams.get("sheet_source"))
    : null;
  const statusFilter = searchParams.get("status") || "";
  const page = Number(searchParams.get("page")) || 1;

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);

  const setFilter = (key: string, value: string | number | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
    if (key !== "page") next.delete("page");
    setSearchParams(next);
  };

  const sheetSourcesQ = useQuery({
    queryKey: ["sheet-sources"],
    queryFn: async (): Promise<SheetSource[]> => {
      const { data } = await api.get<{ results?: SheetSource[] } | SheetSource[]>(
        "/sheet-sources/",
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const operatorsQ = useQuery({
    queryKey: ["operators-active"],
    queryFn: async (): Promise<Operator[]> => {
      const { data } = await api.get<{ results?: Operator[] } | Operator[]>(
        "/operators/?include_inactive=0",
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const orphansQ = useQuery({
    queryKey: ["orphan-leads", sheetSourceId, statusFilter, page],
    queryFn: async (): Promise<OrphanResponse> => {
      const qp = new URLSearchParams();
      if (sheetSourceId) qp.set("sheet_source", String(sheetSourceId));
      if (statusFilter) qp.set("status", statusFilter);
      qp.set("limit", String(PAGE_SIZE));
      qp.set("offset", String((page - 1) * PAGE_SIZE));
      const { data } = await api.get<OrphanResponse>(`/leads/orphans/?${qp.toString()}`);
      return data;
    },
    refetchInterval: 60_000,
  });

  const rows = orphansQ.data?.results || [];
  const totalCount = orphansQ.data?.count || 0;
  const countsBySource = orphansQ.data?.counts_by_source || {};

  useEffect(() => {
    setPicked(new Set());
  }, [page, sheetSourceId, statusFilter]);

  const togglePick = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (picked.size === rows.length) setPicked(new Set());
    else setPicked(new Set(rows.map((r) => r.id)));
  };

  const bulkMut = useMutation({
    mutationFn: (payload: { lead_ids: number[]; operator_id?: number; mode?: string }) =>
      api.post<{ total: number; assigned: Record<string, number> }>(
        "/leads/bulk-reassign/",
        payload,
      ),
    onSuccess: (r) => {
      const total = r.data.total;
      setPicked(new Set());
      setAssignOpen(false);
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(`Раздано: ${total}`);
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const distributeEvenly = () => {
    if (picked.size === 0) return;
    bulkMut.mutate({ lead_ids: Array.from(picked), mode: "round_robin" });
  };

  const sourceChips = useMemo(() => sheetSourcesQ.data ?? [], [sheetSourcesQ.data]);

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Топ-бар: метрики */}
      <section className="nf-card p-5 animate-nfFadeUp">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
              Всего сирот
            </div>
            <div className="text-[22px] font-semibold tabular-nums mt-0.5">
              {totalCount}
            </div>
          </div>
          {Object.entries(countsBySource).length > 0 && (
            <div className="flex-1 min-w-[240px]">
              <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
                По источникам
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[12.5px]">
                {Object.entries(countsBySource).map(([name, n]) => (
                  <span key={name} className="text-muted">
                    {name}{" "}
                    <span className="text-text tabular-nums font-medium">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Фильтры + toolbar */}
      {sourceChips.length > 0 && (
        <section className="flex flex-wrap gap-2 animate-nfFadeUp">
          <Chip
            active={sheetSourceId === null}
            onClick={() => setFilter("sheet_source", null)}
          >
            Все источники
          </Chip>
          {sourceChips.map((s) => (
            <Chip
              key={s.id}
              active={sheetSourceId === s.id}
              onClick={() => setFilter("sheet_source", s.id)}
            >
              {s.name}
            </Chip>
          ))}
        </section>
      )}

      <section className="flex flex-wrap items-center gap-3 animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {picked.size > 0 ? (
            <span className="tabular-nums">
              Выбрано: {picked.size} из {rows.length}
            </span>
          ) : (
            <span>
              Всего:{" "}
              <span className="text-text tabular-nums">{totalCount}</span>
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            disabled={picked.size === 0 || bulkMut.isPending}
            onClick={distributeEvenly}
            variant="secondary"
          >
            <Shuffle className="w-3.5 h-3.5" /> Раздать поровну
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() => setAssignOpen(true)}
          >
            <Users className="w-3.5 h-3.5" /> Назначить оператору…
          </Button>
          {picked.size > 0 && (
            <button
              className="nf-btn nf-btn--ghost"
              style={{ padding: "9px 14px" }}
              onClick={() => setPicked(new Set())}
            >
              <X className="w-3.5 h-3.5" /> Снять выбор
            </button>
          )}
        </div>
      </section>

      {/* Таблица */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col items-center"
          style={{ gridTemplateColumns: "38px 1.3fr 1fr .8fr .8fr .8fr" }}
        >
          <div>
            <Checkbox
              checked={rows.length > 0 && picked.size === rows.length}
              onChange={toggleAll}
              aria-label="Выбрать все"
            />
          </div>
          <div>Лид</div>
          <div>Источник</div>
          <div>Статус</div>
          <div>Товар</div>
          <div className="text-right">Создан</div>
        </div>

        {orphansQ.isLoading ? (
          <div className="text-center text-muted py-16 text-[13px]">Загрузка…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-16 text-[13px]">
            Свободных лидов нет.
          </div>
        ) : (
          <div>
            {rows.map((lead, i) => {
              const isPicked = picked.has(lead.id);
              return (
                <div
                  key={lead.id}
                  onClick={() => togglePick(lead.id)}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "38px 1.3fr 1fr .8fr .8fr .8fr",
                    animationDelay: `${0.02 + i * 0.03}s`,
                    background: isPicked ? "var(--faint)" : undefined,
                  }}
                >
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isPicked}
                      onChange={() => togglePick(lead.id)}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {lead.full_name || <span className="text-muted">—</span>}
                    </div>
                    <div className="text-[12px] text-muted truncate">
                      {lead.phone || (
                        <span style={{ color: "var(--danger)" }}>
                          {lead.phone_raw || "нет телефона"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-muted truncate">
                    {lead.sheet_source_name || "—"}
                  </div>
                  <div>
                    <StatusBadge tone="neutral">{lead.status}</StatusBadge>
                  </div>
                  <div className="truncate text-[12.5px]">
                    {lead.product_hint || (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                  <div className="text-right text-muted tabular-nums text-[12.5px]">
                    {fmtDateTime(lead.created_at)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="flex justify-center">
        <Paginator
          page={page}
          total={totalCount}
          pageSize={PAGE_SIZE}
          onChange={(p) => setFilter("page", p > 1 ? p : null)}
        />
      </div>

      <AssignModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        pickedIds={Array.from(picked)}
        operators={operatorsQ.data || []}
        onSubmit={(operatorId) =>
          bulkMut.mutate({
            lead_ids: Array.from(picked),
            operator_id: operatorId,
          })
        }
        submitting={bulkMut.isPending}
      />
    </div>
  );
}

function AssignModal({
  open,
  onClose,
  pickedIds,
  operators,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  pickedIds: number[];
  operators: Operator[];
  onSubmit: (operatorId: number) => void;
  submitting: boolean;
}) {
  const [opId, setOpId] = useState<string>("");

  useEffect(() => {
    if (open) setOpId(operators[0]?.id ? String(operators[0].id) : "");
  }, [open, operators]);

  return (
    <Modal open={open} onClose={onClose} width={460}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          Назначить оператору · {pickedIds.length}
        </div>
        <p className="text-[13px] text-muted mt-1">
          Все выделенные лиды уйдут выбранному оператору. История назначений
          сохраняется в аудит-логе.
        </p>
        <div className="mt-6 flex flex-col gap-4">
          <div>
            <div className="nf-col mb-1.5">Оператор</div>
            <select
              className="nf-input"
              value={opId}
              onChange={(e) => setOpId(e.target.value)}
            >
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.full_name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-7 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => opId && onSubmit(Number(opId))}
            disabled={submitting || !opId}
          >
            {submitting ? "Сохраняем…" : "Назначить"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
