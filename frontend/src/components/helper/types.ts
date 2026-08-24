export type Severity = "urgent" | "warning" | "info";

export interface HelperSuggestion {
  id: string;
  severity: Severity;
  title_ru: string;
  title_uz: string;
  body_ru: string;
  body_uz: string;
  action_label_ru: string | null;
  action_label_uz: string | null;
  action_href: string | null;
  count: number | null;
  meta?: Record<string, unknown>;
}

export interface HelperFaqItem {
  id: string;
  q_ru: string;
  q_uz: string;
  a_ru: string;
  a_uz: string;
}

export interface OperatorHelperResponse {
  suggestions: HelperSuggestion[];
  faq: HelperFaqItem[];
}
