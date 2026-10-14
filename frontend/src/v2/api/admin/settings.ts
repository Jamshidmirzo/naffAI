/**
 * v2 data hooks — admin zone, group «settings»: /settings, /statuses,
 * /partners, /catalog/{tiers,banks,marketing-settings}.
 * Query keys are the same as the old pages so cache/invalidation is shared.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import type { LeadStatusRow, LeadStatusTone } from "../../../hooks/useLeadStatuses";

export { useLeadStatuses as useSetLeadStatuses } from "../../../hooks/useLeadStatuses";
export type { LeadStatusRow as SetLeadStatusRow, LeadStatusTone as SetLeadStatusTone };

function unwrap<T>(d: unknown): T[] {
  const x = d as { results?: T[] } | T[];
  return (Array.isArray(x) ? x : x?.results) ?? [];
}

/* ---------------- /settings — distribution toggles ---------------- */

export interface SetDistributionSettings {
  auto_distribution_enabled: boolean;
  morning_gate_enabled: boolean;
  updated_at: string | null;
  updated_by: { id: number; full_name: string } | null;
}
export type SetDistributionPatch = Partial<Pick<SetDistributionSettings, "auto_distribution_enabled" | "morning_gate_enabled">>;

export function useSetDistribution() {
  return useQuery<SetDistributionSettings>({
    queryKey: ["settings", "distribution"],
    queryFn: () => api.get<SetDistributionSettings>("/settings/distribution/").then((r) => r.data),
  });
}

export function useSetDistributionPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SetDistributionPatch) =>
      api.patch<SetDistributionSettings>("/settings/distribution/", patch).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "distribution"], data);
      qc.invalidateQueries({ queryKey: ["settings", "distribution"] });
    },
  });
}

/* ---------------- /settings — attendance PIN (superadmin) ---------------- */

export interface SetPinStatus {
  role: string;
  has_pin: boolean;
  pin_required: boolean;
  pin_verified: boolean;
  expires_at: string | null;
  ttl_minutes: number;
  updated_at: string | null;
  updated_by: string | null;
}

export function useSetPinStatus(enabled = true) {
  return useQuery<SetPinStatus>({
    queryKey: ["attendance-pin-status"],
    queryFn: () => api.get<SetPinStatus>("/attendance/pin/status/").then((r) => r.data),
    staleTime: 30_000,
    enabled,
  });
}

export function useSetPinSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (newPin: string) => api.post("/attendance/pin/set/", { new_pin: newPin }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attendance-pin-status"] }),
  });
}

export function useSetPinReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/attendance/pin/reset/"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attendance-pin-status"] }),
  });
}

/* ---------------- /partners — payment channels ---------------- */

export interface SetPartner {
  id: number;
  name: string;
  is_active: boolean;
}

export function useSetPartners() {
  return useQuery({
    queryKey: ["partners"],
    queryFn: () => api.get("/channels/").then((r) => unwrap<SetPartner>(r.data)),
  });
}

function invalidatePartners(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["partners"] });
  qc.invalidateQueries({ queryKey: ["partners-list"] });
}

export function useSetPartnerCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; is_active: boolean }) => api.post("/channels/", body),
    onSuccess: () => invalidatePartners(qc),
  });
}

export function useSetPartnerToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { id: number; is_active: boolean }) => api.patch(`/channels/${p.id}/`, { is_active: p.is_active }),
    onSuccess: () => invalidatePartners(qc),
  });
}

/* ---------------- /statuses — lead status catalog ---------------- */

export type SetLeadStatusBody = {
  code?: string;
  label_ru: string;
  label_uz: string;
  tone: LeadStatusTone;
  emoji: string;
  sort_order: number;
  show_in_chip: boolean;
  show_in_button: boolean;
  is_active: boolean;
  blocks_new_leads: boolean;
};

export function useSetLeadStatusSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: SetLeadStatusBody }) => {
      if (id) await api.patch(`/lead-statuses/${id}/`, body);
      else await api.post("/lead-statuses/", body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-statuses"] }),
  });
}

export function useSetLeadStatusDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/lead-statuses/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-statuses"] }),
  });
}

/* ---------------- /catalog/tiers ---------------- */

export interface SetTier {
  id: number;
  months: number;
  commission_pct: string;
  is_active: boolean;
  show_in_marketing: boolean;
  sort_order: number;
}

export function useSetTiers() {
  return useQuery({
    queryKey: ["installment-tiers"],
    queryFn: () => api.get("/catalog/installment-tiers/").then((r) => unwrap<SetTier>(r.data)),
  });
}

/** Same upsert as the old page: an existing tier with these months is patched, else created. */
export function useSetTierUpsert(rows: SetTier[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<SetTier> & { months: number }) => {
      const existing = rows.find((r) => r.months === body.months);
      if (existing) return api.patch<SetTier>(`/catalog/installment-tiers/${existing.id}/`, body);
      return api.post<SetTier>("/catalog/installment-tiers/", body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["installment-tiers"] }),
  });
}

export function useSetTierDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/catalog/installment-tiers/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["installment-tiers"] }),
  });
}

/* ---------------- /catalog/banks ---------------- */

export interface SetBankPlan {
  id: number;
  bank: number;
  term_months: number;
  multiplier: string;
  is_active: boolean;
  sort_order: number;
}
export interface SetBank {
  id: number;
  name: string;
  icon: string;
  is_active: boolean;
  sort_order: number;
  plans: SetBankPlan[];
}

export function useSetBanks() {
  return useQuery({
    queryKey: ["catalog-banks"],
    queryFn: () => api.get("/catalog/installment/banks/").then((r) => unwrap<SetBank>(r.data)),
  });
}

function useBanksMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-banks"] }),
  });
}

export const useSetBankCreate = () =>
  useBanksMutation((body: { name: string; icon: string }) => api.post("/catalog/installment/banks/", body));
export const useSetBankDelete = () => useBanksMutation((id: number) => api.delete(`/catalog/installment/banks/${id}/`));
export const useSetBankPlanCreate = () =>
  useBanksMutation((body: { bank: number; term_months: number; multiplier: string }) => api.post("/catalog/installment/plans/", body));
export const useSetBankPlanDelete = () => useBanksMutation((id: number) => api.delete(`/catalog/installment/plans/${id}/`));

/* ---------------- /catalog/marketing-settings ---------------- */

export interface SetMarketingSettings {
  id: number;
  default_tagline: string;
  phone_primary: string;
  phone_secondary: string;
  telegram_handle: string;
  address: string;
  benefits: string;
  updated_at: string;
}

export function useSetMarketingSettings() {
  return useQuery({
    queryKey: ["marketing-settings"],
    queryFn: () => api.get<SetMarketingSettings>("/catalog/marketing-settings/").then((r) => r.data),
  });
}

export function useSetMarketingSettingsSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<SetMarketingSettings>) =>
      api.patch<SetMarketingSettings>("/catalog/marketing-settings/", body).then((r) => r.data),
    onSuccess: (data) => qc.setQueryData(["marketing-settings"], data),
  });
}
