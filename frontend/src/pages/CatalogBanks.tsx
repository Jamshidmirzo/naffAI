import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";

type Plan = {
  id: number;
  bank: number;
  term_months: number;
  multiplier: string;
  is_active: boolean;
  sort_order: number;
};
type Bank = {
  id: number;
  name: string;
  icon: string;
  is_active: boolean;
  sort_order: number;
  plans: Plan[];
};

export default function CatalogBanks() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader({ title: t("catalog.banks_title"), subtitle: t("catalog.banks_subtitle") }, [
    t("catalog.banks_title"),
  ]);
  const [newBankName, setNewBankName] = useState("");
  const [newBankIcon, setNewBankIcon] = useState("");

  const banks = useQuery({
    queryKey: ["catalog-banks"],
    queryFn: () =>
      api.get<{ results?: Bank[] } | Bank[]>("/catalog/installment/banks/").then((r) => {
        const d = r.data as any;
        return (d.results || d) as Bank[];
      }),
  });

  const addBank = useMutation({
    mutationFn: (body: { name: string; icon: string }) => api.post("/catalog/installment/banks/", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog-banks"] });
      setNewBankName("");
      setNewBankIcon("");
      toast.success(t("catalog.bank_added"));
    },
  });

  const deleteBank = useMutation({
    mutationFn: (id: number) => api.delete(`/catalog/installment/banks/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-banks"] }),
  });

  const addPlan = useMutation({
    mutationFn: (body: { bank: number; term_months: number; multiplier: string }) =>
      api.post("/catalog/installment/plans/", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-banks"] }),
  });

  const deletePlan = useMutation({
    mutationFn: (id: number) => api.delete(`/catalog/installment/plans/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-banks"] }),
  });

  return (
    <div className="max-w-3xl space-y-5">
      <div className="nf-card p-4">
        <div className="text-[14px] font-semibold mb-2">{t("catalog.banks_add")}</div>
        <div className="flex gap-2">
          <input
            className="nf-input flex-1"
            placeholder="Alif / Zoodpay / Payme…"
            value={newBankName}
            onChange={(e) => setNewBankName(e.target.value)}
          />
          <input
            className="nf-input w-20 text-center"
            placeholder="🏦"
            value={newBankIcon}
            onChange={(e) => setNewBankIcon(e.target.value)}
          />
          <button
            type="button"
            className="nf-btn nf-btn--primary"
            onClick={() => newBankName.trim() && addBank.mutate({ name: newBankName.trim(), icon: newBankIcon })}
            disabled={!newBankName.trim() || addBank.isPending}
          >
            <Plus className="w-4 h-4" /> {t("common.save")}
          </button>
        </div>
      </div>

      {banks.isLoading && <div className="text-muted">{t("common.loading")}</div>}

      <div className="space-y-4">
        {(banks.data || []).map((b) => (
          <BankCard
            key={b.id}
            bank={b}
            onDelete={() => {
              if (confirm(t("catalog.confirm_delete_bank", { name: b.name })))
                deleteBank.mutate(b.id);
            }}
            onAddPlan={(term_months, multiplier) =>
              addPlan.mutate({ bank: b.id, term_months, multiplier })
            }
            onDeletePlan={(pid) => deletePlan.mutate(pid)}
          />
        ))}
      </div>
    </div>
  );
}

function BankCard({
  bank,
  onDelete,
  onAddPlan,
  onDeletePlan,
}: {
  bank: Bank;
  onDelete: () => void;
  onAddPlan: (term_months: number, multiplier: string) => void;
  onDeletePlan: (planId: number) => void;
}) {
  const t = useT();
  const [term, setTerm] = useState("");
  const [mult, setMult] = useState("");
  return (
    <div className="nf-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[15px] font-semibold">
          {bank.icon} {bank.name}
        </div>
        <button
          type="button"
          className="nf-btn nf-btn--ghost !p-2 text-red-500"
          onClick={onDelete}
          title={t("common.delete")}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      <table className="w-full text-[13px] mb-3">
        <thead className="text-[11px] uppercase text-muted">
          <tr>
            <th className="text-left py-1">{t("catalog.plan_term")}</th>
            <th className="text-left py-1">{t("catalog.plan_multiplier")}</th>
            <th className="text-left py-1">{t("catalog.plan_overpay")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(bank.plans || []).map((p) => (
            <tr key={p.id} className="border-t border-[var(--border-row)]">
              <td className="py-1.5">{p.term_months} {t("catalog.months")}</td>
              <td className="py-1.5 tabular-nums">×{p.multiplier}</td>
              <td className="py-1.5 tabular-nums text-muted">
                +{Math.round((Number(p.multiplier) - 1) * 100)}%
              </td>
              <td className="py-1.5 text-right">
                <button
                  type="button"
                  className="text-red-500 hover:text-red-600"
                  onClick={() => onDeletePlan(p.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2 pt-2 border-t border-[var(--border)]">
        <input
          type="number"
          className="nf-input w-24"
          placeholder="12"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <input
          type="number"
          step="0.001"
          className="nf-input w-28"
          placeholder="1.18"
          value={mult}
          onChange={(e) => setMult(e.target.value)}
        />
        <button
          type="button"
          className="nf-btn nf-btn--secondary"
          onClick={() => {
            if (term && mult) {
              onAddPlan(Number(term), mult);
              setTerm("");
              setMult("");
            }
          }}
          disabled={!term || !mult}
        >
          <Plus className="w-3.5 h-3.5" /> {t("catalog.add_plan")}
        </button>
      </div>
    </div>
  );
}
