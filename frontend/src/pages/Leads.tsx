/**
 * Admin lead list. Team lead / manager only.
 *
 * Highlights rows with `needs_review` or `phone_invalid`. Allows
 * reassigning a lead to a different operator inline.
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Users } from "lucide-react";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../lib/api-types";
import { api } from "../lib/api";
import {
  LEAD_STATUS_BADGE,
  LEAD_STATUS_LABEL,
  type Lead,
  type LeadStatus,
} from "../lib/leads";
import { Paginator } from "../components/Paginator";
import { formatDate } from "../lib/format";

type PagedLeads = { results: Lead[]; count?: number } | Lead[];

type Operator = { id: number; full_name: string; status: string };

type SheetSource = { id: number; name: string; gid: number; active: boolean };

const PAGE_SIZE = 50;

const STATUSES: Array<{ value: LeadStatus | ""; label: string }> = [
  { value: "", label: "Все" },
  { value: "new", label: "Новые" },
  { value: "assigned", label: "Назначены" },
  { value: "in_progress", label: "В работе" },
  { value: "callback_scheduled", label: "Callback" },
  { value: "no_answer", label: "Не берут" },
  { value: "won", label: "Продажи" },
  { value: "lost", label: "Потеряны" },
  { value: "needs_review", label: "Требуют проверки" },
  { value: "archived", label: "Архив" },
];

export default function Leads() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const status = (searchParams.get("status") as LeadStatus) || "";
  const needsReview = searchParams.get("needs_review") === "1";
  const phoneInvalid = searchParams.get("phone_invalid") === "1";
  const search = searchParams.get("search") || "";
  const sheetSourceId = searchParams.get("sheet_source") ? Number(searchParams.get("sheet_source")) : null;
  const page = Number(searchParams.get("page")) || 1;

  const [reassignFor, setReassignFor] = useState<Lead | null>(null);

  const setFilter = (key: string, value: string | boolean | number | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "" || value === false) {
      next.delete(key);
    } else if (typeof value === "boolean") {
      next.set(key, "1");
    } else {
      next.set(key, String(value));
    }
    if (key !== "page") {
      next.delete("page");
    }
    setSearchParams(next);
  };

  const sheetSources = useQuery({
    queryKey: ["sheet-sources"],
    queryFn: async (): Promise<SheetSource[]> => {
      const { data } = await api.get<{ results?: SheetSource[] } | SheetSource[]>(
        "/sheet-sources/"
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const leads = useQuery({
    queryKey: ["leads", status, needsReview, phoneInvalid, search, sheetSourceId, page],
    queryFn: async (): Promise<{ results: Lead[]; count: number }> => {
      const qp = new URLSearchParams();
      if (status) qp.set("status", status);
      if (needsReview) qp.set("needs_review", "1");
      if (phoneInvalid) qp.set("phone_invalid", "1");
      if (search) qp.set("search", search);
      if (sheetSourceId) qp.set("sheet_source", String(sheetSourceId));
      qp.set("page", String(page));
      qp.set("page_size", String(PAGE_SIZE));
      const { data } = await api.get<PagedLeads>(`/leads/?${qp.toString()}`);
      if (Array.isArray(data)) {
        return { results: data, count: data.length };
      }
      return { results: data.results || [], count: data.count || (data.results || []).length };
    },
    refetchInterval: 60_000,
  });

  const operators = useQuery({
    queryKey: ["operators-active"],
    queryFn: async (): Promise<Operator[]> => {
      const { data } = await api.get<{ results?: Operator[] } | Operator[]>(
        "/operators/?include_inactive=0"
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const rows = leads.data?.results || [];
  const totalCount = leads.data?.count || 0;
  const summary = useMemo(
    () => ({
      total: totalCount,
      review: rows.filter((r) => r.needs_review).length,
      invalid: rows.filter((r) => r.phone_invalid).length,
    }),
    [rows, totalCount]
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Лиды</h1>
          <div className="text-sm text-gray-500 dark:text-slate-400">
            Всего: {totalCount} · требуют проверки: {summary.review} · с плохим телефоном:{" "}
            {summary.invalid}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-slate-800">
        <button
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            sheetSourceId === null
              ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
          onClick={() => setFilter("sheet_source", null)}
        >
          Все ({summary.total})
        </button>
        {(sheetSources.data || []).map((s) => (
          <button
            key={s.id}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              sheetSourceId === s.id
                ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
            onClick={() => setFilter("sheet_source", s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>

      <div className="card p-4 flex flex-wrap gap-3">
        <input
          className="input max-w-xs"
          placeholder="Поиск: имя / телефон / модель"
          value={search}
          onChange={(e) => setFilter("search", e.target.value)}
        />
        <select
          className="input max-w-xs"
          value={status}
          onChange={(e) => setFilter("status", e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={needsReview}
            onChange={(e) => setFilter("needs_review", e.target.checked)}
          />
          Только требующие проверки
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={phoneInvalid}
            onChange={(e) => setFilter("phone_invalid", e.target.checked)}
          />
          Только с невалидным телефоном
        </label>
      </div>

      <div className="card overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-800/40 text-xs uppercase text-gray-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Клиент</th>
              <th className="text-left px-3 py-2">Телефон</th>
              <th className="text-left px-3 py-2">Товар</th>
              <th className="text-left px-3 py-2">Оператор</th>
              <th className="text-left px-3 py-2">Статус</th>
              <th className="text-left px-3 py-2">Создан</th>
              <th className="text-right px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {rows.map((lead) => (
              <tr
                key={lead.id}
                className={`hover:bg-gray-50/70 dark:hover:bg-slate-800/40 ${
                  lead.needs_review || lead.phone_invalid
                    ? "bg-amber-50/40 dark:bg-amber-500/5"
                    : ""
                }`}
              >
                <td className="px-3 py-2 font-medium">
                  <div className="flex items-center gap-1.5">
                    {lead.needs_review && (
                      <AlertTriangle
                        className="w-3.5 h-3.5 text-amber-500"
                        aria-label="Требует проверки"
                      />
                    )}
                    {lead.full_name || <span className="text-gray-400">—</span>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {lead.phone || (
                    <span className="text-rose-500 text-xs">{lead.phone_raw || "—"}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-slate-400">
                  {lead.product_hint || "—"}
                </td>
                <td className="px-3 py-2">
                  {lead.operator_name || <span className="text-gray-400">не назначен</span>}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${LEAD_STATUS_BADGE[lead.status]}`}
                  >
                    {LEAD_STATUS_LABEL[lead.status]}
                  </span>
                </td>
                <td className="px-3 py-2 text-gray-500 dark:text-slate-400">
                  {formatDate(lead.created_at)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    className="btn-ghost text-xs"
                    onClick={() => setReassignFor(lead)}
                  >
                    <Users className="w-3.5 h-3.5" /> Переназначить
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="text-center text-gray-500 py-6">
                  Лидов пока нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Paginator
        page={page}
        total={totalCount}
        pageSize={PAGE_SIZE}
        onChange={(p) => setFilter("page", p > 1 ? p : null)}
      />

      {reassignFor && (
        <ReassignModal
          lead={reassignFor}
          operators={operators.data || []}
          onClose={() => setReassignFor(null)}
          onDone={() => {
            setReassignFor(null);
            qc.invalidateQueries({ queryKey: ["leads"] });
          }}
        />
      )}
    </div>
  );
}

function ReassignModal({
  lead,
  operators,
  onClose,
  onDone,
}: {
  lead: Lead;
  operators: Operator[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [opId, setOpId] = useState<string>(String(lead.operator || operators[0]?.id || ""));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      if (!opId) throw new Error("Выберите оператора");
      await api.post(`/leads/${lead.id}/reassign/`, {
        operator_id: Number(opId),
        reason,
      });
    },
    onSuccess: onDone,
    onError: (err: unknown) => setError(apiErrorMessage(err)),
  });

  return (
    <Modal
      open={true}
      title={`Переназначить: ${lead.full_name || lead.phone}`}
      onClose={onClose}
    >
      <label className="label">Оператор</label>
      <select
        className="input"
        value={opId}
        onChange={(e) => setOpId(e.target.value)}
      >
        {operators.map((o) => (
          <option key={o.id} value={o.id}>
            {o.full_name}
          </option>
        ))}
      </select>
      <label className="label mt-3">Причина</label>
      <input
        className="input"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Например: alias «Sevara» → Sevara Karimova"
      />
      {error && <div className="text-sm text-rose-600 mt-2">{error}</div>}
      <div className="mt-4 flex gap-2 justify-end">
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn-primary"
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
        >
          {mut.isPending ? "Сохраняем…" : "Переназначить"}
        </button>
      </div>
    </Modal>
  );
}
