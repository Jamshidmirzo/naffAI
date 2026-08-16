import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { formatUZS, toDateInputValue } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Button, toast } from "../ui";
import { Select } from "../Select";
import DateInput from "../DateInput";
import type { AdSpendRow } from "./types";

interface SheetSource {
  id: number;
  name: string;
}

export default function AdSpendEditor() {
  const t = useT();
  const qc = useQueryClient();

  const list = useQuery<AdSpendRow[]>({
    queryKey: ["marketing", "adspend"],
    queryFn: async () => (await api.get<AdSpendRow[]>("/marketing/adspend/")).data,
  });

  const sourcesQ = useQuery<SheetSource[]>({
    queryKey: ["sheet-sources", "for-adspend"],
    queryFn: async () => (await api.get<SheetSource[]>("/sheet-sources/")).data,
  });

  // Draft new row
  const today = toDateInputValue(new Date());
  const [draft, setDraft] = useState({
    period_start: today,
    period_end: today,
    source_id: "",
    source_label: "",
    amount: "",
    note: "",
  });

  const createMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post("/marketing/adspend/", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "adspend"] });
      qc.invalidateQueries({ queryKey: ["marketing", "dashboard"] });
      toast.success(t("marketing.adspend.created"));
      setDraft({
        period_start: today,
        period_end: today,
        source_id: "",
        source_label: "",
        amount: "",
        note: "",
      });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || t("marketing.adspend.create_failed")),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/marketing/adspend/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "adspend"] });
      qc.invalidateQueries({ queryKey: ["marketing", "dashboard"] });
      toast.success(t("marketing.adspend.deleted"));
    },
  });

  const patchMut = useMutation({
    mutationFn: ({ id, fields }: { id: number; fields: Record<string, unknown> }) =>
      api.patch(`/marketing/adspend/${id}/`, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "adspend"] });
      qc.invalidateQueries({ queryKey: ["marketing", "dashboard"] });
    },
  });

  const submit = () => {
    if (!draft.amount || Number(draft.amount) <= 0) {
      toast.error(t("marketing.adspend.err_amount"));
      return;
    }
    if (!draft.source_id && !draft.source_label.trim()) {
      toast.error(t("marketing.adspend.err_source"));
      return;
    }
    createMut.mutate({
      period_start: draft.period_start,
      period_end: draft.period_end,
      source: draft.source_id ? Number(draft.source_id) : null,
      source_label: draft.source_label.trim(),
      amount: draft.amount,
      note: draft.note,
    });
  };

  const rows = list.data || [];
  const total = rows.reduce((a, r) => a + Number(r.amount), 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Draft row */}
      <div className="nf-card p-5">
        <div className="text-[15px] font-semibold tracking-tight mb-3">
          {t("marketing.adspend.add_title")}
        </div>
        <div className="grid gap-2 md:grid-cols-[150px_150px_1fr_1fr_140px_auto]">
          <DateInput
            value={draft.period_start}
            onChange={(v) => setDraft({ ...draft, period_start: v })}
            ariaLabel={t("marketing.adspend.period") + " (с)"}
            max={draft.period_end || undefined}
          />
          <DateInput
            value={draft.period_end}
            onChange={(v) => setDraft({ ...draft, period_end: v })}
            ariaLabel={t("marketing.adspend.period") + " (по)"}
            min={draft.period_start || undefined}
          />
          <Select<string>
            value={draft.source_id}
            onChange={(v) => setDraft({ ...draft, source_id: v })}
            options={[
              {
                value: "",
                label: `— ${t("marketing.adspend.pick_source")} —`,
              },
              ...(sourcesQ.data || []).map((s) => ({
                value: String(s.id),
                label: s.name,
              })),
            ]}
            ariaLabel={t("marketing.adspend.pick_source")}
            searchable={(sourcesQ.data || []).length > 8}
          />
          <input
            type="text"
            value={draft.source_label}
            placeholder={t("marketing.adspend.custom_label_ph")}
            onChange={(e) => setDraft({ ...draft, source_label: e.target.value })}
            disabled={!!draft.source_id}
            className="nf-input text-sm py-2 px-3 disabled:opacity-50"
          />
          <input
            type="number"
            min="0"
            step="1000"
            value={draft.amount}
            placeholder={t("marketing.adspend.amount_ph")}
            onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            className="nf-input text-sm py-2 px-3 text-right tabular-nums"
          />
          <Button onClick={submit} disabled={createMut.isPending}>
            <Plus className="w-3.5 h-3.5" />
            {t("common.save")}
          </Button>
        </div>
        <input
          type="text"
          value={draft.note}
          placeholder={t("marketing.adspend.note_ph")}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          className="mt-2 w-full text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
        />
      </div>

      {/* Existing rows */}
      <div className="nf-card overflow-hidden">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <div className="text-[15px] font-semibold tracking-tight">
            {t("marketing.adspend.list_title")}
          </div>
          <div className="text-[13px] text-muted tabular-nums">
            {t("marketing.adspend.total")}: {formatUZS(total)}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted">
                <th className="text-left px-5 py-2">{t("marketing.adspend.period")}</th>
                <th className="text-left px-3 py-2">{t("marketing.adspend.source")}</th>
                <th className="text-right px-3 py-2">{t("marketing.adspend.amount")}</th>
                <th className="text-left px-3 py-2">{t("marketing.adspend.note")}</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted py-6">
                    {t("marketing.adspend.empty")}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[color:var(--faint)]">
                  <td className="px-5 py-2 whitespace-nowrap">
                    {r.period_start} — {r.period_end}
                  </td>
                  <td className="px-3 py-2">{r.resolved_label}</td>
                  <td className="text-right px-3 py-2 tabular-nums">
                    <input
                      type="number"
                      defaultValue={r.amount}
                      min="0"
                      className="text-sm rounded border border-transparent hover:border-gray-200 dark:hover:border-slate-700 bg-transparent px-2 py-1 w-32 text-right tabular-nums focus:outline-none focus:border-[color:var(--accent)]"
                      onBlur={(e) => {
                        const v = e.target.value;
                        if (v && Number(v) !== Number(r.amount)) {
                          patchMut.mutate({ id: r.id, fields: { amount: v } });
                        }
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 text-muted">{r.note}</td>
                  <td className="text-right pr-5 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(t("marketing.adspend.confirm_delete"))) {
                          deleteMut.mutate(r.id);
                        }
                      }}
                      className="text-[color:var(--muted)] hover:text-[#dc2626]"
                      title={t("common.delete")}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
