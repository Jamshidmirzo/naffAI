import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useLangValue } from "../lib/i18n";

export type LeadStatusTone = "neutral" | "hot" | "danger" | "success" | "info";

export interface LeadStatusRow {
  id: number;
  code: string;
  label_ru: string;
  label_uz: string;
  tone: LeadStatusTone;
  emoji: string;
  sort_order: number;
  show_in_chip: boolean;
  show_in_button: boolean;
  is_active: boolean;
  is_builtin: boolean;
  blocks_new_leads: boolean;
  created_at: string;
  updated_at: string;
}

export function useLeadStatuses() {
  return useQuery<LeadStatusRow[]>({
    queryKey: ["lead-statuses"],
    queryFn: () =>
      api.get<LeadStatusRow[]>("/lead-statuses/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/**
 * Convenience helper: given a raw status `code` (whatever the Lead carries),
 * return `{ label, tone, emoji }` picked from the DB catalog. Falls back to
 * the raw code if the catalog is still loading or the code was deleted.
 */
export function useLeadStatusInfo(code: string | null | undefined) {
  const lang = useLangValue();
  const { data } = useLeadStatuses();
  const row = data?.find((r) => r.code === code);
  if (!row) {
    return {
      label: code || "—",
      tone: "neutral" as LeadStatusTone,
      emoji: "",
      row: null as LeadStatusRow | null,
    };
  }
  const label = lang === "uz" && row.label_uz ? row.label_uz : row.label_ru;
  return {
    label,
    tone: row.tone,
    emoji: row.emoji,
    row,
  };
}
