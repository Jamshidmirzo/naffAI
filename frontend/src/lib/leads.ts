/**
 * Types + helpers shared by /my (operator workstation) and /leads (admin).
 */

// Built-in codes (kept as string-literals for autocomplete), but the field
// is intentionally widened to `string` — manager-created custom statuses
// carry arbitrary codes stored in the DB `LeadStatusLabel.code`.
export type LeadStatusCode =
  | "new"
  | "assigned"
  | "in_progress"
  | "callback_scheduled"
  | "contacted_telegram"
  | "no_answer"
  | "no_answer_2"
  | "phone_on"
  | "has_debt"
  | "won"
  | "lost"
  | "archived"
  | "needs_review";
export type LeadStatus = LeadStatusCode | (string & {});

export type CallOutcome =
  | "talked_interested"
  | "talked_callback"
  | "no_answer"
  | "wrong_number"
  | "rejected"
  | "tg_only";

export type Lead = {
  id: number;
  full_name: string;
  phone: string;
  phone_raw: string;
  phone_invalid: boolean;
  product_hint: string;
  has_card: string;
  status: LeadStatus;
  source: string;
  operator: number | null;
  operator_name: string | null;
  needs_review: boolean;
  sheet_source: number | null;
  sheet_source_name: string | null;
  sheet_row_index: number | null;
  metadata: Record<string, unknown>;
  postponed_at: string | null;
  postponed_by: number | null;
  postponed_by_name: string | null;
  postpone_reason: string;
  previous_operator_name?: string;
  is_retry?: boolean;
  created_at: string;
  updated_at: string;
};

export type CallbackReminder = {
  id: number;
  lead: number;
  lead_name: string;
  lead_phone: string;
  operator: number;
  operator_name: string;
  remind_at: string;
  status: "pending" | "done" | "overdue" | "snoozed" | "superseded";
  comment: string;
  done_at: string | null;
  created_at: string;
};

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: "Новый",
  assigned: "Назначен",
  in_progress: "В работе",
  callback_scheduled: "Callback",
  contacted_telegram: "TG'га боғланди",
  no_answer: "Javob bermadi 1",
  no_answer_2: "Javob bermadi 2",
  phone_on: "Telfoni ochiq",
  has_debt: "Qarzi bor",
  won: "Продажа",
  lost: "Потерян",
  archived: "Архив",
  needs_review: "Требует проверки",
};

export const LEAD_STATUS_BADGE: Record<LeadStatus, string> = {
  new: "bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-300",
  assigned: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-300",
  in_progress: "bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300",
  callback_scheduled:
    "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  contacted_telegram: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/10 dark:text-cyan-300",
  no_answer: "bg-gray-100 text-gray-700 dark:bg-slate-700/40 dark:text-slate-300",
  no_answer_2: "bg-orange-100 text-orange-800 dark:bg-orange-500/10 dark:text-orange-300",
  phone_on: "bg-teal-100 text-teal-800 dark:bg-teal-500/10 dark:text-teal-300",
  has_debt: "bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300",
  won: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300",
  lost: "bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300",
  archived: "bg-neutral-100 text-neutral-600 dark:bg-slate-700/30 dark:text-slate-400",
  needs_review: "bg-orange-100 text-orange-800 dark:bg-orange-500/10 dark:text-orange-300",
};

export const CALL_OUTCOMES: Array<{ value: CallOutcome; label: string; hint?: string }> = [
  { value: "talked_interested", label: "Разговор — интерес" },
  {
    value: "talked_callback",
    label: "Просят перезвонить",
    hint: "Обязательно назначь время callback'а",
  },
  { value: "no_answer", label: "Не берут трубку" },
  { value: "tg_only", label: "Написали в Telegram" },
  { value: "wrong_number", label: "Не тот номер" },
  { value: "rejected", label: "Отказ" },
];

export const TG_LINK_FALLBACK = (phone: string) => `tg://resolve?phone=${phone.replace(/^\+/, "")}`;
