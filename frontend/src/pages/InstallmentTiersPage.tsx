import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";

type Tier = {
  id: number;
  months: number;
  commission_pct: string;
  is_active: boolean;
  show_in_marketing: boolean;
  sort_order: number;
};

export default function InstallmentTiersPage() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader(
    { title: t("tiers.title"), subtitle: t("tiers.subtitle") },
    [t("tiers.title")],
  );

  const q = useQuery({
    queryKey: ["installment-tiers"],
    queryFn: () =>
      api
        .get<{ results?: Tier[] } | Tier[]>("/catalog/installment-tiers/")
        .then((r) => {
          const d: any = r.data;
          return (d.results || d) as Tier[];
        }),
  });

  const [newMonths, setNewMonths] = useState("");
  const [newPct, setNewPct] = useState("");

  const upsert = useMutation({
    mutationFn: (body: Partial<Tier> & { months: number }) => {
      const existing = (q.data || []).find((r) => r.months === body.months);
      if (existing) {
        return api.patch<Tier>(
          `/catalog/installment-tiers/${existing.id}/`,
          body,
        );
      }
      return api.post<Tier>("/catalog/installment-tiers/", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-tiers"] });
      toast.success(t("tiers.saved"));
    },
    onError: () => toast.error(t("marketing_settings.save_failed")),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/catalog/installment-tiers/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-tiers"] });
      toast.success(t("tiers.deleted"));
    },
  });

  const rows = q.data || [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="nf-card p-0 overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="text-[11px] uppercase text-muted bg-[var(--surface2)]">
            <tr>
              <th className="text-left px-3 py-2">{t("tiers.months")}</th>
              <th className="text-left px-3 py-2">{t("tiers.commission_pct")}</th>
              <th className="text-center px-3 py-2">{t("tiers.is_active")}</th>
              <th className="text-center px-3 py-2">{t("tiers.show_in_marketing")}</th>
              <th className="text-center px-3 py-2">{t("tiers.sort_order")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TierRow
                key={r.id}
                row={r}
                onSave={(patch) => upsert.mutate({ months: r.months, ...patch })}
                onDelete={() => {
                  if (confirm(t("tiers.confirm_delete", { months: r.months })))
                    del.mutate(r.id);
                }}
              />
            ))}
            {rows.length === 0 && !q.isLoading && (
              <tr>
                <td
                  colSpan={6}
                  className="text-center text-muted py-6 text-[12.5px]"
                >
                  {t("common.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="nf-card p-4">
        <div className="text-[14px] font-semibold mb-2">
          {t("tiers.add")}
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col">
            <label className="nf-col mb-1">{t("tiers.months")}</label>
            <input
              type="number"
              className="nf-input w-24"
              placeholder="24"
              value={newMonths}
              onChange={(e) => setNewMonths(e.target.value)}
            />
          </div>
          <div className="flex flex-col">
            <label className="nf-col mb-1">{t("tiers.commission_pct")}</label>
            <input
              type="number"
              step="0.01"
              className="nf-input w-28"
              placeholder="60.00"
              value={newPct}
              onChange={(e) => setNewPct(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="nf-btn nf-btn--primary"
            disabled={!newMonths || !newPct || upsert.isPending}
            onClick={() => {
              upsert.mutate({
                months: Number(newMonths),
                commission_pct: newPct,
                is_active: true,
                show_in_marketing: false,
                sort_order: (rows[rows.length - 1]?.sort_order ?? 0) + 10,
              });
              setNewMonths("");
              setNewPct("");
            }}
          >
            <Plus className="w-4 h-4" /> {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function TierRow({
  row,
  onSave,
  onDelete,
}: {
  row: Tier;
  onSave: (patch: Partial<Tier>) => void;
  onDelete: () => void;
}) {
  const [pct, setPct] = useState(row.commission_pct);
  const [sortOrder, setSortOrder] = useState(String(row.sort_order));
  return (
    <tr className="border-t border-[var(--border-row)]">
      <td className="px-3 py-2 tabular-nums">{row.months}</td>
      <td className="px-3 py-2">
        <input
          type="number"
          step="0.01"
          className="nf-input w-24"
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          onBlur={() => pct !== row.commission_pct && onSave({ commission_pct: pct })}
        />
      </td>
      <td className="px-3 py-2 text-center">
        <input
          type="checkbox"
          checked={row.is_active}
          onChange={(e) => onSave({ is_active: e.target.checked })}
        />
      </td>
      <td className="px-3 py-2 text-center">
        <input
          type="checkbox"
          checked={row.show_in_marketing}
          onChange={(e) => onSave({ show_in_marketing: e.target.checked })}
        />
      </td>
      <td className="px-3 py-2 text-center">
        <input
          type="number"
          className="nf-input w-16"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          onBlur={() =>
            Number(sortOrder) !== row.sort_order &&
            onSave({ sort_order: Number(sortOrder) })
          }
        />
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          className="text-red-500 hover:text-red-600"
          onClick={onDelete}
          aria-label="delete tier"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </td>
    </tr>
  );
}
